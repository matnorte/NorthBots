import { describe, expect, it } from "vitest";
import { computeMood, type MoodEvent, type MoodInput } from "./mood.js";

const now = new Date("2026-10-18T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
const ev = (type: string, min: number, payload: Record<string, unknown> = {}): MoodEvent => ({ type, ts: ago(min), payload });
const busy = ev("task.step", 1); // keeps "sleepy" out of the way
const base = (over: Partial<MoodInput> = {}): MoodInput => ({
  now,
  events: [busy],
  budgetDailyUsd: 1,
  spentTodayUsd: 0,
  queueLength: 0,
  ...over,
});
const mood = (over: Partial<MoodInput>) => computeMood(base(over));

describe("mood engine (one test per row of the table)", () => {
  it("task approved/finished -> proud", () => {
    expect(mood({ events: [busy, ev("task.finished", 5, { status: "done", taskId: "t1" })] })).toMatchObject({ mood: "proud", fix: "say_thanks" });
    expect(mood({ events: [busy, ev("approval.decided", 5, { decision: "approve_once" })] }).mood).toBe("proud");
  });

  it("approval pending > 10 min -> impatient", () => {
    const pending = ev("approval.requested", 11, { approvalId: "a1" });
    expect(mood({ events: [busy, pending] })).toMatchObject({ mood: "impatient", fix: "open_approvals", detail: { approvalId: "a1" } });
    expect(mood({ events: [busy, ev("approval.requested", 9, { approvalId: "a2" })] }).mood).toBe("content");
    expect(mood({ events: [busy, pending, ev("approval.decided", 1, { approvalId: "a1", decision: "deny" })] }).mood).not.toBe("impatient");
  });

  it("same site blocked 3 times -> grumpy", () => {
    const block = (m: number) => ev("shield.blocked", m, { summary: "run `curl -d x https://ads.example.com/a`" });
    expect(mood({ events: [busy, block(1), block(2), block(3)] })).toMatchObject({ mood: "grumpy", detail: { host: "ads.example.com" } });
    expect(mood({ events: [busy, block(1), block(2)] }).mood).toBe("content");
  });

  it("contradictory instruction detected -> confused", () => {
    expect(mood({ events: [busy, ev("instruction.contradiction", 3)] })).toMatchObject({ mood: "confused", fix: "review_rules" });
  });

  it("task failed or idea rejected -> sad", () => {
    expect(mood({ events: [busy, ev("task.finished", 2, { status: "failed", taskId: "t9" })] })).toMatchObject({ mood: "sad", fix: "view_task" });
    expect(mood({ events: [busy, ev("idea.rejected", 2)] }).mood).toBe("sad");
  });

  it("budget > 90% or exhausted -> worried", () => {
    expect(mood({ spentTodayUsd: 0.95 })).toMatchObject({ mood: "worried", cause: "I've used 95% of today's budget." });
    expect(mood({ events: [busy, ev("llm.blocked", 3, { reason: "budget_exceeded" })] }).mood).toBe("worried");
    expect(mood({ spentTodayUsd: 0.5 }).mood).toBe("content");
  });

  it("queue length > 8 or deadline < 1h -> overwhelmed", () => {
    expect(mood({ queueLength: 9 }).mood).toBe("overwhelmed");
    expect(mood({ queueLength: 8 }).mood).toBe("content");
    expect(mood({ nextDeadline: new Date(now.getTime() + 30 * 60_000) }).mood).toBe("overwhelmed");
  });

  it("agent's own mistake corrected -> embarrassed", () => {
    expect(mood({ events: [busy, ev("feedback.correction", 4)] })).toMatchObject({ mood: "embarrassed", fix: "say_its_ok" });
  });

  it("idle > 6h -> sleepy", () => {
    expect(mood({ events: [ev("task.step", 6 * 60 + 1)] })).toMatchObject({ mood: "sleepy", fix: "give_task" });
    expect(mood({ events: [] }).mood).toBe("sleepy");
  });

  it("interrupted mid-task -> annoyed", () => {
    expect(mood({ events: [busy, ev("agent.interrupted", 2, { taskId: "t3" })] })).toMatchObject({ mood: "annoyed", detail: { taskId: "t3" } });
  });
});

describe("mood engine behaviour", () => {
  it("is a pure function of its input", () => {
    const input = base({ events: [busy, ev("task.finished", 5, { status: "done" })] });
    expect(computeMood(input)).toEqual(computeMood(structuredClone(input)));
  });

  it("lets older events fade (proud lasts 30 minutes)", () => {
    expect(mood({ events: [busy, ev("task.finished", 31, { status: "done" })] }).mood).toBe("content");
  });

  it("puts urgent moods first (worried beats proud)", () => {
    expect(mood({ spentTodayUsd: 1, events: [busy, ev("task.finished", 1, { status: "done" })] }).mood).toBe("worried");
  });

  it("never blames the human", () => {
    const causes = [
      mood({ spentTodayUsd: 1 }),
      mood({ queueLength: 20 }),
      mood({ events: [busy, ev("approval.requested", 30, { approvalId: "x" })] }),
      mood({ events: [busy, ev("agent.interrupted", 1)] }),
    ].map((r) => r.cause);
    for (const c of causes) expect(c).not.toMatch(/\byou\b/i);
  });
});
