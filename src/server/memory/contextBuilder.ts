/**
 * Context builder for memory system — builds {MEMORY_CONTEXT} and {USER_CONTEXT}
 * strings for injection into the system prompt.
 *
 * See §7.2 of the memory design spec.
 */

import { createLogger } from "../../shared/logger.js";
import type { MemoryConfig, MemoryNote, MemorySearchResult } from "../../shared/memoryTypes.js";
import { listMemories } from "./memoryRepo.js";
import { searchMemories } from "./memorySearch.js";

const log = createLogger("server:memory:contextBuilder");

/**
 * Rough token estimate — ~4 chars per token on average for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format a single memory result as a labeled list item.
 * Example: "- [fact, learned Mar 15] The user prefers TypeScript strict mode"
 */
function formatMemoryLine(result: MemorySearchResult): string {
  const { memory } = result;
  const dateStr = memory.updated_at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  if (memory.memory_type === "reflection") {
    const episodeCount = memory.source_episodes.length;
    return `- [reflection, from ${episodeCount} interaction${episodeCount !== 1 ? "s" : ""}] ${memory.content}`;
  }

  return `- [${memory.memory_type}, learned ${dateStr}] ${memory.content}`;
}

/**
 * Build the {MEMORY_CONTEXT} string by searching memories relevant to the user message.
 *
 * 1. Call searchMemories()
 * 2. Format as labeled list with type and date
 * 3. Truncate to retrieval_max_tokens
 */
export async function buildMemoryContext(
  userMessage: string,
  owner: string,
  config: MemoryConfig,
): Promise<string> {
  if (!config.enabled) return "";

  try {
    const results = await searchMemories(userMessage, owner, config);

    if (results.length === 0) return "";

    const lines: string[] = [];
    let totalTokens = 0;

    for (const result of results) {
      const line = formatMemoryLine(result);
      const lineTokens = estimateTokens(line);

      if (totalTokens + lineTokens > config.retrieval_max_tokens) {
        break;
      }

      lines.push(line);
      totalTokens += lineTokens;
    }

    if (lines.length === 0) return "";

    const context = lines.join("\n");
    log.debug("Memory context built", {
      owner,
      memories: lines.length,
      tokens: totalTokens,
    });

    return context;
  } catch (err) {
    log.warn("Failed to build memory context", { error: (err as Error).message });
    return "";
  }
}

/**
 * Build the {USER_CONTEXT} string by fetching the user_profile memory note.
 *
 * 1. Direct MongoDB lookup for user_profile memory note
 * 2. Format as the profile content string
 * 3. Return empty string if no profile exists
 */
export async function buildUserContext(owner: string): Promise<string> {
  try {
    const { memories } = await listMemories({
      owner,
      memory_type: "user_profile",
      include_invalidated: false,
      limit: 1,
    });

    if (memories.length === 0) return "";

    const profile = memories[0];
    log.debug("User context built", { owner, profileId: profile.memory_id });
    return profile.content;
  } catch (err) {
    log.warn("Failed to build user context", { error: (err as Error).message });
    return "";
  }
}
