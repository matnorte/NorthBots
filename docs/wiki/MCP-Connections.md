# MCP Connections

NorthBot can consume MCP tools for agents and expose selected NorthBot actions to external MCP clients. Client connections and server tokens have independent reviews and permissions.

## Add tools to an agent

Open **Settings → Tool connections**. Choose the agent and transport, inspect the returned tools and approve the displayed version.

| Transport       | Setup                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| stdio           | Install the executable in that agent's computer; enter its executable and JSON argument array. It runs as the unprivileged agent user there. |
| Streamable HTTP | Set the endpoint and, if required, a vault secret name containing its bearer token.                                                          |

Use the [server directory](../../packages/mcp/directory.json) as a starting point, then review the actual server you install. Assignments and reviews are per agent. Configure each tool's allow/ask/block policy, action kind and declared cost. A changed description, schema or version stops calls until the tool is reviewed again. Hidden-instruction scans run before tools are exposed to the model.

MCP is an extension boundary, not a permission bypass. A remote tool can still affect an external account; classify its actual behavior and choose narrow credentials.

## Connect an external client to NorthBot

Create a token in Settings with only the required scopes. Connect a Streamable HTTP MCP client to:

```text
http://localhost:8080/api/mcp
```

The direct-server endpoint is `/mcp`. Use HTTPS outside local development and set the client's Authorization header to `Bearer <token>`.

| Tool              | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `send_letter`     | Send a directed team handoff                  |
| `ask_agent`       | Ask an agent a question                       |
| `list_tasks`      | Inspect tasks                                 |
| `create_task`     | Request work through the runtime              |
| `read_memory`     | Read permitted memory                         |
| `list_schedules`  | Inspect routines                              |
| `create_schedule` | Propose a schedule requiring first-run review |

Tokens are workspace-scoped, stored as hashes, revocable and limited to 60 requests/minute. A task-write scope does not grant memory-read access. Task permissions, costs and kill state still apply.

## OAuth status

The OAuth provider interface and PKCE/state/single-use-code behavior are implemented and tested against an explicitly fake provider. `/mcp/oauth/fake/start` and `/finish` are test flows. Real provider registration is still a documented blocker. Existing real provider tokens may be stored in the vault for HTTP connections; do not present the fake authorization flow as a production integration.

Source: [MCP service](../../apps/server/src/mcp/service.ts), [NorthBot MCP server](../../apps/server/src/mcp/server.ts).
