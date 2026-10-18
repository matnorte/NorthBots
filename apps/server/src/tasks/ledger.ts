import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { actions } from "../db/schema.js";

/**
 * Idempotency ledger. `begin` claims a key atomically; a key that was already claimed is
 * never run again. One that started but never finished (a crash mid-action) is reported as
 * "outcome unknown" rather than repeated: re-sending an email is worse than checking.
 */
export class ActionLedger {
  constructor(private readonly db: DbHandle) {}

  async begin(key: string, ref: { workspaceId: string; taskId: string | null }, summary: string): Promise<{ done: true; result: string } | { done: false }> {
    const inserted = await this.db.db
      .insert(actions)
      .values({ idempotencyKey: key, workspaceId: ref.workspaceId, taskId: ref.taskId, summary })
      .onConflictDoNothing()
      .returning({ key: actions.idempotencyKey });
    if (inserted.length > 0) return { done: false };
    // A failed attempt changed nothing that matters, so it may be retried.
    const reclaimed = await this.db.db
      .update(actions)
      .set({ status: "started", finishedAt: null })
      .where(and(eq(actions.idempotencyKey, key), eq(actions.status, "failed")))
      .returning({ key: actions.idempotencyKey });
    if (reclaimed.length > 0) return { done: false };
    const [row] = await this.db.db.select().from(actions).where(eq(actions.idempotencyKey, key));
    if (row?.status === "started") {
      return { done: true, result: "This action was started before a restart and its outcome is unknown. Check the result with a read before doing anything else." };
    }
    return { done: true, result: row?.result ?? "" };
  }

  async finish(key: string, result: string, ok: boolean): Promise<void> {
    await this.db.db
      .update(actions)
      .set({ status: ok ? "done" : "failed", result: result.slice(0, 20_000), finishedAt: sql`now()` })
      .where(eq(actions.idempotencyKey, key));
  }
}
