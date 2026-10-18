import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ScheduleDefinition } from "@northbot/scheduler";
import { ScheduleService } from "../src/schedules/service.js";
import { schedules } from "../src/db/schema.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";
const definition = (extra: object = {}) =>
  ScheduleDefinition.parse({
    name: "Invoice check",
    cronExpr: "*/5 * * * *",
    taskPrompt: "Summarize invoices",
    retries: 0,
    ...extra,
  });
const models = (extra: object = {}) => ({
  providers: [
    {
      name: "fake",
      type: "fake",
      kind: "local",
      models: ["m"],
      fake: {
        reply: "Done.",
        match: [
          { contains: "You plan work", text: '{"steps":["summarize"]}' },
          { contains: "You check an agent", text: '{"summary":"ok","claims":[]}' },
        ],
        ...extra,
      },
    },
  ],
  aliases: { "northbot-fast": ["fake/m"], "northbot-smart": ["fake/m"] },
  redactPii: false,
  pricing: {},
  dailyBudgetUsd: null,
});
describe("M9 schedules", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ TASK_CONFIRM_ABOVE_USD: "1000" });
  });
  afterAll(async () => {
    await t.services.tasks.idle();
    await t.close();
  });
  async function setup(model = models()) {
    const auth = await signup(t.app);
    await t.app.inject({
      method: "PUT",
      url: "/settings/llm",
      headers: { cookie: auth.cookie },
      payload: model,
    });
    const created = await t.app.inject({
      method: "POST",
      url: "/agents",
      headers: { cookie: auth.cookie },
      payload: { name: "Pia", autonomyLevel: "act_within_limits" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().id as string;
    let now = new Date("2026-10-18T12:00:00Z");
    const service = new ScheduleService(t.services, () => now);
    const create = (extra = {}) =>
      service.create(auth.me.workspaceId, auth.me.userId, {
        agentId,
        roomId: null,
        definition: definition(extra),
      });
    return {
      ...auth,
      agentId,
      service,
      create,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
      now: () => now,
    };
  }
  it("locks occurrences across two workers so the same task executes once", async () => {
    const a = await setup();
    const row = await a.create();
    a.advance(300_000);
    const second = new ScheduleService(t.services, a.now);
    await Promise.all([a.service.tick(), second.tick()]);
    const runs = await a.service.history(a.me.workspaceId, row.id);
    expect(runs).toHaveLength(1);
    await Promise.all([a.service.execute(runs[0]!.id), second.execute(runs[0]!.id)]);
    expect((await a.service.history(a.me.workspaceId, row.id))[0]?.status).toBe("done");
    expect(
      (
        await t.db.pool.query("select id from tasks where idempotency_key=$1", [
          runs[0]!.idempotencyKey,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("wakes a hibernating computer and skips overlapping triggers", async () => {
    const a = await setup(models({ latencyMs: 150 }));
    const row = await a.create();
    await t.services.computers.hibernate(
      { workspaceId: a.me.workspaceId, agentId: a.agentId },
      "test",
    );
    const first = (await a.service.runNow(a.me.workspaceId, row.id)) as { id: string };
    const running = a.service.execute(first.id);
    await new Promise((r) => setTimeout(r, 100));
    const second = (await a.service.runNow(a.me.workspaceId, row.id)) as { id: string };
    await a.service.execute(second.id);
    await running;
    expect((await a.service.history(a.me.workspaceId, row.id)).map((r) => r.status).sort()).toEqual(
      ["done", "skipped_overlap"],
    );
    expect(
      (
        await t.db.pool.query(
          "select id from events where workspace_id=$1 and agent_id=$2 and type='sandbox.woken'",
          [a.me.workspaceId, a.agentId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("requires approval for first write run and invalidates it on edits", async () => {
    const a = await setup();
    const row = await a.create({ actionKind: "write", taskPrompt: "Write an invoice summary" });
    const run = (await a.service.runNow(a.me.workspaceId, row.id)) as { id: string };
    await a.service.execute(run.id);
    let stored = await a.service.get(a.me.workspaceId, row.id);
    expect(stored?.approvalId).toBeTruthy();
    expect((await a.service.history(a.me.workspaceId, row.id))[0]?.taskId).toBeNull();
    await t.services.approvals.decide(
      a.me.workspaceId,
      stored!.approvalId!,
      "approve_once",
      a.me.userId,
    );
    a.advance(6000);
    await a.service.execute(run.id);
    expect((await a.service.history(a.me.workspaceId, row.id))[0]?.status).toBe("done");
    stored = await a.service.edit(a.me.workspaceId, row.id, a.me.userId, {
      taskPrompt: "Write a different summary",
    });
    expect(stored?.approvedHash).toBeNull();
  });
  it("fails over-budget work and pauses after three failures with one alert", async () => {
    const a = await setup(models({ costPerCallUsd: 0.05 }));
    const row = await a.create({ budgetUsdPerRun: 0.01, budgetUsdPerDay: 1 });
    for (let i = 0; i < 3; i++) {
      a.advance(1000);
      const run = (await a.service.runNow(a.me.workspaceId, row.id)) as { id: string };
      await a.service.execute(run.id);
    }
    const stored = await a.service.get(a.me.workspaceId, row.id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.consecutiveFailures).toBe(3);
    expect(
      (
        await t.db.pool.query(
          "select id from notifications where workspace_id=$1 and kind='schedule'",
          [a.me.workspaceId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await t.db.pool.query(
          "select id from events where workspace_id=$1 and type='agent.mood' and payload->>'mood'='worried'",
          [a.me.workspaceId],
        )
      ).rowCount,
    ).toBeGreaterThan(0);
  });
  it("reserves a daily cap across overlapping runs and times out stuck work", async () => {
    const a = await setup(models({ costPerCallUsd: 0.04, latencyMs: 100 }));
    const row = await a.create({ overlapPolicy: "allow", budgetUsdPerRun: 0.2, budgetUsdPerDay: 0.04 });
    const first = await a.service.runNow(a.me.workspaceId, row.id) as { id: string };
    const second = await a.service.runNow(a.me.workspaceId, row.id) as { id: string };
    await Promise.all([a.service.execute(first.id), a.service.execute(second.id)]);
    expect((await a.service.history(a.me.workspaceId, row.id)).map((r) => r.status).sort()).toEqual(["failed", "skipped_no_budget"]);
    const spent = await t.db.pool.query<{ total: string }>("select coalesce(sum(cost_usd),0) total from events where workspace_id=$1 and type='llm.call'", [a.me.workspaceId]);
    expect(Number(spent.rows[0]!.total)).toBe(0.04);
    const b = await setup(models({ latencyMs: 1500 })); const timed = await b.create({ maxRuntimeS: 1 });
    const run = await b.service.runNow(b.me.workspaceId, timed.id) as { id: string };
    await b.service.execute(run.id);
    expect((await b.service.history(b.me.workspaceId, timed.id))[0]?.error).toBe("Maximum run time exceeded.");
  });
  it("honours the kill switch and protects the six visible system schedules", async () => {
    const a = await setup();
    const row = await a.create();
    const system = (await a.service.list(a.me.workspaceId)).filter((r) => r.systemKey);
    expect(system).toHaveLength(6);
    await expect(a.service.remove(a.me.workspaceId, system[0]!.id)).rejects.toThrow(
      "cannot be deleted",
    );
    await t.services.tasks.engageKillSwitch(a.me.workspaceId, a.me.userId);
    await expect(a.service.runNow(a.me.workspaceId, row.id)).rejects.toThrow("kill switch");
    a.advance(300_000);
    await a.service.tick();
    expect(await a.service.history(a.me.workspaceId, row.id)).toHaveLength(0);
  });
  it("scopes targets to a workspace and round-trips the YAML and preview APIs", async () => {
    const a = await setup(),
      b = await setup();
    await expect(
      a.service.create(a.me.workspaceId, a.me.userId, {
        agentId: b.agentId,
        roomId: null,
        definition: definition(),
      }),
    ).rejects.toThrow("No such agent");
    const preview = await t.app.inject({
      method: "POST",
      url: "/schedules/preview",
      headers: { cookie: a.cookie },
      payload: { definition: definition(), phrase: "every weekday at 9am" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().definition.cronExpr).toBe("0 9 * * 1-5");
    expect(preview.json().nextRuns).toHaveLength(5);
    const row = await a.create();
    const exported = await t.app.inject({
      method: "GET",
      url: "/schedules/export",
      headers: { cookie: a.cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("Invoice check");
    await t.db.db.delete(schedules).where(eq(schedules.id, row.id));
    const imported = await t.app.inject({
      method: "POST",
      url: "/schedules/import",
      headers: { cookie: a.cookie },
      payload: { yaml: exported.body },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().count).toBe(1);
  });
});
import { ScheduleQueue } from "../src/schedules/queue.js";

it("delivers persisted pg-boss jobs once through the real Postgres queue", async () => {
  const t = await startTestApp();
  const queue = new ScheduleQueue(t.config.DATABASE_URL, "scheduler_delivery_test");
  const handled: string[] = [];
  try {
    await queue.start(
      async (id) => {
        handled.push(id);
      },
      (error) => {
        throw error;
      },
    );
    const id = "d6348818-0cb0-494f-b0ba-8c66277bbb43";
    await Promise.all([queue.send(id), queue.send(id)]);
    await expect.poll(() => handled.length, { timeout: 8000 }).toBe(1);
    expect(handled).toEqual([id]);
  } finally {
    await queue.stop();
    await t.db.pool.query("DROP SCHEMA scheduler_delivery_test CASCADE");
    await t.close();
  }
});
