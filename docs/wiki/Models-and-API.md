# Models and API

NorthBot routes calls to OpenAI, Anthropic, Google, local OpenAI-compatible endpoints or scripted fake providers. The repository supplies adapters and tests; it does not supply API credits. Real provider accounts remain an explicit validation item in [BLOCKERS.md](../../BLOCKERS.md).

## Configure a provider

The provider/router settings API is `GET`/`PUT /settings/llm`. Store cloud credentials through `PUT /vault/secrets` using names such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY`. Router configuration references the secret's **name** with `keySecret`; it never includes the value. These setup operations currently use the authenticated API, rather than a model-provider form in Settings.

Aliases `northbot-smart` and `northbot-fast` resolve to ordered `provider/model` targets. Targets without credentials are skipped. Configure model IDs that your actual account/endpoint supports; the bundled defaults are examples and do not establish current provider availability or pricing. Set pricing overrides and a workspace daily cap as appropriate.

### Interactive setup example

This optional **Python 3** example asks for credentials without echoing them and keeps the session cookie in memory. Run it from a trusted local terminal. It configures one provider and points both aliases at the model you choose, preserving other providers/settings. Use `fake` to explore without a paid account; it returns canned text and performs no reasoning or tool work. Choose a real provider for useful tasks.

```python
import getpass
import http.cookiejar
import json
import urllib.request
import urllib.parse

base = input("API URL [http://localhost:8080/api]: ").strip() or "http://localhost:8080/api"
url = urllib.parse.urlsplit(base)
if url.username or url.password or url.query or url.fragment or not url.hostname:
    raise SystemExit("Use an API URL without credentials, query or fragment.")
if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}):
    raise SystemExit("Use HTTPS outside loopback development.")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with opener.open(req, timeout=30) as response:
        return json.load(response)

call("POST", "/auth/login", {"email": input("Login email: "), "password": getpass.getpass("Login password: ")})
kind = input("Provider [fake/openai/anthropic/google/openai-compatible]: ").strip()
if kind not in {"fake", "openai", "anthropic", "google", "openai-compatible"}:
    raise SystemExit("Unknown provider type.")
model = "demo" if kind == "fake" else input("Model ID supported by your provider: ").strip()
provider = {"name": "my-provider", "type": kind, "kind": "cloud", "models": [model]}
if kind == "fake":
    provider["fake"] = {"reply": "NorthBot is connected to the demo provider. Configure a real model for useful work."}
elif kind == "openai-compatible":
    provider["kind"] = input("Endpoint kind [local/cloud]: ").strip()
    provider["baseUrl"] = input("Base URL reachable from the server container: ").strip()
if kind != "fake":
    key = getpass.getpass("Provider API key (blank only if endpoint needs none): ")
    if key:
        call("PUT", "/vault/secrets", {"name": "MY_MODEL_API_KEY", "value": key})
        provider["keySecret"] = "MY_MODEL_API_KEY"
settings = call("GET", "/settings/llm")
settings["providers"] = [p for p in settings["providers"] if p["name"] != provider["name"]] + [provider]
for alias in ("northbot-smart", "northbot-fast"):
    settings["aliases"][alias] = [provider["name"] + "/" + model]
call("PUT", "/settings/llm", settings)
print("Provider configured. Review pricing and budgets before real work.")
```

Keep production endpoints on HTTPS. A local endpoint must be reachable **from the server container**; `localhost` there means the container itself. Docker Desktop commonly exposes the host through `host.docker.internal`; Linux hosts may need an explicit host-gateway mapping. Mark a provider `local` only when you control that hardware and data path.

## Budgets, privacy and fallback

Usage records include provider/model, latency, token counts, estimated cost and attempted fallbacks. Workspace, agent, task and API-key caps constrain model use. Cost accuracy depends on the price configuration; provider billing remains authoritative.

Sensitive tasks are restricted to providers marked local. Labels on restricted data can also constrain the agent. A missing local provider should fail safely rather than route sensitive content to a cloud fallback. PII redaction is enabled by default, but is not a substitute for selecting appropriate data destinations.

## OpenAI-compatible endpoints

| Direct API                  | Web-proxy address                           |
| --------------------------- | ------------------------------------------- |
| `GET /v1/models`            | `http://localhost:8080/v1/models`           |
| `POST /v1/chat/completions` | `http://localhost:8080/v1/chat/completions` |
| `POST /v1/responses`        | `http://localhost:8080/v1/responses`        |

Create a NorthBot API key through the authenticated `POST /settings/api-keys` API with a body such as `{"name":"SDK client","scopes":["llm"],"dailyBudgetUsd":1}`. The current Settings form creates MCP-scoped tokens; an LLM key needs the API. Store its one-time `key` response securely rather than logging it. Requests use `Authorization: Bearer <NorthBot API key>` or `x-api-key`. This key is distinct from the upstream provider key in the vault. The compatibility routes apply a per-key limit of 120 requests/minute as well as the server's global limits.

SDK example (install the OpenAI JavaScript SDK in your client project):

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: process.env.NORTHBOT_API_KEY,
});
const result = await client.chat.completions.create({
  model: "northbot-fast",
  messages: [{ role: "user", content: "Write a short checklist for a product listing." }],
});
console.log(result.choices[0]?.message.content);
```

Only documented request/response subsets are supported; the compatibility API is not a promise that every upstream SDK feature works. See [OpenAPI](../openapi.json) and [format implementation](../../apps/server/src/v1/format.ts) for the exact contract. Through the web proxy, ordinary REST routes use `/api/`; compatibility routes use `/v1/` directly.
