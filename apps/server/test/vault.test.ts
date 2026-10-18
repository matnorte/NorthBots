import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretBox } from "../src/vault/crypto.js";
import { DEV_MASTER_KEY } from "../src/config.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";

const CANARY = "sk-canary-7f3a9c1e5b2d8046";

describe("SecretBox", () => {
  it("round-trips and scopes keys per workspace", async () => {
    const box = await SecretBox.create(DEV_MASTER_KEY);
    const sealed = box.seal("ws-a", CANARY);
    expect(sealed.ciphertext.toString("utf8")).not.toContain(CANARY);
    expect(box.open("ws-a", sealed)).toBe(CANARY);
    expect(() => box.open("ws-b", sealed)).toThrow();
  });

  it("refuses a master key of the wrong length", async () => {
    await expect(SecretBox.create(Buffer.from("short").toString("base64"))).rejects.toThrow();
  });
});

describe("vault API", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => t.close());

  it("stores a secret and never returns its value from any route", async () => {
    const { cookie } = await signup(t.app);
    const put = await t.app.inject({
      method: "PUT",
      url: "/vault/secrets",
      headers: { cookie },
      payload: { name: "OPENAI_API_KEY", value: CANARY },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(CANARY);

    const list = await t.app.inject({ method: "GET", url: "/vault/secrets", headers: { cookie } });
    expect(list.json().secrets.map((s: { name: string }) => s.name)).toEqual(["OPENAI_API_KEY"]);
    expect(list.body).not.toContain(CANARY);

    const events = await t.app.inject({ method: "GET", url: "/events", headers: { cookie } });
    expect(events.body).toContain("vault.secret_stored");
    expect(events.body).not.toContain(CANARY);

    const raw = await t.db.pool.query("select ciphertext from secrets where name = 'OPENAI_API_KEY'");
    for (const r of raw.rows) expect(Buffer.from(r.ciphertext).toString("utf8")).not.toContain(CANARY);
  });

  it("delivers the value only to the sandbox sink", async () => {
    const { cookie } = await signup(t.app);
    await t.app.inject({ method: "PUT", url: "/vault/secrets", headers: { cookie }, payload: { name: "SHOP_TOKEN", value: CANARY } });
    const use = await t.app.inject({
      method: "POST",
      url: "/vault/secrets/SHOP_TOKEN/use",
      headers: { cookie },
      payload: { sandboxId: "sbx-1", as: "env", target: "SHOP_TOKEN" },
    });
    expect(use.statusCode).toBe(200);
    expect(use.body).not.toContain(CANARY);
    expect(t.sink.deliveries.at(-1)).toMatchObject({ sandboxId: "sbx-1", value: CANARY });
  });

  it("keeps workspaces apart", async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    await t.app.inject({ method: "PUT", url: "/vault/secrets", headers: { cookie: a.cookie }, payload: { name: "ONLY_A", value: "x1" } });
    const list = await t.app.inject({ method: "GET", url: "/vault/secrets", headers: { cookie: b.cookie } });
    expect(list.json().secrets).toEqual([]);
    const use = await t.app.inject({
      method: "POST",
      url: "/vault/secrets/ONLY_A/use",
      headers: { cookie: b.cookie },
      payload: { sandboxId: "s", as: "env", target: "X" },
    });
    expect(use.statusCode).toBe(404);
  });

  it("deletes a secret", async () => {
    const { cookie } = await signup(t.app);
    await t.app.inject({ method: "PUT", url: "/vault/secrets", headers: { cookie }, payload: { name: "TEMP_KEY", value: "v" } });
    const del = await t.app.inject({ method: "DELETE", url: "/vault/secrets/TEMP_KEY", headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const again = await t.app.inject({ method: "DELETE", url: "/vault/secrets/TEMP_KEY", headers: { cookie } });
    expect(again.statusCode).toBe(404);
  });
});
