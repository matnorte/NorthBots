import { eq, sql } from "drizzle-orm";
import { Avatar, freeLook, lookKey } from "@northbot/shared";
import type { DbHandle } from "../db/client.js";
import { agents } from "../db/schema.js";

export const LOOK_TAKEN = "Another agent already looks like that. Pick another colour or shape.";

/** Looks (shape + colour) already used in a workspace, optionally ignoring one agent. */
export async function takenLooks(db: DbHandle, workspaceId: string, exceptAgentId?: string): Promise<Avatar[]> {
  const rows = await db.db.select({ id: agents.id, avatar: agents.avatar }).from(agents).where(eq(agents.workspaceId, workspaceId));
  // Only real geometric looks count; legacy avatars are being normalised.
  return rows.filter((r) => r.id !== exceptAgentId && "shape" in r.avatar).map((r) => Avatar.parse(r.avatar));
}

/** True when nobody else in the workspace has this look. */
export async function lookIsFree(db: DbHandle, workspaceId: string, look: Avatar, exceptAgentId?: string): Promise<boolean> {
  return !(await takenLooks(db, workspaceId, exceptAgentId)).some((t) => lookKey(t) === lookKey(look));
}

/**
 * Gives every agent without a geometric look (saved before the redesign, or a duplicate the
 * migration cleared) its own free one, as close to its old look as possible. Runs at startup.
 */
export async function normalizeLooks(db: DbHandle): Promise<number> {
  const rows = await db.db.select({ id: agents.id, ws: agents.workspaceId, avatar: agents.avatar }).from(agents).where(sql`not (${agents.avatar} ? 'shape')`);
  for (const r of rows) {
    const look = freeLook(await takenLooks(db, r.ws, r.id), Avatar.parse(r.avatar));
    await db.db.update(agents).set({ avatar: look }).where(eq(agents.id, r.id));
  }
  return rows.length;
}

/** A free look for a new agent, close to `wanted` when given. */
export async function assignLook(db: DbHandle, workspaceId: string, wanted?: Partial<Avatar>): Promise<Avatar> {
  return freeLook(await takenLooks(db, workspaceId), wanted);
}
