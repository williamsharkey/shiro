/**
 * LLM Provider module - multi-provider support for Spirit
 *
 * Supports:
 * - Anthropic Claude (API key)
 * - OpenAI GPT (API key)
 * - Google Gemini (API key) - cheapest, has free tier
 *
 * All providers work from any domain (localhost, file://, any website)
 */

export * from "./types.js";
export { AnthropicProvider } from "./anthropic.js";
export { OpenAIProvider } from "./openai.js";
export { GeminiProvider } from "./gemini.js";

import type { LLMProvider, ProviderConfig, LLMAuthConfig } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";

/**
 * Create an LLM provider from config
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  const auth: LLMAuthConfig = { type: "api_key", apiKey: config.apiKey };

  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(auth, config.model, config.baseUrl);
    case "openai":
      return new OpenAIProvider(auth, config.model, config.baseUrl);
    case "gemini":
      return new GeminiProvider(auth, config.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Provider display names and info for UI
 */
export const PROVIDER_INFO = {
  anthropic: {
    name: "Claude (Anthropic)",
    defaultModel: "claude-sonnet-4-20250514",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    pricing: "~$3-15 per million tokens",
  },
  openai: {
    name: "GPT (OpenAI)",
    defaultModel: "gpt-4o",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    pricing: "~$2.50-10 per million tokens",
  },
  gemini: {
    name: "Gemini (Google)",
    defaultModel: "gemini-2.0-flash",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    pricing: "~$0.10 per million tokens (has free tier!)",
  },
} as const;
