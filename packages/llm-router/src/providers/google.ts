import { GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { ProviderError } from "../errors.js";
import type { ChatMessage, ChatRequest, FinishReason, ProviderChunk, ProviderResult } from "../types.js";
import type { CallOptions, Provider } from "./provider.js";

function toGemini(messages: ChatMessage[]): { system: string | undefined; contents: Content[] } {
  const system = messages.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n");
  const toolNames = new Map<string, string>();
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.content }] });
    if (m.role === "assistant") {
      const parts: NonNullable<Content["parts"]> = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls ?? []) {
        toolNames.set(c.id, c.name);
        parts.push({ functionCall: { id: c.id, name: c.name, args: JSON.parse(c.arguments || "{}") } });
      }
      contents.push({ role: "model", parts });
    }
    if (m.role === "tool") {
      const part = {
        functionResponse: {
          id: m.toolCallId,
          name: toolNames.get(m.toolCallId) ?? "tool",
          response: m.isError ? { error: m.content } : { output: m.content },
        },
      };
      const prev = contents.at(-1);
      if (prev?.role === "user" && prev.parts?.every((p) => p.functionResponse)) prev.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return { system: system || undefined, contents };
}

function finish(res: GenerateContentResponse, hasCalls: boolean): FinishReason {
  if (hasCalls) return "tool_calls";
  const r = res.candidates?.[0]?.finishReason;
  if (r === "MAX_TOKENS") return "length";
  if (r === "SAFETY" || r === "PROHIBITED_CONTENT" || r === "BLOCKLIST") return "refusal";
  return "stop";
}

/** Gemini via the official @google/genai SDK. */
export class GoogleProvider implements Provider {
  constructor(
    readonly name: string,
    readonly kind: "cloud" | "local",
    private readonly baseUrl: string | undefined,
  ) {}

  private params(model: string, req: ChatRequest, opts: CallOptions) {
    const { system, contents } = toGemini(req.messages);
    return {
      model,
      contents,
      config: {
        ...(system ? { systemInstruction: system } : {}),
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: req.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters,
                  })),
                },
              ],
            }
          : {}),
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      },
    };
  }

  private client(opts: CallOptions): GoogleGenAI {
    return new GoogleGenAI({
      apiKey: opts.apiKey,
      ...(this.baseUrl ? { httpOptions: { baseUrl: this.baseUrl } } : {}),
    });
  }

  private toResult(res: GenerateContentResponse, text: string): ProviderResult {
    const toolCalls = (res.functionCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.name ?? "",
      arguments: JSON.stringify(c.args ?? {}),
    }));
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      },
      finishReason: finish(res, toolCalls.length > 0),
      servedModel: res.modelVersion,
    };
  }

  async chat(model: string, req: ChatRequest, opts: CallOptions): Promise<ProviderResult> {
    try {
      const res = await this.client(opts).models.generateContent(this.params(model, req, opts));
      return this.toResult(res, res.text ?? "");
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }
  }

  async *stream(model: string, req: ChatRequest, opts: CallOptions): AsyncIterable<ProviderChunk> {
    let text = "";
    let last: GenerateContentResponse | undefined;
    try {
      const stream = await this.client(opts).models.generateContentStream(this.params(model, req, opts));
      for await (const chunk of stream) {
        last = chunk;
        const t = chunk.text;
        if (t) {
          text += t;
          yield { type: "text", text: t };
        }
      }
    } catch (err) {
      throw new ProviderError(this.name, err instanceof Error ? err.message : String(err));
    }
    if (!last) throw new ProviderError(this.name, "empty stream");
    yield { type: "done", result: this.toResult(last, text) };
  }
}
