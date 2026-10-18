import { parse, stringify } from "yaml";
import { z } from "zod";

/** A skill is a folder: SKILL.md (frontmatter + instructions) plus scripts. */
export type SkillFiles = Record<string, string>;

export const SkillFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, "kebab-case, 2 to 48 characters"),
  description: z.string().min(10).max(500),
  inputs: z
    .array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]*$/), description: z.string().max(200), required: z.boolean().default(true) }))
    .max(10)
    .default([]),
  tools: z.array(z.enum(["terminal", "browser"])).min(1).default(["terminal"]),
  needs_approval: z.boolean().default(true),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMd(text: string): { frontmatter: SkillFrontmatter; body: string } {
  const m = text.match(FRONT);
  if (!m) throw new Error("SKILL.md must start with a --- frontmatter block.");
  const data = parse(m[1] ?? "") as unknown;
  return { frontmatter: SkillFrontmatter.parse(data), body: (m[2] ?? "").trim() };
}

export function renderSkillMd(frontmatter: SkillFrontmatter, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

const SAFE_PATH = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}(\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}){0,2}$/;

/** Structure checks: SKILL.md present and valid, safe file names, sane sizes. */
export function validateSkill(files: SkillFiles): string[] {
  const errors: string[] = [];
  if (!files["SKILL.md"]) errors.push("SKILL.md is missing.");
  else {
    try {
      parseSkillMd(files["SKILL.md"]);
    } catch (err) {
      errors.push(`SKILL.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const names = Object.keys(files);
  if (names.length > 20) errors.push("A skill can have at most 20 files.");
  for (const path of names) {
    if (!SAFE_PATH.test(path) || path.includes("..")) errors.push(`Unsafe file name: ${path}`);
    if ((files[path]?.length ?? 0) > 100_000) errors.push(`${path} is larger than 100 KB.`);
  }
  return errors;
}
