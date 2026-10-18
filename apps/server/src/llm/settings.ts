import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_ROUTER_CONFIG, RouterConfig } from "@northbot/llm-router";
import type { DbHandle } from "../db/client.js";
import { workspaces } from "../db/schema.js";

export const LlmSettings = RouterConfig.extend({
  /** Hard cap on all model spend per local day in the workspace timezone. Null = no cap. */
  dailyBudgetUsd: z.number().positive().nullable().default(null),
});
export type LlmSettings = z.infer<typeof LlmSettings>;

export const DEFAULT_LLM_SETTINGS: LlmSettings = { ...DEFAULT_ROUTER_CONFIG, dailyBudgetUsd: null };

export interface WorkspaceLlm {
  settings: LlmSettings;
  timezone: string;
}

export async function loadLlmSettings(db: DbHandle, workspaceId: string): Promise<WorkspaceLlm> {
  const [ws] = await db.db
    .select({ settings: workspaces.settings, timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error("workspace missing");
  const stored = (ws.settings as { llm?: unknown }).llm;
  const parsed = stored ? LlmSettings.safeParse(stored) : null;
  return { settings: parsed?.success ? parsed.data : DEFAULT_LLM_SETTINGS, timezone: ws.timezone };
}

export async function saveLlmSettings(db: DbHandle, workspaceId: string, s: LlmSettings): Promise<void> {
  await db.db
    .update(workspaces)
    .set({ settings: sql`jsonb_set(${workspaces.settings}, '{llm}', ${JSON.stringify(s)}::jsonb)` })
    .where(eq(workspaces.id, workspaceId));
}
