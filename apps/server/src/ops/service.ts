import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { newTaskState, TaskRunner, type RunnerDeps } from "@northbot/agent-runtime";
import { FakeTurn, Router, RouterConfig } from "@northbot/llm-router";
import { FakeSandbox } from "@northbot/sandbox";
import { VERSION } from "../config.js";
import type { DbHandle } from "../db/client.js";
import { tryLocked } from "../db/lock.js";
import {
  agents,
  deadLetters,
  events,
  incidents,
  opsChecks,
  sandboxes,
  scheduleRuns,
  schedules,
  tasks,
} from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { ScheduleService } from "../schedules/service.js";
import type { TaskRow, TaskService } from "../tasks/service.js";
import type { SecretBox } from "../vault/crypto.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

const STARTED = Date.now();
const nl = String.fromCharCode(10);
const firstLine = (s: string) => (s.split(nl)[0] ?? s).slice(0, 200);

/**
 * Operations: canary checks (including a canary task through the real agent loop with a
 * scripted model and an in-memory computer, so it costs nothing), a dead-letter queue for failed
 * work, searchable run history, incident reports and the data behind the public status page.
 */
export class OpsService {
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly tasks: TaskService,
    private readonly schedules: ScheduleService,
    private readonly box: SecretBox,
  ) {
    tasks.onFinish((task, final) =>
      final.status === "failed" || final.status === "blocked"
        ? this.deadTask(task, final.error ?? final.status)
        : Promise.resolve(),
    );
    this.off = events.subscribeAll((workspaceId, e) => {
      if (e.type === "schedule.finished" && e.payload.status === "failed")
        void this.deadRun(
          workspaceId,
          String(e.payload.runId),
          String(e.payload.scheduleId),
          String(e.payload.error ?? "failed"),
        ).catch(() => {});
    });
  }

  start(everyMs: number): void {
    if (everyMs <= 0) return;
    this.timer = setInterval(() => void this.canary().catch(() => {}), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.off?.();
  }

  // ---------- canary ----------

  private async timed(name: string, fn: () => Promise<void>): Promise<CheckResult> {
    const t0 = performance.now();
    try {
      await fn();
      return { name, ok: true, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      return {
        name,
        ok: false,
        ms: Math.round(performance.now() - t0),
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  /** Runs every check, stores the result, and returns it. */
  async canary(): Promise<{ ok: boolean; checks: CheckResult[]; at: string }> {
    const checks = [
      await this.timed("database", async () => {
        await this.db.pool.query("select 1");
      }),
      await this.timed("vault_crypto", async () => {
        const sealed = this.box.seal("ops:canary", "canary");
        if (this.box.open("ops:canary", sealed) !== "canary")
          throw new Error("vault round trip changed the value");
      }),
      await this.timed("scheduler", async () => {
        const [late] = await this.db.db
          .select({ n: sql<number>`count(*)::int` })
          .from(schedules)
          .where(
            and(
              eq(schedules.enabled, true),
              lte(schedules.nextRunAt, new Date(Date.now() - 10 * 60_000)),
            ),
          );
        if ((late?.n ?? 0) > 0)
          throw new Error(`${late!.n} schedule(s) are more than 10 minutes late`);
      }),
      await this.timed("stuck_tasks", async () => {
        const [stuck] = await this.db.db
          .select({ n: sql<number>`count(*)::int` })
          .from(tasks)
          .where(
            and(
              eq(tasks.status, "running"),
              lte(tasks.updatedAt, new Date(Date.now() - 2 * 3600_000)),
            ),
          );
        if ((stuck?.n ?? 0) > 0) throw new Error(`${stuck!.n} task(s) have not moved for 2 hours`);
      }),
      await this.timed("agent_runtime", () => this.canaryTask()),
    ];
    const ok = checks.every((c) => c.ok);
    const [row] = await this.db.db.insert(opsChecks).values({ ok, checks }).returning();
    // Keep a week of history.
    await this.db.db
      .delete(opsChecks)
      .where(lte(opsChecks.createdAt, new Date(Date.now() - 7 * 86_400_000)));
    return { ok, checks, at: (row?.createdAt ?? new Date()).toISOString() };
  }

  /** A canary task: the real agent loop (plan, a tool call, permissions, verification) on a script. */
  private async canaryTask(): Promise<void> {
    const sh = (command: string) =>
      FakeTurn.parse({ toolCalls: [{ name: "terminal", arguments: { command } }] });
    const router = new Router(
      RouterConfig.parse({
        providers: [
          {
            name: "w",
            type: "fake",
            kind: "local",
            models: ["m"],
            fake: {
              script: [
                sh("echo canary > c.txt"),
                sh("cat c.txt"),
                { text: "draft" },
                { text: "canary ok" },
              ],
            },
          },
          {
            name: "h",
            type: "fake",
            kind: "local",
            models: ["m"],
            fake: {
              reply: "{}",
              match: [
                { contains: "You plan work", text: '{"steps":["write","read"]}' },
                {
                  contains: "You check",
                  text: '{"summary":"ok","claims":[{"text":"c.txt says canary","status":"verified","evidence":"cat"}]}',
                },
              ],
            },
          },
        ],
        aliases: {},
      }),
    );
    const sandbox = new FakeSandbox();
    await sandbox.create({ id: "canary", egressProxyUrl: "" });
    const ledger = new Map<string, string>();
    const deps: RunnerDeps = {
      agent: { name: "Canary", persona: "", autonomy: "act_within_limits" },
      models: { worker: "w/m", planner: "h/m", verifier: "h/m" },
      chat: (req, signal) => router.chat(req, { workspaceId: "canary", privacy: "normal", signal }),
      terminal: async (command) => {
        const r = await sandbox.exec("canary", command);
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
      },
      browser: async () => ({}),
      elementText: async () => "",
      rules: async () => [],
      saveRule: async () => {},
      askHuman: async () => "deny",
      waitForControl: async () => {},
      actionBegin: async (key) =>
        ledger.has(key) ? { done: true, result: ledger.get(key)! } : { done: false },
      actionFinish: async (key, result) => void ledger.set(key, result),
      save: async () => {},
      emit: async () => {},
      setAgentStatus: async () => {},
      maxSteps: 8,
    };
    const final = await new TaskRunner(deps).run(
      newTaskState("canary", "Write canary to c.txt and read it back"),
      AbortSignal.timeout(20_000),
    );
    if (final.status !== "done")
      throw new Error(`the canary task ended ${final.status}: ${final.error ?? ""}`);
    if ((await sandbox.exec("canary", "cat c.txt")).stdout !== "canary\n")
      throw new Error("the canary task did not write its file");
    if (final.report?.claims[0]?.status !== "verified")
      throw new Error("the canary report was not verified");
  }

  async lastCheck() {
    const [row] = await this.db.db
      .select()
      .from(opsChecks)
      .orderBy(desc(opsChecks.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Public status: no workspace data, just whether the instance is healthy. */
  async status() {
    const last = await this.lastCheck();
    const recent = await this.db.db
      .select({ ok: opsChecks.ok, at: opsChecks.createdAt })
      .from(opsChecks)
      .orderBy(desc(opsChecks.createdAt))
      .limit(48);
    const stale = !last || Date.now() - last.createdAt.getTime() > 30 * 60_000;
    return {
      status: !last ? "unknown" : !last.ok ? "degraded" : stale ? "stale" : "operational",
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
      lastCheckAt: last?.createdAt.toISOString() ?? null,
      checks: (last?.checks ?? []).map((c) => ({ name: c.name, ok: c.ok })),
      history: recent.map((r) => ({ ok: r.ok, at: r.at.toISOString() })).reverse(),
    };
  }

  // ---------- health dashboard ----------

  async health(workspaceId: string) {
    const since = new Date(Date.now() - 86_400_000);
    const t0 = performance.now();
    await this.db.pool.query("select 1");
    const dbMs = Math.round(performance.now() - t0);
    const taskRows = await this.db.db
      .select({ status: tasks.status, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), gte(tasks.createdAt, since)))
      .groupBy(tasks.status);
    const byStatus = Object.fromEntries(taskRows.map((r) => [r.status, r.n]));
    const finished = (byStatus.done ?? 0) + (byStatus.failed ?? 0) + (byStatus.blocked ?? 0);
    const [llm] = await this.db.db
      .select({
        calls: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where (${events.payload}->>'ok')::boolean is false)::int`,
        cost: sql<number>`coalesce(sum(${events.costUsd}), 0)::float`,
      })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.type, "llm.call"),
          gte(events.ts, since),
        ),
      );
    const computers = await this.db.db
      .select({ state: sandboxes.state, n: sql<number>`count(*)::int` })
      .from(sandboxes)
      .where(eq(sandboxes.workspaceId, workspaceId))
      .groupBy(sandboxes.state);
    const [sched] = await this.db.db
      .select({
        enabled: sql<number>`count(*) filter (where ${schedules.enabled})::int`,
        failing: sql<number>`count(*) filter (where ${schedules.lastStatus} = 'failed')::int`,
      })
      .from(schedules)
      .where(eq(schedules.workspaceId, workspaceId));
    const [dead] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(deadLetters)
      .where(and(eq(deadLetters.workspaceId, workspaceId), eq(deadLetters.status, "open")));
    const last = await this.lastCheck();
    return {
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
      databaseMs: dbMs,
      tasks24h: byStatus,
      failureRate: finished
        ? Math.round((1000 * ((byStatus.failed ?? 0) + (byStatus.blocked ?? 0))) / finished) / 1000
        : 0,
      llm24h: {
        calls: llm?.calls ?? 0,
        errors: llm?.errors ?? 0,
        costUsd: Math.round((llm?.cost ?? 0) * 10_000) / 10_000,
      },
      computers: Object.fromEntries(computers.map((c) => [c.state, c.n])),
      schedules: { enabled: sched?.enabled ?? 0, failing: sched?.failing ?? 0 },
      deadLetters: dead?.n ?? 0,
      canary: last ? { ok: last.ok, at: last.createdAt.toISOString(), checks: last.checks } : null,
    };
  }

  // ---------- dead letters ----------

  private async deadTask(task: TaskRow, reason: string): Promise<void> {
    const [row] = await this.db.db
      .insert(deadLetters)
      .values({
        workspaceId: task.workspaceId,
        kind: "task",
        refId: task.id,
        agentId: task.agentId,
        summary: firstLine(task.goal),
        reason: reason.slice(0, 1000),
      })
      .onConflictDoNothing()
      .returning();
    if (row)
      await this.events.write(task.workspaceId, {
        type: "ops.dead_letter",
        agentId: task.agentId,
        payload: { deadLetterId: row.id, kind: "task", refId: task.id, operation: "added" },
      });
  }

  private async deadRun(
    workspaceId: string,
    runId: string,
    scheduleId: string,
    reason: string,
  ): Promise<void> {
    const [s] = await this.db.db
      .select({ name: sql<string>`${schedules.definition}->>'name'`, agentId: schedules.agentId })
      .from(schedules)
      .where(eq(schedules.id, scheduleId));
    const [row] = await this.db.db
      .insert(deadLetters)
      .values({
        workspaceId,
        kind: "schedule_run",
        refId: runId,
        agentId: s?.agentId ?? null,
        summary: `Scheduled run of "${s?.name ?? "a routine"}"`,
        reason: reason.slice(0, 1000),
      })
      .onConflictDoNothing()
      .returning();
    if (row)
      await this.events.write(workspaceId, {
        type: "ops.dead_letter",
        payload: { deadLetterId: row.id, kind: "schedule_run", refId: runId, operation: "added" },
      });
  }

  async deadLetters(workspaceId: string, status = "open") {
    return this.db.db
      .select()
      .from(deadLetters)
      .where(and(eq(deadLetters.workspaceId, workspaceId), eq(deadLetters.status, status)))
      .orderBy(desc(deadLetters.createdAt))
      .limit(200);
  }

  /** Retries failed work: a failed task runs again as a new task; a failed scheduled run runs now. */
  async retry(
    workspaceId: string,
    id: string,
    userId: string,
  ): Promise<{ retriedAs: string } | null> {
    const result = await tryLocked(this.db, `dead-letter:${workspaceId}:${id}`, () =>
      this.retryLocked(workspaceId, id, userId),
    );
    return result.locked ? result.value : null;
  }

  private async retryLocked(workspaceId: string, id: string, userId: string) {
    const [d] = await this.db.db
      .select()
      .from(deadLetters)
      .where(
        and(
          eq(deadLetters.id, id),
          eq(deadLetters.workspaceId, workspaceId),
          eq(deadLetters.status, "open"),
        ),
      );
    if (!d) return null;
    let newId: string;
    if (d.kind === "task") {
      const [t] = await this.db.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, d.refId), eq(tasks.workspaceId, workspaceId)));
      if (!t) return null;
      newId = (
        await this.tasks.create({
          workspaceId,
          agentId: t.agentId,
          goal: t.goal,
          by: "user",
          userId,
          idempotencyKey: `ops-retry:${workspaceId}:${id}`,
          budgetUsd: t.budgetUsd === null ? null : Number(t.budgetUsd),
          tainted: t.state?.tainted === true || t.createdBy === "agent",
          threadId: t.threadId,
          roomId: t.roomId,
          letterId: t.letterId,
          deadline: t.deadline,
        })
      ).task.id;
    } else {
      const [run] = await this.db.db
        .select()
        .from(scheduleRuns)
        .where(and(eq(scheduleRuns.id, d.refId), eq(scheduleRuns.workspaceId, workspaceId)));
      if (!run) return null;
      const again = (await this.schedules.runNow(
        workspaceId,
        run.scheduleId,
        false,
        `ops-retry:${workspaceId}:${id}`,
      )) as { id: string };
      newId = again.id;
    }
    await this.db.db
      .update(deadLetters)
      .set({
        status: "retried",
        retriedAs: newId,
        attempts: d.attempts + 1,
        resolvedAt: new Date(),
      })
      .where(eq(deadLetters.id, id));
    await this.events.write(workspaceId, {
      type: "ops.dead_letter",
      agentId: d.agentId,
      payload: { deadLetterId: id, kind: d.kind, refId: d.refId, operation: "retried" },
    });
    return { retriedAs: newId };
  }

  async dismiss(workspaceId: string, id: string): Promise<boolean> {
    const result = await tryLocked(this.db, `dead-letter:${workspaceId}:${id}`, () =>
      this.dismissLocked(workspaceId, id),
    );
    return result.locked && result.value;
  }

  private async dismissLocked(workspaceId: string, id: string): Promise<boolean> {
    const [d] = await this.db.db
      .update(deadLetters)
      .set({ status: "dismissed", resolvedAt: new Date() })
      .where(
        and(
          eq(deadLetters.id, id),
          eq(deadLetters.workspaceId, workspaceId),
          eq(deadLetters.status, "open"),
        ),
      )
      .returning();
    if (d)
      await this.events.write(workspaceId, {
        type: "ops.dead_letter",
        agentId: d.agentId,
        payload: { deadLetterId: id, kind: d.kind, refId: d.refId, operation: "dismissed" },
      });
    return Boolean(d);
  }

  // ---------- run history ----------

  /** Searches tasks (goal and report text) and scheduled runs. */
  async runs(
    workspaceId: string,
    q: { text?: string; status?: string; agentId?: string; from?: Date; to?: Date; limit?: number },
  ) {
    const conds: SQL[] = [eq(tasks.workspaceId, workspaceId)];
    if (q.text) {
      const like = `%${q.text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      conds.push(
        or(
          ilike(tasks.goal, like),
          sql`${tasks.report}::text ilike ${like}`,
          ilike(tasks.error, like),
        )!,
      );
    }
    if (q.status) conds.push(eq(tasks.status, q.status));
    if (q.agentId) conds.push(eq(tasks.agentId, q.agentId));
    if (q.from) conds.push(gte(tasks.createdAt, q.from));
    if (q.to) conds.push(lte(tasks.createdAt, q.to));
    const rows = await this.db.db
      .select({
        t: tasks,
        agentName: agents.name,
        scheduleName: sql<string | null>`${schedules.definition}->>'name'`,
      })
      .from(tasks)
      .leftJoin(agents, eq(agents.id, tasks.agentId))
      .leftJoin(scheduleRuns, eq(scheduleRuns.taskId, tasks.id))
      .leftJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
      .where(and(...conds))
      .orderBy(desc(tasks.createdAt))
      .limit(Math.min(q.limit ?? 50, 200));
    const ids = rows.map((r) => r.t.id);
    const costs = ids.length
      ? await this.db.db
          .select({
            taskId: sql<string>`${events.payload}->>'taskId'`,
            cost: sql<number>`sum(${events.costUsd})::float`,
          })
          .from(events)
          .where(
            and(
              eq(events.workspaceId, workspaceId),
              eq(events.type, "llm.call"),
              inArray(sql`${events.payload}->>'taskId'`, ids),
            ),
          )
          .groupBy(sql`${events.payload}->>'taskId'`)
      : [];
    return rows.map(({ t, agentName, scheduleName }) => ({
      id: t.id,
      agentId: t.agentId,
      agentName,
      goal: firstLine(t.goal),
      status: t.status,
      createdBy: t.createdBy,
      schedule: scheduleName,
      error: t.error,
      summary: (t.report as { summary?: string } | null)?.summary ?? null,
      costUsd: costs.find((c) => c.taskId === t.id)?.cost ?? 0,
      createdAt: t.createdAt.toISOString(),
      finishedAt: t.finishedAt?.toISOString() ?? null,
    }));
  }

  // ---------- incidents ----------

  /** Writes an incident report (markdown) from the event log between two moments. */
  async incident(
    workspaceId: string,
    input: { from: Date; to: Date; title?: string; userId: string | null },
  ) {
    const evs = await this.db.db
      .select({
        id: events.id,
        ts: events.ts,
        type: events.type,
        agentId: events.agentId,
        payload: events.payload,
        cost: events.costUsd,
        agentName: agents.name,
      })
      .from(events)
      .leftJoin(agents, eq(agents.id, events.agentId))
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          gte(events.ts, input.from),
          lte(events.ts, input.to),
        ),
      )
      .orderBy(events.id)
      .limit(5000);
    const is = (t: string, p: (x: Record<string, unknown>) => boolean = () => true) =>
      evs.filter((e) => e.type === t && p(e.payload));
    const failedTasks = is("task.finished", (p) => p.status === "failed" || p.status === "blocked");
    const llmErrors = is("llm.call", (p) => p.ok === false);
    const blocked = [...is("llm.blocked"), ...is("shield.blocked"), ...is("permission.blocked")];
    const alerts = is("security.alert");
    const kills = is("killswitch.engaged");
    const failedRuns = is("schedule.finished", (p) => p.status === "failed");
    const cost = evs.reduce((s, e) => s + Number(e.cost), 0);
    const severity =
      kills.length || alerts.length
        ? "high"
        : failedTasks.length + failedRuns.length + llmErrors.length > 5
          ? "medium"
          : failedTasks.length + failedRuns.length + llmErrors.length > 0
            ? "low"
            : "none";
    const agentsHit = [
      ...new Set(
        [...failedTasks, ...llmErrors, ...blocked].map((e) => e.agentName).filter(Boolean),
      ),
    ];
    const title =
      input.title?.trim() || `Incident ${input.from.toISOString().slice(0, 16).replace("T", " ")}`;
    const line = (e: (typeof evs)[number]) => {
      const p = e.payload;
      const what = String(p.error ?? p.reason ?? p.summary ?? p.message ?? p.status ?? "").slice(
        0,
        140,
      );
      return `- ${e.ts.toISOString().slice(11, 19)} \`${e.type}\`${e.agentName ? ` (${e.agentName})` : ""}${what ? `: ${what}` : ""}`;
    };
    const notable = evs.filter(
      (e) =>
        failedTasks.includes(e) ||
        llmErrors.includes(e) ||
        blocked.includes(e) ||
        alerts.includes(e) ||
        kills.includes(e) ||
        failedRuns.includes(e) ||
        e.type === "killswitch.released",
    );
    const md = [
      `# ${title}`,
      "",
      `- **Window:** ${input.from.toISOString()} → ${input.to.toISOString()}`,
      `- **Severity:** ${severity}`,
      `- **Events reviewed:** ${evs.length}${evs.length === 5000 ? " (first 5000)" : ""}`,
      `- **Agents affected:** ${agentsHit.length ? agentsHit.join(", ") : "none"}`,
      `- **Model spend in window:** $${cost.toFixed(4)}`,
      "",
      "## Summary",
      "",
      `| What | Count |`,
      `| --- | --- |`,
      `| Failed or blocked tasks | ${failedTasks.length} |`,
      `| Failed scheduled runs | ${failedRuns.length} |`,
      `| Model errors | ${llmErrors.length} |`,
      `| Blocked actions (budget, shield, permissions) | ${blocked.length} |`,
      `| Security alerts | ${alerts.length} |`,
      `| Kill switch used | ${kills.length} |`,
      "",
      "## Timeline",
      "",
      ...(notable.length
        ? notable.slice(0, 200).map(line)
        : ["Nothing notable happened in this window."]),
      "",
      "## Follow-up",
      "",
      failedTasks.length || failedRuns.length
        ? "- Review the dead-letter queue and retry or dismiss each failed item."
        : "- No failed work to retry.",
      llmErrors.length ? "- Check model provider keys, quotas and fallbacks in Settings." : "",
      alerts.length ? "- Read the security alerts and rotate any secret involved." : "",
      kills.length ? "- Confirm why the kill switch was used before releasing it again." : "",
      "",
      `_Generated by NorthBot ${VERSION} from the event log._`,
    ]
      .filter((x, i, all) => x !== "" || all[i - 1] !== "")
      .join(nl);
    const [row] = await this.db.db
      .insert(incidents)
      .values({
        workspaceId,
        title,
        severity,
        fromAt: input.from,
        toAt: input.to,
        markdown: md,
        createdBy: input.userId,
      })
      .returning();
    if (!row) throw new Error("incident insert failed");
    await this.events.write(workspaceId, {
      type: "ops.incident",
      payload: { incidentId: row.id, title, severity, userId: input.userId },
    });
    return row;
  }

  async incidents(workspaceId: string) {
    return this.db.db
      .select()
      .from(incidents)
      .where(eq(incidents.workspaceId, workspaceId))
      .orderBy(desc(incidents.createdAt))
      .limit(100);
  }
}
