import fs from "fs";
import path from "path";
import os from "os";
import type { RouterConfig, ProviderConfig } from "./types.js";

const CONFIG_PATHS = [
  path.join(process.cwd(), ".llm-router.json"),
  path.join(os.homedir(), ".llm-router", "config.json"),
];

// ── Load config from file or env vars ───────────────────────

export function loadConfig(configPath?: string): RouterConfig {
  // Try explicit path first
  if (configPath) {
    return parseConfigFile(configPath);
  }

  // Try standard locations
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      return parseConfigFile(p);
    }
  }

  // Fall back to env vars only
  return buildConfigFromEnv();
}

// ── Parse a config file ─────────────────────────────────────

function parseConfigFile(filePath: string): RouterConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  let config: RouterConfig;
  try {
    config = JSON.parse(raw) as RouterConfig;
  } catch {
    throw new Error(`Invalid JSON in config file: ${filePath}`);
  }

  if (!config.providers || typeof config.providers !== 'object') config.providers = {};

  // Resolve $ENV_VAR references in API keys
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider?.apiKey?.startsWith("$")) {
      const envVar = provider.apiKey.slice(1);
      provider.apiKey = process.env[envVar] || "";
    }
  }

  return config;
}

// ── Auto-detect providers from env vars ─────────────────────

function buildConfigFromEnv(): RouterConfig {
  const providers: Record<string, ProviderConfig> = {};

  if (process.env.ANTHROPIC_API_KEY) {
    providers.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    providers.openai = { apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.GROQ_API_KEY) {
    providers.groq = { apiKey: process.env.GROQ_API_KEY };
  }
  if (process.env.GOOGLE_API_KEY) {
    providers.google = { apiKey: process.env.GOOGLE_API_KEY };
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.openrouter = { apiKey: process.env.OPENROUTER_API_KEY };
  }

  // Always include ollama (local, no key needed)
  providers.ollama = { baseUrl: "http://localhost:11434/v1" };

  return { providers, defaultStrategy: "fallback" };
}

// ── Generate a starter config file ──────────────────────────

export function generateConfigTemplate(): string {
  return JSON.stringify(
    {
      providers: {
        anthropic: { apiKey: "$ANTHROPIC_API_KEY" },
        openai: { apiKey: "$OPENAI_API_KEY" },
        groq: { apiKey: "$GROQ_API_KEY" },
        google: { apiKey: "$GOOGLE_API_KEY" },
        openrouter: { apiKey: "$OPENROUTER_API_KEY" },
        ollama: { baseUrl: "http://localhost:11434/v1" },
      },
      defaultStrategy: "cheapest",
    },
    null,
    2
  );
}

export function saveConfigTemplate(location: "global" | "local" = "local"): string {
  const filePath =
    location === "global"
      ? path.join(os.homedir(), ".llm-router", "config.json")
      : path.join(process.cwd(), ".llm-router.json");

  if (fs.existsSync(filePath)) {
    throw new Error(`Config already exists at ${filePath}. Delete it first or edit manually.`);
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, generateConfigTemplate());
  return filePath;
}
