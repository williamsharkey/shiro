/**
 * LLM Provider abstraction - unified interface for Claude, GPT, Gemini
 */

export interface LLMContentBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  thinking?: string;
  // Tool use fields
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string | LLMContentBlock[];
}

export interface LLMToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LLMStreamedResponse {
  content: LLMContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "error";
  inputTokens: number;
  outputTokens: number;
}

export interface LLMCreateParams {
  system: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  max_tokens: number;
  thinkingBudget?: number;
}

export interface LLMStreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
}

export interface LLMProviderCapabilities {
  streaming: boolean;
  toolUse: boolean;
  thinking: boolean;
  vision: boolean;
}

/**
 * Authentication - API key only (works from any domain)
 */
export interface LLMAuthConfig {
  type: "api_key";
  apiKey: string;
}

/**
 * Abstract LLM Provider interface
 */
export interface LLMProvider {
  readonly name: string;
  readonly capabilities: LLMProviderCapabilities;
  model: string;
  readonly availableModels: string[];

  createMessageStream(
    params: LLMCreateParams,
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMStreamedResponse>;

  createMessage(
    params: LLMCreateParams,
    signal?: AbortSignal
  ): Promise<LLMStreamedResponse>;

  isAuthenticated(): boolean;
  getPricing(): { input: number; output: number } | null;
}

/**
 * Provider factory config
 */
export interface ProviderConfig {
  provider: "anthropic" | "openai" | "gemini";
  apiKey: string;
  model?: string;
  baseUrl?: string;
}
