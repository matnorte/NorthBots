# Blockers

Things that need a real external credential or machine. Each one is built against a fake behind the same interface, and the tests use the fake.


- **Real model providers (M2).** The OpenAI, Anthropic and Google adapters are tested only against local mock servers that speak each API's wire format; no real API key was available. To use one for real: store the key in the vault as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY` (or point `keySecret` at your own name), and the default aliases start using it.
