import type { ActionKind, Autonomy, Decision, PermissionResult, PermissionRule, ProposedAction } from "./types.js";

/** What each autonomy level does when no rule matches. Reads are always allowed. */
export const AUTONOMY_DEFAULTS: Record<Autonomy, Record<ActionKind, Decision>> = {
  suggest_only: { read: "allow", write: "block", delete: "block", send: "block", spend: "block", login: "block" },
  ask_first: { read: "allow", write: "ask", delete: "ask", send: "ask", spend: "ask", login: "ask" },
  act_within_limits: { read: "allow", write: "allow", delete: "ask", send: "ask", spend: "ask", login: "ask" },
  autonomous: { read: "allow", write: "allow", delete: "ask", send: "allow", spend: "ask", login: "ask" },
  // No questions: everything runs. Block rules, budgets, the safety shield and the kill switch still apply.
  full_access: { read: "allow", write: "allow", delete: "allow", send: "allow", spend: "allow", login: "allow" },
};

function targetMatches(target: string, pattern: string): boolean {
  const t = target.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, "");
  return t === p || t.endsWith(`.${p}`) || t.endsWith(`@${p}`);
}

export function ruleMatches(rule: PermissionRule, a: ProposedAction): boolean {
  if (rule.kinds && !rule.kinds.includes(a.kind)) return false;
  if (rule.tools && !rule.tools.includes(a.tool)) return false;
  if (rule.targets && !a.targets.some((t) => rule.targets?.some((p) => targetMatches(t, p)))) return false;
  if (rule.pattern) {
    try {
      if (!new RegExp(rule.pattern, "i").test(a.summary)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Decides allow / ask / block. Any matching block rule wins, then allow ("always for this
 * pattern"), then ask; with no matching rule the agent's autonomy level decides. At full access
 * "ask" rules are skipped (the human chose no questions) but block rules still win.
 */
export function decide(a: ProposedAction, rules: PermissionRule[], autonomy: Autonomy): PermissionResult {
  const matching = rules.filter((r) => ruleMatches(r, a));
  const effects = autonomy === "full_access" ? (["block", "allow"] as const) : (["block", "allow", "ask"] as const);
  for (const effect of effects) {
    const r = matching.find((x) => x.effect === effect);
    if (r) return { decision: effect, reason: r.description || `rule: ${effect}`, ruleId: r.id };
  }
  const decision = AUTONOMY_DEFAULTS[autonomy][a.kind];
  return { decision, reason: `${a.kind} actions are "${decision}" at autonomy "${autonomy}"` };
}

/** The rule created when a human picks "always allow this" in the approval inbox. */
export function alwaysRuleFor(a: ProposedAction): PermissionRule {
  const escaped = a.summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    effect: "allow",
    kinds: [a.kind],
    tools: [a.tool],
    ...(a.targets.length ? { targets: a.targets } : { pattern: `^${escaped}$` }),
    description: `Always allow: ${a.summary}`,
  };
}
