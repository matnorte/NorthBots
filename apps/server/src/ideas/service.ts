import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { ExtraTool } from "@northbot/agent-runtime";
import type { DbHandle } from "../db/client.js";
import { agents, events, facts, ideas, notifications } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { MemoryService } from "../memory/service.js";
import { readSettings } from "../settings/routes.js";
import type { TaskService } from "../tasks/service.js";

/** When a binned idea should come back. Recorded at toss time. */
export const IdeaTrigger = z.discriminatedUnion("kind", [
  /** On or after a date. */
  z.object({ kind: z.literal("after"), at: z.string().datetime() }),
  /** When the workspace learns something like this (a new memory). */
  z.object({ kind: z.literal("memory"), text: z.string().min(3).max(500) }),
  /** When an event of this type happens (optionally mentioning some text). */
  z.object({ kind: z.literal("event"), type: z.string().min(3).max(80), contains: z.string().max(200).optional() }),
]);
export type IdeaTrigger = z.infer<typeof IdeaTrigger>;
type IdeaRow = typeof ideas.$inferSelect;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "when", "from", "have", "has", "our", "are", "was", "will", "into", "about", "a", "an", "of", "to", "in", "on", "we", "is"]);
const keywords = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP.has(w));

export function describeTrigger(t: IdeaTrigger | null): string | null {
  if (!t) return null;
  if (t.kind === "after") return `after ${t.at.slice(0, 10)}`;
  if (t.kind === "memory") return `when we learn: ${t.text}`;
  return `when ${t.type} happens${t.contains ? ` mentioning "${t.contains}"` : ""}`;
}

/**
 * The idea bin. Agents (or people) toss ideas that are not right yet; they wait for 30 days by
 * default. Anyone can restore one, and the bin-picker restores those whose trigger came true.
 */
export class IdeaService {
  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly memory: MemoryService,
    tasks: TaskService,
  ) {
    tasks.provideTools((ctx) => [this.tossTool(ctx)]);
  }

  async toss(input: { workspaceId: string; agentId: string | null; title: string; reason: string; trigger?: IdeaTrigger | null; sourceTaskId?: string | null }): Promise<IdeaRow> {
    const { ideaBinDays } = await readSettings(this.db, input.workspaceId);
    const [row] = await this.db.db
      .insert(ideas)
      .values({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        title: input.title.slice(0, 200),
        reason: input.reason.slice(0, 2000),
        trigger: (input.trigger ?? null) as Record<string, unknown> | null,
        sourceTaskId: input.sourceTaskId ?? null,
        expiresAt: new Date(Date.now() + ideaBinDays * 86_400_000),
      })
      .returning();
    if (!row) throw new Error("idea insert failed");
    await this.events.write(input.workspaceId, {
      type: "idea.tossed",
      agentId: input.agentId,
      payload: { ideaId: row.id, title: row.title, trigger: describeTrigger(input.trigger ?? null) },
    });
    return row;
  }

  async list(workspaceId: string, status?: string): Promise<IdeaRow[]> {
    const conds = [eq(ideas.workspaceId, workspaceId)];
    if (status) conds.push(eq(ideas.status, status));
    return this.db.db.select().from(ideas).where(and(...conds)).orderBy(desc(ideas.tossedAt)).limit(200);
  }

  async restore(workspaceId: string, id: string, by: string, note: string): Promise<IdeaRow | null> {
    const [row] = await this.db.db
      .update(ideas)
      .set({ status: "restored", restoredAt: new Date(), restoredBy: by, restoreNote: note })
      .where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId), eq(ideas.status, "binned")))
      .returning();
    if (!row) return null;
    await this.events.write(workspaceId, { type: "idea.restored", agentId: row.agentId, payload: { ideaId: row.id, by, note } });
    await this.db.db.insert(notifications).values({ workspaceId, agentId: row.agentId, kind: "idea.restored", body: `An idea is back from the bin: "${row.title}". ${note}` });
    if (row.agentId) {
      await this.memory.add({ workspaceId, agentId: row.agentId, text: `My idea "${row.title}" came back from the bin: ${note}`, source: `idea ${row.id}` });
    }
    return row;
  }

  /** Has the trigger come true since the idea was tossed? Returns why, or null. */
  async triggered(idea: IdeaRow): Promise<string | null> {
    const parsed = IdeaTrigger.safeParse(idea.trigger);
    if (!parsed.success) return null;
    const t = parsed.data;
    if (t.kind === "after") return Date.now() >= Date.parse(t.at) ? `It is now after ${t.at.slice(0, 10)}.` : null;
    if (t.kind === "memory") {
      const words = keywords(t.text);
      const recent = await this.db.db
        .select({ text: facts.text })
        .from(facts)
        .where(and(eq(facts.workspaceId, idea.workspaceId), gt(facts.createdAt, idea.tossedAt), sql`${facts.source} is distinct from ${`idea ${idea.id}`}`))
        .orderBy(asc(facts.createdAt))
        .limit(500);
      for (const f of recent) {
        const have = new Set(keywords(f.text));
        const allWords = words.length > 0 && words.every((w) => have.has(w));
        if (allWords || (await this.memory.similarity(t.text, f.text)) >= 0.6) return `We learned: "${f.text}".`;
      }
      return null;
    }
    const conds = [eq(events.workspaceId, idea.workspaceId), eq(events.type, t.type), gt(events.ts, idea.tossedAt)];
    if (t.contains) conds.push(sql`${events.payload}::text ilike ${`%${t.contains.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}`);
    const [hit] = await this.db.db.select({ id: events.id }).from(events).where(and(...conds)).limit(1);
    return hit ? `${t.type} happened (event #${hit.id}).` : null;
  }

  /** The bin-picker: expire old ideas, restore the ones whose trigger came true. */
  async pick(workspaceId?: string): Promise<{ restored: string[]; expired: number }> {
    const scope = workspaceId ? [eq(ideas.workspaceId, workspaceId)] : [];
    const old = await this.db.db
      .update(ideas)
      .set({ status: "expired" })
      .where(and(eq(ideas.status, "binned"), lte(ideas.expiresAt, new Date()), ...scope))
      .returning({ id: ideas.id, workspaceId: ideas.workspaceId, agentId: ideas.agentId });
    for (const o of old) await this.events.write(o.workspaceId, { type: "idea.expired", agentId: o.agentId, payload: { ideaId: o.id } });
    const binned = await this.db.db.select().from(ideas).where(and(eq(ideas.status, "binned"), ...scope));
    const restored: string[] = [];
    for (const idea of binned) {
      const why = await this.triggered(idea);
      if (why && (await this.restore(idea.workspaceId, idea.id, "bin-picker", `Trigger met: ${why}`))) restored.push(idea.id);
    }
    const touched = new Set([...binned.map((i) => i.workspaceId), ...old.map((o) => o.workspaceId), ...(workspaceId ? [workspaceId] : [])]);
    for (const ws of touched) {
      await this.events.write(ws, {
        type: "idea.picker_ran",
        payload: { restored: binned.filter((i) => i.workspaceId === ws && restored.includes(i.id)).length, expired: old.filter((o) => o.workspaceId === ws).length },
      });
    }
    return { restored, expired: old.length };
  }

  /** Tool for agents: put an idea in the bin, with an optional condition for bringing it back. */
  private tossTool(ctx: { workspaceId: string; agentId: string; taskId: string }): ExtraTool {
    return {
      def: {
        name: "toss_idea",
        description:
          "Put an idea that is not right yet into the idea bin instead of dropping it. Say why, and optionally when it should come back (trigger).",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            reason: { type: "string", description: "Why not now." },
            trigger: {
              type: "object",
              description: 'When to bring it back: {"kind":"after","at":ISO date} | {"kind":"memory","text":"..."} | {"kind":"event","type":"...","contains":"..."}',
            },
          },
          required: ["title", "reason"],
        },
      },
      // It only adds a note to NorthBot's own bin.
      kind: "read",
      run: async (args) => {
        const trigger = args.trigger === undefined ? null : IdeaTrigger.safeParse(args.trigger);
        if (trigger && !trigger.success) return { output: `That trigger is not valid: ${trigger.error.issues[0]?.message ?? "unknown shape"}.`, ok: false };
        const title = String(args.title ?? "").trim();
        if (!title) return { output: "An idea needs a title.", ok: false };
        const [agent] = await this.db.db.select({ id: agents.id }).from(agents).where(eq(agents.id, ctx.agentId));
        const idea = await this.toss({
          workspaceId: ctx.workspaceId,
          agentId: agent?.id ?? null,
          title,
          reason: String(args.reason ?? ""),
          trigger: trigger?.data ?? null,
          sourceTaskId: ctx.taskId,
        });
        return { output: `Tossed into the idea bin until ${idea.expiresAt.toISOString().slice(0, 10)}${trigger?.data ? `, or ${describeTrigger(trigger.data)}` : ""}.`, ok: true };
      },
    };
  }
}
