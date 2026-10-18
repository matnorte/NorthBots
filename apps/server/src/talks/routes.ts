import { and, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { agents, talks } from "../db/schema.js";
import type { Services } from "../services.js";

type TalkRow = typeof talks.$inferSelect;
const TalkInfo = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  title: z.string(),
  question: z.string(),
  presenterAgentId: z.string().uuid(),
  dissenterAgentId: z.string().uuid().nullable(),
  audience: z.array(z.string().uuid()),
  decisionMode: z.string(),
  budgetUsd: z.number(),
  spentUsd: z.number(),
  stage: z.string(),
  deck: z.record(z.unknown()).nullable(),
  qa: z.array(z.record(z.unknown())),
  challenge: z.record(z.unknown()).nullable(),
  votes: z.array(z.record(z.unknown())),
  decision: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
const talkInfo = (t: TalkRow): z.infer<typeof TalkInfo> => ({
  id: t.id,
  roomId: t.roomId,
  title: t.title,
  question: t.question,
  presenterAgentId: t.presenterAgentId,
  dissenterAgentId: t.dissenterAgentId,
  audience: t.audience,
  decisionMode: t.decisionMode,
  budgetUsd: Number(t.budgetUsd),
  spentUsd: Number(t.spentUsd),
  stage: t.stage,
  deck: t.deck,
  qa: t.qa,
  challenge: t.challenge,
  votes: t.votes,
  // A human decision waiting to be recorded is not shown as the decision yet.
  decision: t.decision && !("pending" in t.decision) ? t.decision : null,
  error: t.error,
  createdAt: t.createdAt.toISOString(),
});
const IdParams = z.object({ id: z.string().uuid() });

/** Talks: brief → prepare → present → Q&A → challenge → vote or human decision → record → learn. */
export const talkRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["talks"];
  app.addHook("preHandler", s.auth);

  app.get("/talks", { schema: { tags, response: { 200: z.object({ talks: z.array(TalkInfo) }) } } }, async (req) => ({
    talks: (await s.talks.list(me(req).workspaceId)).map(talkInfo),
  }));

  app.post(
    "/talks",
    {
      schema: {
        tags,
        body: z.object({
          title: z.string().trim().min(2).max(120),
          question: z.string().trim().min(3).max(2000),
          presenterAgentId: z.string().uuid(),
          audience: z.array(z.string().uuid()).min(1).max(12),
          dissenterAgentId: z.string().uuid().nullable().default(null),
          decisionMode: z.enum(["vote", "human"]).default("vote"),
          budgetUsd: z.number().min(0).max(100).default(1),
        }),
        response: { 201: TalkInfo, 400: ErrorBody, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const ids = [...new Set([req.body.presenterAgentId, ...req.body.audience, ...(req.body.dissenterAgentId ? [req.body.dissenterAgentId] : [])])];
      const found = await s.db.db.select({ id: agents.id }).from(agents).where(and(eq(agents.workspaceId, m.workspaceId), inArray(agents.id, ids)));
      if (found.length !== ids.length) return reply.code(404).send({ error: "not_found", message: "An agent was not found." });
      try {
        const talk = await s.talks.create({ workspaceId: m.workspaceId, userId: m.userId, ...req.body });
        return reply.code(201).send(talkInfo(talk));
      } catch (err) {
        return reply.code(400).send({ error: "bad_talk", message: err instanceof Error ? err.message : "Could not start the Talk." });
      }
    },
  );

  app.get("/talks/:id", { schema: { tags, params: IdParams, response: { 200: TalkInfo, 404: ErrorBody } } }, async (req, reply) => {
    const t = await s.talks.get(me(req).workspaceId, req.params.id);
    if (!t) return reply.code(404).send({ error: "not_found", message: "No such Talk." });
    return talkInfo(t);
  });

  app.post(
    "/talks/:id/questions",
    {
      schema: {
        tags,
        description: "Add a human question to the moderator's queue (until Q&A is over).",
        params: IdParams,
        body: z.object({ question: z.string().trim().min(3).max(1000) }),
        response: { 200: z.object({ ok: z.boolean() }), 409: ErrorBody },
      },
    },
    async (req, reply) => {
      if (!(await s.talks.ask(me(req).workspaceId, req.params.id, req.body.question))) {
        return reply.code(409).send({ error: "too_late", message: "Questions are closed for this Talk." });
      }
      return { ok: true };
    },
  );

  app.post(
    "/talks/:id/decide",
    {
      schema: {
        tags,
        description: "Decide a Talk that waits for a human (decision mode human).",
        params: IdParams,
        body: z.object({ decision: z.string().trim().min(1).max(500), rationale: z.string().trim().min(1).max(4000) }),
        response: { 200: z.object({ ok: z.boolean() }), 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      if (!(await s.talks.decide(m.workspaceId, req.params.id, m.userId, req.body.decision, req.body.rationale))) {
        return reply.code(409).send({ error: "not_waiting", message: "This Talk is not waiting for a human decision." });
      }
      return { ok: true };
    },
  );
};
