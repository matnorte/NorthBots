import { eq } from "drizzle-orm";
import { Avatar, type AgentInfo } from "@northbot/shared";
import { agents } from "../db/schema.js";
import type { Services } from "../services.js";
import { assignLook, LOOK_TAKEN } from "./looks.js";

export interface NewAgent {
  name: string;
  nameLocked: boolean;
  avatar: Avatar;
  persona: Record<string, unknown>;
  modelPolicy: Record<string, unknown>;
  autonomyLevel: AgentInfo["autonomyLevel"];
  budgetDailyUsd: number;
}

export class LookTakenError extends Error {
  constructor() {
    super(LOOK_TAKEN);
  }
}

export function isLookClash(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ("code" in err && err.code === "23505" && "constraint" in err && err.constraint === "agents_look") return true;
  return "cause" in err && isLookClash(err.cause);
}

/**
 * Inserts the agent, logs it, and gives it a computer. Name checks happen before this.
 * `autoLook`: if someone took this look in the meantime, try the next free one; otherwise
 * a clash is an error (the human picked that exact look).
 */
export async function createAgent(s: Services, workspaceId: string, userId: string | null, a: NewAgent, opts: { autoLook?: boolean } = {}) {
  let look = Avatar.parse(a.avatar);
  let row: typeof agents.$inferSelect | undefined;
  for (let attempt = 0; !row; attempt++) {
    try {
      [row] = await s.db.db
        .insert(agents)
        .values({ ...a, avatar: look, workspaceId, budgetDailyUsd: String(a.budgetDailyUsd) })
        .returning();
    } catch (err) {
      if (!isLookClash(err)) throw err;
      if (!opts.autoLook || attempt >= 5) throw new LookTakenError();
      look = await assignLook(s.db, workspaceId, { shape: look.shape });
    }
  }
  await s.events.write(workspaceId, { type: "agent.created", agentId: row.id, payload: { agentId: row.id, name: row.name, userId } });
  await s.computers.createFor({ workspaceId, agentId: row.id });
  const [fresh] = await s.db.db.select().from(agents).where(eq(agents.id, row.id));
  return fresh ?? row;
}
