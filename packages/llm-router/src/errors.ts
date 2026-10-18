/** Base class so callers can map router errors to clear HTTP responses. */
export class RouterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A provider call failed; the router moves to the next target in the chain. */
export class ProviderError extends RouterError {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super("provider_error", `${provider}: ${message}`);
  }
}

export class BudgetExceededError extends RouterError {
  constructor(
    readonly scope: string,
    readonly limitUsd: number,
    readonly spentUsd: number,
  ) {
    super(
      "budget_exceeded",
      `Budget cap reached for ${scope}: limit $${limitUsd.toFixed(4)}, already spent $${spentUsd.toFixed(4)}. ` +
        "Raise the cap in settings or wait for the next window.",
    );
  }
}

export class PrivacyError extends RouterError {
  constructor(message: string) {
    super("privacy_violation", message);
  }
}

export class NoProviderError extends RouterError {
  constructor(message: string) {
    super("no_provider", message);
  }
}

/** Every target in the chain failed. */
export class AllProvidersFailedError extends RouterError {
  constructor(readonly attempts: { provider: string; model: string; error: string }[]) {
    super(
      "all_providers_failed",
      `All providers failed: ${attempts.map((a) => `${a.provider}/${a.model} (${a.error})`).join("; ")}`,
    );
  }
}
