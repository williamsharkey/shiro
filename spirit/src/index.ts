export { SpiritAgent } from "./spirit.js";
export { AgentLoop } from "./agent-loop.js";
export { ApiClient } from "./api-client.js";
export { ToolRegistry } from "./tools/index.js";
export { buildSystemPrompt } from "./system-prompt.js";

export type { OSProvider, FileInfo, StatResult, ShellResult, HostInfo } from "./providers/types.js";
export type {
  AgentConfig,
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  CreateMessageParams,
  MessageResponse,
} from "./types.js";
