import { eq } from "drizzle-orm";
import type { Services } from "../services.js";
import { agents, handoffs } from "../db/schema.js";
/** A handoff holds the existing computer control gate; release continues the same task checkpoint. */
export class HandoffService {
  constructor(private s: Pick<Services, "db" | "events" | "computers" | "tasks">) {}
  attach() {
    this.s.tasks.provideTools((ctx) => [
      {
        def: {
          name: "request_human_handoff",
          description:
            "Pause while a human completes login, 2FA or CAPTCHA in the live browser. Never request passwords in chat.",
          parameters: {
            type: "object",
            properties: { reason: { type: "string", enum: ["login", "2fa", "captcha"] } },
            required: ["reason"],
          },
        },
        kind: "login",
        run: async (args, signal) => {
          const row = await this.open(
            ctx.workspaceId,
            ctx.agentId,
            String(args.reason),
            ctx.taskId,
          );
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearInterval(timer);
              reject(new Error("Handoff cancelled"));
            };
            const timer = setInterval(() => {
              void this.s.db.db
                .select()
                .from(handoffs)
                .where(eq(handoffs.id, row.id))
                .then(([r]) => {
                  if (r?.status === "done") {
                    clearInterval(timer);
                    signal.removeEventListener("abort", abort);
                    resolve();
                  }
                })
                .catch(() => {});
            }, 500);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          return {
            ok: true,
            output: "Human handoff complete. Continue from the current browser page.",
          };
        },
      },
    ]);
  }
  async open(ws: string, agentId: string, reason: string, taskId: string | null = null) {
    if (!["login", "2fa", "captcha"].includes(reason))
      throw new Error("Choose login, 2fa or captcha");
    if (
      !(
        await this.s.db.pool.query("select id from agents where workspace_id=$1 and id=$2", [
          ws,
          agentId,
        ])
      ).rowCount
    )
      throw new Error("No such agent");
    const [row] = await this.s.db.db
      .insert(handoffs)
      .values({ workspaceId: ws, agentId, taskId, reason })
      .returning();
    if (!row) throw new Error("Handoff failed");
    this.s.computers.hold({ workspaceId: ws, agentId });
    await this.s.db.db.update(agents).set({ status: "waiting" }).where(eq(agents.id, agentId));
    await this.s.events.write(ws, {
      type: "security.handoff",
      agentId,
      payload: { handoffId: row.id, taskId, reason, status: "waiting" },
    });
    return row;
  }
  async finish(ws: string, id: string, userId: string) {
    const row = (
      await this.s.db.pool.query<{ agent_id: string; task_id: string | null; reason: string }>(
        "update handoffs set status='done' where id=$1 and workspace_id=$2 and status='waiting' returning *",
        [id, ws],
      )
    ).rows[0];
    if (!row) throw new Error("No pending handoff");
    await this.s.computers.release({ workspaceId: ws, agentId: row.agent_id }, userId);
    this.s.computers.unhold({ workspaceId: ws, agentId: row.agent_id });
    await this.s.events.write(ws, {
      type: "security.handoff",
      agentId: row.agent_id,
      payload: { handoffId: id, taskId: row.task_id, reason: row.reason, status: "done" },
    });
  }
}
