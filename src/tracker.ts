import fs from "fs";
import path from "path";
import os from "os";
import type { CostEntry, CostSummary } from "./types.js";

const COSTS_DIR = path.join(os.homedir(), ".llm-router");
const COSTS_FILE = path.join(COSTS_DIR, "costs.json");

export class CostTracker {
  private entries: CostEntry[] = [];
  private persist: boolean;

  constructor(persist = true) {
    this.persist = persist;
    if (persist) this.load();
  }

  record(entry: Omit<CostEntry, "timestamp">): void {
    const full: CostEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    if (this.persist) this.save();
  }

  getSummary(since?: string): CostSummary {
    let filtered = this.entries;

    if (since) {
      const cutoff = new Date(since).getTime();
      filtered = this.entries.filter(
        (e) => new Date(e.timestamp).getTime() >= cutoff
      );
    }

    const byProvider: Record<string, { cost: number; requests: number }> = {};
    const byModel: Record<string, { cost: number; requests: number }> = {};
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;

    for (const entry of filtered) {
      totalCost += entry.cost;
      totalInput += entry.inputTokens;
      totalOutput += entry.outputTokens;

      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = { cost: 0, requests: 0 };
      }
      byProvider[entry.provider].cost += entry.cost;
      byProvider[entry.provider].requests += 1;

      if (!byModel[entry.model]) {
        byModel[entry.model] = { cost: 0, requests: 0 };
      }
      byModel[entry.model].cost += entry.cost;
      byModel[entry.model].requests += 1;
    }

    return {
      totalCost,
      totalRequests: filtered.length,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      byProvider,
      byModel,
    };
  }

  clear(): void {
    this.entries = [];
    if (this.persist) this.save();
  }

  private load(): void {
    try {
      if (fs.existsSync(COSTS_FILE)) {
        const raw = fs.readFileSync(COSTS_FILE, "utf-8");
        this.entries = JSON.parse(raw);
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    if (!fs.existsSync(COSTS_DIR)) {
      fs.mkdirSync(COSTS_DIR, { recursive: true });
    }
    // Keep last 10,000 entries to prevent unbounded growth
    if (this.entries.length > 10_000) {
      this.entries = this.entries.slice(-10_000);
    }
    fs.writeFileSync(COSTS_FILE, JSON.stringify(this.entries, null, 2));
  }
}
