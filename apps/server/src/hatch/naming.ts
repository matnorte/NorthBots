import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { checkAgentName } from "@northbot/shared";
import type { DbHandle } from "../db/client.js";
import { agents } from "../db/schema.js";
import type { LlmService } from "../llm/service.js";

export const NAMER_SYSTEM = [
  "You are a newly hatched AI agent choosing your own name.",
  'Reply with JSON only: {"candidates": [{"name": string, "reason": string}]} with exactly 3 candidates.',
  "Each name: 2 to 12 characters, letters only (spaces or hyphens allowed), friendly and original.",
  "Never use brands, products, real people, or famous characters. The reason is one short, warm sentence.",
].join("\n");

/** Used when the model is unavailable or every suggestion was rejected. */
const FALLBACK = ["Biscuit", "Mochi", "Pip", "Nimbus", "Juniper", "Pebble", "Sprout", "Waffle", "Clover", "Toffee", "Maple", "Bramble", "Tilly", "Fig", "Hazel", "Pocket", "Comet", "Plum", "Nugget", "Sunny"];

export interface NameCandidate {
  name: string;
  reason: string;
}

const Reply = z.object({ candidates: z.array(z.object({ name: z.string(), reason: z.string().default("") })).min(1) });

export async function nameTaken(db: DbHandle, workspaceId: string, name: string, exceptAgentId?: string): Promise<boolean> {
  const rows = await db.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), sql`lower(${agents.name}) = lower(${name.trim()})`));
  return rows.some((r) => r.id !== exceptAgentId);
}

/** Full name check: the shared rules plus uniqueness in the workspace. */
export async function validateName(db: DbHandle, workspaceId: string, name: string, exceptAgentId?: string) {
  const check = checkAgentName(name);
  if (!check.ok) return check;
  if (await nameTaken(db, workspaceId, name, exceptAgentId)) return { ok: false as const, problem: "taken" as const };
  return { ok: true as const };
}

/** Asks the agent's model for three names, keeps only valid ones, retries, then falls back. */
export async function proposeNames(db: DbHandle, llm: LlmService, workspaceId: string, about: string, avoid: string[] = []): Promise<NameCandidate[]> {
  const seen = new Set(avoid.map((n) => n.toLowerCase()));
  const valid: NameCandidate[] = [];
  const keep = async (c: NameCandidate) => {
    const name = c.name.trim();
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    if ((await validateName(db, workspaceId, name)).ok) valid.push({ name, reason: c.reason.trim() });
  };
  for (let attempt = 0; attempt < 3 && valid.length < 3; attempt++) {
    try {
      const res = await llm.chat(
        {
          model: "northbot-fast",
          messages: [
            { role: "system", content: NAMER_SYSTEM },
            { role: "user", content: `${about}\n${seen.size ? `Do not use: ${[...seen].join(", ")}.` : ""}` },
          ],
        },
        { workspaceId, privacy: "normal" },
      );
      const start = res.text.indexOf("{");
      const parsed = Reply.safeParse(JSON.parse(res.text.slice(start, res.text.lastIndexOf("}") + 1)));
      if (parsed.success) for (const c of parsed.data.candidates) await keep(c);
    } catch {
      break;
    }
  }
  for (const name of FALLBACK) {
    if (valid.length >= 3) break;
    await keep({ name, reason: "A cozy name that felt right." });
  }
  return valid.slice(0, 3);
}

export function nameMessage(problem: string | undefined): string {
  switch (problem) {
    case "taken":
      return "Another agent already has that name.";
    case "length":
      return "Names need 2 to 12 characters.";
    case "characters":
      return "Use letters, numbers, spaces, ' and - only.";
    default:
      return "That name isn't allowed (brands, real people, famous characters and rude words are off limits).";
  }
}
