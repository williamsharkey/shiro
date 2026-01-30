/**
 * Google Gemini provider (API key authentication)
 *
 * Get a free API key at: https://aistudio.google.com/app/apikey
 * Free tier: 1,500 requests/day, 1M tokens/minute
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

const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];

const PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
};

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly capabilities: LLMProviderCapabilities = {
    streaming: true,
    toolUse: true,
    thinking: false,
    vision: true,
  };
  readonly availableModels = MODELS;

  model: string;
  private apiKey: string;

  constructor(auth: LLMAuthConfig, model?: string) {
    if (auth.type !== "api_key") {
      throw new Error("Gemini provider requires API key authentication");
    }
    this.apiKey = auth.apiKey;
    this.model = model ?? "gemini-2.0-flash";
  }

  isAuthenticated(): boolean {
    return !!this.apiKey;
  }

  getPricing(): { input: number; output: number } | null {
    return PRICING[this.model] ?? null;
  }

  private getUrl(endpoint: string): string {
    return `${API_BASE_URL}/models/${this.model}:${endpoint}?key=${this.apiKey}`;
  }

  async createMessage(
    params: LLMCreateParams,
    signal?: AbortSignal
  ): Promise<LLMStreamedResponse> {
    const response = await fetch(this.getUrl("generateContent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.convertRequest(params)),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${body}`);
    }

    const data = await response.json();
    return this.convertResponse(data);
  }

  async createMessageStream(
    params: LLMCreateParams,
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMStreamedResponse> {
    const response = await fetch(this.getUrl("streamGenerateContent") + "&alt=sse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.convertRequest(params)),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${text}`);
    }

    return this.parseSSEStream(response, callbacks);
  }

  /**
   * Convert Spirit's unified format to Gemini API format
   */
  private convertRequest(params: LLMCreateParams) {
    const contents: Array<{
      role: "user" | "model";
      parts: Array<{ text?: string; functionCall?: { name: string; args: object }; functionResponse?: { name: string; response: object } }>;
    }> = [];

    const systemInstruction = { parts: [{ text: params.system }] };

    for (const msg of params.messages) {
      if (msg.role === "system") continue;

      const role = msg.role === "assistant" ? "model" : "user";

      if (typeof msg.content === "string") {
        contents.push({ role, parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const parts: typeof contents[0]["parts"] = [];

        for (const block of msg.content as any[]) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input,
              },
            });
          } else if (block.type === "tool_result") {
            parts.push({
              functionResponse: {
                name: block.tool_use_id,
                response: { result: block.content },
              },
            });
          }
        }

        if (parts.length > 0) {
          contents.push({ role, parts });
        }
      }
    }

    const request: Record<string, unknown> = {
      contents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: params.max_tokens,
      },
    };

    if (params.tools.length > 0) {
      request.tools = [{
        functionDeclarations: params.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        })),
      }];
    }

    return request;
  }

  /**
   * Convert Gemini response to Spirit's unified format
   */
  private convertResponse(data: any): LLMStreamedResponse {
    const content: LLMContentBlock[] = [];
    let stopReason: LLMStreamedResponse["stop_reason"] = "end_turn";

    const candidate = data.candidates?.[0];
    if (candidate) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.text) {
          content.push({ type: "text", text: part.text });
        }
        if (part.functionCall) {
          content.push({
            type: "tool_use",
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          });
          stopReason = "tool_use";
        }
      }

      if (candidate.finishReason === "MAX_TOKENS") {
        stopReason = "max_tokens";
      }
    }

    return {
      content,
      stop_reason: stopReason,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  private async parseSSEStream(
    response: Response,
    callbacks: LLMStreamCallbacks
  ): Promise<LLMStreamedResponse> {
    const content: LLMContentBlock[] = [];
    let textContent = "";
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let stopReason: LLMStreamedResponse["stop_reason"] = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;

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
          if (!data) continue;

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const candidate = event.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                textContent += part.text;
                callbacks.onText?.(part.text);
              }
              if (part.functionCall) {
                toolCalls.push({
                  id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                  name: part.functionCall.name,
                  input: part.functionCall.args ?? {},
                });
                stopReason = "tool_use";
              }
            }
          }

          if (candidate?.finishReason === "MAX_TOKENS") {
            stopReason = "max_tokens";
          }

          if (event.usageMetadata) {
            inputTokens = event.usageMetadata.promptTokenCount ?? 0;
            outputTokens = event.usageMetadata.candidatesTokenCount ?? 0;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    if (textContent) {
      content.push({ type: "text", text: textContent });
    }

    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    return { content, stop_reason: stopReason, inputTokens, outputTokens };
  }
}
