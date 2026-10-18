# Status

Memory across runs. Read this, `DECISIONS.md` and `BLOCKERS.md` first, then continue from the first unfinished milestone.

| Milestone | State |
| --- | --- |
| M0 Scaffold | done (m0.sh passes) |
| M1 Accounts, event log, vault | done (m1.sh passes) |
| M2 LLM router and endpoint | done (m2.sh passes) |
| M3 Agent computers | done (m3.sh passes) |
| M4 Runtime, permissions, approvals | done (m4.sh passes) |
| M5 Chat, avatars, moods, hatching | done (m5.sh passes) |
| M6 Memory and skills | done (m6.sh passes) |
| M7 Multi-agent | done (m7.sh passes) |
| M8 Cozy Office | done (m8.sh passes; full suite, lint and typecheck green) |
| M9 Scheduler | done (m9.sh, 292 tests, lint and typecheck pass) |
| M10 MCP | done (m10.sh; 297 tests, lint and typecheck pass) |
| M11 Security and trust | done (m11.sh: 8 server tests incl. real-browser vault signing and encrypted home volume, plus the security e2e) |
| M12 Deploy, Windows companion, store pack | done (m12.sh passes) |

## User requests applied along the way (2026-10-18)

- UI refresh: responsive grouped sidebar, searchable/filterable agent overview, status counts, grid/list views, improved chat composer and send recovery, consistent controls/empty states/settings cards, and English/pt-BR/Spanish additions. Ten 2048px transparent portraits generated through Higgsfield replace web UI avatar images while preserving existing looks and animated office sprites. See `docs/PROJECT_REVIEW.md`.
- Fixed an office startup/unmount race: cleanup no longer reads Pixi's canvas before renderer initialization finishes.

- Geometric avatars: 10 shapes × 15 colours, two dot eyes, one look per agent per workspace (done).
- Dark UI: blacks and grays with rainbow accents (done).
- Fun working/waiting/resting/blocked animations on avatars (done).
- Office (M8) must draw agents as **pixel-art sprites built from the same 10 shapes and 15 colours, with several animations** (idle, walk, carry, work, sleep, bounce, dizzy). Implemented and tested in M8.

## Local environment notes

- Windows dev box: run acceptance with Git Bash (`bash scripts/acceptance/mN.sh`). Tool PATH helper: Docker at `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`, pnpm in `%APPDATA%\npm`, Go in `C:\Program Files\Go\bin`.
- Postgres from compose is exposed on `localhost:5432`. Server tests use a separate `northbot_test` database.
- The agent image `northbot/agent:dev` is built by `compose_up` (`docker compose --profile images build agent-image`).
- Playwright Chromium is installed for apps/web e2e (`pnpm --filter @northbot/web exec playwright test`).
- Typing `\uXXXX` or `\n` inside inline shell/node snippets gets decoded by the tooling: edit such code with the editor or build characters with `String.fromCharCode`.

## Failing

_Nothing known._ m12.sh, lint and typecheck pass after the M12 commit; a single full `pnpm test` + `pnpm acceptance:all` run (m0–m12) still has to be confirmed.

## M8 completion (2026-10-18)

Done: `packages/shared/src/office.ts` reducer + snapshot tests; pixel sprites (`apps/web/src/office/pixels.ts`, 10 shapes × 15 colours, 13 animations, office cat); PixiJS scene, art in `apps/web/public/office/`, Office page with list view, bubble dial, topic-only, calm, reduced motion, sound, room focus, time slider, test hook `window.__northbotOffice`; lift/drop/shake/cookie endpoints (`apps/server/src/office/routes.ts`) with `test/m8.test.ts` green; fixed the event feed dropping late-committing events.

Completed: `scripts/acceptance/m8.sh` passes against the rebuilt Docker stack. Office drag/lift pauses a busy task, drop resumes it, and the list matches the event-derived scene. The parity assertion waits for the complete event set because sequence IDs can commit out of order; no assertion was removed. Office test computers are cleaned up after each run. Full suite: 277 tests passed, including real Docker sandbox tests; repository lint and all TypeScript checks passed.

Next: M10 MCP, then M11 security/trust and M12 distribution and companion, in the master build specification.

## Original M8 plan

Plan:
1. A pure `officeState(events)` reducer in packages/shared (agents, rooms they stand in, bubbles, letters in flight, idea-bin papers, break room with reasons and wake times, pets, clock). The canvas and the plain list view both read it, so "scene = f(event log)" is testable without a browser.
2. PixiJS v8 isometric scene in apps/web: original SVG art in `apps/web/public/office/`; the agents are **pixel-art sprites generated from the same 10 shapes × 15 colours** (user request), with idle, walk, carry, work, sleep, bounce and dizzy animations; status icons and mood faces.
3. Bubbles (latest per agent, all/important/none dial, topic-only privacy), letters carried desk to desk, idea-bin papers, break room (waiting/resting/out of budget, hibernated computer, why + wake time, one alert when most rest), pets, day/night, reduced-motion and calm modes, pan/zoom, single-room mobile view, time slider over the replay API.
4. Interactions: lift (pauses a busy task at a safe point; grumpy "interrupted"), drop on a room (chat, Talk, rest, desk), shake, poke, pet, cookie (good-job feedback), double-click chat, long-press radial menu, drag a letter onto an agent. Cosmetic only: never deletes, grants or spends.
5. `window.__northbotOffice` test hook; Playwright e2e for each event type, a snapshot test of the reducer, lift-pauses-task, list view = same agents; `scripts/acceptance/m8.sh`.


## M9 completion (2026-10-18)

Done: timezone/DST-aware cron, once and interval definitions; natural-language previews with next five times and frequency estimates; Postgres locked occurrence claims, durable pg-boss delivery and idempotent tasks; catch-up, overlap, jitter, retry/backoff, runtime and reserved daily budget limits; computer wake, approval invalidation, three-failure automatic pause and alert. UI controls, YAML round-trip, run/task/event history, agent/chat proposal paths, system routines and event-derived office clock/calendar/alarm states are implemented.

Validation: m9.sh passes against the rebuilt Docker stack, including the live browser journey. All 292 tests passed across the workspace (server rerun: 87/87); lint and all typechecks passed. The initial full run encountered transient Postgres connection resets/timeouts on Docker Desktop; isolated affected suites and the complete server suite subsequently passed without changing assertions or increasing timeouts. Nightly backup is intentionally paused pending the M12 deployment runner.


## M10 completion (2026-10-18)

Done: official SDK client/server; unprivileged stdio inside the assigned Docker computer and Streamable HTTP; independent assignments, per-tool allow/ask/block/action/cost policies; hidden-instruction scans before model exposure; full schema/description/version pinning and re-approval; call audit/cost events; server directory; PKCE/state-bound fake OAuth provider; seven NorthBot MCP tools with workspace-scoped revocable tokens and per-token rate limits. Settings includes connection setup, schema review, policy editing and token creation/revocation in all three languages.

Validation: m10.sh passes, including a real sandbox stdio tool used in a task, schema-change refusal/re-approval, malicious-description refusal, external SDK scope/isolation/revocation checks and live browser connection/token controls. All 297 workspace tests pass; lint and all typechecks pass. Real OAuth registration is documented in BLOCKERS.md. Next: M11 security and trust, then M12 deployment and companion.


## M11 completion (2026-10-18)

Done (Codex built it; Claude verified and fixed it): agent passkeys stored in the vault and signed by the server through the agent browser's WebAuthn bridge (the key never enters the computer, events or prompts), human login/2FA hand-off that holds the same computer, team vault grants with roles, expiry and one-click revoke, public/private/secret data labels enforced on letters and outbound commands, canary tokens, per-agent memory keys and an encrypted home volume, redacted recordings, Ed25519-signed audit export, LGPD/GDPR person export and erase, an egress map and a security score.

Fix during verification: the Security page's select placeholders were corrupted characters (U+FFFD), which leaked into the fields' accessible names and hung the e2e test; every select now has an explicit accessible name.


## M12 completion (2026-10-18)

Done: `install.sh` (Ubuntu, Docker, secrets in .env, HTTPS via Caddy, first account, the `northbot` command, nightly backup), `northbot backup/restore/update` with automatic rollback, the Windows companion (`companion/`, Go: pairing, outbound tunnel, power levels, shared folders and apps, banner, hotkeys, kill switch, screenshot trail, Wake-on-LAN from the server; off per agent by default), the store operator pack (`packs/store-operator`: seven agents, rules, three routines, fakes, Shopify/Mercado Pago/Meta adapters, daily profit report with the 7-day no-earnings flag), operations (health dashboard, canary checks and canary task, dead-letter queue, run history search, incident reports, public status page), README quickstart, `docs/ARCHITECTURE.md` (mermaid), `CONTRIBUTING.md`, `docs/openapi.json`.

Review fixes in the same pass: the egress proxy no longer lets agents reach private addresses (it could reach the database); companion commands run in order; security/vault caller errors are 400s; passkey signing waits for the row lock; alerts list newest first; LF line endings everywhere.

Real-world gaps are in BLOCKERS.md (real Windows input, real store accounts, a real VPS with a public domain).

## Definition-of-done verification (2026-10-18)

In progress: the first full test run exposed a production-bundle dependency check that resolved every workspace package under packages/, overlooking packs/store-operator. Discovery now reads package names from all three workspace roots; the dependency assertion is unchanged. The focused bundle and M11 regression run passes (9 tests). M11 setup also exceeded its existing 30-second limit during a concurrent Docker rebuild; its focused rerun completed in 19 seconds without changing timeouts. Full validation is being repeated.

Person export now streams JSON with backpressure over keyset pages (100 ordinary rows or one file), preserves the response shape, and no longer caps memory at 500 live facts. Erasure uses the same bounded scans. Added two regressions covering lazy page consumption/cancellation, 521 decrypted memories including expired data, 205 events, file encoding, workspace isolation and erasure. Focused export/M11 tests and strict server typecheck pass.

M12 companion review: screenshots now mask unshared windows (including overlaps) and the desktop; file reads reject non-regular files and remain size-bounded if a file grows. Tunnel workers stop queued input on shutdown and handle closed event channels. Server hello is persisted before a device becomes available, malformed frames are rejected without unhandled errors, assignment and kill state are rechecked at dispatch, and device errors are excluded from audit payloads. Added Go and server regressions; Go vet/tests and the four server companion tests pass.

Full acceptance reached M5 and found missing Settings connection/API-key fixture responses in the browser navigation test. Added explicit responses; unexpected requests still fail and all assertions remain intact. Rerun: M5 PASS, including all 12 browser tests. Earlier M0-M4 scripts passed in this run; later milestones and the final full rerun remain pending.

Operations review: dead-letter retry/dismiss now share a nonblocking PostgreSQL advisory lock across processes. Stable retry keys survive interrupted requests, and task retries retain budget, deadline, context and taint. Referenced tasks/runs are scoped to the requesting workspace. Regression covers a simultaneous retry/dismiss and verifies the persisted original budget and taint; operations and pack integration tests pass (4 tests), with M9 regression coverage also passing.

Store pack review: install is protected against concurrent duplicate teams; invalid calendar dates are rejected. Adapters refuse redirects and cross-origin pagination, remove token query parameters, bound request duration, fail on incomplete pagination and omit reflected response contents from errors. Hour/day boundaries are exclusive. Profit reconciliation requires settled payment amounts, totals include unattributed ad spend, and incompatible currencies are rejected. All 15 pack tests pass (8 new security/correctness regressions); pack/server typechecks and server install regressions pass.

Deployment review: backup replacement is private and atomic, including pre-existing symlink destinations; rotation handles filenames safely. Restore validates archive members and the database dump before destructive steps and never extracts archive paths. Update preserves the actual running image IDs and runtime configuration, and rolls back after source-copy, build, startup or health failure. Installer credentials use private temporary files/stdin and JSON encoding; install-directory configuration is shell-quoted. New deterministic CLI regressions pass on Ubuntu, including Unix permission/symlink assertions. M12 includes them; full Ubuntu installer rerun is pending. The all-milestone runner now fails if a required script is missing.

Egress review: malformed CONNECT authorities/ports are rejected before socket creation; handler failures return gateway errors instead of unhandled rejections; disconnected clients/upstreams close their peer sockets. Credential authentication no longer has a 60-second stale cache. Destination checks are isolated and tested for mapped IPv4, private/transition IPv6, mixed DNS answers and pinned resolution. Added 21 Node tests to pnpm test; all pass, and lint passes. Real proxy/private-network checks remain in M12.

Companion follow-up review: local kill, sharing changes, power reductions, invalid/missing configuration now stop an already-running session within the 100 ms configuration-watch interval; restart explicitly adopts the new settings. Remote pairing/tunnels require HTTPS, with HTTP limited to loopback development, and pairing/tunnel redirects are refused. Go vet and all Go tests pass, including local-revocation subtests and pairing credential/transport regressions.

M11 acceptance now passes. Trace-backed browser synchronization fix: the letter request began 9 ms after Save label, before the label's 34 ms response completed. The test now additionally asserts the save response is 200 before exercising its unchanged secret-transfer rejection assertion. No timeout or existing assertion changed.

Privacy erasure review found a pre-existing PostgreSQL encoding bug: matching recordings with JSON arrays failed with invalid JSON syntax. A new regression first reproduced the failure; redaction now sends one JSON object through typed record conversion, preserving arrays and string columns. All three privacy-export/erasure regressions pass.
