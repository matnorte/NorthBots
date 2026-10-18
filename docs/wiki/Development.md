# Development

NorthBot is a pnpm monorepo with strict TypeScript, a Fastify API, React UI, PostgreSQL/pgvector and a separate Go companion. Read [CONTRIBUTING.md](../../CONTRIBUTING.md), [architecture](../ARCHITECTURE.md), [STATUS.md](../../STATUS.md), [DECISIONS.md](../../DECISIONS.md) and [BLOCKERS.md](../../BLOCKERS.md) before changing behavior.

## Repository map

| Path                                 | Responsibility                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                        | Auth/vault, events, agent runtime, task/approval services, scheduler, MCP, security, companion, operations and packs |
| `apps/web`                           | React workspace, i18next, Zustand state, terminal, browser view and lazy-loaded Pixi office                          |
| `packages/shared`                    | zod contracts, typed events, agent identities, pure office reducer                                                   |
| `packages/llm-router`                | Providers, aliases/fallback, redaction, costs and privacy rules                                                      |
| `packages/agent-runtime`             | Task loop, tools, injection checks and permissions                                                                   |
| `packages/sandbox`                   | Docker/fake computers and agentd bridge                                                                              |
| `packages/memory`, `packages/skills` | Knowledge and reusable reviewed work                                                                                 |
| `packages/scheduler`, `packages/mcp` | Schedule primitives and MCP client support                                                                           |
| `packs/store-operator`               | Example team, adapters, reports and simulation                                                                       |
| `companion`                          | Go command, tunnel, protocol and native/fake desktop drivers                                                         |
| `docker`, `deploy`, `install.sh`     | Images, egress enforcement, HTTPS install and deployment CLI                                                         |
| `scripts/acceptance`                 | M0–M12 end-to-end milestone checks                                                                                   |
| `docs/wiki`                          | Versioned wiki source                                                                                                |

## Work locally

Follow [Quick Start](Quick-Start.md). For frontend iteration against the running API:

```bash
pnpm --filter @northbot/web dev
pnpm --filter @northbot/web exec playwright install chromium
pnpm --filter @northbot/web exec playwright test workspace-ui.spec.ts
```

Browser tests default to `http://localhost:8080`. Set `NORTHBOT_WEB=http://localhost:5173` to target Vite. Some UI tests use isolated fixtures; acceptance journeys use the running backend. The server test database is `northbot_test`, separate from the development database on the same Compose PostgreSQL.

## Required verification

```bash
pnpm install --frozen-lockfile
docker compose up -d
pnpm test
pnpm lint
pnpm typecheck
bash scripts/acceptance/mN.sh
pnpm acceptance:all
```

Replace `mN.sh` with the touched milestone. Windows uses **Git Bash** for scripts. Build the agent image first on a new checkout. For companion changes also run:

```bash
cd companion
go vet ./...
go test ./...
```

Full acceptance runs all 13 milestone scripts, including real Docker computers, Chromium and a privileged clean-Ubuntu installation test. Ensure Go is on PATH and Docker has adequate resources. Native Windows desktop smoke is opt-in; fake-driver passes do not prove real input behavior.

Never weaken, skip or delete an acceptance assertion to make a failure disappear. Fix the underlying code; raise a timeout only with evidence that the operation is legitimately slow. Run the failing milestone until fixed, then confirm the complete run.

## Design rules

The event log is the source of truth. Add validated event schemas before introducing new event-driven behavior. Database sequence IDs can commit out of order; consumers must account for late events rather than treating the highest observed ID as proof all earlier events arrived.

Every dangerous tool uses a fixed action kind and the permission pipeline. Never log vault values or treat external content as instructions. Validate inputs with zod, retain strict TypeScript and keep interface text translated in English, Brazilian Portuguese and Spanish.

Generate Drizzle migrations for schema changes. Keep LF endings and focused commits. Update status/decisions/blockers when behavior or verification changes. Record real-account/machine limitations instead of pretending mocks remove them.

## Documentation workflow

Edit wiki pages in `docs/wiki/`. `node scripts/prepare-wiki.mjs --repo matnorte/NorthBots --output <directory>` prepares a GitHub-wiki copy with page, source and image links rewritten. It performs no network calls and does not publish. Commit source changes before updating the separate wiki repository. Keep the README and feature catalog in step with implemented behavior.
