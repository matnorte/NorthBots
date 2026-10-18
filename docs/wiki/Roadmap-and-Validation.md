# Roadmap and Validation

All planned milestones M0–M12 are built. This page describes the verified baseline and the remaining validation work; it does not invent release dates or promise unsupported integrations.

## Milestones

| Milestone | Delivered                                                    |
| --------- | ------------------------------------------------------------ |
| M0        | Monorepo, containers, health and test scaffold               |
| M1        | Accounts, event log and encrypted vault                      |
| M2        | Model router and compatibility API                           |
| M3        | Per-agent computers                                          |
| M4        | Agent runtime, permissions and approvals                     |
| M5        | Chat, avatars, moods and hatching                            |
| M6        | Memory and reviewed skills                                   |
| M7        | Rooms, letters, Talks and ideas                              |
| M8        | Cozy Office and accessible event-derived list                |
| M9        | Durable schedules and routines                               |
| M10       | MCP clients/server and scoped tokens                         |
| M11       | Security, trust, labels, grants, audit and privacy tools     |
| M12       | Deployment CLI, Windows companion, operations and store pack |

## Confirmed baseline: 2026-10-18

Application revision **`24d1026`**, followed by documentation and publication changes:

| Check                                       | Result                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install/start/test/full acceptance sequence | Exit 0                                                                                                                                                                   |
| `pnpm test`                                 | 354 passed: 333 Vitest + 21 Node egress tests; zero skipped                                                                                                              |
| Milestone scripts                           | All 13 M0–M12 in one uninterrupted full run                                                                                                                              |
| Browser acceptance                          | 16 successful Chromium executions across 12 distinct flows, including scoped repeats                                                                                     |
| Lint and strict TypeScript                  | Both exit 0                                                                                                                                                              |
| M12                                         | Go vet/tests, real companion binary with fake driver, mock adapters, backup/restore, failed-update rollback, existing-agent egress and clean Ubuntu HTTPS install/re-run |

Ignored local logs retain detailed evidence; they are not published because generated artifacts may contain private runtime material. [Project status](../../STATUS.md) records counts and source revision. A remote CI badge, when present, describes that workflow's own run and should not be substituted for these historical results.

## Remaining real-world validation

- Call real OpenAI/Anthropic/Google accounts and verify supported models and billing behavior.
- Register and exercise a real MCP OAuth provider.
- Validate real Windows input, moving/overlapping-window masking and live local revocation.
- Reconcile store reports against real Shopify, Mercado Pago and Meta accounts.
- Deploy on a public VPS/domain and verify Let's Encrypt, systemd and nightly backups.

Read [BLOCKERS.md](../../BLOCKERS.md) for the precise limits. These need real credentials or machines and are deliberately not marked complete by fake/mock tests.

## Where contributions help

Good first contributions include clearer onboarding examples, reproducible issue reports, translated UI copy and documentation improvements. More involved contributions can validate the above real-world paths, improve accessibility, add bounded/adversarial regressions or extend adapters through the existing permission system.

Discuss larger changes before implementation. Bring evidence and tests; do not weaken acceptance to obtain a green result. Keep [STATUS.md](../../STATUS.md) and [DECISIONS.md](../../DECISIONS.md) current, and propose concrete follow-up work without presenting it as a committed release schedule.
