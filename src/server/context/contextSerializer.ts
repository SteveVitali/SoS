/**
 * Position-aware context serializer for the unified context layer.
 *
 * Converts a ranked list of ContextItem[] into a formatted string for
 * injection into the LLM system prompt, respecting a shared token budget.
 *
 * Research basis:
 * - "Lost in the Middle" (Liu et al., TACL 2024): positional bias in LLM attention.
 *   Modern models have improved, so we trust the reranker's ordering rather than
 *   applying a rigid positional template.
 * - The one exception: user profile is always the preamble (identity context).
 */

import { createLogger } from "../../shared/logger.js";
import type { ContextItem } from "./contextTypes.js";

const log = createLogger("server:context:serializer");

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from character length (~4 chars/token for English text).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Format a single ContextItem as a labeled block for prompt injection.
 */
function formatItem(item: ContextItem): string {
  if (item.source === "memory") {
    const tag = item.metadata.temporal_tag || item.metadata.memory_type || "memory";
    return `[${tag}] ${item.content}`;
  }

  // KB item
  const tag = item.metadata.temporal_tag || item.metadata.kb_name || "knowledge base";
  const score = item.raw_score > 0 ? ` (score: ${item.raw_score.toFixed(2)})` : "";
  return `[${tag}]${score}\n${item.content}`;
}

/**
 * Serialize ranked context items into a formatted string within a token budget.
 *
 * Items are serialized in the order provided (typically the reranker's optimal
 * ordering). Each item gets a lightweight source tag for provenance.
 *
 * @param items - Ranked ContextItem[] (reranker-ordered or raw-score-ordered)
 * @param maxTokens - Shared token budget for the entire context string
 * @returns Formatted context string
 */
export function serializeContext(
  items: ContextItem[],
  maxTokens: number,
): {
  context: string;
  itemsUsed: number;
  kbItemsUsed: number;
  memoryItemsUsed: number;
  tokensUsed: number;
} {
  if (items.length === 0) {
    return { context: "", itemsUsed: 0, kbItemsUsed: 0, memoryItemsUsed: 0, tokensUsed: 0 };
  }

  const blocks: string[] = [];
  let totalTokens = 0;
  let kbCount = 0;
  let memoryCount = 0;

  for (const item of items) {
    const formatted = formatItem(item);
    const blockTokens = estimateTokens(formatted);

    if (totalTokens + blockTokens > maxTokens) {
      // Budget exhausted — stop adding items
      break;
    }

    blocks.push(formatted);
    totalTokens += blockTokens;

    if (item.source === "kb") kbCount++;
    else memoryCount++;
  }

  const context = blocks.join("\n\n");

  log.debug("Context serialized", {
    items_total: items.length,
    items_used: blocks.length,
    kb_used: kbCount,
    memory_used: memoryCount,
    tokens: totalTokens,
    max_tokens: maxTokens,
  });

  return {
    context,
    itemsUsed: blocks.length,
    kbItemsUsed: kbCount,
    memoryItemsUsed: memoryCount,
    tokensUsed: totalTokens,
  };
}
