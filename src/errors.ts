export class RouterError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "RouterError";
  }
}

export class NoProvidersError extends RouterError {
  constructor() {
    super(
      "No providers available. Set API keys via env vars or config file.\nRun: llm-router config init",
      "NO_PROVIDERS"
    );
    this.name = "NoProvidersError";
  }
}

export class ProviderNotFoundError extends RouterError {
  constructor(provider: string, available: string[]) {
    super(
      `Provider '${provider}' not configured. Available: ${available.join(", ")}`,
      "PROVIDER_NOT_FOUND"
    );
    this.name = "ProviderNotFoundError";
  }
}

export class CircuitOpenError extends RouterError {
  constructor(provider: string) {
    super(`Provider '${provider}' circuit is open (too many failures)`, "CIRCUIT_OPEN");
    this.name = "CircuitOpenError";
  }
}

export class AllProvidersFailedError extends RouterError {
  constructor(lastError?: Error) {
    super(
      `All providers failed${lastError ? `: ${lastError.message}` : ""}`,
      "ALL_FAILED"
    );
    this.name = "AllProvidersFailedError";
  }
}
