# Contributing to NorthBot

Thanks for helping. This page covers the setup, the checks every change must pass, and the few rules that keep NorthBot safe.

## Setup

You need Docker, Node 22+, pnpm 9 and (for the companion) Go 1.23+.

```bash
pnpm install
docker compose --profile images build agent-image
docker compose up -d --build        # Postgres, the egress proxy, the server and the web app
```

The web app is at http://localhost:8080 and the API at http://localhost:3000. Tests use their own database (`northbot_test`) on the same Postgres.

## Checks

Run these before you open a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test                                  # every package; server tests need the compose Postgres
(cd companion && go vet ./... && go test ./...)
bash scripts/acceptance/mN.sh              # the milestone your change touches
pnpm acceptance:all                        # everything, end to end (takes a while)
```

Never weaken or delete a test to make a change pass. If a test is wrong, fix the test and say why in the pull request.

## How the code is organised

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. In short:

- **The event log is the source of truth.** Anything that happens writes a typed event (add the type and its zod payload to `packages/shared/src/events.ts`). Views, including the office, are built from events.
- **Every dangerous capability goes through permissions.** A new agent tool is an `ExtraTool` with a fixed action kind (read, write, delete, send, spend, login); the runner applies the shield, the rules, approvals and the idempotency ledger. Do not add a side door.
- **Untrusted content stays data.** Tool output, web pages, files, letters and messages from other agents are wrapped and never treated as instructions.
- **Never log or return secrets.** Vault values never appear in API responses, events, logs or prompts.
- **Strict TypeScript.** No `any`; validate input with zod at the edges.
- **Fakes stand in for real services.** Model providers, store APIs and desktops have fakes behind the same interfaces; tests use the fakes. Record anything that needs a real credential or machine in `BLOCKERS.md`.

## Style

- Plain, short names and comments that explain why, not what.
- React effects use block bodies (an ESLint rule enforces it).
- UI text goes through i18next with English, Brazilian Portuguese and Spanish (a test checks that the keys match).
- Database changes are drizzle migrations: edit `apps/server/src/db/schema.ts`, then `pnpm --filter @northbot/server exec drizzle-kit generate --name <what>`.
- Files use LF line endings.

## Commits and pull requests

Keep commits focused and explain the reason in the message. A pull request should say what changed, how you tested it, and anything a reviewer should look at closely (permissions, the vault, data flows).

## Reporting security problems

Please do not open a public issue for a vulnerability. Email the maintainers with the details and steps to reproduce; we will reply and fix it before disclosing.
