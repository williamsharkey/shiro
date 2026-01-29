import type { OSProvider } from "./providers/types.js";
import type {
  AgentConfig,
  ContentBlock,
  Message,
  SpiritStats,
  SpiritTask,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";
import { ApiClient } from "./api-client.js";
import { ToolRegistry } from "./tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_TOKENS = 16384;

export type ToolExecutor = (
  input: Record<string, unknown>,
  provider: OSProvider
) => Promise<string>;

export class AgentLoop {
  private messages: Message[] = [];
  private provider: OSProvider;
  private tools: ToolRegistry;
  private apiClient: ApiClient;
  private config: AgentConfig;
  private abortController: AbortController | null = null;

  // Stats
  private stats: SpiritStats = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
    toolCalls: 0,
    elapsedMs: 0,
  };
  private runStartTime = 0;

  // Task tracking
  private tasks: SpiritTask[] = [];
  private taskIdCounter = 0;

  constructor(provider: OSProvider, config: AgentConfig) {
    this.provider = provider;
    this.config = config;
    this.apiClient = new ApiClient(config.apiKey, config.model);
    this.tools = new ToolRegistry();

    // Register task management tools
    this.tools.register(
      {
        name: "TaskCreate",
        description:
          "Create a task to track progress on multi-step work. Returns the task ID.",
        input_schema: {
          type: "object",
          properties: {
            subject: { type: "string", description: "Brief task title" },
            description: {
              type: "string",
              description: "Detailed description",
            },
          },
          required: ["subject"],
        },
      },
      async (input) => {
        const id = String(++this.taskIdCounter);
        this.tasks.push({
          id,
          subject: input.subject as string,
          status: "pending",
          description: input.description as string | undefined,
        });
        this.config.onTaskUpdate?.([...this.tasks]);
        return `Task #${id} created: ${input.subject}`;
      }
    );

    this.tools.register(
      {
        name: "TaskUpdate",
        description:
          "Update a task's status. Use 'in_progress' when starting work, 'completed' when done.",
        input_schema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "The task ID to update" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "New status",
            },
          },
          required: ["taskId", "status"],
        },
      },
      async (input) => {
        const task = this.tasks.find((t) => t.id === (input.taskId as string));
        if (!task) return `Error: task ${input.taskId} not found`;
        task.status = input.status as SpiritTask["status"];
        this.config.onTaskUpdate?.([...this.tasks]);
        return `Task #${task.id} → ${task.status}`;
      }
    );
  }

  registerTool(definition: ToolDefinition, execute: ToolExecutor): void {
    this.tools.register(definition, execute);
  }

  async run(userMessage: string): Promise<string> {
    this.abortController = new AbortController();
    this.runStartTime = Date.now();
    this.messages.push({ role: "user", content: userMessage });

    const systemPrompt =
      this.config.systemPrompt ?? buildSystemPrompt(this.provider);
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;

    while (this.stats.turns < maxTurns) {
      // Use streaming API
      const streamed = await this.apiClient.createMessageStream(
        {
          system: systemPrompt,
          messages: this.messages,
          tools: this.tools.getDefinitions(),
          max_tokens: DEFAULT_MAX_TOKENS,
        },
        (delta) => {
          // Real-time text streaming to host
          this.config.onText?.(delta);
        },
        this.abortController.signal
      );

      // Update stats
      this.stats.inputTokens += streamed.inputTokens;
      this.stats.outputTokens += streamed.outputTokens;
      this.stats.totalTokens =
        this.stats.inputTokens + this.stats.outputTokens;
      this.stats.turns++;
      this.stats.elapsedMs = Date.now() - this.runStartTime;
      this.emitStats();

      // Record assistant message
      this.messages.push({ role: "assistant", content: streamed.content });

      // Collect text
      const textParts = streamed.content
        .filter(
          (b): b is ContentBlock & { type: "text" } => b.type === "text"
        )
        .map((b) => b.text);

      // Find tool_use blocks
      const toolUses = streamed.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      if (toolUses.length === 0) {
        return textParts.join("");
      }

      // Execute tools
      const toolResults: ToolResultBlock[] = [];

      for (const toolUse of toolUses) {
        this.stats.toolCalls++;
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

        this.stats.elapsedMs = Date.now() - this.runStartTime;
        this.emitStats();
      }

      this.messages.push({ role: "user", content: toolResults });
    }

    return "[Spirit: max turns reached]";
  }

  /**
   * Compact conversation by summarizing older messages.
   * Replaces history with a summary to reduce token usage.
   */
  async compact(): Promise<string> {
    if (this.messages.length < 4) return "Nothing to compact";

    // Build a summary request
    const summaryMessages: Message[] = [
      ...this.messages,
      {
        role: "user" as const,
        content:
          "Summarize this entire conversation concisely. Preserve: all file paths mentioned, all decisions made, current state of work, and any pending tasks. This summary will replace the conversation history to save tokens.",
      },
    ];

    const response = await this.apiClient.createMessage(
      {
        system: "You are a conversation summarizer. Be concise but complete.",
        messages: summaryMessages,
        tools: [],
        max_tokens: 4096,
      },
      this.abortController?.signal
    );

    const summary = response.content
      .filter(
        (b): b is ContentBlock & { type: "text" } => b.type === "text"
      )
      .map((b) => b.text)
      .join("");

    const oldCount = this.messages.length;

    // Replace history with summary
    this.messages = [
      {
        role: "user",
        content: `[Conversation summary from ${oldCount} messages]\n\n${summary}`,
      },
      {
        role: "assistant",
        content: "Understood. I have the context from the conversation summary. How can I continue helping?",
      },
    ];

    return `Compacted ${oldCount} messages → summary (${summary.length} chars)`;
  }

  private emitStats(): void {
    this.config.onStats?.({ ...this.stats });
  }

  abort(): void {
    this.abortController?.abort();
  }

  clearHistory(): void {
    this.messages = [];
    this.stats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turns: 0,
      toolCalls: 0,
      elapsedMs: 0,
    };
    this.tasks = [];
    this.taskIdCounter = 0;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getStats(): SpiritStats {
    return {
      ...this.stats,
      elapsedMs: this.runStartTime
        ? Date.now() - this.runStartTime
        : this.stats.elapsedMs,
    };
  }

  getTasks(): SpiritTask[] {
    return [...this.tasks];
  }

  getApiClient(): ApiClient {
    return this.apiClient;
  }
}
