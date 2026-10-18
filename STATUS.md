# Project status

NorthBot's M0–M12 feature set is implemented. The application source baseline below passed the complete local verification on 2026-10-18. Real-world integration limits remain documented in [BLOCKERS.md](BLOCKERS.md).

## Available features

| Area                                                   | State                                                 |
| ------------------------------------------------------ | ----------------------------------------------------- |
| Accounts, event log and encrypted vault                | Implemented                                           |
| Model router and compatibility API                     | Implemented; live provider accounts need validation   |
| Agent computers, runtime, permissions and approvals    | Implemented                                           |
| Chat, hatching, portraits and moods                    | Implemented                                           |
| Memory, reviewed skills and team collaboration         | Implemented                                           |
| Animated office and accessible list                    | Implemented                                           |
| Durable routines and schedules                         | Implemented                                           |
| MCP clients/server                                     | Implemented; real OAuth registration needs validation |
| Security, grants, data labels, audit and privacy tools | Implemented                                           |
| Deployment, operations and store operator pack         | Implemented; public-host and real-store checks remain |
| Windows companion                                      | Implemented; real desktop input checks remain         |

## Confirmed local validation

Application revision: `24d1026`. This is the historical full-suite baseline; later changes and their focused verification are recorded below.

| Check                                       | Confirmed result                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install/start/test/full acceptance sequence | Exit 0                                                                                                                                                              |
| `pnpm test`                                 | 354 passed: 333 Vitest tests across 11 packages plus 21 Node egress tests; zero skipped                                                                             |
| Milestone acceptance                        | All 13 M0–M12 scripts passed in one uninterrupted run                                                                                                               |
| Browser acceptance                          | 16 successful Chromium executions across 12 distinct flows, including scoped repeats                                                                                |
| `pnpm lint` and `pnpm typecheck`            | Both exit 0                                                                                                                                                         |
| Companion and deployment                    | Go vet/tests, real binary with fake desktop, backup/restore, failed-update rollback, existing-agent connectivity and clean Ubuntu 24.04 HTTPS install/re-run passed |

The native Windows read-only smoke check covered screen capture, window listing, banner and hotkeys. Real clicks/typing and live masking/revocation remain separate checks. Local test evidence is kept in ignored `test-results/`; generated runtime artifacts are not published. [GitHub Actions](https://github.com/matnorte/NorthBots/actions) shows each remote workflow's own outcome.

## Documentation and repository

The public [NorthBots repository](https://github.com/matnorte/NorthBots) uses the MIT license. Its [19-page wiki](https://github.com/matnorte/NorthBots/wiki) is maintained in `docs/wiki/` alongside the code. Issues, Discussions, discovery topics and private vulnerability reporting are enabled.

The README and wiki title use the application's existing brand mark. Public documentation focuses on features and setup; release changes live in [CHANGELOG.md](docs/CHANGELOG.md), architecture choices in [DECISIONS.md](DECISIONS.md), and remaining validation limits in [BLOCKERS.md](BLOCKERS.md).

Documentation validation includes relative-link resolution, GitHub wiki link/image preparation, formatting and the interactive model-setup example against an isolated fake-provider workspace. A scoped LLM key completed a compatibility request and was revoked; unsafe setup URLs were refused.

## Installer dependency repair (2026-10-18)

The installer now checks and installs Docker Buildx as well as Compose, using Ubuntu plugin packages for `docker.io` or official plugin packages for Docker CE. Both commands are verified before code copying or image builds. Existing plugins are reused; existing instance keys/configuration retain their behavior.

Focused verification: six installer dependency scenarios pass as root and as an unprivileged Ubuntu user, and the existing deployment CLI regressions pass. A fresh Ubuntu 24.04 environment installed the real Ubuntu Docker/Compose/Buildx packages and successfully built an image with `COMPOSE_BAKE=true`. Bash syntax and whitespace checks pass. The new dependency scenarios are included in M12; the complete M12/full-suite historical counts above are not presented as a rerun of this installer-only change. Public VPS/domain verification remains in BLOCKERS.md.
