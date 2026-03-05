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

export interface ImageGenerationParams {
  model: string;
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
}

export interface GeneratedImage {
  base64: string;
  mediaType: string;
  revisedPrompt?: string;
}

export interface LLMProvider {
  chat(params: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    model: string;
  }): Promise<LLMResponse>;
  generateImage?(params: ImageGenerationParams): Promise<GeneratedImage[]>;
}
