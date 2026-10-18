import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { ScheduleDefinition, duePlan, nextTimes, validateTiming } from "@northbot/scheduler";
import type { ActionKind } from "@northbot/agent-runtime";
import { startOfDayIn } from "@northbot/shared";
import { ScheduleExecutor, type ScheduleDependencies } from "./execution.js";
import {
  agents,
  approvals,
  facts,
  rooms,
  scheduleRuns,
  schedules,
  skills,
  workspaces,
} from "../db/schema.js";
import { ScheduleQueue } from "./queue.js";
import type { z } from "zod";

type Row = typeof schedules.$inferSelect;
const hash = (s: Row) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        agentId: s.agentId,
        roomId: s.roomId,
        prompt: s.definition.taskPrompt,
        skillId: s.definition.skillId,
        skillVersion: s.definition.skillVersion,
        inputs: s.definition.inputs,
        actionKind: s.definition.actionKind,
        requiresApproval: s.definition.requiresApprovalFirstRun,
      }),
    )
    .digest("hex");
const SYSTEM = [
  { key: "health-canary", cron: "0 7 * * *", name: "Daily health canary" },
  { key: "idea-picker", cron: "0 8 * * 1", name: "Weekly idea-bin picker" },
  { key: "backup", cron: "0 3 * * *", name: "Nightly backup" },
  { key: "memory-expiry", cron: "0 4 * * *", name: "Daily memory expiry sweep" },
  { key: "cost-summary", cron: "0 18 * * *", name: "Daily cost summary" },
  { key: "skill-review", cron: "0 9 * * 1", name: "Weekly skill-usage review" },
];

/** Due rows are locked in Postgres; the durable outbox is delivered through pg-boss. */
export class ScheduleService extends ScheduleExecutor {
  private queue: ScheduleQueue | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private systemReady = new Set<string>();
  constructor(s: ScheduleDependencies, clock: () => Date = () => new Date()) {
    super(s, clock);
  }

  attachProposalTool() {
    this.s.tasks.provideTools((ctx) => [
      {
        def: {
          name: "propose_schedule",
          description:
            "Propose a recurring routine or reminder for yourself. A human must approve it before its first run. Never changes your tool permissions.",
          parameters: {
            type: "object",
            required: ["name", "taskPrompt"],
            properties: {
              name: { type: "string" },
              taskPrompt: { type: "string" },
              cronExpr: { type: "string", description: "Five fields; default 09:00 weekdays" },
              timezone: { type: "string" },
              budgetUsdPerRun: { type: "number" },
            },
          },
        },
        kind: "write" as const,
        run: async (args) => {
          const row = await this.create(
            ctx.workspaceId,
            null,
            { agentId: ctx.agentId, roomId: null, definition: ScheduleDefinition.parse(args) },
            "agent",
          );
          return { ok: true, output: `Proposed schedule ${row.id}; waiting for human approval.` };
        },
      },
    ]);
  }

  async start(onError: (error: Error) => void) {
    this.queue = new ScheduleQueue(this.s.config.DATABASE_URL);
    await this.queue.start((id) => this.execute(id), onError);
    const tick = async () => {
      if (this.ticking) return;
      this.ticking = true;
      try {
        await this.tick();
      } catch (e) {
        onError(e instanceof Error ? e : new Error("Scheduler tick failed"));
      } finally {
        this.ticking = false;
      }
    };
    const workspacesToSeed = await this.s.db.db.select({ id: workspaces.id }).from(workspaces);
    for (const workspace of workspacesToSeed) await this.ensureSystem(workspace.id);
    await tick();
    this.timer = setInterval(() => void tick(), 5000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.queue?.stop();
    this.queue = null;
  }

  async list(workspaceId: string) {
    await this.ensureSystem(workspaceId);
    return this.s.db.db
      .select()
      .from(schedules)
      .where(eq(schedules.workspaceId, workspaceId))
      .orderBy(desc(schedules.createdAt));
  }
  async get(workspaceId: string, id: string) {
    return (
      (
        await this.s.db.db
          .select()
          .from(schedules)
          .where(and(eq(schedules.id, id), eq(schedules.workspaceId, workspaceId)))
      )[0] ?? null
    );
  }
  async history(workspaceId: string, id?: string) {
    return this.s.db.db
      .select()
      .from(scheduleRuns)
      .where(
        and(
          eq(scheduleRuns.workspaceId, workspaceId),
          id ? eq(scheduleRuns.scheduleId, id) : undefined,
        ),
      )
      .orderBy(desc(scheduleRuns.scheduledAt))
      .limit(200);
  }
  async create(
    workspaceId: string,
    userId: string | null,
    input: {
      agentId: string | null;
      roomId: string | null;
      definition: z.input<typeof ScheduleDefinition>;
    },
    by = "user",
  ) {
    await this.ensureSystem(workspaceId);
    const [workspace] = await this.s.db.db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const definition = ScheduleDefinition.parse({
      ...input.definition,
      timezone: input.definition.timezone ?? workspace?.timezone,
    });
    validateTiming(definition, this.s.config.SCHEDULE_MIN_INTERVAL_S);
    if (Boolean(input.agentId) === Boolean(input.roomId))
      throw new Error("Choose exactly one agent or room.");
    if (
      input.agentId &&
      !(
        await this.s.db.db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, workspaceId)))
      )[0]
    )
      throw new Error("No such agent.");
    if (
      input.roomId &&
      !(
        await this.s.db.db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.id, input.roomId), eq(rooms.workspaceId, workspaceId)))
      )[0]
    )
      throw new Error("No such room.");
    if (definition.skillId) {
      const skill = (
        await this.s.db.db
          .select()
          .from(skills)
          .where(and(eq(skills.id, definition.skillId), eq(skills.workspaceId, workspaceId)))
      )[0];
      if (!skill || !skill.activeVersion)
        throw new Error("Choose an approved skill in this workspace.");
      definition.skillVersion = skill.activeVersion;
    }
    const [row] = await this.s.db.db
      .insert(schedules)
      .values({
        workspaceId,
        ownerId: userId,
        ...input,
        definition,
        enabled: definition.enabled,
        nextRunAt: nextTimes(definition, this.clock(), 1)[0] ?? null,
        createdBy: by,
      })
      .returning();
    if (!row) throw new Error("Schedule insert failed.");
    if (by === "agent") await this.requestApproval(row, "write");
    await this.changed(row, userId);
    return row;
  }
  async edit(workspaceId: string, id: string, userId: string, patch: Partial<ScheduleDefinition>) {
    const row = await this.get(workspaceId, id);
    if (!row) return null;
    if (row.systemKey && Object.keys(patch).some((k) => k !== "enabled"))
      throw new Error("System schedules can only be paused or resumed.");
    const definition = ScheduleDefinition.parse({ ...row.definition, ...patch });
    if (definition.skillId) {
      const skill = (
        await this.s.db.db
          .select()
          .from(skills)
          .where(and(eq(skills.id, definition.skillId), eq(skills.workspaceId, workspaceId)))
      )[0];
      if (!skill?.activeVersion) throw new Error("Choose an approved skill in this workspace.");
      definition.skillVersion = skill.activeVersion;
    }
    validateTiming(definition, this.s.config.SCHEDULE_MIN_INTERVAL_S);
    const next =
      patch.kind || patch.cronExpr || patch.runAt || patch.intervalS || patch.timezone
        ? (nextTimes(definition, this.clock(), 1)[0] ?? null)
        : row.nextRunAt;
    const changed = hash({ ...row, definition }) !== hash(row);
    const [saved] = await this.s.db.db
      .update(schedules)
      .set({
        definition,
        enabled: definition.enabled,
        nextRunAt: next,
        consecutiveFailures: patch.enabled ? 0 : row.consecutiveFailures,
        ...(changed ? { approvalId: null, approvedHash: null } : {}),
      })
      .where(eq(schedules.id, id))
      .returning();
    if (saved) await this.changed(saved, userId);
    return saved ?? null;
  }
  async remove(workspaceId: string, id: string) {
    const row = await this.get(workspaceId, id);
    if (!row) return false;
    if (row.systemKey) throw new Error("System schedules cannot be deleted.");
    await this.s.db.db.delete(schedules).where(eq(schedules.id, id));
    await this.changed({ ...row, enabled: false, nextRunAt: null }, null);
    return true;
  }
  async runNow(workspaceId: string, id: string, dryRun = false, idempotencyKey?: string) {
    const row = await this.get(workspaceId, id);
    if (!row) throw new Error("No such schedule.");
    if (dryRun)
      return {
        dryRun: true,
        prompt: row.definition.taskPrompt,
        permission: this.actionKind(row),
        approved: row.approvedHash === hash(row),
        nextRuns: nextTimes(row.definition, this.clock(), 5).map((d) => d.toISOString()),
        budgetUsd: row.definition.budgetUsdPerRun,
      };
    if (await this.s.tasks.killSwitchOn(workspaceId)) throw new Error("The kill switch is on.");
    const now = this.clock();
    const [run] = await this.s.db.db
      .insert(scheduleRuns)
      .values({
        scheduleId: id,
        workspaceId,
        scheduledAt: now,
        availableAt: now,
        idempotencyKey: idempotencyKey ?? `${id}:manual:${randomUUID()}`,
      })
      .onConflictDoNothing({ target: scheduleRuns.idempotencyKey })
      .returning();
    if (!run) {
      const [existing] = await this.s.db.db
        .select()
        .from(scheduleRuns)
        .where(
          and(
            eq(scheduleRuns.workspaceId, workspaceId),
            eq(scheduleRuns.scheduleId, id),
            eq(scheduleRuns.idempotencyKey, idempotencyKey ?? ""),
          ),
        );
      if (!existing) throw new Error("Run insert failed.");
      if (existing.status === "queued") await this.queue?.send(existing.id);
      return existing;
    }
    await this.queue?.send(run.id);
    return run;
  }
  private actionKind(row: Row): ActionKind {
    const prompt = row.definition.taskPrompt.toLowerCase();
    const inferred: ActionKind = /\b(send|email|post|publish)\b/.test(prompt)
      ? "send"
      : /\b(buy|pay|purchase)\b/.test(prompt)
        ? "spend"
        : /\b(delete|remove)\b/.test(prompt)
          ? "delete"
          : /\b(write|save|create|update|edit)\b|[>]/.test(prompt)
            ? "write"
            : "read";
    return row.definition.requiresApprovalFirstRun || row.createdBy === "agent"
      ? "write"
      : row.definition.actionKind !== "read"
        ? row.definition.actionKind
        : inferred;
  }
  private async requestApproval(row: Row, kind = this.actionKind(row)) {
    let agentId = row.agentId;
    if (!agentId && row.roomId)
      agentId =
        (await this.s.db.db.select().from(rooms).where(eq(rooms.id, row.roomId)))[0]
          ?.coordinatorAgentId ?? null;
    if (!agentId) throw new Error("A scheduled room needs a coordinator.");
    const approval = await this.s.approvals.open(
      { workspaceId: row.workspaceId, agentId, taskId: null },
      {
        kind,
        tool: "schedule",
        args: { scheduleId: row.id, hash: hash(row) },
        summary: `First run of ${row.definition.name}: ${row.definition.taskPrompt.slice(0, 180)}`,
        targets: [],
      },
      "Review this schedule's dry run, limits and prompt before it acts. Editing the prompt or skill requires another approval.",
    );
    await this.s.db.db
      .update(schedules)
      .set({ approvalId: approval.id, lastStatus: "waiting_approval" })
      .where(eq(schedules.id, row.id));
    return approval;
  }
  protected async approved(row: Row): Promise<boolean> {
    if (row.systemKey || this.actionKind(row) === "read") return true;
    if (row.approvedHash === hash(row)) return true;
    // A schedule run by an agent at full access needs no first-run review.
    if (row.agentId) {
      const level = (
        await this.s.db.db.select({ autonomy: agents.autonomyLevel }).from(agents).where(eq(agents.id, row.agentId))
      )[0]?.autonomy;
      if (level === "full_access") return true;
    }
    const approval = row.approvalId
      ? (await this.s.db.db.select().from(approvals).where(eq(approvals.id, row.approvalId)))[0]
      : await this.requestApproval(row);
    if (
      approval?.status === "approved" &&
      (approval.action as { args?: { hash?: string } }).args?.hash === hash(row)
    ) {
      await this.s.db.db
        .update(schedules)
        .set({ approvedHash: hash(row) })
        .where(eq(schedules.id, row.id));
      return true;
    }
    return false;
  }
  private async changed(row: Row, userId: string | null) {
    await this.s.events.write(row.workspaceId, {
      type: "schedule.changed",
      agentId: row.agentId,
      roomId: row.roomId,
      payload: {
        scheduleId: row.id,
        name: row.definition.name,
        enabled: row.enabled,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        userId,
      },
    });
  }

  async tick(now = this.clock()) {
    const { db, pool } = this.s.db;
    const advanced: Row[] = [];
    await db.transaction(async (tx) => {
      const due = await tx
        .select({ row: schedules })
        .from(schedules)
        .innerJoin(workspaces, eq(workspaces.id, schedules.workspaceId))
        .where(
          and(
            eq(schedules.enabled, true),
            lte(schedules.nextRunAt, now),
            isNull(workspaces.killSwitchAt),
          ),
        )
        .for("update", { of: schedules, skipLocked: true })
        .limit(100);
      for (const { row } of due) {
        const plan = duePlan(row.definition, row.nextRunAt!, now);
        for (const at of plan.due)
          await tx
            .insert(scheduleRuns)
            .values({
              scheduleId: row.id,
              workspaceId: row.workspaceId,
              scheduledAt: at,
              availableAt: new Date(
                now.getTime() + Math.floor(Math.random() * (row.definition.jitterS + 1)) * 1000,
              ),
              idempotencyKey: `${row.id}:${at.toISOString()}`,
            })
            .onConflictDoNothing();
        await tx.update(schedules).set({ nextRunAt: plan.next }).where(eq(schedules.id, row.id));
        advanced.push({ ...row, nextRunAt: plan.next });
      }
    });
    for (const row of advanced) await this.changed(row, null);
    // Persisted outbox closes the commit/enqueue crash gap. Duplicate queue delivery is safe.
    const queued = await db
      .select({ id: scheduleRuns.id })
      .from(scheduleRuns)
      .where(and(eq(scheduleRuns.status, "queued"), lte(scheduleRuns.availableAt, now)))
      .limit(100);
    for (const row of queued) await this.queue?.send(row.id);
    // A crashed worker cannot leave a run occupying the overlap slot forever.
    const expired = await pool.query<{ id: string }>(
      "select r.id from schedule_runs r join schedules s on s.id=r.schedule_id where r.status='running' and r.started_at + ((s.definition->>'maxRuntimeS')::int * interval '1 second') < $1",
      [now],
    );
    for (const row of expired.rows) await this.failExpired(row.id);
    return queued.length;
  }

  async ensureSystem(workspaceId: string) {
    if (this.systemReady.has(workspaceId)) return;
    const [ws] = await this.s.db.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!ws) return;
    this.systemReady.add(workspaceId);
    for (const item of SYSTEM) {
      const definition = ScheduleDefinition.parse({
        name: item.name,
        cronExpr: item.cron,
        timezone: ws.timezone,
        taskPrompt: `Run system routine: ${item.key}`,
        retries: 0,
      });
      await this.s.db.db
        .insert(schedules)
        .values({
          workspaceId,
          definition,
          systemKey: item.key,
          enabled: item.key !== "backup",
          nextRunAt: nextTimes(definition, this.clock(), 1)[0],
          createdBy: "system",
        })
        .onConflictDoNothing();
    }
  }
  protected async systemRun(row: Row, runId: string) {
    let summary = "";
    switch (row.systemKey) {
      case "health-canary":
        if (!(await this.s.db.ping())) throw new Error("Database canary failed.");
        summary = "Database and worker are healthy.";
        break;
      case "idea-picker": {
        const result = await this.s.ideas.pick(row.workspaceId);
        summary = JSON.stringify(result);
        break;
      }
      case "memory-expiry": {
        const deleted = await this.s.db.db
          .delete(facts)
          .where(and(eq(facts.workspaceId, row.workspaceId), lte(facts.expiresAt, this.clock())))
          .returning({ id: facts.id });
        summary = `Expired ${deleted.length} memories.`;
        break;
      }
      case "cost-summary": {
        const result = await this.s.db.pool.query<{ total: string }>(
          "select coalesce(sum(cost_usd),0) total from events where workspace_id=$1 and ts >= $2",
          [row.workspaceId, startOfDayIn(this.clock(), row.definition.timezone)],
        );
        summary = `Today's model spend: USD ${result.rows[0]?.total ?? 0}.`;
        break;
      }
      case "skill-review": {
        const result = await this.s.db.pool.query<{ count: string }>(
          "select count(*) from events where workspace_id=$1 and type='skill.used' and ts >= $2",
          [row.workspaceId, new Date(this.clock().getTime() - 7 * 86400_000)],
        );
        summary = `${result.rows[0]?.count ?? 0} approved skill uses this week.`;
        break;
      }
      case "backup":
        throw new Error(
          "Backups run on the host: `northbot backup` (install.sh schedules it nightly at 03:00). Keep this routine off.",
        );
      default:
        throw new Error("Unknown system routine.");
    }
    await this.s.events.write(row.workspaceId, {
      type: "schedule.system",
      payload: { scheduleId: row.id, runId, operation: row.systemKey!, summary },
    });
  }
}
