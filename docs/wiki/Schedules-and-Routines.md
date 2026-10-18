# Schedules and Routines

Schedules turn a reviewed task or skill into repeatable work. Create them in **Schedules** or propose one from an agent chat. Always preview the actual timezone-aware occurrences before confirming.

## Schedule types

| Type            | Example                               |
| --------------- | ------------------------------------- |
| Five-field cron | `0 9 * * 1-5` for weekday mornings    |
| Macros          | `@daily`, `@hourly`                   |
| One-time        | A single future run                   |
| Interval        | Repeated runs separated by a duration |

Choose the agent or room, timezone, task and execution policy. The preview shows the next five run times and frequency/budget estimates. The default minimum interval is five minutes (`SCHEDULE_MIN_INTERVAL_S=300`). Timezone and daylight-saving behavior are tested, but you should still inspect previews around clock changes.

In chat, select **Do it** and try:

```text
schedule: every weekday at 9am | Summarize invoices
```

This creates a paused proposal for review. It does not silently authorize recurring invoice access or delivery.

## Review and control

Use run now, dry run, pause, duplicate or edit. YAML import/export supports moving definitions for review. History links each occurrence to its task, computer and event trail. Prompt/skill changes invalidate first-run approval. Every actual tool action still passes permissions and budgets.

Configure catch-up, overlap, jitter, retry/backoff, runtime and reserved daily budget limits. Repeated failures cause an automatic pause and alert after three failures. Check the error before resuming a failing routine.

## Delivery and system routines

PostgreSQL locks claim occurrences and pg-boss delivers them durably. Stable occurrence keys prevent duplicate task creation; retries reuse that identity. External side effects still need their own idempotent design—durable scheduling is not a blanket exactly-once guarantee for third-party actions.

Visible, pausable system routines cover health, ideas, expiring memory, cost and skill usage. Database backup runs on the deployment host through `northbot backup` and the installer's nightly job. The in-app backup routine remains disabled.

Source: [scheduler package](../../packages/scheduler/src/index.ts), [schedule service](../../apps/server/src/schedules/service.ts).
