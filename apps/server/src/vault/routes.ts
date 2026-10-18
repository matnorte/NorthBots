import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody, PutSecretBody, SecretInfo, SecretName, UseSecretBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";

const Ok = z.object({ ok: z.boolean() });
const NameParams = z.object({ name: SecretName });

/** Vault API: put, list names, delete, use in sandbox. No route ever returns a secret value. */
export const vaultRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["vault"];
  app.addHook("preHandler", s.auth);

  app.put(
    "/vault/secrets",
    { schema: { tags, body: PutSecretBody, response: { 200: SecretInfo.pick({ name: true }) } } },
    async (req) => {
      const m = me(req);
      if (/^(AGENT_PASSKEY_|AUDIT_SIGNING_KEY)/.test(req.body.name)) throw new Error("This name is reserved for vault signing.");
      if(!await s.grants.authorize(m.workspaceId,`secret:${req.body.name}`,"user",m.userId,true))throw new Error("Only an owner can edit this secret");
      await s.vault.put(m.workspaceId, req.body.name, req.body.value);
      await s.events.write(m.workspaceId, {
        type: "vault.secret_stored",
        payload: { name: req.body.name, userId: m.userId },
      });
      return { name: req.body.name };
    },
  );

  app.get(
    "/vault/secrets",
    { schema: { tags, response: { 200: z.object({ secrets: z.array(SecretInfo) }) } } },
    async (req) => {
      const m=me(req);
      const names = await s.vault.listNames(m.workspaceId);
      const list = (await Promise.all(names.map(async row=>await s.grants.authorize(m.workspaceId,`secret:${row.name}`,"user",m.userId,"metadata")?row:null))).filter(row=>row!==null);
      return {
        secrets: list.map((x) => ({
          name: x.name,
          createdAt: x.createdAt.toISOString(),
          updatedAt: x.updatedAt.toISOString(),
        })),
      };
    },
  );

  app.delete(
    "/vault/secrets/:name",
    { schema: { tags, params: NameParams, response: { 200: Ok, 404: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      if(!await s.grants.authorize(m.workspaceId,`secret:${req.params.name}`,"user",m.userId,true))throw new Error("Only an owner can delete this secret");
      if (!(await s.vault.delete(m.workspaceId, req.params.name))) {
        return reply.code(404).send({ error: "not_found", message: "No secret with that name." });
      }
      await s.events.write(m.workspaceId, {
        type: "vault.secret_deleted",
        payload: { name: req.params.name, userId: m.userId },
      });
      return { ok: true };
    },
  );

  app.post(
    "/vault/secrets/:name/use",
    {
      schema: { tags, params: NameParams, body: UseSecretBody, response: { 200: Ok, 404: ErrorBody } },
    },
    async (req, reply) => {
      const m = me(req);
      if(!await s.grants.authorize(m.workspaceId,`secret:${req.params.name}`,"user",m.userId))throw new Error("No access to this secret");
      const used = await s.vault.useInSandbox(m.workspaceId, req.params.name, req.body);
      if (!used) return reply.code(404).send({ error: "not_found", message: "No secret with that name." });
      await s.events.write(m.workspaceId, {
        type: "vault.secret_used",
        payload: { name: req.params.name, sandboxId: req.body.sandboxId, as: req.body.as },
      });
      return { ok: true };
    },
  );
};
