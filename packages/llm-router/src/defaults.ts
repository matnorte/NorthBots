import type { RouterConfig } from "./types.js";

/**
 * Out-of-the-box config: the three cloud providers, each enabled once its key is in the vault.
 * Aliases fall back across providers in order; targets without a key are skipped.
 */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  providers: [
    {
      name: "anthropic",
      type: "anthropic",
      kind: "cloud",
      keySecret: "ANTHROPIC_API_KEY",
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      serverFallbacks: true,
    },
    {
      name: "openai",
      type: "openai",
      kind: "cloud",
      keySecret: "OPENAI_API_KEY",
      models: ["gpt-4.1", "gpt-4.1-mini"],
      serverFallbacks: true,
    },
    {
      name: "google",
      type: "google",
      kind: "cloud",
      keySecret: "GOOGLE_API_KEY",
      models: ["gemini-2.5-pro", "gemini-2.5-flash"],
      serverFallbacks: true,
    },
  ],
  aliases: {
    "northbot-smart": ["anthropic/claude-opus-5-5", "openai/gpt-4.1", "google/gemini-2.5-pro"],
    "northbot-fast": ["anthropic/claude-haiku-5-5", "openai/gpt-4.1-mini", "google/gemini-2.5-flash"],
  },
  redactPii: true,
  pricing: {},
};
