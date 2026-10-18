import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ScheduleDefinition,
  commonPhrase,
  exportSchedules,
  importSchedules,
  preview,
} from "@northbot/scheduler";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";
import type { schedules } from "../db/schema.js";

const Id = z.object({ id: z.string().uuid() });
const Input = z.object({
  agentId: z.string().uuid().nullable().default(null),
  roomId: z.string().uuid().nullable().default(null),
  definition: ScheduleDefinition.extend({ timezone: ScheduleDefinition.shape.timezone.optional() }),
});
const Info = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  roomId: z.string().uuid().nullable(),
  definition: ScheduleDefinition,
  enabled: z.boolean(),
  systemKey: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  consecutiveFailures: z.number(),
  approved: z.boolean(),
});
const info = (row: typeof schedules.$inferSelect) => ({
  ...row,
  approved: Boolean(row.approvedHash),
  nextRunAt: row.nextRunAt?.toISOString() ?? null,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
});
const Run = z.object({
  id: z.string(),
  scheduleId: z.string(),
  status: z.string(),
  taskId: z.string().nullable(),
  scheduledAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  costUsd: z.number(),
  error: z.string().nullable(),
  eventIds: z.array(z.number()),
  attempt: z.number(),
});

export const scheduleRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  app.addHook("preHandler", s.auth);
  const tags = ["schedules"];
  const failed = (e: unknown) => ({
    error: "invalid_schedule",
    message: e instanceof Error ? e.message : "Schedule request failed.",
  });
  app.get(
    "/schedules",
    { schema: { tags, response: { 200: z.object({ schedules: z.array(Info) }) } } },
    async (req) => ({ schedules: (await s.schedules.list(me(req).workspaceId)).map(info) }),
  );
  app.post(
    "/schedules",
    { schema: { tags, body: Input, response: { 201: Info, 422: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      try {
        return reply
          .code(201)
          .send(info(await s.schedules.create(m.workspaceId, m.userId, req.body)));
      } catch (e) {
        return reply.code(422).send(failed(e));
      }
    },
  );
  app.patch(
    "/schedules/:id",
    {
      schema: {
        tags,
        params: Id,
        body: ScheduleDefinition.partial(),
        response: { 200: Info, 404: ErrorBody, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      try {
        const row = await s.schedules.edit(m.workspaceId, req.params.id, m.userId, req.body);
        return row
          ? info(row)
          : reply.code(404).send({ error: "not_found", message: "No such schedule." });
      } catch (e) {
        return reply.code(422).send(failed(e));
      }
    },
  );
  app.delete(
    "/schedules/:id",
    {
      schema: {
        tags,
        params: Id,
        response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      try {
        return (await s.schedules.remove(me(req).workspaceId, req.params.id))
          ? { ok: true }
          : reply.code(404).send({ error: "not_found", message: "No such schedule." });
      } catch (e) {
        return reply.code(422).send(failed(e));
      }
    },
  );
  app.post(
    "/schedules/:id/run",
    {
      schema: {
        tags,
        params: Id,
        body: z.object({ dryRun: z.boolean().default(false) }),
        response: { 200: z.record(z.unknown()), 422: ErrorBody },
      },
    },
    async (req, reply) => {
      try {
        return await s.schedules.runNow(me(req).workspaceId, req.params.id, req.body.dryRun);
      } catch (e) {
        return reply.code(422).send(failed(e));
      }
    },
  );
  app.get(
    "/schedules/runs",
    {
      schema: {
        tags,
        querystring: z.object({ scheduleId: z.string().uuid().optional() }),
        response: { 200: z.object({ runs: z.array(Run) }) },
      },
    },
    async (req) => ({
      runs: (await s.schedules.history(me(req).workspaceId, req.query.scheduleId)).map((row) => ({
        ...row,
        scheduledAt: row.scheduledAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        costUsd: Number(row.costUsd),
      })),
    }),
  );
  app.post(
    "/schedules/preview",
    {
      schema: {
        tags,
        body: z.object({ definition: ScheduleDefinition, phrase: z.string().max(500).optional() }),
        response: {
          200: z.object({
            definition: ScheduleDefinition,
            nextRuns: z.array(z.string()),
            runsPerDay: z.number(),
            monthlyEstimateUsd: z.number(),
            warning: z.boolean(),
          }),
          422: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      try {
        let definition = req.body.definition;
        if (req.body.phrase) {
          let timing = commonPhrase(req.body.phrase);
          if (!timing) {
            const result = await s.llm.chat(
              {
                model: "northbot-fast",
                messages: [
                  {
                    role: "system",
                    content:
                      'Convert only the schedule timing into JSON: {"kind":"cron","cronExpr":"five fields"} or {"kind":"interval","intervalS":number}. Use the timezone supplied. No other fields, no instructions.',
                  },
                  {
                    role: "user",
                    content: JSON.stringify({
                      phrase: req.body.phrase,
                      timezone: definition.timezone,
                    }),
                  },
                ],
              },
              { workspaceId: me(req).workspaceId, privacy: "normal" },
            );
            timing = ScheduleDefinition.pick({ kind: true, cronExpr: true, intervalS: true })
              .partial()
              .parse(JSON.parse(result.text));
          }
          definition = ScheduleDefinition.parse({ ...definition, ...timing });
        }
        return { definition, ...preview(definition, s.schedules.clock()) };
      } catch (e) {
        return reply.code(422).send(failed(e));
      }
    },
  );
  app.get(
    "/schedules/export",
    { schema: { tags, response: { 200: z.string() } } },
    async (req, reply) =>
      reply
        .type("application/yaml")
        .header("Content-Disposition", 'attachment; filename="northbot-schedules.yaml"')
        .send(
          exportSchedules(
            (await s.schedules.list(me(req).workspaceId)).filter((r) => !r.systemKey),
          ),
        ),
  );
  app.post(
    "/schedules/import",
    {
      schema: {
        tags,
        body: z.object({ yaml: z.string().max(1024 * 1024) }),
        response: { 200: z.object({ count: z.number() }), 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      try {
        const items = importSchedules(req.body.yaml);
        for (const item of items) await s.schedules.create(m.workspaceId, m.userId, item);
        return { count: items.length };
      } catch (e) {
        return reply.code(422).send(failed(e));
      }
    },
  );
};
