import type { OSProvider } from "./providers/types.js";
import type { AgentConfig } from "./types.js";
import { AgentLoop } from "./agent-loop.js";

export class SpiritAgent {
  private loop: AgentLoop;
  private provider: OSProvider;

  constructor(provider: OSProvider, config: AgentConfig) {
    this.provider = provider;
    this.loop = new AgentLoop(provider, config);
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
