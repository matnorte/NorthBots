import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { agents, ideas } from "../db/schema.js";
import type { Services } from "../services.js";
import { describeTrigger, IdeaTrigger } from "./service.js";

type IdeaRow = typeof ideas.$inferSelect;
const IdeaInfo = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  title: z.string(),
  reason: z.string(),
  trigger: z.record(z.unknown()).nullable(),
  triggerText: z.string().nullable(),
  status: z.string(),
  tossedAt: z.string(),
  expiresAt: z.string(),
  restoredAt: z.string().nullable(),
  restoredBy: z.string().nullable(),
  restoreNote: z.string().nullable(),
});
const ideaInfo = (i: IdeaRow): z.infer<typeof IdeaInfo> => {
  const t = IdeaTrigger.safeParse(i.trigger);
  return {
    id: i.id,
    agentId: i.agentId,
    title: i.title,
    reason: i.reason,
    trigger: i.trigger,
    triggerText: t.success ? describeTrigger(t.data) : null,
    status: i.status,
    tossedAt: i.tossedAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    restoredAt: i.restoredAt?.toISOString() ?? null,
    restoredBy: i.restoredBy,
    restoreNote: i.restoreNote,
  };
};
const IdParams = z.object({ id: z.string().uuid() });

/** The idea bin: browse, toss, restore, and run the bin-picker now. */
export const ideaRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["ideas"];
  app.addHook("preHandler", s.auth);

  app.get(
    "/ideas",
    { schema: { tags, querystring: z.object({ status: z.enum(["binned", "restored", "expired"]).optional() }), response: { 200: z.object({ ideas: z.array(IdeaInfo) }) } } },
    async (req) => ({ ideas: (await s.ideas.list(me(req).workspaceId, req.query.status)).map(ideaInfo) }),
  );

  app.post(
    "/ideas",
    {
      schema: {
        tags,
        description: "Toss an idea into the bin (for a person, or on behalf of an agent).",
        body: z.object({
          title: z.string().trim().min(2).max(200),
          reason: z.string().max(2000).default(""),
          agentId: z.string().uuid().nullable().default(null),
          trigger: IdeaTrigger.nullable().default(null),
        }),
        response: { 201: IdeaInfo, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      if (req.body.agentId) {
        const [a] = await s.db.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, req.body.agentId), eq(agents.workspaceId, m.workspaceId)));
        if (!a) return reply.code(404).send({ error: "not_found", message: "No such agent." });
      }
      const idea = await s.ideas.toss({ workspaceId: m.workspaceId, ...req.body });
      return reply.code(201).send(ideaInfo(idea));
    },
  );

  app.post(
    "/ideas/:id/restore",
    { schema: { tags, params: IdParams, body: z.object({ note: z.string().max(500).default("") }), response: { 200: IdeaInfo, 404: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      const idea = await s.ideas.restore(m.workspaceId, req.params.id, m.userId, req.body.note || "Restored by a person.");
      if (!idea) return reply.code(404).send({ error: "not_found", message: "No idea in the bin with that id." });
      return ideaInfo(idea);
    },
  );

  app.post(
    "/ideas/pick",
    {
      schema: {
        tags,
        description: "Run the bin-picker now for this workspace (it also runs weekly on its own).",
        response: { 200: z.object({ restored: z.array(z.string().uuid()), expired: z.number().int() }) },
      },
    },
    async (req) => s.ideas.pick(me(req).workspaceId),
  );
};
