import type { OSProvider } from "./providers/types.js";
import type { AgentConfig, SpiritStats, SpiritTask, ToolDefinition } from "./types.js";
import { AgentLoop } from "./agent-loop.js";
import type { ToolExecutor } from "./agent-loop.js";

const SLASH_COMMANDS: Record<string, string> = {
  "/help": "Show available commands",
  "/clear": "Clear conversation history and stats",
  "/compact": "Summarize conversation to reduce token usage",
  "/model": "Switch model (e.g., /model opus, /model sonnet)",
  "/stats": "Show token usage and timing",
  "/tasks": "Show task checklist",
  "/thinking": "Toggle extended thinking (e.g., /thinking 10000)",
  "/cost": "Show estimated API cost",
  "/history": "Show conversation turn count",
  "/env": "Show dev environment capabilities",
  "/abort": "Cancel current run",
};

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-5-20251101",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-3-5-20241022",
};

// Approximate pricing per million tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-5-20251101": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-3-5-20241022": { input: 0.8, output: 4 },
};

export class SpiritAgent {
  private loop: AgentLoop;
  private provider: OSProvider;
  private config: AgentConfig;

  constructor(provider: OSProvider, config: AgentConfig) {
    this.provider = provider;
    this.config = config;
    this.loop = new AgentLoop(provider, config);
  }

  /**
   * Register a custom tool. Hosts use this to add environment-specific
   * tools (e.g., js_eval, dom_query) beyond Spirit's built-in set.
   * Custom tools are included in API calls alongside built-in tools.
   */
  registerTool(definition: ToolDefinition, execute: ToolExecutor): void {
    this.loop.registerTool(definition, execute);
  }

  /**
   * Handle a slash command. Returns true if the input was a slash command
   * (and was handled), false if it should be sent to the agent loop.
   * The result string is the command output to display.
   */
  async handleSlashCommand(
    input: string
  ): Promise<{ handled: boolean; output: string }> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
      return { handled: false, output: "" };
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "/help": {
        const lines = Object.entries(SLASH_COMMANDS)
          .map(([k, v]) => `  ${k.padEnd(12)} ${v}`)
          .join("\n");
        return { handled: true, output: `Available commands:\n${lines}` };
      }

      case "/clear":
        this.loop.clearHistory();
        return { handled: true, output: "Conversation cleared." };

      case "/compact": {
        const result = await this.loop.compact();
        return { handled: true, output: result };
      }

      case "/model": {
        const modelArg = parts[1];
        if (!modelArg) {
          const current = this.loop.getApiClient().model;
          return {
            handled: true,
            output: `Current model: ${current}\nUsage: /model <name>\nAliases: ${Object.keys(MODEL_ALIASES).join(", ")}`,
          };
        }
        const resolved = MODEL_ALIASES[modelArg.toLowerCase()] ?? modelArg;
        this.loop.getApiClient().model = resolved;
        return { handled: true, output: `Model switched to: ${resolved}` };
      }

      case "/stats": {
        const s = this.loop.getStats();
        const elapsed = (s.elapsedMs / 1000).toFixed(1);
        return {
          handled: true,
          output: [
            `Tokens: ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out (${s.totalTokens.toLocaleString()} total)`,
            `Turns: ${s.turns}  Tool calls: ${s.toolCalls}`,
            `Elapsed: ${elapsed}s`,
          ].join("\n"),
        };
      }

      case "/tasks": {
        const tasks = this.loop.getTasks();
        if (tasks.length === 0) {
          return { handled: true, output: "No tasks." };
        }
        const statusIcon: Record<string, string> = {
          pending: "[ ]",
          in_progress: "[~]",
          completed: "[x]",
        };
        const lines = tasks
          .map(
            (t) => `${statusIcon[t.status] ?? "[ ]"} #${t.id} ${t.subject}`
          )
          .join("\n");
        return { handled: true, output: lines };
      }

      case "/thinking": {
        const budget = parseInt(parts[1], 10);
        if (!parts[1]) {
          const current = this.config.thinkingBudget ?? 0;
          return {
            handled: true,
            output: current > 0
              ? `Extended thinking: enabled (budget: ${current.toLocaleString()} tokens)`
              : "Extended thinking: disabled\nUsage: /thinking <budget> (e.g., /thinking 10000)",
          };
        }
        if (isNaN(budget) || budget < 0) {
          return { handled: true, output: "Invalid budget. Use a positive number or 0 to disable." };
        }
        this.config.thinkingBudget = budget;
        return {
          handled: true,
          output: budget > 0
            ? `Extended thinking enabled: ${budget.toLocaleString()} token budget`
            : "Extended thinking disabled.",
        };
      }

      case "/cost": {
        const s = this.loop.getStats();
        const model = this.loop.getApiClient().model;
        const pricing = MODEL_PRICING[model];
        if (pricing) {
          const inputCost = (s.inputTokens / 1_000_000) * pricing.input;
          const outputCost = (s.outputTokens / 1_000_000) * pricing.output;
          const totalCost = inputCost + outputCost;
          return {
            handled: true,
            output: [
              `Model: ${model}`,
              `Input:  ${s.inputTokens.toLocaleString()} tokens × $${pricing.input}/M = $${inputCost.toFixed(4)}`,
              `Output: ${s.outputTokens.toLocaleString()} tokens × $${pricing.output}/M = $${outputCost.toFixed(4)}`,
              `Total:  $${totalCost.toFixed(4)}`,
            ].join("\n"),
          };
        }
        return {
          handled: true,
          output: `Model: ${model}\nTokens: ${s.totalTokens.toLocaleString()} (pricing unknown for this model)`,
        };
      }

      case "/history": {
        const msgCount = this.loop.getMessages().length;
        const s = this.loop.getStats();
        return {
          handled: true,
          output: `Messages: ${msgCount}  Turns: ${s.turns}  Tool calls: ${s.toolCalls}`,
        };
      }

      case "/env": {
        const hostInfo = this.provider.getHostInfo();
        const caps = hostInfo.capabilities;
        if (!caps) {
          return { handled: true, output: `${hostInfo.name} v${hostInfo.version}\nNo dev capabilities declared.` };
        }
        const envLines = [`${hostInfo.name} v${hostInfo.version} — Dev Environment`];
        if (caps.runtimes.length) envLines.push(`Runtimes:         ${caps.runtimes.join(", ")}`);
        if (caps.packageManagers.length) envLines.push(`Package managers:  ${caps.packageManagers.join(", ")}`);
        if (caps.buildTools.length) envLines.push(`Build tools:       ${caps.buildTools.join(", ")}`);
        envLines.push(`Git:               ${caps.git ? "yes" : "no"}`);
        if (caps.extraCommands.length) envLines.push(`Extra commands:    ${caps.extraCommands.join(", ")}`);
        if (caps.fsRoots.length) envLines.push(`FS roots:          ${caps.fsRoots.join(", ")}`);
        if (caps.notes.length) {
          envLines.push("");
          for (const note of caps.notes) envLines.push(`  ${note}`);
        }
        return { handled: true, output: envLines.join("\n") };
      }

      case "/abort":
        this.loop.abort();
        return { handled: true, output: "Aborted." };

      default:
        return {
          handled: true,
          output: `Unknown command: ${cmd}. Type /help for available commands.`,
        };
    }
  }

  async run(userMessage: string): Promise<string> {
    return this.loop.run(userMessage);
  }

  abort(): void {
    this.loop.abort();
  }

  clearHistory(): void {
    this.loop.clearHistory();
  }

  getStats(): SpiritStats {
    return this.loop.getStats();
  }

  getTasks(): SpiritTask[] {
    return this.loop.getTasks();
  }

  async compact(): Promise<string> {
    return this.loop.compact();
  }
}
