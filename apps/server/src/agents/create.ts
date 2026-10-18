import { eq } from "drizzle-orm";
import type { AgentInfo } from "@northbot/shared";
import { agents } from "../db/schema.js";
import type { Services } from "../services.js";

export interface NewAgent {
  name: string;
  nameLocked: boolean;
  avatar: Record<string, unknown>;
  persona: Record<string, unknown>;
  modelPolicy: Record<string, unknown>;
  autonomyLevel: AgentInfo["autonomyLevel"];
  budgetDailyUsd: number;
}

/** Inserts the agent, logs it, and gives it a computer. Name checks happen before this. */
export async function createAgent(s: Services, workspaceId: string, userId: string | null, a: NewAgent) {
  const [row] = await s.db.db
    .insert(agents)
    .values({ ...a, workspaceId, budgetDailyUsd: String(a.budgetDailyUsd) })
    .returning();
  if (!row) throw new Error("agent insert failed");
  await s.events.write(workspaceId, { type: "agent.created", agentId: row.id, payload: { agentId: row.id, name: row.name, userId } });
  await s.computers.createFor({ workspaceId, agentId: row.id });
  const [fresh] = await s.db.db.select().from(agents).where(eq(agents.id, row.id));
  return fresh ?? row;
}
