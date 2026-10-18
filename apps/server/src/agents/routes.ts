import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentInfo, AgentName, AUTONOMY_LEVELS, Avatar, CreateAgentBody, ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { agents, events } from "../db/schema.js";
import { nameMessage, validateName } from "../hatch/naming.js";
import type { Services } from "../services.js";
import { createAgent } from "./create.js";

type Row = typeof agents.$inferSelect;

export function agentInfo(r: Row): AgentInfo {
  return {
    id: r.id,
    name: r.name,
    nameLocked: r.nameLocked,
    avatar: r.avatar,
    persona: r.persona,
    modelPolicy: r.modelPolicy,
    autonomyLevel: r.autonomyLevel as AgentInfo["autonomyLevel"],
    budgetDailyUsd: Number(r.budgetDailyUsd),
    status: r.status as AgentInfo["status"],
    mood: r.mood,
    sandboxId: r.sandboxId,
    createdAt: r.createdAt.toISOString(),
  };
}

export const AgentParams = z.object({ id: z.string().uuid() });

const Patch = z.object({
  name: AgentName.optional(),
  avatar: Avatar.optional(),
  autonomyLevel: z.enum(AUTONOMY_LEVELS).optional(),
  budgetDailyUsd: z.number().positive().max(10_000).optional(),
  moodsEnabled: z.boolean().optional(),
});

const MoodReply = z.object({ mood: z.string(), cause: z.string(), fix: z.string().nullable(), detail: z.record(z.string()) });

export const agentRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["agents"];
  app.addHook("preHandler", s.auth);

  const find = async (workspaceId: string, id: string) =>
    (await s.db.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId))))[0];

  app.post(
    "/agents",
    {
      schema: {
        tags,
        description: "Quick create (no hatching). The name follows the same rules as self-chosen names and is locked.",
        body: CreateAgentBody,
        response: { 201: AgentInfo, 409: ErrorBody, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const check = await validateName(s.db, m.workspaceId, req.body.name);
      if (!check.ok) {
        return reply.code(check.problem === "taken" ? 409 : 422).send({ error: `name_${check.problem}`, message: nameMessage(check.problem) });
      }
      const row = await createAgent(s, m.workspaceId, m.userId, { ...req.body, nameLocked: true });
      return reply.code(201).send(agentInfo(row));
    },
  );

  app.get("/agents", { schema: { tags, response: { 200: z.object({ agents: z.array(AgentInfo) }) } } }, async (req) => {
    const rows = await s.db.db.select().from(agents).where(eq(agents.workspaceId, me(req).workspaceId)).orderBy(asc(agents.createdAt));
    return { agents: rows.map(agentInfo) };
  });

  app.get("/agents/:id", { schema: { tags, params: AgentParams, response: { 200: AgentInfo, 404: ErrorBody } } }, async (req, reply) => {
    const row = await find(me(req).workspaceId, req.params.id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such agent." });
    return agentInfo(row);
  });

  app.patch(
    "/agents/:id",
    {
      schema: {
        tags,
        description: "Change an agent. Giving it a name yourself locks the name (the agent will not rename itself).",
        params: AgentParams,
        body: Patch,
        response: { 200: AgentInfo, 404: ErrorBody, 409: ErrorBody, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const row = await find(m.workspaceId, req.params.id);
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      const { name, budgetDailyUsd, ...rest } = req.body;
      const set: Partial<typeof agents.$inferInsert> = { ...rest };
      if (budgetDailyUsd !== undefined) set.budgetDailyUsd = String(budgetDailyUsd);
      if (name !== undefined && name.trim() !== row.name) {
        const check = await validateName(s.db, m.workspaceId, name, row.id);
        if (!check.ok) {
          return reply.code(check.problem === "taken" ? 409 : 422).send({ error: `name_${check.problem}`, message: nameMessage(check.problem) });
        }
        set.name = name.trim();
        set.nameLocked = true;
      }
      if (Object.keys(set).length === 0) return agentInfo(row);
      const [updated] = await s.db.db.update(agents).set(set).where(eq(agents.id, row.id)).returning();
      if (!updated) throw new Error("agent update failed");
      if (set.name) {
        await s.events.write(m.workspaceId, { type: "agent.renamed", agentId: row.id, payload: { agentId: row.id, from: row.name, to: set.name, userId: m.userId } });
      }
      const changed = Object.keys(req.body).filter((k) => k !== "name");
      if (changed.length) await s.events.write(m.workspaceId, { type: "agent.updated", agentId: row.id, payload: { agentId: row.id, changed, userId: m.userId } });
      return agentInfo(updated);
    },
  );

  app.get("/agents/:id/mood", { schema: { tags, params: AgentParams, response: { 200: MoodReply, 404: ErrorBody } } }, async (req, reply) => {
    const m = me(req);
    const row = await find(m.workspaceId, req.params.id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "No such agent." });
    const [last] = await s.db.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.agentId, row.id), eq(events.type, "agent.mood")))
      .orderBy(desc(events.id))
      .limit(1);
    const p = (last?.payload ?? {}) as Partial<z.infer<typeof MoodReply>>;
    return { mood: p.mood ?? row.mood, cause: p.cause ?? "All good.", fix: p.fix ?? null, detail: p.detail ?? {} };
  });

  app.post(
    "/agents/:id/cheer",
    {
      schema: {
        tags,
        description: "A small kindness (thanks, it's ok, pet, cookie). Purely cosmetic: it never grants permissions or spends money.",
        params: AgentParams,
        body: z.object({ how: z.enum(["thanks", "its_ok", "pet", "cookie"]) }),
        response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const row = await find(m.workspaceId, req.params.id);
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      await s.events.write(m.workspaceId, { type: "agent.cheered", agentId: row.id, payload: { how: req.body.how, userId: m.userId } });
      return { ok: true };
    },
  );

  app.delete(
    "/agents/:id",
    {
      schema: {
        tags,
        description: "Deletes the agent and its computer (disk included). The event history stays.",
        params: AgentParams,
        response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const row = await find(m.workspaceId, req.params.id);
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      await s.computers.destroy({ workspaceId: m.workspaceId, agentId: row.id });
      await s.db.db.delete(agents).where(eq(agents.id, row.id));
      await s.events.write(m.workspaceId, { type: "agent.deleted", agentId: row.id, payload: { agentId: row.id, userId: m.userId } });
      return { ok: true };
    },
  );
};
