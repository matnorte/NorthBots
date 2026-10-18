# Contributing to NorthBots

Thanks for helping. NorthBots is the repository; NorthBot is the application. Start with the [wiki](docs/wiki/Home.md), [feature catalog](docs/wiki/Feature-Catalog.md) and [architecture](docs/ARCHITECTURE.md). This page covers setup, required checks and the rules that keep agent work reviewable.

Documentation, translations, accessibility fixes and reproducible reports are good starting points. Discuss larger changes in an issue or Discussion before implementing them. Please keep feedback respectful, specific and focused on the work; follow the [community conduct guidelines](CODE_OF_CONDUCT.md).

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

Never weaken, skip or delete a test or acceptance assertion to make a change pass. Fix the code at the root cause. Raise a timeout only with evidence that the operation is legitimately slow. Keep STATUS.md, DECISIONS.md and BLOCKERS.md current and use focused commits.

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

Follow [SECURITY.md](SECURITY.md) for private reporting. Do not put exploit details, live tokens, cookies, `.env`, backups or first-login credentials in public issues.

## Documentation

Wiki source lives in `docs/wiki/`; the published GitHub wiki is a copy. Update the relevant guide, feature catalog and README handoff when behavior changes. Run `node scripts/prepare-wiki.mjs --repo matnorte/NorthBots --output <directory>` to prepare publishable pages locally. It does not publish or require credentials. Keep instructions reproducible and distinguish verified behavior from real-account/machine blockers.
