// Tiny HTTP client for acceptance scripts: keeps the session cookie between calls.
import { randomUUID } from "node:crypto";

export const API = process.env.NORTHBOT_API ?? "http://localhost:3000";

export function fail(msg) {
  console.error(`\x1b[1;31m[accept] FAIL:\x1b[0m ${msg}`);
  process.exit(1);
}

export function log(msg) {
  console.log(`\x1b[1;35m[accept]\x1b[0m ${msg}`);
}

export function assert(cond, msg) {
  if (!cond) fail(msg);
}

export class Client {
  cookie = "";

  async req(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("nb_session="));
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  }

  async signup() {
    const email = `accept-${randomUUID()}@example.test`;
    const r = await this.req("POST", "/auth/signup", { email, password: "acceptance password 1" });
    assert(r.status === 201, `signup failed: ${r.status} ${r.text}`);
    return { email, ...r.json };
  }
}
