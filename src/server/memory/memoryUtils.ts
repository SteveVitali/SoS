/**
 * Shared utility functions for the memory system.
 */

import type { MemoryNote } from "../../shared/memoryTypes.js";
import { getModelForRole } from "../../shared/modelConfig.js";
import { createResearchLLMClient, type LLMClient } from "../kb/research/llmClient.js";

/**
 * Convert LanceDB L2 distance to a 0-1 similarity score.
 * Lower distance = higher similarity. Formula: 1 / (1 + distance)
 */
export function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

/**
 * Create an LLM client configured for the memory model role.
 */
export function createMemoryLLMClient(): LLMClient {
  return createResearchLLMClient({
    model: getModelForRole("memory"),
  });
}

/**
 * Build the combined embedding text for a memory note from its components.
 */
export function buildEmbeddingText(content: string, context: string, keywords: string[]): string {
  return `${content} ${context} ${keywords.join(" ")}`;
}
