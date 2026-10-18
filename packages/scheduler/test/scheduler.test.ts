import { describe, expect, it } from "vitest";
import {
  ScheduleDefinition,
  commonPhrase,
  duePlan,
  exportSchedules,
  importSchedules,
  nextTimes,
  preview,
  validateTiming,
} from "../src/index.js";
const spec = (extra: object = {}) =>
  ScheduleDefinition.parse({ name: "Invoices", taskPrompt: "Summarize invoices", ...extra });

describe("scheduler timing and safety", () => {
  it("fires a five-minute cron exactly twelve times during one simulated hour", () => {
    const schedule = spec({ cronExpr: "*/5 * * * *", timezone: "UTC" });
    let next = nextTimes(schedule, new Date("2026-01-01T00:00:00Z"), 1)[0]!;
    const fired: string[] = [];
    for (let minute = 1; minute <= 60; minute++) {
      const now = new Date(Date.parse("2026-01-01T00:00:00Z") + minute * 60_000);
      const plan = duePlan(schedule, next, now);
      fired.push(...plan.due.map((d) => d.toISOString()));
      next = plan.next!;
    }
    expect(fired).toHaveLength(12);
    expect(new Set(fired).size).toBe(12);
    expect(fired[11]).toBe("2026-01-01T01:00:00.000Z");
  });
  it("keeps local time across Lisbon DST while Sao Paulo stays UTC-3", () => {
    const from = new Date("2026-03-28T00:00:00Z");
    expect(
      nextTimes(spec({ cronExpr: "0 9 * * *", timezone: "Europe/Lisbon" }), from, 3).map((d) =>
        d.toISOString(),
      ),
    ).toEqual(["2026-03-28T09:00:00.000Z", "2026-03-29T08:00:00.000Z", "2026-03-30T08:00:00.000Z"]);
    expect(nextTimes(spec({ cronExpr: "0 9 * * *" }), from, 3).map((d) => d.getUTCHours())).toEqual(
      [12, 12, 12],
    );
  });
  it("bounds run_all catch-up, coalesces run_once and discards missed skip ticks", () => {
    const first = new Date("2026-01-01T00:05:00Z"),
      now = new Date("2026-01-01T03:05:00Z");
    expect(
      duePlan(spec({ cronExpr: "*/5 * * * *", catchupPolicy: "run_once" }), first, now).due,
    ).toHaveLength(1);
    expect(
      duePlan(spec({ cronExpr: "*/5 * * * *", catchupPolicy: "run_all" }), first, now).due,
    ).toHaveLength(10);
    expect(
      duePlan(spec({ cronExpr: "*/5 * * * *", catchupPolicy: "skip" }), first, now).due,
    ).toHaveLength(0);
  });
  it("preserves interval phase when polling is late and never repeats a one-off", () => {
    expect(
      duePlan(
        spec({ kind: "interval", intervalS: 300 }),
        new Date("2026-01-01T00:05:00Z"),
        new Date("2026-01-01T00:05:12Z"),
      ).next?.toISOString(),
    ).toBe("2026-01-01T00:10:00.000Z");
    expect(
      nextTimes(spec({ kind: "once", runAt: "2026-01-01T00:00:00Z" }), new Date("2026-01-02")),
    ).toEqual([]);
  });
  it("previews common language, confirms the next five times and warns before frequent schedules", () => {
    const schedule = spec(commonPhrase("every weekday at 9am")!);
    expect(schedule.cronExpr).toBe("0 9 * * 1-5");
    const result = preview(schedule, new Date("2026-10-18T12:00:00Z"));
    expect(result.nextRuns).toHaveLength(5);
    expect(result.nextRuns[0]).toBe("2026-10-19T12:00:00.000Z");
    const frequent = preview(
      spec({ cronExpr: "* * * * *", budgetUsdPerRun: 0.1 }),
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(frequent.warning).toBe(true);
    expect(frequent.monthlyEstimateUsd).toBeGreaterThan(4000);
    expect(() => validateTiming(spec({ cronExpr: "* * * * *" }))).toThrow("300 seconds");
  });
  it("round-trips schedule definitions through YAML without losing limits or policies", () => {
    const items = [
      {
        agentId: "b1b2f321-5d17-4da3-9d67-212706948bf8",
        roomId: null,
        definition: spec({ overlapPolicy: "queue", retries: 4, budgetUsdPerRun: 0.75 }),
      },
    ];
    expect(importSchedules(exportSchedules(items))).toEqual(items);
    expect(() => importSchedules("version: 2\nschedules: []")).toThrow();
  });
});
