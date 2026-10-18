import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ProviderError } from "../errors.js";
import type { ChatMessage, ChatRequest, FinishReason, ProviderChunk, ProviderResult } from "../types.js";
import type { CallOptions, Provider } from "./provider.js";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function toAnthropic(
  messages: ChatMessage[],
  provider: string,
  model: string,
): { system: string | undefined; messages: BetaMessageParam[] } {
  const system = messages.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n");
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.raw && m.raw.provider === provider && m.raw.model === model) {
        // Replay Claude's own blocks unchanged (thinking blocks are bound to the conversation).
        out.push({ role: "assistant", content: m.raw.content as BetaContentBlockParam[] });
        continue;
      }
      const blocks: BetaContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: JSON.parse(c.arguments || "{}") });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      const result: BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      // All results for one assistant turn go back in a single user message.
      const prev = out.at(-1);
      if (prev?.role === "user" && Array.isArray(prev.content) && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(result);
      } else {
        out.push({ role: "user", content: [result] });
      }
    }
  }
  return { system: system || undefined, messages: out };
}

function finish(reason: BetaMessage["stop_reason"]): FinishReason {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    default:
      return "stop";
  }
}

function toResult(provider: string, model: string, msg: BetaMessage): ProviderResult {
  const content: BetaContentBlock[] = msg.content;
  const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const toolCalls = content.flatMap((b) =>
    b.type === "tool_use" ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }] : [],
  );
  const u = msg.usage;
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    },
    finishReason: finish(msg.stop_reason),
    raw: { provider, model, content },
    servedModel: msg.model,
  };
}

/** Claude via the official Anthropic SDK. */
export class AnthropicProvider implements Provider {
  constructor(
    readonly name: string,
    readonly kind: "cloud" | "local",
    private readonly baseUrl: string | undefined,
    private readonly serverFallbacks: boolean,
  ) {}

  private client(opts: CallOptions): Anthropic {
    return new Anthropic({ apiKey: opts.apiKey, baseURL: this.baseUrl, maxRetries: 1 });
  }

  private body(model: string, req: ChatRequest): MessageCreateParamsNonStreaming {
    const { system, messages } = toAnthropic(req.messages, this.name, model);
    // No temperature / thinking budget: current Claude models reject them; effort is the control.
    const fallbacks = this.serverFallbacks && !this.baseUrl;
    return {
      model,
      max_tokens: req.maxTokens ?? 16000,
      messages,
      ...(system ? { system } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: { type: "object" as const, ...t.parameters },
            })),
          }
        : {}),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
  }

  private wrap(err: unknown): ProviderError {
    if (err instanceof Anthropic.APIError) return new ProviderError(this.name, err.message, err.status);
    return new ProviderError(this.name, err instanceof Error ? err.message : String(err));
  }

  async chat(model: string, req: ChatRequest, opts: CallOptions): Promise<ProviderResult> {
    try {
      const msg = await this.client(opts).beta.messages.create(this.body(model, req), { signal: opts.signal });
      return toResult(this.name, model, msg);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async *stream(model: string, req: ChatRequest, opts: CallOptions): AsyncIterable<ProviderChunk> {
    let final: BetaMessage;
    try {
      const stream = this.client(opts).beta.messages.stream(this.body(model, req), { signal: opts.signal });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      throw this.wrap(err);
    }
    yield { type: "done", result: toResult(this.name, model, final) };
  }
}
