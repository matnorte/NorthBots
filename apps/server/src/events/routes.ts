import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EventPayloads, StoredEvent } from "@northbot/shared";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";
import { streamEvents } from "./feed.js";

const FromQuery = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/** Clients may only write the event types listed in CLIENT_WRITABLE_EVENTS. */
const ClientEvent = z.object({ type: z.literal("user.note"), payload: EventPayloads["user.note"] });

export const eventRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["events"];
  app.addHook("preHandler", s.auth);

  app.get(
    "/events",
    { schema: { tags, querystring: FromQuery, response: { 200: z.object({ events: z.array(StoredEvent) }) } } },
    async (req) => ({
      events: await s.events.list(me(req).workspaceId, req.query.from, req.query.limit),
    }),
  );

  app.post(
    "/events",
    { schema: { tags, body: ClientEvent, response: { 201: StoredEvent } } },
    async (req, reply) => {
      const event = await s.events.write(me(req).workspaceId, req.body);
      return reply.code(201).send(event);
    },
  );

  // WebSocket feed: replay from ?from=<id> (inclusive), then live events.
  app.get(
    "/events/stream",
    { websocket: true, schema: { tags, querystring: FromQuery.pick({ from: true }) } },
    async (socket, req) => {
      const workspaceId = me(req).workspaceId;
      let stop: (() => void) | null = null;
      let closed = false;
      socket.on("close", () => {
        closed = true;
        stop?.();
      });
      stop = await streamEvents(s.events, workspaceId, req.query.from, (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      });
      if (closed) stop();
    },
  );
};
