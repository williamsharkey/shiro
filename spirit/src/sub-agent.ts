import type { OSProvider } from "./providers/types.js";
import type { AgentConfig, SpiritTask } from "./types.js";
import { AgentLoop } from "./agent-loop.js";

export interface SubAgentResult {
  id: string;
  prompt: string;
  result: string;
  status: "completed" | "error";
  error?: string;
}

/**
 * SubAgentManager handles spawning and tracking child agent loops
 * that run concurrently for complex multi-step tasks.
 */
export class SubAgentManager {
  private provider: OSProvider;
  private config: AgentConfig;
  private agents = new Map<string, { loop: AgentLoop; promise: Promise<SubAgentResult> }>();
  private idCounter = 0;
  private onUpdate?: (agents: SubAgentResult[]) => void;
  private completedResults: SubAgentResult[] = [];

  constructor(provider: OSProvider, config: AgentConfig) {
    this.provider = provider;
    this.config = config;
  }

  setOnUpdate(callback: (agents: SubAgentResult[]) => void): void {
    this.onUpdate = callback;
  }

  /**
   * Spawn a new sub-agent that runs a prompt independently.
   * Returns immediately with the agent ID.
   */
  spawn(prompt: string, description?: string): string {
    const id = String(++this.idCounter);

    // Create a child agent loop with limited turns
    const childConfig: AgentConfig = {
      ...this.config,
      maxTurns: this.config.maxTurns ? Math.min(this.config.maxTurns, 20) : 20,
      // Don't forward UX callbacks from parent — child runs silently
      onText: undefined,
      onThinking: undefined,
      onToolStart: undefined,
      onToolEnd: undefined,
      onPermissionRequest: undefined,
      // Keep error and stats tracking
      onError: this.config.onError,
    };

    const loop = new AgentLoop(this.provider, childConfig);

    const promise = loop
      .run(prompt)
      .then((result) => {
        const agentResult: SubAgentResult = {
          id,
          prompt: description ?? prompt.slice(0, 80),
          result,
          status: "completed",
        };
        this.completedResults.push(agentResult);
        this.agents.delete(id);
        return agentResult;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const agentResult: SubAgentResult = {
          id,
          prompt: description ?? prompt.slice(0, 80),
          result: "",
          status: "error",
          error: message,
        };
        this.completedResults.push(agentResult);
        this.agents.delete(id);
        return agentResult;
      });

    this.agents.set(id, { loop, promise });
    return id;
  }

  /**
   * Wait for a specific sub-agent to complete.
   */
  async waitFor(id: string): Promise<SubAgentResult> {
    const agent = this.agents.get(id);
    if (agent) {
      return agent.promise;
    }
    // Already completed
    const completed = this.completedResults.find((r) => r.id === id);
    if (completed) return completed;
    throw new Error(`Sub-agent ${id} not found`);
  }

  /**
   * Wait for all running sub-agents to complete.
   */
  async waitAll(): Promise<SubAgentResult[]> {
    const promises = Array.from(this.agents.values()).map((a) => a.promise);
    const results = await Promise.allSettled(promises);
    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { id: "?", prompt: "", result: "", status: "error" as const, error: String(r.reason) }
    );
  }

  /**
   * Get status of all agents (running + completed).
   */
  getStatus(): { running: string[]; completed: SubAgentResult[] } {
    return {
      running: Array.from(this.agents.keys()),
      completed: [...this.completedResults],
    };
  }

  /**
   * Abort a running sub-agent.
   */
  abort(id: string): boolean {
    const agent = this.agents.get(id);
    if (agent) {
      agent.loop.abort();
      return true;
    }
    return false;
  }

  abortAll(): void {
    for (const agent of this.agents.values()) {
      agent.loop.abort();
    }
  }
}
