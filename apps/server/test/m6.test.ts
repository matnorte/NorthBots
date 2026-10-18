import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, startTestApp, type TestApp } from "./helpers.js";

const SKILL_PATH = "/opt/northbot-skills/invoice-summary";
const DRAFT = {
  name: "invoice-summary",
  description: "Summarize this week's invoices from the invoices folder.",
  inputs: [],
  instructions: "Prints the invoices so they can be summarized.",
  script: "cat invoices/a.csv\n",
};

function settings() {
  const turn = (command: string) => ({ toolCalls: [{ name: "terminal", arguments: { command } }] });
  return {
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
          // Without the skill: do it by hand. When the skill is offered: use it.
          script: [turn("cat invoices/a.csv"), { text: "draft" }, { text: "Total: 30" }],
          match: [{ contains: `${SKILL_PATH}/SKILL.md`, script: [turn(`bash ${SKILL_PATH}/run.sh`), { text: "draft" }, { text: "Total: 30 (with my skill)" }] }],
        },
      },
    ],
    aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
    redactPii: false,
    pricing: {},
    dailyBudgetUsd: null,
  };
}

describe("M6: memory and skills", () => {
  let t: TestApp;
  let base: string;
  beforeAll(async () => {
    t = await startTestApp({ TASK_CONFIRM_ABOVE_USD: "1000" });
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await t.services.tasks.idle();
    await t.close();
  });

  async function ws() {
    const s = await signup(t.app);
    const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: { cookie: s.cookie }, ...(payload ? { payload } : {}) });
    await inject("PUT", "/settings/llm", settings());
    const evs = async () => (await inject("GET", "/events?limit=1000")).json().events as { type: string; payload: Record<string, unknown> }[];
    return { ...s, inject, evs };
  }

  it("searches memory by meaning and alerts on contradictions", async () => {
    const w = await ws();
    await w.inject("POST", "/memory", { text: "The shop closes at 18:00 on weekdays" });
    await w.inject("POST", "/memory", { text: "Ana prefers short replies by email" });
    const found = (await w.inject("GET", "/memory?q=what%20time%20does%20the%20shop%20close")).json().facts;
    expect(found[0].text).toBe("The shop closes at 18:00 on weekdays");
    await w.inject("POST", "/memory", { text: "The shop closes at 20:00 on weekdays" });
    expect((await w.evs()).some((e) => e.type === "memory.contradiction")).toBe(true);
    expect((await w.inject("GET", "/notifications")).json().notifications[0].body).toMatch(/Two memories disagree/);
  });

  it("forgets a fact and everything derived only from it", async () => {
    const w = await ws();
    const a = await t.services.memory.add({ workspaceId: w.me.workspaceId, agentId: null, text: "Supplier is Acme" });
    const b = await t.services.memory.add({ workspaceId: w.me.workspaceId, agentId: null, text: "Order mugs from Acme", derivedFrom: [a.id] });
    const c = await t.services.memory.add({ workspaceId: w.me.workspaceId, agentId: null, text: "Reorder when stock < 5", derivedFrom: [b.id] });
    const keep = await t.services.memory.add({ workspaceId: w.me.workspaceId, agentId: null, text: "Mugs cost 10", derivedFrom: [a.id, "00000000-0000-4000-8000-0000000000aa"] });
    const res = await w.inject("DELETE", `/memory/${a.id}`);
    expect(res.json().forgotten.sort()).toEqual([a.id, b.id, c.id].sort());
    const left = (await w.inject("GET", "/memory")).json().facts.map((f: { id: string }) => f.id);
    expect(left).toEqual([keep.id]);
  });

  it("export then import restores memory exactly", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Memo" })).json();
    const a = await t.services.memory.add({ workspaceId: w.me.workspaceId, agentId: null, text: "Shared fact one" });
    await t.services.memory.add({ workspaceId: w.me.workspaceId, agentId: agent.id, text: "Private fact", derivedFrom: [a.id], expiresAt: new Date("2030-01-01T00:00:00Z") });
    const exportZip = async () => Buffer.from(await (await fetch(`${base}/memory/export`, { headers: { cookie: w.cookie } })).arrayBuffer());
    const before = await exportZip();
    for (const f of (await w.inject("GET", "/memory")).json().facts) await w.inject("DELETE", `/memory/${f.id}`);
    expect((await w.inject("GET", "/memory")).json().facts).toEqual([]);

    const form = new FormData();
    form.append("file", new Blob([before]), "northbot-memory.zip");
    const imp = await fetch(`${base}/memory/import`, { method: "POST", headers: { cookie: w.cookie }, body: form });
    expect(await imp.json()).toEqual({ count: 2, format: "northbot" });
    const json = async (zip: Buffer) => (await JSZip.loadAsync(zip)).file("memory.json")?.async("string");
    expect(await json(await exportZip())).toBe(await json(before));
  });

  it("learns from a task, drafts a skill after 3 repeats, and uses it on the 4th run once approved", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Ledger" })).json();
    await t.sandbox.writeFile(agent.sandboxId, "invoices/a.csv", Buffer.from("client,total\nacme,10\nbolt,20\n"));
    const run = async () => {
      const id = (await w.inject("POST", `/agents/${agent.id}/tasks`, { goal: "Summarize this week's invoices" })).json().id;
      await t.services.tasks.idle();
      return (await w.inject("GET", `/tasks/${id}`)).json();
    };

    for (let i = 0; i < 2; i++) expect((await run()).status).toBe("done");
    expect((await w.inject("GET", "/skills")).json().skills).toEqual([]);
    expect((await run()).status).toBe("done");

    const [skill] = (await w.inject("GET", "/skills")).json().skills;
    expect(skill).toMatchObject({ name: "invoice-summary", activeVersion: null });
    expect(skill.versions[0]).toMatchObject({ status: "draft", trigger: "repeated", rights: "read", createdBy: "agent" });
    expect(skill.versions[0].dryRun).toMatchObject({ ok: true });
    expect(skill.versions[0].files["SKILL.md"]).toContain("needs_approval: true");
    expect(skill.versions[0].diff).toContain("+++ run.sh (new)");
    // It also remembered something lasting, once.
    const facts = (await w.inject("GET", `/memory?agentId=${agent.id}&scope=all`)).json().facts;
    expect(facts.filter((f: { text: string }) => f.text === "Invoices live in the invoices folder")).toHaveLength(1);

    await w.inject("POST", `/skills/${skill.id}/versions/1/decide`, { decision: "approve" });
    const fourth = await run();
    expect(fourth.status).toBe("done");
    expect(fourth.report.finalText).toBe("Total: 30 (with my skill)");
    const evs = await w.evs();
    expect(evs.filter((e) => e.type === "skill.used" && e.payload.taskId === fourth.id)).toHaveLength(1);
    // The skill ran as a read (its audited rights): no approval was needed at ask_first.
    expect((await w.inject("GET", "/approvals")).json().approvals).toEqual([]);
    expect((await t.sandbox.exec(agent.sandboxId, `echo hacked > ${SKILL_PATH}/run.sh`)).exitCode).toBe(1);
  });

  it("rejects a skill with a planted secret", async () => {
    const w = await ws();
    const files = {
      "SKILL.md": "---\nname: leaky\ndescription: Calls the shop API with a key.\n---\nRun run.sh",
      "run.sh": 'curl -H "Authorization: Bearer sk-live-4fJ8kQ2mZx9PqR7tVw3nYb6c" https://api.shop.test/orders\n',
    };
    const res = await w.inject("POST", "/skills", { files });
    expect(res.statusCode).toBe(422);
    expect(res.json().findings.map((f: { kind: string }) => f.kind)).toContain("secret");
    expect((await w.evs()).some((e) => e.type === "skill.rejected")).toBe(true);
  });

  it("also catches a vault secret pasted into a skill", async () => {
    const w = await ws();
    await w.inject("PUT", "/vault/secrets", { name: "SHOP_PASS", value: "plain-words-pass" });
    const files = { "SKILL.md": "---\nname: shop-login\ndescription: Logs in to the shop admin.\n---\nRun run.sh", "run.sh": "echo plain-words-pass | shop-cli login\n" };
    expect((await w.inject("POST", "/skills", { files })).statusCode).toBe(422);
  });

  it("drafts a skill from a demonstrated task, and versions can be rolled back", async () => {
    const w = await ws();
    const agent = (await w.inject("POST", "/agents", { name: "Teach" })).json();
    await t.sandbox.writeFile(agent.sandboxId, "invoices/a.csv", Buffer.from("x,1\n"));
    const id = (await w.inject("POST", `/agents/${agent.id}/tasks`, { goal: "Summarize this week's invoices" })).json().id;
    await t.services.tasks.idle();
    const taught = (await w.inject("POST", "/skills/teach", { taskId: id })).json();
    expect(taught).toMatchObject({ drafted: true, reason: "demonstrated", version: 1 });
    await w.inject("POST", `/skills/${taught.skillId}/versions/1/decide`, { decision: "approve" });
    const edited = { "SKILL.md": "---\nname: invoice-summary\ndescription: Summarize invoices, edited by a human.\n---\nRun run.sh", "run.sh": "cat invoices/a.csv\n" };
    const second = await w.inject("POST", "/skills", { files: edited });
    expect(second.json().version).toBe(2);
    // The description follows the active version.
    expect((await w.inject("GET", "/skills")).json().skills[0]).toMatchObject({ activeVersion: 2, description: "Summarize invoices, edited by a human." });
    expect((await w.inject("POST", `/skills/${taught.skillId}/rollback`, { version: 1 })).json()).toEqual({ ok: true });
    expect((await w.inject("GET", "/skills")).json().skills[0]).toMatchObject({ activeVersion: 1, description: DRAFT.description });
  });
});
