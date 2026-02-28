export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic type
  input: Record<string, any>;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; base64: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface LLMProvider {
  chat(params: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    model: string;
  }): Promise<LLMResponse>;
}
