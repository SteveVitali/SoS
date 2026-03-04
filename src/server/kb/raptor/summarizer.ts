/**
 * LLM-based cluster summarization for RAPTOR tree construction.
 * Takes a cluster of semantically similar chunks and produces a coherent summary.
 */

import { createLogger } from "../../../shared/logger.js";
import type { LLMClient } from "../research/llmClient.js";

const log = createLogger("server:kb:raptor:summarizer");

const SUMMARIZE_PROMPT = `You are a technical documentation summarizer. Summarize the following related passages into a single coherent paragraph that captures ALL key information, concepts, and details.

Rules:
- Preserve specific technical details, names, values, and relationships
- Do not add information not present in the passages
- Write in a neutral, documentation-style tone
- The summary should be self-contained and understandable without the original passages
- Keep the summary concise but comprehensive (1-3 paragraphs)`;

const CHARS_PER_TOKEN = 4;

export interface SummarizeOptions {
  maxInputTokens: number;
}

/**
 * Summarize a cluster of text chunks using an LLM.
 */
export async function summarizeCluster(
  chunks: Array<{ id: string; content: string }>,
  llm: LLMClient,
  options: SummarizeOptions,
): Promise<string> {
  // Concatenate chunk contents, truncating to fit context window
  const maxChars = options.maxInputTokens * CHARS_PER_TOKEN;
  let combined = "";
  for (let i = 0; i < chunks.length; i++) {
    const entry = `--- Passage ${i + 1} ---\n${chunks[i].content}\n\n`;
    if (combined.length + entry.length > maxChars) {
      // Truncate remaining
      const remaining = maxChars - combined.length;
      if (remaining > 100) {
        combined += `${entry.slice(0, remaining)}\n[truncated]\n`;
      }
      break;
    }
    combined += entry;
  }

  if (!combined.trim()) {
    return "";
  }

  try {
    const response = await llm.chat(
      [
        { role: "system", content: SUMMARIZE_PROMPT },
        { role: "user", content: combined },
      ],
      { max_tokens: 1024 },
    );

    log.info("Cluster summarized", {
      input_chunks: chunks.length,
      input_chars: combined.length,
      output_chars: response.content.length,
      tokens_used: response.prompt_tokens + response.completion_tokens,
    });

    return response.content.trim();
  } catch (err) {
    log.error("Cluster summarization failed", {
      chunks: chunks.length,
      error: (err as Error).message,
    });
    // Fallback: concatenate first few chunks
    return chunks
      .slice(0, 3)
      .map((c) => c.content.slice(0, 200))
      .join("\n\n");
  }
}
