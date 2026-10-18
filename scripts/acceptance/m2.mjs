// M2: with fake providers, the official openai client talks to /v1; killing provider A falls
// back to B; a $0.01 cap stops the second call; a sensitive call is refused for a cloud provider.
import OpenAI from "openai";
import { API, Client, assert, log } from "./client.mjs";

const settings = (over = {}) => ({
  providers: [
    { name: "fake-a", type: "fake", kind: "cloud", models: ["m"], fake: { down: over.aDown ?? false, reply: "hello from A", costPerCallUsd: 0.012 } },
    { name: "fake-b", type: "fake", kind: "local", models: ["m"], fake: { reply: "hello from B" } },
  ],
  aliases: { "northbot-fast": ["fake-a/m", "fake-b/m"], "cloud-only": ["fake-a/m"] },
  redactPii: true,
  pricing: {},
  dailyBudgetUsd: over.dailyBudgetUsd ?? null,
});

async function workspace(over) {
  const c = new Client();
  await c.signup();
  const put = await c.req("PUT", "/settings/llm", settings(over));
  assert(put.status === 200, `put llm settings: ${put.status} ${put.text}`);
  const k = await c.req("POST", "/settings/api-keys", { name: "acceptance" });
  assert(k.status === 201, `create api key: ${k.status} ${k.text}`);
  return { c, openai: new OpenAI({ apiKey: k.json.key, baseURL: `${API}/v1`, maxRetries: 0 }) };
}

const ask = (model = "northbot-fast", content = "hi") => ({ model, messages: [{ role: "user", content }] });

// 1. The official client works, streaming too.
const w = await workspace();
const r1 = await w.openai.chat.completions.create(ask());
assert(r1.choices[0].message.content === "hello from A", `unexpected reply: ${JSON.stringify(r1)}`);
let streamed = "";
for await (const chunk of await w.openai.chat.completions.create({ ...ask(), stream: true })) {
  streamed += chunk.choices[0]?.delta?.content ?? "";
}
assert(streamed === "hello from A", `unexpected stream: ${streamed}`);
log("chat completion (plain and streaming) works through the openai npm client");

// 2. Kill provider A: the alias falls back to B.
await w.c.req("PUT", "/settings/llm", settings({ aDown: true }));
const r2 = await w.openai.chat.completions.create(ask());
assert(r2.choices[0].message.content === "hello from B", `no fallback: ${JSON.stringify(r2)}`);
log("killing provider A falls back to B");

// 3. $0.01 daily cap: first call costs $0.012, the second is refused clearly.
const b = await workspace({ dailyBudgetUsd: 0.01 });
await b.openai.chat.completions.create(ask("northbot-fast", "first"));
let budgetErr = null;
try {
  await b.openai.chat.completions.create(ask("northbot-fast", "second"));
} catch (e) {
  budgetErr = e;
}
assert(budgetErr instanceof OpenAI.APIError && budgetErr.status === 402, `expected 402, got ${budgetErr}`);
assert(/Budget cap reached/.test(budgetErr.message), `unclear budget error: ${budgetErr.message}`);
log(`budget cap stopped the second call: "${budgetErr.message.slice(0, 80)}..."`);

// 4. A sensitive-tagged call is refused for a non-local provider.
let privacyErr = null;
try {
  await w.openai.chat.completions.create(ask("cloud-only"), { headers: { "x-northbot-privacy": "sensitive" } });
} catch (e) {
  privacyErr = e;
}
assert(privacyErr instanceof OpenAI.APIError && privacyErr.status === 403, `expected 403, got ${privacyErr}`);
log("sensitive call refused for a cloud provider");
