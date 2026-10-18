# NorthBot

An open, self-hostable platform of always-on AI agents. Each agent has its own cloud computer (a terminal and a browser), agents talk to each other in rooms, letters and Talks, and you watch them in a cozy 2.5D office.

> Work in progress. See `STATUS.md` for which milestones are done.

## In the workspace

- **Agents:** see who is working, who needs help, and who is ready. Search your team, filter by status, and switch between grid and list views.
- **Chat and computers:** explore an idea with Ask, start a task with Do it, attach files, or inspect an agent's terminal and browser.
- **Collaboration:** bring agents together in rooms, route requests through letters, discuss decisions in Talks, and save ideas for later.
- **Memory and skills:** inspect what the team remembers and review reusable routines before approving them.
- **The office:** watch an event-driven, animated pixel office, or use its accessible list view.
- **Your controls:** review approvals, manage rules and budgets, set quiet hours, and stop all agents when needed.

The responsive dark UI supports English, Brazilian Portuguese, Spanish, keyboard navigation and reduced motion. Agent portraits use ten original high-definition Higgsfield mascots, retaining the existing 150 shape-and-colour identities. Original PNGs, optimized WebP assets and generation prompts are in `apps/web/public/avatars`.

![NorthBot workspace](docs/screenshots/workspace.png)

Read the [project review](docs/PROJECT_REVIEW.md) for architecture, implementation status and the UI refresh details. See `STATUS.md` for milestone completion and remaining work.

## Quickstart (local)

Needs Docker, Node 22+ and pnpm 9.

```bash
pnpm install
docker compose --profile images build agent-image   # the agent computer image (first build takes a while)
docker compose up -d --build
```

- Web app: http://localhost:8080
- API: http://localhost:3000 (health at `/health`, OpenAPI at `/openapi.json`)

## Development

```bash
pnpm test             # unit tests (needs the compose Postgres running)
pnpm lint
pnpm typecheck
pnpm acceptance:all   # every milestone acceptance script
```

For frontend development against the running local API:

```bash
pnpm --filter @northbot/web dev
pnpm --filter @northbot/web exec playwright install chromium  # first time
pnpm --filter @northbot/web exec playwright test workspace-ui.spec.ts
```

The browser suite defaults to the built app at `http://localhost:8080`. Set `NORTHBOT_WEB=http://localhost:5173` to test the development server. Its workspace UI tests use isolated fixtures; the hatching and office acceptance tests use the running backend.

## Layout

| Path                  | What                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `apps/server`         | API, WebSocket, agent runtime, scheduler worker                   |
| `apps/web`            | React app, chat UI, Cozy Office                                   |
| `packages/shared`     | zod types and the event schema                                    |
| `packages/llm-router` | model providers, aliases, fallback, redaction, pricing            |
| `packages/sandbox`    | agent computers: the `Sandbox` interface, Docker and fake drivers |
| `docker/agent`        | the agent computer image and `agentd` (shells + browser)          |
| `docker/egress`       | the egress proxy that logs every outbound connection              |
| `scripts/acceptance`  | one `mN.sh` per milestone                                         |
| `docker/`             | Dockerfiles and nginx config                                      |

## Scheduled routines

Schedules supports five-field cron (`@daily` and `@hourly` included), one-time runs and intervals. Choose an agent or room, preview the next five times in its timezone, then confirm. The default minimum interval is five minutes (`SCHEDULE_MIN_INTERVAL_S`); frequent schedules show a monthly budget estimate. In an agent chat, use **Do it** with `schedule: every weekday at 9am | Summarize invoices` to create a paused routine for review.

Run now, dry run, pause, duplicate, edit and YAML import/export are available from Schedules. History links to each task, computer and event trail. Changes to a prompt or approved skill invalidate first-run approval. Tool permissions still apply to every action. Concurrent workers claim occurrences in Postgres and deliver them through pg-boss; persisted idempotency keys prevent duplicate tasks. Catch-up, overlap, jitter, retry, runtime and daily budget limits are configurable per routine.

System routines are visible and pausable. The nightly backup routine starts paused until the deployment backup runner is configured; enabling it prematurely produces an explicit failure. Other built-ins cover health, ideas, expiring memory, costs and skill usage.


## MCP connections

Open **Settings → Tool connections** to add a server. For stdio, install the program inside the selected agent computer, enter its executable and JSON argument array, inspect the tools, then approve the displayed version. The process runs as the unprivileged `agent` user inside that container. HTTP connections support a bearer token referenced by vault name; token values are never returned by the connection API. Each agent has an independent tool review and per-tool allow/ask/block, action classification and declared cost. Description, schema or version changes stop calls until a human reviews again. The [server directory](packages/mcp/directory.json) provides starting points.

NorthBot's MCP endpoint is `POST /mcp` (through the web proxy, `/api/mcp`). Create a token in Settings with only the required scopes. Available tools: `send_letter`, `ask_agent`, `list_tasks`, `create_task`, `read_memory`, `list_schedules`, `create_schedule`. Tokens are workspace-scoped, revocable, hashed in storage and limited to 60 requests/minute. Tool scopes are shown in the token form; `mcp:tasks:write` cannot read memory. Tasks retain the ordinary permission checks and kill switch; MCP-created schedules require first-run approval.

For an SDK client, use `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`, set the endpoint URL and `requestInit.headers.Authorization` to `Bearer <your token>`. Use HTTPS outside local development. OAuth has a provider interface and an explicitly test-only PKCE/state fake at `/mcp/oauth/fake/start` and `/finish`; real provider registration remains deployment-specific. Existing provider tokens can be stored in the vault and used immediately.
