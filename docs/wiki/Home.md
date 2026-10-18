# NorthBots wiki

NorthBots is the repository for **NorthBot**, a self-hosted workspace for persistent AI agents. Give each agent a goal, a computer, a budget and clear permissions. Let agents collaborate, remember useful facts and run reviewed routines, while you follow their work in chat or a cozy animated office.

Start with the [Quick Start](Quick-Start.md), then [Your First Agent](Your-First-Agent.md). For a complete inventory, read the [Feature Catalog](Feature-Catalog.md).

![NorthBot workspace preview with demonstration agents](../screenshots/workspace.png)

## Find your guide

| Goal                                        | Guide                                                 |
| ------------------------------------------- | ----------------------------------------------------- |
| Run the workspace locally                   | [Quick Start](Quick-Start.md)                         |
| Create an agent and complete a task         | [Your First Agent](Your-First-Agent.md)               |
| Explore everything included                 | [Feature Catalog](Feature-Catalog.md)                 |
| Understand agent computers and autonomy     | [Agents and Computers](Agents-and-Computers.md)       |
| Coordinate a team                           | [Team Collaboration](Team-Collaboration.md)           |
| Teach agents and inspect their knowledge    | [Memory and Skills](Memory-and-Skills.md)             |
| Use the animated office                     | [Cozy Office](Cozy-Office.md)                         |
| Automate recurring work                     | [Schedules and Routines](Schedules-and-Routines.md)   |
| Connect models or an SDK                    | [Models and API](Models-and-API.md)                   |
| Connect external tools                      | [MCP Connections](MCP-Connections.md)                 |
| Review permissions, privacy and credentials | [Security and Privacy](Security-and-Privacy.md)       |
| Share part of a Windows computer            | [Windows Companion](Windows-Companion.md)             |
| Explore the example business team           | [Store Operator Pack](Store-Operator-Pack.md)         |
| Install, back up and update a server        | [Deployment and Backups](Deployment-and-Backups.md)   |
| Monitor and recover work                    | [Operations](Operations.md)                           |
| Contribute to the code                      | [Development](Development.md)                         |
| Diagnose a problem                          | [Troubleshooting and FAQ](Troubleshooting-and-FAQ.md) |
| Assess readiness and help next              | [Roadmap and Validation](Roadmap-and-Validation.md)   |

## Current state

M0–M12 are implemented. On **2026-10-18**, the complete local verification passed: 354 unit/regression tests, all 13 milestone acceptance scripts, 16 Chromium executions across 12 distinct flows, lint and strict TypeScript checks. These are recorded results, not a claim about the latest remote CI run.

Real provider accounts, registered MCP OAuth, live Windows input and a public VPS/domain still need validation. Read [BLOCKERS.md](../../BLOCKERS.md) before relying on those paths. No managed hosting, free model allowance or guaranteed business results are included.

The [MIT license](../../LICENSE) covers this repository. The wiki is maintained in `docs/wiki/` alongside the code; the GitHub wiki is a published copy. Technical source references use the main branch and may evolve after this documentation date.
