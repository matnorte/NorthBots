import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SoftAuthenticator } from "../src/auth/soft/authenticator.js";
import { signup, startTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("password auth and sessions", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => t.close());

  it("signs up, reads /auth/me, logs out", async () => {
    const { cookie, email } = await signup(t.app);
    const me = await t.app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(email);

    const out = await t.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const after = await t.app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("sets an httpOnly session cookie and stores only its hash", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: uniqueEmail(), password: "correct horse battery" },
    });
    const c = res.cookies.find((x) => x.name === "nb_session");
    expect(c?.httpOnly).toBe(true);
    const rows = await t.db.pool.query("select 1 from sessions where token_hash = $1", [c?.value]);
    expect(rows.rowCount).toBe(0);
  });

  it("rejects a duplicate email", async () => {
    const { email } = await signup(t.app);
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "another long password" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("logs in with the right password only, and hashes with argon2id", async () => {
    const { email } = await signup(t.app);
    const bad = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "wrong-password!!" } });
    expect(bad.statusCode).toBe(401);
    const good = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    expect(good.statusCode).toBe(200);
    const row = await t.db.pool.query("select password_hash from users where email = $1", [email]);
    expect(row.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it("rejects short passwords and unauthenticated access", async () => {
    const res = await t.app.inject({ method: "POST", url: "/auth/signup", payload: { email: uniqueEmail(), password: "short" } });
    expect(res.statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/settings" })).statusCode).toBe(401);
  });
});

describe("passkeys", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => t.close());

  it("registers a passkey and logs in with it", async () => {
    const { cookie, email } = await signup(t.app);
    const auth = new SoftAuthenticator(t.config.WEB_ORIGIN, t.config.RP_ID);

    const regOpts = await t.app.inject({ method: "POST", url: "/auth/passkey/register/options", headers: { cookie } });
    const { challengeId, options } = regOpts.json();
    const reg = await t.app.inject({
      method: "POST",
      url: "/auth/passkey/register/verify",
      headers: { cookie },
      payload: { challengeId, credential: auth.create(options) },
    });
    expect(reg.statusCode).toBe(200);

    const loginOpts = (await t.app.inject({ method: "POST", url: "/auth/passkey/login/options" })).json();
    const login = await t.app.inject({
      method: "POST",
      url: "/auth/passkey/login/verify",
      payload: { challengeId: loginOpts.challengeId, credential: auth.get(loginOpts.options) },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().email).toBe(email);
    expect(login.cookies.some((c) => c.name === "nb_session")).toBe(true);
  });

  it("refuses a replayed challenge", async () => {
    const { cookie } = await signup(t.app);
    const auth = new SoftAuthenticator(t.config.WEB_ORIGIN, t.config.RP_ID);
    const { challengeId, options } = (
      await t.app.inject({ method: "POST", url: "/auth/passkey/register/options", headers: { cookie } })
    ).json();
    const credential = auth.create(options);
    const send = () =>
      t.app.inject({
        method: "POST",
        url: "/auth/passkey/register/verify",
        headers: { cookie },
        payload: { challengeId, credential },
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(400);
  });

  it("rejects a signature from the wrong origin", async () => {
    const { cookie } = await signup(t.app);
    const evil = new SoftAuthenticator("https://evil.example", t.config.RP_ID);
    const { challengeId, options } = (
      await t.app.inject({ method: "POST", url: "/auth/passkey/register/options", headers: { cookie } })
    ).json();
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/passkey/register/verify",
      headers: { cookie },
      payload: { challengeId, credential: evil.create(options) },
    });
    expect(res.statusCode).toBe(400);
  });
});
