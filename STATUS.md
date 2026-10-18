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
| M6 Memory and skills | in progress: server done and tested; web UI + m6 acceptance left |
| M7 Multi-agent | not started |
| M8 Cozy Office | not started |
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

_Nothing known._ Last full run: 225+ unit/integration tests green; m0–m5 acceptance green (m5 re-run after the UI changes).

## Next (M6 remaining)

1. Web: a Memory page (search/browse, add, edit, forget, export download, import upload) and a Skills page with review cards (draft files, diff, scan findings, dry-run result, rights; approve / edit / reject; versions and rollback; "make this task a skill" button on finished tasks).
2. `scripts/acceptance/m6.mjs` + `m6.sh` against compose with real computers: run the same scripted task 3× → skill draft; approve → 4th run uses the skill (`skill.used`); planted secret → 422; memory export → forget all → import → identical `memory.json`. Fake models via `fake.match` (see apps/server/test/m6.test.ts for a working settings block).
3. Run lint, typecheck, `bash scripts/acceptance/all.sh`, then commit `M6: Memory and skills`.
4. Then M7 (rooms, letters + mail agent routing, idea bin + bin-picker, Talks). Agents need a way to call NorthBot from their computer (toss_idea, letters): plan is an `nb` CLI in the agent image that reaches the server through the egress proxy as `northbot.internal` with the sandbox identity.
