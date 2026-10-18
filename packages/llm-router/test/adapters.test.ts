import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAIProvider,
  ProviderError,
  Router,
  RouterConfig,
  type ChatRequest,
  type ProviderChunk,
} from "../src/index.js";
import { json, mockServer, sse } from "./mock-server.js";

const req: ChatRequest = {
  model: "x",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ],
  temperature: 0.2,
  tools: [{ name: "terminal", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } }],
};

async function drain(it: AsyncIterable<ProviderChunk>) {
  const chunks: ProviderChunk[] = [];
  for await (const c of it) chunks.push(c);
  return chunks;
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe("OpenAI adapter", () => {
  it("maps messages, tools and tool calls", async () => {
    const s = await mockServer((_r, res) =>
      json(res, {
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "t1", type: "function", function: { name: "terminal", arguments: '{"command":"ls"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }),
    );
    close = s.close;
    const p = new OpenAIProvider("oa", "cloud", `${s.url}/v1`, true);
    const r = await p.chat("gpt-test", req, { apiKey: "sk-test" });
    expect(r).toMatchObject({ finishReason: "tool_calls", usage: { inputTokens: 12, outputTokens: 5 } });
    expect(r.toolCalls[0]).toEqual({ id: "t1", name: "terminal", arguments: '{"command":"ls"}' });
    const body = s.requests[0]?.body ?? {};
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ]);
    expect(body.temperature).toBe(0.2);
    expect(s.requests[0]?.headers.authorization).toBe("Bearer sk-test");
  });

  it("streams text deltas and usage", async () => {
    const chunk = (delta: object, extra: object = {}) => ({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    });
    const s = await mockServer((_r, res) =>
      sse(
        res,
        [
          { data: chunk({ role: "assistant", content: "Hel" }) },
          { data: chunk({ content: "lo" }) },
          { data: { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } },
        ],
        true,
      ),
    );
    close = s.close;
    const chunks = await drain(new OpenAIProvider("oc", "local", `${s.url}/v1`, false).stream("m", req, {}));
    expect(chunks.filter((c) => c.type === "text").map((c) => c.type === "text" && c.text)).toEqual(["Hel", "lo"]);
    const done = chunks.at(-1);
    expect(done?.type === "done" && done.result).toMatchObject({ text: "Hello", usage: { inputTokens: 3, outputTokens: 2 } });
    expect(s.requests[0]?.body.stream).toBe(true);
  });

  it("raises ProviderError when the server is unreachable, so the router falls back", async () => {
    const dead = new OpenAIProvider("dead", "local", "http://127.0.0.1:9/v1", false);
    await expect(dead.chat("m", req, {})).rejects.toBeInstanceOf(ProviderError);

    const cfg = RouterConfig.parse({
      providers: [
        { name: "dead", type: "openai-compatible", kind: "local", baseUrl: "http://127.0.0.1:9/v1", models: ["m"] },
        { name: "fake", type: "fake", kind: "local", models: ["m"], fake: { reply: "rescued" } },
      ],
      aliases: { a: ["dead/m", "fake/m"] },
    });
    const r = await new Router(cfg).chat({ ...req, model: "a" }, { workspaceId: "w", privacy: "normal" });
    expect(r.text).toBe("rescued");
  });
});

const anthropicMessage = (content: unknown[], stop = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 },
});

describe("Anthropic adapter", () => {
  it("sends system separately, drops temperature, groups tool results, replays raw blocks", async () => {
    const s = await mockServer((_r, res) =>
      json(res, anthropicMessage([{ type: "tool_use", id: "tu1", name: "terminal", input: { command: "ls" } }], "tool_use")),
    );
    close = s.close;
    const p = new AnthropicProvider("anthropic", "cloud", s.url, true);
    const first = await p.chat("claude-opus-5-5", req, { apiKey: "sk-ant-test" });
    expect(first.toolCalls).toEqual([{ id: "tu1", name: "terminal", arguments: '{"command":"ls"}' }]);
    expect(first.usage).toEqual({ inputTokens: 24, outputTokens: 7 });

    const body = s.requests[0]?.body ?? {};
    expect(body.system).toBe("be brief");
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    // A custom baseUrl (proxy) may not support server-side fallback, so it is not requested.
    expect(body.fallbacks).toBeUndefined();

    await p.chat(
      "claude-opus-5-5",
      {
        model: "x",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "", toolCalls: first.toolCalls, raw: first.raw },
          { role: "tool", toolCallId: "tu1", content: "a.txt" },
          { role: "tool", toolCallId: "tu2", content: "boom", isError: true },
        ],
      },
      { apiKey: "k" },
    );
    const msgs = s.requests[1]?.body.messages as { role: string; content: unknown }[];
    expect(msgs[1]?.content).toEqual([{ type: "tool_use", id: "tu1", name: "terminal", input: { command: "ls" } }]);
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "a.txt" },
        { type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true },
      ],
    });
  });

  it("asks for server-side refusal fallback on the first-party API", async () => {
    const p = new AnthropicProvider("anthropic", "cloud", undefined, true);
    // Inspect the request body without a network call.
    const body = (p as unknown as { body(m: string, r: ChatRequest): Record<string, unknown> }).body("claude-opus-5-5", req);
    expect(body).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  });

  it("maps a refusal stop reason", async () => {
    const s = await mockServer((_r, res) => json(res, anthropicMessage([], "refusal")));
    close = s.close;
    const r = await new AnthropicProvider("anthropic", "cloud", s.url, true).chat("claude-opus-5-5", req, { apiKey: "k" });
    expect(r.finishReason).toBe("refusal");
  });

  it("streams text deltas and returns the final message", async () => {
    const s = await mockServer((_r, res) =>
      sse(res, [
        { event: "message_start", data: { type: "message_start", message: { ...anthropicMessage([]), usage: { input_tokens: 5, output_tokens: 0 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Oi " } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tudo bem" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]),
    );
    close = s.close;
    const chunks = await drain(new AnthropicProvider("anthropic", "cloud", s.url, true).stream("claude-opus-5-5", req, { apiKey: "k" }));
    const done = chunks.at(-1);
    expect(chunks.filter((c) => c.type === "text").length).toBe(2);
    expect(done?.type === "done" && done.result).toMatchObject({ text: "Oi tudo bem", finishReason: "stop" });
  });
});

describe("Google adapter", () => {
  it("maps system instruction, tools and function calls", async () => {
    const s = await mockServer((_r, res) =>
      json(res, {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok " }, { functionCall: { name: "terminal", args: { command: "pwd" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 },
      }),
    );
    close = s.close;
    const r = await new GoogleProvider("google", "cloud", s.url).chat("gemini-test", req, { apiKey: "g-key" });
    expect(r).toMatchObject({ finishReason: "tool_calls", usage: { inputTokens: 9, outputTokens: 3 } });
    expect(JSON.parse(r.toolCalls[0]?.arguments ?? "{}")).toEqual({ command: "pwd" });
    const rec = s.requests[0];
    expect(rec?.path).toContain("gemini-test:generateContent");
    expect(JSON.stringify(rec?.body)).toContain("be brief");
    expect(JSON.stringify(rec?.body)).toContain("functionDeclarations");
  });
});
