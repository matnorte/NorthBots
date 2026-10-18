import { z } from "zod";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, as the model produced them. */
  arguments: string;
}

/**
 * Provider-native content of an assistant turn. Agent loops must replay it unchanged
 * when the next call goes to the same provider and model (e.g. Claude thinking blocks:
 * editing or stripping them breaks the conversation-binding check).
 */
export interface RawTurn {
  provider: string;
  model: string;
  content: unknown;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: RawTurn }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type Privacy = "normal" | "sensitive";

export interface ChatRequest {
  /** An alias (`northbot-fast`), `provider/model`, or a bare model a provider lists. */
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  /** Only sent to providers that accept sampling parameters. */
  temperature?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "refusal" | "error";

/** What one provider call returns, before the router adds cost and routing info. */
export interface ProviderResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
  raw?: RawTurn;
  /** The model that actually answered, when the provider reports a different one. */
  servedModel?: string;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "done"; result: ProviderResult };

export interface ChatResult extends ProviderResult {
  id: string;
  provider: string;
  model: string;
  alias: string | null;
  costUsd: number;
  latencyMs: number;
  /** Targets that failed before this one answered. */
  fallbacks: { provider: string; model: string; error: string }[];
}

export type StreamEvent = { type: "text"; text: string } | { type: "done"; result: ChatResult };

/** Who is calling; used for budgets, privacy and the event log. */
export interface CallContext {
  workspaceId: string;
  agentId?: string | null;
  taskId?: string | null;
  apiKeyId?: string | null;
  taskBudgetUsd?: number | null;
  privacy: Privacy;
  signal?: AbortSignal;
}

export const FakeTurn = z.object({
  text: z.string().optional(),
  toolCalls: z.array(z.object({ name: z.string(), arguments: z.record(z.unknown()) })).optional(),
});
export type FakeTurn = z.infer<typeof FakeTurn>;

export const FakeConfig = z.object({
  /** A killed provider: every call fails like a network error. */
  down: z.boolean().default(false),
  /** Turn i answers the request that already holds i assistant messages (stateless scripting). */
  script: z.array(FakeTurn).default([]),
  reply: z.string().optional(),
  /** Role-based answers: the first entry whose `contains` appears in the system prompt wins. */
  match: z.array(FakeTurn.extend({ contains: z.string(), script: z.array(FakeTurn).optional() })).default([]),
  costPerCallUsd: z.number().min(0).optional(),
  latencyMs: z.number().int().min(0).default(0),
});
export type FakeConfig = z.infer<typeof FakeConfig>;

export const ProviderConfig = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  type: z.enum(["openai", "anthropic", "google", "openai-compatible", "fake"]),
  /** `local` providers run on hardware the user controls; only they may see sensitive tasks. */
  kind: z.enum(["cloud", "local"]),
  baseUrl: z.string().url().optional(),
  /** Vault secret holding the API key. The value is fetched at call time and never logged. */
  keySecret: z.string().optional(),
  models: z.array(z.string()).default([]),
  /** Anthropic: ask the API to retry refusals on its default fallback model. */
  serverFallbacks: z.boolean().default(true),
  fake: FakeConfig.optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const Price = z.object({ inputPerM: z.number().min(0), outputPerM: z.number().min(0) });
export type Price = z.infer<typeof Price>;

export const RouterConfig = z.object({
  providers: z.array(ProviderConfig),
  /** alias -> ordered fallback chain of `provider/model` targets. */
  aliases: z.record(z.array(z.string()).min(1)),
  redactPii: z.boolean().default(true),
  /** Overrides for the built-in price table, keyed by `provider/model` or model. */
  pricing: z.record(Price).default({}),
});
export type RouterConfig = z.infer<typeof RouterConfig>;
