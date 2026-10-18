// M6: against compose with real agent computers and scripted fake models: the same task run 3×
// leaves a skill draft (scanned and dry-run); once approved, the 4th run uses it (skill.used);
// a skill with a planted secret is refused (422); memory search, contradiction alerts, and
// export → forget all → import give back an identical memory.json.
import JSZip from "jszip";
import { API, Client, assert, log } from "./client.mjs";

const c = new Client();
await c.signup();

const SKILL_PATH = "/opt/northbot-skills/invoice-summary";
const DRAFT = {
  name: "invoice-summary",
  description: "Summarize this week's invoices from the invoices folder.",
  inputs: [],
  instructions: "Prints the invoices so they can be summarized.",
  script: "cat invoices/a.csv\n",
};
const turn = (command) => ({ toolCalls: [{ name: "terminal", arguments: { command } }] });
const put = await c.req("PUT", "/settings/llm", {
  providers: [
    {
      name: "fast",
      type: "fake",
      kind: "local",
      models: ["m"],
      fake: {
        reply: "{}",
        match: [
          { contains: "You plan work", text: JSON.stringify({ steps: ["read the invoices", "sum them"] }) },
          { contains: "You check an agent", text: JSON.stringify({ summary: "ok", claims: [{ text: "summed", status: "verified", evidence: "cat output" }] }) },
          { contains: "Extract durable facts", text: JSON.stringify({ facts: ["Invoices live in the invoices folder"] }) },
          { contains: "You write reusable skills", text: JSON.stringify(DRAFT) },
        ],
      },
    },
    {
      name: "smart",
      type: "fake",
      kind: "local",
      models: ["m"],
      fake: {
        // By hand until the skill is offered; then through the skill.
        script: [turn("cat invoices/a.csv"), { text: "draft" }, { text: "Total: 30" }],
        match: [{ contains: `${SKILL_PATH}/SKILL.md`, script: [turn(`bash ${SKILL_PATH}/run.sh`), { text: "draft" }, { text: "Total: 30 (with my skill)" }] }],
      },
    },
  ],
  aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
  redactPii: false,
  pricing: {},
  dailyBudgetUsd: null,
});
assert(put.status === 200, `llm settings: ${put.status} ${put.text}`);

const events = async () => (await c.req("GET", "/events?limit=1000")).json.events;
async function waitFor(what, check, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    assert(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const exec = async (a, command) => (await c.req("POST", `/agents/${a.id}/computer/exec`, { command })).json;
/** Runs the invoice task and waits until learning after it (memory + skill drafting) is over. */
async function runTask(a) {
  const r = await c.req("POST", `/agents/${a.id}/tasks`, { goal: "Summarize this week's invoices" });
  assert(r.status === 201, `start task: ${r.status} ${r.text}`);
  const id = r.json.id;
  const task = await waitFor(`task ${id}`, async () => {
    const t = (await c.req("GET", `/tasks/${id}`)).json;
    return ["done", "failed", "blocked", "killed", "waiting_approval"].includes(t.status) ? t : null;
  });
  assert(task.status === "done", `task ended ${task.status}: ${task.error ?? ""}`);
  const learned = await waitFor("learning after the task", async () => (await events()).find((e) => e.type === "task.learned" && e.payload.taskId === id));
  return { task, learned: learned.payload };
}
const memoryJson = async (zip) => (await JSZip.loadAsync(zip)).file("memory.json")?.async("string");
const exportZip = async () => {
  const res = await fetch(`${API}/memory/export`, { headers: { cookie: c.cookie } });
  assert(res.status === 200, `export: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const created = [];
try {
  const r = await c.req("POST", "/agents", { name: "Ledger" });
  assert(r.status === 201, `create agent: ${r.status} ${r.text}`);
  const ledger = r.json;
  created.push(ledger.id);
  const csv = await exec(ledger, "mkdir -p invoices && printf 'client,total\\nacme,10\\nbolt,20\\n' > invoices/a.csv && cat invoices/a.csv");
  assert(csv.exitCode === 0 && csv.stdout.includes("bolt,20"), `could not write invoices: ${JSON.stringify(csv)}`);

  // 1. Three runs of the same work: a skill draft with a scan and a real dry run.
  for (let i = 1; i <= 2; i++) {
    const { learned } = await runTask(ledger);
    assert(!learned.skillDrafted, `drafted a skill after only ${i} run(s)`);
  }
  const third = await runTask(ledger);
  assert(third.learned.skillDrafted && third.learned.reason === "repeated", `no draft after 3 runs: ${JSON.stringify(third.learned)}`);
  const [skill] = (await c.req("GET", "/skills")).json.skills;
  assert(skill?.name === "invoice-summary" && skill.activeVersion === null, `unexpected skill: ${JSON.stringify(skill)}`);
  const draft = skill.versions[0];
  assert(draft.status === "draft" && draft.trigger === "repeated" && draft.rights === "read", `unexpected draft: ${JSON.stringify(draft)}`);
  assert(draft.scan.ok === true, `scan failed: ${JSON.stringify(draft.scan)}`);
  assert(draft.dryRun?.ok === true && draft.dryRun.output.includes("bolt,20"), `dry run: ${JSON.stringify(draft.dryRun)}`);
  assert(draft.files["SKILL.md"].includes("needs_approval: true"), "draft does not ask for approval");
  log(`3 runs → draft "${skill.name}" v1 (rights: ${draft.rights}, scan ok, dry run exit ${draft.dryRun.exitCode} on the real computer)`);

  // 2. Approve; the 4th run uses the skill, installed read-only on the computer.
  const approve = await c.req("POST", `/skills/${skill.id}/versions/1/decide`, { decision: "approve" });
  assert(approve.status === 200, `approve: ${approve.status} ${approve.text}`);
  const fourth = await runTask(ledger);
  assert(fourth.task.report.finalText === "Total: 30 (with my skill)", `4th run did not use the skill: ${fourth.task.report.finalText}`);
  const used = (await events()).filter((e) => e.type === "skill.used" && e.payload.taskId === fourth.task.id);
  assert(used.length === 1, `expected one skill.used, got ${used.length}`);
  const tamper = await exec(ledger, `echo hacked > ${SKILL_PATH}/run.sh`);
  assert(tamper.exitCode !== 0, "the agent could overwrite an approved skill");
  assert((await exec(ledger, `cat ${SKILL_PATH}/run.sh`)).stdout === DRAFT.script, "installed skill script changed");
  log("approved → the 4th run used the skill (skill.used), and the agent cannot change the installed skill");

  // 3. A planted secret is refused.
  const leaky = await c.req("POST", "/skills", {
    files: {
      "SKILL.md": "---\nname: leaky\ndescription: Calls the shop API with a key.\n---\nRun run.sh",
      "run.sh": 'curl -H "Authorization: Bearer sk-live-4fJ8kQ2mZx9PqR7tVw3nYb6c" https://api.shop.test/orders\n',
    },
  });
  assert(leaky.status === 422, `planted secret: expected 422, got ${leaky.status}`);
  assert(leaky.json.findings.some((f) => f.kind === "secret"), `no secret finding: ${leaky.text}`);
  log("a skill with a planted secret was refused (422)");

  // 4. Memory: learned once, searchable by meaning, contradictions raised.
  const facts = (await c.req("GET", `/memory?agentId=${ledger.id}`)).json.facts;
  assert(facts.filter((f) => f.text === "Invoices live in the invoices folder").length === 1, `learned facts: ${JSON.stringify(facts)}`);
  await c.req("POST", "/memory", { text: "The shop closes at 18:00 on weekdays" });
  await c.req("POST", "/memory", { text: "Ana prefers short replies by email", expiresAt: "2031-01-01T00:00:00.000Z" });
  const found = (await c.req("GET", `/memory?q=${encodeURIComponent("what time does the shop close")}`)).json.facts;
  assert(found[0]?.text === "The shop closes at 18:00 on weekdays", `search: ${JSON.stringify(found.map((f) => f.text))}`);
  await c.req("POST", "/memory", { text: "The shop closes at 20:00 on weekdays" });
  assert((await events()).some((e) => e.type === "memory.contradiction"), "no contradiction alert");
  log("memory: learned a fact once, found the right one by meaning, and flagged a contradiction");

  // 5. Export → forget all → import → identical memory.json.
  const before = await exportZip();
  const all = (await c.req("GET", "/memory")).json.facts;
  for (const f of all) await c.req("DELETE", `/memory/${f.id}`);
  assert((await c.req("GET", "/memory")).json.facts.length === 0, "memory not empty after forgetting all");
  const form = new FormData();
  form.append("file", new Blob([before]), "northbot-memory.zip");
  const imp = await fetch(`${API}/memory/import`, { method: "POST", headers: { cookie: c.cookie }, body: form });
  const impBody = await imp.json();
  assert(imp.status === 200 && impBody.count === all.length && impBody.format === "northbot", `import: ${imp.status} ${JSON.stringify(impBody)}`);
  const a = await memoryJson(before);
  const b = await memoryJson(await exportZip());
  assert(a && a === b, "memory.json differs after export → forget → import");
  log(`export → forget all (${all.length}) → import gave back an identical memory.json`);
} finally {
  for (const id of created) await c.req("DELETE", `/agents/${id}`);
}
