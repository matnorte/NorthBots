// M7: against compose with real agent computers and scripted fake models: a letter about
// invoices is routed to the agent holding the invoices skill; a low-confidence letter goes to the
// coordinator; a tossed idea is restored by the bin-picker when its trigger fires; a room runs on
// mentions and its coordinator; a full Talk produces a decision record and updates two listeners'
// memory.
import { Client, assert, log } from "./client.mjs";

const c = new Client();
await c.signup();

const nl = String.fromCharCode(10);
const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] });
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
          { contains: "You plan work", text: JSON.stringify({ steps: ["do it"] }) },
          { contains: "You check an agent", text: JSON.stringify({ summary: "ok", claims: [{ text: "done", status: "verified", evidence: "tool output" }] }) },
          { contains: "You coordinate the room", text: JSON.stringify({ speakers: ["Bo"], tasks: [{ agent: "Ana", goal: "List the files in your home folder" }] }) },
          { contains: "Ask the presenter one short question", text: "Is Acme reliable on delivery?" },
          { contains: "Vote on the question", text: JSON.stringify({ vote: "yes", why: "Acme is cheaper" }) },
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
        script: [call("terminal", { command: "ls" }), { text: "draft" }, { text: "Done: handled it on my computer." }],
        match: [
          { contains: "Reply with one short message as yourself", text: "Happy to help with that." },
          {
            contains: "Prepare a Talk",
            text: JSON.stringify({
              slides: [
                { title: "Why switch", bullets: ["Acme is 20% cheaper"], notes: "cost first" },
                { title: "Risks", bullets: ["A new supplier"], notes: "" },
              ],
              evidence: [{ claim: "Acme is 20% cheaper", source: "quotes.csv" }],
              recommendation: "Switch our mug supplier to Acme.",
            }),
          },
          { contains: "Answer a question from the audience", text: "Yes, they deliver in 3 days." },
          { contains: "assigned dissenter", text: "Switching suppliers mid-season is risky." },
          { contains: "Reply to the dissenter", text: "We keep the old supplier as a backup for a month." },
          {
            contains: "Think about selling mugs",
            script: [call("toss_idea", { title: "Sell branded mugs", reason: "We have no supplier yet", trigger: { kind: "memory", text: "new mug supplier" } }), { text: "draft" }, { text: "Tossed the mug idea." }],
          },
        ],
      },
    },
  ],
  aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
  redactPii: false,
  pricing: {},
  dailyBudgetUsd: null,
});
assert(put.status === 200, `llm settings: ${put.status} ${put.text}`);

async function waitFor(what, check, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    assert(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const events = async () => (await c.req("GET", "/events?limit=1000")).json.events;
const created = [];
async function agent(name) {
  const r = await c.req("POST", "/agents", { name, autonomyLevel: "act_within_limits" });
  assert(r.status === 201, `create ${name}: ${r.status} ${r.text}`);
  created.push(r.json.id);
  return r.json;
}

try {
  const [ana, bo, boss, pia] = [await agent("Ana"), await agent("Bo"), await agent("Boss"), await agent("Pia")];
  const skill = await c.req("POST", "/skills", {
    agentId: ana.id,
    files: {
      "SKILL.md": ["---", "name: invoice-summary", "description: Summarize this week's invoices from the invoices folder.", "---", "Run run.sh"].join(nl),
      "run.sh": `cat invoices/*.csv${nl}`,
    },
  });
  assert(skill.status === 201, `skill: ${skill.status} ${skill.text}`);

  // 1. A letter about invoices goes to the agent holding the invoices skill; the report comes back.
  const letter = await c.req("POST", "/letters", { type: "request", subject: "Invoices", body: "Please summarize this week's invoices and tell me the total." });
  assert(letter.status === 201, `letter: ${letter.status} ${letter.text}`);
  const stamp = letter.json.stamp;
  assert(letter.json.toAgentId === ana.id && stamp.handledBy === ana.id && !stamp.lowConfidence, `misrouted: ${JSON.stringify(stamp)}`);
  log(`letter about invoices → ${stamp.handledByName} (confidence ${stamp.confidence}): ${stamp.why}`);
  const answered = await waitFor("the reply letter", async () => {
    const l = (await c.req("GET", `/letters/${letter.json.id}`)).json;
    return l.status === "answered" ? l : null;
  });
  assert(answered.replies[0]?.body === "Done: handled it on my computer.", `reply: ${JSON.stringify(answered.replies)}`);
  assert((await events()).some((e) => e.type === "terminal.exec" && e.agentId === ana.id), "Ana never used her computer");
  log("Ana worked on her real computer and her report came back as a reply letter");

  // 2. A letter nobody clearly fits goes to the coordinator.
  const set = await c.req("PATCH", "/settings", { coordinatorAgentId: boss.id });
  assert(set.json.coordinatorAgentId === boss.id, "could not set the coordinator");
  const unclear = await c.req("POST", "/letters", { type: "question", body: "Could someone water the office plants on Friday?" });
  assert(unclear.json.toAgentId === boss.id && unclear.json.stamp.lowConfidence === true, `low-confidence letter: ${JSON.stringify(unclear.json.stamp)}`);
  log(`low-confidence letter → coordinator ${unclear.json.stamp.handledByName} (confidence ${unclear.json.stamp.confidence})`);

  // 3. An agent tosses an idea from a task; the bin-picker restores it once the trigger fires.
  const toss = await c.req("POST", `/agents/${pia.id}/tasks`, { goal: "Think about selling mugs" });
  assert(toss.status === 201, `toss task: ${toss.status} ${toss.text}`);
  const idea = await waitFor("the tossed idea", async () => (await c.req("GET", "/ideas?status=binned")).json.ideas.find((i) => i.title === "Sell branded mugs"));
  assert(idea.agentId === pia.id && idea.triggerText === "when we learn: new mug supplier", `idea: ${JSON.stringify(idea)}`);
  let picked = (await c.req("POST", "/ideas/pick")).json;
  assert(!picked.restored.includes(idea.id), "restored before its trigger fired");
  await c.req("POST", "/memory", { text: "We signed a new mug supplier: Acme" });
  picked = (await c.req("POST", "/ideas/pick")).json;
  assert(picked.restored.includes(idea.id), `bin-picker did not restore it: ${JSON.stringify(picked)}`);
  const back = (await c.req("GET", "/ideas?status=restored")).json.ideas.find((i) => i.id === idea.id);
  assert(back?.restoredBy === "bin-picker", `restored by ${back?.restoredBy}`);
  log(`Pia tossed "${idea.title}"; the bin-picker restored it: ${back.restoreNote}`);

  // 4. A room: a mention answers; without one, the coordinator picks a speaker and fills the board.
  const room = (await c.req("POST", "/rooms", { name: "Shop", goal: "Run the mug shop", agentIds: [ana.id, bo.id], coordinatorAgentId: boss.id })).json;
  await c.req("POST", `/rooms/${room.id}/messages`, { content: "@Ana what do you think?" });
  await c.req("POST", `/rooms/${room.id}/messages`, { content: "How is stock looking?" });
  const view = await waitFor("the room to settle", async () => {
    const v = (await c.req("GET", `/rooms/${room.id}`)).json;
    const said = v.messages.filter((m) => m.authorKind === "agent" && m.kind === "message").map((m) => m.agentId);
    return said.includes(ana.id) && said.includes(bo.id) && v.board[0]?.status === "done" ? v : null;
  });
  assert(view.board.length === 1 && view.board[0].agentId === ana.id, `board: ${JSON.stringify(view.board)}`);
  log(`room: @Ana answered, the coordinator picked Bo and put "${view.board[0].goal}" on the board for Ana (done)`);

  // 5. A full Talk: decision record, and two listeners remember it.
  const talk = await c.req("POST", "/talks", {
    title: "Mug supplier",
    question: "Should we switch our mug supplier to Acme?",
    presenterAgentId: pia.id,
    audience: [ana.id, bo.id],
    dissenterAgentId: bo.id,
  });
  assert(talk.status === 201, `talk: ${talk.status} ${talk.text}`);
  const done = await waitFor("the Talk to finish", async () => {
    const t = (await c.req("GET", `/talks/${talk.json.id}`)).json;
    assert(t.stage !== "stopped", `Talk stopped: ${t.error}`);
    return t.stage === "done" ? t : null;
  });
  const d = done.decision;
  assert(d.decision === "Yes: Should we switch our mug supplier to Acme?" && d.tally.yes === 2 && d.dissent && d.evidence.length === 1, `decision: ${JSON.stringify(d)}`);
  for (const a of [ana, bo]) {
    const facts = (await c.req("GET", `/memory?agentId=${a.id}`)).json.facts.filter((f) => f.source === `talk ${done.id}`);
    assert(facts.length === 1 && facts[0].sourceEventId === d.eventId, `${a.name} memory: ${JSON.stringify(facts)}`);
  }
  log(`Talk: ${done.deck.slides.length} slides, ${done.qa.length} questions, a challenge, votes ${d.tally.yes}-${d.tally.no} → "${d.decision}"; Ana and Bo remember it (linked to event #${d.eventId})`);
} finally {
  await c.req("PATCH", "/settings", { coordinatorAgentId: null });
  for (const id of created) await c.req("DELETE", `/agents/${id}`);
}
