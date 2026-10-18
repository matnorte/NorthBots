import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody, LoginBody, Me, SignupBody } from "@northbot/shared";
import { users, workspaces } from "../db/schema.js";
import type { Services } from "../services.js";
import { clearSessionCookie, setSessionCookie } from "./cookie.js";
import { me } from "./guard.js";
import { dummyHash, hashPassword, verifyPassword } from "./password.js";
import { SESSION_COOKIE } from "./sessions.js";

export const authRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const limit = { rateLimit: { max: s.config.AUTH_RATE_LIMIT_PER_MIN, timeWindow: "1 minute" } };

  app.post(
    "/auth/signup",
    {
      config: limit,
      schema: { tags: ["auth"], body: SignupBody, response: { 201: Me, 409: ErrorBody } },
    },
    async (req, reply) => {
      const { email, password, workspaceName } = req.body;
      const [existing] = await s.db.db.select().from(users).where(eq(users.email, email));
      if (existing) {
        return reply.code(409).send({ error: "email_taken", message: "That email already has an account." });
      }
      const passwordHash = await hashPassword(password);
      const user = await s.db.db.transaction(async (tx) => {
        const [ws] = await tx
          .insert(workspaces)
          .values({ name: workspaceName ?? "My office" })
          .returning();
        if (!ws) throw new Error("workspace insert failed");
        const [u] = await tx
          .insert(users)
          .values({ workspaceId: ws.id, email, passwordHash })
          .returning();
        if (!u) throw new Error("user insert failed");
        return u;
      });
      await s.events.write(user.workspaceId, { type: "auth.signup", payload: { userId: user.id } });
      const session = await s.sessions.create(user.id);
      setSessionCookie(reply, s.config, session.token, session.expiresAt);
      return reply.code(201).send({ userId: user.id, workspaceId: user.workspaceId, email });
    },
  );

  app.post(
    "/auth/login",
    {
      config: limit,
      schema: { tags: ["auth"], body: LoginBody, response: { 200: Me, 401: ErrorBody } },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const [user] = await s.db.db.select().from(users).where(eq(users.email, email));
      const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash()), password);
      if (!user || !ok) {
        return reply.code(401).send({ error: "bad_credentials", message: "Email or password is wrong." });
      }
      await s.events.write(user.workspaceId, {
        type: "auth.login",
        payload: { userId: user.id, method: "password" },
      });
      const session = await s.sessions.create(user.id);
      setSessionCookie(reply, s.config, session.token, session.expiresAt);
      return { userId: user.id, workspaceId: user.workspaceId, email: user.email };
    },
  );

  app.post(
    "/auth/logout",
    { preHandler: s.auth, schema: { tags: ["auth"], response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req, reply) => {
      const m = me(req);
      const token = req.cookies[SESSION_COOKIE];
      if (token) await s.sessions.destroy(token);
      await s.events.write(m.workspaceId, { type: "auth.logout", payload: { userId: m.userId } });
      clearSessionCookie(reply);
      return { ok: true };
    },
  );

  app.get(
    "/auth/me",
    { preHandler: s.auth, schema: { tags: ["auth"], response: { 200: Me, 401: ErrorBody } } },
    async (req) => me(req),
  );
};
