import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { loadFiles } from "../chat/files.js";
import { agents, letters } from "../db/schema.js";
import type { Services } from "../services.js";
import { KillSwitchOnError } from "../tasks/service.js";
import { LETTER_TYPES } from "./service.js";

type LetterRow = typeof letters.$inferSelect;
const LetterInfo = z.object({
  id: z.string().uuid(),
  type: z.enum(LETTER_TYPES),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(z.object({ id: z.string(), name: z.string(), size: z.number(), mime: z.string() })),
  from: z.object({ kind: z.enum(["user", "agent", "system"]), agentId: z.string().uuid().nullable(), userId: z.string().uuid().nullable() }),
  toAgentId: z.string().uuid().nullable(),
  status: z.string(),
  stamp: z.record(z.unknown()).nullable(),
  replyToId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export const letterInfo = (l: LetterRow): z.infer<typeof LetterInfo> => ({
  id: l.id,
  type: l.type as z.infer<typeof LetterInfo>["type"],
  subject: l.subject,
  body: l.body,
  attachments: l.attachments,
  from: { kind: l.fromKind as "user" | "agent" | "system", agentId: l.fromAgentId, userId: l.fromUserId },
  toAgentId: l.toAgentId,
  status: l.status,
  stamp: l.stamp,
  replyToId: l.replyToId,
  taskId: l.taskId,
  createdAt: l.createdAt.toISOString(),
  readAt: l.readAt?.toISOString() ?? null,
});
const IdParams = z.object({ id: z.string().uuid() });

/** Letters: write one and the mail agent routes it; replies come back as letters. */
export const letterRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["letters"];
  app.addHook("preHandler", s.auth);

  app.post(
    "/letters",
    {
      schema: {
        tags,
        description: "Send a letter. Without toAgentId the mail agent scores every agent and routes it (see the stamp).",
        body: z.object({
          type: z.enum(LETTER_TYPES),
          subject: z.string().max(200).default(""),
          body: z.string().trim().min(1).max(20_000),
          attachments: z.array(z.string().uuid()).max(10).default([]),
          toAgentId: z.string().uuid().nullable().default(null),
        }),
        response: { 201: LetterInfo, 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      if (req.body.toAgentId) {
        const [a] = await s.db.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, req.body.toAgentId), eq(agents.workspaceId, m.workspaceId)));
        if (!a) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      }
      const files = await loadFiles(s.db, m.workspaceId, req.body.attachments);
      if (files.length !== req.body.attachments.length) return reply.code(404).send({ error: "not_found", message: "An attachment was not found." });
      try {
        const letter = await s.mail.send({
          workspaceId: m.workspaceId,
          type: req.body.type,
          subject: req.body.subject,
          body: req.body.body,
          attachments: files.map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })),
          from: { kind: "user", userId: m.userId },
          toAgentId: req.body.toAgentId,
        });
        return reply.code(201).send(letterInfo(letter));
      } catch (err) {
        if (err instanceof KillSwitchOnError) return reply.code(409).send({ error: "kill_switch", message: err.message });
        throw err;
      }
    },
  );

  app.get(
    "/letters",
    {
      schema: {
        tags,
        querystring: z.object({ status: z.string().max(20).optional(), agentId: z.string().uuid().optional() }),
        response: { 200: z.object({ letters: z.array(LetterInfo) }) },
      },
    },
    async (req) => ({ letters: (await s.mail.list(me(req).workspaceId, req.query)).map(letterInfo) }),
  );

  app.get("/letters/:id", { schema: { tags, params: IdParams, response: { 200: LetterInfo.extend({ replies: z.array(LetterInfo) }), 404: ErrorBody } } }, async (req, reply) => {
    const m = me(req);
    const [l] = await s.db.db.select().from(letters).where(and(eq(letters.id, req.params.id), eq(letters.workspaceId, m.workspaceId)));
    if (!l) return reply.code(404).send({ error: "not_found", message: "No such letter." });
    const replies = await s.db.db.select().from(letters).where(eq(letters.replyToId, l.id));
    return { ...letterInfo(l), replies: replies.map(letterInfo) };
  });

  app.post(
    "/letters/:id/assign",
    {
      schema: {
        tags,
        description: "For a letter the mail agent could not place: a human picks who handles it.",
        params: IdParams,
        body: z.object({ agentId: z.string().uuid() }),
        response: { 200: LetterInfo, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const l = await s.mail.assign(me(req).workspaceId, req.params.id, req.body.agentId);
      if (!l) return reply.code(404).send({ error: "not_found", message: "No letter waiting for a human with that id, or no such agent." });
      return letterInfo(l);
    },
  );

  app.post("/letters/:id/read", { schema: { tags, params: IdParams, response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const rows = await s.db.db
      .update(letters)
      .set({ readAt: new Date() })
      .where(and(eq(letters.id, req.params.id), eq(letters.workspaceId, me(req).workspaceId), isNull(letters.readAt)))
      .returning({ id: letters.id });
    return { ok: rows.length > 0 };
  });
};
