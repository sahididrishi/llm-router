import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "fs";
import path from "path";
import os from "os";
import { Router } from "../src/router.js";
import { CostTracker } from "../src/tracker.js";
import { loadConfig, generateConfigTemplate, saveConfigTemplate } from "../src/config.js";
import { createProvider } from "../src/providers.js";
import { MODEL_REGISTRY, DEFAULT_BASE_URLS, DEFAULT_MODELS } from "../src/types.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import {
  RouterError,
  NoProvidersError,
  ProviderNotFoundError,
  CircuitOpenError,
  AllProvidersFailedError,
} from "../src/errors.js";

// ── Model registry ──────���───────────────────────────────────

describe("Model Registry", () => {
  it("contains models for all major providers", () => {
    const providers = new Set(MODEL_REGISTRY.map((m) => m.provider));
    assert.ok(providers.has("anthropic"));
    assert.ok(providers.has("openai"));
    assert.ok(providers.has("groq"));
    assert.ok(providers.has("ollama"));
  });

  it("has valid pricing for all models", () => {
    for (const model of MODEL_REGISTRY) {
      assert.ok(model.inputCostPer1M >= 0, `${model.id} has negative input cost`);
      assert.ok(model.outputCostPer1M >= 0, `${model.id} has negative output cost`);
      assert.ok(model.maxContext > 0, `${model.id} has invalid context size`);
    }
  });

  it("has valid tiers for all models", () => {
    const validTiers = new Set(["economy", "standard", "premium"]);
    for (const model of MODEL_REGISTRY) {
      assert.ok(validTiers.has(model.tier), `${model.id} has invalid tier: ${model.tier}`);
    }
  });

  it("local models are free", () => {
    const localModels = MODEL_REGISTRY.filter((m) => m.provider === "ollama");
    for (const model of localModels) {
      assert.equal(model.inputCostPer1M, 0);
      assert.equal(model.outputCostPer1M, 0);
    }
  });
});

// ── Default URLs and models ─────────────────────────────────

describe("Defaults", () => {
  it("has base URLs for all providers", () => {
    assert.ok(DEFAULT_BASE_URLS.anthropic);
    assert.ok(DEFAULT_BASE_URLS.openai);
    assert.ok(DEFAULT_BASE_URLS.groq);
    assert.ok(DEFAULT_BASE_URLS.ollama);
    assert.ok(DEFAULT_BASE_URLS.openrouter);
  });

  it("has default models for all providers", () => {
    assert.ok(DEFAULT_MODELS.anthropic);
    assert.ok(DEFAULT_MODELS.openai);
    assert.ok(DEFAULT_MODELS.groq);
    assert.ok(DEFAULT_MODELS.ollama);
  });
});

// ── Provider factory ─────────────���──────────────────────────

describe("Provider factory", () => {
  it("creates an Anthropic provider", () => {
    const provider = createProvider("anthropic", { apiKey: "test-key" });
    assert.equal(provider.name, "anthropic");
    assert.ok(provider.isAvailable());
  });

  it("creates an OpenAI-compatible provider", () => {
    const provider = createProvider("openai", { apiKey: "test-key" });
    assert.equal(provider.name, "openai");
    assert.ok(provider.isAvailable());
  });

  it("Ollama is available without API key", () => {
    const provider = createProvider("ollama", {});
    assert.equal(provider.name, "ollama");
    assert.ok(provider.isAvailable());
  });

  it("OpenAI provider without key is unavailable", () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const provider = createProvider("openai", {});
    assert.ok(!provider.isAvailable());
    if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  });

  it("lists models for each provider", () => {
    const anthropic = createProvider("anthropic", { apiKey: "test" });
    const models = anthropic.listModels();
    assert.ok(models.length >= 2);
    assert.ok(models.every((m) => m.provider === "anthropic"));
  });
});

// ── Router initialization ──────��────────────────────────────

describe("Router", () => {
  it("initializes with explicit config", () => {
    const router = new Router({
      providers: {
        anthropic: { apiKey: "test-key" },
      },
      trackCosts: false,
    });
    assert.ok(router.listProviders().includes("anthropic"));
  });

  it("lists configured providers", () => {
    const router = new Router({
      providers: {
        anthropic: { apiKey: "test" },
        openai: { apiKey: "test" },
      },
      trackCosts: false,
    });
    const providers = router.listProviders();
    assert.ok(providers.includes("anthropic"));
    assert.ok(providers.includes("openai"));
  });

  it("lists models across providers", () => {
    const router = new Router({
      providers: {
        anthropic: { apiKey: "test" },
        groq: { apiKey: "test" },
      },
      trackCosts: false,
    });
    const models = router.listModels();
    assert.ok(models.some((m) => m.provider === "anthropic"));
    assert.ok(models.some((m) => m.provider === "groq"));
  });

  it("filters models by provider", () => {
    const router = new Router({
      providers: {
        anthropic: { apiKey: "test" },
        openai: { apiKey: "test" },
      },
      trackCosts: false,
    });
    const models = router.listModels("anthropic");
    assert.ok(models.every((m) => m.provider === "anthropic"));
  });

  it("throws when no providers available", async () => {
    const router = new Router({
      providers: {},
      trackCosts: false,
    });
    await assert.rejects(() => router.chat("Hello"), /No providers available/);
  });
});

// ── Cost tracker ────────────────────────────────────────────

describe("CostTracker", () => {
  let tracker: CostTracker;

  before(() => {
    tracker = new CostTracker(false); // in-memory only
  });

  it("records entries", () => {
    tracker.record({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20241022",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      latencyMs: 500,
    });

    const summary = tracker.getSummary();
    assert.equal(summary.totalRequests, 1);
    assert.equal(summary.totalCost, 0.001);
  });

  it("tracks by provider", () => {
    tracker.record({
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.002,
      latencyMs: 300,
    });

    const summary = tracker.getSummary();
    assert.equal(summary.totalRequests, 2);
    assert.ok(summary.byProvider.anthropic);
    assert.ok(summary.byProvider.openai);
  });

  it("tracks by model", () => {
    const summary = tracker.getSummary();
    assert.ok(summary.byModel["claude-sonnet-4-5-20241022"]);
    assert.ok(summary.byModel["gpt-4o-mini"]);
  });

  it("clears history", () => {
    tracker.clear();
    const summary = tracker.getSummary();
    assert.equal(summary.totalRequests, 0);
    assert.equal(summary.totalCost, 0);
  });

  it("filters by date", () => {
    tracker.record({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20241022",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      latencyMs: 500,
    });

    // Future date should return the entry
    const summary = tracker.getSummary("2020-01-01");
    assert.equal(summary.totalRequests, 1);

    // Future date should return nothing
    const empty = tracker.getSummary("2099-01-01");
    assert.equal(empty.totalRequests, 0);
  });
});

// ── Config ──────────────────────────────────────────────────

describe("Config", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-router-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a config template", () => {
    const template = generateConfigTemplate();
    const parsed = JSON.parse(template);
    assert.ok(parsed.providers.anthropic);
    assert.ok(parsed.providers.openai);
    assert.ok(parsed.providers.ollama);
    assert.equal(parsed.defaultStrategy, "cheapest");
  });

  it("loads config from a file", () => {
    const configPath = path.join(tmpDir, "test-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          anthropic: { apiKey: "test-from-file" },
        },
        defaultStrategy: "smartest",
      })
    );

    const config = loadConfig(configPath);
    assert.equal(config.providers.anthropic?.apiKey, "test-from-file");
    assert.equal(config.defaultStrategy, "smartest");
  });

  it("resolves $ENV_VAR references", () => {
    process.env.TEST_LLM_KEY = "resolved-key-123";

    const configPath = path.join(tmpDir, "env-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          openai: { apiKey: "$TEST_LLM_KEY" },
        },
      })
    );

    const config = loadConfig(configPath);
    assert.equal(config.providers.openai?.apiKey, "resolved-key-123");
    delete process.env.TEST_LLM_KEY;
  });

  it("falls back to env vars when no config file", () => {
    // loadConfig() without an explicit path falls back to env vars
    const config = loadConfig();
    assert.ok(config.providers);
  });
});

// ── Circuit Breaker ──────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker("test");
    assert.equal(cb.getState(), "closed");
    assert.ok(cb.canExecute());
  });

  it("opens after threshold failures", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.getState(), "closed");
    cb.recordFailure();
    assert.equal(cb.getState(), "open");
    assert.ok(!cb.canExecute());
  });

  it("resets on success", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    assert.equal(cb.getState(), "closed");
    assert.equal(cb.getFailures(), 0);
  });

  it("transitions to half-open after reset timeout", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 10 });
    cb.recordFailure();
    assert.equal(cb.getState(), "open");
    // Wait for timeout
    await sleep(20);
    assert.ok(cb.canExecute());
    assert.equal(cb.getState(), "half-open");
  });

  it("closes from half-open on success", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 10 });
    cb.recordFailure();
    await sleep(20);
    cb.canExecute(); // triggers half-open
    cb.recordSuccess();
    assert.equal(cb.getState(), "closed");
  });

  it("re-opens from half-open on failure", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 10 });
    cb.recordFailure();
    await sleep(20);
    cb.canExecute();
    cb.recordFailure();
    assert.equal(cb.getState(), "open");
  });
});

// ── Error hierarchy ─────────────────────────────────────────

describe("Error hierarchy", () => {
  it("NoProvidersError has correct code", () => {
    const err = new NoProvidersError();
    assert.equal(err.code, "NO_PROVIDERS");
    assert.ok(err instanceof RouterError);
    assert.ok(err instanceof Error);
  });

  it("ProviderNotFoundError includes provider name", () => {
    const err = new ProviderNotFoundError("anthropic", ["openai", "groq"]);
    assert.ok(err.message.includes("anthropic"));
    assert.ok(err.message.includes("openai"));
    assert.equal(err.code, "PROVIDER_NOT_FOUND");
  });

  it("CircuitOpenError includes provider name", () => {
    const err = new CircuitOpenError("openai");
    assert.ok(err.message.includes("openai"));
    assert.equal(err.code, "CIRCUIT_OPEN");
  });

  it("AllProvidersFailedError includes last error", () => {
    const cause = new Error("connection refused");
    const err = new AllProvidersFailedError(cause);
    assert.ok(err.message.includes("connection refused"));
    assert.equal(err.code, "ALL_FAILED");
  });

  it("Router throws NoProvidersError when no providers configured", async () => {
    const router = new Router({ providers: {}, trackCosts: false });
    await assert.rejects(() => router.chat("Hello"), (err: any) => {
      assert.ok(err instanceof NoProvidersError);
      return true;
    });
  });
});
