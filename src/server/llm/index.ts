import { createLogger } from "../../shared/logger.js";
import type { LLMProvider } from "./llmProvider.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAICompatibleProvider } from "./openaiProvider.js";

const log = createLogger("server:llm");

export type LLMProviderType = "anthropic" | "openai_compatible";

export interface LLMConfig {
  provider: LLMProviderType;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export function createLLMProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      log.info("Using Anthropic LLM provider", { model: config.model });
      return new AnthropicProvider(config.apiKey);

    case "openai_compatible":
      if (!config.baseUrl) {
        throw new Error("SOS_LLM_BASE_URL is required for openai_compatible provider");
      }
      log.info("Using OpenAI-compatible LLM provider", { model: config.model, baseUrl: config.baseUrl });
      return new OpenAICompatibleProvider(config.apiKey, config.baseUrl);

    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

export type { LLMProvider, LLMResponse, ChatMessage, ContentBlock, ToolDefinition, ToolCall } from "./llmProvider.js";
