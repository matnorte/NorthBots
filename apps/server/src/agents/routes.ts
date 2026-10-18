import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentInfo, CreateAgentBody, ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { agents } from "../db/schema.js";
import type { Services } from "../services.js";

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

export const agentRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["agents"];
  app.addHook("preHandler", s.auth);

  app.post(
    "/agents",
    { schema: { tags, body: CreateAgentBody, response: { 201: AgentInfo, 409: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      const [taken] = await s.db.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, m.workspaceId), sql`lower(${agents.name}) = lower(${req.body.name})`));
      if (taken) return reply.code(409).send({ error: "name_taken", message: "Another agent already has that name." });
      const [row] = await s.db.db
        .insert(agents)
        .values({ ...req.body, workspaceId: m.workspaceId, budgetDailyUsd: String(req.body.budgetDailyUsd) })
        .returning();
      if (!row) throw new Error("agent insert failed");
      await s.events.write(m.workspaceId, {
        type: "agent.created",
        agentId: row.id,
        payload: { agentId: row.id, name: row.name, userId: m.userId },
      });
      await s.computers.createFor({ workspaceId: m.workspaceId, agentId: row.id });
      const [fresh] = await s.db.db.select().from(agents).where(eq(agents.id, row.id));
      return reply.code(201).send(agentInfo(fresh ?? row));
    },
  );

  app.get("/agents", { schema: { tags, response: { 200: z.object({ agents: z.array(AgentInfo) }) } } }, async (req) => {
    const rows = await s.db.db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, me(req).workspaceId))
      .orderBy(asc(agents.createdAt));
    return { agents: rows.map(agentInfo) };
  });

  app.get(
    "/agents/:id",
    { schema: { tags, params: AgentParams, response: { 200: AgentInfo, 404: ErrorBody } } },
    async (req, reply) => {
      const [row] = await s.db.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, req.params.id), eq(agents.workspaceId, me(req).workspaceId)));
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      return agentInfo(row);
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
      const ref = { workspaceId: m.workspaceId, agentId: req.params.id };
      const [row] = await s.db.db.select().from(agents).where(and(eq(agents.id, ref.agentId), eq(agents.workspaceId, ref.workspaceId)));
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      await s.computers.destroy(ref);
      await s.db.db.delete(agents).where(eq(agents.id, row.id));
      await s.events.write(m.workspaceId, { type: "agent.deleted", agentId: row.id, payload: { agentId: row.id, userId: m.userId } });
      return { ok: true };
    },
  );
};
