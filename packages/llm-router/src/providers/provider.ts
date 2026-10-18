import type { ChatRequest, ProviderChunk, ProviderResult } from "../types.js";

export interface CallOptions {
  apiKey?: string;
  signal?: AbortSignal;
}

/** One model provider. Implementations throw ProviderError on any failure. */
export interface Provider {
  readonly name: string;
  readonly kind: "cloud" | "local";
  chat(model: string, req: ChatRequest, opts: CallOptions): Promise<ProviderResult>;
  stream(model: string, req: ChatRequest, opts: CallOptions): AsyncIterable<ProviderChunk>;
}

/** Turns a non-streaming call into the streaming shape (used by providers without SSE). */
export async function* streamFromChat(result: Promise<ProviderResult>): AsyncIterable<ProviderChunk> {
  const r = await result;
  if (r.text) yield { type: "text", text: r.text };
  yield { type: "done", result: r };
}

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
