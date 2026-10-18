import multipart from "@fastify/multipart";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { agents } from "../db/schema.js";
import type { Services } from "../services.js";

const Fact = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  text: z.string(),
  source: z.string().nullable(),
  sourceEventId: z.number().int().nullable(),
  derivedFrom: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  score: z.number().optional(),
});
const IdParams = z.object({ id: z.string().uuid() });

/** Memory: browse and search, add, edit, forget (with derived facts), export and import. */
export const memoryRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["memory"];
  app.addHook("preHandler", s.auth);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  const ownsAgent = async (workspaceId: string, agentId: string | null | undefined) =>
    !agentId || (await s.db.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))).length > 0;

  app.get(
    "/memory",
    {
      schema: {
        tags,
        description: "With q: the most relevant facts (an agent sees its private facts plus shared ones). Without q: the newest facts.",
        querystring: z.object({ q: z.string().max(500).optional(), agentId: z.string().uuid().optional(), scope: z.enum(["private", "shared", "all"]).default("all") }),
        response: { 200: z.object({ facts: z.array(Fact) }) },
      },
    },
    async (req) => {
      const m = me(req);
      const { q, agentId, scope } = req.query;
      if (!(await ownsAgent(m.workspaceId, agentId))) return { facts: [] };
      const facts = q ? await s.memory.search(m.workspaceId, agentId ?? null, q, 20) : await s.memory.list(m.workspaceId, { agentId, scope });
      return { facts };
    },
  );

  app.post(
    "/memory",
    {
      schema: {
        tags,
        body: z.object({ text: z.string().trim().min(2).max(4000), agentId: z.string().uuid().nullable().default(null), expiresAt: z.string().datetime().nullable().default(null) }),
        response: { 201: Fact, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      if (!(await ownsAgent(m.workspaceId, req.body.agentId))) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      const row = await s.memory.add({
        workspaceId: m.workspaceId,
        agentId: req.body.agentId,
        text: req.body.text,
        source: "added by a human",
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
      });
      return reply.code(201).send({
        id: row.id,
        agentId: row.agentId,
        text: row.text,
        source: row.source,
        sourceEventId: row.sourceEventId,
        derivedFrom: row.derivedFrom,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
      });
    },
  );

  app.patch(
    "/memory/:id",
    { schema: { tags, params: IdParams, body: z.object({ text: z.string().trim().min(2).max(4000) }), response: { 200: Fact, 404: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      const f = await s.memory.update(m.workspaceId, req.params.id, req.body.text, m.userId);
      if (!f) return reply.code(404).send({ error: "not_found", message: "No such memory." });
      return f;
    },
  );

  app.delete(
    "/memory/:id",
    {
      schema: {
        tags,
        description: "Forget a fact, plus every fact derived only from forgotten facts.",
        params: IdParams,
        response: { 200: z.object({ forgotten: z.array(z.string()) }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const forgotten = await s.memory.forget(m.workspaceId, req.params.id, m.userId);
      if (forgotten.length === 0) return reply.code(404).send({ error: "not_found", message: "No such memory." });
      return { forgotten };
    },
  );

  app.get("/memory/export", { schema: { tags, description: "A zip with memory.json (exact) and readable markdown." } }, async (req, reply) => {
    const zip = await s.memory.exportAll(me(req).workspaceId);
    return reply.header("content-type", "application/zip").header("content-disposition", 'attachment; filename="northbot-memory.zip"').send(zip);
  });

  app.post(
    "/memory/import",
    {
      schema: {
        tags,
        description: "Upload (field `file`): a NorthBot export, a ChatGPT or Claude export (conversations.json or the zip), or a list of facts.",
        response: { 200: z.object({ count: z.number().int(), format: z.string() }), 400: ErrorBody, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "no_file", message: "Send a multipart field named `file`." });
      try {
        return await s.memory.importAll(m.workspaceId, await part.toBuffer(), m.userId);
      } catch (err) {
        return reply.code(422).send({ error: "bad_import", message: err instanceof Error ? err.message : "Could not read that file." });
      }
    },
  );
};
