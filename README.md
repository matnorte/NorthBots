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

```powershell
northbot-companion pair  --api https://bots.example.com/api --code NB-XXXX-XXXX
northbot-companion share --power view+click --folder "C:\Users\me\Shop" --app notepad.exe
northbot-companion run
```

It only dials out (one WebSocket), shows a banner while an agent acts, keeps a screenshot after every action in the audit log, and stops with **Ctrl+Alt+Shift+B** (take back control), **+R** (resume) or **+K** (kill switch). The workspace kill switch stops it too. Each computer is off for every agent until you pick an agent and turn it on. Screenshots expose only shared-app regions. Local sharing/power changes and the `kill` command stop the running session; start `run` again after changing them. Remote API connections require HTTPS; HTTP is permitted only on loopback for development. Build it with `cd companion && go build ./cmd/northbot-companion`.

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

Signed audit exports use Ed25519; keep the exported public key fingerprint to verify later artifacts. Security activity summaries are redacted; companion screenshots are stored separately with unshared regions masked. Person-data exports stream matching stored records, including expired memories. Erasure covers matching data in memory, conversations, tasks, collaboration records, routines and activity history while preserving JSON structure. Backups and copies already downloaded require their own retention/deletion process.

## Handoff: where the build stands (2026-10-18)

All 13 milestones (M0-M12) and the finishing fixes are committed. See `git log --oneline`, STATUS.md, DECISIONS.md and BLOCKERS.md.

### Verification

Confirmed on 2026-10-18: the full install/start/test/acceptance sequence exits **0**, and lint/typecheck both exit **0**.

| Check | Confirmed result |
| --- | --- |
| `pnpm test` | 354 passed: 333 Vitest tests plus 21 Node egress tests; zero skipped |
| `pnpm acceptance:all` | M0-M12 passed in one uninterrupted run (all 13 scripts) |
| Chromium browser acceptance | 16 successful executions covering 12 distinct flows, including scoped milestone repeats |
| `pnpm lint` / `pnpm typecheck` | Both pass |

M0 also repeats the complete unit suite. Local evidence is retained in ignored `test-results/definition-of-done-*.log` files and `definition-of-done-summary.json`. Application source revision tested: `24d1026`; the final handoff commit changes documentation only.

The full sequence is run in Git Bash on Windows:

```bash
pnpm install && docker compose up -d && pnpm test && pnpm acceptance:all
pnpm lint && pnpm typecheck
```

M12 also exercises Go vet/tests, the real companion binary with its fake desktop, store adapters against mock APIs, backup/restore into a fresh database, update rollback with existing-agent connectivity, and a clean Ubuntu 24.04 install with Docker, HTTPS, first-account sign-in and an installer re-run that preserves keys. Real desktop input remains a separate blocker; the existing native smoke test stays opt-in.

### Added in the finishing review

- Bounded row/JSON streaming helpers, an uncapped privacy-memory iterator, and regressions for large exports, cancellation, tenant isolation, expired memories and JSON-preserving erasure.
- Cross-process operation locks; tests for concurrent retry/dismiss and pack-install requests.
- Companion tests for screenshot masking, shutdown queues, closed event channels, persisted handshakes, malformed frames, local sharing revocation, TLS and redirect refusal.
- Eight store-adapter/report regressions and 21 egress-network tests, with the egress tests included in `pnpm test`.
- Deployment CLI regressions for private backups, unsafe archives, source/build/start/health rollback, Docker containerd manifests and agent-network reconnection. Unix permission/symlink assertions run on Ubuntu when the host is Windows.
- Docker build guards that reject private runtime files before dependency installation.

### Changed

- **Privacy:** person export streams the existing JSON response with backpressure, fetching at most 100 ordinary rows or one file per page. It includes all stored matching memories, including expired facts and matches beyond the old 500-row screen limit. Erasure uses bounded scans and preserves JSON arrays and object keys.
- **Companion:** screenshots mask unshared windows and desktop regions, including overlapping windows. File reads remain size-bounded if a file grows and reject non-regular files. Queued input stops on shutdown; local kill, share changes, power reductions or unreadable configuration invalidate the live session. Run the companion again to adopt changed settings. Remote pairing/tunnels require HTTPS; loopback HTTP remains available for development, and credential-bearing redirects are refused. The server waits for the persisted handshake, rejects malformed frames, rechecks assignment/kill state at dispatch, and keeps device error contents out of audit payloads.
- **Operations:** retry and dismiss are serialized across processes. Stable retry keys prevent duplicate work after interrupted requests; task retries retain budget, deadline, context and the untrusted-input marker. Referenced tasks and runs are scoped to their workspace. Scheduled retries reuse the same occurrence key.
- **Store pack:** concurrent installation cannot create duplicate teams. Real reporting checks the requesting user's grants for every required secret before decryption. Invalid dates are rejected. Adapters refuse redirects/cross-origin pagination, strip token query parameters, bound request duration, reject incomplete pagination and omit response contents from errors. Hour/day boundaries are exclusive. Pending or partial payments do not fully reconcile a paid order; unattributed ad spend counts against total profit; mixed order currencies require conversion support.
- **Deployment:** backups are private and atomically replaced, including symlink destinations, and rotation handles filenames safely. Restore reads only allowlisted archive members into fixed private files and validates the dump before destructive steps. Update preserves running image identities (with verified containerd manifest fallback), runtime Compose/Caddy configuration and agent-network attachments, then rolls back on source, build, startup or health failure. Database schema rollback remains manual using the pre-update backup.
- **Installer/build privacy:** signup credentials travel over stdin/private temporary files with proper JSON escaping; installation paths are shell-quoted. Docker contexts exclude environment files, backups, first-login credentials and generated test/report archives. Examples remain available. Older local builder caches predate these exclusions and should remain private.
- **Validation/docs:** bundle dependency discovery follows declared workspace package names across `apps/`, `packages/` and `packs/`. Browser fixtures include Settings connections/API keys; the security flow asserts label-save success before the unchanged secret-transfer denial assertion. Missing milestone scripts fail the full runner. Installer output is captured portably before checking `INSTALL_OK`. OpenAPI responses and project status/decisions/blockers are current.

### Removed

- Whole-workspace privacy result arrays and the privacy path's 500-live-memory cap.
- The stale egress credential cache, reflected API response bodies in errors, predictable signup temporary filenames, unchecked archive extraction and silent acceptance-script omissions.
- No source files or existing acceptance assertions were deleted. No existing test timeout was raised and no test was disabled to obtain a pass.

### Remaining limits and real-world checks

BLOCKERS.md retains the real Windows desktop-input, Shopify/Mercado Pago/Meta account, registered MCP OAuth provider, real model-provider and public VPS/domain checks. Fake/mock tests do not clear those items. Real-Windows follow-up also covers moving/overlapping-window masking and live local sharing revocation.

Canary tokens intentionally alert once. Privacy streaming uses bounded keyset scans rather than a transaction-wide snapshot; concurrent writes can affect the export. Backups and already downloaded copies retain their own deletion/retention requirements. Environment files, backups and first-login credentials remain untracked. The development database was preserved and existing agent-network connections were repaired.


<details>
<summary>Finishing-review file inventory (since handoff commit 848fd15)</summary>

A = added; M = changed. Deleted files: none.

```text
A	apps/server/src/db/lock.ts
A	apps/server/src/security/stream.ts
A	apps/server/test/person-export.test.ts
A	companion/cmd/northbot-companion/main_test.go
A	docker/egress/network.mjs
A	docker/egress/network.test.mjs
A	packs/store-operator/test/security.test.ts
A	scripts/acceptance/deploy-cli.sh
M	.dockerignore
M	apps/server/src/companion/service.ts
M	apps/server/src/memory/service.ts
M	apps/server/src/ops/service.ts
M	apps/server/src/packs/routes.ts
M	apps/server/src/schedules/service.ts
M	apps/server/src/security/audit.ts
M	apps/server/src/security/person.ts
M	apps/server/src/security/routes.ts
M	apps/server/test/bundle-deps.test.ts
M	apps/server/test/companion.test.ts
M	apps/server/test/m11.test.ts
M	apps/server/test/ops.test.ts
M	apps/server/test/packs.test.ts
M	apps/web/e2e/security.spec.ts
M	apps/web/e2e/workspace-ui.spec.ts
M	BLOCKERS.md
M	companion/cmd/northbot-companion/main.go
M	companion/internal/core/core_test.go
M	companion/internal/core/core.go
M	companion/internal/tunnel/tunnel_test.go
M	companion/internal/tunnel/tunnel.go
M	DECISIONS.md
M	deploy/northbot
M	docker/egress/Dockerfile
M	docker/egress/proxy.mjs
M	docker/server.Dockerfile
M	docker/web.Dockerfile
M	docs/openapi.json
M	install.sh
M	package.json
M	packs/store-operator/src/adapters/mercadopago.ts
M	packs/store-operator/src/adapters/meta.ts
M	packs/store-operator/src/adapters/shopify.ts
M	packs/store-operator/src/integrations.ts
M	packs/store-operator/src/profit.ts
M	packs/store-operator/src/simulate.ts
M	README.md
M	scripts/acceptance/all.sh
M	scripts/acceptance/m12.mjs
M	scripts/acceptance/m12.sh
M	STATUS.md
```

</details>
