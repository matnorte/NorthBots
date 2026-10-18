import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { PermissionRule } from "@northbot/agent-runtime";
import { ErrorBody } from "@northbot/shared";
import { AgentParams } from "../agents/routes.js";
import { me } from "../auth/guard.js";
import { agents, events, tasks, workspaces } from "../db/schema.js";
import type { Services } from "../services.js";
import { RuleCompileError } from "./rules.js";
import { KillSwitchOnError } from "./service.js";

const TaskInfo = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  goal: z.string(),
  status: z.string(),
  createdBy: z.string(),
  plan: z.array(z.string()).nullable(),
  report: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  costUsd: z.number(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

const IdParams = z.object({ id: z.string().uuid() });
const Ok = z.object({ ok: z.boolean() });

export const taskRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  app.addHook("preHandler", s.auth);

  const info = async (t: typeof tasks.$inferSelect): Promise<z.infer<typeof TaskInfo>> => {
    const [cost] = await s.db.db
      .select({ v: sql<string>`coalesce(sum(${events.costUsd}), 0)` })
      .from(events)
      .where(and(eq(events.workspaceId, t.workspaceId), eq(events.type, "llm.call"), sql`${events.payload}->>'taskId' = ${t.id}`));
    const state = t.state as { plan?: string[] | null } | null;
    return {
      id: t.id,
      agentId: t.agentId,
      goal: t.goal,
      status: t.status,
      createdBy: t.createdBy,
      plan: state?.plan ?? null,
      report: t.report,
      error: t.error,
      costUsd: Number(cost?.v ?? 0),
      createdAt: t.createdAt.toISOString(),
      finishedAt: t.finishedAt?.toISOString() ?? null,
    };
  };

  app.post(
    "/agents/:id/tasks",
    {
      schema: {
        tags: ["tasks"],
        params: AgentParams,
        body: z.object({ goal: z.string().trim().min(1).max(8000), budgetUsd: z.number().positive().max(10_000).optional() }),
        response: { 201: TaskInfo, 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const [agent] = await s.db.db.select().from(agents).where(and(eq(agents.id, req.params.id), eq(agents.workspaceId, m.workspaceId)));
      if (!agent) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      try {
        const { task } = await s.tasks.create({
          workspaceId: m.workspaceId,
          agentId: agent.id,
          goal: req.body.goal,
          by: "user",
          userId: m.userId,
          budgetUsd: req.body.budgetUsd ?? null,
        });
        return reply.code(201).send(await info(task));
      } catch (err) {
        if (err instanceof KillSwitchOnError) return reply.code(409).send({ error: "kill_switch_on", message: err.message });
        throw err;
      }
    },
  );

  app.get(
    "/agents/:id/tasks",
    { schema: { tags: ["tasks"], params: AgentParams, response: { 200: z.object({ tasks: z.array(TaskInfo) }) } } },
    async (req) => {
      const rows = await s.db.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.agentId, req.params.id), eq(tasks.workspaceId, me(req).workspaceId)))
        .orderBy(desc(tasks.createdAt))
        .limit(50);
      return { tasks: await Promise.all(rows.map(info)) };
    },
  );

  app.get("/tasks/:id", { schema: { tags: ["tasks"], params: IdParams, response: { 200: TaskInfo, 404: ErrorBody } } }, async (req, reply) => {
    const [t] = await s.db.db.select().from(tasks).where(and(eq(tasks.id, req.params.id), eq(tasks.workspaceId, me(req).workspaceId)));
    if (!t) return reply.code(404).send({ error: "not_found", message: "No such task." });
    return info(t);
  });

  app.post("/tasks/:id/cancel", { schema: { tags: ["tasks"], params: IdParams, response: { 200: Ok, 404: ErrorBody } } }, async (req, reply) => {
    if (!(await s.tasks.cancel(me(req).workspaceId, req.params.id, me(req).userId))) {
      return reply.code(404).send({ error: "not_found", message: "No running task with that id." });
    }
    return { ok: true };
  });

  app.post(
    "/tasks/:id/feedback",
    {
      schema: {
        tags: ["tasks"],
        description: "correction: the agent got something wrong (it learns, and feels a bit embarrassed). good_job: a thank-you.",
        params: IdParams,
        body: z.object({ kind: z.enum(["correction", "good_job"]), note: z.string().trim().max(2000).default("") }),
        response: { 200: Ok, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const [t] = await s.db.db.select().from(tasks).where(and(eq(tasks.id, req.params.id), eq(tasks.workspaceId, m.workspaceId)));
      if (!t) return reply.code(404).send({ error: "not_found", message: "No such task." });
      await s.events.write(m.workspaceId, {
        type: req.body.kind === "correction" ? "feedback.correction" : "feedback.good_job",
        agentId: t.agentId,
        payload: { taskId: t.id, note: req.body.note, userId: m.userId },
      });
      return { ok: true };
    },
  );

  // ---------- approval inbox ----------
  const ApprovalInfo = z.object({
    id: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    agentName: z.string().nullable(),
    taskId: z.string().uuid().nullable(),
    kind: z.string(),
    summary: z.string(),
    reason: z.string(),
    status: z.string(),
    createdAt: z.string(),
  });

  app.get(
    "/approvals",
    {
      schema: {
        tags: ["approvals"],
        querystring: z.object({ status: z.enum(["pending", "approved", "denied", "cancelled"]).default("pending") }),
        response: { 200: z.object({ approvals: z.array(ApprovalInfo) }) },
      },
    },
    async (req) => ({
      approvals: (await s.approvals.list(me(req).workspaceId, req.query.status)).map(({ approval: a, agentName }) => ({
        id: a.id,
        agentId: a.agentId,
        agentName,
        taskId: a.taskId,
        kind: a.kind,
        summary: a.summary,
        reason: a.reason,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
      })),
    }),
  );

  app.post(
    "/approvals/:id/decide",
    {
      schema: {
        tags: ["approvals"],
        description: "approve_once runs this action; approve_always also adds a rule for the same pattern; deny refuses it.",
        params: IdParams,
        body: z.object({ decision: z.enum(["approve_once", "approve_always", "deny"]) }),
        response: { 200: Ok, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const row = await s.approvals.decide(m.workspaceId, req.params.id, req.body.decision, m.userId);
      if (!row) return reply.code(404).send({ error: "not_found", message: "No pending approval with that id." });
      return { ok: true };
    },
  );

  // ---------- permission rules ----------
  const RuleInfo = z.object({
    id: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    text: z.string(),
    rule: z.record(z.unknown()),
    source: z.string(),
    createdAt: z.string(),
  });

  app.get("/rules", { schema: { tags: ["rules"], response: { 200: z.object({ rules: z.array(RuleInfo) }) } } }, async (req) => ({
    rules: (await s.rules.list(me(req).workspaceId)).map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  }));

  app.post(
    "/rules",
    {
      schema: {
        tags: ["rules"],
        description: "Add a rule in plain language (compiled to JSON by a model) or as JSON.",
        body: z.object({
          text: z.string().trim().min(3).max(500),
          agentId: z.string().uuid().nullable().default(null),
          rule: PermissionRule.omit({ id: true, description: true }).optional(),
        }),
        response: { 201: RuleInfo, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      try {
        const rule = req.body.rule ? { ...req.body.rule, description: req.body.text } : await s.rules.compile(m.workspaceId, req.body.text);
        const row = await s.rules.add({ workspaceId: m.workspaceId, agentId: req.body.agentId, text: req.body.text, rule, source: "user", userId: m.userId });
        return reply.code(201).send({ ...row, createdAt: row.createdAt.toISOString() });
      } catch (err) {
        if (err instanceof RuleCompileError) return reply.code(422).send({ error: "rule_not_understood", message: err.message });
        throw err;
      }
    },
  );

  app.delete("/rules/:id", { schema: { tags: ["rules"], params: IdParams, response: { 200: Ok, 404: ErrorBody } } }, async (req, reply) => {
    const m = me(req);
    if (!(await s.rules.remove(m.workspaceId, req.params.id, m.userId))) {
      return reply.code(404).send({ error: "not_found", message: "No such rule." });
    }
    return { ok: true };
  });

  // ---------- kill switch ----------
  const KillState = z.object({ active: z.boolean(), since: z.string().nullable() });
  const killState = async (workspaceId: string) => {
    const [ws] = await s.db.db.select({ at: workspaces.killSwitchAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    return { active: Boolean(ws?.at), since: ws?.at?.toISOString() ?? null };
  };

  app.get("/kill-switch", { schema: { tags: ["safety"], response: { 200: KillState } } }, async (req) => killState(me(req).workspaceId));

  app.post(
    "/kill-switch",
    {
      schema: {
        tags: ["safety"],
        description: "engage: stop every agent now and refuse new work. release: allow work again.",
        body: z.object({ engage: z.boolean() }),
        response: { 200: KillState.extend({ stoppedTasks: z.number().int() }) },
      },
    },
    async (req) => {
      const m = me(req);
      let stoppedTasks = 0;
      if (req.body.engage) stoppedTasks = await s.tasks.engageKillSwitch(m.workspaceId, m.userId);
      else await s.tasks.releaseKillSwitch(m.workspaceId, m.userId);
      return { ...(await killState(m.workspaceId)), stoppedTasks };
    },
  );
};
