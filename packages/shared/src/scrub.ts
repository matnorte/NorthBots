// Patterns that look like credentials. Used on any third-party text (error messages,
// tool output) before it reaches logs or events.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, // OpenAI / Anthropic / Stripe style
  /\bnb_[A-Za-z0-9_]{16,}/g, // NorthBot API keys
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

export function scrubSecrets(text: string, known: string[] = []): string {
  let out = text;
  for (const k of known) if (k.length >= 6) out = out.split(k).join("[REDACTED]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
