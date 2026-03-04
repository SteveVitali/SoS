/**
 * Lightweight LLM client for research pipeline reasoning calls.
 * Uses OpenAI-compatible chat completions API with JSON mode and tool-use support.
 */

import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../../shared/logger.js";
import { getModelForRole } from "../../../shared/modelConfig.js";
import type { LLMCallRecord, ResearchStage } from "../../../shared/researchTypes.js";

const log = createLogger("server:kb:research:llm");

// ─── Config ─────────────────────────────────────────────────────

export interface LLMClientConfig {
  model: string;
  api_key: string;
  base_url: string;
  temperature: number;
  max_tokens: number;
}

export function loadResearchLLMConfig(): LLMClientConfig {
  return {
    model: getModelForRole("research"),
    api_key: process.env.SOS_RESEARCH_LLM_API_KEY || process.env.OPENAI_API_KEY || "",
    base_url: process.env.SOS_RESEARCH_LLM_BASE_URL || "https://api.openai.com/v1",
    temperature: parseFloat(process.env.SOS_RESEARCH_LLM_TEMPERATURE || "0.0"),
    max_tokens: parseInt(process.env.SOS_RESEARCH_LLM_MAX_TOKENS || "2048", 10),
  };
}

// ─── Types ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  cost_usd?: number;
  tool_calls: ToolCall[];
}

// ─── Cost estimation ────────────────────────────────────────────

const COST_PER_1M: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4.0 },
  "claude-3-5-sonnet-latest": { input: 3.0, output: 15.0 },
  "bedrock/amazon.nova-micro-v1:0": { input: 0.035, output: 0.14 },
  "bedrock/amazon.nova-lite-v1:0": { input: 0.06, output: 0.24 },
  "bedrock/amazon.nova-pro-v1:0": { input: 0.8, output: 3.2 },
};

function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const pricing = COST_PER_1M[model];
  if (!pricing) return undefined;
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
}

// ─── Client ─────────────────────────────────────────────────────

export interface LLMClient {
  chat(
    messages: ChatMessage[],
    options?: { json_mode?: boolean; max_tokens?: number },
  ): Promise<LLMResponse>;

  chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: { max_tokens?: number },
  ): Promise<LLMResponse>;

  /** Build an LLMCallRecord from a response (for audit logging). */
  toAuditRecord(
    response: LLMResponse,
    stage: ResearchStage,
    purpose: string,
    inputPreview: string,
  ): LLMCallRecord;

  readonly config: LLMClientConfig;
}

export function createResearchLLMClient(overrides?: Partial<LLMClientConfig>): LLMClient {
  const cfg: LLMClientConfig = { ...loadResearchLLMConfig(), ...overrides };

  if (!cfg.api_key) {
    throw new Error(
      "Research LLM API key not configured. Set SOS_RESEARCH_LLM_API_KEY or OPENAI_API_KEY.",
    );
  }

  log.info("Research LLM client initialized", { model: cfg.model, base_url: cfg.base_url });

  async function doChat(
    messages: ChatMessage[],
    options?: {
      json_mode?: boolean;
      max_tokens?: number;
      tools?: ToolDefinition[];
    },
  ): Promise<LLMResponse> {
    const start = Date.now();

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: options?.max_tokens ?? cfg.max_tokens,
    };

    if (options?.json_mode) {
      body.response_format = { type: "json_object" };
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    const res = await fetch(`${cfg.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Research LLM API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content?: string;
          tool_calls?: ToolCall[];
        };
      }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    const content = choice?.message?.content || "";
    const toolCalls = choice?.message?.tool_calls || [];
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const duration_ms = Date.now() - start;

    log.info("Research LLM call complete", {
      model: data.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      duration_ms,
      has_tools: toolCalls.length > 0,
    });

    return {
      content,
      model: data.model || cfg.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      duration_ms,
      cost_usd: estimateCost(cfg.model, promptTokens, completionTokens),
      tool_calls: toolCalls,
    };
  }

  return {
    config: cfg,

    async chat(messages, options) {
      return doChat(messages, { json_mode: options?.json_mode, max_tokens: options?.max_tokens });
    },

    async chatWithTools(messages, tools, options) {
      return doChat(messages, { tools, max_tokens: options?.max_tokens });
    },

    toAuditRecord(response, stage, purpose, inputPreview): LLMCallRecord {
      return {
        call_id: uuidv4(),
        stage,
        purpose,
        model: response.model,
        prompt_tokens: response.prompt_tokens,
        completion_tokens: response.completion_tokens,
        cost_usd: response.cost_usd,
        duration_ms: response.duration_ms,
        input_preview: inputPreview.slice(0, 500),
        output_preview: response.content.slice(0, 500),
      };
    },
  };
}

// ─── Singleton ──────────────────────────────────────────────────

let cachedClient: LLMClient | null = null;

export function getResearchLLMClient(): LLMClient {
  if (!cachedClient) {
    cachedClient = createResearchLLMClient();
  }
  return cachedClient;
}

export function _resetResearchLLMClient(): void {
  cachedClient = null;
}
