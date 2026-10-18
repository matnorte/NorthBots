export interface TaskSummary {
  id: string;
  goal: string;
  embedding: number[];
  status: string;
  /** Tool failures before success. */
  failures: number;
  /** A human sent a correction for this task. */
  corrected: boolean;
}

export type Trigger = "repeated" | "corrected" | "demonstrated";

export interface SkillCandidate {
  trigger: Trigger;
  /** The task the draft is based on (the most recent example). */
  exampleTaskId: string;
  /** All tasks that showed the pattern. */
  taskIds: string[];
}

function cos(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d += a[i]! * b[i]!;
  return d;
}

/**
 * Finds work worth turning into a skill: the same kind of task done successfully 3 times, or
 * a task that only succeeded after mistakes or corrections. `tasks` is newest first.
 */
export function detectCandidates(tasks: TaskSummary[], opts: { similarity?: number; repeat?: number } = {}): SkillCandidate[] {
  const threshold = opts.similarity ?? 0.8;
  const repeat = opts.repeat ?? 3;
  const done = tasks.filter((t) => t.status === "done");
  const out: SkillCandidate[] = [];
  const latest = done[0];
  if (latest) {
    const similar = done.filter((t) => cos(t.embedding, latest.embedding) >= threshold);
    if (similar.length >= repeat) out.push({ trigger: "repeated", exampleTaskId: latest.id, taskIds: similar.map((t) => t.id) });
    else if (latest.failures >= 2 || latest.corrected) out.push({ trigger: "corrected", exampleTaskId: latest.id, taskIds: [latest.id] });
  }
  return out;
}
