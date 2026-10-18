# Feature Catalog

This is the full functional map of the built M0–M12 workspace. Links lead to the relevant operating guide; [Roadmap and Validation](Roadmap-and-Validation.md) distinguishes automated coverage from outstanding real-world checks.

| Area                 | Included features                                                                                                                                                       | Guide                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Accounts             | Email/password signup and login, session cookies, passkey account routes, workspace isolation, authentication rate limits                                               | [Security](Security-and-Privacy.md)     |
| Agent creation       | Full and short hatching, goal/personality choices, suggested names, quick create, locked user-chosen names, unique looks                                                | [First agent](Your-First-Agent.md)      |
| Agent identity       | Ten original 2048px Higgsfield portraits, optimized WebP delivery, ten shapes × fifteen colors, moods with causes and suggestions                                       | [Agents](Agents-and-Computers.md)       |
| Team overview        | Search, status filters/counts, grid/list views, working/waiting/resting/blocked/idle states                                                                             | [Agents](Agents-and-Computers.md)       |
| Chat                 | Ask and Do it modes, attachments, task progress, recoverable send errors, context from conversations                                                                    | [Agents](Agents-and-Computers.md)       |
| Task runtime         | Planning, tool execution, verification/reporting, action classification, untrusted-input shield, approval pauses, idempotency ledger                                    | [Agents](Agents-and-Computers.md)       |
| Autonomy             | Suggest only, ask first, act within limits and autonomous modes, combined with rules, budgets and kill state                                                            | [Security](Security-and-Privacy.md)     |
| Cloud computers      | One isolated Linux computer per agent, terminal, browser tabs/actions/screenshots, persistent home, lifecycle controls, optional encrypted new volumes                  | [Computers](Agents-and-Computers.md)    |
| Model router         | OpenAI, Anthropic, Google, local OpenAI-compatible and fake providers; aliases, ordered fallback, streaming, usage/cost accounting, privacy filtering                   | [Models/API](Models-and-API.md)         |
| Compatibility API    | Models, Chat Completions and Responses endpoints; scoped, revocable API keys and daily caps                                                                             | [Models/API](Models-and-API.md)         |
| Rooms                | Membership, shared messages, room tasks and interruptions                                                                                                               | [Collaboration](Team-Collaboration.md)  |
| Letters              | Agent-to-agent requests, FYI handoffs, replies and delivery history                                                                                                     | [Collaboration](Team-Collaboration.md)  |
| Talks                | Structured discussion, questions and recorded decisions                                                                                                                 | [Collaboration](Team-Collaboration.md)  |
| Ideas                | Idea bin, retention, review/bin-picker and coordinator routing                                                                                                          | [Collaboration](Team-Collaboration.md)  |
| Memory               | Private/shared facts, semantic search, sources, expiry, contradiction handling, editing/forgetting, derived-fact relationships, import/export                           | [Memory/skills](Memory-and-Skills.md)   |
| Skills               | Human-authored and agent-proposed routines, instruction/secret scans, review cards, diffs, dry runs, versions, approval/rejection and rollback                          | [Memory/skills](Memory-and-Skills.md)   |
| Cozy Office          | Event-derived 2.5D Pixi scene, animated pixel agents, rooms, letters, ideas, break room, pets, moods, replay/time slider                                                | [Office](Cozy-Office.md)                |
| Office controls      | Lift/drop/pause, chat/menu interactions, cosmetic kindness, bubbles/topic privacy, pan/zoom, room focus, calm/reduced-motion/sound settings and accessible list         | [Office](Cozy-Office.md)                |
| Schedules            | Cron, hourly/daily macros, one-time/interval runs, timezone/DST preview, natural-language proposals, first-run review and cost estimates                                | [Routines](Schedules-and-Routines.md)   |
| Schedule reliability | PostgreSQL occurrence claims, pg-boss delivery, stable occurrence keys, catch-up/overlap/jitter/retry policies, runtime and daily budget limits, repeated-failure pause | [Routines](Schedules-and-Routines.md)   |
| Routine controls     | Run now, dry run, pause, edit, duplicate, YAML round-trip and linked run/task/computer/event history                                                                    | [Routines](Schedules-and-Routines.md)   |
| MCP clients          | Agent-computer stdio and Streamable HTTP, vault-backed bearer references, tool inspection, independent agent assignments, policies/costs, schema pinning and re-review  | [MCP](MCP-Connections.md)               |
| MCP server           | Seven team/task/memory/schedule tools, workspace-scoped revocable tokens, per-scope authorization and token rate limits                                                 | [MCP](MCP-Connections.md)               |
| Secrets              | Encrypted vault, named secret references, scoped use/injection, reserved signing secrets and redacted activity                                                          | [Security](Security-and-Privacy.md)     |
| Permissions          | Action rules for read/write/delete/send/spend/login, approval inbox, owner/user/use-only grants, expiry/revocation and handoffs                                         | [Security](Security-and-Privacy.md)     |
| Data boundaries      | Public/private/secret labels, explicit secret destinations, restricted-agent egress and local-model requirements, connection audit and alerts                           | [Security](Security-and-Privacy.md)     |
| Audit/privacy        | Ed25519-signed exports, recordings, masked companion screenshots, streaming person-data exports and bounded structural erasure                                          | [Security](Security-and-Privacy.md)     |
| Windows companion    | One-time pairing, outbound WebSocket, local app/folder shares, view/view+click/full power, banner, hotkeys, kill/take-back and local revocation                         | [Companion](Windows-Companion.md)       |
| Operations           | Health/cost/computer/routine overview, canary tasks, scheduler/stuck-task checks, dead-letter retry/dismiss, run search and incident reports                            | [Operations](Operations.md)             |
| Public status        | Instance-only status HTML and JSON, without workspace contents                                                                                                          | [Operations](Operations.md)             |
| Store operator pack  | Seven named specialists/coordinator, approval rules, three routines, fake-day simulation, profit/ROAS flags, order/payment reconciliation                               | [Store pack](Store-Operator-Pack.md)    |
| Store adapters       | Shopify orders, Mercado Pago payments, Meta ads insights and Instagram publishing adapters, safe pagination/redirect handling and requesting-user secret grants         | [Store pack](Store-Operator-Pack.md)    |
| Deployment           | Ubuntu installer, generated secrets, Caddy HTTPS, first account, CLI status/backup/restore/update, private backups and failed-update rollback                           | [Deployment](Deployment-and-Backups.md) |
| Interface            | Responsive dark UI, English/Português (Brasil)/Español, keyboard navigation, notifications, loading/error/empty states, quiet hours                                     | [Office](Cozy-Office.md)                |
| Developer experience | Strict TypeScript monorepo, zod validation/OpenAPI, event schemas, fakes, unit/integration/browser tests, M0–M12 acceptance and Go companion tests                      | [Development](Development.md)           |

## Practical uses

- A research team can collect sources, share findings through letters and preserve reviewed facts.
- A content team can draft, discuss and revise material while publishing remains subject to permission rules.
- A small-store operator can explore the included simulation and then validate adapters with its own accounts.
- A private workflow can route sensitive tasks to a local model and review which destinations an agent may contact.

These are supported building blocks, not promises of unattended correctness. The operator still supplies model/service access, grants appropriate permissions and reviews consequential outputs.
