import { and, avg, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  newTaskState,
  TaskRunner,
  type ProposedAction,
  type RunnerDeps,
  type TaskState,
} from "@northbot/agent-runtime";
import type { BrowserAction } from "@northbot/sandbox";
import type { DbHandle } from "../db/client.js";
import { agents, events, tasks, workspaces } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { LlmService } from "../llm/service.js";
import type { ComputerManager } from "../computer/manager.js";
import type { ApprovalInbox } from "./approvals.js";
import type { ActionLedger } from "./ledger.js";
import type { RuleStore } from "./rules.js";

export class KillSwitchOnError extends Error {
  constructor() {
    super("The kill switch is on. Release it before starting new work.");
  }
}

const ACTIVE = ["queued", "running", "waiting_approval"];
const DEFAULT_STEP_COST_USD = 0.01;

export interface TaskServiceOptions {
  /** Jobs whose estimate is above this ask a human first. */
  confirmAboveUsd: number;
}

/** Starts, resumes, cancels and kills agent tasks, wiring the runner to the real world. */
export class TaskService {
  private running = new Map<string, { controller: AbortController; workspaceId: string }>();
  private watchers = new Map<string, { off: () => void; count: number }>();

  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly llm: LlmService,
    private readonly computers: ComputerManager,
    private readonly inbox: ApprovalInbox,
    private readonly rules: RuleStore,
    private readonly ledger: ActionLedger,
    private readonly opts: TaskServiceOptions = { confirmAboveUsd: 1 },
  ) {}

  async killSwitchOn(workspaceId: string): Promise<boolean> {
    const [ws] = await this.db.db.select({ at: workspaces.killSwitchAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    return Boolean(ws?.at);
  }

  async create(input: {
    workspaceId: string;
    agentId: string;
    goal: string;
    by: "user" | "agent" | "schedule" | "system";
    userId: string | null;
    budgetUsd?: number | null;
    idempotencyKey?: string;
  }) {
    if (await this.killSwitchOn(input.workspaceId)) throw new KillSwitchOnError();
    const [row] = await this.db.db
      .insert(tasks)
      .values({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        goal: input.goal,
        createdBy: input.by,
        userId: input.userId,
        budgetUsd: input.budgetUsd == null ? null : String(input.budgetUsd),
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .onConflictDoNothing({ target: tasks.idempotencyKey })
      .returning();
    if (!row) {
      // Same idempotency key as an existing task: return that one, start nothing.
      const [existing] = await this.db.db.select().from(tasks).where(eq(tasks.idempotencyKey, input.idempotencyKey ?? ""));
      if (!existing) throw new Error("task insert failed");
      return { task: existing, created: false };
    }
    await this.events.write(input.workspaceId, {
      type: "task.created",
      agentId: input.agentId,
      payload: { taskId: row.id, goal: input.goal, by: input.by, userId: input.userId },
    });
    void this.start(row.id);
    return { task: row, created: true };
  }

  /** Resumes tasks that were running when the server stopped. */
  async resumeAll(): Promise<number> {
    const rows = await this.db.db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(and(inArray(tasks.status, ACTIVE), isNull(workspaces.killSwitchAt)));
    for (const r of rows) void this.start(r.id);
    return rows.length;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Resolves when every task started on this instance has finished (tests and shutdown). */
  async idle(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  }

  private watch(workspaceId: string): () => void {
    let w = this.watchers.get(workspaceId);
    if (!w) {
      const off = this.events.subscribe(workspaceId, (e) => {
        if (e.type === "killswitch.engaged") this.abortLocal(workspaceId);
      });
      w = { off, count: 0 };
      this.watchers.set(workspaceId, w);
    }
    w.count += 1;
    return () => {
      const cur = this.watchers.get(workspaceId);
      if (!cur) return;
      cur.count -= 1;
      if (cur.count === 0) {
        cur.off();
        this.watchers.delete(workspaceId);
      }
    };
  }

  /** Aborts this instance's runners for a workspace (or one task); returns their task ids. */
  private abortLocal(workspaceId: string, taskId?: string): string[] {
    const ids: string[] = [];
    for (const [id, r] of this.running) {
      if (r.workspaceId === workspaceId && (!taskId || id === taskId)) {
        r.controller.abort();
        ids.push(id);
      }
    }
    return ids;
  }

  async start(taskId: string): Promise<void> {
    if (this.running.has(taskId)) return;
    const [row] = await this.db.db
      .select({ task: tasks, agent: agents })
      .from(tasks)
      .innerJoin(agents, eq(agents.id, tasks.agentId))
      .where(eq(tasks.id, taskId));
    if (!row || !ACTIVE.includes(row.task.status)) return;
    const { task, agent } = row;
    const controller = new AbortController();
    this.running.set(taskId, { controller, workspaceId: task.workspaceId });
    const unwatch = this.watch(task.workspaceId);
    try {
      if (await this.killSwitchOn(task.workspaceId)) controller.abort();
      await this.db.db.update(tasks).set({ status: "running", updatedAt: new Date() }).where(eq(tasks.id, taskId));
      const state = (task.state as unknown as TaskState | null) ?? newTaskState(task.id, task.goal);
      state.status = "running";
      const runner = new TaskRunner(this.deps(task, agent));
      const final = await runner.run(state, controller.signal);
      await this.db.db
        .update(tasks)
        .set({
          status: final.status,
          state: final as unknown as Record<string, unknown>,
          report: final.report as unknown as Record<string, unknown> | null,
          error: final.error,
          updatedAt: new Date(),
          finishedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
      if (final.status === "killed") await this.inbox.cancelForTask(task.workspaceId, taskId);
    } finally {
      unwatch();
      this.running.delete(taskId);
    }
  }

  private deps(task: typeof tasks.$inferSelect, agent: typeof agents.$inferSelect): RunnerDeps {
    const ref = { workspaceId: task.workspaceId, agentId: agent.id };
    const policy = agent.modelPolicy as { model?: string; planner?: string; verifier?: string; privacy?: "normal" | "sensitive" };
    const worker = policy.model ?? "northbot-smart";
    const ctx = (signal: AbortSignal) => ({
      workspaceId: task.workspaceId,
      agentId: agent.id,
      taskId: task.id,
      taskBudgetUsd: task.budgetUsd === null ? null : Number(task.budgetUsd),
      privacy: policy.privacy ?? ("normal" as const),
      signal,
    });
    const untilAbort = <T>(p: Promise<T>, signal: AbortSignal) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);

    return {
      agent: { name: agent.name, persona: String((agent.persona as { summary?: string }).summary ?? ""), autonomy: agent.autonomyLevel as RunnerDeps["agent"]["autonomy"] },
      models: { worker, planner: policy.planner ?? worker, verifier: policy.verifier ?? worker },
      chat: (req, signal) => this.llm.chat(req, ctx(signal)),
      terminal: (command, timeoutMs, signal) => untilAbort(this.computers.exec(ref, command, "agent", { timeoutMs }), signal),
      browser: async (args, signal) => {
        const a = String(args.action);
        if (a === "tabs") return untilAbort(this.computers.browser(ref).then((b) => b.tabs()), signal) as Promise<Record<string, unknown>>;
        if (a === "new_tab") {
          return untilAbort(this.computers.browser(ref).then((b) => b.newTab(args.url ? String(args.url) : undefined)), signal) as unknown as Promise<
            Record<string, unknown>
          >;
        }
        const r = await untilAbort(this.computers.browse(ref, args as unknown as BrowserAction, "agent"), signal);
        return r as unknown as Record<string, unknown>;
      },
      elementText: async (selector) => {
        const b = await this.computers.browser(ref);
        return (await b.act({ action: "read", selector })).text ?? "";
      },
      rules: () => this.rules.forAgent(task.workspaceId, agent.id),
      saveRule: async (rule) => {
        await this.rules.add({ workspaceId: task.workspaceId, agentId: agent.id, text: rule.description, rule, source: "approval", userId: null });
      },
      askHuman: async (action: ProposedAction, reason, signal) => {
        const a = await this.inbox.open({ ...ref, taskId: task.id }, action, reason);
        return this.inbox.wait(task.workspaceId, a.id, signal);
      },
      waitForControl: async (signal) => {
        while (await this.computers.isTakenOver(ref)) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
      actionBegin: (key, action) => this.ledger.begin(key, { workspaceId: task.workspaceId, taskId: task.id }, action.summary),
      actionFinish: (key, result, ok) => this.ledger.finish(key, result, ok),
      save: async (state) => {
        const finished = !["running", "waiting_approval"].includes(state.status);
        await this.db.db
          .update(tasks)
          .set({
            state: state as unknown as Record<string, unknown>,
            status: state.status,
            report: state.report as unknown as Record<string, unknown> | null,
            error: state.error,
            updatedAt: new Date(),
            ...(finished ? { finishedAt: new Date() } : {}),
          })
          .where(eq(tasks.id, task.id));
      },
      emit: async (type, payload) => {
        // Runner event names match the shared registry; the log validates every payload.
        await this.events.write(task.workspaceId, { type: type as "task.step", agentId: agent.id, payload: payload as never });
      },
      setAgentStatus: async (status) => {
        await this.db.db.update(agents).set({ status }).where(eq(agents.id, agent.id));
        await this.events.write(task.workspaceId, { type: "agent.status", agentId: agent.id, payload: { status } });
      },
      approveEstimate: async (steps, signal) => {
        const perStep = await this.avgCallCost(agent.id);
        const estimateUsd = Number((steps.length * 2 * perStep).toFixed(4));
        const needsApproval = estimateUsd > this.opts.confirmAboveUsd;
        await this.events.write(task.workspaceId, { type: "task.estimate", agentId: agent.id, payload: { taskId: task.id, estimateUsd, needsApproval } });
        if (!needsApproval) return true;
        const action: ProposedAction = {
          tool: "task",
          args: { estimateUsd },
          kind: "spend",
          summary: `start a job of ${steps.length} steps estimated at about $${estimateUsd.toFixed(2)}`,
          targets: [],
        };
        const a = await this.inbox.open({ ...ref, taskId: task.id }, action, "This job may cost more than your confirmation limit.");
        return (await this.inbox.wait(task.workspaceId, a.id, signal)) !== "deny";
      },
    };
  }

  private async avgCallCost(agentId: string): Promise<number> {
    const [row] = await this.db.db
      .select({ v: avg(events.costUsd) })
      .from(events)
      .where(and(eq(events.agentId, agentId), eq(events.type, "llm.call"), isNotNull(events.costUsd)));
    const v = Number(row?.v ?? 0);
    return v > 0 ? v : DEFAULT_STEP_COST_USD;
  }

  async cancel(workspaceId: string, taskId: string): Promise<boolean> {
    const [row] = await this.db.db
      .update(tasks)
      .set({ status: "killed", error: "Cancelled by a human.", updatedAt: new Date(), finishedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ACTIVE)))
      .returning();
    if (!row) return false;
    this.abortLocal(workspaceId, taskId);
    await this.inbox.cancelForTask(workspaceId, taskId);
    return true;
  }

  /** Stops every agent in the workspace and blocks new work until released. */
  async engageKillSwitch(workspaceId: string, userId: string): Promise<number> {
    // Stop first, bookkeeping after: local runners abort at once.
    const local = this.abortLocal(workspaceId);
    await this.db.db.update(workspaces).set({ killSwitchAt: new Date() }).where(eq(workspaces.id, workspaceId));
    const all = await this.db.db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, workspaceId));
    const stopping = Promise.all(all.map((a) => this.computers.stopCommands({ workspaceId, agentId: a.id })));
    const stopped = await this.db.db
      .update(tasks)
      .set({ status: "killed", error: "Stopped by the kill switch.", updatedAt: new Date(), finishedAt: new Date() })
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ACTIVE)))
      .returning({ id: tasks.id });
    const ids = new Set([...local, ...this.abortLocal(workspaceId), ...stopped.map((t) => t.id)]);
    await stopping;
    for (const id of ids) await this.inbox.cancelForTask(workspaceId, id);
    await this.db.db.update(agents).set({ status: "idle" }).where(and(eq(agents.workspaceId, workspaceId), sql`${agents.status} <> 'resting'`));
    // Other server instances abort their tasks when they see this event.
    await this.events.write(workspaceId, { type: "killswitch.engaged", payload: { userId, stoppedTasks: ids.size } });
    return ids.size;
  }

  async releaseKillSwitch(workspaceId: string, userId: string): Promise<void> {
    await this.db.db.update(workspaces).set({ killSwitchAt: null }).where(eq(workspaces.id, workspaceId));
    await this.events.write(workspaceId, { type: "killswitch.released", payload: { userId } });
  }
}
