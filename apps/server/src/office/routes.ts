import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody, ZONES } from "@northbot/shared";
import { AgentParams } from "../agents/routes.js";
import { me } from "../auth/guard.js";
import { agents, tasks } from "../db/schema.js";
import type { Services } from "../services.js";

const Ok = z.object({ ok: z.boolean() });

/**
 * Playful office interactions. They are cosmetic: none of them deletes anything, grants a
 * permission or spends money. Lifting a busy agent only pauses its task at the next safe point.
 */
export const officeRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["office"];
  app.addHook("preHandler", s.auth);

  const find = async (workspaceId: string, id: string) => (await s.db.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId))))[0];
  const ref = (a: { workspaceId: string; id: string }) => ({ workspaceId: a.workspaceId, agentId: a.id });

  app.post(
    "/agents/:id/lift",
    {
      schema: {
        tags,
        description: "Pick an agent up. A busy agent pauses at its next safe point (and is a bit annoyed) until it is dropped.",
        params: AgentParams,
        response: { 200: z.object({ ok: z.boolean(), pausedTaskId: z.string().uuid().nullable() }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const agent = await find(m.workspaceId, req.params.id);
      if (!agent) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      s.computers.hold(ref(agent));
      const taskId = await s.tasks.activeTaskOf(agent.id);
      await s.events.write(m.workspaceId, { type: "agent.lifted", agentId: agent.id, payload: { userId: m.userId, taskId } });
      if (taskId) await s.events.write(m.workspaceId, { type: "agent.interrupted", agentId: agent.id, payload: { taskId, how: "picked_up", userId: m.userId } });
      return { ok: true, pausedTaskId: taskId };
    },
  );

  app.post(
    "/agents/:id/drop",
    {
      schema: {
        tags,
        description: "Put a lifted agent down in a room. desk: back to work. break_room: rest (its computer hibernates when it has no task). Others just move it.",
        params: AgentParams,
        body: z.object({ zone: z.enum(ZONES) }),
        response: { 200: z.object({ ok: z.boolean(), rested: z.boolean() }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const agent = await find(m.workspaceId, req.params.id);
      if (!agent) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      s.computers.unhold(ref(agent));
      await s.events.write(m.workspaceId, { type: "agent.dropped", agentId: agent.id, payload: { userId: m.userId, zone: req.body.zone } });
      let rested = false;
      if (req.body.zone === "break_room" && !(await s.tasks.activeTaskOf(agent.id)) && (await s.computers.state(ref(agent))) === "running") {
        await s.computers.hibernate(ref(agent), "Sent to the break room");
        rested = true;
      }
      return { ok: true, rested };
    },
  );

  app.post(
    "/agents/:id/shake",
    {
      schema: { tags, description: "Shake an agent: it gets dizzy, and a sleeping computer wakes up.", params: AgentParams, response: { 200: z.object({ ok: z.boolean(), woke: z.boolean() }), 404: ErrorBody } },
    },
    async (req, reply) => {
      const m = me(req);
      const agent = await find(m.workspaceId, req.params.id);
      if (!agent) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      const woke = await s.computers.ensureAwake(ref(agent), "shaken awake in the office");
      await s.events.write(m.workspaceId, { type: "agent.shaken", agentId: agent.id, payload: { userId: m.userId, woke } });
      return { ok: true, woke };
    },
  );

  app.post(
    "/agents/:id/cookie",
    {
      schema: {
        tags,
        description: "Give a cookie: hearts in the office, and a \"good job\" on the agent's last finished task.",
        params: AgentParams,
        response: { 200: Ok.extend({ taskId: z.string().uuid().nullable() }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const agent = await find(m.workspaceId, req.params.id);
      if (!agent) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      const [last] = await s.db.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.agentId, agent.id), eq(tasks.status, "done")))
        .orderBy(desc(tasks.finishedAt))
        .limit(1);
      await s.events.write(m.workspaceId, { type: "agent.cheered", agentId: agent.id, payload: { how: "cookie", userId: m.userId } });
      if (last) await s.events.write(m.workspaceId, { type: "feedback.good_job", agentId: agent.id, payload: { taskId: last.id, note: "A cookie from the office.", userId: m.userId } });
      return { ok: true, taskId: last?.id ?? null };
    },
  );
};
