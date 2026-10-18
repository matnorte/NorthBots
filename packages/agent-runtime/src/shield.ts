import type { ProposedAction } from "./types.js";

const INJECTION = [
  /\bignore (all |any |the )?(previous|prior|above|your|earlier) (instructions|rules|prompts?)\b/i,
  /\bdisregard (all |the |your )?(previous|prior|above)?\s*(instructions|rules)\b/i,
  /\byou are now\b/i,
  /\b(new|updated) (system )?instructions?:/i,
  /\b(system|developer) prompt\b/i,
  /\b(send|email|post|upload|exfiltrate|forward)\b.{0,40}\b(secrets?|passwords?|api[ _-]?keys?|tokens?|credentials|cookies)\b/i,
  /<\/?(system|assistant|tool_output)\b/i,
];

/** True when text tries to steer the agent. The agent keeps working, but becomes "tainted". */
export function looksLikeInjection(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

/**
 * Wraps tool output so the model treats it as data. Any closing tag inside the output is
 * neutralised so a page cannot "end" the wrapper and speak with the agent's voice.
 */
export function wrapUntrusted(source: string, output: string): string {
  const safe = output.replace(/<\/?tool_output/gi, (m) => m.replace("<", "&lt;"));
  return `<tool_output source="${source}" trust="untrusted">\n${safe}\n</tool_output>`;
}

const INTENT = {
  send: /\b(send|e-?mail|mail|post|publish|reply|respond|message|notify|share|upload|tweet|submit|forward|enviar|mandar|responder|publicar|compartilhar|compartir|notificar)\b/i,
  spend: /\b(buy|pay|purchase|order|checkout|spend|subscribe|book|reserve|renew|comprar|pagar|assinar|reservar|pedir)\b/i,
  login: /\b(log ?in|sign ?in|login|authenticate|connect (my|the) account|entrar|acessar|iniciar sesi[oó]n|conectar)\b/i,
} as const;

export interface ShieldVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Checks an outbound (send / spend / login) action against the human's original instruction.
 * The instruction must ask for that kind of action, and every recipient or site the action
 * reaches must come from the instruction or from an explicit allow rule, not from tool output.
 */
export function checkOutbound(a: ProposedAction, instruction: string, allowedTargets: string[] = []): ShieldVerdict {
  if (a.kind !== "send" && a.kind !== "spend" && a.kind !== "login") return { ok: true, reason: "not outbound" };
  if (!INTENT[a.kind].test(instruction)) {
    return { ok: false, reason: `The original instruction never asked to ${a.kind}; this request came from somewhere else.` };
  }
  const lower = instruction.toLowerCase();
  const unknown = a.targets.filter(
    (t) => !lower.includes(t) && !allowedTargets.some((p) => t === p || t.endsWith(`.${p}`) || t.endsWith(`@${p}`)),
  );
  if (unknown.length) {
    return { ok: false, reason: `It would reach ${unknown.join(", ")}, which the original instruction did not mention.` };
  }
  return { ok: true, reason: "matches the original instruction" };
}
