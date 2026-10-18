import { describe, expect, it, vi } from "vitest";
import {
  AllProvidersFailedError,
  BudgetExceededError,
  NoProviderError,
  PrivacyError,
  Router,
  RouterConfig,
  type CallContext,
  type CallRecord,
  type StreamEvent,
} from "../src/index.js";

const ctx: CallContext = { workspaceId: "w1", privacy: "normal" };

function config(overrides: Partial<Record<"aDown" | "bDown", boolean>> = {}, extra: Partial<RouterConfig> = {}) {
  return RouterConfig.parse({
    providers: [
      { name: "a", type: "fake", kind: "cloud", models: ["m"], fake: { down: overrides.aDown ?? false, reply: "from A", costPerCallUsd: 0.006 } },
      { name: "b", type: "fake", kind: "local", models: ["m"], fake: { down: overrides.bDown ?? false, reply: "from B" } },
    ],
    aliases: { chain: ["a/m", "b/m"] },
    ...extra,
  });
}

const ask = (model = "chain") => ({ model, messages: [{ role: "user" as const, content: "hi" }] });

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("Router", () => {
  it("answers from the first target and reports cost", async () => {
    const r = await new Router(config()).chat(ask(), ctx);
    expect(r).toMatchObject({ text: "from A", provider: "a", alias: "chain", costUsd: 0.006, fallbacks: [] });
  });

  it("falls back to B when A is killed, and records both attempts", async () => {
    const calls: CallRecord[] = [];
    const r = await new Router(config({ aDown: true }), { onCall: async (c) => void calls.push(c) }).chat(ask(), ctx);
    expect(r.text).toBe("from B");
    expect(r.fallbacks[0]?.provider).toBe("a");
    expect(calls.map((c) => [c.provider, c.ok])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("fails clearly when every target is down", async () => {
    await expect(new Router(config({ aDown: true, bDown: true })).chat(ask(), ctx)).rejects.toBeInstanceOf(
      AllProvidersFailedError,
    );
  });

  it("routes provider/model and bare model names, and rejects unknown ones", async () => {
    const router = new Router(config());
    expect((await router.chat(ask("b/m"), ctx)).provider).toBe("b");
    expect((await router.chat(ask("m"), ctx)).provider).toBe("a");
    await expect(router.chat(ask("nope"), ctx)).rejects.toBeInstanceOf(NoProviderError);
  });

  it("sends sensitive calls only to local providers", async () => {
    const router = new Router(config());
    const r = await router.chat(ask(), { ...ctx, privacy: "sensitive" });
    expect(r.provider).toBe("b");
    await expect(router.chat(ask("a/m"), { ...ctx, privacy: "sensitive" })).rejects.toBeInstanceOf(PrivacyError);
  });

  it("checks the budget before calling any provider", async () => {
    const onCall = vi.fn();
    const budget = { check: async () => Promise.reject(new BudgetExceededError("workspace day", 0.01, 0.012)) };
    await expect(new Router(config(), { budget, onCall }).chat(ask(), ctx)).rejects.toThrow(/Budget cap reached/);
    expect(onCall).not.toHaveBeenCalled();
  });

  it("skips providers whose vault key is missing", async () => {
    const cfg = RouterConfig.parse({
      providers: [
        { name: "oa", type: "openai", kind: "cloud", keySecret: "OPENAI_API_KEY", models: ["gpt"] },
        { name: "b", type: "fake", kind: "local", models: ["m"], fake: { reply: "local" } },
      ],
      aliases: { x: ["oa/gpt", "b/m"] },
    });
    const r = await new Router(cfg, { resolveKey: async () => undefined }).chat(ask("x"), ctx);
    expect(r.text).toBe("local");
    expect(r.fallbacks[0]).toMatchObject({ provider: "oa", error: "no API key in the vault" });
  });

  it("redacts PII for cloud providers and restores it in the reply", async () => {
    const seen: string[] = [];
    const cfg = config();
    const router = new Router(cfg, {
      providers: {
        a: {
          name: "a",
          kind: "cloud",
          chat: async (_m, req) => {
            seen.push(req.messages.map((m) => m.content).join(" "));
            return { text: "I will email [EMAIL_1]", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
          },
          stream: () => {
            throw new Error("unused");
          },
        },
      },
    });
    const r = await router.chat({ model: "a/m", messages: [{ role: "user", content: "write to bia@shop.com" }] }, ctx);
    expect(seen[0]).toBe("write to [EMAIL_1]");
    expect(r.text).toBe("I will email bia@shop.com");
  });

  it("does not redact for local providers", async () => {
    const r = await new Router(config(), {}).chat({ model: "b/m", messages: [{ role: "user", content: "x@y.io" }] }, ctx);
    expect(r.provider).toBe("b");
  });

  it("streams text and a final result, falling back before the first chunk", async () => {
    const events = await collect(new Router(config({ aDown: true })).stream(ask(), ctx));
    const text = events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
    const done = events.at(-1);
    expect(text).toBe("from B");
    expect(done?.type === "done" && done.result.provider).toBe("b");
  });

  it("replays a scripted multi-step run with tool calls", async () => {
    const cfg = RouterConfig.parse({
      providers: [
        {
          name: "f",
          type: "fake",
          kind: "local",
          models: ["m"],
          fake: { script: [{ toolCalls: [{ name: "terminal", arguments: { command: "ls" } }] }, { text: "done" }] },
        },
      ],
      aliases: {},
    });
    const router = new Router(cfg);
    const first = await router.chat(ask("f/m"), ctx);
    expect(first.finishReason).toBe("tool_calls");
    expect(JSON.parse(first.toolCalls[0]?.arguments ?? "")).toEqual({ command: "ls" });
    const second = await router.chat(
      {
        model: "f/m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", toolCalls: first.toolCalls },
          { role: "tool", toolCallId: first.toolCalls[0]?.id ?? "", content: "a.txt" },
        ],
      },
      ctx,
    );
    expect(second.text).toBe("done");
  });
});
