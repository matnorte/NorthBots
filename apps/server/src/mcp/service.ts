import type {DataGuard} from "../security/data.js";
import { and, eq } from "drizzle-orm";
import {
  Client,
  DockerStdioTransport,
  StreamableHTTPClientTransport,
  toolHash,
  ToolPolicy,
  type PinnedTool,
} from "@northbot/mcp";
import { scanSkill } from "@northbot/skills";
import type { ExtraTool } from "@northbot/agent-runtime";
import type { Services } from "../services.js";
import { agents, mcpAssignments, mcpServers, sandboxes } from "../db/schema.js";
import type { z } from "zod";
import { scrubSecrets } from "@northbot/shared";

type Server = typeof mcpServers.$inferSelect;
type Binding = typeof mcpAssignments.$inferSelect;
export class McpService {
  private security:DataGuard|null=null;
  attachSecurity(data:DataGuard){this.security=data;}
  constructor(
    private s: Pick<Services, "db" | "events" | "computers" | "tasks" | "approvals" | "vault">,
  ) {
    s.tasks.provideTools((ctx) => this.tools(ctx));
  }
  async server(ws: string, id: string) {
    return (
      (
        await this.s.db.db
          .select()
          .from(mcpServers)
          .where(and(eq(mcpServers.id, id), eq(mcpServers.workspaceId, ws)))
      )[0] ?? null
    );
  }
  async binding(ws: string, serverId: string, agentId: string) {
    if (!(await this.server(ws, serverId))) throw new Error("No such server");
    if (
      !(
        await this.s.db.db
          .select()
          .from(agents)
          .where(and(eq(agents.workspaceId, ws), eq(agents.id, agentId)))
      )[0]
    )
      throw new Error("No such agent");
    return (
      (
        await this.s.db.db
          .insert(mcpAssignments)
          .values({ serverId, agentId })
          .onConflictDoNothing()
          .returning()
      )[0] ??
      (
        await this.s.db.db
          .select()
          .from(mcpAssignments)
          .where(and(eq(mcpAssignments.serverId, serverId), eq(mcpAssignments.agentId, agentId)))
      )[0]!
    );
  }
  private async connect(server: Server, agentId: string) {
    const client = new Client({ name: "northbot", version: "1.0.0" });
    try {
      if (server.config.transport === "stdio") {
        await this.s.computers.ensureAwake(
          { workspaceId: server.workspaceId, agentId },
          "MCP connection",
        );
        const [row] = await this.s.db.db
          .select({ containerId: sandboxes.containerId })
          .from(agents)
          .innerJoin(sandboxes, eq(agents.sandboxId, sandboxes.id))
          .where(and(eq(agents.id, agentId), eq(agents.workspaceId, server.workspaceId)));
        if (!row?.containerId) throw new Error("No agent computer");
        await client.connect(
          new DockerStdioTransport(row.containerId, server.config.command, server.config.args),
          { timeout: 10000 },
        );
      } else {
        const url = new URL(server.config.url);
        if (url.username || url.password || !["https:", "http:"].includes(url.protocol))
          throw new Error("Invalid MCP URL");
        const token = server.config.tokenSecret
          ? await this.s.vault.withSecretForAgent(
              server.workspaceId,
              server.config.tokenSecret,
              agentId,
              async (secret) => secret,
            )
          : null;
        await client.connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
          }),
          { timeout: 10000 },
        );
      }
      return client;
    } catch {
      await client.close().catch(() => {});
      throw new Error("MCP connection failed. Check the server, computer and authorization.");
    }
  }
  private async inspect(client: Client) {
    const tools: PinnedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (tools.length > 200) throw new Error("Too many MCP tools");
    } while (cursor);
    const version = client.getServerVersion()?.version ?? "unknown";
    const hash = toolHash(tools, version);
    const scan = scanSkill(
      Object.fromEntries(
        tools.map((t) => [t.name, `${t.description ?? ""} ${JSON.stringify(t.inputSchema)}`]),
      ),
    );
    return { tools, version, hash, scan };
  }
  async review(
    ws: string,
    serverId: string,
    agentId: string,
    approveHash?: string,
    policies?: Record<string, z.input<typeof ToolPolicy>>,
  ) {
    const server = await this.server(ws, serverId);
    if (!server) throw new Error("No such server");
    const binding = await this.binding(ws, serverId, agentId);
    const client = await this.connect(server, agentId);
    try {
      const result = await this.inspect(client);
      const approved =
        (approveHash === result.hash || binding.approvedHash === result.hash) && result.scan.ok;
      const parsed = Object.fromEntries(
        Object.entries(policies ?? binding.policies).map(([name, p]) => [
          name,
          ToolPolicy.parse(p),
        ]),
      );
      await this.s.db.db
        .update(mcpAssignments)
        .set({
          tools: result.tools,
          version: result.version,
          observedHash: result.hash,
          approvedHash: approved
            ? result.hash
            : binding.approvedHash === result.hash
              ? binding.approvedHash
              : null,
          policies: parsed,
        })
        .where(eq(mcpAssignments.id, binding.id));
      await this.s.events.write(ws, {
        type: "mcp.review",
        agentId,
        payload: { serverId, hash: result.hash, approved, findings: result.scan.findings.length },
      });
      return { ...result, approved, policies: parsed };
    } finally {
      await client.close();
    }
  }
  private async tools(ctx: {
    workspaceId: string;
    agentId: string;
    taskId: string;
  }): Promise<ExtraTool[]> {
    const assignments = await this.s.db.db
      .select({ binding: mcpAssignments, server: mcpServers })
      .from(mcpAssignments)
      .innerJoin(mcpServers, eq(mcpAssignments.serverId, mcpServers.id))
      .where(
        and(eq(mcpServers.workspaceId, ctx.workspaceId), eq(mcpAssignments.agentId, ctx.agentId)),
      );
    return assignments
      .filter(({ binding }) => binding.approvedHash !== null)
      .flatMap(({ binding, server }) =>
        binding.tools.map((tool) => ({
          def: {
            name: `mcp_${server.id.replaceAll("-", "").slice(0, 12)}_${tool.name}`.slice(0, 64),
            description: tool.description ?? tool.name,
            parameters: tool.inputSchema,
          },
          kind: binding.policies[tool.name]?.kind ?? "write",
          run: async (args, signal) => this.call(ctx, server, binding, tool.name, args, signal),
        })),
      );
  }
  async call(
    ctx: { workspaceId: string; agentId: string; taskId: string | null },
    server: Server,
    binding: Binding,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const started = Date.now();
    let ok = false;
    const fresh = (
      await this.s.db.db.select().from(mcpAssignments).where(eq(mcpAssignments.id, binding.id))
    )[0];
    const policy = ToolPolicy.parse(fresh?.policies[name] ?? {});
    let client: Client | null = null;
    try {
      if (await this.s.tasks.killSwitchOn(ctx.workspaceId)) throw new Error("Kill switch is on");
      if (!fresh?.approvedHash || policy.effect === "block")
        throw new Error("MCP tool is blocked or needs schema review");
      if (policy.kind !== (binding.policies[name]?.kind ?? "write"))
        throw new Error("Tool permissions changed; start a new task for review");
      await this.security?.check(ctx.workspaceId,"agent",ctx.agentId,server.config.transport==="http" ? new URL(server.config.url).hostname : `mcp-${server.id}.internal`);
      client = await this.connect(server, ctx.agentId);
      const observed = await this.inspect(client);
      if (observed.hash !== fresh.approvedHash || !observed.scan.ok) {
        await this.s.db.db
          .update(mcpAssignments)
          .set({ approvedHash: null, observedHash: observed.hash })
          .where(eq(mcpAssignments.id, binding.id));
        throw new Error("MCP schema or server version changed. Human re-approval required.");
      }
      // An agent at full access was told to work without questions; "ask" tools just run.
      const level = (
        await this.s.db.db
          .select({ autonomy: agents.autonomyLevel })
          .from(agents)
          .where(and(eq(agents.workspaceId, ctx.workspaceId), eq(agents.id, ctx.agentId)))
      )[0]?.autonomy;
      if (policy.effect === "ask" && level !== "full_access") {
        const approval = await this.s.approvals.open(
          ctx,
          {
            tool: `mcp:${server.id}:${name}`,
            kind: policy.kind,
            args,
            summary: `Use ${server.name}: ${name}`,
            targets: [],
          },
          "This MCP tool is set to ask before each call.",
        );
        if ((await this.s.approvals.wait(ctx.workspaceId, approval.id, signal)) === "deny")
          throw new Error("MCP call denied");
      }
      // External service prices are declared by the human reviewing the tool, never its output.
      const spend = await this.s.db.pool.query<{ spent: string; cap: string | null }>(
        "select coalesce((select sum(cost_usd) from events where workspace_id=$1 and agent_id=$2 and ts>=date_trunc('day',now())),0) spent,budget_daily_usd cap from agents where workspace_id=$1 and id=$2",
        [ctx.workspaceId, ctx.agentId],
      );
      const row = spend.rows[0];
      if (!row || Number(row.spent) + policy.costUsd > Number(row.cap))
        throw new Error("MCP call exceeds the agent budget");
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: 30000,
      });
      ok = !result.isError;
      return { ok, output: scrubSecrets(JSON.stringify(result.content)).slice(0, 16000) };
    } catch (e) {
      return { ok: false, output: e instanceof Error ? e.message : "MCP call failed" };
    } finally {
      await client?.close();
      await this.s.events.write(ctx.workspaceId, {
        type: "mcp.call",
        agentId: ctx.agentId,
        costUsd: ok ? policy.costUsd : 0,
        payload: {
          serverId: server.id,
          tool: name,
          taskId: ctx.taskId,
          ok,
          durationMs: Date.now() - started,
        },
      });
    }
  }
}
