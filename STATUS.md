# Status

Memory across runs. Read this, `DECISIONS.md` and `BLOCKERS.md` first, then continue from the first unfinished milestone.

| Milestone | State |
| --- | --- |
| M0 Scaffold | done (m0.sh passes) |
| M1 Accounts, event log, vault | done (m1.sh passes) |
| M2 LLM router and endpoint | done (m2.sh passes) |
| M3 Agent computers | done (m3.sh passes) |
| M4 Runtime, permissions, approvals | done (m4.sh passes) |
| M5 Chat, avatars, moods, hatching | next |
| M6 Memory and skills | not started |
| M7 Multi-agent | not started |
| M8 Cozy Office | not started |
| M9 Scheduler | not started |
| M10 MCP | not started |
| M11 Security and trust | not started |
| M12 Deploy, Windows companion, store pack | not started |

## Local environment notes

- Windows dev box: run acceptance with Git Bash (`bash scripts/acceptance/m0.sh`).
- Postgres from compose is exposed on `localhost:5432` for tests.

## Failing

_Nothing known._

## Next

Start M5: chat UI (threads, streaming, attachments), SVG avatar system with mood expressions, mood engine (pure function, all 10 rows tested), hatching onboarding with self-naming (blocklist, uniqueness, name lock), Playwright e2e.
