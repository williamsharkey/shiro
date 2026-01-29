export { SpiritAgent } from "./spirit.js";
export { AgentLoop } from "./agent-loop.js";
export type { ToolExecutor } from "./agent-loop.js";
export { ApiClient } from "./api-client.js";
export { ToolRegistry } from "./tools/index.js";
export { buildSystemPrompt } from "./system-prompt.js";
export { browserTools } from "./browser-tools.js";
export { SubAgentManager } from "./sub-agent.js";
export type { SubAgentResult } from "./sub-agent.js";
export { ShiroProvider } from "./providers/shiro-provider.js";
export { FoamProvider } from "./providers/foam-provider.js";

export type { OSProvider, FileInfo, StatResult, ShellResult, HostInfo } from "./providers/types.js";
export type { SpiritCommand } from "./command.js";
export type {
  AgentConfig,
  Message,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  CreateMessageParams,
  MessageResponse,
  StreamEvent,
  SpiritStats,
  SpiritTask,
  PermissionRequest,
} from "./types.js";
