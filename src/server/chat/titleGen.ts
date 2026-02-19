import { createLogger } from "../../shared/logger.js";
import type { LLMProvider } from "../llm/index.js";
import { setTitle } from "./conversationRepo.js";

const log = createLogger("server:chat:titleGen");

let provider: LLMProvider | null = null;
let configuredModel = "claude-sonnet-4-20250514";

export function initChatTitleGenerator(llmProvider: LLMProvider, model: string) {
  provider = llmProvider;
  configuredModel = model;
}

const SYSTEM_PROMPT = `You generate very short titles for chat conversations. Given the user's first message, produce a concise title (max 8 words) that captures what the conversation is about. Do NOT include quotes. Output ONLY the title.`;

export async function generateConversationTitle(
  conversationId: string,
  firstMessage: string,
): Promise<void> {
  if (!provider) {
    // Fallback: use first ~40 chars of message
    const fallback = firstMessage.slice(0, 40).trim() + (firstMessage.length > 40 ? "…" : "");
    await setTitle(conversationId, fallback);
    return;
  }

  try {
    const response = await provider.chat({
      model: configuredModel,
      maxTokens: 60,
      system: SYSTEM_PROMPT,
      tools: [],
      messages: [{ role: "user", content: firstMessage.slice(0, 2000) }],
    });

    const title = response.text.trim().slice(0, 120);
    if (title) {
      await setTitle(conversationId, title);
      log.info("Chat title generated", { conversation_id: conversationId, title });
    }
  } catch (err: any) {
    log.warn("Failed to generate chat title", {
      conversation_id: conversationId,
      error: err.message,
    });
    // Fallback
    const fallback = firstMessage.slice(0, 40).trim() + (firstMessage.length > 40 ? "…" : "");
    await setTitle(conversationId, fallback).catch(() => {});
  }
}
