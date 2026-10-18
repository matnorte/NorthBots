import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { scanRows } from "../src/security/stream.js";
import { events, facts, files } from "../src/db/schema.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";

describe("person export streaming", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("fetches bounded pages on demand and stops fetching when the consumer leaves", async () => {
    const page = vi.fn(async (after: number | undefined) =>
      Array.from({ length: 100 }, (_, i) => ({ id: (after ?? 0) + i + 1 })),
    );
    const rows = scanRows(page);
    expect(page).not.toHaveBeenCalled();
    expect((await rows.next()).value).toEqual({ id: 1 });
    expect(page).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 100; i++) await rows.next();
    expect(page).toHaveBeenCalledTimes(1);
    expect((await rows.next()).value).toEqual({ id: 101 });
    expect(page).toHaveBeenLastCalledWith(100);
    await rows.return(undefined);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("streams all stored matches beyond the UI cap, decrypts expired memories and isolates workspaces", async () => {
    const owner = await signup(t.app);
    const stranger = await signup(t.app);
    const ws = owner.me.workspaceId;
    const first = await t.services.memory.add({
      workspaceId: ws,
      agentId: null,
      text: "maya-export@example.test prefers tea",
    });
    await t.db.pool.query(
      `insert into facts(workspace_id,text,embedding,embedding_model,expires_at)
       select workspace_id,text,embedding,embedding_model,now()-interval '1 day'
       from facts cross join generate_series(1,520) where id=$1`,
      [first.id],
    );
    await t.services.memory.add({
      workspaceId: stranger.me.workspaceId,
      agentId: null,
      text: "maya-export@example.test private foreign note",
    });
    await t.db.db.insert(files).values({
      workspaceId: ws,
      name: "person.txt",
      mime: "text/plain",
      size: 24,
      sha256: "test",
      data: Buffer.from("maya-export@example.test"),
    });
    await t.db.db.insert(events).values(
      Array.from({ length: 205 }, () => ({
        workspaceId: ws,
        type: "user.note",
        payload: { text: "maya-export@example.test" },
      })),
    );
    const list = vi.spyOn(t.services.memory, "list");
    const stream = t.services.audit.personExport(ws, "maya-export@example.test");
    expect(stream).toBeInstanceOf(Readable);
    expect(stream.readableLength).toBe(0);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    const exported = JSON.parse(Buffer.concat(chunks).toString()) as {
      memory: { text: string; expiresAt: string | null }[];
      events: { payload: { text?: string } }[];
      files: { data: string }[];
      records: Record<string, unknown[]>;
    };
    expect(exported.memory).toHaveLength(521);
    expect(exported.events).toHaveLength(205);
    expect(exported.memory.filter((m) => m.expiresAt !== null)).toHaveLength(520);
    expect(exported.memory.every((m) => m.text === "maya-export@example.test prefers tea")).toBe(
      true,
    );
    expect(exported.files[0]?.data).toBe(
      Buffer.from("maya-export@example.test").toString("base64"),
    );
    expect(exported.records).toHaveProperty("room_messages", []);
    expect(list).not.toHaveBeenCalled();
    list.mockRestore();
    expect(() => t.services.audit.personExport(ws, "  ")).toThrow("specific person identifier");
    const response = await t.app.inject({
      method: "POST",
      url: "/security/person/export",
      headers: { cookie: owner.cookie },
      payload: { query: "maya-export@example.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json().memory).toHaveLength(521);
    // Erasure consumes the same bounded scan, including facts the UI does not show.
    expect((await t.services.audit.erase(ws, "maya-export@example.test")).memory).toBe(521);
    const remaining = await t.db.db.select().from(facts);
    expect(remaining.some((f) => f.workspaceId === ws)).toBe(false);
    expect(remaining.some((f) => f.workspaceId === stranger.me.workspaceId)).toBe(true);
  });
});
