import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { EventFeedMessage, StoredEvent } from "@northbot/shared";
import type { EventLog } from "../src/events/log.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";

function collect(url: string, cookie: string, until: (msgs: EventFeedMessage[]) => boolean) {
  return new Promise<EventFeedMessage[]>((resolve, reject) => {
    const msgs: EventFeedMessage[] = [];
    const ws = new WebSocket(url, { headers: { cookie } });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout; got ${msgs.length} messages`));
    }, 10_000);
    ws.on("message", (data) => {
      msgs.push(JSON.parse(String(data)) as EventFeedMessage);
      if (until(msgs)) {
        clearTimeout(timer);
        ws.close();
        resolve(msgs);
      }
    });
    ws.on("error", reject);
  });
}

describe("event log", () => {
  let t: TestApp;
  let base: string;
  beforeAll(async () => {
    t = await startTestApp();
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = t.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    base = `ws://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => t.close());

  it("rejects untyped or invalid payloads", async () => {
    const { me } = await signup(t.app);
    // @ts-expect-error unknown type is a compile error too
    await expect(t.services.events.write(me.workspaceId, { type: "nope", payload: {} })).rejects.toThrow();
    await expect(
      t.services.events.write(me.workspaceId, { type: "user.note", payload: { text: "" } }),
    ).rejects.toThrow();
  });

  it("only accepts client-writable types over HTTP", async () => {
    const { cookie } = await signup(t.app);
    const res = await t.app.inject({
      method: "POST",
      url: "/events",
      headers: { cookie },
      payload: { type: "auth.login", payload: { userId: "x", method: "password" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("replays from an id over WebSocket, then streams live", async () => {
    const { cookie } = await signup(t.app);
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await t.app.inject({ method: "POST", url: "/events", headers: { cookie }, payload: { type: "user.note", payload: { text: `n${i}` } } });
      ids.push(r.json().id);
    }
    const from = ids[10] as number;
    const live = collect(`${base}/events/stream?from=${from}`, cookie, (m) =>
      m.some((x) => x.kind === "event" && x.event.payload.text === "live"),
    );
    await new Promise((r) => setTimeout(r, 300));
    await t.app.inject({ method: "POST", url: "/events", headers: { cookie }, payload: { type: "user.note", payload: { text: "live" } } });
    const msgs = await live;

    const gotIds = msgs.flatMap((m) => (m.kind === "event" ? [m.event.id] : []));
    expect(gotIds.slice(0, 10)).toEqual(ids.slice(10));
    expect(new Set(gotIds).size).toBe(gotIds.length);
    expect(msgs.findIndex((m) => m.kind === "replay_done")).toBe(10);
  });

  it("never leaks another workspace's events", async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    await t.app.inject({ method: "POST", url: "/events", headers: { cookie: a.cookie }, payload: { type: "user.note", payload: { text: "secret-plan" } } });
    const res = await t.app.inject({ method: "GET", url: "/events", headers: { cookie: b.cookie } });
    expect(res.body).not.toContain("secret-plan");
  });

  it("refuses the WebSocket without a session", async () => {
    await expect(collect(`${base}/events/stream`, "", () => true)).rejects.toThrow();
  });
});

describe("event feed ordering", () => {
  it("delivers a live event that commits after a newer one (lower id, arriving late), exactly once", async () => {
    const { streamEvents } = await import("../src/events/feed.js");
    let listener: ((e: StoredEvent) => void) | null = null;
    const log = {
      subscribe: (_ws: string, fn: (e: StoredEvent) => void) => {
        listener = fn;
        return () => {};
      },
      list: async () => [],
    } as unknown as EventLog;
    const sent: EventFeedMessage[] = [];
    await streamEvents(log, "w", 0, (m) => sent.push(m));
    const ev = (id: number): StoredEvent => ({ id, ts: new Date().toISOString(), agentId: null, roomId: null, type: "user.note", payload: { text: "x" }, costUsd: 0 });
    listener!(ev(11));
    listener!(ev(10));
    listener!(ev(11));
    expect(sent.filter((m) => m.kind === "event").map((m) => (m.kind === "event" ? m.event.id : 0))).toEqual([11, 10]);
  });
});
