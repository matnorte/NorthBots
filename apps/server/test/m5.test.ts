import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverAfterQuietHours, MoodService } from "../src/moods/service.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";

const NAMES = { candidates: [{ name: "Biscuit", reason: "warm" }, { name: "Claude", reason: "nope" }, { name: "Nimbus", reason: "cloudy" }, { name: "Pip", reason: "small" }] };
const VERDICT = { summary: "ok", claims: [{ text: "said hello", status: "verified", evidence: "uname" }] };

function settings(workerScript: object[]) {
  return {
    providers: [
      {
        name: "fast",
        type: "fake",
        kind: "local",
        models: ["m"],
        fake: {
          reply: "{}",
          match: [
            { contains: "choosing your own name", text: JSON.stringify(NAMES) },
            { contains: "You plan work", text: JSON.stringify({ steps: ["look around", "say hello"] }) },
            { contains: "You check an agent", text: JSON.stringify(VERDICT) },
            { contains: "Convert a plain-language permission rule", text: JSON.stringify({ effect: "block", targets: ["shop.test"] }) },
          ],
        },
      },
      { name: "smart", type: "fake", kind: "local", models: ["m"], fake: { script: workerScript, match: [{ contains: "chatting with the person", text: "Hi there! Happy to help." }] } },
    ],
    aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
    redactPii: false,
    pricing: {},
    dailyBudgetUsd: null,
  };
}
const HELLO = [{ toolCalls: [{ name: "terminal", arguments: { command: "uname -a" } }] }, { text: "draft" }, { text: "Hi! I'm Biscuit." }];

describe("M5: hatching, names, chat, moods", () => {
  let t: TestApp;
  let base: string;
  beforeAll(async () => {
    t = await startTestApp({ TASK_CONFIRM_ABOVE_USD: "1000" });
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await t.services.tasks.idle();
    await t.close();
  });

  async function ws(script: object[] = HELLO) {
    const s = await signup(t.app);
    const inject = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: { cookie: s.cookie }, ...(payload ? { payload } : {}) });
    expect((await inject("PUT", "/settings/llm", settings(script))).statusCode).toBe(200);
    const waitTask = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const tk = (await inject("GET", `/tasks/${id}`)).json();
        if (["done", "failed", "blocked", "killed"].includes(tk.status)) return tk;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("task did not finish");
    };
    const evs = async () => (await inject("GET", "/events?limit=1000")).json().events as { type: string; agentId: string | null; payload: Record<string, unknown> }[];
    return { ...s, inject, waitTask, evs };
  }

  const hatchBody = { goal: "Help run my small online shop", personality: { tone: "warm", pace: "careful", checkins: "often" }, avatar: { base: "cat", color: "mint", accessory: "scarf" } };

  it("the agent suggests only valid names (the blocked one is filtered out)", async () => {
    const w = await ws();
    const res = await w.inject("POST", "/hatch/names", hatchBody);
    expect(res.json().candidates.map((c: { name: string }) => c.name)).toEqual(["Biscuit", "Nimbus", "Pip"]);
  });

  it("hatches a self-named agent that completes its first task", async () => {
    const w = await ws();
    const res = await w.inject("POST", "/hatch", { ...hatchBody, name: "Biscuit", nameChosenBy: "agent" });
    expect(res.statusCode).toBe(201);
    const { agent, firstTaskId } = res.json();
    expect(agent).toMatchObject({ name: "Biscuit", nameLocked: false, autonomyLevel: "ask_first", avatar: hatchBody.avatar });
    expect(agent.persona.summary).toMatch(/warm and kind/);
    const task = await w.waitTask(firstTaskId);
    expect(task.status).toBe("done");
    expect(task.report.finalText).toBe("Hi! I'm Biscuit.");
    expect((await w.evs()).map((e) => e.type)).toEqual(expect.arrayContaining(["agent.hatched", "task.finished"]));
  });

  it("rejects a duplicate name and locks a name the human gives", async () => {
    const w = await ws();
    const first = (await w.inject("POST", "/hatch", { ...hatchBody, name: "Nimbus", nameChosenBy: "agent" })).json().agent;
    const dup = await w.inject("POST", "/hatch", { ...hatchBody, name: "nimbus", nameChosenBy: "human" });
    expect(dup.statusCode).toBe(409);
    const blocked = await w.inject("POST", "/hatch", { ...hatchBody, name: "Pikachu", nameChosenBy: "human" });
    expect(blocked.statusCode).toBe(422);
    const renamed = await w.inject("PATCH", `/agents/${first.id}`, { name: "Juniper" });
    expect(renamed.json()).toMatchObject({ name: "Juniper", nameLocked: true });
    expect((await w.evs()).some((e) => e.type === "agent.renamed")).toBe(true);
    // The agent no longer suggests names for itself once a human has named it, and quick-create names are locked too.
    const quick = await w.inject("POST", "/agents", { name: "Plum" });
    expect(quick.json().nameLocked).toBe(true);
  });

  it("streams a chat reply and turns 'do it' messages into tasks reported back in the thread", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/hatch", { ...hatchBody, name: "Pip", nameChosenBy: "agent" })).json().agent;
    await w.waitTask((await w.inject("GET", `/agents/${agent.id}/tasks`)).json().tasks[0].id);
    const thread = (await w.inject("POST", `/agents/${agent.id}/threads`, { title: "Hello" })).json();

    const sse = await fetch(`${base}/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { cookie: w.cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "Hi Pip!", mode: "ask" }),
    });
    const text = await sse.text();
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    const msgs = (await w.inject("GET", `/threads/${thread.id}/messages`)).json().messages;
    expect(msgs.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ["user", "Hi Pip!"],
      ["agent", "Hi there! Happy to help."],
    ]);

    // "Do it" with an attachment: the file lands in ~/inbox and the report comes back to the thread.
    const form = new FormData();
    form.append("file", new Blob(["sku,qty\nmug,3\n"], { type: "text/csv" }), "stock.csv");
    const up = await fetch(`${base}/files`, { method: "POST", headers: { cookie: w.cookie }, body: form });
    expect(up.status).toBe(201);
    const file = (await up.json()) as { id: string };
    const doIt = await w.inject("POST", `/threads/${thread.id}/messages`, { content: "Count the mugs", mode: "do", attachmentIds: [file.id] });
    expect(doIt.statusCode).toBe(201);
    const task = await w.waitTask(doIt.json().taskId);
    expect(task.goal).toContain("~/inbox: stock.csv");
    expect((await t.sandbox.exec(agent.sandboxId, "cat inbox/stock.csv")).stdout).toBe("sku,qty\nmug,3\n");
    for (let i = 0; i < 40; i++) {
      const all = (await w.inject("GET", `/threads/${thread.id}/messages`)).json().messages;
      if (all.length === 4) {
        expect(all[3]).toMatchObject({ role: "agent", taskId: task.id });
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await w.evs()).filter((e) => e.type === "chat.message").length).toBeGreaterThanOrEqual(4);
  });

  it("computes moods from events and notifies, holding notifications during quiet hours", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Moody" })).json();
    // An approval that has been waiting for 11 minutes.
    const req = await t.services.events.write(w.me.workspaceId, {
      type: "approval.requested",
      agentId: agent.id,
      payload: { approvalId: "00000000-0000-4000-8000-000000000001", taskId: null, kind: "write", summary: "x", reason: "y" },
    });
    await t.db.pool.query("update events set ts = now() - interval '11 minutes' where id = $1", [req.id]);
    const later = new MoodService(t.db, t.services.events);
    await w.inject("PATCH", "/settings", { quietHours: null });
    const mood = await later.refresh(w.me.workspaceId, agent.id);
    expect(mood).toMatchObject({ mood: "impatient", fix: "open_approvals" });
    expect((await w.inject("GET", `/agents/${agent.id}/mood`)).json().mood).toBe("impatient");
    // Either this refresh or the server's background one records the change; wait for its notification.
    let notes: { body: string }[] = [];
    for (let i = 0; i < 80 && notes.length === 0; i++) {
      notes = (await w.inject("GET", "/notifications")).json().notifications;
      if (notes.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(notes[0]?.body).toMatch(/^Moody: I've been waiting 1[01] minutes/);

    // Moods can be switched off per agent.
    await w.inject("PATCH", `/agents/${agent.id}`, { moodsEnabled: false });
    expect((await later.refresh(w.me.workspaceId, agent.id))?.mood).toBe("content");
  });

  it("holds a notification raised in quiet hours until they end", () => {
    const at = new Date("2026-10-18T02:30:00Z"); // 23:30 in Sao Paulo
    const when = deliverAfterQuietHours(at, "America/Sao_Paulo", { start: "22:00", end: "08:00" });
    expect(when.toISOString()).toBe("2026-10-18T11:00:00.000Z"); // 08:00 local
    expect(deliverAfterQuietHours(new Date("2026-10-18T15:00:00Z"), "America/Sao_Paulo", { start: "22:00", end: "08:00" }).toISOString()).toBe(
      "2026-10-18T15:00:00.000Z",
    );
  });

  it("makes an agent confused by contradicting rules and embarrassed by a correction", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Kit" })).json();
    await w.inject("POST", "/rules", { text: "allow everything on shop.test", rule: { effect: "allow", targets: ["shop.test"] } });
    await w.inject("POST", "/rules", { text: "never touch shop.test" });
    expect((await w.evs()).some((e) => e.type === "instruction.contradiction" && e.agentId === agent.id)).toBe(true);
    expect((await t.services.moods.refresh(w.me.workspaceId, agent.id))?.mood).toBe("confused");
  });
});
