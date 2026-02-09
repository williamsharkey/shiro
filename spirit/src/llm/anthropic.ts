/**
 * Anthropic Claude provider
 */

import type {
  LLMProvider,
  LLMProviderCapabilities,
  LLMCreateParams,
  LLMStreamCallbacks,
  LLMStreamedResponse,
  LLMContentBlock,
  LLMAuthConfig,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

const MODELS = [
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-20250514",
  "claude-haiku-3-5-20241022",
];

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-5-20251101": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-3-5-20241022": { input: 0.8, output: 4 },
};

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly capabilities: LLMProviderCapabilities = {
    streaming: true,
    toolUse: true,
    thinking: true,
    vision: true,
  };
  readonly availableModels = MODELS;

  model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(auth: LLMAuthConfig, model?: string, baseUrl?: string) {
    if (auth.type !== "api_key") {
      throw new Error("Anthropic only supports API key authentication");
    }
    this.apiKey = auth.apiKey;
    this.model = model ?? "claude-sonnet-4-20250514";
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
  }

  isAuthenticated(): boolean {
    return !!this.apiKey;
  }

  getPricing(): { input: number; output: number } | null {
    return PRICING[this.model] ?? null;
  }

  async createMessage(
    params: LLMCreateParams,
    signal?: AbortSignal
  ): Promise<LLMStreamedResponse> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.model,
        system: params.system,
        messages: this.convertMessages(params.messages),
        tools: params.tools,
        max_tokens: params.max_tokens,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body}`);
    }

    const data = await response.json();
    return {
      content: data.content as LLMContentBlock[],
      stop_reason: data.stop_reason,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
  }

  async createMessageStream(
    params: LLMCreateParams,
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMStreamedResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      system: params.system,
      messages: this.convertMessages(params.messages),
      tools: params.tools,
      max_tokens: params.max_tokens,
    };

    // Extended thinking support
    if (params.thinkingBudget && params.thinkingBudget > 0) {
      body.thinking = {
        type: "enabled",
        budget_tokens: params.thinkingBudget,
      };
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    return this.parseSSEStream(response, callbacks);
  }

  private convertMessages(messages: LLMCreateParams["messages"]) {
    // Anthropic format is already compatible
    return messages.filter(m => m.role !== "system").map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  private async parseSSEStream(
    response: Response,
    callbacks: LLMStreamCallbacks
  ): Promise<LLMStreamedResponse> {
    const contentBlocks: LLMContentBlock[] = [];
    let stopReason: LLMStreamedResponse["stop_reason"] = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;

    const blockTexts = new Map<number, string>();
    const blockThinking = new Map<number, string>();
    const blockToolJsons = new Map<number, string>();
    const blockToolMeta = new Map<number, { id: string; name: string }>();

    if (!response.body) {
      throw new Error("Empty response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          switch (event.type) {
            case "error":
              throw new Error(`Stream error: ${event.error.message}`);

            case "message_start":
              inputTokens = event.message.usage.input_tokens;
              break;

            case "content_block_start":
              if (event.content_block.type === "text") {
                blockTexts.set(event.index, event.content_block.text ?? "");
              } else if (event.content_block.type === "thinking") {
                blockThinking.set(event.index, event.content_block.thinking ?? "");
              } else if (event.content_block.type === "tool_use") {
                blockToolMeta.set(event.index, {
                  id: event.content_block.id,
                  name: event.content_block.name,
                });
                blockToolJsons.set(event.index, "");
              }
              break;

            case "content_block_delta":
              if (event.delta.type === "text_delta") {
                const prev = blockTexts.get(event.index) ?? "";
                blockTexts.set(event.index, prev + event.delta.text);
                callbacks.onText?.(event.delta.text);
              } else if (event.delta.type === "thinking_delta") {
                const prev = blockThinking.get(event.index) ?? "";
                blockThinking.set(event.index, prev + event.delta.thinking);
                callbacks.onThinking?.(event.delta.thinking);
              } else if (event.delta.type === "input_json_delta") {
                const prev = blockToolJsons.get(event.index) ?? "";
                blockToolJsons.set(event.index, prev + event.delta.partial_json);
              }
              break;

            case "content_block_stop":
              if (blockTexts.has(event.index)) {
                contentBlocks.push({
                  type: "text",
                  text: blockTexts.get(event.index)!,
                });
                blockTexts.delete(event.index);
              } else if (blockThinking.has(event.index)) {
                contentBlocks.push({
                  type: "thinking",
                  thinking: blockThinking.get(event.index)!,
                });
                blockThinking.delete(event.index);
              } else if (blockToolMeta.has(event.index)) {
                const meta = blockToolMeta.get(event.index)!;
                const json = blockToolJsons.get(event.index) ?? "{}";
                let input: Record<string, unknown>;
                try {
                  input = JSON.parse(json);
                } catch {
                  input = {};
                }
                contentBlocks.push({
                  type: "tool_use",
                  id: meta.id,
                  name: meta.name,
                  input,
                });
                blockToolMeta.delete(event.index);
                blockToolJsons.delete(event.index);
              }
              break;

            case "message_delta":
              stopReason = event.delta.stop_reason;
              outputTokens = event.usage.output_tokens;
              break;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    return { content: contentBlocks, stop_reason: stopReason, inputTokens, outputTokens };
  }
}
