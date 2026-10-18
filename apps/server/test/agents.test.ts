import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { signup, startTestApp, type TestApp } from "./helpers.js";

describe("agents and their computers", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
    await t.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => t.close());

  const createAgent = async (cookie: string, name: string) => {
    const res = await t.app.inject({ method: "POST", url: "/agents", headers: { cookie }, payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; sandboxId: string; name: string };
  };

  const eventTypes = async (cookie: string) =>
    ((await t.app.inject({ method: "GET", url: "/events?limit=1000", headers: { cookie } })).json().events as { type: string }[]).map(
      (e) => e.type,
    );

  it("creates an agent with its own computer and logs it", async () => {
    const { cookie } = await signup(t.app);
    const a = await createAgent(cookie, "Pip");
    expect(a.sandboxId).toMatch(/^sbx[0-9a-f]{12}$/);
    expect(await t.sandbox.state(a.sandboxId)).toBe("running");
    expect(await eventTypes(cookie)).toEqual(expect.arrayContaining(["agent.created", "sandbox.created"]));
    const list = await t.app.inject({ method: "GET", url: "/agents", headers: { cookie } });
    expect(list.json().agents.map((x: { name: string }) => x.name)).toEqual(["Pip"]);
  });

  it("rejects a duplicate name (case-insensitive) and bad names", async () => {
    const { cookie } = await signup(t.app);
    await createAgent(cookie, "Mochi");
    const dup = await t.app.inject({ method: "POST", url: "/agents", headers: { cookie }, payload: { name: "mochi" } });
    expect(dup.statusCode).toBe(409);
    const bad = await t.app.inject({ method: "POST", url: "/agents", headers: { cookie }, payload: { name: "x" } });
    expect(bad.statusCode).toBe(400);
  });

  it("runs commands on one computer that the other cannot see, and logs them", async () => {
    const { cookie } = await signup(t.app);
    const a = await createAgent(cookie, "Ada");
    const b = await createAgent(cookie, "Bo");
    const run = (id: string, command: string) =>
      t.app.inject({ method: "POST", url: `/agents/${id}/computer/exec`, headers: { cookie }, payload: { command } });
    expect((await run(a.id, "echo hi > a.txt")).json().exitCode).toBe(0);
    expect((await run(a.id, "cat a.txt")).json().stdout).toBe("hi\n");
    expect((await run(b.id, "cat a.txt")).json().exitCode).toBe(1);
    const events = (await t.app.inject({ method: "GET", url: "/events?limit=1000", headers: { cookie } })).json().events as {
      type: string;
      agentId: string;
      payload: { command?: string; by?: string };
    }[];
    const execs = events.filter((e) => e.type === "terminal.exec");
    expect(execs.map((e) => [e.agentId, e.payload.command, e.payload.by])).toEqual([
      [a.id, "echo hi > a.txt", "user"],
      [a.id, "cat a.txt", "user"],
      [b.id, "cat a.txt", "user"],
    ]);
  });

  it("scrubs secrets from logged commands", async () => {
    const { cookie } = await signup(t.app);
    const a = await createAgent(cookie, "Kit");
    await t.app.inject({
      method: "POST",
      url: `/agents/${a.id}/computer/exec`,
      headers: { cookie },
      payload: { command: "echo sk-live-abcdefghijklmnop1234" },
    });
    const body = (await t.app.inject({ method: "GET", url: "/events?limit=1000", headers: { cookie } })).body;
    expect(body).not.toContain("sk-live-abcdefghijklmnop1234");
  });

  it("hibernates, wakes on the next command, and keeps the browser tab", async () => {
    const { cookie } = await signup(t.app);
    const a = await createAgent(cookie, "Zed");
    const open = await t.app.inject({
      method: "POST",
      url: `/agents/${a.id}/browser`,
      headers: { cookie },
      payload: { action: "goto", url: "data:text/html,<title>Shop</title>" },
    });
    expect(open.json().title).toBe("Shop");
    const h = await t.app.inject({ method: "POST", url: `/agents/${a.id}/computer/hibernate`, headers: { cookie } });
    expect(h.json().state).toBe("hibernated");
    await t.app.inject({ method: "POST", url: `/agents/${a.id}/computer/exec`, headers: { cookie }, payload: { command: "pwd" } });
    expect(await t.sandbox.state(a.sandboxId)).toBe("running");
    const tabs = await t.app.inject({ method: "GET", url: `/agents/${a.id}/browser/tabs`, headers: { cookie } });
    expect(tabs.json().pages[0].title).toBe("Shop");
    expect(await eventTypes(cookie)).toEqual(expect.arrayContaining(["sandbox.hibernated", "sandbox.woken", "browser.action"]));
  });

  it("keeps other workspaces out", async () => {
    const owner = await signup(t.app);
    const intruder = await signup(t.app);
    const a = await createAgent(owner.cookie, "Private");
    const res = await t.app.inject({
      method: "POST",
      url: `/agents/${a.id}/computer/exec`,
      headers: { cookie: intruder.cookie },
      payload: { command: "ls" },
    });
    expect(res.statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: `/agents/${a.id}`, headers: { cookie: intruder.cookie } })).statusCode).toBe(404);
  });

  it("streams the live terminal and logs attach and detach", async () => {
    const { cookie } = await signup(t.app);
    const a = await createAgent(cookie, "Term");
    const port = (t.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/${a.id}/terminal`, { headers: { cookie } });
    const output = await new Promise<string>((resolve, reject) => {
      let buf = "";
      ws.on("open", () => ws.send(JSON.stringify({ type: "input", data: "echo live-shell\r" })));
      ws.on("message", (raw) => {
        buf += (JSON.parse(String(raw)) as { data: string }).data;
        if (buf.includes("live-shell")) resolve(buf);
      });
      ws.on("error", reject);
    });
    expect(output).toContain("live-shell");
    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(await eventTypes(cookie)).toEqual(expect.arrayContaining(["terminal.attached", "terminal.detached"]));
  });

  it("deletes the agent and destroys its computer", async () => {
    const { cookie } = await signup(t.app);
    const a = await createAgent(cookie, "Gone");
    const del = await t.app.inject({ method: "DELETE", url: `/agents/${a.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(await t.sandbox.state(a.sandboxId)).toBe("missing");
    expect(await eventTypes(cookie)).toEqual(expect.arrayContaining(["sandbox.destroyed", "agent.deleted"]));
  });
});
