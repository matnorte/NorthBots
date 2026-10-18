import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody, Me } from "@northbot/shared";
import type { Services } from "../services.js";
import { setSessionCookie } from "./cookie.js";
import { me } from "./guard.js";
import { Passkeys } from "./passkeys.js";

/** Shape check only; the cryptographic verification is done by @simplewebauthn/server. */
const CredentialJSON = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    response: z.record(z.unknown()),
    clientExtensionResults: z.record(z.unknown()).default({}),
  })
  .passthrough();

const OptionsReply = z.object({
  challengeId: z.string().uuid(),
  options: z.object({ challenge: z.string() }).passthrough(),
});
const VerifyBody = z.object({ challengeId: z.string().uuid(), credential: CredentialJSON });

export const passkeyRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const pk = new Passkeys(s);
  const limit = { rateLimit: { max: s.config.AUTH_RATE_LIMIT_PER_MIN, timeWindow: "1 minute" } };
  const tags = ["auth"];

  app.post(
    "/auth/passkey/register/options",
    { preHandler: s.auth, schema: { tags, response: { 200: OptionsReply } } },
    async (req) => {
      const m = me(req);
      return pk.registrationOptions(m.userId, m.email);
    },
  );

  app.post(
    "/auth/passkey/register/verify",
    {
      preHandler: s.auth,
      schema: {
        tags,
        body: VerifyBody,
        response: { 200: z.object({ credentialId: z.string() }), 400: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const credential = req.body.credential as unknown as RegistrationResponseJSON;
      const id = await pk.verifyRegistration(m.userId, req.body.challengeId, credential).catch(() => null);
      if (!id) return reply.code(400).send({ error: "passkey_rejected", message: "That passkey could not be verified." });
      await s.events.write(m.workspaceId, {
        type: "auth.passkey_added",
        payload: { userId: m.userId, credentialId: id },
      });
      return { credentialId: id };
    },
  );

  app.post(
    "/auth/passkey/login/options",
    { config: limit, schema: { tags, response: { 200: OptionsReply } } },
    async () => pk.loginOptions(),
  );

  app.post(
    "/auth/passkey/login/verify",
    { config: limit, schema: { tags, body: VerifyBody, response: { 200: Me, 401: ErrorBody } } },
    async (req, reply) => {
      const credential = req.body.credential as unknown as AuthenticationResponseJSON;
      const user = await pk.verifyLogin(req.body.challengeId, credential).catch(() => null);
      if (!user) return reply.code(401).send({ error: "passkey_rejected", message: "That passkey did not work." });
      await s.events.write(user.workspaceId, {
        type: "auth.login",
        payload: { userId: user.id, method: "passkey" },
      });
      const session = await s.sessions.create(user.id);
      setSessionCookie(reply, s.config, session.token, session.expiresAt);
      return { userId: user.id, workspaceId: user.workspaceId, email: user.email };
    },
  );
};
