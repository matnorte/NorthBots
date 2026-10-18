import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";

export const API_SCOPES = ["llm"] as const;

const KeyInfo = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  dailyBudgetUsd: z.number().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1).default(["llm"]),
  dailyBudgetUsd: z.number().positive().nullable().default(null),
});

type Row = Awaited<ReturnType<Services["apiKeys"]["list"]>>[number];
const info = (r: Row): z.infer<typeof KeyInfo> => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  dailyBudgetUsd: r.dailyBudgetUsd === null ? null : Number(r.dailyBudgetUsd),
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

export const apiKeyRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["settings"];
  app.addHook("preHandler", s.auth);

  app.post(
    "/settings/api-keys",
    {
      schema: {
        tags,
        description: "Creates an API key. The key is shown in this response only.",
        body: CreateBody,
        response: { 201: KeyInfo.extend({ key: z.string() }) },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const { row, key } = await s.apiKeys.create({ ...req.body, workspaceId: m.workspaceId, createdBy: m.userId });
      await s.events.write(m.workspaceId, {
        type: "apikey.created",
        payload: { apiKeyId: row.id, name: row.name, userId: m.userId },
      });
      return reply.code(201).send({ ...info(row), key });
    },
  );

  app.get("/settings/api-keys", { schema: { tags, response: { 200: z.object({ keys: z.array(KeyInfo) }) } } }, async (req) => ({
    keys: (await s.apiKeys.list(me(req).workspaceId)).map(info),
  }));

  app.delete(
    "/settings/api-keys/:id",
    { schema: { tags, params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      if (!(await s.apiKeys.revoke(m.workspaceId, req.params.id))) {
        return reply.code(404).send({ error: "not_found", message: "No active key with that id." });
      }
      await s.events.write(m.workspaceId, { type: "apikey.revoked", payload: { apiKeyId: req.params.id, userId: m.userId } });
      return { ok: true };
    },
  );
};
