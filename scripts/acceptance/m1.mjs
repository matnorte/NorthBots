// M1: create an account via the API, store a secret, prove the API never returns it,
// write 100 events and replay from the 50th over the WebSocket feed.
import WebSocket from "ws";
import { API, Client, assert, log } from "./client.mjs";

const CANARY = `sk-canary-${Math.random().toString(36).slice(2)}${Date.now()}`;
const c = new Client();

const me = await c.signup();
log(`account created: ${me.email}`);

const put = await c.req("PUT", "/vault/secrets", { name: "OPENAI_API_KEY", value: CANARY });
assert(put.status === 200, `put secret: ${put.status} ${put.text}`);

const seen = [put.text];
for (const path of ["/vault/secrets", "/events?limit=1000", "/settings", "/auth/me", "/openapi.json"]) {
  const r = await c.req("GET", path);
  assert(r.status === 200, `${path}: ${r.status}`);
  seen.push(r.text);
}
const names = JSON.parse(seen[1]).secrets.map((s) => s.name);
assert(names.includes("OPENAI_API_KEY"), "secret name not listed");
assert(!seen.some((t) => t.includes(CANARY)), "a route returned the secret value");
log("secret stored; no route returned its value");

const ids = [];
for (let i = 1; i <= 100; i++) {
  const r = await c.req("POST", "/events", { type: "user.note", payload: { text: `event ${i}` } });
  assert(r.status === 201, `write event ${i}: ${r.status} ${r.text}`);
  ids.push(r.json.id);
}
log(`wrote 100 events (${ids[0]}..${ids[99]})`);

const from = ids[49];
const replayed = await new Promise((resolve, reject) => {
  const got = [];
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/events/stream?from=${from}`, {
    headers: { cookie: c.cookie },
  });
  const timer = setTimeout(() => reject(new Error("replay timed out")), 15000);
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.kind === "event") got.push(msg.event);
    if (msg.kind === "replay_done") {
      clearTimeout(timer);
      ws.close();
      resolve(got);
    }
  });
  ws.on("error", reject);
});

const gotIds = replayed.map((e) => e.id);
assert(gotIds.length === 51, `expected 51 replayed events, got ${gotIds.length}`);
assert(JSON.stringify(gotIds) === JSON.stringify(ids.slice(49)), "replayed ids do not match 50..100");
assert(replayed[0].payload.text === "event 50", "first replayed event is not event 50");
log("replayed events 50..100 over WebSocket in order");
