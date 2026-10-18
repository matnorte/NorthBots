import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, startTestApp, type TestApp } from "./helpers.js";

describe("workspace settings", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => t.close());

  it("defaults to America/Sao_Paulo and can be updated", async () => {
    const { cookie } = await signup(t.app);
    const get = await t.app.inject({ method: "GET", url: "/settings", headers: { cookie } });
    expect(get.json()).toMatchObject({ timezone: "America/Sao_Paulo", locale: "en" });

    const patch = await t.app.inject({
      method: "PATCH",
      url: "/settings",
      headers: { cookie },
      payload: { timezone: "Europe/Lisbon", locale: "pt-BR", name: "Loja" },
    });
    expect(patch.json()).toEqual({ timezone: "Europe/Lisbon", locale: "pt-BR", name: "Loja" });
  });

  it("rejects an unknown timezone", async () => {
    const { cookie } = await signup(t.app);
    const res = await t.app.inject({ method: "PATCH", url: "/settings", headers: { cookie }, payload: { timezone: "Mars/Olympus" } });
    expect(res.statusCode).toBe(400);
  });
});
