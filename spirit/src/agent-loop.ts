import type { OSProvider } from "./providers/types.js";
import type {
  AgentConfig,
  ContentBlock,
  Message,
  PermissionRequest,
  SpiritStats,
  SpiritTask,
  ThinkingBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";
import { ApiClient } from "./api-client.js";
import { ToolRegistry } from "./tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { SubAgentManager } from "./sub-agent.js";
import type { SubAgentResult } from "./sub-agent.js";

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

  // Sub-agent support
  private subAgentManager: SubAgentManager;

  constructor(provider: OSProvider, config: AgentConfig) {
    this.provider = provider;
    this.config = config;
    this.apiClient = new ApiClient(config.apiKey, config.model);
    this.tools = new ToolRegistry();
    this.subAgentManager = new SubAgentManager(provider, config);

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

    // Sub-agent tools
    this.tools.register(
      {
        name: "SpawnAgent",
        description:
          "Launch a sub-agent to handle a task concurrently. The sub-agent runs independently with its own conversation. Returns an agent ID for tracking.",
        input_schema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The task for the sub-agent to perform",
            },
            description: {
              type: "string",
              description: "Short description for tracking (3-5 words)",
            },
          },
          required: ["prompt"],
        },
      },
      async (input) => {
        const id = this.subAgentManager.spawn(
          input.prompt as string,
          input.description as string | undefined
        );
        return `Sub-agent #${id} spawned: ${input.description ?? (input.prompt as string).slice(0, 60)}`;
      }
    );

    this.tools.register(
      {
        name: "WaitForAgent",
        description:
          "Wait for a sub-agent to complete and get its result. Use 'all' as ID to wait for all running agents.",
        input_schema: {
          type: "object",
          properties: {
            agentId: {
              type: "string",
              description: "The agent ID to wait for, or 'all'",
            },
          },
          required: ["agentId"],
        },
      },
      async (input) => {
        const id = input.agentId as string;
        if (id === "all") {
          const results = await this.subAgentManager.waitAll();
          return results
            .map(
              (r) =>
                `Agent #${r.id} (${r.prompt}): ${r.status}${r.status === "error" ? ` - ${r.error}` : ""}\n${r.result.slice(0, 500)}`
            )
            .join("\n\n");
        }
        const result = await this.subAgentManager.waitFor(id);
        return `Agent #${result.id} (${result.prompt}): ${result.status}\n${result.result}`;
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
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    while (this.stats.turns < maxTurns) {
      // Use streaming API with thinking support
      const streamed = await this.apiClient.createMessageStream(
        {
          system: systemPrompt,
          messages: this.messages,
          tools: this.tools.getDefinitions(),
          max_tokens: maxTokens,
          thinkingBudget: this.config.thinkingBudget,
        },
        (delta) => {
          // Real-time text streaming to host
          this.config.onText?.(delta);
        },
        this.abortController.signal,
        (thinkingDelta) => {
          // Real-time thinking streaming
          this.config.onThinking?.(thinkingDelta);
        }
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

      // Execute tools with permission checks
      const toolResults: ToolResultBlock[] = [];

      // Tools that modify the filesystem or run commands need permission
      const DANGEROUS_TOOLS = new Set(["Bash", "Write", "Edit"]);

      for (const toolUse of toolUses) {
        this.stats.toolCalls++;

        // Permission check for dangerous operations
        if (DANGEROUS_TOOLS.has(toolUse.name) && this.config.onPermissionRequest) {
          const description = this.describeToolUse(toolUse);
          const request: PermissionRequest = {
            tool: toolUse.name,
            description,
            input: toolUse.input,
          };
          const allowed = await this.config.onPermissionRequest(request);
          if (!allowed) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Permission denied by user.",
              is_error: true,
            });
            continue;
          }
        }

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

  /**
   * Generate a human-readable description of a tool use for permission prompts.
   * Mimics Claude Code's tool use descriptions.
   */
  private describeToolUse(toolUse: ToolUseBlock): string {
    const input = toolUse.input;
    switch (toolUse.name) {
      case "Bash":
        return `Run command: ${input.command}`;
      case "Write":
        return `Write to ${input.file_path}`;
      case "Edit":
        return `Edit ${input.file_path}`;
      default:
        return `${toolUse.name}: ${JSON.stringify(input).slice(0, 100)}`;
    }
  }

  private emitStats(): void {
    this.config.onStats?.({ ...this.stats });
  }

  abort(): void {
    this.abortController?.abort();
    this.subAgentManager.abortAll();
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
