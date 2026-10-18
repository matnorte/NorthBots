import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, startTestApp, type TestApp } from "./helpers.js";

const nl = String.fromCharCode(10);
const SKILL = {
  "SKILL.md": ["---", "name: invoice-summary", "description: Summarize this week's invoices from the invoices folder.", "---", "Run run.sh"].join(nl),
  "run.sh": "cat invoices/*.csv" + nl,
};
const call = (name: string, args: Record<string, unknown>) => ({ toolCalls: [{ name, arguments: args }] });

function settings(costPerCallUsd?: number) {
  return {
    providers: [
      {
        name: "fast",
        type: "fake",
        kind: "local",
        models: ["m"],
        fake: {
          reply: "{}",
          ...(costPerCallUsd === undefined ? {} : { costPerCallUsd }),
          match: [
            { contains: "You plan work", text: JSON.stringify({ steps: ["do it"] }) },
            { contains: "You check an agent", text: JSON.stringify({ summary: "ok", claims: [{ text: "done", status: "verified", evidence: "tool output" }] }) },
            { contains: "You coordinate the room", text: JSON.stringify({ speakers: ["Bo"], tasks: [{ agent: "Ana", goal: "Count the mugs in stock" }] }) },
            { contains: "Ask the presenter one short question", text: "Is Acme reliable on delivery?" },
            { contains: "Vote on the question", text: JSON.stringify({ vote: "yes", why: "Acme is cheaper" }) },
            { contains: "You are Cleo. Short comprehension quiz", text: "I was not listening, sorry." },
            { contains: "Short comprehension quiz", text: "We decided yes: switch our mug supplier to Acme, because Acme is cheaper." },
          ],
        },
      },
      {
        name: "smart",
        type: "fake",
        kind: "local",
        models: ["m"],
        fake: {
          ...(costPerCallUsd === undefined ? {} : { costPerCallUsd }),
          script: [{ text: "draft" }, { text: "Done: handled it." }],
          match: [
            { contains: "Reply with one short message as yourself", text: "Happy to help with that." },
            {
              contains: "Prepare a Talk",
              text: JSON.stringify({
                slides: [
                  { title: "Why switch", bullets: ["Acme is 20% cheaper"], notes: "cost first" },
                  { title: "Risks", bullets: ["New supplier"], notes: "" },
                ],
                evidence: [{ claim: "Acme is 20% cheaper", source: "quotes.csv" }],
                recommendation: "Switch our mug supplier to Acme.",
              }),
            },
            { contains: "Answer a question from the audience", text: "Yes, they deliver in 3 days." },
            { contains: "assigned dissenter", text: "Switching suppliers mid-season is risky." },
            { contains: "Reply to the dissenter", text: "We keep the old supplier as a backup for a month." },
            { contains: "Think about selling mugs", script: [call("toss_idea", { title: "Sell branded mugs", reason: "We have no supplier yet", trigger: { kind: "memory", text: "new mug supplier" } }), { text: "draft" }, { text: "Tossed the mug idea." }] },
            { contains: "Ask a coworker about stock", script: [call("send_letter", { type: "question", subject: "Stock", body: "How many mugs are in stock?", to_agent: "Bo" }), { text: "draft" }, { text: "Asked Bo." }] },
          ],
        },
      },
    ],
    aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
    redactPii: false,
    pricing: {},
    dailyBudgetUsd: null,
  };
}

describe("M7: multi-agent", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ TASK_CONFIRM_ABOVE_USD: "1000", BIN_PICKER_INTERVAL_HOURS: "0" });
  });
  afterAll(async () => {
    await t.services.rooms.idle();
    await t.services.talks.idle();
    await t.services.tasks.idle();
    await t.close();
  });

  async function ws(opts: { cost?: number } = {}) {
    const s = await signup(t.app);
    const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: { cookie: s.cookie }, ...(payload ? { payload } : {}) });
    expect((await inject("PUT", "/settings/llm", settings(opts.cost))).statusCode).toBe(200);
    const agent = async (name: string, autonomyLevel = "act_within_limits") => (await inject("POST", "/agents", { name, autonomyLevel })).json() as { id: string; name: string };
    const evs = async () => (await inject("GET", "/events?limit=1000")).json().events as { type: string; agentId: string | null; payload: Record<string, unknown> }[];
    const settle = async () => {
      for (let i = 0; i < 5; i++) {
        await t.services.tasks.idle();
        await t.services.rooms.idle();
        await t.services.talks.idle();
      }
    };
    return { ...s, inject, agent, evs, settle };
  }

  it("routes a letter about invoices to the agent with the invoices skill, and the report comes back as a reply", async () => {
    const w = await ws();
    const ana = await w.agent("Ana");
    const bo = await w.agent("Bo");
    expect((await w.inject("POST", "/skills", { files: SKILL, agentId: ana.id })).statusCode).toBe(201);
    const res = await w.inject("POST", "/letters", { type: "request", subject: "Invoices", body: "Please summarize this week's invoices and tell me the total." });
    expect(res.statusCode).toBe(201);
    const letter = res.json();
    expect(letter.status).toBe("routed");
    expect(letter.toAgentId).toBe(ana.id);
    expect(letter.stamp).toMatchObject({ by: "mail agent", handledBy: ana.id, handledByName: "Ana", lowConfidence: false });
    expect(letter.stamp.confidence).toBeGreaterThanOrEqual(0.5);
    expect(letter.stamp.why).toContain("invoice-summary");
    expect(letter.stamp.candidates.map((c: { agentId: string }) => c.agentId)).toEqual([ana.id, bo.id]);

    await w.settle();
    const done = (await w.inject("GET", `/letters/${letter.id}`)).json();
    expect(done.status).toBe("answered");
    expect(done.replies).toHaveLength(1);
    expect(done.replies[0]).toMatchObject({ type: "fyi", body: "Done: handled it.", from: { kind: "agent", agentId: ana.id }, toAgentId: null });
    expect((await w.evs()).some((e) => e.type === "letter.answered")).toBe(true);
  });

  it("sends an unclear letter to the coordinator, or to a human when there is none", async () => {
    const w = await ws();
    const ana = await w.agent("Ana");
    await w.inject("POST", "/skills", { files: SKILL, agentId: ana.id });
    const boss = await w.agent("Boss");

    const noCoordinator = (await w.inject("POST", "/letters", { type: "request", body: "Could someone water the office plants on Friday?" })).json();
    expect(noCoordinator.status).toBe("needs_human");
    expect(noCoordinator.stamp).toMatchObject({ handledBy: null, lowConfidence: true });
    expect((await w.inject("GET", "/notifications")).json().notifications.some((n: { kind: string }) => n.kind === "letter.needs_human")).toBe(true);
    const assigned = (await w.inject("POST", `/letters/${noCoordinator.id}/assign`, { agentId: boss.id })).json();
    expect(assigned).toMatchObject({ status: "routed", toAgentId: boss.id });

    expect((await w.inject("PATCH", "/settings", { coordinatorAgentId: boss.id })).json().coordinatorAgentId).toBe(boss.id);
    const unclear = (await w.inject("POST", "/letters", { type: "question", body: "Could someone water the office plants on Friday?" })).json();
    expect(unclear).toMatchObject({ status: "routed", toAgentId: boss.id });
    expect(unclear.stamp).toMatchObject({ handledBy: boss.id, lowConfidence: true });
    expect(unclear.stamp.why).toMatch(/coordinator decides/);
    const task = (await w.inject("GET", `/tasks/${unclear.taskId}`)).json();
    expect(task.goal).toMatch(/not sure who should handle this/);
    await w.settle();
  });

  it("lets an agent write a letter from a task; the work it causes starts tainted", async () => {
    const w = await ws();
    const ana = await w.agent("Ana");
    const bo = await w.agent("Bo");
    const id = (await w.inject("POST", `/agents/${ana.id}/tasks`, { goal: "Ask a coworker about stock" })).json().id;
    await w.settle();
    expect((await w.inject("GET", `/tasks/${id}`)).json().status).toBe("done");
    const sent = (await w.inject("GET", "/letters")).json().letters.find((l: { from: { agentId: string | null }; replyToId: string | null }) => l.from.agentId === ana.id && !l.replyToId);
    expect(sent).toMatchObject({ type: "question", toAgentId: bo.id, status: "answered" });
    const [boTask] = (await w.inject("GET", `/agents/${bo.id}/tasks`)).json().tasks;
    expect(boTask.goal).toMatch(/your coworker Ana/);
    const state = (await t.services.db.db.execute(sql`select state->>'tainted' as tainted from tasks where id = ${boTask.id}`)).rows[0] as { tainted: string };
    expect(state.tainted).toBe("true");
    // Bo's answer came back to Ana as a memory.
    const facts = (await w.inject("GET", `/memory?agentId=${ana.id}`)).json().facts;
    expect(facts.some((f: { text: string }) => f.text.startsWith("Re: Stock"))).toBe(true);
  });

  it("keeps tossed ideas in the bin until their trigger fires, then the bin-picker restores them", async () => {
    const w = await ws();
    const ana = await w.agent("Ana");
    await w.inject("POST", `/agents/${ana.id}/tasks`, { goal: "Think about selling mugs" });
    await w.settle();
    const [idea] = (await w.inject("GET", "/ideas")).json().ideas;
    expect(idea).toMatchObject({ title: "Sell branded mugs", status: "binned", agentId: ana.id, triggerText: "when we learn: new mug supplier" });
    const days = (Date.parse(idea.expiresAt) - Date.parse(idea.tossedAt)) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    expect((await w.inject("POST", "/ideas/pick")).json().restored).toEqual([]);
    await w.inject("POST", "/memory", { text: "We signed a new mug supplier: Acme" });
    expect((await w.inject("POST", "/ideas/pick")).json().restored).toEqual([idea.id]);
    const back = (await w.inject("GET", "/ideas?status=restored")).json().ideas[0];
    expect(back).toMatchObject({ id: idea.id, restoredBy: "bin-picker" });
    expect(back.restoreNote).toContain("new mug supplier");

    // Anyone can restore by hand; old ideas expire.
    const manual = (await w.inject("POST", "/ideas", { title: "Weekend pop-up shop", reason: "No staff yet" })).json();
    expect((await w.inject("POST", `/ideas/${manual.id}/restore`, {})).json().restoredBy).toBe(w.me.userId);
    const old = (await w.inject("POST", "/ideas", { title: "Old idea", reason: "meh" })).json();
    await t.services.db.db.execute(sql`update ideas set expires_at = now() - interval '1 day' where id = ${old.id}`);
    expect((await w.inject("POST", "/ideas/pick")).json().expired).toBe(1);
    expect((await w.inject("GET", "/ideas?status=expired")).json().ideas.map((i: { id: string }) => i.id)).toEqual([old.id]);
  });

  it("runs a room: mentions answer, the coordinator picks speakers and fills the board, a human can interrupt", async () => {
    const w = await ws();
    const ana = await w.agent("Ana");
    const bo = await w.agent("Bo");
    const boss = await w.agent("Boss");
    const room = (await w.inject("POST", "/rooms", { name: "Shop", goal: "Run the mug shop", brief: "Mugs only.", agentIds: [ana.id, bo.id], coordinatorAgentId: boss.id })).json();

    await w.inject("POST", `/rooms/${room.id}/messages`, { content: "@Ana what do you think?" });
    await w.settle();
    let view = (await w.inject("GET", `/rooms/${room.id}`)).json();
    const fromAgents = () => view.messages.filter((m: { authorKind: string }) => m.authorKind === "agent");
    expect(fromAgents().map((m: { agentId: string }) => m.agentId)).toEqual([ana.id]);
    expect(view.messages[0].mentions).toEqual([ana.id]);

    await w.inject("POST", `/rooms/${room.id}/messages`, { content: "How is stock looking?" });
    await w.settle();
    view = (await w.inject("GET", `/rooms/${room.id}`)).json();
    expect(view.board).toEqual([expect.objectContaining({ agentId: ana.id, goal: "Count the mugs in stock", status: "done" })]);
    const kinds = view.messages.map((m: { kind: string; agentId: string | null }) => `${m.kind}:${m.agentId === bo.id ? "Bo" : m.agentId === ana.id ? "Ana" : "-"}`);
    expect(kinds).toEqual(expect.arrayContaining(["task:-", "message:Bo", "task:Ana"]));
    expect(view.members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual(["Ana:member", "Bo:member", "Boss:coordinator"]);

    const stop = await w.inject("POST", `/rooms/${room.id}/interrupt`);
    expect(stop.statusCode).toBe(200);
    expect((await w.evs()).some((e) => e.type === "room.interrupted")).toBe(true);
  });

  it("stops a room at its cost cap", async () => {
    const w = await ws({ cost: 0.3 });
    const ana = await w.agent("Ana");
    const bo = await w.agent("Bo");
    const room = (await w.inject("POST", "/rooms", { name: "Pricey", agentIds: [ana.id, bo.id], turnRule: "mentions", costCapUsd: 0.5 })).json();
    await w.inject("POST", `/rooms/${room.id}/messages`, { content: "@Ana @Bo hello" });
    await w.settle();
    await w.inject("POST", `/rooms/${room.id}/messages`, { content: "@Ana again?" });
    await w.settle();
    const view = (await w.inject("GET", `/rooms/${room.id}`)).json();
    expect(view.messages.filter((m: { authorKind: string }) => m.authorKind === "agent")).toHaveLength(2);
    expect(view.messages.at(-1).content).toMatch(/cost cap/);
    expect(view.spentUsd).toBeCloseTo(0.6);
    expect((await w.evs()).filter((e) => e.type === "room.cap_reached")).toHaveLength(1);
  });

  it("runs a full Talk to a decision record and updates the memory of the listeners who understood it", async () => {
    const w = await ws();
    const pia = await w.agent("Pia");
    const ana = await w.agent("Ana");
    const bo = await w.agent("Bo");
    const cleo = await w.agent("Cleo");
    const res = await w.inject("POST", "/talks", {
      title: "Mug supplier",
      question: "Should we switch our mug supplier to Acme?",
      presenterAgentId: pia.id,
      audience: [ana.id, bo.id, cleo.id],
      dissenterAgentId: bo.id,
    });
    expect(res.statusCode).toBe(201);
    await w.settle();
    const talk = (await w.inject("GET", `/talks/${res.json().id}`)).json();
    expect(talk.stage).toBe("done");
    expect(talk.deck.slides).toHaveLength(2);
    expect(talk.qa).toHaveLength(3);
    expect(talk.qa.every((q: { answer: string | null }) => q.answer === "Yes, they deliver in 3 days.")).toBe(true);
    expect(talk.challenge).toMatchObject({ by: bo.id, objection: "Switching suppliers mid-season is risky." });
    expect(talk.decision).toMatchObject({
      decision: "Yes: Should we switch our mug supplier to Acme?",
      outcome: "yes",
      tally: { yes: 3, no: 0, abstain: 0 },
      presenter: "Pia",
      recommendation: "Switch our mug supplier to Acme.",
      dissent: "Switching suppliers mid-season is risky.",
      evidence: [{ claim: "Acme is 20% cheaper", source: "quotes.csv" }],
      decidedBy: "vote",
    });
    const room = (await w.inject("GET", `/rooms/${talk.roomId}`)).json();
    expect(room.kind).toBe("talk");
    const stages = room.messages.map((m: { kind: string }) => m.kind);
    expect(stages.indexOf("slide")).toBeLessThan(stages.indexOf("question"));
    expect(stages.indexOf("challenge")).toBeLessThan(stages.indexOf("vote"));
    expect(stages.indexOf("vote")).toBeLessThan(stages.indexOf("decision"));

    // Ana and Bo passed the quiz and remember the decision with a source link; Cleo did not.
    const remembered = async (id: string) => (await w.inject("GET", `/memory?agentId=${id}`)).json().facts.filter((f: { source: string }) => f.source === `talk ${talk.id}`);
    for (const a of [ana, bo]) expect(await remembered(a.id)).toEqual([expect.objectContaining({ text: expect.stringContaining('Talk "Mug supplier" decided: Yes') })]);
    expect(await remembered(cleo.id)).toEqual([]);
    const learned = (await w.evs()).filter((e) => e.type === "talk.learned");
    expect(learned.map((e) => [e.agentId, e.payload.passed])).toEqual([
      [ana.id, true],
      [bo.id, true],
      [cleo.id, false],
    ]);
    // The source link: the fact points at the talk.decided event.
    const [fact] = await remembered(ana.id);
    const decided = (await w.evs()).find((e) => e.type === "talk.decided") as { id?: number } | undefined;
    expect(fact.sourceEventId).toBe(talk.decision.eventId);
    expect(decided?.id).toBe(talk.decision.eventId);
  });

  it("waits for a human when the Talk is decided by a person", async () => {
    const w = await ws();
    const pia = await w.agent("Pia");
    const ana = await w.agent("Ana");
    const created = (await w.inject("POST", "/talks", { title: "Prices", question: "Should we raise mug prices?", presenterAgentId: pia.id, audience: [ana.id], decisionMode: "human" })).json();
    await w.settle();
    expect((await w.inject("GET", `/talks/${created.id}`)).json()).toMatchObject({ stage: "decide", decision: null });
    expect((await w.inject("POST", `/talks/${created.id}/decide`, { decision: "No, keep prices", rationale: "Sales are new." })).statusCode).toBe(200);
    await w.settle();
    const talk = (await w.inject("GET", `/talks/${created.id}`)).json();
    expect(talk).toMatchObject({ stage: "done", decision: { decision: "No, keep prices", outcome: "human", decidedBy: `human:${w.me.userId}` } });
  });
});
