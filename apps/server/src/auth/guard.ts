import type { FastifyReply, FastifyRequest } from "fastify";
import type { Me } from "@northbot/shared";
import { SESSION_COOKIE, type SessionStore } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    me: Me | null;
  }
}

/** preHandler that rejects requests without a valid session cookie and sets `req.me`. */
export function requireAuth(store: SessionStore) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = req.cookies[SESSION_COOKIE];
    const me = token ? await store.resolve(token) : null;
    if (!me) {
      await reply.code(401).send({ error: "unauthorized", message: "Please sign in." });
      return;
    }
    req.me = me;
  };
}

/** Narrows `req.me` inside handlers that run after `requireAuth`. */
export function me(req: FastifyRequest): Me {
  if (!req.me) throw new Error("requireAuth must run before this handler");
  return req.me;
}
