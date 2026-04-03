# llm-router

One interface for every LLM. Route requests across Claude, GPT, Gemini, Groq, Ollama, OpenRouter, and any OpenAI-compatible API — with smart routing, automatic failover, and cost tracking.

**Zero provider SDK dependencies.** Pure HTTP. Works with any provider.

```typescript
import { Router } from "llm-router";

const router = new Router();
const response = await router.chat("Explain quantum computing", {
  strategy: "cheapest",   // or "fastest", "smartest", "fallback", "round-robin"
});

console.log(response.text);
console.log(response.provider);   // "groq"
console.log(response.usage.cost); // 0.0001
```

## The Problem

- Your code is locked to one AI provider. Switching means rewriting everything.
- One provider goes down and your entire app breaks.
- You're using GPT-4 for tasks that a $0.05/M model could handle.
- You have no idea how much you're spending per provider, per model, per feature.

**llm-router** fixes all of this with a single import.

## Features

### Unified interface
Same API for every provider. Swap Claude for GPT by changing one string.

### 5 routing strategies
| Strategy | Behavior |
|----------|----------|
| `cheapest` | Routes to the lowest-cost model across all providers |
| `fastest` | Routes to the fastest provider (Groq, Ollama, etc.) |
| `smartest` | Routes to the highest-tier model available |
| `fallback` | Tries providers in order, skips on failure |
| `round-robin` | Distributes requests evenly across providers |

### Automatic failover
If a provider returns an error, the router automatically tries the next one.

### Cost tracking
Every request is tracked — tokens, cost, latency — with per-provider and per-model breakdowns. Persisted to `~/.llm-router/costs.json`.

### Streaming
Real-time streaming from any provider via async iterators.

### CLI tool
Full CLI for quick chats, benchmarking, model discovery, and cost analysis.

## Supported Providers

| Provider | API Type | Key Required | Notes |
|----------|----------|-------------|-------|
| **Anthropic** | Native | Yes (`ANTHROPIC_API_KEY`) | Claude Sonnet, Opus, Haiku |
| **OpenAI** | Native | Yes (`OPENAI_API_KEY`) | GPT-4o, GPT-4o Mini, o1 |
| **Groq** | OpenAI-compatible | Yes (`GROQ_API_KEY`) | Llama, Mixtral — blazing fast |
| **Google** | OpenAI-compatible | Yes (`GOOGLE_API_KEY`) | Gemini Flash, Gemini Pro |
| **Ollama** | OpenAI-compatible | No | Local models — free, private |
| **OpenRouter** | OpenAI-compatible | Yes (`OPENROUTER_API_KEY`) | 100+ models, one key |
| **Any OpenAI-compatible** | OpenAI-compatible | Varies | Together, Fireworks, Mistral, etc. |

## Installation

```bash
git clone https://github.com/sahididrishi/llm-router.git
cd llm-router
npm install
npm run build
```

### Set up providers

**Option 1: Environment variables** (simplest)
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GROQ_API_KEY=gsk_...
```

**Option 2: Config file**
```bash
llm-router config init    # Creates .llm-router.json
```

```json
{
  "providers": {
    "anthropic": { "apiKey": "$ANTHROPIC_API_KEY" },
    "openai": { "apiKey": "$OPENAI_API_KEY" },
    "groq": { "apiKey": "$GROQ_API_KEY" },
    "ollama": { "baseUrl": "http://localhost:11434/v1" }
  },
  "defaultStrategy": "cheapest"
}
```

The `$VAR_NAME` syntax reads from environment variables at runtime.

## Library Usage

```typescript
import { Router } from "llm-router";

// Auto-detects providers from env vars
const router = new Router();

// Simple chat
const response = await router.chat("Hello");

// With options
const response = await router.chat("Explain this code", {
  provider: "anthropic",
  model: "claude-sonnet-4-5-20241022",
  system: "You are a senior engineer",
  maxTokens: 2000,
  temperature: 0.7,
});

// Strategy-based routing
const cheap = await router.chat("Quick question", { strategy: "cheapest" });
const fast = await router.chat("Need this now", { strategy: "fastest" });
const best = await router.chat("Complex task", { strategy: "smartest" });

// With conversation history
const response = await router.chat("Follow up question", {
  history: [
    { role: "user", content: "Previous message" },
    { role: "assistant", content: "Previous response" },
  ],
});

// Streaming
for await (const chunk of router.stream("Tell me a story")) {
  process.stdout.write(chunk);
}

// Benchmarking
const results = await router.benchmark("Explain AI");
for (const r of results) {
  console.log(`${r.provider}: ${r.latencyMs}ms, $${r.cost.toFixed(4)}`);
}

// Cost tracking
const costs = router.getCosts();
console.log(`Total spent: $${costs.totalCost.toFixed(2)}`);
```

## CLI Usage

```bash
# Chat with auto-routing
llm-router chat "What is the capital of France?"

# Use a specific provider
llm-router chat "Hello" --provider anthropic

# Use cheapest available model
llm-router chat "Quick question" --strategy cheapest

# Stream the response
llm-router chat "Tell me a story" --stream --provider openai

# Benchmark across providers
llm-router bench "Explain quantum computing"
llm-router bench "Write a haiku" --providers anthropic,openai,groq

# List all models with pricing
llm-router models
llm-router models --provider groq

# Check costs
llm-router costs
llm-router costs --since 2025-01-01

# See configured providers
llm-router providers

# Create config file
llm-router config init
llm-router config init --global
```

## Adding Custom Providers

Any OpenAI-compatible API works out of the box:

```typescript
const router = new Router({
  providers: {
    // Together AI
    together: {
      apiKey: process.env.TOGETHER_API_KEY,
      baseUrl: "https://api.together.xyz/v1",
      defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    },
    // Fireworks AI
    fireworks: {
      apiKey: process.env.FIREWORKS_API_KEY,
      baseUrl: "https://api.fireworks.ai/inference/v1",
    },
    // Self-hosted vLLM
    internal: {
      baseUrl: "http://gpu-server:8000/v1",
    },
  },
});
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Your Application                │
│                                                  │
│  router.chat("Hello", { strategy: "cheapest" })  │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│                    Router                        │
│                                                  │
│  ┌────────────┐  ┌──────────┐  ┌─────────────┐  │
│  │  Strategy  │  │ Failover │  │   Cost      │  │
│  │  Engine    │  │ Handler  │  │   Tracker   │  │
│  │            │  │          │  │             │  │
│  │ cheapest   │  │ try next │  │ per request │  │
│  │ fastest    │  │ on error │  │ per model   │  │
│  │ smartest   │  │          │  │ per provider│  │
│  │ fallback   │  │          │  │ persisted   │  │
│  │ round-robin│  │          │  │             │  │
│  └─────┬──────┘  └────┬─────┘  └──────┬──────┘  │
│        └───────────────┼───────────────┘         │
│                        ▼                         │
│  ┌─────────────────────────────────────────────┐ │
│  │            Provider Layer                   │ │
│  │                                             │ │
│  │  AnthropicProvider    OpenAICompatProvider   │ │
│  │  (native API)        (any /chat/completions)│ │
│  └──┬────────────────────┬─────────────────────┘ │
└─────│────────────────────│───────────────────────┘
      │                    │
      ▼                    ▼
   Anthropic    OpenAI / Groq / Google / Ollama / OpenRouter / ...
```

## Project Structure

```
llm-router/
├── src/
│   ├── index.ts       # Library exports
│   ├── types.ts       # Types, model registry, pricing data
│   ├── providers.ts   # Anthropic + OpenAI-compatible providers
│   ├── router.ts      # Router class — strategies, failover, tracking
│   ├── tracker.ts     # Cost tracking with JSON persistence
│   ├── config.ts      # Config file loading with $ENV_VAR support
│   └── cli.ts         # CLI — chat, bench, models, costs, config
├── tests/
│   └── router.test.ts # 25 tests — models, providers, router, costs, config
├── dist/              # Compiled JavaScript + type declarations
├── package.json
├── tsconfig.json
└── README.md
```

## Design Decisions

- **Zero SDK dependencies** — Raw HTTP via `fetch()`. No `@anthropic-ai/sdk`, no `openai` package. Shows you understand the underlying APIs, not just wrappers. Also means smaller install and no version conflicts.
- **Two provider classes handle everything** — `AnthropicProvider` for Claude's unique API format, `OpenAICompatProvider` for every `/v1/chat/completions` endpoint. Adding a new provider is one config object.
- **Config file with $ENV_VAR syntax** — API keys reference env vars (`"$OPENAI_API_KEY"`), so config files are safe to commit. Secrets stay in the environment.
- **Persistent cost tracking** — Every request logged to `~/.llm-router/costs.json`. Capped at 10K entries to prevent unbounded growth.
- **Model registry with known pricing** — 20+ models with accurate pricing data. Cost calculated automatically per request.

## License

MIT
