import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { magicPacket } from "../src/companion/service.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";

/** A stand-in companion: it answers like the Go app does, typing into a fake notepad. */
function fakeDevice(url: string, token: string, power: string, onKill: () => void) {
  let typed = "";
  let focused = false;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", data: { deviceName: "shop-pc", os: "windows", power, folders: ["C:\\Shop"], apps: ["notepad.exe"] } }));
      resolve();
    });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as { type: string; id: string; action: string; args: Record<string, unknown> };
    if (m.type === "kill") return onKill();
    if (m.type !== "command") return;
    const reply = (ok: boolean, data?: unknown, error?: string) => ws.send(JSON.stringify({ type: "result", id: m.id, ok, data, error }));
    if (m.action === "click") {
      focused = Number(m.args.x) < 300;
      reply(true);
    } else if (m.action === "type") {
      if (!focused) return reply(false, undefined, "the focused window is not a shared app");
      typed += String(m.args.text);
      reply(true);
      // A screenshot for the audit trail (a 1×1 PNG).
      ws.send(JSON.stringify({ type: "event", kind: "screenshot", data: { action: "type", png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==" } }));
    } else if (m.action === "screenshot") reply(true, { width: 640, height: 400, png: "" });
    else reply(false, undefined, "unknown");
  });
  return { ws, opened, typed: () => typed };
}

const sh = (command: string) => ({ toolCalls: [{ name: "desktop_act", arguments: { action: "click", x: 50, y: 50, note: command } }] });

describe("M12: Windows companion (server side)", () => {
  let t: TestApp;
  let base: string;
  beforeAll(async () => {
    t = await startTestApp({ TASK_CONFIRM_ABOVE_USD: "1000", BIN_PICKER_INTERVAL_HOURS: "0" });
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    base = `127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await t.services.tasks.idle();
    await t.close();
  });

  async function ws() {
    const s = await signup(t.app);
    const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: { cookie: s.cookie }, ...(payload ? { payload } : {}) });
    return { ...s, inject };
  }
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("pairs once with a code, then runs click-and-type through the tunnel, keeping a screenshot trail", async () => {
    const w = await ws();
    const { code } = (await w.inject("POST", "/companion/pairings")).json();
    expect(code).toMatch(/^NB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const pair = await t.app.inject({ method: "POST", url: "/companion/pair", payload: { code, deviceName: "shop-pc", os: "windows", mac: "AA-BB-CC-DD-EE-FF" } });
    expect(pair.statusCode).toBe(201);
    const { deviceId, token } = pair.json();
    expect((await t.app.inject({ method: "POST", url: "/companion/pair", payload: { code } })).statusCode).toBe(401);

    // Bad tokens never get a tunnel.
    await expect(fakeDevice(`ws://${base}/companion/tunnel`, "nbc_nope", "view", () => {}).opened).rejects.toThrow("401");

    const killed: string[] = [];
    const dev = fakeDevice(`ws://${base}/companion/tunnel`, token, "view+click", () => killed.push("kill"));
    await dev.opened;
    await until(async () => (await w.inject("GET", "/companion/devices")).json().devices[0]?.online);
    const [listed] = (await w.inject("GET", "/companion/devices")).json().devices;
    expect(listed).toMatchObject({ id: deviceId, power: "view+click", apps: ["notepad.exe"], folders: ["C:\\Shop"], enabled: false, agentId: null, mac: "aa:bb:cc:dd:ee:ff" });

    for (const [action, args] of [
      ["click", { x: 50, y: 50 }],
      ["type", { text: "Order #42 shipped" }],
    ] as const) {
      const r = await w.inject("POST", `/companion/devices/${deviceId}/command`, { action, args });
      expect(r.statusCode).toBe(200);
    }
    expect(dev.typed()).toBe("Order #42 shipped");
    // The server refuses actions above the device's power level before asking it.
    const tooMuch = await w.inject("POST", `/companion/devices/${deviceId}/command`, { action: "launch_app", args: { app: "notepad.exe" } });
    expect(tooMuch.statusCode).toBe(403);
    await until(async () => (await w.inject("GET", "/events?limit=1000")).json().events.some((e: { type: string }) => e.type === "companion.screenshot"));
    const evs = (await w.inject("GET", "/events?limit=1000")).json().events as { type: string; payload: Record<string, unknown> }[];
    const shot = evs.find((e) => e.type === "companion.screenshot")!;
    expect((await w.inject("GET", `/files/${shot.payload.fileId}`)).statusCode).toBe(200);
    expect(evs.filter((e) => e.type === "companion.command").map((e) => [e.payload.action, e.payload.ok])).toEqual([
      ["click", true],
      ["type", true],
    ]);

    // The workspace kill switch reaches the computer too.
    await w.inject("POST", "/kill-switch", { engage: true });
    await until(() => killed.length > 0);
    expect(killed).toEqual(["kill"]);
    await w.inject("POST", "/kill-switch", { engage: false });

    // Unpairing closes the tunnel and the token stops working.
    expect((await w.inject("DELETE", `/companion/devices/${deviceId}`)).json()).toEqual({ ok: true });
    await until(() => dev.ws.readyState === WebSocket.CLOSED);
    await expect(fakeDevice(`ws://${base}/companion/tunnel`, token, "view", () => {}).opened).rejects.toThrow("401");
  });

  it("gives desktop tools only to the agent a human enabled", async () => {
    const w = await ws();
    await w.inject("PUT", "/settings/llm", {
      providers: [
        { name: "fast", type: "fake", kind: "local", models: ["m"], fake: { reply: "{}", match: [{ contains: "You plan work", text: '{"steps":["click"]}' }, { contains: "You check an agent", text: '{"summary":"ok","claims":[]}' }] } },
        { name: "smart", type: "fake", kind: "local", models: ["m"], fake: { script: [sh("x"), { text: "draft" }, { text: "done" }] } },
      ],
      aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
      redactPii: false,
      pricing: {},
      dailyBudgetUsd: null,
    });
    const agent = (await w.inject("POST", "/agents", { name: "Desky", autonomyLevel: "act_within_limits" })).json();
    const { code } = (await w.inject("POST", "/companion/pairings")).json();
    const { deviceId, token } = (await t.app.inject({ method: "POST", url: "/companion/pair", payload: { code } })).json();
    const dev = fakeDevice(`ws://${base}/companion/tunnel`, token, "view+click", () => {});
    await dev.opened;
    await until(() => t.services.companion.isOnline(deviceId));

    const run = async () => {
      const id = (await w.inject("POST", `/agents/${agent.id}/tasks`, { goal: "Click into notepad" })).json().id;
      await t.services.tasks.idle();
      return (await w.inject("GET", `/tasks/${id}`)).json();
    };
    // Paired but not enabled for this agent: the tool says so and nothing reaches the computer.
    await run();
    let cmds = (await w.inject("GET", "/events?limit=1000")).json().events.filter((e: { type: string }) => e.type === "companion.command");
    expect(cmds).toEqual([]);

    await w.inject("PATCH", `/companion/devices/${deviceId}`, { agentId: agent.id, enabled: true });
    await run();
    cmds = (await w.inject("GET", "/events?limit=1000")).json().events.filter((e: { type: string }) => e.type === "companion.command");
    expect(cmds.map((e: { payload: { by: string; action: string } }) => [e.payload.by, e.payload.action])).toEqual([["agent", "click"]]);
    dev.ws.close();
  });

  it("builds a Wake-on-LAN magic packet", () => {
    const p = magicPacket("aa:bb:cc:dd:ee:ff");
    expect(p.length).toBe(102);
    expect(p.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    expect(p.subarray(96)).toEqual(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
  });
});
