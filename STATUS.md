# Status

Memory across runs. Read this, `DECISIONS.md` and `BLOCKERS.md` first, then continue from the first unfinished milestone.

| Milestone | State |
| --- | --- |
| M0 Scaffold | done (m0.sh passes) |
| M1 Accounts, event log, vault | next |
| M2 LLM router and endpoint | not started |
| M3 Agent computers | not started |
| M4 Runtime, permissions, approvals | not started |
| M5 Chat, avatars, moods, hatching | not started |
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

Start M1: accounts (argon2id + passkeys), sessions, settings, vault, typed event log, WebSocket replay.
