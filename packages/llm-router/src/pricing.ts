import type { Price, Usage } from "./types.js";

/**
 * Built-in USD prices per million tokens. Anthropic rows are first-party list prices
 * (2026-10); others are best-effort defaults. Every row can be overridden in settings.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { inputPerM: 10, outputPerM: 50 },
  "claude-opus-5-5": { inputPerM: 4, outputPerM: 20 },
  "claude-sonnet-5-5": { inputPerM: 2, outputPerM: 10 },
  "claude-haiku-5-5": { inputPerM: 0.1, outputPerM: 0.5 },
  "gpt-4.1": { inputPerM: 2, outputPerM: 8 },
  "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6 },
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 10 },
  "gemini-2.5-flash": { inputPerM: 0.3, outputPerM: 2.5 },
};

/** Unknown cloud models are priced conservatively so budgets still bite. */
const UNKNOWN_CLOUD: Price = { inputPerM: 10, outputPerM: 50 };
const FREE: Price = { inputPerM: 0, outputPerM: 0 };

export function priceFor(
  provider: string,
  model: string,
  kind: "cloud" | "local",
  overrides: Record<string, Price>,
): Price {
  return (
    overrides[`${provider}/${model}`] ??
    overrides[model] ??
    DEFAULT_PRICES[model] ??
    (kind === "local" ? FREE : UNKNOWN_CLOUD)
  );
}

export function costOf(usage: Usage, price: Price): number {
  return (usage.inputTokens * price.inputPerM + usage.outputTokens * price.outputPerM) / 1_000_000;
}
