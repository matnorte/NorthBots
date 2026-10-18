/**
 * Moods are computed by rules from events, never by a model. `computeMood` is a pure function:
 * the same events and clock always give the same mood, cause and fix.
 */
export const MOODS = [
  "content",
  "proud",
  "impatient",
  "grumpy",
  "confused",
  "sad",
  "worried",
  "overwhelmed",
  "embarrassed",
  "sleepy",
  "annoyed",
] as const;
export type Mood = (typeof MOODS)[number];

/** The button shown next to a mood. Ids are stable; the web app translates the labels. */
export type MoodFix =
  | "open_approvals"
  | "review_blocked_site"
  | "review_rules"
  | "view_task"
  | "raise_budget"
  | "review_queue"
  | "say_its_ok"
  | "give_task"
  | "resume_task"
  | "say_thanks"
  | null;

export interface MoodEvent {
  type: string;
  ts: string;
  payload: Record<string, unknown>;
  costUsd?: number;
}

export interface MoodInput {
  now: Date;
  /** This agent's recent events, any order. */
  events: MoodEvent[];
  budgetDailyUsd: number;
  /** USD this agent spent today (workspace timezone). */
  spentTodayUsd: number;
  /** Tasks queued or in progress for this agent. */
  queueLength: number;
  /** Earliest deadline among its open tasks, if any. */
  nextDeadline?: Date | null;
}

export interface MoodResult {
  mood: Mood;
  /** One plain sentence. Never blames the human. */
  cause: string;
  fix: MoodFix;
  /** Ids or details the fix button needs (task id, host, ...). */
  detail: Record<string, string>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const WINDOW = { proud: 30 * MIN, sad: 60 * MIN, embarrassed: 30 * MIN, annoyed: 30 * MIN, grumpy: 2 * HOUR, confused: 2 * HOUR };

const age = (now: Date, e: MoodEvent) => now.getTime() - new Date(e.ts).getTime();
const recent = (now: Date, events: MoodEvent[], ms: number, pred: (e: MoodEvent) => boolean) =>
  events.filter((e) => age(now, e) <= ms && pred(e)).sort((a, b) => b.ts.localeCompare(a.ts));

function hostOf(e: MoodEvent): string | null {
  const p = e.payload;
  if (typeof p.host === "string") return p.host;
  for (const k of ["url", "summary"]) {
    const m = typeof p[k] === "string" ? (p[k] as string).match(/https?:\/\/([^/\s"'`]+)/) : null;
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}

type Rule = (i: MoodInput) => MoodResult | null;

const taskDetail = (e: MoodEvent): Record<string, string> => (e.payload.taskId ? { taskId: String(e.payload.taskId) } : {});

/** Checked in this order: the first rule that applies wins. */
const RULES: Rule[] = [
  (i) => {
    const failed = recent(i.now, i.events, 6 * HOUR, (e) => e.type === "schedule.paused")[0];
    return failed ? { mood: "worried", cause: "A scheduled routine needs a hand.", fix: "view_task", detail: { scheduleId: String(failed.payload.scheduleId) } } : null;
  },
  // worried: budget above 90 % or exhausted
  (i) => {
    const exhausted = recent(i.now, i.events, 6 * HOUR, (e) => e.type === "llm.blocked" && e.payload.reason === "budget_exceeded")[0];
    if (exhausted || (i.budgetDailyUsd > 0 && i.spentTodayUsd >= 0.9 * i.budgetDailyUsd)) {
      const pct = i.budgetDailyUsd > 0 ? Math.round((100 * i.spentTodayUsd) / i.budgetDailyUsd) : 100;
      return {
        mood: "worried",
        cause: exhausted ? "I ran out of today's budget, so I paused." : `I've used ${pct}% of today's budget.`,
        fix: "raise_budget",
        detail: {},
      };
    }
    return null;
  },
  // overwhelmed: queue longer than 8, or a deadline less than an hour away
  (i) => {
    const soon = i.nextDeadline && i.nextDeadline.getTime() - i.now.getTime() < HOUR;
    if (i.queueLength > 8 || soon) {
      return {
        mood: "overwhelmed",
        cause: i.queueLength > 8 ? `I have ${i.queueLength} things waiting.` : "A deadline is less than an hour away.",
        fix: "review_queue",
        detail: {},
      };
    }
    return null;
  },
  // impatient: an approval pending for more than 10 minutes
  (i) => {
    const decided = new Set(i.events.filter((e) => e.type === "approval.decided").map((e) => String(e.payload.approvalId)));
    const waiting = i.events
      .filter((e) => e.type === "approval.requested" && !decided.has(String(e.payload.approvalId)) && age(i.now, e) > 10 * MIN)
      .sort((a, b) => a.ts.localeCompare(b.ts))[0];
    if (!waiting) return null;
    return {
      mood: "impatient",
      cause: `I've been waiting ${Math.floor(age(i.now, waiting) / MIN)} minutes for an approval.`,
      fix: "open_approvals",
      detail: { approvalId: String(waiting.payload.approvalId) },
    };
  },
  // grumpy: the same site blocked 3 times
  (i) => {
    const blocks = recent(i.now, i.events, WINDOW.grumpy, (e) =>
      ["shield.blocked", "permission.blocked"].includes(e.type) || (e.type === "egress" && e.payload.status === "error"),
    );
    const counts = new Map<string, number>();
    for (const e of blocks) {
      const h = hostOf(e);
      if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    const hit = [...counts].find(([, n]) => n >= 3);
    if (!hit) return null;
    return { mood: "grumpy", cause: `I keep getting blocked on ${hit[0]}.`, fix: "review_blocked_site", detail: { host: hit[0] } };
  },
  // confused: contradictory instructions detected
  (i) => {
    const e = recent(i.now, i.events, WINDOW.confused, (x) => x.type === "instruction.contradiction")[0];
    return e ? { mood: "confused", cause: "Two of my instructions disagree with each other.", fix: "review_rules", detail: {} } : null;
  },
  // annoyed: interrupted mid-task (picked up or paused by a human)
  (i) => {
    const e = recent(i.now, i.events, WINDOW.annoyed, (x) => x.type === "agent.interrupted")[0];
    if (!e) return null;
    return {
      mood: "annoyed",
      cause: "I was in the middle of something when I got paused.",
      fix: "resume_task",
      detail: taskDetail(e),
    };
  },
  // embarrassed: the agent's own mistake was corrected
  (i) => {
    const e = recent(i.now, i.events, WINDOW.embarrassed, (x) => x.type === "feedback.correction")[0];
    return e ? { mood: "embarrassed", cause: "I made a mistake and it was corrected.", fix: "say_its_ok", detail: {} } : null;
  },
  // sad: a task failed or an idea was rejected
  (i) => {
    const e = recent(
      i.now,
      i.events,
      WINDOW.sad,
      (x) => (x.type === "task.finished" && ["failed", "blocked"].includes(String(x.payload.status))) || x.type === "idea.rejected",
    )[0];
    if (!e) return null;
    const idea = e.type === "idea.rejected";
    return {
      mood: "sad",
      cause: idea ? "One of my ideas didn't make it." : "A task didn't work out.",
      fix: idea ? null : "view_task",
      detail: taskDetail(e),
    };
  },
  // proud: a task finished or an approval came through
  (i) => {
    const e = recent(
      i.now,
      i.events,
      WINDOW.proud,
      (x) =>
        (x.type === "task.finished" && x.payload.status === "done") ||
        (x.type === "approval.decided" && String(x.payload.decision).startsWith("approve")),
    )[0];
    if (!e) return null;
    return {
      mood: "proud",
      cause: e.type === "task.finished" ? "I finished a task." : "My request was approved.",
      fix: "say_thanks",
      detail: taskDetail(e),
    };
  },
  // sleepy: nothing for more than 6 hours
  (i) => {
    const latest = i.events.reduce((max, e) => Math.max(max, new Date(e.ts).getTime()), 0);
    if (latest === 0 || i.now.getTime() - latest > 6 * HOUR) {
      return { mood: "sleepy", cause: "It's been quiet for a while.", fix: "give_task", detail: {} };
    }
    return null;
  },
];

export function computeMood(input: MoodInput): MoodResult {
  for (const rule of RULES) {
    const r = rule(input);
    if (r) return r;
  }
  return { mood: "content", cause: "All good.", fix: null, detail: {} };
}
