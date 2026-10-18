# Agents and Computers

## Persistent agents

Agents retain their identity, persona, model policy, daily budget, memory and computer between tasks. The overview reports actual working, waiting, resting, blocked and idle states; moods include a cause and suggested remedy. Search, status filters and grid/list layouts help with larger teams.

An agent has one available shape/color look per workspace. User-assigned names are locked so a later naming step cannot silently replace them. Kindness actions such as a cookie or a thank-you are cosmetic; they do not grant permissions or spend money.

## Chat and task execution

**Ask** is conversational. **Do it** creates work for the runtime. Attachments enter the agent's context through the file system and data-label checks. A task moves through planning, classified actions, policy checks, tool execution and verification/reporting. The event log connects its messages, approvals, calls and computer activity.

The runtime applies injection checks to untrusted content, rules to the action kind, model/task budgets, human approvals and idempotency checks. Changing autonomy does not bypass those controls. Use a task's recorded reason to distinguish an approval wait from a failed tool or an exhausted budget.

## Agent computers

Each agent receives a Linux container with its own persistent home, terminal and browser. The computer view supports terminal inspection and browser navigation/actions, tabs and screenshots. The server controls agent computers through Docker; agents run their shell work as the unprivileged `agent` user.

Each computer has an internal network. Its outbound connections pass through the egress proxy, which checks destination policy and records connection events. The server itself controls the host Docker socket and is therefore a privileged part of the deployment: run it only on a host you administer and trust.

Use the computer's lifecycle controls for starting/stopping or restoring work. Persistent storage and image snapshots serve different purposes. With encrypted new home volumes enabled, use encrypted disk export or deployment volume backup rather than assuming an image snapshot contains the home directory. [Security and Privacy](Security-and-Privacy.md) explains the mount requirements and master-key dependency.

## Budgets and autonomy

| Mode                | Intent                                                                            |
| ------------------- | --------------------------------------------------------------------------------- |
| `suggest_only`      | Keep the agent in a proposal-oriented role                                        |
| `ask_first`         | Require human review before actions that need approval                            |
| `act_within_limits` | Work within configured rules and limits                                           |
| `autonomous`        | Broader delegated operation, still bounded by permissions, budgets and kill state |

Defaults include a $1 agent daily model budget and `ask_first`. Budget accounting needs accurate configured model prices; do not interpret it as a cap on every external service charge. Spending actions and provider-side billing have their own controls.

Source: [shared agent schemas](../../packages/shared/src/agents.ts), [runtime](../../packages/agent-runtime/src/index.ts), [sandbox implementation](../../packages/sandbox/src/docker.ts).
