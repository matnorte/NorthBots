import { and, eq, lte, sql } from "drizzle-orm";
import { startOfDayIn, scrubSecrets } from "@northbot/shared";
import type { Services } from "../services.js";
import {
  agents,
  events,
  notifications,
  rooms,
  scheduleRuns,
  schedules,
  skills,
} from "../db/schema.js";
type Row = typeof schedules.$inferSelect;
export type ScheduleDependencies = Pick<
  Services,
  "db" | "config" | "events" | "tasks" | "computers" | "approvals" | "ideas"
>;
const ACTIVE = ["queued", "running", "waiting_approval"];
/** Execution owns run claims, budget reservations, retries, timeouts and completion. */
export abstract class ScheduleExecutor {
  constructor(
    protected readonly s: ScheduleDependencies,
    readonly clock: () => Date,
  ) {}
  abstract get(workspaceId: string, id: string): Promise<Row | null>;
  protected abstract approved(row: Row): Promise<boolean>;
  protected abstract systemRun(row: Row, runId: string): Promise<void>;
  async execute(runId: string) {
    const { db } = this.s.db;
    const claimed = await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(scheduleRuns)
        .where(
          and(
            eq(scheduleRuns.id, runId),
            eq(scheduleRuns.status, "queued"),
            lte(scheduleRuns.availableAt, this.clock()),
          ),
        )
        .for("update", { skipLocked: true });
      if (!run) return null;
      const [schedule] = await tx
        .select()
        .from(schedules)
        .where(eq(schedules.id, run.scheduleId))
        .for("update");
      if (!schedule) return null;
      const other = await tx
        .select({ id: scheduleRuns.id })
        .from(scheduleRuns)
        .where(and(eq(scheduleRuns.scheduleId, schedule.id), eq(scheduleRuns.status, "running")));
      if (other.length && schedule.definition.overlapPolicy === "queue") {
        await tx
          .update(scheduleRuns)
          .set({ availableAt: new Date(this.clock().getTime() + 5000) })
          .where(eq(scheduleRuns.id, runId));
        return null;
      }
      const used = await tx
        .select({
          total: sql<string>`coalesce(sum(${scheduleRuns.costUsd} + ${scheduleRuns.reservedUsd}),0)`,
        })
        .from(scheduleRuns)
        .where(
          and(
            eq(scheduleRuns.scheduleId, schedule.id),
            sql`${scheduleRuns.scheduledAt} >= ${startOfDayIn(this.clock(), schedule.definition.timezone)}`,
          ),
        );
      const remaining = Math.max(
        0,
        schedule.definition.budgetUsdPerDay - Number(used[0]?.total ?? 0),
      );
      const [claim] = await tx
        .update(scheduleRuns)
        .set({
          status: "running",
          startedAt: this.clock(),
          reservedUsd: String(Math.min(schedule.definition.budgetUsdPerRun, remaining)),
        })
        .where(eq(scheduleRuns.id, runId))
        .returning();
      return {
        claim: claim!,
        row: schedule,
        skip: other.length > 0 && schedule.definition.overlapPolicy === "skip",
      };
    });
    if (!claimed) return;
    const { claim, row } = claimed;
    const d = row.definition;
    if (claimed.skip) {
      await this.finish(row, runId, "skipped_overlap", 0, null);
      return;
    }
    if (
      (await this.s.tasks.killSwitchOn(row.workspaceId)) ||
      (!row.enabled && !claim.idempotencyKey.includes(":manual:"))
    ) {
      await db
        .update(scheduleRuns)
        .set({
          status: "queued",
          startedAt: null,
          reservedUsd: "0",
          availableAt: new Date(this.clock().getTime() + 30_000),
        })
        .where(eq(scheduleRuns.id, runId));
      return;
    }
    if (!(await this.approved(row))) {
      await db
        .update(scheduleRuns)
        .set({
          status: "queued",
          startedAt: null,
          reservedUsd: "0",
          availableAt: new Date(this.clock().getTime() + 5000),
        })
        .where(eq(scheduleRuns.id, runId));
      return;
    }
    try {
      if (row.systemKey) {
        await this.systemRun(row, runId);
        await this.finish(row, runId, "done", 0, null);
        return;
      }
      const remaining = Number(claim.reservedUsd);
      if (remaining <= 0) {
        await this.finish(
          row,
          runId,
          "skipped_no_budget",
          0,
          "Schedule daily budget is exhausted.",
        );
        return;
      }
      let agentId = row.agentId;
      if (!agentId && row.roomId)
        agentId =
          (await db.select().from(rooms).where(eq(rooms.id, row.roomId)))[0]?.coordinatorAgentId ??
          null;
      if (!agentId) throw new Error("The target room has no coordinator.");
      if (d.skillId) {
        const skill = (await db.select().from(skills).where(eq(skills.id, d.skillId)))[0];
        if (!skill || skill.activeVersion !== d.skillVersion) {
          await db
            .update(schedules)
            .set({
              approvalId: null,
              approvedHash: null,
              enabled: false,
              lastStatus: "skill_changed",
            })
            .where(eq(schedules.id, row.id));
          throw new Error("The skill version changed. Review and re-enable this schedule.");
        }
      }
      await this.s.computers.ensureAwake(
        { workspaceId: row.workspaceId, agentId },
        "scheduled run",
      );
      if (claim.attempt > 0 && claim.taskId)
        await this.s.tasks.retry(row.workspaceId, claim.taskId);
      const ref = await this.s.tasks.create({
        workspaceId: row.workspaceId,
        agentId,
        userId: row.ownerId,
        by: "schedule",
        goal: d.skillId
          ? `${d.taskPrompt}\nUse approved skill ${d.skillId} version ${d.skillVersion}. Inputs: ${JSON.stringify(d.inputs)}`
          : d.taskPrompt,
        roomId: row.roomId,
        budgetUsd: Math.min(d.budgetUsdPerRun, remaining),
        idempotencyKey: claim.idempotencyKey,
      });
      const taskId = ref.task.id;
      await db.update(scheduleRuns).set({ taskId }).where(eq(scheduleRuns.id, runId));
      const started = await this.s.events.write(row.workspaceId, {
        type: "schedule.started",
        agentId,
        roomId: row.roomId,
        payload: {
          scheduleId: row.id,
          runId,
          scheduledAt: claim.scheduledAt.toISOString(),
          taskId,
        },
      });
      await db
        .update(scheduleRuns)
        .set({ eventIds: [...claim.eventIds, started.id] })
        .where(eq(scheduleRuns.id, runId));
      const deadline = Date.now() + d.maxRuntimeS * 1000;
      while (Date.now() < deadline) {
        const result = await this.s.db.pool.query<{ status: string; error: string | null }>(
          "select status,error from tasks where id=$1",
          [taskId],
        );
        const task = result.rows[0];
        if (!task || !ACTIVE.includes(task.status)) {
          const cost = await db
            .select({ total: sql<string>`coalesce(sum(${events.costUsd}),0)` })
            .from(events)
            .where(
              and(
                eq(events.workspaceId, row.workspaceId),
                sql`${events.payload}->>'taskId' = ${taskId}`,
              ),
            );
          const usd = Number(cost[0]?.total ?? 0);
          await this.finish(
            row,
            runId,
            task?.status === "done" && usd <= d.budgetUsdPerRun && usd <= remaining
              ? "done"
              : "failed",
            usd,
            task?.error ??
              (usd > Math.min(d.budgetUsdPerRun, remaining)
                ? "Run budget exceeded."
                : task?.status === "done"
                  ? null
                  : "Task did not complete."),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await this.s.tasks.cancel(row.workspaceId, taskId, row.ownerId ?? row.workspaceId);
      await this.s.computers.stopCommands({ workspaceId: row.workspaceId, agentId });
      await this.finish(row, runId, "failed", 0, "Maximum run time exceeded.");
    } catch (e) {
      await this.finish(
        row,
        runId,
        "failed",
        0,
        scrubSecrets(e instanceof Error ? e.message : "Run failed."),
      );
    }
  }
  protected async failExpired(id: string) {
    const [run] = await this.s.db.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id));
    if (!run || run.status !== "running") return;
    const row = await this.get(run.workspaceId, run.scheduleId);
    if (!row) return;
    if (run.taskId)
      await this.s.tasks.cancel(row.workspaceId, run.taskId, row.ownerId ?? row.workspaceId);
    await this.finish(
      row,
      id,
      "failed",
      Number(run.costUsd),
      "Run expired after a worker restart.",
    );
  }
  private async finish(
    row: Row,
    runId: string,
    status: string,
    cost: number,
    error: string | null,
  ) {
    const [run] = await this.s.db.db
      .update(scheduleRuns)
      .set({ status, costUsd: String(cost), reservedUsd: "0", error, finishedAt: this.clock() })
      .where(and(eq(scheduleRuns.id, runId), eq(scheduleRuns.status, "running")))
      .returning();
    if (!run) return;
    const event = await this.s.events.write(row.workspaceId, {
      type: "schedule.finished",
      agentId: row.agentId,
      roomId: row.roomId,
      payload: { scheduleId: row.id, runId, status, costUsd: cost, error },
    });
    await this.s.db.db
      .update(scheduleRuns)
      .set({ eventIds: [...run.eventIds, event.id] })
      .where(eq(scheduleRuns.id, runId));
    const failed = status === "failed";
    const [updated] = await this.s.db.db
      .update(schedules)
      .set({
        lastRunAt: this.clock(),
        lastStatus: status,
        consecutiveFailures: failed
          ? sql`${schedules.consecutiveFailures} + 1`
          : status === "done"
            ? 0
            : sql`${schedules.consecutiveFailures}`,
      })
      .where(eq(schedules.id, row.id))
      .returning();
    if (failed && updated && updated.consecutiveFailures >= row.definition.pauseAfterFailures) {
      await this.s.db.db
        .update(schedules)
        .set({ enabled: false, lastStatus: "paused_failures" })
        .where(eq(schedules.id, row.id));
      await this.s.events.write(row.workspaceId, {
        type: "schedule.paused",
        agentId: row.agentId,
        payload: {
          scheduleId: row.id,
          failures: updated.consecutiveFailures,
          reason: error ?? "Repeated failures",
        },
      });
      if (row.agentId) {
        await this.s.db.db
          .update(agents)
          .set({ mood: "worried" })
          .where(eq(agents.id, row.agentId));
        await this.s.events.write(row.workspaceId, {
          type: "agent.mood",
          agentId: row.agentId,
          payload: {
            mood: "worried",
            cause: "A scheduled routine needs a hand.",
            fix: "view_task",
            detail: { scheduleId: row.id },
          },
        });
      }
      await this.s.db.db.insert(notifications).values({
        workspaceId: row.workspaceId,
        agentId: row.agentId,
        body: `Paused ${row.definition.name} after repeated failures. Review its run history.`,
        kind: "schedule",
        deliverAt: this.clock(),
      });
    } else if (failed && run.attempt < row.definition.retries) {
      // Resume the same task checkpoint; its action ledger prevents repeating completed writes.
      await this.s.db.db
        .update(scheduleRuns)
        .set({
          status: "queued",
          attempt: run.attempt + 1,
          startedAt: null,
          finishedAt: null,
          availableAt: new Date(
            this.clock().getTime() + row.definition.retryBackoffS * 2 ** run.attempt * 1000,
          ),
        })
        .where(eq(scheduleRuns.id, runId));
    }
  }
}
