import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { FakeOAuthProvider, McpConfig, ToolPolicy } from "@northbot/mcp";
import { me } from "../auth/guard.js";
import { sha256 } from "../auth/sessions.js";
import type { Services } from "../services.js";
import { mcpAssignments, mcpServers } from "../db/schema.js";
import { northbotMcpServer } from "./server.js";
export const mcpRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  app.post(
    "/mcp",
    {
      schema: { hide: true },
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: (req) => sha256(req.headers.authorization ?? req.ip),
        },
      },
    },
    async (req, reply) => {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const principal = token ? await s.apiKeys.authenticate(token) : null;
      if (!principal || !principal.scopes.some((x) => x.startsWith("mcp:")))
        return reply.code(401).send({ error: "A scoped MCP token is required" });
      if (req.headers.origin && req.headers.origin !== s.config.WEB_ORIGIN)
        return reply.code(403).send({ error: "Origin is not allowed" });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = northbotMcpServer(s, principal);
      await server.connect(transport);
      reply.hijack();
      try {
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } finally {
        await server.close();
      }
    },
  );
  await app.register(async (child) => {
    const ui = child.withTypeProvider<ZodTypeProvider>();
    ui.addHook("preHandler", s.auth);
    const tags = ["mcp"];
    const params = z.object({ id: z.string().uuid() });
    ui.get("/mcp/servers", { schema: { tags } }, async (req) => ({
      servers: await s.db.db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.workspaceId, me(req).workspaceId)),
    }));
    ui.post(
      "/mcp/servers",
      {
        schema: {
          tags,
          body: z.object({ name: z.string().trim().min(1).max(80), config: McpConfig }),
        },
      },
      async (req, reply) => {
        const [row] = await s.db.db
          .insert(mcpServers)
          .values({ ...req.body, workspaceId: me(req).workspaceId })
          .returning();
        return reply.code(201).send(row);
      },
    );
    ui.get("/mcp/servers/:id/assignments", { schema: { tags, params } }, async (req) => {
      if (!(await s.mcp.server(me(req).workspaceId, req.params.id)))
        throw new Error("No such server");
      return {
        assignments: await s.db.db
          .select()
          .from(mcpAssignments)
          .where(eq(mcpAssignments.serverId, req.params.id)),
      };
    });
    ui.post(
      "/mcp/servers/:id/review",
      {
        schema: {
          tags,
          params,
          body: z.object({
            agentId: z.string().uuid(),
            approveHash: z.string().optional(),
            policies: z.record(ToolPolicy).optional(),
          }),
        },
      },
      async (req, reply) => {
        try {
          return await s.mcp.review(
            me(req).workspaceId,
            req.params.id,
            req.body.agentId,
            req.body.approveHash,
            req.body.policies,
          );
        } catch (e) {
          return reply.code(400).send({ error: e instanceof Error ? e.message : "Review failed" });
        }
      },
    );
    ui.delete("/mcp/servers/:id", { schema: { tags, params } }, async (req, reply) => {
      if (!(await s.mcp.server(me(req).workspaceId, req.params.id)))
        return reply.code(404).send({ error: "Not found" });
      await s.db.db.delete(mcpServers).where(eq(mcpServers.id, req.params.id));
      return { ok: true };
    });
    const provider = new FakeOAuthProvider();
    const pending = new Map<
      string,
      { ws: string; user: string; verifier: string; expires: number }
    >();
    ui.post("/mcp/oauth/fake/start", { schema: { tags } }, async (req) => {
      for (const [key, row] of pending) if (row.expires < Date.now()) pending.delete(key);
      if (pending.size > 100) throw new Error("Too many pending connections");
      const state = randomBytes(24).toString("base64url"),
        verifier = randomBytes(32).toString("base64url");
      pending.set(state, {
        ws: me(req).workspaceId,
        user: me(req).userId,
        verifier,
        expires: Date.now() + 600000,
      });
      return {
        url: await provider.authorize(
          state,
          createHash("sha256").update(verifier).digest("base64url"),
        ),
        testOnly: true,
      };
    });
    ui.post(
      "/mcp/oauth/fake/finish",
      {
        schema: {
          tags,
          body: z.object({
            state: z.string(),
            code: z.string(),
            secretName: z.string().regex(/^[A-Z][A-Z0-9_]{1,70}$/),
          }),
        },
      },
      async (req, reply) => {
        const row = pending.get(req.body.state);
        pending.delete(req.body.state);
        if (
          !row ||
          row.ws !== me(req).workspaceId ||
          row.user !== me(req).userId ||
          row.expires < Date.now()
        )
          return reply.code(400).send({ error: "Invalid OAuth state" });
        const token = await provider.exchange(req.body.code, row.verifier);
        await s.vault.put(row.ws, req.body.secretName, token);
        return { ok: true, testOnly: true };
      },
    );
  });
};
