# Security policy

NorthBot controls agent computers, model calls, secrets and optional shared Windows input. Report vulnerabilities privately and include a minimal reproduction with fake credentials/data whenever possible.

## Report a vulnerability

Use [GitHub's private vulnerability report](https://github.com/matnorte/NorthBots/security/advisories/new) when available. If private reporting is not enabled or inaccessible, contact the maintainer through the contact options on [their GitHub profile](https://github.com/matnorte). A public issue requesting a private contact channel is acceptable **without technical exploit details or sensitive data**.

Do not publish live tokens, cookies, environment files, backups, first-login credentials, private screenshots or an exploitable proof of concept in an issue. Include the affected commit, deployment context, expected/actual behavior, impact and redacted reproduction privately. No response-time or disclosure-date guarantee is established yet.

## Supported baseline

Security fixes are developed on `main`; there is no announced long-term support or backport policy. M0–M12 pass the recorded local acceptance baseline, but real provider/store accounts, registered MCP OAuth, real Windows input and a public VPS/domain remain validation items in [BLOCKERS.md](BLOCKERS.md).

Review the [security guide](docs/wiki/Security-and-Privacy.md) and [architecture](docs/ARCHITECTURE.md). Every dangerous capability must pass permissions; never work around a failed security assertion by weakening a test.
