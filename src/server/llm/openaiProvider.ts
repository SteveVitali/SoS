import OpenAI from "openai";
import { createLogger } from "../../shared/logger.js";
import type { ChatMessage, LLMProvider, LLMResponse, ToolDefinition } from "./llmProvider.js";

const log = createLogger("server:llm:openai");

export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    log.info("OpenAI-compatible LLM provider initialized", { baseURL });
  }

  async chat(params: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    model: string;
  }): Promise<LLMResponse> {
    const openaiTools: OpenAI.ChatCompletionTool[] = params.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object" as const,
          properties: t.parameters.properties,
          required: t.parameters.required,
        },
      },
    }));

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: params.system },
      ...params.messages.map((m): OpenAI.ChatCompletionMessageParam => {
        if (typeof m.content === "string") {
          if (m.role === "assistant") {
            return { role: "assistant", content: m.content };
          }
          return { role: "user", content: m.content };
        }
        // Multimodal content blocks — only valid for user messages
        const parts: OpenAI.ChatCompletionContentPart[] = m.content.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          return {
            type: "image_url" as const,
            image_url: { url: `data:${block.mediaType};base64,${block.base64}` },
          };
        });
        return { role: "user", content: parts };
      }),
    ];

    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      tools: openaiTools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const text = choice?.message?.content || "";
    const toolCalls: LLMResponse["toolCalls"] = [];

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type === "function") {
          try {
            toolCalls.push({
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || "{}"),
            });
          } catch {
            log.warn("Failed to parse tool call arguments", {
              name: tc.function.name,
              args: tc.function.arguments,
            });
          }
        }
      }
    }

    return { text, toolCalls };
  }
}
