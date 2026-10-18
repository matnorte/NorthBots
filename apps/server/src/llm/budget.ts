import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import { BudgetExceededError, RouterError, type BudgetGuard, type CallContext } from "@northbot/llm-router";
import { startOfDayIn } from "@northbot/shared";
import type { DbHandle } from "../db/client.js";
import { agents, events } from "../db/schema.js";

interface Cap {
  scope: string;
  limitUsd: number;
  where: SQL;
}

/**
 * Hard caps, all computed from `llm.call` events: workspace per day, API key per day,
 * agent per day (from agents.budget_daily_usd) and per task (whole task, no day window).
 */
export class ServerBudgetGuard implements BudgetGuard {
  constructor(
    private readonly db: DbHandle,
    private readonly opts: { timezone: string; workspaceDailyUsd: number | null; apiKeyDailyUsd: number | null },
  ) {}

  private async caps(ctx: CallContext): Promise<Cap[]> {
    const base = and(eq(events.workspaceId, ctx.workspaceId), eq(events.type, "llm.call"));
    const today = and(base, gte(events.ts, startOfDayIn(new Date(), this.opts.timezone)));
    const caps: Cap[] = [];
    if (this.opts.workspaceDailyUsd !== null) {
      caps.push({ scope: "this workspace today", limitUsd: this.opts.workspaceDailyUsd, where: today! });
    }
    if (ctx.apiKeyId && this.opts.apiKeyDailyUsd !== null) {
      caps.push({
        scope: "this API key today",
        limitUsd: this.opts.apiKeyDailyUsd,
        where: and(today, sql`${events.payload}->>'apiKeyId' = ${ctx.apiKeyId}`)!,
      });
    }
    if (ctx.agentId) {
      const [agent] = await this.db.db
        .select({ budget: agents.budgetDailyUsd, name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, ctx.agentId), eq(agents.workspaceId, ctx.workspaceId)));
      if (!agent) throw new RouterError("unknown_agent", "That agent does not exist in this workspace.");
      caps.push({ scope: `agent ${agent.name} today`, limitUsd: Number(agent.budget), where: and(today, eq(events.agentId, ctx.agentId))! });
    }
    if (ctx.taskId && ctx.taskBudgetUsd != null) {
      caps.push({
        scope: `task ${ctx.taskId}`,
        limitUsd: ctx.taskBudgetUsd,
        where: and(base, sql`${events.payload}->>'taskId' = ${ctx.taskId}`)!,
      });
    }
    return caps;
  }

  async spent(where: SQL): Promise<number> {
    const [row] = await this.db.db
      .select({ total: sql<string>`coalesce(sum(${events.costUsd}), 0)` })
      .from(events)
      .where(where);
    return Number(row?.total ?? 0);
  }

  async check(ctx: CallContext): Promise<void> {
    for (const cap of await this.caps(ctx)) {
      const spent = await this.spent(cap.where);
      if (spent >= cap.limitUsd) throw new BudgetExceededError(cap.scope, cap.limitUsd, spent);
    }
  }
}
