import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";
import {
  agentPasskeys,
  canaryTokens,
  handoffs,
  securityRecordings,
  users,
  vaultGrants,
} from "../db/schema.js";
export const securityRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["security"],
    id = z.object({ id: z.string().uuid() });
  app.get(
    "/canary/:token",
    {
      schema: { hide: true, params: z.object({ token: z.string().max(100) }) },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req) => {
      await s.data.observe(null, req.params.token);
      return { ok: true };
    },
  );
  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/canary/")) return;
    await s.auth.call(app, req, reply);
    if (reply.sent) return;
    const owner = (
      await s.db.db
        .select()
        .from(users)
        .where(eq(users.id, me(req).userId))
    )[0];
    if (owner?.role !== "owner") return reply.code(403).send({ error: "Owner access required" });
  });
  app.get("/security", { schema: { tags } }, async (req) => {
    const ws = me(req).workspaceId;
    const [grants, passkeys, labels, alerts, egress, pending, canaries] = await Promise.all([
      s.db.db.select().from(vaultGrants).where(eq(vaultGrants.workspaceId, ws)),
      s.db.db.select().from(agentPasskeys).where(eq(agentPasskeys.workspaceId, ws)),
      s.data.labels(ws),
      s.data.alerts(ws),
      s.data.egress(ws),
      s.db.db
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.workspaceId, ws), eq(handoffs.status, "waiting"))),
      s.db.db
        .select({
          id: canaryTokens.id,
          name: canaryTokens.name,
          triggeredAt: canaryTokens.triggeredAt,
        })
        .from(canaryTokens)
        .where(eq(canaryTokens.workspaceId, ws)),
    ]);
    const encrypted =
      (
        await s.db.pool.query<{ count: string }>(
          "select count(*) from facts where workspace_id=$1 and text not like 'nbenc1:%'",
          [ws],
        )
      ).rows[0]?.count === "0";
    const diskRows = await s.db.pool.query<{ encrypted: boolean }>(
      "select encrypted from sandboxes where workspace_id=$1 and state <> 'destroyed'",
      [ws],
    );
    const checks = [
      { key: "memory", ok: encrypted },
      {
        key: "masterKey",
        ok: s.config.NORTHBOT_MASTER_KEY !== "ZGV2LW9ubHktbm9ydGhib3QtbWFzdGVyLWtleS0zMmI=",
      },
      { key: "https", ok: s.config.COOKIE_SECURE },
      { key: "canaries", ok: canaries.length > 0 },
      { key: "grants", ok: grants.every((g) => g.role === "owner" || Boolean(g.expiresAt)) },
      {
        key: "disk",
        ok: s.config.SANDBOX_DISK_ENCRYPTION && diskRows.rows.every((r) => r.encrypted),
      },
    ];
    return {
      resources: (
        await s.db.pool.query<{ id: string; type: string; name: string }>(
          "select id::text,'file' type,name from files where workspace_id=$1 union all select id::text,'agent' type,name from agents where workspace_id=$1 union all select id::text,'memory' type,'Encrypted memory' name from facts where workspace_id=$1",
          [ws],
        )
      ).rows,
      secretNames: (await s.vault.listNames(ws))
        .map((x) => x.name)
        .filter((x) => !/^(AGENT_PASSKEY_|AUDIT_SIGNING_KEY)/.test(x)),
      members: await s.db.db
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.workspaceId, ws)),
      score: Math.round((checks.filter((c) => c.ok).length / checks.length) * 100),
      checks,
      grants,
      passkeys,
      labels,
      alerts,
      egress,
      handoffs: pending,
      canaries,
    };
  });
  app.post(
    "/security/grants",
    {
      schema: {
        tags,
        body: z.object({
          resource: z.string().min(1).max(200),
          subjectKind: z.enum(["user", "agent"]),
          subjectId: z.string().uuid(),
          role: z.enum(["owner", "user", "use-only"]),
          expiresAt: z.string().datetime().nullable(),
        }),
      },
    },
    async (req) =>
      s.grants.grant({
        ...req.body,
        workspaceId: me(req).workspaceId,
        createdBy: me(req).userId,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
      }),
  );
  app.delete("/security/grants/:id", { schema: { tags, params: id } }, async (req) => {
    await s.grants.revoke(me(req).workspaceId, req.params.id, me(req).userId);
    return { ok: true };
  });
  app.post(
    "/security/labels",
    {
      schema: {
        tags,
        body: z.object({
          resourceType: z.enum(["file", "memory", "agent"]),
          resourceId: z.string().uuid(),
          label: z.enum(["public", "private", "secret"]),
          destinations: z.array(z.string().max(300)).max(100).default([]),
        }),
      },
    },
    async (req) =>
      s.data.label(
        me(req).workspaceId,
        req.body.resourceType,
        req.body.resourceId,
        req.body.label,
        req.body.destinations,
      ),
  );
  app.post(
    "/security/canaries",
    { schema: { tags, body: z.object({ name: z.string().min(1).max(100) }) } },
    async (req) => s.data.createCanary(me(req).workspaceId, req.body.name),
  );
  app.post(
    "/security/passkeys",
    {
      schema: {
        tags,
        body: z.object({
          agentId: z.string().uuid(),
          rpId: z.string().min(1).max(250),
          origin: z.string().url(),
          challenge: z.string().regex(/^[A-Za-z0-9_-]{16,1000}$/),
          userHandle: z.string().min(1).max(500),
        }),
      },
    },
    async (req) =>
      s.passkeyVault.register({
        ...req.body,
        workspaceId: me(req).workspaceId,
        ownerId: me(req).userId,
      }),
  );
  app.post(
    "/security/passkeys/:id/connect",
    { schema: { tags, params: id, body: z.object({ agentId: z.string().uuid() }) } },
    async (req) => s.passkeyVault.connect(me(req).workspaceId, req.params.id, req.body.agentId),
  );
  app.post(
    "/security/passkeys/:id/sign",
    {
      schema: {
        tags,
        params: id,
        body: z.object({
          agentId: z.string().uuid(),
          challenge: z.string().regex(/^[A-Za-z0-9_-]{16,1000}$/),
        }),
      },
    },
    async (req) =>
      s.passkeyVault.sign(me(req).workspaceId, req.params.id, req.body.agentId, req.body.challenge),
  );
  app.post(
    "/security/handoffs",
    {
      schema: {
        tags,
        body: z.object({ agentId: z.string().uuid(), reason: z.enum(["login", "2fa", "captcha"]) }),
      },
    },
    async (req) => s.handoffs.open(me(req).workspaceId, req.body.agentId, req.body.reason),
  );
  app.post("/security/handoffs/:id/finish", { schema: { tags, params: id } }, async (req) => {
    await s.handoffs.finish(me(req).workspaceId, req.params.id, me(req).userId);
    return { ok: true };
  });
  app.get("/security/audit", { schema: { tags } }, async (req) => {
    await s.events.write(me(req).workspaceId, {
      type: "security.export",
      payload: { kind: "signed-audit", userId: me(req).userId },
    });
    return s.audit.signedExport(me(req).workspaceId);
  });
  app.get("/security/recordings", { schema: { tags } }, async (req) => ({
    recordings: await s.db.db
      .select()
      .from(securityRecordings)
      .where(eq(securityRecordings.workspaceId, me(req).workspaceId))
      .orderBy(desc(securityRecordings.createdAt))
      .limit(100),
  }));
  app.post(
    "/security/recordings",
    { schema: { tags, body: z.object({ agentId: z.string().uuid() }) } },
    async (req) => {
      const ws = me(req).workspaceId,
        agentId = req.body.agentId;
      if (
        !(
          await s.db.pool.query("select id from agents where id=$1 and workspace_id=$2", [
            agentId,
            ws,
          ])
        ).rowCount
      )
        throw new Error("No such agent");
      const rows = await s.db.pool.query<{
        ts: Date;
        type: string;
        payload: Record<string, unknown>;
      }>(
        "select ts,type,payload from events where workspace_id=$1 and agent_id=$2 and type in ('browser.action','terminal.exec','sandbox.takeover','sandbox.released') order by id desc limit 500",
        [ws, agentId],
      );
      return s.audit.record(
        ws,
        agentId,
        rows.rows.reverse().map((e) => ({
          ts: e.ts.toISOString(),
          kind: String(e.payload.action ?? e.type),
          summary:
            e.type === "browser.action"
              ? String(e.payload.url ?? "")
              : String(e.payload.outputPreview ?? e.type),
        })),
      );
    },
  );
  app.post(
    "/security/person/export",
    { schema: { tags, body: z.object({ query: z.string().min(3).max(200) }) } },
    async (req) => s.audit.personExport(me(req).workspaceId, req.body.query),
  );
  app.post(
    "/security/person/erase",
    {
      schema: {
        tags,
        body: z.object({ query: z.string().min(3).max(200), confirmation: z.literal("ERASE") }),
      },
    },
    async (req) => s.audit.erase(me(req).workspaceId, req.body.query),
  );
  app.get("/security/disks/:id/export", { schema: { tags, params: id } }, async (req) =>
    s.audit.encryptedDisk(me(req).workspaceId, req.params.id, `agent-${req.params.id}.nbenc`),
  );
};
