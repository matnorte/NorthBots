import { and, asc, eq, gte } from "drizzle-orm";
import pg from "pg";
import {
  parseEventPayload,
  type EventType,
  type NewEvent,
  type StoredEvent,
} from "@northbot/shared";
import type { DbHandle } from "../db/client.js";
import { events } from "../db/schema.js";

type Row = typeof events.$inferSelect;
type Listener = (event: StoredEvent) => void;

export function toStored(row: Row): StoredEvent {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    agentId: row.agentId,
    roomId: row.roomId,
    type: row.type,
    payload: row.payload,
    costUsd: Number(row.costUsd),
  };
}

/** The event log: the single source of truth. Writes are typed; live delivery goes through NOTIFY. */
export class EventLog {
  private listeners = new Map<string, Set<Listener>>();
  private allListeners = new Set<(workspaceId: string, event: StoredEvent) => void>();
  private client: pg.Client | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly databaseUrl: string,
  ) {}

  async write<T extends EventType>(workspaceId: string, e: NewEvent<T>): Promise<StoredEvent> {
    const payload = parseEventPayload(e.type, e.payload) as Record<string, unknown>;
    const [row] = await this.db.db
      .insert(events)
      .values({
        workspaceId,
        type: e.type,
        payload,
        agentId: e.agentId ?? null,
        roomId: e.roomId ?? null,
        costUsd: String(e.costUsd ?? 0),
      })
      .returning();
    if (!row) throw new Error("event insert returned nothing");
    return toStored(row);
  }

  async list(workspaceId: string, fromId: number, limit: number): Promise<StoredEvent[]> {
    const rows = await this.db.db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.id, fromId)))
      .orderBy(asc(events.id))
      .limit(limit);
    return rows.map(toStored);
  }

  /** Subscribe to live events for a workspace. Returns an unsubscribe function. */
  subscribe(workspaceId: string, fn: Listener): () => void {
    let set = this.listeners.get(workspaceId);
    if (!set) this.listeners.set(workspaceId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(workspaceId);
    };
  }

  async start(): Promise<void> {
    this.client = new pg.Client({ connectionString: this.databaseUrl });
    await this.client.connect();
    this.client.on("notification", (msg) => void this.onNotify(msg.payload));
    await this.client.query("LISTEN nb_events");
  }

  async stop(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }

  /** Every event from every workspace (server-side services such as the mood engine). */
  subscribeAll(fn: (workspaceId: string, event: StoredEvent) => void): () => void {
    this.allListeners.add(fn);
    return () => this.allListeners.delete(fn);
  }

  private async onNotify(raw: string | undefined): Promise<void> {
    if (!raw) return;
    const { id, w } = JSON.parse(raw) as { id: number; w: string };
    const set = this.listeners.get(w);
    if ((!set || set.size === 0) && this.allListeners.size === 0) return;
    const [row] = await this.db.db.select().from(events).where(eq(events.id, id));
    if (!row) return;
    const stored = toStored(row);
    for (const fn of set ?? []) fn(stored);
    for (const fn of this.allListeners) fn(w, stored);
  }
}
