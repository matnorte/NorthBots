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

_Nothing known._ Last full run (2026-10-18): lint, typecheck, every unit/integration suite, and m0–m6 acceptance green on Docker Desktop.

## Next: M7 (multi-agent)

Plan (see DECISIONS.md for the reasoning):
1. Runtime: extra tools for the agent loop (`RunnerDeps.tools`), each with a fixed action kind, so agents can `send_letter` and `toss_idea` without any network path from their computer into the server. M10 MCP tools will reuse the same hook.
2. Data: rooms (+members, messages), letters (stamp jsonb), ideas (trigger jsonb), talks; tasks get room_id and letter_id.
3. Mail agent (a server service, not an agent row): scores agents on skill match, memory match, past success, load and cost; stamps the letter; low confidence goes to the workspace coordinator agent, or to the human when there is none; task reports come back as reply letters.
4. Rooms: coordinator turn rule (it picks speakers and may add board tasks), @mentions, room cost cap, human interrupt.
5. Idea bin: 30-day retention setting; triggers (after a date, a matching memory, an event type); bin-picker runs weekly on a timer until M9 makes it a schedule, plus a run-now endpoint.
6. Talks: brief, prepare (deck, notes, evidence), present, Q&A queue, challenge round, vote or human decision, decision record, then a comprehension quiz per listener before their memory is updated with a source link.
7. Web pages for rooms, letters, idea bin, talks; `m7.test.ts`; `scripts/acceptance/m7.mjs`.
