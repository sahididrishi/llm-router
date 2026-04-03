#!/usr/bin/env node

import { Command } from "commander";
import { Router } from "./router.js";
import { loadConfig, saveConfigTemplate, generateConfigTemplate } from "./config.js";
import type { BenchmarkResult, CostSummary } from "./types.js";

// ── ANSI helpers ────────────────────────────────────────────

const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const RD = "\x1b[31m";
const nc = !process.stdout.isTTY || !!process.env.NO_COLOR;
const c = (code: string, t: string) => (nc ? t : `${code}${t}${R}`);

const program = new Command();

program
  .name("llm-router")
  .description("Unified LLM router — one interface for Claude, GPT, Gemini, Groq, Ollama, and more")
  .version("1.0.0");

// ── chat ────────────────────────────────────────────────────

program
  .command("chat")
  .description("Send a message to an LLM. Auto-selects the best provider based on strategy.")
  .argument("<message>", "Message to send")
  .option("-p, --provider <name>", "Use a specific provider (anthropic, openai, groq, ollama, etc)")
  .option("-m, --model <id>", "Use a specific model")
  .option("-s, --strategy <strategy>", "Routing strategy: cheapest, fastest, smartest, fallback", "fallback")
  .option("--system <prompt>", "System prompt")
  .option("--stream", "Stream the response in real-time")
  .option("--max-tokens <n>", "Maximum tokens in response", "4096")
  .action(async (message, opts) => {
    try {
      const maxTokens = parseInt(opts.maxTokens);
      if (isNaN(maxTokens) || maxTokens <= 0) {
        console.error("Error: --max-tokens must be a positive number");
        process.exit(1);
      }

      const router = new Router();

      if (opts.stream) {
        for await (const chunk of router.stream(message, {
          provider: opts.provider,
          model: opts.model,
          strategy: opts.strategy,
          system: opts.system,
          maxTokens,
        })) {
          process.stdout.write(chunk);
        }
        process.stdout.write("\n");
      } else {
        const response = await router.chat(message, {
          provider: opts.provider,
          model: opts.model,
          strategy: opts.strategy as any,
          system: opts.system,
          maxTokens,
        });

        console.log(response.text);
        console.log(
          `\n${c(D, `Provider: ${response.provider} | Model: ${response.model} | ` +
            `${response.usage.inputTokens} in / ${response.usage.outputTokens} out | ` +
            `${response.latencyMs}ms | $${response.usage.cost.toFixed(4)}`)}`
        );
      }
    } catch (err: any) {
      console.error(c(RD, `Error: ${err.message}`));
      process.exit(1);
    }
  });

// ── bench ───────────────────────────────────────────────────

program
  .command("bench")
  .description("Benchmark a prompt across multiple providers — compare speed, cost, and output")
  .argument("<prompt>", "Prompt to benchmark")
  .option("-p, --providers <list>", "Comma-separated provider list")
  .action(async (prompt, opts) => {
    try {
      const router = new Router();
      const providers = opts.providers?.split(",").map((s: string) => s.trim());

      console.log(c(B, "\nBenchmarking across providers...\n"));

      const results = await router.benchmark(prompt, providers);
      printBenchmarkTable(results);
    } catch (err: any) {
      console.error(c(RD, `Error: ${err.message}`));
      process.exit(1);
    }
  });

// ── models ──────────────────────────────────────────────────

program
  .command("models")
  .description("List all available models and their pricing")
  .option("-p, --provider <name>", "Filter by provider")
  .action((opts) => {
    const router = new Router();
    const models = router.listModels(opts.provider);

    if (models.length === 0) {
      console.log("No models found. Configure providers first: llm-router config init");
      return;
    }

    console.log(`\n${c(B, "Available Models")}\n`);
    console.log(
      padRight("Provider", 14) +
      padRight("Model", 32) +
      padRight("Input/1M", 10) +
      padRight("Output/1M", 10) +
      padRight("Context", 10) +
      "Tier"
    );
    console.log(c(D, "─".repeat(90)));

    for (const m of models) {
      const inputCost = m.inputCostPer1M === 0 ? "free" : `$${m.inputCostPer1M}`;
      const outputCost = m.outputCostPer1M === 0 ? "free" : `$${m.outputCostPer1M}`;
      const ctx = m.maxContext >= 1_000_000 ? `${m.maxContext / 1_000_000}M` : `${m.maxContext / 1000}K`;

      console.log(
        padRight(m.provider, 14) +
        padRight(m.displayName, 32) +
        padRight(inputCost, 10) +
        padRight(outputCost, 10) +
        padRight(ctx, 10) +
        m.tier
      );
    }
    console.log();
  });

// ── costs ───────────────────────────────────────────────────

program
  .command("costs")
  .description("Show cost tracking summary")
  .option("--since <date>", "Filter from date (YYYY-MM-DD)")
  .option("--clear", "Clear all cost history")
  .action((opts) => {
    try {
      const router = new Router();

      if (opts.clear) {
        router.clearCosts();
        console.log("Cost history cleared.");
        return;
      }

      const summary = router.getCosts(opts.since);
      printCostSummary(summary, opts.since);
    } catch (err: any) {
      console.error(c(RD, `Error: ${err.message}`));
      process.exit(1);
    }
  });

// ── providers ───────────────────────────────────────────────

program
  .command("providers")
  .description("List configured and available providers")
  .action(() => {
    const router = new Router();
    const active = router.listProviders();

    console.log(`\n${c(B, "Configured Providers")}\n`);
    if (active.length === 0) {
      console.log("  No providers configured. Run: llm-router config init\n");
    } else {
      for (const name of active) {
        console.log(`  ${c(G, "●")} ${name}`);
      }
      console.log();
    }

    const allKnown = ["anthropic", "openai", "groq", "google", "ollama", "openrouter"];
    const inactive = allKnown.filter((p) => !active.includes(p));
    if (inactive.length > 0) {
      console.log(c(D, "  Not configured:"));
      for (const name of inactive) {
        console.log(c(D, `  ○ ${name}`));
      }
      console.log();
    }
  });

// ── config ──────────────────────────────────────────────────

program
  .command("config")
  .description("Manage configuration")
  .argument("[action]", "init (create config file) or show (print current config)")
  .option("--global", "Save to ~/.llm-router/config.json instead of local")
  .action((action, opts) => {
    try {
      if (action === "init") {
        const location = opts.global ? "global" : "local";
        const filePath = saveConfigTemplate(location as any);
        console.log(`Config file created at: ${filePath}`);
        console.log("Edit it to add your API keys, or set them as environment variables.");
      } else if (action === "show") {
        const config = loadConfig();
        // Mask API keys for display
        const display = JSON.parse(JSON.stringify(config));
        for (const [name, provider] of Object.entries(display.providers || {})) {
          const key = (provider as any)?.apiKey;
          if (key && key.length > 8) {
            (provider as any).apiKey = key.slice(0, 8) + "...";
          } else if (key) {
            (provider as any).apiKey = "***";
          }
        }
        console.log(JSON.stringify(display, null, 2));
    } else {
      console.log("Usage: llm-router config init [--global] | llm-router config show");
    }
    } catch (err: any) {
      console.error(c(RD, `Error: ${err.message}`));
      process.exit(1);
    }
  });

// ── Parse ───────────────────────────────────────────────────

program.parse();

// ── Display helpers ─────────────────────────────────────────

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function printBenchmarkTable(results: BenchmarkResult[]) {
  console.log(
    padRight("Provider", 14) +
    padRight("Model", 28) +
    padRight("Time", 8) +
    padRight("Tokens", 14) +
    padRight("Cost", 10) +
    "Status"
  );
  console.log(c(D, "─".repeat(85)));

  for (const r of results) {
    if (r.error) {
      console.log(
        padRight(r.provider, 14) +
        padRight(r.model.slice(0, 27), 28) +
        padRight("-", 8) +
        padRight("-", 14) +
        padRight("-", 10) +
        c(RD, `Error: ${r.error.slice(0, 40)}`)
      );
    } else {
      console.log(
        padRight(r.provider, 14) +
        padRight(r.model.slice(0, 27), 28) +
        padRight(`${r.latencyMs}ms`, 8) +
        padRight(`${r.inputTokens}/${r.outputTokens}`, 14) +
        padRight(`$${r.cost.toFixed(4)}`, 10) +
        c(G, "OK")
      );
    }
  }

  console.log();

  // Show responses
  for (const r of results) {
    if (!r.error && r.responsePreview) {
      console.log(`${c(B, r.provider)}: ${r.responsePreview}`);
      console.log();
    }
  }
}

function printCostSummary(summary: CostSummary, since?: string) {
  console.log(`\n${c(B, "Cost Summary")}${since ? c(D, ` (since ${since})`) : ""}\n`);

  if (summary.totalRequests === 0) {
    console.log("  No requests recorded yet.\n");
    return;
  }

  console.log(`  Total cost:     ${c(C, "$" + summary.totalCost.toFixed(4))}`);
  console.log(`  Total requests: ${summary.totalRequests}`);
  console.log(`  Total tokens:   ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`);

  console.log(`\n  ${c(B, "By Provider:")}`);
  for (const [name, data] of Object.entries(summary.byProvider)) {
    console.log(`    ${padRight(name, 14)} $${data.cost.toFixed(4)}  (${data.requests} requests)`);
  }

  console.log(`\n  ${c(B, "By Model:")}`);
  for (const [name, data] of Object.entries(summary.byModel)) {
    console.log(`    ${padRight(name.slice(0, 30), 32)} $${data.cost.toFixed(4)}  (${data.requests} requests)`);
  }

  console.log();
}
