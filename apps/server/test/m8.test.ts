import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reduceOffice, type StoredEvent } from "@northbot/shared";
import { signup, startTestApp, type TestApp } from "./helpers.js";

const sh = (command: string) => ({ toolCalls: [{ name: "terminal", arguments: { command } }] });

function settings() {
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
            { contains: "You plan work", text: JSON.stringify({ steps: ["wait", "write"] }) },
            { contains: "You check an agent", text: JSON.stringify({ summary: "ok", claims: [{ text: "done", status: "verified", evidence: "exit 0" }] }) },
          ],
        },
      },
      { name: "smart", type: "fake", kind: "local", models: ["m"], fake: { script: [sh("sleep 1"), sh("echo after > after.txt"), { text: "draft" }, { text: "done" }] } },
    ],
    aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
    redactPii: false,
    pricing: {},
    dailyBudgetUsd: null,
  };
}

describe("M8: office interactions", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ TASK_CONFIRM_ABOVE_USD: "1000", BIN_PICKER_INTERVAL_HOURS: "0" });
  });
  afterAll(async () => {
    await t.services.tasks.idle();
    await t.close();
  });

  async function ws() {
    const s = await signup(t.app);
    const inject = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: { cookie: s.cookie }, ...(payload ? { payload } : {}) });
    await inject("PUT", "/settings/llm", settings());
    const evs = async () => (await inject("GET", "/events?limit=1000")).json().events as StoredEvent[];
    return { ...s, inject, evs };
  }
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("logs each agent's look so the office can draw it from events alone", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Ana", avatar: { shape: "star", color: "sunflower" } })).json();
    await w.inject("PATCH", `/agents/${agent.id}`, { avatar: { shape: "diamond", color: "pink" } });
    const office = reduceOffice(await w.evs());
    expect(office.agents[agent.id]).toMatchObject({ name: "Ana", avatar: { shape: "diamond", color: "pink" }, zone: "desk" });
  });

  it("lifting a busy agent pauses its task at the next safe point until it is dropped", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Busy", autonomyLevel: "act_within_limits" })).json();
    const taskId = (await w.inject("POST", `/agents/${agent.id}/tasks`, { goal: "Wait, then write a file" })).json().id;
    const steps = async () => (await w.evs()).filter((e) => e.type === "task.step" && e.payload.taskId === taskId).length;
    await until(async () => (await steps()) === 1);

    const lift = (await w.inject("POST", `/agents/${agent.id}/lift`)).json();
    expect(lift).toEqual({ ok: true, pausedTaskId: taskId });
    await new Promise((r) => setTimeout(r, 1800));
    // The next action may be proposed, but it does not run while the agent is held.
    const ran = async () => (await w.evs()).filter((e) => e.type === "terminal.exec" && e.agentId === agent.id).length;
    expect(await ran()).toBe(1);
    expect(await steps()).toBeLessThanOrEqual(2);
    expect((await w.inject("GET", `/tasks/${taskId}`)).json().status).toBe("running");
    expect((await t.sandbox.exec(agent.sandboxId, "cat after.txt")).exitCode).not.toBe(0);
    const evs = await w.evs();
    expect(evs.some((e) => e.type === "agent.interrupted" && e.payload.how === "picked_up")).toBe(true);
    await until(async () => (await w.inject("GET", `/agents/${agent.id}/mood`)).json().mood === "annoyed");
    expect(reduceOffice(await w.evs()).agents[agent.id]).toMatchObject({ held: true, mood: "annoyed" });

    expect((await w.inject("POST", `/agents/${agent.id}/drop`, { zone: "desk" })).json()).toEqual({ ok: true, rested: false });
    await t.services.tasks.idle();
    expect((await w.inject("GET", `/tasks/${taskId}`)).json().status).toBe("done");
    expect((await t.sandbox.exec(agent.sandboxId, "cat after.txt")).stdout).toBe("after\n");
    expect(reduceOffice(await w.evs()).agents[agent.id]).toMatchObject({ held: false });
  });

  it("break room rests an idle agent; shaking wakes it; a cookie says good job on the last task", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Napper", autonomyLevel: "act_within_limits" })).json();
    await w.inject("POST", `/agents/${agent.id}/lift`);
    expect((await w.inject("POST", `/agents/${agent.id}/drop`, { zone: "break_room" })).json()).toEqual({ ok: true, rested: true });
    let office = reduceOffice(await w.evs());
    expect(office.agents[agent.id]).toMatchObject({ zone: "break_room", hibernated: true, rest: { why: "Sent to the break room" } });

    expect((await w.inject("POST", `/agents/${agent.id}/shake`)).json()).toEqual({ ok: true, woke: true });
    office = reduceOffice(await w.evs());
    expect(office.agents[agent.id]).toMatchObject({ zone: "desk", hibernated: false, reaction: { kind: "dizzy" } });

    const taskId = (await w.inject("POST", `/agents/${agent.id}/tasks`, { goal: "Wait, then write a file" })).json().id;
    await t.services.tasks.idle();
    expect((await w.inject("POST", `/agents/${agent.id}/cookie`)).json()).toEqual({ ok: true, taskId });
    const evs = await w.evs();
    expect(evs.some((e) => e.type === "feedback.good_job" && e.payload.taskId === taskId)).toBe(true);
    expect(reduceOffice(evs).agents[agent.id]!.reaction).toMatchObject({ kind: "cookie" });
  });
});
