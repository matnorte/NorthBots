# NorthBot

An open, self-hostable platform of always-on AI agents. Each agent has its own cloud computer (a terminal and a browser), agents talk to each other in rooms, letters and Talks, and you watch them in a cozy 2.5D office.

> All milestones (M0–M12) are built; see `STATUS.md` for details and `docs/CHANGELOG.md` for what changed.

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

## Install on a server

On a fresh Ubuntu 22.04/24.04 machine with a domain pointing at it:

```bash
git clone <your NorthBot repository> northbot && cd northbot
sudo ./install.sh --domain bots.example.com --email you@example.com
```

The installer installs Docker, copies NorthBot to `/opt/northbot`, writes `.env` with a new vault master key and database password, builds the images, starts everything behind HTTPS (Caddy with automatic certificates), creates your account (password in `/opt/northbot/first-login.txt`), installs the `northbot` command and schedules a nightly backup. The database and API listen on 127.0.0.1 only. Re-running it keeps your keys and data.

```bash
northbot status
northbot backup                          # database + .env (vault key) in backups/, mode 600
northbot restore FILE --database copy    # into a fresh database, or --yes to replace the live one
northbot update --source DIR             # backs up, rebuilds, rolls back by itself if health fails
```

Keep a copy of `NORTHBOT_MASTER_KEY`: without it, the secrets inside a backup cannot be read.

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
| `packages/agent-runtime` | the agent loop, permissions, injection shield                  |
| `packages/memory`, `packages/skills`, `packages/scheduler`, `packages/mcp` | memory, skills, cron routines, MCP |
| `packs/store-operator` | the store operator business pack                                 |
| `companion/`          | the Windows companion (Go)                                        |
| `deploy/`, `install.sh` | server install, the `northbot` command, HTTPS                   |

## Scheduled routines

Schedules supports five-field cron (`@daily` and `@hourly` included), one-time runs and intervals. Choose an agent or room, preview the next five times in its timezone, then confirm. The default minimum interval is five minutes (`SCHEDULE_MIN_INTERVAL_S`); frequent schedules show a monthly budget estimate. In an agent chat, use **Do it** with `schedule: every weekday at 9am | Summarize invoices` to create a paused routine for review.

Run now, dry run, pause, duplicate, edit and YAML import/export are available from Schedules. History links to each task, computer and event trail. Changes to a prompt or approved skill invalidate first-run approval. Tool permissions still apply to every action. Concurrent workers claim occurrences in Postgres and deliver them through pg-boss; persisted idempotency keys prevent duplicate tasks. Catch-up, overlap, jitter, retry, runtime and daily budget limits are configurable per routine.

System routines are visible and pausable and cover health, ideas, expiring memory, costs and skill usage. Database backups run on the host instead (`northbot backup`, scheduled nightly by `install.sh`), so the in-app backup routine stays off.


## MCP connections

Open **Settings → Tool connections** to add a server. For stdio, install the program inside the selected agent computer, enter its executable and JSON argument array, inspect the tools, then approve the displayed version. The process runs as the unprivileged `agent` user inside that container. HTTP connections support a bearer token referenced by vault name; token values are never returned by the connection API. Each agent has an independent tool review and per-tool allow/ask/block, action classification and declared cost. Description, schema or version changes stop calls until a human reviews again. The [server directory](packages/mcp/directory.json) provides starting points.

NorthBot's MCP endpoint is `POST /mcp` (through the web proxy, `/api/mcp`). Create a token in Settings with only the required scopes. Available tools: `send_letter`, `ask_agent`, `list_tasks`, `create_task`, `read_memory`, `list_schedules`, `create_schedule`. Tokens are workspace-scoped, revocable, hashed in storage and limited to 60 requests/minute. Tool scopes are shown in the token form; `mcp:tasks:write` cannot read memory. Tasks retain the ordinary permission checks and kill switch; MCP-created schedules require first-run approval.

For an SDK client, use `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`, set the endpoint URL and `requestInit.headers.Authorization` to `Bearer <your token>`. Use HTTPS outside local development. OAuth has a provider interface and an explicitly test-only PKCE/state fake at `/mcp/oauth/fake/start` and `/finish`; real provider registration remains deployment-specific. Existing provider tokens can be stored in the vault and used immediately.

## Windows companion

`companion/` is a small Go program that lets one agent use one of your computers, inside limits set **on that computer**: the folders and apps you share and a power level (`view`, `view+click`, `full`). Pair it with a one-time code from **Companion** in the app:

```bash
northbot-companion pair  --api https://bots.example.com/api --code NB-XXXX-XXXX
northbot-companion share --power view+click --folder C:\Users\me\Shop --app notepad.exe
northbot-companion run
```

It only dials out (one WebSocket), shows a banner while an agent acts, keeps a screenshot after every action in the audit log, and stops with **Ctrl+Alt+Shift+B** (take back control), **+R** (resume) or **+K** (kill switch). The workspace kill switch stops it too. Each computer is off for every agent until you pick an agent and turn it on. Build it with `cd companion && go build ./cmd/northbot-companion`.

## Operations

**Operations** shows a health dashboard (tasks, failure rate, model calls and cost, computers, routines), canary checks every 10 minutes (database, vault encryption, scheduler lag, stuck tasks, and a canary task that runs the real agent loop on a scripted model at no cost), a dead-letter queue to retry or dismiss failed tasks and scheduled runs, searchable run history, and incident reports generated from the event log. A public status page is at `/api/status` (JSON at `/api/status.json`); it shows instance health only, never workspace data.

## Store operator pack

`packs/store-operator` installs a coordinator (Maple) and six specialists for a small online store (research, listings, ads, Instagram, support, payment reconciliation), safety rules (refunds and spending ask first, posts wait for approval), and three routines: the daily profit report at 08:00, an hourly order check and a weekly bin-picker. The report flags any store that earned nothing in 7 days and any campaign that costs more than it brings in. Install it from **Operations**; "Simulate a day" runs it on fake store data. Shopify, Mercado Pago and Meta (ads and Instagram) adapters are included; with `SHOPIFY_SHOP`, `SHOPIFY_TOKEN`, `MERCADOPAGO_TOKEN`, `META_AD_ACCOUNT`, `META_TOKEN` and `INSTAGRAM_USER_ID` in the vault, the report can run on real data.

## Documentation

- [Architecture](docs/ARCHITECTURE.md), with diagrams
- [Contributing](CONTRIBUTING.md)
- [REST API (OpenAPI)](docs/openapi.json); the running server also serves it at `/openapi.json`
- [Changelog](docs/CHANGELOG.md) and [project review](docs/PROJECT_REVIEW.md)

## Security and trust

**Security** shows checks for encryption, HTTPS, the vault key and expiring grants, along with outgoing connections, alerts and human handoffs. Resource labels are `public`, `private` or `secret`. Secret resources require explicit destinations; delivering a restricted file or memory to an agent also restricts that agent's outgoing traffic and model use. The egress proxy checks destinations on every connection. Sensitive agents use local model providers; change a label only after reviewing its data.

Passkey enrollment uses `POST /security/passkeys` with the site's public registration challenge, user handle, exact origin and relying-party hostname, while the agent browser is on that site. It returns a public WebAuthn registration response for the site to verify. Connect the credential from Security (or `/security/passkeys/:id/connect`); subsequent `navigator.credentials.get` requests go through the vault bridge, M4 login permissions and the approval inbox. Only public challenges and signed assertions reach the browser. The private key stays encrypted in the vault. The initial agent grant expires after 24 hours; owners can renew or revoke it. Passkeys currently require the relying-party ID to equal the origin's hostname.

Grant owners may manage access; users may use granted resources; use-only grants cannot manage access. Non-owner grants require expiry. Revocation is checked again on each signature, token resolution or secret injection. Previously issued third-party tokens must also be revoked at their provider. For login, 2FA or CAPTCHA, agents can request a handoff; use the computer's live view and finish the handoff in Security to resume the same task.

Memory text is encrypted under separate agent/shared keys derived from `NORTHBOT_MASTER_KEY`; search vectors remain available to Postgres. To encrypt **new persistent home volumes**, set `SANDBOX_DISK_ENCRYPTION=true` and recreate the server. The gocryptfs driver needs `/dev/fuse`, adds `SYS_ADMIN` to the root control process and uses an unconfined AppArmor profile for FUSE mounting. Agent shells still run unprivileged. Its passphrase crosses a root-only pipe into a temporary RAM file, which is removed after mounting. Existing computers keep their original storage format. Encrypted disks use deployment volume backups or encrypted disk exports, rather than image snapshots. Keep the original master key and agent identity when restoring.

Signed audit exports use Ed25519; keep the exported public key fingerprint to verify later artifacts. Activity records retain redacted summaries and exclude raw screenshots. The person-data tools export matching live records and erase matches in memory, conversations, tasks, collaboration records, routines and activity history. Backups and copies already downloaded require their own retention/deletion process.

## Handoff: where the build stands (2026-10-18)

All twelve milestones (M0–M12) are built and committed, one commit each (`git log --oneline`).
The last commit is `M12: Deployment, Windows companion, business pack, polish`.

**Verified on this machine (Windows 11, Docker Desktop, Git Bash):**

- `scripts/acceptance/m12.sh` passes end to end:
  - Go companion tests, store pack tests and server integration tests.
  - Backup → restore into a fresh database.
  - The egress proxy refuses private destinations.
  - A failing `northbot update` rolls back.
  - The real companion binary pairs, clicks, types, refuses an unshared app and stops on kill.
  - Pack install and a simulated day, plus the OpenAPI export.
  - `install.sh` inside a fresh Ubuntu 24.04 container, with HTTPS, first login and a re-run that keeps the keys.
- `m0.sh`–`m11.sh` passed when each milestone landed.
- `pnpm lint` and `pnpm typecheck` pass after the final commit.

**Not yet confirmed after the final commit:** a clean run of `pnpm test` followed by
`pnpm acceptance:all` (m0–m12 in one go). The run was started but not read before the session
ended. That is the first thing to do: `pnpm install && docker compose up -d && pnpm acceptance:all`
must exit 0.

**Late fixes worth knowing:**

- Agent networks now take a /28 each from `SANDBOX_SUBNET_POOL` (default `10.213.0.0/16`).
  Docker's default pools ran out after about 30 agent computers.
- `northbot update` only runs `git pull` when the checkout has an upstream branch.
- `backups/` and `first-login.txt` are git-ignored. Backups contain the vault key.
- Leftover test agents pile up in the dev database across acceptance runs. Each one keeps an
  `nb-agent-*` container and an `nb-net-*` network. If Docker gets slow, drop them with
  `docker compose down -v` (this wipes the dev database).

**Needs a real credential or machine** (see BLOCKERS.md): real Windows input on a desktop
(`NORTHBOT_NATIVE_SMOKE=1 go test ./internal/driver/`), real Shopify / Mercado Pago / Meta
accounts for the store pack, and a public VPS with a domain for `install.sh --domain`.

**Known, not fixed:**

- Each canary token alerts only once (by design).
- The person export loads every row into memory. It should stream for large workspaces.

Project state lives in STATUS.md (progress), DECISIONS.md (why things are the way they are) and BLOCKERS.md.
