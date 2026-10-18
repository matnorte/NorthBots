import type { SkillFiles } from "./skill.js";

/** Line diff (LCS) in unified-ish form: "  same", "- removed", "+ added". */
export function diffLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

/** Diff of a whole skill folder, file by file, for the review card. */
export function diffSkill(before: SkillFiles, after: SkillFiles): string {
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return files
    .flatMap((f) => {
      if (before[f] === after[f]) return [];
      const header = before[f] === undefined ? `+++ ${f} (new)` : after[f] === undefined ? `--- ${f} (removed)` : `*** ${f}`;
      return [header, ...diffLines(before[f] ?? "", after[f] ?? "")];
    })
    .join("\n");
}
