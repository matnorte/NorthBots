import { z } from "zod";
import { Cron } from "croner";
import { parse, stringify } from "yaml";

const Timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Invalid time zone");
export const ScheduleDefinition = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["cron", "once", "interval"]).default("cron"),
  cronExpr: z.string().default("0 9 * * 1-5"),
  runAt: z.string().datetime({ offset: true }).nullable().default(null),
  intervalS: z.number().int().min(1).default(3600),
  timezone: Timezone.default("America/Sao_Paulo"),
  taskPrompt: z.string().trim().min(3).max(12000),
  skillId: z.string().uuid().nullable().default(null),
  skillVersion: z.number().int().positive().nullable().default(null),
  inputs: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
  catchupPolicy: z.enum(["skip", "run_once", "run_all"]).default("run_once"),
  overlapPolicy: z.enum(["skip", "queue", "allow"]).default("skip"),
  maxRuntimeS: z.number().int().min(1).max(86400).default(600),
  budgetUsdPerRun: z.number().positive().max(10000).default(1),
  budgetUsdPerDay: z.number().positive().max(100000).default(5),
  jitterS: z.number().int().min(0).max(3600).default(0),
  retries: z.number().int().min(0).max(10).default(2),
  retryBackoffS: z.number().int().min(1).max(3600).default(30),
  pauseAfterFailures: z.number().int().min(1).max(20).default(3),
  actionKind: z.enum(["read", "write", "spend", "send", "delete", "login"]).default("read"),
  requiresApprovalFirstRun: z.boolean().default(false),
});
export type ScheduleDefinition = z.infer<typeof ScheduleDefinition>;
export type Timing = Pick<
  ScheduleDefinition,
  "kind" | "cronExpr" | "runAt" | "intervalS" | "timezone"
>;

export function normalizeCron(expression: string): string {
  const text =
    (
      { "@daily": "0 0 * * *", "@hourly": "0 * * * *", "@weekly": "0 0 * * 0" } as Record<
        string,
        string
      >
    )[expression] ?? expression.trim();
  if (text.split(/\s+/).length !== 5) throw new Error("Use a standard five-field cron expression.");
  return text;
}

export function nextTimes(spec: Timing, from: Date, count = 5): Date[] {
  if (spec.kind === "once") {
    const date = spec.runAt ? new Date(spec.runAt) : null;
    return date && date > from ? [date] : [];
  }
  if (spec.kind === "interval")
    return Array.from(
      { length: count },
      (_, i) => new Date(from.getTime() + spec.intervalS * (i + 1) * 1000),
    );
  const cron = new Cron(normalizeCron(spec.cronExpr), { timezone: spec.timezone, paused: true });
  try {
    return cron.nextRuns(count, from);
  } finally {
    cron.stop();
  }
}

export function validateTiming(spec: Timing, minimumIntervalS = 300): void {
  if (spec.kind === "once" && (!spec.runAt || !Number.isFinite(new Date(spec.runAt).getTime())))
    throw new Error("Choose a date and time for a one-off run.");
  const times = nextTimes(spec, new Date("2026-01-01T00:00:00Z"), 20);
  if (
    (spec.kind === "interval" && spec.intervalS < minimumIntervalS) ||
    times.some((at, i) => i > 0 && at.getTime() - times[i - 1]!.getTime() < minimumIntervalS * 1000)
  )
    throw new Error(`Schedules must be at least ${minimumIntervalS} seconds apart.`);
}

export function preview(spec: ScheduleDefinition, now: Date, averageCostUsd?: number) {
  const times = nextTimes(spec, now, 5);
  let runsPerDay = spec.kind === "once" ? 1 : 86400 / spec.intervalS;
  if (spec.kind === "cron") {
    const cron = new Cron(normalizeCron(spec.cronExpr), { timezone: spec.timezone, paused: true });
    try {
      runsPerDay = cron
        .nextRuns(1441, now)
        .filter((at) => at.getTime() < now.getTime() + 86400_000).length;
    } finally {
      cron.stop();
    }
  }
  return {
    nextRuns: times.map((d) => d.toISOString()),
    runsPerDay,
    warning: runsPerDay > 50,
    monthlyEstimateUsd:
      Math.round(runsPerDay * 30 * (averageCostUsd ?? spec.budgetUsdPerRun) * 100) / 100,
  };
}

/** Skip only genuinely missed ticks: ordinary poll jitter must not discard an on-time run. */
export function duePlan(
  spec: ScheduleDefinition,
  first: Date,
  now: Date,
  graceMs = 30_000,
): { due: Date[]; next: Date | null } {
  if (first > now) return { due: [], next: first };
  const next =
    spec.kind === "interval"
      ? new Date(
          first.getTime() +
            (Math.floor((now.getTime() - first.getTime()) / (spec.intervalS * 1000)) + 1) *
              spec.intervalS *
              1000,
        )
      : (nextTimes(spec, now, 1)[0] ?? null);
  if (spec.catchupPolicy === "skip" && now.getTime() - first.getTime() > graceMs)
    return { due: [], next };
  if (spec.catchupPolicy !== "run_all") return { due: [first], next };
  const due = [first];
  let cursor = first;
  while (due.length < 10) {
    const at = nextTimes(spec, cursor, 1)[0];
    if (!at || at > now) break;
    due.push(at);
    cursor = at;
  }
  return { due, next };
}

export function exportSchedules(
  items: { agentId: string | null; roomId: string | null; definition: ScheduleDefinition }[],
): string {
  return stringify({ version: 1, schedules: items });
}
export function importSchedules(yaml: string) {
  if (yaml.length > 1024 * 1024) throw new Error("Schedule import is too large.");
  const value: unknown = parse(yaml, { maxAliasCount: 20 });
  return z
    .object({
      version: z.literal(1),
      schedules: z
        .array(
          z.object({
            agentId: z.string().uuid().nullable(),
            roomId: z.string().uuid().nullable(),
            definition: ScheduleDefinition,
          }),
        )
        .max(200),
    })
    .parse(value).schedules;
}

/** Conservative parsing for common phrases; other phrases use the server's helper model. */
export function commonPhrase(text: string): Partial<ScheduleDefinition> | null {
  const value = text.toLowerCase().trim();
  if (value === "every weekday at 9am") return { kind: "cron", cronExpr: "0 9 * * 1-5" };
  if (value === "first monday of the month") return { kind: "cron", cronExpr: "0 9 * * 1#1" };
  const interval = /^every (\d+) (minutes?|hours?)$/.exec(value);
  return interval
    ? {
        kind: "interval",
        intervalS: Number(interval[1]) * (interval[2]!.startsWith("hour") ? 3600 : 60),
      }
    : null;
}
