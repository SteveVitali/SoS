import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../../shared/logger.js";
import type { ChatMessage, LLMProvider, LLMResponse, ToolDefinition } from "./llmProvider.js";

const log = createLogger("server:llm:anthropic");

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    log.info("Anthropic LLM provider initialized");
  }

  async chat(params: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    model: string;
  }): Promise<LLMResponse> {
    const anthropicTools: Anthropic.Tool[] = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    }));

    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools: anthropicTools,
      messages: params.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((block) => {
                if (block.type === "text") {
                  return { type: "text" as const, text: block.text };
                }
                return {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: block.mediaType as
                      | "image/png"
                      | "image/jpeg"
                      | "image/gif"
                      | "image/webp",
                    data: block.base64,
                  },
                };
              }),
      })),
    });

    let text = "";
    const toolCalls: LLMResponse["toolCalls"] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          name: block.name,
          // biome-ignore lint/suspicious/noExplicitAny: dynamic type
          input: (block.input as Record<string, any>) || {},
        });
      }
    }

    return { text, toolCalls };
  }
}
