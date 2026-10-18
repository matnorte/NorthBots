import {
  BudgetExceededError,
  PrivacyError,
  Router,
  type CallContext,
  type CallRecord,
  type ChatRequest,
  type ChatResult,
  type Provider,
  type StreamEvent,
} from "@northbot/llm-router";
import { scrubSecrets } from "@northbot/shared";
import type { DbHandle } from "../db/client.js";
import type { EventLog } from "../events/log.js";
import type { Vault } from "../vault/vault.js";
import { ServerBudgetGuard } from "./budget.js";
import { loadLlmSettings } from "./settings.js";

export interface LlmCallOptions {
  apiKeyDailyUsd?: number | null;
}

/** The single way the server talks to models: budgets, privacy, vault keys and cost events. */
export class LlmService {
  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly vault: Vault,
    /** Test hook: named providers that replace the configured ones. */
    private readonly overrides: Record<string, Provider> = {},
  ) {}

  private async router(ctx: CallContext, opts: LlmCallOptions): Promise<Router> {
    const { settings, timezone } = await loadLlmSettings(this.db, ctx.workspaceId);
    const budget = new ServerBudgetGuard(this.db, {
      timezone,
      workspaceDailyUsd: settings.dailyBudgetUsd,
      apiKeyDailyUsd: opts.apiKeyDailyUsd ?? null,
    });
    return new Router(settings, {
      budget,
      providers: this.overrides,
      resolveKey: async (p) =>
        p.keySecret ? ((await this.vault.withSecret(ctx.workspaceId, p.keySecret, async (v) => v)) ?? undefined) : undefined,
      onCall: (rec) => this.record(rec),
    });
  }

  private async record(rec: CallRecord): Promise<void> {
    await this.events.write(rec.ctx.workspaceId, {
      type: "llm.call",
      agentId: rec.ctx.agentId ?? null,
      costUsd: rec.costUsd,
      payload: {
        provider: rec.provider,
        model: rec.model,
        alias: rec.alias,
        ok: rec.ok,
        ...(rec.error ? { error: scrubSecrets(rec.error).slice(0, 500) } : {}),
        inputTokens: rec.usage.inputTokens,
        outputTokens: rec.usage.outputTokens,
        latencyMs: rec.latencyMs,
        privacy: rec.ctx.privacy,
        redactions: rec.redactions,
        taskId: rec.ctx.taskId ?? null,
        apiKeyId: rec.ctx.apiKeyId ?? null,
      },
    });
  }

  private async blocked(ctx: CallContext, err: unknown): Promise<void> {
    if (!(err instanceof BudgetExceededError || err instanceof PrivacyError)) return;
    await this.events.write(ctx.workspaceId, {
      type: "llm.blocked",
      agentId: ctx.agentId ?? null,
      payload: {
        reason: err instanceof BudgetExceededError ? "budget_exceeded" : "privacy_violation",
        message: err.message,
        taskId: ctx.taskId ?? null,
        apiKeyId: ctx.apiKeyId ?? null,
      },
    });
  }

  async chat(req: ChatRequest, ctx: CallContext, opts: LlmCallOptions = {}): Promise<ChatResult> {
    try {
      return await (await this.router(ctx, opts)).chat(req, ctx);
    } catch (err) {
      await this.blocked(ctx, err);
      throw err;
    }
  }

  async *stream(req: ChatRequest, ctx: CallContext, opts: LlmCallOptions = {}): AsyncIterable<StreamEvent> {
    try {
      yield* (await this.router(ctx, opts)).stream(req, ctx);
    } catch (err) {
      await this.blocked(ctx, err);
      throw err;
    }
  }

  async models(workspaceId: string) {
    const { settings } = await loadLlmSettings(this.db, workspaceId);
    return new Router(settings, { providers: this.overrides }).models();
  }
}
