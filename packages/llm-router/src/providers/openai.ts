import OpenAI from "openai";
import { ProviderError } from "../errors.js";
import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  ProviderChunk,
  ProviderResult,
  ToolCall,
} from "../types.js";
import type { CallOptions, Provider } from "./provider.js";

type OAMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OATool = OpenAI.Chat.Completions.ChatCompletionTool;

function toOpenAI(messages: ChatMessage[]): OAMessage[] {
  return messages.map((m): OAMessage => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

function finish(reason: string | null | undefined): FinishReason {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "tool_calls";
  if (reason === "content_filter") return "refusal";
  return "stop";
}

/** OpenAI and any OpenAI-compatible server (Ollama, vLLM, OpenRouter, LM Studio). */
export class OpenAIProvider implements Provider {
  constructor(
    readonly name: string,
    readonly kind: "cloud" | "local",
    private readonly baseUrl: string | undefined,
    /** Official OpenAI takes `max_completion_tokens`; most compatible servers want `max_tokens`. */
    private readonly official: boolean,
  ) {}

  private client(opts: CallOptions): OpenAI {
    // Local servers often need no key, but the SDK requires a non-empty string.
    return new OpenAI({ apiKey: opts.apiKey || "not-needed", baseURL: this.baseUrl, maxRetries: 1 });
  }

  private body(model: string, req: ChatRequest) {
    const tools: OATool[] | undefined = req.tools?.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    return {
      model,
      messages: toOpenAI(req.messages),
      ...(tools?.length ? { tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens
        ? this.official
          ? { max_completion_tokens: req.maxTokens }
          : { max_tokens: req.maxTokens }
        : {}),
    };
  }

  private wrap(err: unknown): ProviderError {
    const status = typeof err === "object" && err && "status" in err ? Number(err.status) : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    return new ProviderError(this.name, msg, Number.isFinite(status) ? status : undefined);
  }

  async chat(model: string, req: ChatRequest, opts: CallOptions): Promise<ProviderResult> {
    try {
      const res = await this.client(opts).chat.completions.create(this.body(model, req), {
        signal: opts.signal,
      });
      const choice = res.choices[0];
      const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).flatMap((c) =>
        c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
      );
      return {
        text: choice?.message.content ?? "",
        toolCalls,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
        finishReason: finish(choice?.finish_reason),
        servedModel: res.model,
      };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async *stream(model: string, req: ChatRequest, opts: CallOptions): AsyncIterable<ProviderChunk> {
    let text = "";
    let reason: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    const calls = new Map<number, ToolCall>();
    try {
      const stream = await this.client(opts).chat.completions.create(
        { ...this.body(model, req), stream: true, stream_options: { include_usage: true } },
        { signal: opts.signal },
      );
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) reason = choice.finish_reason;
        const delta = choice.delta;
        if (delta.content) {
          text += delta.content;
          yield { type: "text", text: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          cur.id = tc.id ?? cur.id;
          cur.name += tc.function?.name ?? "";
          cur.arguments += tc.function?.arguments ?? "";
          calls.set(tc.index, cur);
        }
      }
    } catch (err) {
      throw this.wrap(err);
    }
    yield {
      type: "done",
      result: { text, toolCalls: [...calls.values()], usage, finishReason: finish(reason) },
    };
  }
}
