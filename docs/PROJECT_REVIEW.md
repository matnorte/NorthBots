# Project review and UI refresh

Reviewed 2026-10-18 against README.md, STATUS.md, DECISIONS.md, the web screens, API registration, and the shared runtime packages.

## What NorthBot is

NorthBot is a self-hosted workspace for a team of AI agents. A teammate is more than a chat persona: it has an isolated Docker computer with a terminal and browser, a daily budget, a model policy, memory, learned skills, and permission rules. Humans can chat, delegate tasks, inspect the computer, approve actions, and stop the workspace.

The cozy office is a second view of that work. Its scene is derived from the event log rather than a separate simulation. Rooms coordinate group conversations; letters route requests to suitable agents; Talks structure presentations and decisions; the idea bin keeps deferred ideas available.

## Architecture

| Area                     | Responsibility                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| `apps/web`               | React, Zustand, i18next, Tailwind; lazy-loaded Pixi office and computer screen |
| `apps/server`            | Fastify API, cookie sessions, event stream, workspace services, task execution |
| `packages/shared`        | Validated schemas, names and looks, moods, event-driven office reducer         |
| `packages/agent-runtime` | Planning, tools, permissions, action ledger, self-critique, verification       |
| `packages/llm-router`    | Provider adapters, aliases, fallbacks, redaction, pricing and budget checks    |
| `packages/sandbox`       | Docker and fake computer drivers, sessions and agentd bridge                   |
| `packages/memory`        | Local embeddings, retrieval support, contradictions and archives               |
| `packages/skills`        | Skill parsing, scanning, change inspection and detection                       |
| `docker`                 | Postgres/pgvector, nginx, outbound proxy, server and isolated agent images     |

The browser calls same-origin `/api` routes through nginx. Task and collaboration changes become Postgres events, delivered over WebSocket. The office replays those events and then follows the live feed. The model-facing API is available under `/v1`.

## Product status

The repository marks M0–M7 complete. M8's office implementation exists, but STATUS.md still records an unresolved lift/drag acceptance step. The scheduler, MCP milestone, additional security/trust work and distribution milestones remain planned. This refresh does not mark those milestones complete or imply that the planned scheduler already runs.

## Changes in this refresh

- A persistent sidebar separates overview, collaboration and knowledge. Mobile navigation opens as a drawer with Escape dismissal and keyboard focus handling.
- The agent overview shows actual team counts and status filters, name search, grid/list views, daily budget limits, computer availability, and direct chat/computer actions.
- Ten original 2048 × 2048 transparent mascots were generated through Higgsfield. The existing shape × colour identity and uniqueness rules remain intact. Runtime colour filters retain the generated shading; original PNGs, optimized WebP files, prompts and generation provenance are stored in `apps/web/public/avatars`.
- UI portraits now share the generated set, including onboarding previews and room participants. Mood badges, status animations, accessible descriptions, reduced-motion support and SVG image-error fallback remain available. The office canvas keeps its animated pixel sprites.
- Shared surfaces, typography, spacing, controls and focus styles carry through all screens. Settings are grouped into cards; empty collaboration and knowledge pages explain the next useful step.
- Chat distinguishes asking from doing, provides a multiline composer, attachment removal and Ctrl/Cmd+Enter submission. Failed unaccepted sends retain the draft and files. Sending is guarded against duplicates, messages do not poll over an active reply, and scrolling respects someone reading earlier messages.
- Login has submission feedback and password-manager hints. Session and agent loading failures offer recovery; approval actions show failures and disable repeat decisions while pending.
- Added UI text in English, Brazilian Portuguese and Spanish.

## Validation

The UI browser suite uses isolated API and WebSocket fixtures and exercises the dashboard, navigation, mobile layout, chat errors and streaming, and office canvas/list parity. The existing real-backend hatching test checks that onboarding still creates a teammate and completes its first task. See the final work report for the checks actually run.

Validation completed for this refresh: repository ESLint, web TypeScript checks, eight web unit tests, seven workspace browser tests, the real-backend hatching test, and the Docker production web build all passed. Backend integration suites and the older full M8 gesture acceptance test were not rerun. The new office check also caught and verified a fix for cleanup reading the Pixi canvas before asynchronous renderer initialization completed.

![Agent workspace preview using test data](screenshots/workspace.png)
