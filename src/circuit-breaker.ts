export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failureThreshold: number;    // failures before opening (default: 5)
  resetTimeoutMs: number;      // ms before trying half-open (default: 30000)
  halfOpenMaxAttempts: number;  // probes in half-open state (default: 1)
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private config: CircuitBreakerConfig;

  constructor(public readonly name: string, config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Check if requests can be sent to this provider. */
  canExecute(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = "half-open";
        this.halfOpenAttempts = 0;
        return true;
      }
      return false;
    }
    // half-open
    return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
  }

  /** Record a successful request. Resets failure count and closes circuit. */
  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.halfOpenAttempts = 0;
  }

  /** Record a failed request. Opens circuit if threshold is reached. */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.state === "half-open") {
      this.state = "open";
    } else if (this.failures >= this.config.failureThreshold) {
      this.state = "open";
    }
  }

  getState(): CircuitState { return this.state; }
  getFailures(): number { return this.failures; }
}
