import { ProviderError } from "../errors.js";
import type { ChatRequest, FakeConfig, ProviderChunk, ProviderResult, ToolCall } from "../types.js";
import { estimateTokens, type CallOptions, type Provider } from "./provider.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic provider for tests and demos. With a script, turn i answers the request that
 * already contains i assistant messages, so an agent loop replays identically every run.
 */
export class FakeProvider implements Provider {
  constructor(
    readonly name: string,
    readonly kind: "cloud" | "local",
    private readonly config: FakeConfig,
  ) {}

  /** Fixed cost per call; the router uses it instead of the price table when set. */
  get costPerCallUsd(): number | undefined {
    return this.config.costPerCallUsd;
  }

  async chat(model: string, req: ChatRequest, opts: CallOptions): Promise<ProviderResult> {
    if (this.config.latencyMs) await sleep(this.config.latencyMs);
    if (opts.signal?.aborted) throw new ProviderError(this.name, "aborted");
    if (this.config.down) throw new ProviderError(this.name, "connection refused (provider is down)", 503);

    const turn = req.messages.filter((m) => m.role === "assistant").length;
    // Match rules look at the system prompt and the opening request (the task or question).
    const opening = req.messages.find((m) => m.role === "user")?.content ?? "";
    const context = `${req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join(" ")} ${opening}`;
    const matched = this.config.match.find((m) => context.includes(m.contains));
    const scripted = matched?.script ? matched.script[turn] : (matched ?? this.config.script[turn]);
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const text = scripted ? (scripted.text ?? "") : (this.config.reply ?? `fake reply to: ${lastUser}`);
    const toolCalls: ToolCall[] = (scripted?.toolCalls ?? []).map((c, i) => ({
      id: `call_${turn}_${i}`,
      name: c.name,
      arguments: JSON.stringify(c.arguments),
    }));
    const input = req.messages.map((m) => m.content).join("\n");
    return {
      text,
      toolCalls,
      usage: { inputTokens: estimateTokens(input), outputTokens: estimateTokens(text || " ") },
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      raw: { provider: this.name, model, content: { text, toolCalls } },
    };
  }

  async *stream(model: string, req: ChatRequest, opts: CallOptions): AsyncIterable<ProviderChunk> {
    const result = await this.chat(model, req, opts);
    for (const word of result.text.match(/\S+\s*/g) ?? []) yield { type: "text", text: word };
    yield { type: "done", result };
  }
}
