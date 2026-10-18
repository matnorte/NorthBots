import { eq, sql } from "drizzle-orm";
import type { EventLog } from "../events/log.js";
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

/**
 * The office draws agents only from the event log, so every agent's current look must be in
 * an event. Agents created before looks were logged (or changed outside the API) get an
 * `agent.updated` event with their look. Runs at startup.
 */
export async function logLooks(db: DbHandle, events: EventLog): Promise<number> {
  const rows = await db.db.execute<{ id: string; ws: string; avatar: Record<string, unknown>; logged: Record<string, unknown> | null }>(sql`
    select a.id, a.workspace_id as ws, a.avatar, (
      select e.payload->'avatar' from events e
      where e.agent_id = a.id and e.type in ('agent.created', 'agent.updated') and e.payload ? 'avatar'
      order by e.id desc limit 1
    ) as logged
    from agents a`);
  let n = 0;
  for (const r of rows.rows) {
    const look = Avatar.parse(r.avatar);
    if (r.logged && lookKey(Avatar.parse(r.logged)) === lookKey(look)) continue;
    await events.write(r.ws, { type: "agent.updated", agentId: r.id, payload: { agentId: r.id, changed: ["avatar"], userId: null, avatar: look } });
    n += 1;
  }
  return n;
}

/** A free look for a new agent, close to `wanted` when given. */
export async function assignLook(db: DbHandle, workspaceId: string, wanted?: Partial<Avatar>): Promise<Avatar> {
  return freeLook(await takenLooks(db, workspaceId), wanted);
}
