import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { sha256 } from "../auth/sessions.js";
import { agents } from "../db/schema.js";
import type { Services } from "../services.js";
import { ACTIONS, CompanionError } from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const DeviceInfo = z.object({
  id: z.string().uuid(),
  name: z.string(),
  os: z.string(),
  mac: z.string().nullable(),
  power: z.string(),
  folders: z.array(z.string()),
  apps: z.array(z.string()),
  agentId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
const STATUS: Record<CompanionError["code"], number> = {
  not_found: 404,
  offline: 409,
  not_allowed: 403,
  timeout: 504,
  refused: 422,
};

/** The Windows companion: pairing, the device tunnel, and managing paired computers. */
export const companionRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["companion"];

  // ---- Device side (no session: a one-time code, then the device token) ----
  app.post(
    "/companion/pair",
    {
      schema: {
        tags,
        description:
          "Called by the companion app: trade a one-time pairing code for a device token (shown once).",
        body: z.object({
          code: z.string().min(6).max(40),
          deviceName: z.string().max(80).default("Computer"),
          os: z.string().max(20).default(""),
          mac: z.string().max(20).optional(),
        }),
        response: {
          201: z.object({ deviceId: z.string().uuid(), token: z.string() }),
          401: ErrorBody,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const paired = await s.companion.pair(req.body);
      if (!paired)
        return reply
          .code(401)
          .send({ error: "bad_code", message: "That pairing code is wrong, used or expired." });
      return reply.code(201).send(paired);
    },
  );

  app.get(
    "/companion/tunnel",
    {
      websocket: true,
      schema: { tags, hide: true },
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (req) => sha256(req.headers.authorization ?? req.ip),
        },
      },
      preValidation: async (req, reply) => {
        const token = req.headers.authorization?.match(/^Bearer (nbc_[\w-]+)$/)?.[1];
        const device = token ? await s.companion.authenticate(token) : null;
        if (!device)
          return reply
            .code(401)
            .send({ error: "unauthorized", message: "Unknown or revoked device." });
        (req as unknown as { device: typeof device }).device = device;
      },
    },
    (socket, req) => {
      const device = (
        req as unknown as {
          device: NonNullable<Awaited<ReturnType<typeof s.companion.authenticate>>>;
        }
      ).device;
      s.companion.attach(device, socket);
    },
  );

  // ---- People side ----
  await app.register(async (child) => {
    const ui = child.withTypeProvider<ZodTypeProvider>();
    ui.addHook("preHandler", s.auth);
    const view = (
      d: Awaited<ReturnType<typeof s.companion.list>>[number],
    ): z.infer<typeof DeviceInfo> => ({
      id: d.id,
      name: d.name,
      os: d.os,
      mac: d.mac,
      power: d.power,
      folders: d.folders,
      apps: d.apps,
      agentId: d.agentId,
      enabled: d.enabled,
      online: d.online,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    });

    ui.post(
      "/companion/pairings",
      {
        schema: {
          tags,
          description: "A one-time code (10 minutes) to pair a computer.",
          response: { 201: z.object({ code: z.string(), expiresAt: z.string() }) },
        },
      },
      async (req, reply) => {
        const m = me(req);
        return reply.code(201).send(await s.companion.createPairing(m.workspaceId, m.userId));
      },
    );

    ui.get(
      "/companion/devices",
      { schema: { tags, response: { 200: z.object({ devices: z.array(DeviceInfo) }) } } },
      async (req) => ({
        devices: (await s.companion.list(me(req).workspaceId)).map(view),
      }),
    );

    ui.patch(
      "/companion/devices/:id",
      {
        schema: {
          tags,
          description:
            "Rename it, or let one agent use it (off by default). Power, folders and apps are chosen on the computer itself.",
          params: IdParams,
          body: z.object({
            name: z.string().trim().min(1).max(80).optional(),
            agentId: z.string().uuid().nullable().optional(),
            enabled: z.boolean().optional(),
          }),
          response: { 200: DeviceInfo, 404: ErrorBody },
        },
      },
      async (req, reply) => {
        const m = me(req);
        if (req.body.agentId) {
          const [a] = await s.db.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, req.body.agentId), eq(agents.workspaceId, m.workspaceId)));
          if (!a) return reply.code(404).send({ error: "not_found", message: "No such agent." });
        }
        const d = await s.companion.update(m.workspaceId, req.params.id, req.body, m.userId);
        if (!d) return reply.code(404).send({ error: "not_found", message: "No such computer." });
        return view({ ...d, online: s.companion.isOnline(d.id) });
      },
    );

    ui.delete(
      "/companion/devices/:id",
      {
        schema: {
          tags,
          description: "Unpair (the token stops working at once).",
          params: IdParams,
          response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody },
        },
      },
      async (req, reply) => {
        const m = me(req);
        if (!(await s.companion.revoke(m.workspaceId, req.params.id, m.userId)))
          return reply.code(404).send({ error: "not_found", message: "No such computer." });
        return { ok: true };
      },
    );

    ui.post(
      "/companion/devices/:id/command",
      {
        schema: {
          tags,
          description:
            "Run one command on a paired computer yourself (the same checks as agents: power level, shared apps and folders).",
          params: IdParams,
          body: z.object({ action: z.enum(ACTIONS), args: z.record(z.unknown()).default({}) }),
          response: {
            200: z.object({ data: z.unknown() }),
            403: ErrorBody,
            404: ErrorBody,
            409: ErrorBody,
            422: ErrorBody,
            504: ErrorBody,
          },
        },
      },
      async (req, reply) => {
        const m = me(req);
        if (await s.tasks.killSwitchOn(m.workspaceId))
          return reply.code(409).send({ error: "kill_switch", message: "The kill switch is on." });
        try {
          return {
            data: await s.companion.command(
              m.workspaceId,
              req.params.id,
              req.body.action,
              req.body.args,
              { by: "user" },
            ),
          };
        } catch (err) {
          if (!(err instanceof CompanionError)) throw err;
          return reply
            .code(STATUS[err.code] as 403)
            .send({ error: err.code, message: err.message });
        }
      },
    );

    ui.post(
      "/companion/devices/:id/kill",
      { schema: { tags, params: IdParams, response: { 200: z.object({ ok: z.boolean() }) } } },
      async (req) => {
        const m = me(req);
        return { ok: await s.companion.kill(m.workspaceId, req.params.id, m.userId) };
      },
    );

    ui.post(
      "/companion/devices/:id/wake",
      {
        schema: {
          tags,
          description: "Send a Wake-on-LAN packet to the computer's network card.",
          params: IdParams,
          response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody },
        },
      },
      async (req, reply) => {
        const m = me(req);
        if (!(await s.companion.wake(m.workspaceId, req.params.id, m.userId)))
          return reply
            .code(404)
            .send({
              error: "no_mac",
              message: "This computer did not share a network address to wake.",
            });
        return { ok: true };
      },
    );
  });
};
