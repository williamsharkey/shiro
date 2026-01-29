import type { OSProvider } from "./providers/types.js";
import type {
  AgentConfig,
  ContentBlock,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";
import { ApiClient } from "./api-client.js";
import { ToolRegistry } from "./tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_TOKENS = 16384;

export class AgentLoop {
  private messages: Message[] = [];
  private provider: OSProvider;
  private tools: ToolRegistry;
  private apiClient: ApiClient;
  private config: AgentConfig;
  private abortController: AbortController | null = null;

  constructor(provider: OSProvider, config: AgentConfig) {
    this.provider = provider;
    this.config = config;
    this.apiClient = new ApiClient(config.apiKey, config.model);
    this.tools = new ToolRegistry();
  }

  async run(userMessage: string): Promise<string> {
    this.abortController = new AbortController();
    this.messages.push({ role: "user", content: userMessage });

    const systemPrompt =
      this.config.systemPrompt ?? buildSystemPrompt(this.provider);
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;
    let turns = 0;

    while (turns < maxTurns) {
      const response = await this.apiClient.createMessage(
        {
          system: systemPrompt,
          messages: this.messages,
          tools: this.tools.getDefinitions(),
          max_tokens: DEFAULT_MAX_TOKENS,
        },
        this.abortController.signal
      );

      this.messages.push({ role: "assistant", content: response.content });

      // Extract text blocks and emit them
      const textParts = response.content
        .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
        .map((b) => b.text);

      if (textParts.length > 0) {
        const text = textParts.join("");
        this.config.onText?.(text);
      }

      // Find tool_use blocks
      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      if (toolUses.length === 0) {
        // No tool calls — done
        return textParts.join("");
      }

      // Execute tools and collect results
      const toolResults: ToolResultBlock[] = [];

      for (const toolUse of toolUses) {
        this.config.onToolStart?.(toolUse.name, toolUse.input);

        try {
          const result = await this.tools.execute(
            toolUse.name,
            toolUse.input,
            this.provider
          );
          this.config.onToolEnd?.(toolUse.name, result);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result,
          });
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.config.onError?.(
            error instanceof Error ? error : new Error(message)
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: ${message}`,
            is_error: true,
          });
        }
      }

      // Send tool results back as user message
      this.messages.push({ role: "user", content: toolResults });
      turns++;
    }

    return "[Spirit: max turns reached]";
  }

  abort(): void {
    this.abortController?.abort();
  }

  clearHistory(): void {
    this.messages = [];
  }

  getMessages(): Message[] {
    return [...this.messages];
  }
}
