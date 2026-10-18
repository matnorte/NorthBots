import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { notifications } from "../db/schema.js";
import type { Services } from "../services.js";

const NotificationInfo = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  kind: z.string(),
  body: z.string(),
  createdAt: z.string(),
  read: z.boolean(),
});

/** In-app notifications. Ones raised during quiet hours appear when quiet hours end. */
export const notificationRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["notifications"];
  app.addHook("preHandler", s.auth);

  app.get("/notifications", { schema: { tags, response: { 200: z.object({ notifications: z.array(NotificationInfo) }) } } }, async (req) => {
    const rows = await s.db.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspaceId, me(req).workspaceId), lte(notifications.deliverAt, new Date())))
      .orderBy(desc(notifications.deliverAt))
      .limit(50);
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        agentId: n.agentId,
        kind: n.kind,
        body: n.body,
        createdAt: n.createdAt.toISOString(),
        read: n.readAt !== null,
      })),
    };
  });

  app.post(
    "/notifications/:id/read",
    { schema: { tags, params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody } } },
    async (req, reply) => {
      const rows = await s.db.db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, req.params.id), eq(notifications.workspaceId, me(req).workspaceId), isNull(notifications.readAt)))
        .returning({ id: notifications.id });
      if (rows.length === 0) return reply.code(404).send({ error: "not_found", message: "No unread notification with that id." });
      return { ok: true };
    },
  );
};
