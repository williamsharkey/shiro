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

export type ContentBlock = TextBlock | ToolUseBlock;

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
  content_block: { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
}

export interface StreamEventContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
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

export type StreamEvent =
  | StreamEventMessageStart
  | StreamEventContentBlockStart
  | StreamEventContentBlockDelta
  | StreamEventContentBlockStop
  | StreamEventMessageDelta
  | StreamEventMessageStop;

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

// Agent config

export interface AgentConfig {
  apiKey: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
  onText?: (text: string) => void;
  onError?: (error: Error) => void;
  onStats?: (stats: SpiritStats) => void;
  onTaskUpdate?: (tasks: SpiritTask[]) => void;
}
