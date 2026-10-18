import { tokens } from "./embed.js";

const NEGATION = /\b(not|never|no|don'?t|doesn'?t|isn'?t|aren'?t|won'?t|can'?t|cannot|stopped|nunca|não|nao|nem|jamás|jamas|ningún|ninguna)\b/i;
const NUMBER = /\d+(?:[.,]\d+)?/g;

export interface ContradictionCheck {
  contradicts: boolean;
  reason: string;
}

/**
 * Cheap, explainable check for two related facts that disagree: same subject (shared words)
 * but one negates the other, or they state different numbers. Callers only ask about pairs
 * that are already similar by embedding.
 */
export function checkContradiction(a: string, b: string): ContradictionCheck {
  const ta = new Set(tokens(a.replace(NEGATION, " ").replace(NUMBER, " ")));
  const tb = new Set(tokens(b.replace(NEGATION, " ").replace(NUMBER, " ")));
  const shared = [...ta].filter((w) => tb.has(w)).length;
  const overlap = shared / Math.max(1, Math.min(ta.size, tb.size));
  if (overlap < 0.6) return { contradicts: false, reason: "different subjects" };
  if (NEGATION.test(a) !== NEGATION.test(b)) return { contradicts: true, reason: "one says the opposite of the other" };
  const na = (a.match(NUMBER) ?? []).join(",");
  const nb = (b.match(NUMBER) ?? []).join(",");
  if (na && nb && na !== nb) return { contradicts: true, reason: "they give different numbers" };
  return { contradicts: false, reason: "consistent" };
}
