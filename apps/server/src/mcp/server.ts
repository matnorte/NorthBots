import { zodToJsonSchema } from "zod-to-json-schema";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { ScheduleDefinition } from "@northbot/scheduler";
import type { ApiKeyPrincipal } from "../apikeys/store.js";
import type { Services } from "../services.js";
import { agents, tasks } from "../db/schema.js";
export const MCP_SCOPES = [
  "mcp:letters:write",
  "mcp:tasks:read",
  "mcp:tasks:write",
  "mcp:memory:read",
  "mcp:schedules:read",
  "mcp:schedules:write",
] as const;
const agentId = z.string().uuid();
const definitions = {
  send_letter: {
    scope: "mcp:letters:write",
    schema: z.object({
      agentId,
      body: z.string().min(1).max(10000),
      subject: z.string().max(200).default(""),
    }),
    description: "Send a request letter to an agent.",
  },
  ask_agent: {
    scope: "mcp:tasks:write",
    schema: z.object({ agentId, goal: z.string().min(1).max(10000) }),
    description: "Ask an agent by creating a task subject to its permissions.",
  },
  list_tasks: {
    scope: "mcp:tasks:read",
    schema: z.object({ agentId: agentId.optional() }),
    description: "List the latest tasks in this token's workspace.",
  },
  create_task: {
    scope: "mcp:tasks:write",
    schema: z.object({
      agentId,
      goal: z.string().min(1).max(10000),
      idempotencyKey: z.string().min(1).max(200).optional(),
    }),
    description: "Create work in this workspace. Agent permissions and kill switch apply.",
  },
  read_memory: {
    scope: "mcp:memory:read",
    schema: z.object({ agentId: agentId.optional(), query: z.string().min(1).max(1000) }),
    description: "Search shared or an agent's private memory. Requires memory scope.",
  },
  list_schedules: {
    scope: "mcp:schedules:read",
    schema: z.object({}),
    description: "List workspace schedules.",
  },
  create_schedule: {
    scope: "mcp:schedules:write",
    schema: z.object({ agentId, definition: ScheduleDefinition }),
    description: "Propose a schedule, requiring human approval before the first run.",
  },
};
export function northbotMcpServer(s: Services, principal: ApiKeyPrincipal) {
  const server = new Server(
    { name: "northbot", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(definitions).map(([name, d]) => ({
      name,
      description: d.description,
      inputSchema: zodToJsonSchema(d.schema, { target: "jsonSchema7" }),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as keyof typeof definitions;
    const definition = definitions[name];
    const result = (value: unknown, isError = false) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      isError,
    });
    if (!definition) return result({ error: "Unknown tool" }, true);
    if (!principal.scopes.includes(definition.scope))
      return result({ error: `Scope required: ${definition.scope}` }, true);
    try {
      const input = definition.schema.parse(request.params.arguments ?? {}) as {
        agentId?: string;
        goal?: string;
        body?: string;
        subject?: string;
        query?: string;
        definition?: ScheduleDefinition;
        idempotencyKey?: string;
      };
      const ws = principal.workspaceId;
      if (
        input.agentId &&
        !(
          await s.db.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.workspaceId, ws), eq(agents.id, input.agentId)))
        )[0]
      )
        throw new Error("No such agent in this workspace");
      let value: unknown;
      switch (name) {
        case "create_task":
        case "ask_agent": {
          const created = await s.tasks.create({
            workspaceId: ws,
            agentId: input.agentId!,
            goal: input.goal!,
            by: "agent",
            userId: null,
            tainted: true,
            idempotencyKey: input.idempotencyKey
              ? `mcp:${principal.id}:${input.idempotencyKey}`
              : undefined,
            budgetUsd: principal.dailyBudgetUsd,
          });
          value = { id: created.task.id, status: created.task.status };
          break;
        }
        case "list_tasks":
          value = await s.db.db
            .select({
              id: tasks.id,
              agentId: tasks.agentId,
              goal: tasks.goal,
              status: tasks.status,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.workspaceId, ws),
                input.agentId ? eq(tasks.agentId, input.agentId) : undefined,
              ),
            )
            .orderBy(desc(tasks.createdAt))
            .limit(100);
          break;
        case "read_memory":
          value = await s.memory.search(ws, input.agentId ?? null, input.query!);
          for(const fact of value as {id:string}[]) await s.data.check(ws,"memory",fact.id,`client:${principal.id}`);
          break;
        case "send_letter":
          value = await s.mail.send({
            workspaceId: ws,
            type: "request",
            body: input.body!,
            subject: input.subject,
            from: { kind: "system" },
            toAgentId: input.agentId,
          });
          break;
        case "list_schedules":
          value = await s.schedules.list(ws);
          break;
        case "create_schedule":
          value = await s.schedules.create(
            ws,
            null,
            { agentId: input.agentId!, roomId: null, definition: input.definition! },
            "agent",
          );
          break;
      }
      return result(value);
    } catch {
      return result(
        {
          error:
            "Request could not be completed. Check input, permissions, budgets and kill switch.",
        },
        true,
      );
    }
  });
  return server;
}
