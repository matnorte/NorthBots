import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, startTestApp, type TestApp } from "./helpers.js";

type APIError = InstanceType<typeof OpenAI.APIError>;
async function failure(p: Promise<unknown>): Promise<APIError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OpenAI.APIError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

const fakeSettings = (over: { aDown?: boolean; dailyBudgetUsd?: number | null } = {}) => ({
  providers: [
    { name: "fake-a", type: "fake", kind: "cloud", models: ["m"], fake: { down: over.aDown ?? false, reply: "hello from A", costPerCallUsd: 0.012 } },
    { name: "fake-b", type: "fake", kind: "local", models: ["m"], fake: { reply: "hello from B" } },
  ],
  aliases: { "northbot-fast": ["fake-a/m", "fake-b/m"], "cloud-only": ["fake-a/m"] },
  redactPii: true,
  pricing: {},
  dailyBudgetUsd: over.dailyBudgetUsd ?? null,
});

describe("LLM router endpoint (/v1)", () => {
  let t: TestApp;
  let baseURL: string;

  beforeAll(async () => {
    t = await startTestApp();
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    baseURL = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => t.close());

  async function workspace(settings: object = fakeSettings(), keyBody: object = { name: "test" }) {
    const s = await signup(t.app);
    const put = await t.app.inject({ method: "PUT", url: "/settings/llm", headers: { cookie: s.cookie }, payload: settings });
    expect(put.statusCode).toBe(200);
    const k = await t.app.inject({ method: "POST", url: "/settings/api-keys", headers: { cookie: s.cookie }, payload: keyBody });
    expect(k.statusCode).toBe(201);
    const key = k.json().key as string;
    return { ...s, key, keyId: k.json().id as string, client: new OpenAI({ apiKey: key, baseURL, maxRetries: 0 }) };
  }

  const llmEvents = async (cookie: string) =>
    ((await t.app.inject({ method: "GET", url: "/events?limit=1000", headers: { cookie } })).json().events as {
      type: string;
      costUsd: number;
      payload: Record<string, unknown>;
      agentId: string | null;
    }[]).filter((e) => e.type === "llm.call");

  it("serves chat completions to the official openai client and logs cost", async () => {
    const w = await workspace();
    const r = await w.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "hi" }] });
    expect(r.choices[0]?.message.content).toBe("hello from A");
    expect(r.usage?.total_tokens).toBeGreaterThan(0);
    const ev = await llmEvents(w.cookie);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ costUsd: 0.012, payload: { provider: "fake-a", ok: true, apiKeyId: w.keyId } });
  });

  it("streams with the openai client", async () => {
    const w = await workspace();
    const stream = await w.client.chat.completions.create({
      model: "northbot-fast",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage = 0;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      usage = chunk.usage?.total_tokens ?? usage;
    }
    expect(text).toBe("hello from A");
    expect(usage).toBeGreaterThan(0);
  });

  it("lists models and answers /v1/responses", async () => {
    const w = await workspace();
    const models = await w.client.models.list();
    expect(models.data.map((m) => m.id)).toEqual(expect.arrayContaining(["northbot-fast", "fake-a/m", "fake-b/m"]));
    const resp = await w.client.responses.create({ model: "fake-b/m", input: "hey" });
    expect(resp.output_text).toBe("hello from B");
  });

  it("falls back from a killed provider A to B", async () => {
    const w = await workspace(fakeSettings({ aDown: true }));
    const r = await w.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "hi" }] });
    expect(r.choices[0]?.message.content).toBe("hello from B");
    const ev = await llmEvents(w.cookie);
    expect(ev.map((e) => [e.payload.provider, e.payload.ok])).toEqual([
      ["fake-a", false],
      ["fake-b", true],
    ]);
  });

  it("stops the second call at a $0.01 workspace daily cap with a clear error", async () => {
    const w = await workspace(fakeSettings({ dailyBudgetUsd: 0.01 }));
    await w.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "1" }] });
    const err = await failure(w.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "2" }] }));
    expect(err.status).toBe(402);
    expect(err.message).toMatch(/Budget cap reached for this workspace today: limit \$0\.0100/);
  });

  it("enforces API key, agent and task caps", async () => {
    const k = await workspace(fakeSettings(), { name: "capped", dailyBudgetUsd: 0.01 });
    await k.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "1" }] });
    await expect(k.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "2" }] })).rejects.toThrow(
      /this API key today/,
    );

    const a = await workspace();
    const agent = await t.db.pool.query(
      "insert into agents (workspace_id, name, budget_daily_usd) values ($1, 'Pip', 0.01) returning id",
      [a.me.workspaceId],
    );
    const agentId = agent.rows[0].id as string;
    const asAgent = { headers: { "x-northbot-agent-id": agentId } };
    await a.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "1" }] }, asAgent);
    await expect(
      a.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "2" }] }, asAgent),
    ).rejects.toThrow(/agent Pip today/);
    expect((await llmEvents(a.cookie))[0]?.agentId).toBe(agentId);

    const task = { headers: { "x-northbot-task-id": "task-1", "x-northbot-task-budget-usd": "0.01" } };
    await a.client.chat.completions.create({ model: "fake-b/m", messages: [{ role: "user", content: "1" }] }, task);
    // fake-b is free, so the task cap is never reached; switch to the paid provider.
    await a.client.chat.completions.create({ model: "fake-a/m", messages: [{ role: "user", content: "1" }] }, task);
    await expect(a.client.chat.completions.create({ model: "fake-b/m", messages: [{ role: "user", content: "3" }] }, task)).rejects.toThrow(
      /task task-1/,
    );
  });

  it("refuses sensitive calls on cloud providers and routes them to local ones", async () => {
    const w = await workspace();
    const sensitive = { headers: { "x-northbot-privacy": "sensitive" } };
    const r = await w.client.chat.completions.create({ model: "northbot-fast", messages: [{ role: "user", content: "x" }] }, sensitive);
    expect(r.choices[0]?.message.content).toBe("hello from B");
    const err = await failure(w.client.chat.completions.create({ model: "cloud-only", messages: [{ role: "user", content: "x" }] }, sensitive));
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/sensitive/);
  });

  it("rejects missing and revoked keys", async () => {
    const w = await workspace();
    const bad = new OpenAI({ apiKey: "nb_not-a-real-key-123456789", baseURL, maxRetries: 0 });
    await expect(bad.models.list()).rejects.toMatchObject({ status: 401 });
    await t.app.inject({ method: "DELETE", url: `/settings/api-keys/${w.keyId}`, headers: { cookie: w.cookie } });
    await expect(w.client.models.list()).rejects.toMatchObject({ status: 401 });
    const list = await t.app.inject({ method: "GET", url: "/settings/api-keys", headers: { cookie: w.cookie } });
    expect(list.body).not.toContain(w.key);
  });

  it("uses the provider key from the vault without leaking it, and redacts PII for cloud", async () => {
    const seen: { auth?: string; body: string }[] = [];
    const mock = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 1,
            model: "up",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok [EMAIL_1]" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
    const VALUE = "sk-upstream-canary-91c2e7f0";
    try {
      const w = await workspace({
        providers: [{ name: "up", type: "openai-compatible", kind: "cloud", baseUrl: url, keySecret: "UP_KEY", models: ["up"] }],
        aliases: {},
        dailyBudgetUsd: null,
      });
      await t.app.inject({ method: "PUT", url: "/vault/secrets", headers: { cookie: w.cookie }, payload: { name: "UP_KEY", value: VALUE } });
      const r = await w.client.chat.completions.create({ model: "up/up", messages: [{ role: "user", content: "mail ana@x.com" }] });
      expect(seen[0]?.auth).toBe(`Bearer ${VALUE}`);
      expect(seen[0]?.body).not.toContain("ana@x.com");
      expect(r.choices[0]?.message.content).toBe("ok ana@x.com");
      const all = await t.app.inject({ method: "GET", url: "/events?limit=1000", headers: { cookie: w.cookie } });
      expect(all.body).not.toContain(VALUE);
      expect(all.body).toContain('"redactions":1');
    } finally {
      await new Promise<void>((r) => mock.close(() => r()));
    }
  });
});
