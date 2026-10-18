# Blockers

Things that need a real external credential or machine. Each one is built against a fake behind the same interface, and the tests use the fake.


- **Real model providers (M2).** The OpenAI, Anthropic and Google adapters are tested only against local mock servers that speak each API's wire format; no real API key was available. To use one for real: store the key in the vault as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY` (or point `keySecret` at your own name), and the default aliases start using it.
- **Real MCP OAuth provider registration (M10).** PKCE, single-use authorization codes and user/workspace state binding are exercised through a fake provider. There is no deployed OAuth client registration for third-party servers. Supply an existing provider token through the vault for HTTP connections, or implement the `OAuthProvider` interface with your registered provider before exposing a production authorization flow. The `/fake/` routes identify their results as test-only.
