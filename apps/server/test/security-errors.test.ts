import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, startTestApp, type TestApp } from "./helpers.js";

describe("security and vault: caller mistakes are 400s, not 500s", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ BIN_PICKER_INTERVAL_HOURS: "0", CANARY_INTERVAL_MINUTES: "0" });
  });
  afterAll(() => t.close());

  it("refuses a grant for an unknown agent and a reserved vault name with 400", async () => {
    const s = await signup(t.app);
    const inject = (method: "POST" | "PUT", url: string, payload: object) => t.app.inject({ method, url, headers: { cookie: s.cookie }, payload });
    await inject("PUT", "/vault/secrets", { name: "SHOP_TOKEN", value: "x" });
    const grant = await inject("POST", "/security/grants", {
      resource: "secret:SHOP_TOKEN",
      subjectKind: "agent",
      subjectId: "00000000-0000-4000-8000-000000000000",
      role: "use-only",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(grant.statusCode).toBe(400);
    expect(grant.json()).toMatchObject({ error: "bad_request", message: "No such team member or agent" });
    const reserved = await inject("PUT", "/vault/secrets", { name: "AUDIT_SIGNING_KEY", value: "x" });
    expect(reserved.statusCode).toBe(400);
  });
});
