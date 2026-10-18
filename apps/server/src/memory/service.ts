import { and, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { checkContradiction, cosine, exportMemory, HashEmbedder, importMemory, type Embedder, type PortableFact } from "@northbot/memory";
import type { DbHandle } from "../db/client.js";
import { agents, facts, notifications } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { LlmService } from "../llm/service.js";

type FactRow = typeof facts.$inferSelect;
export interface FactView {
  id: string;
  agentId: string | null;
  text: string;
  source: string | null;
  /** The event this fact came from (a task report, a Talk decision), if any. */
  sourceEventId: number | null;
  derivedFrom: string[];
  createdAt: string;
  expiresAt: string | null;
  score?: number;
}

const view = (f: FactRow, score?: number): FactView => ({
  id: f.id,
  agentId: f.agentId,
  text: f.text,
  source: f.source,
  sourceEventId: f.sourceEventId,
  derivedFrom: f.derivedFrom,
  createdAt: f.createdAt.toISOString(),
  expiresAt: f.expiresAt?.toISOString() ?? null,
  ...(score === undefined ? {} : { score }),
});

const vec = (v: number[]) => sql`${`[${v.join(",")}]`}::vector`;
const live = () => or(isNull(facts.expiresAt), gt(facts.expiresAt, new Date()));

const EXTRACT_SYSTEM =
  'Extract durable facts worth remembering from this finished task: preferences, names, decisions, numbers, how things are done here. Reply with JSON only: {"facts": [string]} (at most 5, each one short sentence; [] if nothing lasting).';

export class MemoryService {
  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly llm: LlmService,
    readonly embedder: Embedder = new HashEmbedder(),
  ) {}

  /** What an agent can see: its own private facts plus shared ones. */
  private visible(workspaceId: string, agentId: string | null): SQL {
    const scope = agentId ? or(eq(facts.agentId, agentId), isNull(facts.agentId)) : isNull(facts.agentId);
    return and(eq(facts.workspaceId, workspaceId), eq(facts.embeddingModel, this.embedder.model), live(), scope)!;
  }

  async add(input: {
    workspaceId: string;
    agentId: string | null;
    text: string;
    source?: string | null;
    sourceEventId?: number | null;
    derivedFrom?: string[];
    expiresAt?: Date | null;
    id?: string;
    createdAt?: Date;
  }): Promise<FactRow> {
    const [embedding] = await this.embedder.embed([input.text]);
    if (!embedding) throw new Error("embedding failed");
    const [row] = await this.db.db
      .insert(facts)
      .values({
        ...(input.id ? { id: input.id } : {}),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        text: input.text.trim(),
        source: input.source ?? null,
        sourceEventId: input.sourceEventId ?? null,
        derivedFrom: input.derivedFrom ?? [],
        expiresAt: input.expiresAt ?? null,
        embedding,
        embeddingModel: this.embedder.model,
      })
      .returning();
    if (!row) throw new Error("fact insert failed");
    await this.events.write(input.workspaceId, {
      type: "memory.added",
      agentId: input.agentId,
      payload: { factId: row.id, scope: input.agentId ? "private" : "shared", preview: row.text.slice(0, 140), source: row.source },
    });
    await this.alertContradictions(row);
    return row;
  }

  /** Warns (event + notification) when a new fact disagrees with a similar existing one. */
  private async alertContradictions(row: FactRow): Promise<void> {
    const similar = await this.db.db
      .select({ f: facts, score: sql<number>`1 - (${facts.embedding} <=> ${vec(row.embedding)})` })
      .from(facts)
      .where(and(this.visible(row.workspaceId, row.agentId), sql`${facts.id} <> ${row.id}`))
      .orderBy(sql`${facts.embedding} <=> ${vec(row.embedding)}`)
      .limit(5);
    for (const { f, score } of similar) {
      if (Number(score) < 0.45) break;
      const check = checkContradiction(row.text, f.text);
      if (!check.contradicts) continue;
      const description = `"${row.text}" vs "${f.text}": ${check.reason}.`;
      await this.events.write(row.workspaceId, { type: "memory.contradiction", agentId: row.agentId, payload: { factIds: [row.id, f.id], description } });
      await this.db.db.insert(notifications).values({ workspaceId: row.workspaceId, agentId: row.agentId, kind: "memory.contradiction", body: `Two memories disagree: ${description}` });
      return;
    }
  }

  async search(workspaceId: string, agentId: string | null, query: string, k = 10, minScore = 0): Promise<FactView[]> {
    const [q] = await this.embedder.embed([query]);
    if (!q) return [];
    const rows = await this.db.db
      .select({ f: facts, score: sql<number>`1 - (${facts.embedding} <=> ${vec(q)})` })
      .from(facts)
      .where(this.visible(workspaceId, agentId))
      .orderBy(sql`${facts.embedding} <=> ${vec(q)}`)
      .limit(k);
    return rows.filter((r) => Number(r.score) >= minScore).map((r) => view(r.f, Number(Number(r.score).toFixed(4))));
  }

  /** How well a text matches one agent's own (private) memories: the best similarity, 0 if none. */
  async privateMatch(workspaceId: string, agentId: string, text: string): Promise<{ score: number; text: string | null }> {
    const [q] = await this.embedder.embed([text]);
    if (!q) return { score: 0, text: null };
    const [row] = await this.db.db
      .select({ text: facts.text, score: sql<number>`1 - (${facts.embedding} <=> ${vec(q)})` })
      .from(facts)
      .where(and(eq(facts.workspaceId, workspaceId), eq(facts.agentId, agentId), eq(facts.embeddingModel, this.embedder.model), live()))
      .orderBy(sql`${facts.embedding} <=> ${vec(q)}`)
      .limit(1);
    return row ? { score: Math.max(0, Number(row.score)), text: row.text } : { score: 0, text: null };
  }

  /** Similarity between two texts with the memory embedder (0..1). */
  async similarity(a: string, b: string): Promise<number> {
    const [x, y] = await this.embedder.embed([a, b]);
    return x && y ? Math.max(0, cosine(x, y)) : 0;
  }

  async list(workspaceId: string, filter: { agentId?: string | null; scope?: "private" | "shared" | "all" } = {}): Promise<FactView[]> {
    const conds: SQL[] = [eq(facts.workspaceId, workspaceId), live()!];
    if (filter.scope === "shared") conds.push(isNull(facts.agentId));
    if (filter.agentId) conds.push(eq(facts.agentId, filter.agentId));
    const rows = await this.db.db.select().from(facts).where(and(...conds)).orderBy(desc(facts.createdAt)).limit(500);
    return rows.map((r) => view(r));
  }

  async update(workspaceId: string, id: string, text: string, userId: string): Promise<FactView | null> {
    const [embedding] = await this.embedder.embed([text]);
    if (!embedding) return null;
    const [row] = await this.db.db
      .update(facts)
      .set({ text: text.trim(), embedding, embeddingModel: this.embedder.model })
      .where(and(eq(facts.id, id), eq(facts.workspaceId, workspaceId)))
      .returning();
    if (!row) return null;
    await this.events.write(workspaceId, { type: "memory.updated", agentId: row.agentId, payload: { factId: id, userId } });
    return view(row);
  }

  /** Forgets a fact and everything derived only from forgotten facts (repeated to a fixpoint). */
  async forget(workspaceId: string, id: string, userId: string | null): Promise<string[]> {
    const gone = new Set<string>();
    const [first] = await this.db.db.select().from(facts).where(and(eq(facts.id, id), eq(facts.workspaceId, workspaceId)));
    if (!first) return [];
    gone.add(first.id);
    for (;;) {
      const rows = await this.db.db
        .select({ id: facts.id, from: facts.derivedFrom })
        .from(facts)
        .where(and(eq(facts.workspaceId, workspaceId), sql`${facts.derivedFrom} && ${`{${[...gone].join(",")}}`}::uuid[]`));
      const next = rows.filter((r) => !gone.has(r.id) && r.from.length > 0 && r.from.every((f) => gone.has(f)));
      if (next.length === 0) break;
      next.forEach((r) => gone.add(r.id));
    }
    const ids = [...gone];
    await this.db.db.delete(facts).where(and(eq(facts.workspaceId, workspaceId), inArray(facts.id, ids)));
    await this.events.write(workspaceId, { type: "memory.forgotten", agentId: first.agentId, payload: { factIds: ids, userId } });
    return ids;
  }

  /** Re-embeds facts stored by an older embedder (run at startup after an upgrade). */
  async reembedStale(): Promise<number> {
    const stale = await this.db.db.select({ id: facts.id, text: facts.text }).from(facts).where(sql`${facts.embeddingModel} <> ${this.embedder.model}`);
    for (const f of stale) {
      const [embedding] = await this.embedder.embed([f.text]);
      if (embedding) await this.db.db.update(facts).set({ embedding, embeddingModel: this.embedder.model }).where(eq(facts.id, f.id));
    }
    return stale.length;
  }

  async deleteExpired(): Promise<number> {
    const rows = await this.db.db.delete(facts).where(lt(facts.expiresAt, new Date())).returning({ id: facts.id });
    return rows.length;
  }

  async exportAll(workspaceId: string): Promise<Buffer> {
    const rows = await this.db.db
      .select({ f: facts, agentName: agents.name })
      .from(facts)
      .leftJoin(agents, eq(agents.id, facts.agentId))
      .where(eq(facts.workspaceId, workspaceId))
      .orderBy(facts.createdAt, facts.id);
    const out: PortableFact[] = rows.map(({ f, agentName }) => ({
      id: f.id,
      scope: f.agentId ? "private" : "shared",
      agentName: agentName ?? null,
      text: f.text,
      createdAt: f.createdAt.toISOString(),
      expiresAt: f.expiresAt?.toISOString() ?? null,
      derivedFrom: f.derivedFrom,
      source: f.source,
    }));
    return exportMemory(out);
  }

  /** Imports a NorthBot export (ids, links and dates kept), or ChatGPT / Claude / plain facts as shared memory. */
  async importAll(workspaceId: string, data: Buffer, userId: string): Promise<{ count: number; format: string }> {
    const parsed = await importMemory(data);
    const byName = new Map((await this.db.db.select().from(agents).where(eq(agents.workspaceId, workspaceId))).map((a) => [a.name.toLowerCase(), a.id]));
    let count = 0;
    for (const f of parsed.facts) {
      const id = "id" in f ? z.string().uuid().safeParse(f.id).data : undefined;
      if (id && (await this.db.db.select({ id: facts.id }).from(facts).where(eq(facts.id, id))).length) continue;
      const agentId = f.scope === "private" && f.agentName ? (byName.get(f.agentName.toLowerCase()) ?? null) : null;
      await this.add({
        workspaceId,
        agentId,
        text: f.text,
        source: f.source,
        derivedFrom: f.derivedFrom,
        expiresAt: f.expiresAt ? new Date(f.expiresAt) : null,
        createdAt: new Date(f.createdAt),
        ...(id ? { id } : {}),
      });
      count += 1;
    }
    await this.events.write(workspaceId, { type: "memory.imported", payload: { count, format: parsed.format, userId } });
    return { count, format: parsed.format };
  }

  /** Context for a task: the agent's most relevant memories. */
  async contextFor(workspaceId: string, agentId: string, goal: string): Promise<string> {
    const found = await this.search(workspaceId, agentId, goal, 5, 0.3);
    if (found.length === 0) return "";
    return `Things you remember (they may be out of date):\n${found.map((f) => `- ${f.text}`).join("\n")}`;
  }

  /** After a task: ask a cheap model for lasting facts and keep them as private memory. */
  async learnFromTask(input: { workspaceId: string; agentId: string; taskId: string; goal: string; report: string; reportEventId: number | null; model: string }) {
    const res = await this.llm.chat(
      { model: input.model, messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: `Task: ${input.goal}\n\nReport:\n${input.report}` }] },
      { workspaceId: input.workspaceId, agentId: input.agentId, taskId: input.taskId, privacy: "normal" },
    );
    const start = res.text.indexOf("{");
    const parsed = z.object({ facts: z.array(z.string().min(3).max(500)).max(5) }).safeParse((() => {
      try {
        return JSON.parse(res.text.slice(start, res.text.lastIndexOf("}") + 1));
      } catch {
        return null;
      }
    })());
    if (!parsed.success) return [];
    const added = [];
    for (const text of parsed.data.facts) {
      const dupe = (await this.search(input.workspaceId, input.agentId, text, 1, 0.92))[0];
      if (dupe) continue;
      added.push(await this.add({ workspaceId: input.workspaceId, agentId: input.agentId, text, source: `task ${input.taskId}`, sourceEventId: input.reportEventId }));
    }
    return added;
  }
}
