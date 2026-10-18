// M12 against the running compose stack: backup then restore into a fresh database reproduces
// agents, memory and schedules; `northbot update` rolls back when health fails; the real Windows
// companion (fake desktop driver) pairs and runs a click-and-type script; the store pack runs a
// simulated day into a profit report; the OpenAPI file is exported to docs/openapi.json.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, Client, assert, log } from "./client.mjs";

const ROOT = process.env.ROOT ?? process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "northbot-m12-"));
const sh = (args, opts = {}) => execFileSync("bash", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NORTHBOT_DIR: ROOT }, ...opts });
const psql = (db, query) => sh(["-c", `docker compose exec -T postgres psql -U northbot -d ${db} -At -c "${query.replace(/"/g, '\\"')}"`]).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, check, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    assert(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(250);
  }
}

const c = new Client();
const me = await c.signup();
const created = [];

try {
  // ---- 1. Backup, then restore into a fresh database ----
  const agent = (await c.req("POST", "/agents", { name: "Keeper" })).json;
  created.push(agent.id);
  await c.req("POST", "/memory", { text: "The backup test remembers this sentence", agentId: agent.id });
  await c.req("POST", "/memory", { text: "Shared fact for the restore check" });
  const sch = await c.req("POST", "/schedules", { agentId: agent.id, definition: { name: "Nightly tidy", cronExpr: "0 2 * * *", taskPrompt: "List the files in your home folder" } });
  assert(sch.status === 201, `schedule: ${sch.status} ${sch.text}`);
  const ws = me.workspaceId;
  const snapshot = (db) => ({
    agents: psql(db, `select id||':'||name from agents where workspace_id='${ws}' order by id`),
    facts: psql(db, `select id||':'||md5(text)||':'||coalesce(agent_id::text,'shared') from facts where workspace_id='${ws}' order by id`),
    schedules: psql(db, `select id||':'||md5(definition::text)||':'||enabled from schedules where workspace_id='${ws}' order by id`),
  });
  const before = snapshot("northbot");
  assert(before.facts.split("\n").length === 2 && before.schedules.includes(":"), `unexpected starting data: ${JSON.stringify(before)}`);
  // A path relative to the repo: GNU tar reads "C:\..." on Windows as a remote host.
  const file = "test-results/m12-backup.tar.gz";
  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  sh(["deploy/northbot", "backup", file]);
  sh(["-c", "docker compose exec -T postgres dropdb -U northbot --if-exists northbot_restore"]);
  sh(["deploy/northbot", "restore", file, "--database", "northbot_restore"]);
  rmSync(join(ROOT, file), { force: true });
  const after = snapshot("northbot_restore");
  assert(JSON.stringify(after) === JSON.stringify(before), `restored data differs:\n${JSON.stringify(before)}\n${JSON.stringify(after)}`);
  sh(["-c", "docker compose exec -T postgres dropdb -U northbot --if-exists northbot_restore"]);
  log(`backup → restore into a fresh database reproduced ${before.agents.split("\n").length} agent(s), 2 memories and ${before.schedules.split("\n").length} schedule(s)`);

  // ---- 1b. An agent computer cannot reach private addresses through the egress proxy ----
  for (const url of ["http://postgres:5432/", "http://server:3000/health", "http://169.254.169.254/latest/meta-data/"]) {
    const r = (await c.req("POST", `/agents/${agent.id}/computer/exec`, { command: `curl -s -o /dev/null -w '%{http_code}' --max-time 10 ${url}` })).json;
    assert(r.stdout === "403", `${url} was not refused (got ${JSON.stringify(r)})`);
  }
  log("the egress proxy refuses private destinations (the database, the server, cloud metadata)");

  // ---- 2. An update whose health check fails rolls back by itself ----
  let failed = false;
  let out = "";
  try {
    out = sh(["deploy/northbot", "update", "--health-url", "http://127.0.0.1:3000/no-such-health-check"], { stdio: ["ignore", "pipe", "pipe"], timeout: 900_000 });
  } catch (err) {
    failed = true;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert(failed && /rolled back/.test(out), `update did not roll back:\n${out.slice(-800)}`);
  await waitFor("the server after rollback", async () => (await fetch(`${API}/health`).catch(() => null))?.ok);
  log("a failing update rolled back automatically and the server is healthy");
  // The rollback restarted the server: sign in again with a fresh session.
  await waitFor("sign-in after the restart", async () => (await c.req("GET", "/auth/me").catch(() => ({ status: 0 }))).status === 200, 120_000);
  const stillIsolated = (await c.req("POST", `/agents/${agent.id}/computer/exec`, {
    command: "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://server:3000/health",
  })).json;
  assert(stillIsolated.stdout === "403", `existing agent lost its egress proxy after rollback: ${JSON.stringify(stillIsolated)}`);
  log("existing agent networks remain connected to the egress proxy after rollback");

  // ---- 3. The real companion binary pairs and runs a click-and-type script on its fake desktop ----
  const exe = join(tmp, process.platform === "win32" ? "northbot-companion.exe" : "northbot-companion");
  execFileSync("go", ["build", "-o", exe, "./cmd/northbot-companion"], { cwd: join(ROOT, "companion"), stdio: "inherit" });
  const cfg = join(tmp, "companion.json");
  const { code } = (await c.req("POST", "/companion/pairings")).json;
  execFileSync(exe, ["pair", "--api", API, "--code", code, "--name", "test-pc", "--config", cfg], { stdio: "inherit" });
  execFileSync(exe, ["share", "--config", cfg, "--power", "view+click", "--app", "notepad.exe"], { stdio: "inherit" });
  const proc = spawn(exe, ["run", "--config", cfg, "--fake-driver"], { stdio: ["ignore", "inherit", "inherit"] });
  const exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
  try {
    const device = await waitFor("the companion to connect", async () => (await c.req("GET", "/companion/devices")).json.devices.find((d) => d.online && d.name === "test-pc"));
    assert(device.power === "view+click" && device.apps.join() === "notepad.exe", `device: ${JSON.stringify(device)}`);
    for (const [action, args] of [
      ["click", { x: 100, y: 100 }],
      ["type", { text: "Hello from NorthBot" }],
      ["key", { key: "enter" }],
    ]) {
      const r = await c.req("POST", `/companion/devices/${device.id}/command`, { action, args });
      assert(r.status === 200, `${action}: ${r.status} ${r.text}`);
    }
    const outside = await c.req("POST", `/companion/devices/${device.id}/command`, { action: "click", args: { x: 600, y: 380 } });
    assert(outside.status === 422, `a click outside shared apps was allowed: ${outside.status}`);
    const shots = await waitFor("the screenshot trail", async () => {
      const evs = (await c.req("GET", "/events?limit=1000")).json.events.filter((e) => e.type === "companion.screenshot");
      return evs.length >= 3 ? evs : null;
    });
    const png = await fetch(`${API}/files/${shots[0].payload.fileId}`, { headers: { cookie: c.cookie } });
    assert(png.ok && (await png.arrayBuffer()).byteLength > 100, "screenshot file missing");
    await c.req("POST", `/companion/devices/${device.id}/kill`);
    const code2 = await Promise.race([exited, sleep(15_000).then(() => "timeout")]);
    assert(code2 === 0, `the companion did not stop on kill (${code2})`);
    log(`companion paired, ran click → type → enter on its fake desktop (${shots.length} screenshots in the audit log), refused an unshared app, and stopped on kill`);
  } finally {
    proc.kill();
  }

  // ---- 4. The store operator pack: install, then one simulated day ----
  const inst = await c.req("POST", "/packs/store-operator/install");
  assert(inst.status === 200 && inst.json.agents === 7 && inst.json.schedules === 3, `pack install: ${inst.text}`);
  for (const a of (await c.req("GET", "/agents")).json.agents) if (!created.includes(a.id)) created.push(a.id);
  const day = await c.req("POST", "/packs/store-operator/simulate", { day: "2026-10-17", seed: 3 });
  assert(day.status === 200, `simulate: ${day.status} ${day.text}`);
  const report = day.json;
  assert(report.markdown.includes("Daily profit report") && report.report.total.revenue > 0, "no profit report");
  assert(report.report.flags.includes("Quiet Corner has earned nothing in 7 days."), `flags: ${JSON.stringify(report.report.flags)}`);
  assert(report.timeline.filter((e) => e.what.startsWith("Hourly order check")).length === 24, "hourly checks missing");
  log(`store pack: 7 agents and 3 routines installed; simulated day → profit ${report.report.total.profit.toFixed(2)} on revenue ${report.report.total.revenue.toFixed(2)}, ${report.report.flags.length} flag(s)`);

  // ---- 5. The OpenAPI file ----
  const spec = await (await fetch(`${API}/openapi.json`)).json();
  for (const path of ["/companion/pairings", "/ops/health", "/packs/store-operator/install", "/security/grants", "/schedules", "/agents/{id}/tasks"]) assert(spec.paths?.[path], `OpenAPI is missing ${path}`);
  writeFileSync(join(ROOT, "docs", "openapi.json"), `${JSON.stringify(spec, null, 2)}\n`);
  log(`OpenAPI exported to docs/openapi.json (${Object.keys(spec.paths).length} paths)`);
} finally {
  for (const id of created) await c.req("DELETE", `/agents/${id}`).catch(() => {});
}
