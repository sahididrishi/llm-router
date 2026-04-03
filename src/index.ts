// ── Library exports ─────────────────────────────────────────
// Use llm-router as a library in your own projects:
//
//   import { Router } from "llm-router";
//   const router = new Router({ providers: { anthropic: { apiKey: "..." } } });
//   const response = await router.chat("Hello");

export { Router } from "./router.js";
export { RouterError, NoProvidersError, ProviderNotFoundError, CircuitOpenError, AllProvidersFailedError } from "./errors.js";
export { CostTracker } from "./tracker.js";
export { loadConfig, generateConfigTemplate } from "./config.js";
export { createProvider, AnthropicProvider, OpenAICompatProvider } from "./providers.js";
export { MODEL_REGISTRY, DEFAULT_BASE_URLS, DEFAULT_MODELS } from "./types.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export type { CircuitState, CircuitBreakerConfig } from "./circuit-breaker.js";
export type {
  RouterConfig,
  ChatOptions,
  ChatResponse,
  Message,
  TokenUsage,
  Provider,
  ProviderConfig,
  ProviderResponse,
  ModelInfo,
  ModelTier,
  RoutingStrategy,
  BenchmarkResult,
  CostEntry,
  CostSummary,
} from "./types.js";
