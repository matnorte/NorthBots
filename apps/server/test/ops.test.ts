import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { tasks } from "../src/db/schema.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";

const sh = (command: string) => ({ toolCalls: [{ name: "terminal", arguments: { command } }] });

describe("M12: operations", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({
      TASK_CONFIRM_ABOVE_USD: "1000",
      BIN_PICKER_INTERVAL_HOURS: "0",
      CANARY_INTERVAL_MINUTES: "0",
    });
  });
  afterAll(async () => {
    await t.services.tasks.idle();
    await t.close();
  });

  async function ws() {
    const s = await signup(t.app);
    const inject = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: { cookie: s.cookie }, ...(payload ? { payload } : {}) });
    await inject("PUT", "/settings/llm", {
      providers: [
        {
          name: "fast",
          type: "fake",
          kind: "local",
          models: ["m"],
          fake: {
            reply: "{}",
            match: [
              { contains: "You plan work", text: '{"steps":["try"]}' },
              { contains: "You check an agent", text: '{"summary":"ok","claims":[]}' },
            ],
          },
        },
        // Three failing commands in a row: the task escalates and fails.
        {
          name: "smart",
          type: "fake",
          kind: "local",
          models: ["m"],
          fake: {
            script: [sh("cat missing-1"), sh("cat missing-2"), sh("cat missing-3"), { text: "x" }],
          },
        },
      ],
      aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
      redactPii: false,
      pricing: {},
      dailyBudgetUsd: null,
    });
    return { ...s, inject };
  }

  it("runs the canary checks, including a canary task through the agent loop, and reports on the status page", async () => {
    const run = await t.app.inject({
      method: "POST",
      url: "/ops/canary",
      headers: { cookie: (await signup(t.app)).cookie },
    });
    const body = run.json() as {
      ok: boolean;
      checks: { name: string; ok: boolean; error?: string }[];
    };
    expect(body.checks.map((c) => c.name)).toEqual([
      "database",
      "vault_crypto",
      "scheduler",
      "stuck_tasks",
      "agent_runtime",
    ]);
    expect(body.checks.find((c) => c.name === "agent_runtime")).toMatchObject({ ok: true });
    const status = (await t.app.inject({ method: "GET", url: "/status.json" })).json();
    expect(status).toMatchObject({
      checks: expect.arrayContaining([{ name: "agent_runtime", ok: true }]),
    });
    expect(["operational", "degraded"]).toContain(status.status);
    const page = await t.app.inject({ method: "GET", url: "/status" });
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("NorthBot status");
    // No workspace data on the public page.
    expect(page.body).not.toContain("@example.test");
  });

  it("puts failed work in the dead-letter queue, retries it, searches runs and writes an incident report", async () => {
    const w = await ws();
    const agent = (
      await w.inject("POST", "/agents", { name: "Fumble", autonomyLevel: "act_within_limits" })
    ).json();
    const taskId = (
      await w.inject("POST", `/agents/${agent.id}/tasks`, {
        goal: "Read the missing invoices file",
      })
    ).json().id;
    await t.services.tasks.idle();
    expect((await w.inject("GET", `/tasks/${taskId}`)).json().status).toMatch(/failed|blocked/);

    const [dead] = (await w.inject("GET", "/ops/dead-letters")).json().deadLetters;
    expect(dead).toMatchObject({
      kind: "task",
      refId: taskId,
      agentId: agent.id,
      summary: "Read the missing invoices file",
      status: "open",
    });

    const retried = (await w.inject("POST", `/ops/dead-letters/${dead.id}/retry`)).json();
    expect(retried.retriedAs).not.toBe(taskId);
    await t.services.tasks.idle();
    expect(
      (await w.inject("GET", "/ops/dead-letters?status=retried")).json().deadLetters[0],
    ).toMatchObject({ id: dead.id, retriedAs: retried.retriedAs });
    // The retry failed too: it is a new dead letter, which can be dismissed.
    const [second] = (await w.inject("GET", "/ops/dead-letters")).json().deadLetters;
    expect(second.refId).toBe(retried.retriedAs);
    expect((await w.inject("POST", `/ops/dead-letters/${second.id}/dismiss`)).json()).toEqual({
      ok: true,
    });
    expect((await w.inject("GET", "/ops/dead-letters")).json().deadLetters).toEqual([]);

    const found = (await w.inject("GET", "/ops/runs?q=invoices")).json().runs;
    expect(found.map((r: { id: string }) => r.id).sort()).toEqual(
      [taskId, retried.retriedAs].sort(),
    );
    expect(found[0]).toMatchObject({ agentName: "Fumble", goal: "Read the missing invoices file" });
    expect((await w.inject("GET", "/ops/runs?q=nothing-like-this")).json().runs).toEqual([]);

    const health = (await w.inject("GET", "/ops/health")).json();
    expect((health.tasks24h.failed ?? 0) + (health.tasks24h.blocked ?? 0)).toBeGreaterThanOrEqual(
      2,
    );
    expect(health.failureRate).toBe(1);

    const incident = await w.inject("POST", "/ops/incidents", { title: "Invoices outage" });
    expect(incident.statusCode).toBe(201);
    const md = incident.json().markdown as string;
    expect(md).toContain("# Invoices outage");
    expect(md).toMatch(/Failed or blocked tasks \| 2 \|/);
    expect(md).toContain("(Fumble)");
    expect(incident.json().severity).toBe("low");
    const file = await w.inject("GET", `/ops/incidents/${incident.json().id}.md`);
    expect(file.body).toBe(md);
  });

  it("serializes retries and dismissals, preserves budget and taint, and scopes references", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "RetryGuard" })).json();
    const original = await t.services.tasks.create({
      workspaceId: w.me.workspaceId,
      agentId: agent.id,
      goal: "Read missing invoices",
      by: "agent",
      userId: null,
      budgetUsd: 0.37,
      tainted: true,
    });
    await t.services.tasks.idle();
    const [dead] = await t.services.ops.deadLetters(w.me.workspaceId);
    expect(dead?.refId).toBe(original.task.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const create = t.services.tasks.create.bind(t.services.tasks);
    const spy = vi.spyOn(t.services.tasks, "create").mockImplementation(async (input) => {
      entered = true;
      await gate;
      return create(input);
    });
    try {
      const first = w.inject("POST", `/ops/dead-letters/${dead!.id}/retry`);
      for (let i = 0; i < 100 && !entered; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(entered).toBe(true);
      expect((await w.inject("POST", `/ops/dead-letters/${dead!.id}/retry`)).statusCode).toBe(404);
      expect((await w.inject("POST", `/ops/dead-letters/${dead!.id}/dismiss`)).json()).toEqual({
        ok: false,
      });
      const other = await signup(t.app);
      expect(
        await t.services.ops.retry(other.me.workspaceId, dead!.id, other.me.userId),
      ).toBeNull();
      release();
      const response = await first;
      expect(response.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({
        budgetUsd: 0.37,
        tainted: true,
        idempotencyKey: `ops-retry:${w.me.workspaceId}:${dead!.id}`,
      });
      await t.services.tasks.idle();
      const [retry] = await t.db.db
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.id, response.json().retriedAs), eq(tasks.workspaceId, w.me.workspaceId)),
        );
      expect(retry?.budgetUsd).toBe(original.task.budgetUsd);
      expect(retry?.state?.tainted).toBe(true);
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
