import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers.js";

describe("GET /health", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("returns ok with a live database", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", db: "ok" });
  });

  it("ran migrations on boot (pgvector + app_meta exist)", async () => {
    const ext = await t.db.pool.query("select 1 from pg_extension where extname = 'vector'");
    expect(ext.rowCount).toBe(1);
    const tbl = await t.db.pool.query("select to_regclass('public.app_meta') as t");
    expect(tbl.rows[0].t).toBe("app_meta");
  });

  it("publishes an OpenAPI document listing /health", async () => {
    const res = await t.app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.json().paths["/health"]).toBeDefined();
  });
});
