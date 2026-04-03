import { createProvider } from "./providers.js";
import { CostTracker } from "./tracker.js";
import { loadConfig } from "./config.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
  NoProvidersError,
  ProviderNotFoundError,
  CircuitOpenError,
  AllProvidersFailedError,
} from "./errors.js";
import type {
  RouterConfig, ChatOptions, ChatResponse, Message, Provider, ModelInfo,
  RoutingStrategy, BenchmarkResult, CostSummary, MODEL_REGISTRY,
} from "./types.js";
import { MODEL_REGISTRY as MODELS, DEFAULT_MODELS } from "./types.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_OUTPUT_TOKEN_ESTIMATE = 500;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Router {
  private providers: Map<string, Provider> = new Map();
  private breakers: Map<string, CircuitBreaker> = new Map();
  private tracker: CostTracker;
  private defaultStrategy: RoutingStrategy;
  private roundRobinIndex = 0;

  constructor(config?: RouterConfig) {
    const resolvedConfig = config || loadConfig();
    this.defaultStrategy = resolvedConfig.defaultStrategy || "fallback";
    this.tracker = new CostTracker(resolvedConfig.trackCosts !== false);

    for (const [name, providerConfig] of Object.entries(resolvedConfig.providers)) {
      if (!providerConfig) continue;
      const provider = createProvider(name, providerConfig);
      if (provider.isAvailable()) {
        this.providers.set(name, provider);
      }
    }

    for (const name of this.providers.keys()) {
      this.breakers.set(name, new CircuitBreaker(name));
    }
  }

  // ── Core: send a message ────────────────────────────────

  /** Send a message to an LLM. Automatically routes based on strategy with failover. */
  async chat(message: string, opts?: ChatOptions): Promise<ChatResponse> {
    const strategy = opts?.strategy || this.defaultStrategy;
    const messages = this.buildMessages(message, opts);

    // If specific provider/model requested, use directly
    if (opts?.provider) {
      return this.sendToProvider(opts.provider, messages, opts);
    }

    // Get ordered list of providers based on strategy
    const order = this.getProviderOrder(strategy, opts, messages);

    if (order.length === 0) {
      throw new NoProvidersError();
    }

    // Try providers in order (failover)
    let lastError: Error | null = null;
    for (const { provider, model } of order) {
      try {
        return await this.sendToProvider(provider, messages, { ...opts, model });
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (strategy !== "fallback" && strategy !== "cheapest" && strategy !== "smartest") {
          throw lastError; // Only failover for certain strategies
        }
      }
    }

    throw new AllProvidersFailedError(lastError ?? undefined);
  }

  // ── Streaming ───────────────────────────────────────────

  /** Stream a response from an LLM. Supports failover for fallback/cheapest/smartest strategies. */
  async *stream(message: string, opts?: ChatOptions): AsyncIterable<string> {
    const strategy = opts?.strategy || this.defaultStrategy;
    const messages = this.buildMessages(message, opts);

    if (opts?.provider) {
      const provider = this.providers.get(opts.provider);
      if (!provider) throw new ProviderNotFoundError(opts.provider, this.listProviders());
      const model = opts?.model || DEFAULT_MODELS[opts.provider] || "";
      yield* provider.streamChat(messages, model, {
        maxTokens: opts?.maxTokens,
        temperature: opts?.temperature,
        system: opts?.system,
      });
      return;
    }

    const order = this.getProviderOrder(strategy, opts, messages);
    if (order.length === 0) throw new NoProvidersError();

    let lastError: Error | null = null;
    for (const { provider: providerName, model } of order) {
      try {
        const provider = this.providers.get(providerName)!;
        yield* provider.streamChat(messages, model, {
          maxTokens: opts?.maxTokens,
          temperature: opts?.temperature,
          system: opts?.system,
        });
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (strategy !== "fallback" && strategy !== "cheapest" && strategy !== "smartest") throw lastError;
      }
    }
    throw new AllProvidersFailedError(lastError ?? undefined);
  }

  // ── Benchmarking ────────────────────────────────────────

  /** Benchmark a prompt across multiple providers. Returns timing, cost, and response preview. */
  async benchmark(
    prompt: string,
    providerNames?: string[]
  ): Promise<BenchmarkResult[]> {
    const names = providerNames || [...this.providers.keys()];
    const results: BenchmarkResult[] = [];

    for (const name of names) {
      const provider = this.providers.get(name);
      if (!provider) {
        results.push({
          provider: name,
          model: "N/A",
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          responsePreview: "",
          error: "Provider not configured",
        });
        continue;
      }

      const model = DEFAULT_MODELS[name] || "";
      const start = performance.now();

      try {
        const response = await provider.chat(
          [{ role: "user", content: prompt }],
          model,
          { maxTokens: 300 }
        );

        const latencyMs = Math.round(performance.now() - start);
        const modelInfo = this.findModel(name, response.model);
        const cost = this.calculateCost(
          response.inputTokens,
          response.outputTokens,
          modelInfo
        );

        results.push({
          provider: name,
          model: response.model,
          latencyMs,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cost,
          responsePreview: response.text.slice(0, 150) + (response.text.length > 150 ? "..." : ""),
        });
      } catch (err: unknown) {
        results.push({
          provider: name,
          model,
          latencyMs: Math.round(performance.now() - start),
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          responsePreview: "",
          error: getErrorMessage(err).slice(0, 100),
        });
      }
    }

    return results;
  }

  // ── Info ────────────────────────────────────────────────

  /** List names of all configured and available providers. */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** List available models, optionally filtered by provider. */
  listModels(providerName?: string): ModelInfo[] {
    if (providerName) {
      const provider = this.providers.get(providerName);
      return provider?.listModels() || [];
    }
    const models: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.listModels());
    }
    return models;
  }

  /** Get cost tracking summary, optionally filtered by date. */
  getCosts(since?: string): CostSummary {
    return this.tracker.getSummary(since);
  }

  /** Clear all cost tracking history. */
  clearCosts(): void {
    this.tracker.clear();
  }

  // ── Private helpers ────────────────────────────────────

  private async sendToProvider(
    providerName: string,
    messages: Message[],
    opts?: ChatOptions
  ): Promise<ChatResponse> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new ProviderNotFoundError(providerName, this.listProviders());
    }

    const breaker = this.breakers.get(providerName);
    if (breaker && !breaker.canExecute()) {
      throw new CircuitOpenError(providerName);
    }

    const model = opts?.model || DEFAULT_MODELS[providerName] || "";
    const start = performance.now();

    try {
      const response = await provider.chat(messages, model, {
        maxTokens: opts?.maxTokens,
        temperature: opts?.temperature,
        system: opts?.system,
      });

      const latencyMs = Math.round(performance.now() - start);
      const modelInfo = this.findModel(providerName, response.model);
      const cost = this.calculateCost(
        response.inputTokens,
        response.outputTokens,
        modelInfo
      );

      this.tracker.record({
        provider: providerName,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cost,
        latencyMs,
      });

      breaker?.recordSuccess();

      return {
        text: response.text,
        model: response.model,
        provider: providerName,
        usage: {
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cost,
        },
        latencyMs,
      };
    } catch (err) {
      breaker?.recordFailure();
      throw err;
    }
  }

  private buildMessages(message: string, opts?: ChatOptions): Message[] {
    const messages: Message[] = [];
    if (opts?.history) {
      messages.push(...opts.history);
    }
    messages.push({ role: "user", content: message });
    return messages;
  }

  private getProviderOrder(
    strategy: RoutingStrategy,
    opts?: ChatOptions,
    messages?: Message[]
  ): Array<{ provider: string; model: string }> {
    const available = opts?.providers
      ? opts.providers.filter((p) => this.providers.has(p))
      : [...this.providers.keys()];

    if (available.length === 0) return [];

    switch (strategy) {
      case "cheapest":
        return this.sortByCost(available, messages);
      case "fastest":
        return this.sortBySpeed(available);
      case "smartest":
        return this.sortByTier(available);
      case "round-robin":
        return this.nextRoundRobin(available);
      case "fallback":
      default:
        return available.map((p) => ({ provider: p, model: DEFAULT_MODELS[p] || "" }));
    }
  }

  private estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const msg of messages) {
      chars += msg.content.length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE); // rough estimate: ~4 chars per token
  }

  private sortByCost(providers: string[], messages?: Message[]): Array<{ provider: string; model: string }> {
    const estimatedInputTokens = messages ? this.estimateTokens(messages) : 1000;
    const estimatedOutputTokens = DEFAULT_OUTPUT_TOKEN_ESTIMATE; // reasonable default

    return providers
      .flatMap((p) => {
        const models = MODELS.filter((m) => m.provider === p);
        if (models.length === 0) return [{ provider: p, model: DEFAULT_MODELS[p] || "", cost: 999 }];
        const cheapest = models.sort((a, b) => {
          const costA = (estimatedInputTokens / 1_000_000) * a.inputCostPer1M + (estimatedOutputTokens / 1_000_000) * a.outputCostPer1M;
          const costB = (estimatedInputTokens / 1_000_000) * b.inputCostPer1M + (estimatedOutputTokens / 1_000_000) * b.outputCostPer1M;
          return costA - costB;
        })[0];
        const cost = (estimatedInputTokens / 1_000_000) * cheapest.inputCostPer1M + (estimatedOutputTokens / 1_000_000) * cheapest.outputCostPer1M;
        return [{ provider: p, model: cheapest.id, cost }];
      })
      .sort((a, b) => a.cost - b.cost)
      .map(({ provider, model }) => ({ provider, model }));
  }

  private sortBySpeed(providers: string[]): Array<{ provider: string; model: string }> {
    // Groq and Ollama (local) are typically fastest
    const speedPriority: Record<string, number> = {
      groq: 0, ollama: 1, openai: 2, google: 3, anthropic: 4, openrouter: 5,
    };
    return providers
      .sort((a, b) => (speedPriority[a] ?? 99) - (speedPriority[b] ?? 99))
      .map((p) => ({ provider: p, model: DEFAULT_MODELS[p] || "" }));
  }

  private sortByTier(providers: string[]): Array<{ provider: string; model: string }> {
    const tierOrder = { premium: 0, standard: 1, economy: 2 };
    return providers
      .flatMap((p) => {
        const models = MODELS.filter((m) => m.provider === p);
        if (models.length === 0) return [{ provider: p, model: DEFAULT_MODELS[p] || "", tier: 2 }];
        const best = models.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier])[0];
        return [{ provider: p, model: best.id, tier: tierOrder[best.tier] }];
      })
      .sort((a, b) => a.tier - b.tier)
      .map(({ provider, model }) => ({ provider, model }));
  }

  private nextRoundRobin(providers: string[]): Array<{ provider: string; model: string }> {
    const idx = this.roundRobinIndex % providers.length;
    this.roundRobinIndex++;
    const ordered = [...providers.slice(idx), ...providers.slice(0, idx)];
    return ordered.map((p) => ({ provider: p, model: DEFAULT_MODELS[p] || "" }));
  }

  private findModel(provider: string, modelId: string): ModelInfo | null {
    return MODELS.find((m) => m.id === modelId || (m.provider === provider && modelId.includes(m.id))) || null;
  }

  private calculateCost(inputTokens: number, outputTokens: number, model: ModelInfo | null): number {
    if (!model) return 0;
    return (
      (inputTokens / 1_000_000) * model.inputCostPer1M +
      (outputTokens / 1_000_000) * model.outputCostPer1M
    );
  }
}
