/**
 * OpenAI GPT provider
 */

import type {
  LLMProvider,
  LLMProviderCapabilities,
  LLMCreateParams,
  LLMStreamCallbacks,
  LLMStreamedResponse,
  LLMContentBlock,
  LLMAuthConfig,
  LLMToolDefinition,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com";

const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4",
  "gpt-3.5-turbo",
  "o1",
  "o1-mini",
];

const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
};

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly capabilities: LLMProviderCapabilities = {
    streaming: true,
    toolUse: true,
    thinking: false,  // o1 has reasoning but different API
    vision: true,
  };
  readonly availableModels = MODELS;

  model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(auth: LLMAuthConfig, model?: string, baseUrl?: string) {
    if (auth.type !== "api_key") {
      throw new Error("OpenAI only supports API key authentication");
    }
    this.apiKey = auth.apiKey;
    this.model = model ?? "gpt-4o";
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
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.convertMessages(params),
        tools: this.convertTools(params.tools),
        max_tokens: params.max_tokens,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${body}`);
    }

    const data = await response.json();
    return this.convertResponse(data);
  }

  async createMessageStream(
    params: LLMCreateParams,
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMStreamedResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.convertMessages(params),
        tools: params.tools.length > 0 ? this.convertTools(params.tools) : undefined,
        max_tokens: params.max_tokens,
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    return this.parseSSEStream(response, callbacks);
  }

  /**
   * Convert Spirit's unified message format to OpenAI format
   */
  private convertMessages(params: LLMCreateParams) {
    const messages: Array<{
      role: "system" | "user" | "assistant" | "tool";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    }> = [];

    // System message first
    messages.push({ role: "system", content: params.system });

    for (const msg of params.messages) {
      if (msg.role === "system") continue;

      if (typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Check if this is tool results
        const toolResults = msg.content.filter(
          (b: any) => b.type === "tool_result"
        );
        if (toolResults.length > 0) {
          // Convert tool results to OpenAI format
          for (const result of toolResults as any[]) {
            messages.push({
              role: "tool",
              tool_call_id: result.tool_use_id,
              content: result.content,
            });
          }
        } else {
          // Assistant message with tool calls or text
          const textBlocks = msg.content.filter((b: any) => b.type === "text");
          const toolUseBlocks = msg.content.filter((b: any) => b.type === "tool_use");

          const assistantMsg: typeof messages[0] = {
            role: "assistant",
            content: textBlocks.length > 0
              ? textBlocks.map((b: any) => b.text).join("")
              : null,
          };

          if (toolUseBlocks.length > 0) {
            assistantMsg.tool_calls = toolUseBlocks.map((b: any) => ({
              id: b.id,
              type: "function" as const,
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input),
              },
            }));
          }

          messages.push(assistantMsg);
        }
      }
    }

    return messages;
  }

  /**
   * Convert Spirit's tool definitions to OpenAI function format
   */
  private convertTools(tools: LLMToolDefinition[]) {
    return tools.map(tool => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  /**
   * Convert OpenAI response to Spirit's unified format
   */
  private convertResponse(data: any): LLMStreamedResponse {
    const choice = data.choices[0];
    const content: LLMContentBlock[] = [];

    // Add text content
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments || "{}"),
        });
      }
    }

    // Map finish_reason to our format
    let stopReason: LLMStreamedResponse["stop_reason"] = "end_turn";
    if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
    else if (choice.finish_reason === "length") stopReason = "max_tokens";

    return {
      content,
      stop_reason: stopReason,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }

  private async parseSSEStream(
    response: Response,
    callbacks: LLMStreamCallbacks
  ): Promise<LLMStreamedResponse> {
    const content: LLMContentBlock[] = [];
    let textContent = "";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
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
          if (data === "[DONE]") continue;

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const choice = event.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Text content
          if (delta?.content) {
            textContent += delta.content;
            callbacks.onText?.(delta.content);
          }

          // Tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              }
              const call = toolCalls.get(idx)!;
              if (tc.id) call.id = tc.id;
              if (tc.function?.name) call.name = tc.function.name;
              if (tc.function?.arguments) call.args += tc.function.arguments;
            }
          }

          // Finish reason
          if (choice.finish_reason) {
            if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
            else if (choice.finish_reason === "length") stopReason = "max_tokens";
          }

          // Usage (in final chunk)
          if (event.usage) {
            inputTokens = event.usage.prompt_tokens ?? 0;
            outputTokens = event.usage.completion_tokens ?? 0;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    // Assemble content
    if (textContent) {
      content.push({ type: "text", text: textContent });
    }

    for (const [_, tc] of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: JSON.parse(tc.args || "{}"),
      });
    }

    return { content, stop_reason: stopReason, inputTokens, outputTokens };
  }
}
