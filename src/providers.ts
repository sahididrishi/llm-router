import type {
  Provider, ProviderConfig, ProviderResponse, Message, ModelInfo,
  MODEL_REGISTRY, DEFAULT_BASE_URLS, DEFAULT_MODELS,
} from "./types.js";
import {
  MODEL_REGISTRY as MODELS,
  DEFAULT_BASE_URLS as URLS,
  DEFAULT_MODELS as DEFAULTS,
} from "./types.js";

// ── Fetch with timeout ──────────────────────────────────────

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── SSE parser ──────────────────────────────────────────────

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
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        yield data;
      }
    }
  }
}

// ── Anthropic provider ──────────────────────────────────────

export class AnthropicProvider implements Provider {
  name = "anthropic";
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || "";
    this.baseUrl = config.baseUrl || URLS.anthropic;
    this.timeoutMs = config.timeoutMs || 30_000;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  listModels(): ModelInfo[] {
    return MODELS.filter((m) => m.provider === "anthropic");
  }

  async chat(
    messages: Message[],
    model: string,
    opts?: { maxTokens?: number; temperature?: number; system?: string }
  ): Promise<ProviderResponse> {
    const { system, apiMessages } = this.formatMessages(messages, opts?.system);

    const response = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || DEFAULTS.anthropic,
        max_tokens: opts?.maxTokens || 4096,
        temperature: opts?.temperature,
        system: system || undefined,
        messages: apiMessages,
      }),
    }, this.timeoutMs);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
    }

    const data = await response.json() as any;
    const text = data.content?.[0]?.text || "";

    return {
      text,
      model: data.model,
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    };
  }

  async *streamChat(
    messages: Message[],
    model: string,
    opts?: { maxTokens?: number; temperature?: number; system?: string }
  ): AsyncIterable<string> {
    const { system, apiMessages } = this.formatMessages(messages, opts?.system);

    const response = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || DEFAULTS.anthropic,
        max_tokens: opts?.maxTokens || 4096,
        temperature: opts?.temperature,
        system: system || undefined,
        messages: apiMessages,
        stream: true,
      }),
    }, this.timeoutMs);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
    }

    for await (const data of parseSSE(response)) {
      try {
        const event = JSON.parse(data);
        if (event.type === "content_block_delta" && event.delta?.text) {
          yield event.delta.text;
        }
      } catch (e) { /* skip non-JSON SSE lines */ }
    }
  }

  private formatMessages(messages: Message[], system?: string) {
    let sysPrompt = system || "";
    const apiMessages: Array<{ role: string; content: string }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        if (!sysPrompt) sysPrompt = msg.content;
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return { system: sysPrompt, apiMessages };
  }
}

// ── OpenAI-compatible provider ──────────────────────────────
// Works with: OpenAI, Groq, OpenRouter, Ollama, Together, Fireworks, Mistral, etc.

export class OpenAICompatProvider implements Provider {
  name: string;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(providerName: string, config: ProviderConfig) {
    this.name = providerName;
    this.apiKey = config.apiKey || this.envKey(providerName) || "";
    this.baseUrl = config.baseUrl || URLS[providerName] || URLS.openai;
    this.timeoutMs = config.timeoutMs || 30_000;
  }

  isAvailable(): boolean {
    // Ollama doesn't need an API key
    if (this.name === "ollama") return true;
    return !!this.apiKey;
  }

  listModels(): ModelInfo[] {
    return MODELS.filter((m) => m.provider === this.name);
  }

  async chat(
    messages: Message[],
    model: string,
    opts?: { maxTokens?: number; temperature?: number; system?: string }
  ): Promise<ProviderResponse> {
    const apiMessages = this.formatMessages(messages, opts?.system);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || DEFAULTS[this.name] || "gpt-4o-mini",
        max_tokens: opts?.maxTokens || 4096,
        temperature: opts?.temperature,
        messages: apiMessages,
      }),
    }, this.timeoutMs);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`${this.name} API error (${response.status}): ${err}`);
    }

    const data = await response.json() as any;
    const text = data.choices?.[0]?.message?.content || "";

    return {
      text,
      model: data.model || model,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    };
  }

  async *streamChat(
    messages: Message[],
    model: string,
    opts?: { maxTokens?: number; temperature?: number; system?: string }
  ): AsyncIterable<string> {
    const apiMessages = this.formatMessages(messages, opts?.system);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || DEFAULTS[this.name] || "gpt-4o-mini",
        max_tokens: opts?.maxTokens || 4096,
        temperature: opts?.temperature,
        messages: apiMessages,
        stream: true,
      }),
    }, this.timeoutMs);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`${this.name} API error (${response.status}): ${err}`);
    }

    for await (const data of parseSSE(response)) {
      try {
        const event = JSON.parse(data);
        const content = event.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch (e) { /* skip non-JSON SSE lines */ }
    }
  }

  private formatMessages(messages: Message[], system?: string) {
    const apiMessages: Array<{ role: string; content: string }> = [];

    if (system) {
      apiMessages.push({ role: "system", content: system });
    }

    for (const msg of messages) {
      // Skip system messages from history if we already have an explicit system prompt
      if (msg.role === "system") {
        if (!system) apiMessages.push({ role: msg.role, content: msg.content });
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return apiMessages;
  }

  private envKey(provider: string): string {
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      groq: "GROQ_API_KEY",
      google: "GOOGLE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    return process.env[envMap[provider] || ""] || "";
  }
}

// ── Provider factory ────────────────────────────────────────

export function createProvider(name: string, config: ProviderConfig): Provider {
  if (name === "anthropic") {
    return new AnthropicProvider(config);
  }
  return new OpenAICompatProvider(name, config);
}
