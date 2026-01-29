import type {
  CreateMessageParams,
  MessageResponse,
  StreamEvent,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export interface StreamedResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  inputTokens: number;
  outputTokens: number;
}

export class ApiClient {
  private apiKey: string;
  model: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    model = "claude-sonnet-4-20250514",
    baseUrl = DEFAULT_BASE_URL
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async createMessage(
    params: Omit<CreateMessageParams, "model">,
    signal?: AbortSignal
  ): Promise<MessageResponse> {
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
        ...params,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body}`);
    }

    return response.json();
  }

  /**
   * Stream a message response via SSE.
   * Calls onTextDelta for each text chunk as it arrives.
   * Returns the fully assembled response when complete.
   */
  async createMessageStream(
    params: Omit<CreateMessageParams, "model">,
    onTextDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<StreamedResponse> {
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
        stream: true,
        ...params,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body}`);
    }

    // Parse SSE stream
    const contentBlocks: ContentBlock[] = [];
    let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;

    // Track in-progress blocks
    const blockTexts: Map<number, string> = new Map();
    const blockToolJsons: Map<number, string> = new Map();
    const blockToolMeta: Map<number, { id: string; name: string }> =
      new Map();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let event: StreamEvent;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage.input_tokens;
            break;

          case "content_block_start":
            if (event.content_block.type === "text") {
              blockTexts.set(event.index, event.content_block.text);
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
              onTextDelta(event.delta.text);
            } else if (event.delta.type === "input_json_delta") {
              const prev = blockToolJsons.get(event.index) ?? "";
              blockToolJsons.set(
                event.index,
                prev + event.delta.partial_json
              );
            }
            break;

          case "content_block_stop": {
            // Finalize the block
            if (blockTexts.has(event.index)) {
              const text = blockTexts.get(event.index)!;
              contentBlocks.push({ type: "text", text } as TextBlock);
              blockTexts.delete(event.index);
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
              } as ToolUseBlock);
              blockToolMeta.delete(event.index);
              blockToolJsons.delete(event.index);
            }
            break;
          }

          case "message_delta":
            stopReason = event.delta.stop_reason;
            outputTokens = event.usage.output_tokens;
            break;
        }
      }
    }

    return { content: contentBlocks, stop_reason: stopReason, inputTokens, outputTokens };
  }
}
