import type { OSProvider } from "./providers/types.js";
import type { AgentConfig, ToolDefinition } from "./types.js";
import { AgentLoop } from "./agent-loop.js";
import type { ToolExecutor } from "./agent-loop.js";

export class SpiritAgent {
  private loop: AgentLoop;
  private provider: OSProvider;

  constructor(provider: OSProvider, config: AgentConfig) {
    this.provider = provider;
    this.loop = new AgentLoop(provider, config);
  }

  /**
   * Register a custom tool. Hosts use this to add environment-specific
   * tools (e.g., js_eval, dom_query) beyond Spirit's built-in set.
   * Custom tools are included in API calls alongside built-in tools.
   */
  registerTool(
    definition: ToolDefinition,
    execute: ToolExecutor
  ): void {
    this.loop.registerTool(definition, execute);
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
}
