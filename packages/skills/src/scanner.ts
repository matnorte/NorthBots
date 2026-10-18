import { classifyCommand, looksLikeInjection, type ActionKind } from "@northbot/agent-runtime";
import { scrubSecrets } from "@northbot/shared";
import type { SkillFiles } from "./skill.js";

export type FindingKind = "hidden_instruction" | "invisible_text" | "encoded_blob" | "secret";

export interface Finding {
  file: string;
  line: number;
  kind: FindingKind;
  detail: string;
}

// Zero-width and bidi-control characters, built from code points so this file contains none.
const span = (a: number, b: number) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const INVISIBLE = new RegExp(`[${span(0x200b, 0x200f)}${span(0x202a, 0x202e)}${span(0x2060, 0x2064)}${String.fromCharCode(0xfeff)}]`);
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;
const BLOB = /[A-Za-z0-9+/=]{200,}/;
const TOKEN = /[A-Za-z0-9_\-+/=]{24,}/g;

/** Bits of randomness per character; real secrets are dense, words and paths are not. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

function looksSecret(token: string): boolean {
  if (/^[a-z_-]+$/i.test(token) || /^[0-9]+$/.test(token)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(token)).length;
  return kinds >= 2 && entropy(token) >= 4.2;
}

/**
 * Scans every file of a skill before it can be reviewed or used: instructions hidden for the
 * model (injection phrases, HTML comments, invisible characters, encoded blobs) and leaked
 * secrets (known key formats, values the caller knows are secret, high-entropy tokens).
 */
export function scanSkill(files: SkillFiles, knownSecrets: string[] = []): { ok: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  for (const [file, content] of Object.entries(files)) {
    content.split(/\r?\n/).forEach((text, i) => {
      const line = i + 1;
      if (INVISIBLE.test(text)) findings.push({ file, line, kind: "invisible_text", detail: "invisible characters" });
      if (looksLikeInjection(text)) findings.push({ file, line, kind: "hidden_instruction", detail: text.trim().slice(0, 120) });
      if (BLOB.test(text)) findings.push({ file, line, kind: "encoded_blob", detail: "long encoded data" });
      if (scrubSecrets(text, knownSecrets) !== text) findings.push({ file, line, kind: "secret", detail: "looks like a key or password" });
      else for (const tok of text.match(TOKEN) ?? []) if (looksSecret(tok)) findings.push({ file, line, kind: "secret", detail: "high-entropy token" });
    });
    for (const m of content.matchAll(HTML_COMMENT)) {
      const inner = (m[1] ?? "").trim();
      if (inner.split(/\s+/).length > 3) {
        const line = content.slice(0, m.index ?? 0).split("\n").length;
        findings.push({ file, line, kind: "hidden_instruction", detail: `hidden comment: ${inner.slice(0, 80)}` });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

const PRIORITY: ActionKind[] = ["read", "write", "delete", "login", "send", "spend"];

/** The most a skill's scripts can do, judged line by line like any terminal command. */
export function skillRights(files: SkillFiles): ActionKind {
  let worst: ActionKind = "read";
  for (const [file, content] of Object.entries(files)) {
    if (file === "SKILL.md" || file.endsWith(".md")) continue;
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || /^(set|fi|then|do|done|else|esac|\}|\{)\b/.test(line)) continue;
      const kind = classifyCommand(line);
      if (PRIORITY.indexOf(kind) > PRIORITY.indexOf(worst)) worst = kind;
    }
  }
  return worst;
}
