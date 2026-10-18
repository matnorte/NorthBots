import {
  AllProvidersFailedError,
  NoProviderError,
  PrivacyError,
  ProviderError,
  RouterError,
} from "./errors.js";
import { createProvider, FakeProvider, type Provider } from "./providers/index.js";
import { costOf, priceFor } from "./pricing.js";
import { Redactor, StreamRestorer } from "./redact.js";
import type {
  CallContext,
  ChatRequest,
  ChatResult,
  ProviderConfig,
  ProviderResult,
  RouterConfig,
  StreamEvent,
  Usage,
} from "./types.js";

export interface Target {
  config: ProviderConfig;
  provider: Provider;
  model: string;
  alias: string | null;
}

export interface CallRecord {
  ctx: CallContext;
  provider: string;
  model: string;
  alias: string | null;
  ok: boolean;
  error?: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  redactions: number;
}

export interface BudgetGuard {
  /** Throws BudgetExceededError when any cap that applies to `ctx` is already used up. */
  check(ctx: CallContext): Promise<void>;
}

export interface RouterDeps {
  /** Returns the API key for a provider (from the vault), or undefined if none is stored. */
  resolveKey?: (provider: ProviderConfig) => Promise<string | undefined>;
  budget?: BudgetGuard;
  /** Called once per attempt, success or failure; the server writes an `llm.call` event. */
  onCall?: (rec: CallRecord) => Promise<void>;
  /** Pre-built providers by name (tests use this to inject scripted fakes). */
  providers?: Record<string, Provider>;
}

const NEEDS_KEY = new Set(["openai", "anthropic", "google"]);

export class Router {
  private providers = new Map<string, { config: ProviderConfig; provider: Provider }>();

  constructor(
    private readonly config: RouterConfig,
    private readonly deps: RouterDeps = {},
  ) {
    for (const c of config.providers) {
      this.providers.set(c.name, { config: c, provider: deps.providers?.[c.name] ?? createProvider(c) });
    }
  }

  /** Every name a client can put in `model`: aliases first, then `provider/model` pairs. */
  models(): { id: string; kind: "alias" | "model"; provider?: string }[] {
    const aliases = Object.keys(this.config.aliases).map((id) => ({ id, kind: "alias" as const }));
    const direct = this.config.providers.flatMap((p) =>
      p.models.map((m) => ({ id: `${p.name}/${m}`, kind: "model" as const, provider: p.name })),
    );
    return [...aliases, ...direct];
  }

  resolve(model: string): Target[] {
    const chain = this.config.aliases[model];
    const specs = chain ?? [model];
    const targets = specs.flatMap((spec): Target[] => {
      const slash = spec.indexOf("/");
      if (slash > 0) {
        const p = this.providers.get(spec.slice(0, slash));
        return p ? [{ ...p, model: spec.slice(slash + 1), alias: chain ? model : null }] : [];
      }
      return [...this.providers.values()]
        .filter((p) => p.config.models.includes(spec))
        .map((p) => ({ ...p, model: spec, alias: null }));
    });
    if (targets.length === 0) throw new NoProviderError(`Unknown model or alias "${model}".`);
    return targets;
  }

  private allowed(targets: Target[], ctx: CallContext): Target[] {
    if (ctx.privacy !== "sensitive") return targets;
    const local = targets.filter((t) => t.config.kind === "local");
    if (local.length === 0) {
      throw new PrivacyError(
        `This call is tagged sensitive, so it may only use local providers, and none of ` +
          `${targets.map((t) => `${t.config.name}/${t.model}`).join(", ")} is local. ` +
          "Add a local provider (Ollama, vLLM, LM Studio) to the chain.",
      );
    }
    return local;
  }

  private async keyFor(t: Target): Promise<string | undefined | null> {
    const key = t.config.keySecret ? await this.deps.resolveKey?.(t.config) : undefined;
    if (!key && NEEDS_KEY.has(t.config.type)) return null;
    return key;
  }

  private cost(t: Target, usage: Usage): number {
    if (t.provider instanceof FakeProvider && t.provider.costPerCallUsd !== undefined) {
      return t.provider.costPerCallUsd;
    }
    return costOf(usage, priceFor(t.config.name, t.model, t.config.kind, this.config.pricing));
  }

  private finalize(t: Target, r: ProviderResult, redactor: Redactor | null, started: number, fallbacks: ChatResult["fallbacks"]): ChatResult {
    const restore = (s: string) => (redactor ? redactor.restore(s) : s);
    return {
      ...r,
      text: restore(r.text),
      toolCalls: r.toolCalls.map((c) => ({ ...c, arguments: restore(c.arguments) })),
      id: `chatcmpl-${crypto.randomUUID()}`,
      provider: t.config.name,
      model: r.servedModel ?? t.model,
      alias: t.alias,
      costUsd: this.cost(t, r.usage),
      latencyMs: Date.now() - started,
      fallbacks,
    };
  }

  private async record(ctx: CallContext, t: Target, rec: Partial<CallRecord> & { ok: boolean }) {
    await this.deps.onCall?.({
      ctx,
      provider: t.config.name,
      model: t.model,
      alias: t.alias,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      redactions: 0,
      ...rec,
    });
  }

  private async prepare(req: ChatRequest, ctx: CallContext): Promise<Target[]> {
    const targets = this.allowed(this.resolve(req.model), ctx);
    await this.deps.budget?.check(ctx);
    return targets;
  }

  private redactorFor(t: Target): Redactor | null {
    return t.config.kind === "cloud" && this.config.redactPii ? new Redactor() : null;
  }

  async chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    const fallbacks: ChatResult["fallbacks"] = [];
    for (const t of await this.prepare(req, ctx)) {
      const apiKey = await this.keyFor(t);
      if (apiKey === null) {
        fallbacks.push({ provider: t.config.name, model: t.model, error: "no API key in the vault" });
        continue;
      }
      const redactor = this.redactorFor(t);
      const messages = redactor ? redactor.redactMessages(req.messages) : req.messages;
      const started = Date.now();
      try {
        const r = await t.provider.chat(t.model, { ...req, messages }, { apiKey, signal: ctx.signal });
        const result = this.finalize(t, r, redactor, started, fallbacks);
        await this.record(ctx, t, {
          ok: true,
          usage: r.usage,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          redactions: redactor?.count ?? 0,
        });
        return result;
      } catch (err) {
        if (!(err instanceof ProviderError) || ctx.signal?.aborted) throw err;
        await this.record(ctx, t, { ok: false, error: err.message, latencyMs: Date.now() - started });
        fallbacks.push({ provider: t.config.name, model: t.model, error: err.message });
      }
    }
    throw new AllProvidersFailedError(fallbacks);
  }

  /** Streams text; falls back to the next target only if nothing was emitted yet. */
  async *stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamEvent> {
    const fallbacks: ChatResult["fallbacks"] = [];
    for (const t of await this.prepare(req, ctx)) {
      const apiKey = await this.keyFor(t);
      if (apiKey === null) {
        fallbacks.push({ provider: t.config.name, model: t.model, error: "no API key in the vault" });
        continue;
      }
      const redactor = this.redactorFor(t);
      const restorer = redactor ? new StreamRestorer(redactor) : null;
      const messages = redactor ? redactor.redactMessages(req.messages) : req.messages;
      const started = Date.now();
      let emitted = false;
      try {
        for await (const chunk of t.provider.stream(t.model, { ...req, messages }, { apiKey, signal: ctx.signal })) {
          if (chunk.type === "text") {
            const text = restorer ? restorer.push(chunk.text) : chunk.text;
            if (text) {
              emitted = true;
              yield { type: "text", text };
            }
            continue;
          }
          const tail = restorer?.flush();
          if (tail) yield { type: "text", text: tail };
          const result = this.finalize(t, chunk.result, redactor, started, fallbacks);
          await this.record(ctx, t, {
            ok: true,
            usage: chunk.result.usage,
            costUsd: result.costUsd,
            latencyMs: result.latencyMs,
            redactions: redactor?.count ?? 0,
          });
          yield { type: "done", result };
          return;
        }
        throw new ProviderError(t.config.name, "stream ended without a result");
      } catch (err) {
        if (!(err instanceof ProviderError) || ctx.signal?.aborted) throw err;
        await this.record(ctx, t, { ok: false, error: err.message, latencyMs: Date.now() - started });
        if (emitted) throw err;
        fallbacks.push({ provider: t.config.name, model: t.model, error: err.message });
      }
    }
    throw new AllProvidersFailedError(fallbacks);
  }
}

export { RouterError };
