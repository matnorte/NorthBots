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
| M8 Cozy Office | in progress: reducer, sprites, scene, interactions, server endpoints done; e2e lift step failing |
| M9 Scheduler | not started |
| M10 MCP | not started |
| M11 Security and trust | not started |
| M12 Deploy, Windows companion, store pack | not started |

## User requests applied along the way (2026-10-18)

- Geometric avatars: 10 shapes × 15 colours, two dot eyes, one look per agent per workspace (done).
- Dark UI: blacks and grays with rainbow accents (done).
- Fun working/waiting/resting/blocked animations on avatars (done).
- Office (M8) must draw agents as **pixel-art sprites built from the same 10 shapes and 15 colours, with several animations** (idle, walk, carry, work, sleep, bounce, dizzy). Not built yet.

## Local environment notes

- Windows dev box: run acceptance with Git Bash (`bash scripts/acceptance/mN.sh`). Tool PATH helper: Docker at `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`, pnpm in `%APPDATA%\npm`, Go in `C:\Program Files\Go\bin`.
- Postgres from compose is exposed on `localhost:5432`. Server tests use a separate `northbot_test` database.
- The agent image `northbot/agent:dev` is built by `compose_up` (`docker compose --profile images build agent-image`).
- Playwright Chromium is installed for apps/web e2e (`pnpm --filter @northbot/web exec playwright test`).
- Typing `\uXXXX` or `\n` inside inline shell/node snippets gets decoded by the tooling: edit such code with the editor or build characters with `String.fromCharCode`.

## Failing

_Nothing known._ Last full run (2026-10-18): lint, typecheck, every unit/integration suite, and m0–m7 acceptance green on Docker Desktop.

## M8 state (2026-10-18, work in progress)

Done: `packages/shared/src/office.ts` reducer + snapshot tests; pixel sprites (`apps/web/src/office/pixels.ts`, 10 shapes × 15 colours, 13 animations, office cat); PixiJS scene, art in `apps/web/public/office/`, Office page with list view, bubble dial, topic-only, calm, reduced motion, sound, room focus, time slider, test hook `window.__northbotOffice`; lift/drop/shake/cookie endpoints (`apps/server/src/office/routes.ts`) with `test/m8.test.ts` green; fixed the event feed dropping late-committing events.

Left: `apps/web/e2e/office.spec.ts` passes bubble, letter, break room and log snapshot, but the canvas drag in the lift step does not register a lift (line ~117): check the Pixi pointer path (sprite pointerdown → stage pointermove) under Playwright; then `scripts/acceptance/m8.sh` (compose_up + playwright office spec), full gate, commit `M8: The Cozy Office`.

## Original M8 plan

Plan:
1. A pure `officeState(events)` reducer in packages/shared (agents, rooms they stand in, bubbles, letters in flight, idea-bin papers, break room with reasons and wake times, pets, clock). The canvas and the plain list view both read it, so "scene = f(event log)" is testable without a browser.
2. PixiJS v8 isometric scene in apps/web: original SVG art in `apps/web/public/office/`; the agents are **pixel-art sprites generated from the same 10 shapes × 15 colours** (user request), with idle, walk, carry, work, sleep, bounce and dizzy animations; status icons and mood faces.
3. Bubbles (latest per agent, all/important/none dial, topic-only privacy), letters carried desk to desk, idea-bin papers, break room (waiting/resting/out of budget, hibernated computer, why + wake time, one alert when most rest), pets, day/night, reduced-motion and calm modes, pan/zoom, single-room mobile view, time slider over the replay API.
4. Interactions: lift (pauses a busy task at a safe point; grumpy "interrupted"), drop on a room (chat, Talk, rest, desk), shake, poke, pet, cookie (good-job feedback), double-click chat, long-press radial menu, drag a letter onto an agent. Cosmetic only: never deletes, grants or spends.
5. `window.__northbotOffice` test hook; Playwright e2e for each event type, a snapshot test of the reducer, lift-pauses-task, list view = same agents; `scripts/acceptance/m8.sh`.
