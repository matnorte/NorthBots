import type { FastifyReply } from "fastify";
import type { Config } from "../config.js";
import { SESSION_COOKIE } from "./sessions.js";

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expires: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.COOKIE_SECURE,
    path: "/",
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
