// M3: two agents with real computers. A file in one is invisible to the other; the browser
// opens a page and reads its title; hibernate + wake keeps the file and the open tab; a curl
// call is logged as an egress event.
import { Client, assert, log } from "./client.mjs";

const c = new Client();
await c.signup();

const created = [];
async function agent(name) {
  const r = await c.req("POST", "/agents", { name });
  assert(r.status === 201, `create ${name}: ${r.status} ${r.text}`);
  created.push(r.json.id);
  return r.json;
}
const exec = async (id, command) => {
  const r = await c.req("POST", `/agents/${id}/computer/exec`, { command, timeoutMs: 60_000 });
  assert(r.status === 200, `exec ${command}: ${r.status} ${r.text}`);
  return r.json;
};

try {
  const a = await agent("Ada");
  const b = await agent("Bo");
  log(`created two agents with computers ${a.sandboxId} and ${b.sandboxId}`);

  assert((await exec(a.id, "echo hi > a.txt")).exitCode === 0, "write a.txt failed");
  const other = await exec(b.id, "cat a.txt");
  assert(other.exitCode !== 0, "the second agent could read the first agent's file");
  log("a file written by one agent is invisible to the other");

  const page = "data:text/html,<title>North Star Shop</title><h1>Welcome</h1>";
  const open = await c.req("POST", `/agents/${a.id}/browser`, { action: "goto", url: page });
  assert(open.status === 200 && open.json.title === "North Star Shop", `browser title: ${open.status} ${open.text}`);
  log(`browser opened a page and read its title: "${open.json.title}"`);

  const h = await c.req("POST", `/agents/${a.id}/computer/hibernate`);
  assert(h.json.state === "hibernated", `hibernate: ${h.text}`);
  const w = await c.req("POST", `/agents/${a.id}/computer/wake`);
  assert(w.json.state === "running", `wake: ${w.text}`);
  assert((await exec(a.id, "cat a.txt")).stdout === "hi\n", "file lost across hibernate");
  const tabs = await c.req("GET", `/agents/${a.id}/browser/tabs`);
  assert(tabs.json.pages.some((p) => p.title === "North Star Shop"), `tab lost across hibernate: ${tabs.text}`);
  log("hibernate + wake kept the file and the open tab");

  const curl = await exec(a.id, "curl -s -m 20 -o /dev/null -w '%{http_code}' https://example.com || true");
  let egress = null;
  for (let i = 0; i < 30 && !egress; i++) {
    const ev = await c.req("GET", "/events?limit=1000");
    egress = ev.json.events.find((e) => e.type === "egress" && e.agentId === a.id && e.payload.host === "example.com");
    if (!egress) await new Promise((r) => setTimeout(r, 500));
  }
  assert(egress, "no egress event for the curl call");
  log(`egress logged: ${egress.payload.method} ${egress.payload.host}:${egress.payload.port} (${egress.payload.status}, curl said ${curl.stdout || "nothing"})`);

  const direct = await exec(a.id, "curl -s --noproxy '*' -m 5 https://example.com >/dev/null; echo $?");
  assert(direct.stdout.trim() !== "0", "a direct connection that skips the proxy got out");
  log("a direct connection that skips the proxy is blocked");
} finally {
  for (const id of created) await c.req("DELETE", `/agents/${id}`);
}
