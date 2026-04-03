// ── Provider configuration ──────────────────────────────────

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface RouterConfig {
  providers: Record<string, ProviderConfig>;
  defaultStrategy?: RoutingStrategy;
  trackCosts?: boolean;
}

// ── Routing ─────────────────────────────────────────────────

export type RoutingStrategy = "cheapest" | "fastest" | "smartest" | "fallback" | "round-robin";

export interface ChatOptions {
  system?: string;
  history?: Message[];
  strategy?: RoutingStrategy;
  providers?: string[];
  provider?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// ── Responses ───────────────────────────────────────────────

export interface ChatResponse {
  text: string;
  model: string;
  provider: string;
  usage: TokenUsage;
  latencyMs: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface StreamEvent {
  type: "text" | "done" | "error";
  text?: string;
  usage?: TokenUsage;
  error?: string;
}

// ── Model registry ──────────────────────────────────────────

export type ModelTier = "economy" | "standard" | "premium";

export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxContext: number;
  tier: ModelTier;
}

// ── Benchmarking ────────────────────────────────────────────

export interface BenchmarkResult {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  responsePreview: string;
  error?: string;
}

// ── Cost tracking ───────────────────────────────────────────

export interface CostEntry {
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
}

export interface CostSummary {
  totalCost: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<string, { cost: number; requests: number }>;
  byModel: Record<string, { cost: number; requests: number }>;
}

// ── Provider interface ──────────────────────────────────────

export interface Provider {
  name: string;
  chat(messages: Message[], model: string, opts?: { maxTokens?: number; temperature?: number; system?: string }): Promise<ProviderResponse>;
  streamChat(messages: Message[], model: string, opts?: { maxTokens?: number; temperature?: number; system?: string }): AsyncIterable<string>;
  listModels(): ModelInfo[];
  isAvailable(): boolean;
}

export interface ProviderResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// ── Known model pricing ─────────────────────────────────────

export const MODEL_REGISTRY: ModelInfo[] = [
  // Anthropic
  { id: "claude-sonnet-4-5-20241022", provider: "anthropic", displayName: "Claude Sonnet 4.5", inputCostPer1M: 3, outputCostPer1M: 15, maxContext: 200000, tier: "standard" },
  { id: "claude-opus-4-5-20250514", provider: "anthropic", displayName: "Claude Opus 4.5", inputCostPer1M: 15, outputCostPer1M: 75, maxContext: 200000, tier: "premium" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", displayName: "Claude Haiku 4.5", inputCostPer1M: 0.8, outputCostPer1M: 4, maxContext: 200000, tier: "economy" },

  // OpenAI
  { id: "gpt-4o", provider: "openai", displayName: "GPT-4o", inputCostPer1M: 2.5, outputCostPer1M: 10, maxContext: 128000, tier: "standard" },
  { id: "gpt-4o-mini", provider: "openai", displayName: "GPT-4o Mini", inputCostPer1M: 0.15, outputCostPer1M: 0.6, maxContext: 128000, tier: "economy" },
  { id: "gpt-4-turbo", provider: "openai", displayName: "GPT-4 Turbo", inputCostPer1M: 10, outputCostPer1M: 30, maxContext: 128000, tier: "premium" },
  { id: "o1", provider: "openai", displayName: "o1", inputCostPer1M: 15, outputCostPer1M: 60, maxContext: 200000, tier: "premium" },

  // Groq
  { id: "llama-3.3-70b-versatile", provider: "groq", displayName: "Llama 3.3 70B", inputCostPer1M: 0.59, outputCostPer1M: 0.79, maxContext: 128000, tier: "economy" },
  { id: "llama-3.1-8b-instant", provider: "groq", displayName: "Llama 3.1 8B", inputCostPer1M: 0.05, outputCostPer1M: 0.08, maxContext: 128000, tier: "economy" },
  { id: "mixtral-8x7b-32768", provider: "groq", displayName: "Mixtral 8x7B", inputCostPer1M: 0.24, outputCostPer1M: 0.24, maxContext: 32768, tier: "economy" },
  { id: "gemma2-9b-it", provider: "groq", displayName: "Gemma 2 9B", inputCostPer1M: 0.20, outputCostPer1M: 0.20, maxContext: 8192, tier: "economy" },

  // Google (OpenAI-compatible via proxy or direct)
  { id: "gemini-2.0-flash", provider: "google", displayName: "Gemini 2.0 Flash", inputCostPer1M: 0.1, outputCostPer1M: 0.4, maxContext: 1000000, tier: "economy" },
  { id: "gemini-2.5-pro", provider: "google", displayName: "Gemini 2.5 Pro", inputCostPer1M: 1.25, outputCostPer1M: 10, maxContext: 1000000, tier: "standard" },

  // Ollama (free, local)
  { id: "llama3.2", provider: "ollama", displayName: "Llama 3.2 (local)", inputCostPer1M: 0, outputCostPer1M: 0, maxContext: 128000, tier: "economy" },
  { id: "mistral", provider: "ollama", displayName: "Mistral (local)", inputCostPer1M: 0, outputCostPer1M: 0, maxContext: 32000, tier: "economy" },
  { id: "codellama", provider: "ollama", displayName: "Code Llama (local)", inputCostPer1M: 0, outputCostPer1M: 0, maxContext: 16000, tier: "economy" },
  { id: "deepseek-r1", provider: "ollama", displayName: "DeepSeek R1 (local)", inputCostPer1M: 0, outputCostPer1M: 0, maxContext: 64000, tier: "economy" },

  // OpenRouter (pass-through — costs vary by model)
  { id: "anthropic/claude-sonnet-4-5", provider: "openrouter", displayName: "Claude Sonnet 4.5 (via OpenRouter)", inputCostPer1M: 3, outputCostPer1M: 15, maxContext: 200000, tier: "standard" },
  { id: "openai/gpt-4o", provider: "openrouter", displayName: "GPT-4o (via OpenRouter)", inputCostPer1M: 2.5, outputCostPer1M: 10, maxContext: 128000, tier: "standard" },
  { id: "google/gemini-2.0-flash-001", provider: "openrouter", displayName: "Gemini Flash (via OpenRouter)", inputCostPer1M: 0.1, outputCostPer1M: 0.4, maxContext: 1000000, tier: "economy" },
  { id: "meta-llama/llama-3.3-70b-instruct", provider: "openrouter", displayName: "Llama 3.3 70B (via OpenRouter)", inputCostPer1M: 0.39, outputCostPer1M: 0.39, maxContext: 128000, tier: "economy" },
];

// ── Provider base URLs ──────────────────────────────────────

export const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://localhost:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// ── Default models per provider ─────────────────────────────

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5-20241022",
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  google: "gemini-2.0-flash",
  ollama: "llama3.2",
  openrouter: "anthropic/claude-sonnet-4-5",
};
