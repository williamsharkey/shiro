// Anthropic Messages API types (minimal subset needed for Spirit)

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[] | ToolResultBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CreateMessageParams {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  max_tokens: number;
}

export interface MessageResponse {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage: { input_tokens: number; output_tokens: number };
}

// Streaming SSE event types

export interface StreamEventMessageStart {
  type: "message_start";
  message: { id: string; usage: { input_tokens: number } };
}

export interface StreamEventContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "thinking"; thinking: string };
}

export interface StreamEventContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string };
}

export interface StreamEventContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface StreamEventMessageDelta {
  type: "message_delta";
  delta: { stop_reason: "end_turn" | "tool_use" | "max_tokens" };
  usage: { output_tokens: number };
}

export interface StreamEventMessageStop {
  type: "message_stop";
}

export interface StreamEventError {
  type: "error";
  error: { type: string; message: string };
}

export type StreamEvent =
  | StreamEventMessageStart
  | StreamEventContentBlockStart
  | StreamEventContentBlockDelta
  | StreamEventContentBlockStop
  | StreamEventMessageDelta
  | StreamEventMessageStop
  | StreamEventError;

// Stats

export interface SpiritStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  toolCalls: number;
  elapsedMs: number;
}

// Task tracking

export interface SpiritTask {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  description?: string;
}

// Permission request for dangerous operations
export interface PermissionRequest {
  tool: string;
  description: string;
  input: Record<string, unknown>;
}

// Agent config

export interface AgentConfig {
  apiKey: string;
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  systemPrompt?: string;

  // UX callbacks — Claude Code style
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
  onError?: (error: Error) => void;
  onStats?: (stats: SpiritStats) => void;
  onTaskUpdate?: (tasks: SpiritTask[]) => void;

  // Permission system: return true to allow, false to deny
  // If not set, all operations are auto-approved
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>;

  // Extended thinking budget (0 = disabled)
  thinkingBudget?: number;

  // Per-tool execution timeout in ms (default 30000)
  toolTimeoutMs?: number;
}
