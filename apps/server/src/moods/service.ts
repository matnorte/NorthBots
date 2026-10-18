import { and, desc, eq, gte, inArray, min, sql } from "drizzle-orm";
import { computeMood, startOfDayIn, zonedParts, type Mood, type MoodResult, type StoredEvent } from "@northbot/shared";
import type { DbHandle } from "../db/client.js";
import { agents, events, notifications, tasks } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import { readSettings } from "../settings/routes.js";

/** Moods worth a (quiet-hours-aware) notification. Happy moods never ping anyone. */
const NOTIFY: Mood[] = ["impatient", "worried", "overwhelmed", "grumpy", "confused"];
const LOOKBACK_MS = 7 * 3600_000;
/** Mood changes the engine itself causes must not trigger another recompute. */
const IGNORE = new Set(["agent.mood", "notification.created"]);

/** Minutes since midnight of "HH:MM". */
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** When a notification raised at `now` may be delivered, given quiet hours in `tz`. */
export function deliverAfterQuietHours(now: Date, tz: string, quiet: { start: string; end: string } | null): Date {
  if (!quiet) return now;
  const p = zonedParts(now, tz);
  const cur = p.hour * 60 + p.minute;
  const [s, e] = [minutes(quiet.start), minutes(quiet.end)];
  const inQuiet = s <= e ? cur >= s && cur < e : cur >= s || cur < e;
  if (!inQuiet) return now;
  const wait = (e - cur + 24 * 60) % (24 * 60);
  return new Date(now.getTime() + wait * 60_000 - p.second * 1000);
}

export class MoodService {
  private pending = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(tickMs = 60_000): void {
    this.off = this.events.subscribeAll((workspaceId, e: StoredEvent) => {
      if (e.agentId && !IGNORE.has(e.type)) this.schedule(workspaceId, e.agentId);
    });
    this.timer = setInterval(() => void this.tick().catch(() => {}), tickMs);
  }

  stop(): void {
    this.off?.();
    if (this.timer) clearInterval(this.timer);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private schedule(workspaceId: string, agentId: string): void {
    if (this.pending.has(agentId)) return;
    this.pending.set(
      agentId,
      setTimeout(() => {
        this.pending.delete(agentId);
        void this.refresh(workspaceId, agentId).catch(() => {});
      }, 150),
    );
  }

  /** Time-based moods (impatient, sleepy) change without new events. */
  async tick(): Promise<void> {
    const rows = await this.db.db.select({ id: agents.id, ws: agents.workspaceId }).from(agents);
    for (const r of rows) await this.refresh(r.ws, r.id).catch(() => {});
  }

  /** Recomputes one agent's mood; writes `agent.mood` only when it changed. */
  async refresh(workspaceId: string, agentId: string): Promise<MoodResult | null> {
    const [agent] = await this.db.db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return null;
    const settings = await readSettings(this.db, workspaceId);
    const now = this.clock();
    const result: MoodResult =
      settings.moodsEnabled && agent.moodsEnabled ? await this.compute(agent, settings.timezone, now) : { mood: "content", cause: "Moods are off.", fix: null, detail: {} };

    const [last] = await this.db.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.agentId, agentId), eq(events.type, "agent.mood")))
      .orderBy(desc(events.id))
      .limit(1);
    if (last && last.payload.mood === result.mood && last.payload.cause === result.cause) return result;
    if (!last && result.mood === agent.mood && result.mood === "content") return result;

    await this.db.db.update(agents).set({ mood: result.mood }).where(eq(agents.id, agentId));
    await this.events.write(workspaceId, {
      type: "agent.mood",
      agentId,
      payload: { mood: result.mood, cause: result.cause, fix: result.fix, detail: result.detail },
    });
    if (NOTIFY.includes(result.mood) && result.mood !== agent.mood) await this.notify(workspaceId, agent.name, agentId, result, settings, now);
    return result;
  }

  private async compute(agent: typeof agents.$inferSelect, tz: string, now: Date): Promise<MoodResult> {
    const since = new Date(now.getTime() - LOOKBACK_MS);
    const recent = await this.db.db
      .select({ type: events.type, ts: events.ts, payload: events.payload, costUsd: events.costUsd })
      .from(events)
      .where(and(eq(events.agentId, agent.id), gte(events.ts, since), sql`${events.type} <> 'agent.mood'`))
      .orderBy(desc(events.id))
      .limit(1000);
    const [lastAny] = recent.length
      ? []
      : await this.db.db
          .select({ type: events.type, ts: events.ts, payload: events.payload })
          .from(events)
          .where(and(eq(events.agentId, agent.id), sql`${events.type} <> 'agent.mood'`))
          .orderBy(desc(events.id))
          .limit(1);
    const dayStart = startOfDayIn(now, tz);
    const spent = recent.filter((e) => e.type === "llm.call" && e.ts >= dayStart).reduce((s, e) => s + Number(e.costUsd), 0);
    const [queue] = await this.db.db
      .select({ n: sql<number>`count(*)::int`, deadline: min(tasks.deadline) })
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), inArray(tasks.status, ["queued", "running", "waiting_approval"])));
    const evs = (recent.length ? recent : lastAny ? [lastAny] : []).map((e) => ({ type: e.type, ts: e.ts.toISOString(), payload: e.payload }));
    return computeMood({
      now,
      events: evs,
      budgetDailyUsd: Number(agent.budgetDailyUsd),
      spentTodayUsd: spent,
      queueLength: queue?.n ?? 0,
      nextDeadline: queue?.deadline ?? null,
    });
  }

  private async notify(
    workspaceId: string,
    agentName: string,
    agentId: string,
    r: MoodResult,
    settings: { timezone: string; quietHours: { start: string; end: string } | null },
    now: Date,
  ): Promise<void> {
    const deliverAt = deliverAfterQuietHours(now, settings.timezone, settings.quietHours);
    const body = `${agentName}: ${r.cause}`;
    const [row] = await this.db.db.insert(notifications).values({ workspaceId, agentId, kind: `mood.${r.mood}`, body, deliverAt }).returning();
    if (!row) return;
    await this.events.write(workspaceId, {
      type: "notification.created",
      agentId,
      payload: { notificationId: row.id, kind: row.kind, body, deliverAt: deliverAt.toISOString() },
    });
  }
}
