# Technical Documentation: llm-router

> **Version:** 1.0.0
> **Author:** Sahid Idrishi
> **License:** MIT
> **Last updated:** April 2026

---

## Table of Contents

1. [What This Project Does](#1-what-this-project-does)
2. [How LLM APIs Work](#2-how-llm-apis-work)
3. [System Architecture](#3-system-architecture)
4. [Provider Abstraction](#4-provider-abstraction)
5. [Routing Strategies Deep Dive](#5-routing-strategies-deep-dive)
6. [Circuit Breaker Pattern](#6-circuit-breaker-pattern)
7. [Cost Tracking](#7-cost-tracking)
8. [Configuration System](#8-configuration-system)
9. [Error Handling Strategy](#9-error-handling-strategy)
10. [CLI Design](#10-cli-design)
11. [Testing Strategy](#11-testing-strategy)
12. [How to Build a Similar Multi-Provider System](#12-how-to-build-a-similar-multi-provider-system)
13. [Glossary](#13-glossary)

---

## 1. What This Project Does

### Plain English explanation

Imagine you want to order a pizza. You could call one specific pizza place every time, but what if they are closed, or their prices went up, or the wait is two hours? Wouldn't it be nice to have a single phone number that automatically finds you the cheapest, fastest, or best pizza from any place in town -- and if one shop can't deliver, it seamlessly calls the next one?

That is what `llm-router` does, except for AI language models instead of pizza.

Large Language Models (LLMs) like ChatGPT, Claude, and Gemini are powerful AI systems that understand and generate human language. Dozens of companies offer access to these models through the internet. Each company has its own door to knock on (its "API"), its own pricing, its own strengths, and its own quirks. If you build software that relies on just one of them, you are stuck with that one provider's prices, downtime, and limitations.

`llm-router` is a piece of software that sits between your application and all of those AI providers. You send it a message. It decides which provider to use -- based on rules you set -- sends the message, gets the response, tracks how much it cost, and gives you back the answer. If one provider is down, it automatically tries the next. If you want the cheapest option, it calculates pricing across all providers and picks the winner. If you want the smartest model, it knows which ones are top-tier.

### The problems it solves

| Problem | Without llm-router | With llm-router |
|---------|-------------------|-----------------|
| **Vendor lock-in** | Your code is written specifically for one provider. Switching means rewriting everything. | One interface works with every provider. Change a single string to switch. |
| **Cost** | You might be using an expensive model for tasks a cheap one could handle just fine. | The `cheapest` strategy automatically picks the lowest-cost option. |
| **Reliability** | If your provider goes down, your app goes down. | Automatic failover tries the next provider when one fails. |
| **No visibility** | You have no idea how much you're spending, on which models, for which features. | Every request is tracked -- tokens, cost, latency -- with breakdowns by provider and model. |

### Who would use this and why

- **Startups building AI features** -- route to the cheapest model during development, the smartest in production, and failover to a backup if anything goes wrong.
- **Enterprises with multiple AI contracts** -- distribute load across providers, track spending per team or feature.
- **Developers experimenting** -- benchmark the same prompt across five providers and compare speed, quality, and cost in one command.
- **Anyone tired of rewriting code** when switching from OpenAI to Anthropic (or vice versa).

### Library vs CLI: two ways to use it

`llm-router` is designed as a **dual-use package**. This means it serves two completely different audiences from the same codebase:

1. **As a library** -- import it into your Node.js / TypeScript project and use it programmatically:

   ```typescript
   import { Router } from "llm-router";
   const router = new Router();
   const response = await router.chat("Explain quantum computing", {
     strategy: "cheapest",
   });
   console.log(response.text);
   ```

2. **As a CLI tool** -- run it from your terminal for quick tasks, benchmarking, and cost analysis:

   ```bash
   llm-router chat "Explain quantum computing" --strategy cheapest
   llm-router bench "Write a haiku" --providers anthropic,openai,groq
   llm-router costs --since 2026-01-01
   ```

The library entry point is `src/index.ts` (compiled to `dist/index.js`). The CLI entry point is `src/cli.ts` (compiled to `dist/cli.js`). Both share the same core modules -- the Router, providers, tracker, and config system.

---

## 2. How LLM APIs Work

### What is an LLM API in simple terms

An API (Application Programming Interface) is a way for one program to talk to another over the internet. Think of it like a restaurant menu: you tell the waiter (the API) what you want, the kitchen (the server) prepares it, and the waiter brings it back. You don't need to know how the kitchen works -- you just need to know how to read the menu and place your order.

An LLM API is specifically a service where you send text (your prompt) and get text back (the AI's response). The AI model itself runs on powerful servers in data centers -- you just interact with it through HTTP requests.

### The chat completion pattern: messages in, response out

Almost all modern LLM APIs follow the **chat completion** pattern. Here's how it works:

1. You send an array of **messages**, each with a **role** and **content**.
2. The API sends back a **completion** -- the model's response.

The three roles are:

| Role | Purpose | Example |
|------|---------|---------|
| `system` | Sets the AI's personality and instructions | "You are a helpful coding assistant" |
| `user` | The human's message | "How do I sort an array in Python?" |
| `assistant` | A previous AI response (for conversation context) | "You can use the sorted() function..." |

A typical request looks like this:

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is the capital of France?" }
  ],
  "max_tokens": 100
}
```

And the response:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "The capital of France is Paris."
    }
  }],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 8
  }
}
```

### How different providers differ

While the pattern is the same -- messages in, response out -- providers differ in the details:

**Anthropic (Claude)** uses a unique API format:
- System messages go in a separate top-level `system` field, not in the messages array.
- Authentication uses a custom `x-api-key` header and an `anthropic-version` header.
- The response uses `content[0].text` instead of `choices[0].message.content`.
- Token fields are named `input_tokens` and `output_tokens`.

**OpenAI and compatibles** (GPT, Groq, Google, Ollama, OpenRouter) all follow the OpenAI format:
- System messages go directly in the messages array.
- Authentication uses a `Bearer` token in the `Authorization` header.
- The response uses `choices[0].message.content`.
- Token fields are named `prompt_tokens` and `completion_tokens`.

This difference is the reason `llm-router` has two provider classes instead of one.

### OpenAI-compatible APIs: the de facto standard

OpenAI's API format has become the industry standard. When a company says their API is "OpenAI-compatible," they mean: you can send the same JSON, to the same `/v1/chat/completions` endpoint path, and get back the same response shape. Only the base URL and API key change.

This is a huge win for `llm-router`. Here is the landscape:

| Provider | Base URL | Notes |
|----------|----------|-------|
| OpenAI | `https://api.openai.com/v1` | The original |
| Groq | `https://api.groq.com/openai/v1` | Ultra-fast inference |
| Google | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini models |
| Ollama | `http://localhost:11434/v1` | Local models, free |
| OpenRouter | `https://openrouter.ai/api/v1` | 100+ models, one key |
| Together AI | `https://api.together.xyz/v1` | Custom GPU clusters |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | Optimized inference |

Because they all speak the same language, a single `OpenAICompatProvider` class handles all of them.

### Streaming with Server-Sent Events (SSE): how real-time responses work

When you ask an LLM a question, the model generates its answer one token at a time (a token is roughly a word or word-piece). Without streaming, you wait for the entire response to be generated before you see anything. With streaming, each token is sent to you as soon as it is generated, so you see the answer appearing in real-time -- just like watching someone type.

The protocol used for this is **Server-Sent Events (SSE)**. Here is how it works:

1. You send a normal HTTP request, but include `"stream": true` in the body.
2. Instead of a single JSON response, the server sends a stream of text lines.
3. Each line starts with `data: ` followed by a JSON chunk.
4. The final line is `data: [DONE]`.

A stream looks like this over the wire:

```
data: {"choices":[{"delta":{"content":"The"}}]}

data: {"choices":[{"delta":{"content":" capital"}}]}

data: {"choices":[{"delta":{"content":" of"}}]}

data: {"choices":[{"delta":{"content":" France"}}]}

data: {"choices":[{"delta":{"content":" is"}}]}

data: {"choices":[{"delta":{"content":" Paris."}}]}

data: [DONE]
```

In `llm-router`, the `parseSSE` function in `src/providers.ts` reads this stream using the Web Streams API's `ReadableStream.getReader()`, buffers incoming bytes, splits on newlines, extracts the `data: ` lines, and yields each JSON payload as a string. The provider-specific `streamChat` methods then parse the JSON and yield just the text content.

### Tokens and pricing: how costs are calculated

LLMs don't think in words -- they think in **tokens**. A token is typically 3-4 characters of English text. The word "hamburger" might be split into "ham", "bur", "ger" -- three tokens. Short common words like "the" are one token.

Providers charge per token, separately for input and output:

- **Input tokens** (also called prompt tokens): the text you send to the model. This includes the system prompt, conversation history, and your current message.
- **Output tokens** (also called completion tokens): the text the model generates in response.

Pricing is typically quoted per million tokens. For example, GPT-4o charges $2.50 per million input tokens and $10.00 per million output tokens.

The cost formula used by `llm-router` (in `Router.calculateCost`):

```
cost = (inputTokens / 1,000,000) * inputCostPer1M
     + (outputTokens / 1,000,000) * outputCostPer1M
```

So if you send 1,000 input tokens and receive 500 output tokens using GPT-4o:

```
cost = (1000 / 1,000,000) * 2.50 + (500 / 1,000,000) * 10.00
     = 0.0025 + 0.005
     = $0.0075
```

---

## 3. System Architecture

### ASCII diagram: all components and data flow

```
                           USER APPLICATION
                    (or CLI: llm-router chat "Hello")
                                 |
                                 v
  +-----------------------------------------------------------------+
  |                          src/index.ts                           |
  |                     (Library entry point)                       |
  |  Exports: Router, CostTracker, CircuitBreaker, errors, types   |
  +-----------------------------------------------------------------+
                                 |
              +------------------+------------------+
              |                                     |
              v                                     v
  +------------------------+           +------------------------+
  |      src/router.ts     |           |      src/cli.ts        |
  |                        |           |                        |
  |  - Routing strategies  |           |  - 6 CLI commands      |
  |  - Failover logic      |           |  - ANSI formatting     |
  |  - Message building    |           |  - Benchmark display   |
  |  - Cost calculation    |           |  - Uses commander      |
  |  - Benchmarking        |           |                        |
  +-----+-----+-----+-----+           +------------------------+
        |     |     |
        v     v     v
  +----------+ +----------+ +------------------+
  | Provider | | Cost     | | Circuit Breaker  |
  | Layer    | | Tracker  | | (per provider)   |
  |          | |          | |                  |
  | providers| | tracker  | | circuit-breaker  |
  | .ts      | | .ts      | | .ts              |
  +----+-----+ +----+-----+ +------------------+
       |             |
       v             v
  +-----------+  +------------------+
  | External  |  | ~/.llm-router/   |
  | LLM APIs  |  |   costs.json     |
  +-----------+  +------------------+

  Supporting modules:
  +-------------+  +-------------+  +-------------+
  | src/types.ts|  | src/config.ts|  | src/errors.ts|
  | Model data  |  | Config load  |  | Error types  |
  | Interfaces  |  | $ENV_VAR     |  | Hierarchy    |
  | Pricing     |  | Auto-detect  |  |              |
  +-------------+  +-------------+  +-------------+
```

### How a request flows through the system

Here is the complete journey of a request through `llm-router`, step by step:

```
Step 1: User calls router.chat("Hello", { strategy: "cheapest" })

Step 2: Router.chat() builds messages array
        [ { role: "user", content: "Hello" } ]
        (includes history if provided)

Step 3: Router.getProviderOrder("cheapest", ...) is called
        - Gets list of available providers
        - For "cheapest": estimates token count from message length
          (chars / 4 = approximate tokens)
        - Calculates estimated cost for each provider's cheapest model
        - Returns providers sorted by cost, cheapest first

Step 4: Router tries providers in order (failover loop)
        For each { provider, model } in the sorted list:

        Step 4a: Check circuit breaker for this provider
                 - If circuit is OPEN: skip (throw CircuitOpenError)
                 - If CLOSED or HALF-OPEN: proceed

        Step 4b: Call provider.chat(messages, model, options)
                 - AnthropicProvider: POST to /v1/messages
                   with x-api-key header, Anthropic format
                 - OpenAICompatProvider: POST to /chat/completions
                   with Bearer token, OpenAI format

        Step 4c: Wait for HTTP response (with timeout)
                 - fetchWithTimeout uses AbortController
                 - Default timeout: 30 seconds

        Step 4d: Parse response
                 - Extract text, model name, token counts
                 - Calculate cost using MODEL_REGISTRY pricing

        Step 4e: Record success
                 - Circuit breaker: recordSuccess() (resets failures)
                 - Cost tracker: record entry to costs.json
                 - Return ChatResponse to user

        Step 4f: On failure
                 - Circuit breaker: recordFailure() (may open circuit)
                 - If strategy supports failover: try next provider
                 - If all fail: throw AllProvidersFailedError

Step 5: User receives ChatResponse:
        {
          text: "Hello! How can I help you today?",
          model: "llama-3.1-8b-instant",
          provider: "groq",
          usage: { inputTokens: 10, outputTokens: 12, cost: 0.000001 },
          latencyMs: 145
        }
```

### Each module's role explained in plain English

| Module | File | Role |
|--------|------|------|
| **Types** | `src/types.ts` | The dictionary. Defines the shape of every data structure used in the project -- what a provider config looks like, what a chat response contains, what a cost entry records. Also contains the MODEL_REGISTRY (pricing data for 20+ models) and default URLs/models for each provider. |
| **Providers** | `src/providers.ts` | The translators. Takes a universal message format and translates it into the specific HTTP request each API expects. Two classes: `AnthropicProvider` for Claude's unique format, `OpenAICompatProvider` for everything else. Also handles streaming via SSE. |
| **Router** | `src/router.ts` | The brain. Decides which provider to use based on strategy, sends the request, handles failover if it fails, calculates costs, and records everything. This is the main class users interact with. |
| **Tracker** | `src/tracker.ts` | The accountant. Records every request's cost, tokens, and latency. Saves to disk as JSON. Provides summaries filtered by provider, model, or date range. |
| **Config** | `src/config.ts` | The settings manager. Loads configuration from JSON files or environment variables. Supports the `$ENV_VAR` pattern so config files never contain actual secrets. |
| **Circuit Breaker** | `src/circuit-breaker.ts` | The safety switch. Tracks failures per provider. If a provider fails too many times, the circuit "opens" and stops sending requests to it for a cooldown period, preventing cascading failures. |
| **Errors** | `src/errors.ts` | The error vocabulary. Defines specific error types so calling code can catch and handle different failure modes distinctly (no providers configured vs. specific provider down vs. all providers failed). |
| **CLI** | `src/cli.ts` | The command-line interface. Uses the `commander` library to parse commands and options, creates a Router instance, and formats output with ANSI colors for terminal display. |
| **Index** | `src/index.ts` | The front door. Re-exports everything that library consumers need. This is what `import { Router } from "llm-router"` resolves to. |

### The dual-use design: library exports + CLI entry point

The project compiles to two independent entry points:

- `dist/index.js` is the library. When another project does `import { Router } from "llm-router"`, Node.js loads this file. It exports classes, types, and utilities -- no side effects, no CLI parsing.

- `dist/cli.js` is the CLI. When you run `llm-router chat "Hello"` from your terminal, Node.js loads this file. It immediately parses command-line arguments using `commander` and executes the appropriate action.

The `package.json` declares both:

```json
{
  "main": "dist/index.js",       // Library entry point
  "types": "dist/index.d.ts",    // TypeScript type declarations
  "bin": {
    "llm-router": "./dist/cli.js" // CLI entry point
  }
}
```

---

## 4. Provider Abstraction

### The Provider interface: what every provider must implement

The `Provider` interface in `src/types.ts` defines the contract that every provider must follow:

```typescript
interface Provider {
  name: string;

  chat(
    messages: Message[],
    model: string,
    opts?: { maxTokens?: number; temperature?: number; system?: string }
  ): Promise<ProviderResponse>;

  streamChat(
    messages: Message[],
    model: string,
    opts?: { maxTokens?: number; temperature?: number; system?: string }
  ): AsyncIterable<string>;

  listModels(): ModelInfo[];
  isAvailable(): boolean;
}
```

Think of this like a job description. Any class that wants to be a "provider" in the system must be able to:

1. **`chat()`** -- Accept messages and return a complete response (text + token counts).
2. **`streamChat()`** -- Accept messages and return a stream of text chunks as they arrive.
3. **`listModels()`** -- Report which models it offers, with pricing and capabilities.
4. **`isAvailable()`** -- Confirm that it has the credentials needed to make API calls.

The Router never talks to APIs directly -- it only talks through this interface. This means you could add a completely new provider (say, a custom AI running on your company's servers) by creating a class that implements these four methods.

### Why two classes handle everything

Despite the many providers the system supports, only two classes are needed:

**`AnthropicProvider`** -- handles Claude's API, which uses a different format from everyone else:
- Authentication via `x-api-key` header (not `Authorization: Bearer`)
- Requires an `anthropic-version` header
- System prompt is a top-level field, not a message in the array
- Response body uses `content[0].text` and `input_tokens`/`output_tokens`
- Streaming events use `content_block_delta` type

**`OpenAICompatProvider`** -- handles OpenAI and every API that follows the OpenAI format:
- Authentication via `Authorization: Bearer <key>` header
- System prompt is a message with `role: "system"` in the messages array
- Response body uses `choices[0].message.content` and `prompt_tokens`/`completion_tokens`
- Streaming events use `choices[0].delta.content`
- Works unchanged with: OpenAI, Groq, Google Gemini, Ollama, OpenRouter, Together AI, Fireworks AI, Mistral, and any other OpenAI-compatible endpoint

The key insight: because OpenAI's format became the industry standard, a single class can talk to dozens of different providers. The only thing that changes between providers is the base URL and API key.

### How to add a new provider (step-by-step)

**Scenario:** You want to add Together AI as a provider.

**Step 1: No code changes needed if it's OpenAI-compatible.** Just configure it:

```typescript
const router = new Router({
  providers: {
    together: {
      apiKey: process.env.TOGETHER_API_KEY,
      baseUrl: "https://api.together.xyz/v1",
      defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    },
  },
});
```

The `createProvider` factory in `src/providers.ts` handles this automatically:

```typescript
function createProvider(name: string, config: ProviderConfig): Provider {
  if (name === "anthropic") {
    return new AnthropicProvider(config);
  }
  return new OpenAICompatProvider(name, config);  // Everything else
}
```

Since "together" is not "anthropic", it gets an `OpenAICompatProvider` instance. Done.

**Step 2 (optional): Add models to the registry.** If you want cost tracking and strategy routing to know about Together AI's pricing, add entries to `MODEL_REGISTRY` in `src/types.ts`:

```typescript
{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", provider: "together",
  displayName: "Llama 3.3 70B Turbo", inputCostPer1M: 0.88,
  outputCostPer1M: 0.88, maxContext: 128000, tier: "economy" },
```

**Step 3 (optional): Add defaults.** Add entries to `DEFAULT_BASE_URLS` and `DEFAULT_MODELS` in `src/types.ts` so users don't need to specify the base URL manually:

```typescript
// In DEFAULT_BASE_URLS:
together: "https://api.together.xyz/v1",

// In DEFAULT_MODELS:
together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
```

**Step 4 (optional): Add auto-detection.** If you want Together AI to be auto-configured when `TOGETHER_API_KEY` is set, add a block to `buildConfigFromEnv()` in `src/config.ts`:

```typescript
if (process.env.TOGETHER_API_KEY) {
  providers.together = { apiKey: process.env.TOGETHER_API_KEY };
}
```

And add the env var mapping in `OpenAICompatProvider.envKey()`:

```typescript
together: "TOGETHER_API_KEY",
```

That's it. No new classes, no new interfaces -- just configuration.

### The fetchWithTimeout helper: why timeouts matter

Network calls can hang indefinitely. If a provider's server accepts your connection but never sends a response, your application would freeze forever without a timeout. The `fetchWithTimeout` function in `src/providers.ts` solves this:

```typescript
function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}
```

Here's what happens:

1. Creates an `AbortController` -- a built-in web API that can cancel a request.
2. Sets a timer (default: 30 seconds) that will call `controller.abort()` if it fires.
3. Passes the controller's `signal` to `fetch()`, linking them.
4. If the request completes before the timer, `finally()` clears the timer (so it doesn't fire needlessly).
5. If the timer fires first, the request is aborted and throws an error.

Each provider can configure its own timeout via `timeoutMs` in the provider config. This is important because different providers have different response times -- Groq might answer in under a second, while a complex Opus query might need 30 seconds.

### SSE parsing: how we read streaming responses

The `parseSSE` function is an **async generator** -- a special kind of function that can produce values one at a time, pausing between each one. It reads the raw byte stream from an HTTP response and extracts the SSE data payloads:

```typescript
async function* parseSSE(response: Response): AsyncIterable<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";   // Keep incomplete last line in buffer

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        yield data;               // Yield JSON string to caller
      }
    }
  }
}
```

The buffering logic is important: network data arrives in chunks that don't necessarily align with line boundaries. A single `read()` might give you half a line, or three and a half lines. The buffer accumulates incoming text, splits on newlines, and keeps any incomplete final line for the next iteration.

---

## 5. Routing Strategies Deep Dive

The router supports five strategies that control how it picks a provider for each request. Each strategy produces an ordered list of `{ provider, model }` pairs, and the router tries them in order until one succeeds.

### cheapest: token-aware cost estimation

**What it does:** Picks the provider-and-model combination that will cost the least for this specific request.

**When to use it:** For high-volume, cost-sensitive workloads where quality differences between models are acceptable. Good for summarization, classification, data extraction -- tasks where a $0.05/M-token model performs nearly as well as a $15/M-token one.

**How it decides:**

1. Estimates the number of input tokens from the message text: `characters / 4` (a rough but effective heuristic).
2. Assumes a default of 500 output tokens (a reasonable middle ground).
3. For each provider, finds its cheapest model from the registry.
4. Calculates estimated cost: `(inputTokens / 1M) * inputPrice + (outputTokens / 1M) * outputPrice`.
5. Sorts all providers by estimated cost, cheapest first.
6. Supports failover: if the cheapest provider fails, tries the next cheapest.

**Example scenario:**

You send "Summarize this paragraph" (30 characters, roughly 8 input tokens). With 500 estimated output tokens:

| Provider | Model | Estimated Cost |
|----------|-------|---------------|
| Ollama | llama3.2 | $0.000000 (free, local) |
| Groq | llama-3.1-8b-instant | $0.000040 |
| Google | gemini-2.0-flash | $0.000200 |
| OpenAI | gpt-4o-mini | $0.000300 |
| Anthropic | claude-haiku-4-5 | $0.002001 |

The router tries Ollama first. If Ollama isn't running, it falls back to Groq, then Google, and so on.

### fastest: latency-based ordering

**What it does:** Picks the provider most likely to respond quickly.

**When to use it:** For interactive applications where response time matters more than cost or quality -- chatbots, autocomplete, real-time suggestions.

**How it decides:**

Uses a static priority ranking based on known provider characteristics:

| Priority | Provider | Why |
|----------|----------|-----|
| 0 (fastest) | Groq | Purpose-built for speed; uses custom LPU hardware |
| 1 | Ollama | Local execution; no network latency to a remote server |
| 2 | OpenAI | Large-scale infrastructure, good latency |
| 3 | Google | Good infrastructure, slightly higher latency |
| 4 | Anthropic | Reliable but not the fastest |
| 5 | OpenRouter | Adds a proxy hop, so inherently slower |

This is a heuristic (educated guess) rather than a measurement. A future enhancement could use actual latency data from the cost tracker.

**Does not support failover.** The "fastest" strategy sends to a single provider. If it fails, the error propagates immediately -- the assumption is that if you asked for "fastest," you don't want to wait for a slower fallback.

**Example scenario:** In an interactive chat app, you use `{ strategy: "fastest" }`. The router picks Groq with the Llama 3.3 70B model. The user gets a response in ~200ms.

### smartest: tier-based selection

**What it does:** Picks the highest-quality model available, regardless of cost or speed.

**When to use it:** For complex tasks that require the best reasoning -- code generation, legal analysis, creative writing, multi-step problem solving.

**How it decides:**

1. Every model in the registry has a `tier`: "premium", "standard", or "economy".
2. For each provider, finds its highest-tier model.
3. Sorts providers by tier: premium first, then standard, then economy.
4. Supports failover: if the top-tier provider fails, tries the next best.

The tier assignments:

| Tier | Models | Typical use |
|------|--------|-------------|
| **Premium** | Claude Opus 4.5, GPT-4 Turbo, o1 | Complex reasoning, creative work |
| **Standard** | Claude Sonnet 4.5, GPT-4o, Gemini 2.5 Pro | General-purpose, good balance |
| **Economy** | Haiku, GPT-4o Mini, Llama, Gemma, all Ollama | High volume, simple tasks |

**Example scenario:** You ask the router to write a business plan with `{ strategy: "smartest" }`. It routes to Anthropic's Claude Opus 4.5 (premium tier, $15/$75 per million tokens). If Anthropic is down, it falls back to OpenAI's o1 (also premium).

### fallback: sequential with error recovery

**What it does:** Tries providers in the order they are configured, moving to the next one only when the current one fails.

**When to use it:** When you have a preferred provider but want automatic recovery. This is the **default strategy** when none is specified.

**How it decides:**

Uses the order providers appear in your configuration (or the order they were detected from environment variables). No sorting, no optimization -- just "try the first one; if it fails, try the second; if that fails, try the third."

**Example scenario:** Your config lists: anthropic, openai, groq, ollama. You send a request.

1. Try Anthropic -- it returns a 503 (service unavailable). Move on.
2. Try OpenAI -- it works. Return the response.
3. Groq and Ollama are never contacted.

If all four fail, the router throws an `AllProvidersFailedError` with the last error message attached.

### round-robin: even distribution

**What it does:** Distributes requests evenly across all providers, cycling through them one at a time.

**When to use it:** For load distribution, to avoid hitting rate limits on a single provider, or to get a natural mix of models for A/B testing.

**How it decides:**

Maintains a counter (`roundRobinIndex`) that increments with each request. Uses modulo arithmetic to cycle: `index % numberOfProviders`.

With 3 providers (anthropic, openai, groq):
- Request 1: anthropic (index 0)
- Request 2: openai (index 1)
- Request 3: groq (index 2)
- Request 4: anthropic (index 3 % 3 = 0)
- Request 5: openai (index 4 % 3 = 1)
- ... and so on

**Does not support failover.** Like "fastest," this is an explicit provider selection. If the chosen provider fails, the error propagates immediately.

**Example scenario:** You're building an application that makes 1,000 API calls per day. Instead of burning through your rate limit on one provider, `round-robin` spreads the load: ~333 to Anthropic, ~333 to OpenAI, ~334 to Groq.

---

## 6. Circuit Breaker Pattern

### What is a circuit breaker?

Think about the circuit breaker panel in your house. If too much electricity flows through a circuit (say, you plugged in too many appliances), the breaker "trips" -- it physically disconnects the circuit to prevent a fire. After you unplug some appliances, you can flip the breaker back on to restore power.

The **circuit breaker pattern** in software works the same way. If a provider keeps failing (the server is down, returning errors, or timing out), the circuit breaker "trips" and stops sending requests to that provider for a while. This prevents three problems:

1. **Wasted time** -- Why wait 30 seconds for a timeout when we already know it's broken?
2. **Cascading failures** -- Hammering a struggling server makes it worse.
3. **Resource exhaustion** -- Each hanging request ties up memory and connections.

### The three states

```
                    success
                  +--------+
                  |        |
                  v        |
             +--------+   |
     +------>| CLOSED |---+
     |       +--------+
     |           |
     |           | failure count >= threshold
     |           v
     |       +--------+
     |       |  OPEN  |<------+
     |       +--------+       |
     |           |             |
     |           | timeout     | failure
     |           | expires     | in probe
     |           v             |
     |       +-----------+     |
     +-------| HALF-OPEN |----+
     success +-----------+
```

**CLOSED (normal operation)**

Everything is fine. Requests flow through normally. Every failure increments a counter. If the counter reaches the threshold (default: 5 failures), the circuit trips to OPEN.

Think of it like this: the first few failures might be flukes. Maybe the server hiccupped. But five failures in a row? That's a pattern -- something is genuinely wrong.

**OPEN (provider is blocked)**

No requests are sent to this provider. Any attempt immediately receives a `CircuitOpenError`. This is the "tripped breaker" state.

The circuit stays open for a configurable timeout period (default: 30 seconds). After that timeout expires, the circuit transitions to HALF-OPEN.

**HALF-OPEN (testing the waters)**

The circuit cautiously allows a small number of test requests through (default: 1). This is like flipping the breaker back on and plugging in one appliance to see if it works.

- If the test request **succeeds**: the circuit closes (back to normal). The failure counter resets to zero.
- If the test request **fails**: the circuit re-opens. Back to waiting.

### Why it matters for multi-provider systems

Without circuit breakers, every request to a dead provider would:
1. Wait for the full 30-second timeout
2. Then fail and try the next provider
3. Adding 30 seconds of latency to every single request

With circuit breakers, after the fifth failure, subsequent requests skip the dead provider instantly and go straight to a working one. When the dead provider recovers, the half-open probe will detect it and restore normal routing.

### Configuration

The circuit breaker accepts three settings (in `CircuitBreakerConfig`):

| Setting | Default | Description |
|---------|---------|-------------|
| `failureThreshold` | 5 | Number of consecutive failures before the circuit opens |
| `resetTimeoutMs` | 30,000 | Milliseconds to wait before attempting a half-open probe |
| `halfOpenMaxAttempts` | 1 | Number of probe requests allowed in half-open state |

### How it integrates with the router

The Router creates one `CircuitBreaker` instance per provider in its constructor:

```typescript
for (const name of this.providers.keys()) {
  this.breakers.set(name, new CircuitBreaker(name));
}
```

Before every request (both `chat` and `stream`), the router checks:

```typescript
const breaker = this.breakers.get(providerName);
if (breaker && !breaker.canExecute()) {
  throw new CircuitOpenError(providerName);
}
```

After every request:
- On success: `breaker.recordSuccess()` -- resets failures, closes circuit
- On failure: `breaker.recordFailure()` -- increments counter, may open circuit

For strategies that support failover (`fallback`, `cheapest`, `smartest`), a `CircuitOpenError` is caught and the router skips to the next provider. For strategies without failover (`fastest`, `round-robin`), the error propagates to the caller.

---

## 7. Cost Tracking

### How costs are calculated per request

Every time a provider responds to a `chat()` call, the router calculates the cost and records it. The calculation uses the model's pricing from the registry:

```typescript
cost = (inputTokens / 1_000_000) * model.inputCostPer1M
     + (outputTokens / 1_000_000) * model.outputCostPer1M
```

Token counts come directly from the provider's response. Both Anthropic and OpenAI-compatible APIs report how many tokens were consumed. If the model isn't found in the registry, cost defaults to 0.

The full cost entry recorded includes:

| Field | Example | Description |
|-------|---------|-------------|
| `timestamp` | `"2026-04-03T14:30:00.000Z"` | When the request was made (ISO 8601) |
| `provider` | `"anthropic"` | Which provider handled it |
| `model` | `"claude-sonnet-4-5-20241022"` | Which specific model was used |
| `inputTokens` | `156` | Tokens in the prompt |
| `outputTokens` | `423` | Tokens in the response |
| `cost` | `0.006795` | Calculated dollar cost |
| `latencyMs` | `1847` | How long the request took in milliseconds |

### The model registry: known pricing for 20+ models

The `MODEL_REGISTRY` in `src/types.ts` contains pricing and metadata for models across all supported providers. Here is a sample:

| Provider | Model | Input $/1M | Output $/1M | Context | Tier |
|----------|-------|-----------|-------------|---------|------|
| Anthropic | Claude Opus 4.5 | $15.00 | $75.00 | 200K | Premium |
| Anthropic | Claude Sonnet 4.5 | $3.00 | $15.00 | 200K | Standard |
| Anthropic | Claude Haiku 4.5 | $0.80 | $4.00 | 200K | Economy |
| OpenAI | GPT-4o | $2.50 | $10.00 | 128K | Standard |
| OpenAI | GPT-4o Mini | $0.15 | $0.60 | 128K | Economy |
| OpenAI | o1 | $15.00 | $60.00 | 200K | Premium |
| Groq | Llama 3.3 70B | $0.59 | $0.79 | 128K | Economy |
| Groq | Llama 3.1 8B | $0.05 | $0.08 | 128K | Economy |
| Google | Gemini 2.0 Flash | $0.10 | $0.40 | 1M | Economy |
| Ollama | All local models | Free | Free | Varies | Economy |

The registry currently contains 22 model entries. When a model isn't in the registry (e.g., a custom model on Together AI), cost tracking still works -- it just records the cost as $0.00.

### Persistence: how costs are saved to disk

The `CostTracker` class in `src/tracker.ts` saves cost data to `~/.llm-router/costs.json`. This means your cost history survives across program restarts.

The persistence works simply:
- **On startup:** `load()` reads the JSON file (if it exists) and parses it into an array of `CostEntry` objects.
- **On each record:** `save()` writes the entire array back to disk as formatted JSON.
- **Directory creation:** If `~/.llm-router/` doesn't exist, it's created automatically with `mkdirSync({ recursive: true })`.
- **Error handling:** If the file is corrupted or unreadable, the tracker starts with an empty array -- it never crashes.

Persistence can be disabled by passing `trackCosts: false` in the router config, or by creating the tracker with `new CostTracker(false)`. In that mode, costs are tracked in memory only (useful for tests).

### The 10K entry cap: why it exists

```typescript
if (this.entries.length > 10_000) {
  this.entries = this.entries.slice(-10_000);
}
```

Every `save()` call checks the entry count. If it exceeds 10,000, the oldest entries are dropped to keep only the most recent 10,000.

Why 10,000? It's a practical balance:
- **At 100 requests/day**, that's 100 days of history -- more than enough for monthly billing analysis.
- **At 1,000 requests/day**, that's 10 days -- still recent enough for debugging.
- **Without a cap**, a high-volume application could produce a costs.json file that grows to hundreds of megabytes, slowing down every save/load operation.

The cap uses `slice(-10_000)` to keep the *newest* entries (negative index slices from the end).

### Querying costs: by provider, by model, by date range

The `getSummary()` method returns a `CostSummary` object:

```typescript
{
  totalCost: 12.45,
  totalRequests: 1547,
  totalInputTokens: 2340000,
  totalOutputTokens: 890000,
  byProvider: {
    anthropic: { cost: 8.20, requests: 423 },
    openai: { cost: 3.15, requests: 812 },
    groq: { cost: 1.10, requests: 312 },
  },
  byModel: {
    "claude-sonnet-4-5-20241022": { cost: 7.50, requests: 380 },
    "gpt-4o-mini": { cost: 2.40, requests: 750 },
    // ...
  },
}
```

You can filter by date by passing a `since` parameter:

```typescript
const thisMonth = router.getCosts("2026-04-01");
const thisWeek = router.getCosts("2026-03-28");
```

The filter compares each entry's ISO timestamp against the cutoff date.

---

## 8. Configuration System

### The config file format (.llm-router.json)

Configuration is a JSON file that tells the router which providers to use, how to authenticate with them, and what default behavior to follow:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "$ANTHROPIC_API_KEY"
    },
    "openai": {
      "apiKey": "$OPENAI_API_KEY"
    },
    "groq": {
      "apiKey": "$GROQ_API_KEY"
    },
    "google": {
      "apiKey": "$GOOGLE_API_KEY"
    },
    "openrouter": {
      "apiKey": "$OPENROUTER_API_KEY"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1"
    }
  },
  "defaultStrategy": "cheapest"
}
```

Each provider entry supports these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `apiKey` | Varies | API key (or `$ENV_VAR` reference). Not needed for Ollama. |
| `baseUrl` | No | Override the default API endpoint URL. |
| `defaultModel` | No | Override which model to use by default. |
| `timeoutMs` | No | Override the request timeout (default: 30,000ms). |

Top-level fields:

| Field | Default | Description |
|-------|---------|-------------|
| `providers` | `{}` | Map of provider name to config |
| `defaultStrategy` | `"fallback"` | Strategy when none is specified in a request |
| `trackCosts` | `true` | Whether to persist costs to disk |

### The $ENV_VAR pattern: keeping secrets safe

API keys are secrets -- they should never be committed to version control. The config system solves this with a simple convention: if an `apiKey` value starts with `$`, it is treated as an environment variable name and resolved at runtime.

```json
{ "apiKey": "$OPENAI_API_KEY" }
```

When the config is loaded, `parseConfigFile()` does:

```typescript
if (provider?.apiKey?.startsWith("$")) {
  const envVar = provider.apiKey.slice(1);   // Remove the $
  provider.apiKey = process.env[envVar] || "";
}
```

This means:
- The config file is **safe to commit to git** -- it contains `$OPENAI_API_KEY`, not the actual key.
- The actual key lives in your shell environment, a `.env` file, or your CI/CD secrets manager.
- If the environment variable isn't set, `apiKey` becomes `""` and `isAvailable()` returns `false` -- the provider is silently skipped.

Note that `.llm-router.json` is listed in `.gitignore` as an extra safety net.

### Config resolution order

When `loadConfig()` is called (either by the Router constructor or the CLI), it searches for configuration in this order:

1. **Explicit path** -- if a `configPath` argument is passed, use that file directly.
2. **Local config** -- look for `.llm-router.json` in the current working directory.
3. **Global config** -- look for `~/.llm-router/config.json` in the user's home directory.
4. **Environment variables** -- if no config file is found anywhere, auto-detect providers from env vars.

The first match wins. If a config file is found, environment variable auto-detection is not performed (but `$ENV_VAR` references within the file are still resolved).

### Auto-detection: how we find providers from environment variables

When no config file exists, `buildConfigFromEnv()` checks for known API key environment variables:

| Environment Variable | Provider Added |
|---------------------|---------------|
| `ANTHROPIC_API_KEY` | anthropic |
| `OPENAI_API_KEY` | openai |
| `GROQ_API_KEY` | groq |
| `GOOGLE_API_KEY` | google |
| `OPENROUTER_API_KEY` | openrouter |
| *(always)* | ollama |

Ollama is always included because it runs locally and doesn't need an API key. The default strategy for auto-detected configs is `"fallback"`.

This means you can start using `llm-router` with zero configuration -- just set your API keys as environment variables and it works:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

# No config file needed:
llm-router chat "Hello" --strategy cheapest
```

---

## 9. Error Handling Strategy

### The error hierarchy

`llm-router` defines a hierarchy of error types in `src/errors.ts`, all extending from a base `RouterError`:

```
Error (built-in JavaScript)
  └── RouterError (base class, code: string)
        ├── NoProvidersError       (code: "NO_PROVIDERS")
        ├── ProviderNotFoundError  (code: "PROVIDER_NOT_FOUND")
        ├── CircuitOpenError       (code: "CIRCUIT_OPEN")
        └── AllProvidersFailedError (code: "ALL_FAILED")
```

Each error type corresponds to a distinct failure scenario:

**`RouterError`** -- The base class. All router errors extend this and include a `code` property for programmatic error handling. Consumers can catch `RouterError` to handle all router-specific errors, or catch specific subclasses for fine-grained control.

**`NoProvidersError`** (`NO_PROVIDERS`) -- Thrown when the router has zero available providers. This happens when no API keys are set and Ollama isn't running. The error message includes actionable guidance: "Run: llm-router config init".

**`ProviderNotFoundError`** (`PROVIDER_NOT_FOUND`) -- Thrown when a user requests a specific provider (e.g., `{ provider: "anthropic" }`) that isn't configured. The error message lists which providers *are* available, helping the user fix the issue.

**`CircuitOpenError`** (`CIRCUIT_OPEN`) -- Thrown when a request targets a provider whose circuit breaker is open (too many recent failures). This error is caught internally during failover and causes the router to skip to the next provider.

**`AllProvidersFailedError`** (`ALL_FAILED`) -- Thrown when every provider in the failover chain has failed. Includes the last error's message for debugging. This is the "we tried everything" error.

### How errors flow through failover

During a fallback/cheapest/smartest routed request, errors drive the failover process:

```
Provider 1: CircuitOpenError → skip (circuit is open)
Provider 2: API Error (500)  → recordFailure(), catch, try next
Provider 3: Timeout          → recordFailure(), catch, try next
Provider 4: Success!         → recordSuccess(), return response

If all fail:
  throw AllProvidersFailedError(lastError)
```

For strategies without failover (`fastest`, `round-robin`), errors propagate immediately to the caller:

```
Provider 1: API Error (500) → recordFailure(), throw immediately
```

### The getErrorMessage helper: handling unknown error types safely

TypeScript's `catch` clause types errors as `unknown` (since anything can be thrown in JavaScript -- not just `Error` objects). The `getErrorMessage` helper handles this safely:

```typescript
function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

This function appears in both `src/router.ts` and `src/cli.ts`. It ensures that whether the caught value is an `Error` object, a string, a number, or anything else, we always get a meaningful string message.

### CLI error display: clean messages instead of stack traces

The CLI wraps every command action in a try/catch and displays errors in red using ANSI escape codes:

```typescript
} catch (err: unknown) {
  console.error(c(RD, `Error: ${getErrorMessage(err)}`));
  process.exit(1);
}
```

This gives users a clean, readable message:

```
Error: No providers available. Set API keys via env vars or config file.
Run: llm-router config init
```

Instead of a raw stack trace that would look like:

```
NoProvidersError: No providers available...
    at new NoProvidersError (/dist/errors.js:12:9)
    at Router.chat (/dist/router.js:47:19)
    ...
```

The CLI exits with code 1 on errors, which is the Unix convention for "something went wrong" -- useful for scripts that chain commands together.

---

## 10. CLI Design

### The 6 commands

The CLI is built with the `commander` library (the only runtime dependency). It defines six commands:

**`llm-router chat <message>`** -- Send a message to an LLM.

```bash
llm-router chat "What is the capital of France?"
llm-router chat "Explain this code" --provider anthropic --model claude-sonnet-4-5-20241022
llm-router chat "Quick question" --strategy cheapest
llm-router chat "Tell me a story" --stream
llm-router chat "Be creative" --system "You are a poet" --max-tokens 2000
```

Options:
- `-p, --provider <name>` -- Force a specific provider
- `-m, --model <id>` -- Force a specific model
- `-s, --strategy <strategy>` -- Routing strategy (default: "fallback")
- `--system <prompt>` -- Set a system prompt
- `--stream` -- Stream the response token-by-token
- `--max-tokens <n>` -- Maximum response length (default: 4096)

After a non-streaming response, it prints metadata in dim text:

```
The capital of France is Paris.

Provider: openai | Model: gpt-4o-mini | 18 in / 8 out | 342ms | $0.0001
```

**`llm-router bench <prompt>`** -- Benchmark a prompt across multiple providers.

```bash
llm-router bench "Explain quantum computing"
llm-router bench "Write a haiku" --providers anthropic,openai,groq
```

Sends the same prompt to every configured provider (or a specified subset) and displays a comparison table.

**`llm-router models`** -- List all available models with pricing.

```bash
llm-router models
llm-router models --provider groq
```

Displays a formatted table: provider, display name, input cost per million tokens, output cost per million tokens, context window size, and tier.

**`llm-router costs`** -- Show cost tracking summary.

```bash
llm-router costs
llm-router costs --since 2026-01-01
llm-router costs --clear
```

Displays total cost, total requests, total tokens, and breakdowns by provider and by model.

**`llm-router providers`** -- List configured and available providers.

```bash
llm-router providers
```

Shows configured providers with a green dot and unconfigured providers with a dim circle. Helps users understand which providers are active.

**`llm-router config <action>`** -- Manage configuration.

```bash
llm-router config init          # Create .llm-router.json in current directory
llm-router config init --global # Create ~/.llm-router/config.json
llm-router config show          # Display current config (with masked API keys)
```

The `show` action masks API keys for safety, displaying only the first 8 characters followed by "...".

### ANSI terminal formatting

The CLI uses ANSI escape codes for colored, styled terminal output. These are special character sequences that terminals interpret as formatting instructions:

```typescript
const B = "\x1b[1m";   // Bold
const D = "\x1b[2m";   // Dim
const R = "\x1b[0m";   // Reset (back to normal)
const G = "\x1b[32m";  // Green
const Y = "\x1b[33m";  // Yellow
const C = "\x1b[36m";  // Cyan
const RD = "\x1b[31m"; // Red
```

The `c()` helper function applies formatting but respects two conditions where colors should be disabled:
- `process.stdout.isTTY` is `false` -- output is being piped to a file or another program.
- `NO_COLOR` environment variable is set -- the user has explicitly requested no colors (a widely supported convention).

```typescript
const nc = !process.stdout.isTTY || !!process.env.NO_COLOR;
const c = (code: string, t: string) => (nc ? t : `${code}${t}${R}`);
```

### How benchmarking works: parallel provider comparison

The `bench` command creates a Router, calls `router.benchmark(prompt, providers)`, and displays results in a table.

Inside `benchmark()`:

1. Iterates through each provider name.
2. For each provider, records the start time with `performance.now()`.
3. Sends the prompt with `maxTokens: 300` (to keep benchmarks short and comparable).
4. Records the end time and calculates latency.
5. Looks up the model in the registry and calculates cost.
6. Truncates the response to 150 characters for the preview.
7. If a provider fails, the error message is captured (up to 100 characters) instead of crashing.

The output table shows:

```
Provider      Model                       Time    Tokens        Cost      Status
----------------------------------------------------------------------------------------------
anthropic     claude-sonnet-4-5-20241022  1847ms  156/423       $0.0068   OK
openai        gpt-4o-mini                 342ms   148/389       $0.0003   OK
groq          llama-3.3-70b-versatile     189ms   152/401       $0.0004   OK
ollama        llama3.2                    -       -             -         Error: connect ECONNREFUSED
```

---

## 11. Testing Strategy

### What is tested and what isn't

The test suite in `tests/router.test.ts` contains **36 tests** organized into 7 categories. It uses Node.js's built-in test runner (`node:test`), meaning no test framework dependencies (no Jest, no Mocha).

**What IS tested (unit tests, no network required):**
- Model registry data integrity (pricing, tiers, context sizes)
- Default URLs and models for all providers
- Provider factory (correct class creation, availability checks)
- Router initialization, provider listing, model listing
- Cost tracker (recording, querying, filtering, clearing)
- Config loading (from file, $ENV_VAR resolution, env var fallback)
- Circuit breaker state machine (all transitions)
- Error hierarchy (codes, messages, inheritance)

**What is NOT tested (would require live API keys):**
- Actual HTTP calls to provider APIs
- Streaming responses
- End-to-end routing with real providers
- Benchmarking with real responses
- Cost persistence to disk (tests use in-memory mode)

This is a deliberate design choice: the tests can run anywhere without API keys, making them suitable for CI/CD pipelines.

### Test categories

**1. Model Registry (4 tests)**
- Verifies all major providers have models in the registry.
- Checks that no model has negative pricing.
- Validates all tiers are "economy", "standard", or "premium".
- Confirms local (Ollama) models are free.

**2. Defaults (2 tests)**
- Verifies base URLs exist for all known providers.
- Verifies default models exist for all known providers.

**3. Provider Factory (5 tests)**
- Creates Anthropic provider with API key -- confirms it's available.
- Creates OpenAI provider with API key -- confirms it's available.
- Creates Ollama provider without API key -- confirms it's still available.
- Creates OpenAI provider without key or env var -- confirms it's unavailable.
- Lists models for a provider -- confirms they're filtered correctly.

**4. Router (5 tests)**
- Initializes with explicit config -- confirms providers are listed.
- Lists multiple configured providers.
- Lists models across all providers.
- Filters models by a single provider.
- Throws `NoProvidersError` when no providers are available.

**5. Cost Tracker (5 tests)**
- Records an entry and verifies the summary.
- Tracks by provider (two providers, checks both appear).
- Tracks by model (checks model-level breakdown).
- Clears history (resets to zero).
- Filters by date (future date returns entries, far-future returns nothing).

**6. Config (4 tests)**
- Generates a config template with all providers and default strategy.
- Loads config from a JSON file.
- Resolves `$ENV_VAR` references in API keys.
- Falls back to env vars when no config file exists.

**7. Circuit Breaker (6 tests)**
- Starts in closed state.
- Opens after reaching failure threshold.
- Resets to closed on success.
- Transitions to half-open after reset timeout.
- Closes from half-open on success.
- Re-opens from half-open on failure.

**8. Error Hierarchy (5 tests)**
- `NoProvidersError` has correct code and extends `RouterError`.
- `ProviderNotFoundError` includes provider name and available providers.
- `CircuitOpenError` includes provider name.
- `AllProvidersFailedError` includes last error message.
- Router throws `NoProvidersError` when empty.

### How to run tests

```bash
# Run the full test suite
npm test

# Which executes:
tsx --test tests/router.test.ts
```

The test command uses `tsx` (a TypeScript execution engine) to run TypeScript tests directly without a separate compile step. The `--test` flag enables Node.js's built-in test runner, which discovers `describe()` and `it()` blocks automatically.

### How to add new tests

1. Open `tests/router.test.ts`.
2. Add a new `describe()` block for a new category, or add `it()` blocks to an existing category.
3. Import any modules you need from `../src/`.
4. Use `assert` from `node:assert/strict` for assertions.

Example: adding a test for round-robin ordering:

```typescript
describe("Round-robin strategy", () => {
  it("cycles through providers", async () => {
    const router = new Router({
      providers: {
        anthropic: { apiKey: "test" },
        openai: { apiKey: "test" },
      },
      trackCosts: false,
    });
    // Note: testing actual routing would require mock providers,
    // since we can't make real API calls in tests.
    const providers = router.listProviders();
    assert.equal(providers.length, 2);
  });
});
```

### Mock provider patterns for testing without API keys

For more thorough testing, you could create a mock provider that implements the `Provider` interface:

```typescript
class MockProvider implements Provider {
  name: string;
  callCount = 0;
  shouldFail = false;

  constructor(name: string) { this.name = name; }

  isAvailable(): boolean { return true; }
  listModels(): ModelInfo[] { return []; }

  async chat(messages: Message[]): Promise<ProviderResponse> {
    this.callCount++;
    if (this.shouldFail) throw new Error("Mock failure");
    return {
      text: `Response from ${this.name}`,
      model: "mock-model",
      inputTokens: 10,
      outputTokens: 20,
    };
  }

  async *streamChat(): AsyncIterable<string> {
    yield "Mock ";
    yield "stream";
  }
}
```

This mock could be injected into the Router to test routing strategies, failover behavior, and circuit breaker integration without making any network calls.

---

## 12. How to Build a Similar Multi-Provider System

This section is a guide for developers who want to build their own multi-provider routing system, whether for LLMs or any other multi-backend service.

### Step 1: Designing a provider abstraction

Start by defining a clear interface that all providers must implement. This is the most important design decision -- get it right and everything else follows naturally.

**Key principles:**
- Keep the interface small. Four to five methods is enough.
- Make it async. Network calls are inherently asynchronous.
- Include a "health check" method (`isAvailable()`).
- Include a "capabilities" method (`listModels()`).

```typescript
interface Provider {
  name: string;
  isAvailable(): boolean;
  chat(messages: Message[], model: string, opts?: Options): Promise<Response>;
  streamChat(messages: Message[], model: string, opts?: Options): AsyncIterable<string>;
  listModels(): ModelInfo[];
}
```

Then create a **factory function** that picks the right implementation based on the provider name:

```typescript
function createProvider(name: string, config: Config): Provider {
  if (name === "special-case") return new SpecialProvider(config);
  return new GenericProvider(name, config); // covers 90% of providers
}
```

The `llm-router` lesson: because OpenAI's format became the standard, a single "generic" class handles the majority of providers. Don't over-engineer -- start with the assumption that most backends are similar, and create specialized classes only when you must.

### Step 2: Implementing routing strategies

Routing strategies are really just sorting functions. Each one takes a list of available providers and returns them in a specific order:

```typescript
function sortByCost(providers: string[]): ProviderOrder[] { ... }
function sortBySpeed(providers: string[]): ProviderOrder[] { ... }
function sortByQuality(providers: string[]): ProviderOrder[] { ... }
```

**Tips:**
- Store the strategy as a union type: `type Strategy = "cheapest" | "fastest" | ...`
- Use a `switch` statement in the router to dispatch to the right sorting function.
- Return an array, not a single provider -- this enables failover by trying each element in order.
- Keep heuristics simple. `llm-router`'s "fastest" strategy uses a static priority list, not actual measurements. Simple heuristics that are right 90% of the time are better than complex systems that are right 95% of the time but hard to debug.

### Step 3: Adding circuit breakers for resilience

Implement the circuit breaker as a standalone class with no dependencies on your routing logic:

```typescript
class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;

  canExecute(): boolean { ... }
  recordSuccess(): void { ... }
  recordFailure(): void { ... }
}
```

Create one instance per provider. Check `canExecute()` before every request, and call `recordSuccess()` or `recordFailure()` after.

**Design tips:**
- Make thresholds configurable (don't hardcode "5 failures").
- Use timestamps, not timers, for the reset timeout -- timers can drift and are hard to test.
- Make sure the half-open state is limited (only 1-2 probe requests).
- The circuit breaker should know nothing about HTTP, providers, or routing -- it's a generic state machine.

### Step 4: Tracking costs and usage

Build a tracker that:

1. Records every request with metadata (provider, model, tokens, cost, latency, timestamp).
2. Provides summary queries (total cost, breakdown by provider, by model, by date range).
3. Persists to disk for durability.
4. Caps stored entries to prevent unbounded growth.

```typescript
class Tracker {
  record(entry: CostEntry): void { ... }
  getSummary(since?: string): Summary { ... }
  clear(): void { ... }
}
```

**Tips:**
- Use JSON for the persistence format -- it's human-readable and debuggable.
- Add the cap (like `llm-router`'s 10K entries) from day one.
- Make persistence optional (a constructor flag) so tests can run in memory.
- Store timestamps as ISO 8601 strings for cross-platform compatibility.

### Step 5: Building a CLI on top

Use a CLI framework like `commander` (Node.js), `click` (Python), or `cobra` (Go). Map your library's main functions to CLI commands:

| Library method | CLI command |
|---------------|-------------|
| `router.chat()` | `cli chat <message>` |
| `router.benchmark()` | `cli bench <prompt>` |
| `router.listModels()` | `cli models` |
| `router.getCosts()` | `cli costs` |

**Tips:**
- Respect `NO_COLOR` and pipe detection for ANSI codes.
- Display errors as clean messages, not stack traces.
- Mask secrets when displaying configuration.
- Exit with code 1 on errors for script compatibility.
- Validate input early (check that `--max-tokens` is a positive number before creating the router).

### Step 6: Publishing as a dual-use library + CLI

In your `package.json`:

```json
{
  "main": "dist/index.js",          // Library entry
  "types": "dist/index.d.ts",       // TypeScript declarations
  "bin": { "my-tool": "dist/cli.js" } // CLI entry
}
```

In your library entry point (`src/index.ts`), export only what consumers need:

```typescript
export { Router } from "./router.js";
export { CostTracker } from "./tracker.js";
export type { ChatOptions, ChatResponse } from "./types.js";
// Don't export CLI internals
```

In your CLI entry point (`src/cli.ts`), start with the shebang and import the same internal modules:

```typescript
#!/usr/bin/env node
import { Router } from "./router.js";
// Parse args, run commands
```

The key insight: the CLI and library share the same core code. The CLI is just a thin wrapper that parses command-line arguments and formats output.

---

## 13. Glossary

**Abort Controller** -- A built-in web API that allows you to cancel an in-progress HTTP request. Used by `fetchWithTimeout` to enforce time limits.

**ANSI escape codes** -- Special character sequences (like `\x1b[31m`) that terminals interpret as formatting instructions (colors, bold, dim). Named after the American National Standards Institute.

**API (Application Programming Interface)** -- A set of rules that allows one piece of software to talk to another. In this context, it refers to the HTTP endpoints that LLM providers expose for sending prompts and receiving responses.

**API key** -- A secret string (like a password) that identifies your account when making API calls. Providers use it for authentication and billing.

**Async generator** -- A JavaScript function declared with `async function*` that can yield values one at a time asynchronously. Used for streaming -- each `yield` produces one chunk of the response.

**Async iterable** -- An object that can be looped over with `for await...of`. Both `streamChat()` and `parseSSE()` return async iterables.

**Base URL** -- The root address of an API endpoint. For example, OpenAI's base URL is `https://api.openai.com/v1`. All API paths are appended to this.

**Chat completion** -- The standard pattern for LLM APIs: you send a list of messages (with roles like "user" and "assistant") and receive a completion (the model's response).

**Circuit breaker** -- A design pattern that prevents repeated calls to a failing service. Named after the electrical device that cuts power when too much current flows.

**CLI (Command-Line Interface)** -- A text-based interface where you type commands into a terminal. As opposed to a GUI (graphical user interface) with buttons and windows.

**Commander** -- A Node.js library for building command-line interfaces. Handles argument parsing, help text generation, and command routing.

**CommonJS** -- A module system for Node.js that uses `require()` and `module.exports`. This project uses CommonJS (set via `"type": "commonjs"` in package.json), though TypeScript `import`/`export` syntax is used in source code and compiled to `require()` calls.

**Context window** -- The maximum number of tokens a model can process in a single request (input + output combined). GPT-4o has a 128K context window; Gemini has 1M.

**Cost entry** -- A single record of an API request, including provider, model, tokens used, cost, latency, and timestamp.

**Dual-use package** -- A package that works both as an importable library and as a standalone CLI tool. The same codebase serves both use cases.

**Failover** -- The process of automatically switching to a backup provider when the primary one fails.

**Fetch** -- The built-in web API for making HTTP requests. `llm-router` uses `fetch()` directly (no Axios, no `node-fetch`) because modern Node.js includes it natively.

**Half-open (circuit state)** -- A cautious state where the circuit breaker allows a limited number of test requests through to check if the provider has recovered.

**Heuristic** -- A practical approach to problem-solving that isn't guaranteed to be optimal but is good enough. The "fastest" strategy uses a static speed ranking as a heuristic.

**HTTP (Hypertext Transfer Protocol)** -- The protocol used for communication on the web. API calls in this project are HTTP POST requests with JSON bodies.

**ISO 8601** -- An international standard for date/time formatting. Example: `2026-04-03T14:30:00.000Z`. Used for timestamps in cost entries.

**JSON (JavaScript Object Notation)** -- A lightweight data format that uses key-value pairs and arrays. Used for API request/response bodies, config files, and cost persistence.

**LLM (Large Language Model)** -- An AI system trained on vast amounts of text data that can understand and generate human language. Examples: GPT-4, Claude, Gemini, Llama.

**Model registry** -- A hardcoded list of known models with their pricing, context window sizes, and quality tiers. Used for cost calculation and strategy routing.

**Model tier** -- A quality classification: "economy" (cheap, good for simple tasks), "standard" (balanced), or "premium" (best quality, most expensive).

**OpenAI-compatible** -- An API that follows the same request/response format as OpenAI's API, particularly the `/v1/chat/completions` endpoint. Many providers have adopted this format.

**Provider** -- A company or service that hosts and serves LLM models via an API. Examples: Anthropic (Claude), OpenAI (GPT), Groq, Google (Gemini), Ollama (local).

**Provider abstraction** -- A design pattern where different providers are accessed through a common interface, hiding their differences behind a uniform API.

**Rate limit** -- A restriction on how many API requests you can make per minute/hour/day. Providers impose rate limits to prevent abuse and ensure fair resource sharing.

**Round-robin** -- A load distribution method where each provider is selected in turn, cycling through the list repeatedly.

**Routing strategy** -- A rule that determines which provider to use for a given request. The five strategies are: cheapest, fastest, smartest, fallback, and round-robin.

**Shebang** -- The `#!/usr/bin/env node` line at the top of a CLI script. It tells Unix-like systems to execute the file with Node.js.

**SSE (Server-Sent Events)** -- A protocol for streaming data from server to client over HTTP. Each message is a text line starting with `data: `. Used by LLM APIs for real-time token-by-token responses.

**Token** -- The basic unit of text that LLMs process. Roughly 3-4 characters of English text. "Hello world" is typically 2 tokens. Providers charge per token.

**TSX** -- A TypeScript execution engine that runs `.ts` files directly without a separate compilation step. Used in the `dev` and `test` scripts.

**TypeScript** -- A programming language that extends JavaScript with static type annotations. It compiles to plain JavaScript. This project is written in TypeScript and compiled to JavaScript for distribution.

**Vendor lock-in** -- The situation where your code depends so heavily on one provider's specific API that switching to another would require significant rewriting.

---

*This document covers llm-router version 1.0.0. For the latest code, see the [source repository](https://github.com/sahididrishi/llm-router).*
