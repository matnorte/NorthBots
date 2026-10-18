import { and, desc, eq } from "drizzle-orm";
import type { ApprovalAnswer, ProposedAction } from "@northbot/agent-runtime";
import type { DbHandle } from "../db/client.js";
import { agents, approvals } from "../db/schema.js";
import type { EventLog } from "../events/log.js";

type Row = typeof approvals.$inferSelect;

/** The approval inbox. Waiting tasks learn about decisions through the event log (any instance). */
export class ApprovalInbox {
  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
  ) {}

  /** Returns the pending approval for this task and action, creating it if needed. */
  async open(ref: { workspaceId: string; agentId: string; taskId: string | null }, action: ProposedAction, reason: string): Promise<Row> {
    if (ref.taskId) {
      const [existing] = await this.db.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.taskId, ref.taskId), eq(approvals.summary, action.summary), eq(approvals.status, "pending")));
      if (existing) return existing;
    }
    const [row] = await this.db.db
      .insert(approvals)
      .values({
        workspaceId: ref.workspaceId,
        agentId: ref.agentId,
        taskId: ref.taskId,
        kind: action.kind,
        summary: action.summary,
        reason,
        action: action as unknown as Record<string, unknown>,
      })
      .returning();
    if (!row) throw new Error("approval insert failed");
    await this.events.write(ref.workspaceId, {
      type: "approval.requested",
      agentId: ref.agentId,
      payload: { approvalId: row.id, taskId: ref.taskId, kind: action.kind, summary: action.summary, reason },
    });
    return row;
  }

  /** Waits for a human decision. Rejects when `signal` aborts (kill switch / cancel). */
  async wait(workspaceId: string, approvalId: string, signal: AbortSignal): Promise<ApprovalAnswer> {
    const check = async (): Promise<ApprovalAnswer | null> => {
      const [row] = await this.db.db.select().from(approvals).where(eq(approvals.id, approvalId));
      if (!row || row.status === "pending") return null;
      if (row.status === "approved") return row.decision === "approve_always" ? "approve_always" : "approve_once";
      return "deny";
    };
    const now = await check();
    if (now) return now;
    return new Promise<ApprovalAnswer>((resolve, reject) => {
      const done = (fn: () => void) => {
        unsubscribe();
        clearInterval(poll);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => done(() => reject(new Error("aborted")));
      const unsubscribe = this.events.subscribe(workspaceId, (e) => {
        if (e.type === "approval.decided" && e.payload.approvalId === approvalId) {
          void check().then((a) => a && done(() => resolve(a)));
        }
      });
      // Safety net in case a notification is missed.
      const poll = setInterval(() => void check().then((a) => a && done(() => resolve(a))), 5000);
      signal.addEventListener("abort", onAbort);
    });
  }

  async decide(workspaceId: string, approvalId: string, decision: ApprovalAnswer, userId: string): Promise<Row | null> {
    const [row] = await this.db.db
      .update(approvals)
      .set({ status: decision === "deny" ? "denied" : "approved", decision, decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending")))
      .returning();
    if (!row) return null;
    await this.events.write(workspaceId, {
      type: "approval.decided",
      agentId: row.agentId,
      payload: { approvalId, taskId: row.taskId, decision, userId },
    });
    return row;
  }

  async cancelForTask(workspaceId: string, taskId: string): Promise<void> {
    const rows = await this.db.db
      .update(approvals)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(and(eq(approvals.taskId, taskId), eq(approvals.status, "pending")))
      .returning();
    for (const row of rows) {
      await this.events.write(workspaceId, {
        type: "approval.decided",
        agentId: row.agentId,
        payload: { approvalId: row.id, taskId, decision: "cancelled", userId: null },
      });
    }
  }

  async list(workspaceId: string, status: string) {
    return this.db.db
      .select({ approval: approvals, agentName: agents.name })
      .from(approvals)
      .leftJoin(agents, eq(agents.id, approvals.agentId))
      .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, status)))
      .orderBy(desc(approvals.createdAt))
      .limit(200);
  }
}
