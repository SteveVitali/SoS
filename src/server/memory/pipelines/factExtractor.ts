/**
 * Pipeline B: Fact Extraction (Mem0-style)
 *
 * Extracts facts from interaction episodes and curates them against
 * existing memories using ADD/UPDATE/DELETE/NOOP operations.
 *
 * Uses the batched extraction+curation prompt (§8.3) by default for efficiency.
 * See §6.2 of the memory design spec.
 */

import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../../shared/logger.js";
import type { InteractionEpisode, MemoryConfig, MemoryNote } from "../../../shared/memoryTypes.js";
import { getModelForRole } from "../../../shared/modelConfig.js";
import { getEmbeddingProvider } from "../../kb/embeddings.js";
import { createResearchLLMClient, type LLMClient } from "../../kb/research/llmClient.js";
import { findEpisode, listEpisodes, updateExtractionStatus } from "../episodeRepo.js";
import { addToMemoryFTS, deleteFromMemoryFTS } from "../memoryFtsStore.js";
import { findMemory, insertMemory, invalidateMemory, updateMemory } from "../memoryRepo.js";
import { addToMemoryTable, searchMemoryTable } from "../memoryVectorStore.js";
import {
  buildBatchedExtractionPrompt,
  formatMemoriesForPrompt,
  formatPriorEpisodes,
} from "../prompts.js";
import { evolveMemory } from "./memoryEvolver.js";

const log = createLogger("server:memory:factExtractor");

// ─── Extraction Filter ──────────────────────────────────────────

/** Actions considered purely mechanical (skip extraction unless signals detected) */
const MECHANICAL_ACTIONS = new Set(["job_status", "cancel_job", "retry_job", "list_jobs"]);

/** Actions considered information-rich (always extract) */
const INFORMATION_RICH_ACTIONS = new Set(["chat", "kb_search", "create_job", "plan_job", "github"]);

/**
 * Determine whether an episode should be processed for fact extraction.
 */
export function shouldExtract(episode: InteractionEpisode, config: MemoryConfig): boolean {
  // Skip if action is in the skip list
  if (config.extraction_skip_actions.includes(episode.routed_action)) {
    return false;
  }

  // Skip short messages
  if (episode.user_message.length < 10) {
    return false;
  }

  // Skip mechanical actions unless correction/gratitude signal detected
  if (MECHANICAL_ACTIONS.has(episode.routed_action)) {
    const hasRelevantSignal = episode.signals.some(
      (s) => s.signal_type === "correction" || s.signal_type === "gratitude",
    );
    if (!hasRelevantSignal) {
      return false;
    }
  }

  // Always extract from information-rich actions
  if (INFORMATION_RICH_ACTIONS.has(episode.routed_action)) {
    return true;
  }

  // Always extract if correction or gratitude signals detected
  const hasSignal = episode.signals.some(
    (s) => s.signal_type === "correction" || s.signal_type === "gratitude",
  );
  if (hasSignal) {
    return true;
  }

  // Default: extract
  return true;
}

// ─── LLM Response Types ─────────────────────────────────────────

export interface ExtractionOperation {
  content: string;
  importance: number;
  keywords: string[];
  tags: string[];
  operation: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  target_memory_id: string | null;
  updated_content: string | null;
  reason: string;
}

interface BatchedExtractionResponse {
  operations: ExtractionOperation[];
}

// ─── Main Extraction Function ───────────────────────────────────

/**
 * Create a memory LLM client for extraction calls.
 */
function createMemoryLLMClient(): LLMClient {
  return createResearchLLMClient({
    model: getModelForRole("memory"),
  });
}

/**
 * Build the embedding text for a memory note.
 */
function buildEmbeddingText(content: string, context: string, keywords: string[]): string {
  return `${content} ${context} ${keywords.join(" ")}`;
}

/**
 * Extract facts from an interaction episode and execute memory operations.
 */
export async function extractFactsFromEpisode(
  episodeId: string,
  config: MemoryConfig,
): Promise<{
  extracted: number;
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
}> {
  const result = { extracted: 0, added: 0, updated: 0, deleted: 0, skipped: 0 };

  // Fetch the episode
  const episode = await findEpisode(episodeId);
  if (!episode) {
    log.warn("Episode not found for extraction", { episodeId });
    return result;
  }

  // Check extraction filter
  if (!shouldExtract(episode, config)) {
    await updateExtractionStatus(episodeId, "skipped");
    log.debug("Episode skipped by extraction filter", {
      episodeId,
      action: episode.routed_action,
    });
    return result;
  }

  // Fetch up to 5 prior episodes in same conversation/thread for context
  const priorEpisodes = await fetchPriorEpisodes(episode, 5);

  // Fetch existing potentially-related memories via embedding search
  const existingMemories = await fetchRelatedMemories(episode, config);

  // Call LLM with batched extraction+curation prompt
  const operations = await callExtractionLLM(episode, priorEpisodes, existingMemories, config);

  if (!operations || operations.length === 0) {
    await updateExtractionStatus(episodeId, "extracted", []);
    return result;
  }

  result.extracted = operations.length;

  // Execute each operation
  const extractedMemoryIds: string[] = [];

  for (const op of operations) {
    try {
      switch (op.operation) {
        case "ADD": {
          const memoryId = await executeAdd(op, episode, config);
          if (memoryId) {
            extractedMemoryIds.push(memoryId);
            result.added++;
            // Fire-and-forget evolution
            evolveMemory(memoryId, config).catch((err) => {
              log.warn("Memory evolution failed after ADD", {
                memoryId,
                error: (err as Error).message,
              });
            });
          }
          break;
        }
        case "UPDATE": {
          const memoryId = await executeUpdate(op, episode, config);
          if (memoryId) {
            extractedMemoryIds.push(memoryId);
            result.updated++;
            // Fire-and-forget evolution
            evolveMemory(memoryId, config).catch((err) => {
              log.warn("Memory evolution failed after UPDATE", {
                memoryId,
                error: (err as Error).message,
              });
            });
          }
          break;
        }
        case "DELETE": {
          const deleted = await executeDelete(op);
          if (deleted) result.deleted++;
          break;
        }
        case "NOOP":
          result.skipped++;
          break;
        default:
          log.warn("Unknown extraction operation", { operation: op.operation });
          result.skipped++;
      }
    } catch (err) {
      log.warn("Failed to execute extraction operation", {
        operation: op.operation,
        error: (err as Error).message,
      });
      result.skipped++;
    }
  }

  // Update episode status
  await updateExtractionStatus(episodeId, "extracted", extractedMemoryIds);

  log.info("Fact extraction complete", {
    episodeId,
    owner: episode.owner,
    ...result,
  });

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Fetch prior episodes in the same conversation/thread for context.
 */
async function fetchPriorEpisodes(
  episode: InteractionEpisode,
  maxCount: number,
): Promise<InteractionEpisode[]> {
  // Build a filter to find episodes in the same thread/conversation
  const { episodes } = await listEpisodes({
    owner: episode.owner,
    limit: maxCount + 1, // +1 to account for the current episode
  });

  // Filter to same conversation context and before current episode
  return episodes
    .filter((ep) => {
      if (ep.episode_id === episode.episode_id) return false;
      if (ep.timestamp >= episode.timestamp) return false;

      // Match by thread/conversation context
      if (episode.source_ref.thread_ts && ep.source_ref.thread_ts) {
        return ep.source_ref.thread_ts === episode.source_ref.thread_ts;
      }
      if (episode.source_ref.conversation_id && ep.source_ref.conversation_id) {
        return ep.source_ref.conversation_id === episode.source_ref.conversation_id;
      }
      if (episode.source_ref.channel_id && ep.source_ref.channel_id) {
        return ep.source_ref.channel_id === episode.source_ref.channel_id;
      }

      return false;
    })
    .slice(0, maxCount);
}

/**
 * Fetch existing memories that might be related to this episode.
 */
async function fetchRelatedMemories(
  episode: InteractionEpisode,
  config: MemoryConfig,
): Promise<MemoryNote[]> {
  const embeddingProvider = getEmbeddingProvider();

  let queryVector: number[];
  try {
    [queryVector] = await embeddingProvider.embed([episode.user_message]);
  } catch (err) {
    log.warn("Failed to embed episode for memory search", {
      error: (err as Error).message,
    });
    return [];
  }

  const vectorResults = await searchMemoryTable(episode.owner, queryVector, 5);

  // Fetch full documents for top results with similarity > 0.5
  const memories: MemoryNote[] = [];
  for (const r of vectorResults) {
    const similarity = 1 / (1 + r._distance);
    if (similarity < 0.5) continue;

    const memory = await findMemory(r.id);
    if (memory && !memory.invalidated_at) {
      memories.push(memory);
    }
  }

  return memories;
}

/**
 * Call the LLM with the batched extraction+curation prompt.
 */
async function callExtractionLLM(
  episode: InteractionEpisode,
  priorEpisodes: InteractionEpisode[],
  existingMemories: MemoryNote[],
  config: MemoryConfig,
): Promise<ExtractionOperation[]> {
  const llm = createMemoryLLMClient();

  const priorContext = priorEpisodes.length > 0 ? formatPriorEpisodes(priorEpisodes) : undefined;

  const prompt = buildBatchedExtractionPrompt({
    user_message: episode.user_message,
    routed_action: episode.routed_action,
    response_summary: episode.response_summary,
    prior_context: priorContext,
    existing_memories: formatMemoriesForPrompt(existingMemories),
    max_facts: config.extraction_max_facts_per_call,
  });

  try {
    const response = await llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "Extract and curate memories from this interaction." },
      ],
      { json_mode: true },
    );

    const parsed = JSON.parse(response.content) as BatchedExtractionResponse;
    if (!parsed.operations || !Array.isArray(parsed.operations)) {
      log.warn("Invalid extraction response format", {
        content: response.content.slice(0, 200),
      });
      return [];
    }

    return parsed.operations;
  } catch (err) {
    log.warn("Extraction LLM call failed", { error: (err as Error).message });
    return [];
  }
}

/**
 * Execute an ADD operation — create a new MemoryNote.
 */
async function executeAdd(
  op: ExtractionOperation,
  episode: InteractionEpisode,
  config: MemoryConfig,
): Promise<string | null> {
  const memoryId = uuidv4();
  const now = new Date();
  const context = `Extracted from ${episode.source} interaction (${episode.routed_action})`;
  const embeddingText = buildEmbeddingText(op.content, context, op.keywords);

  const memory: MemoryNote = {
    memory_id: memoryId,
    owner: episode.owner,
    memory_type: "fact",
    content: op.content,
    context,
    keywords: op.keywords,
    tags: op.tags,
    source_episodes: [episode.episode_id],
    source_type: episode.source,
    created_at: now,
    updated_at: now,
    valid_from: now,
    linked_memory_ids: [],
    link_reasons: [],
    access_count: 0,
    importance: op.importance,
    confidence: 0.8,
    embedding_text: embeddingText,
  };

  await insertMemory(memory);

  // Embed and store in vector + FTS
  try {
    const embeddingProvider = getEmbeddingProvider();
    const [vector] = await embeddingProvider.embed([embeddingText]);

    await addToMemoryTable(episode.owner, [
      {
        id: memoryId,
        owner: episode.owner,
        content: embeddingText,
        memory_type: "fact",
        vector,
        tags: JSON.stringify(op.tags),
        importance: op.importance,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ]);

    addToMemoryFTS(episode.owner, [
      {
        memory_id: memoryId,
        owner: episode.owner,
        content: embeddingText,
        keywords: op.keywords.join(" "),
        tags: op.tags.join(" "),
        memory_type: "fact",
      },
    ]);
  } catch (err) {
    log.warn("Failed to embed/index new memory", {
      memoryId,
      error: (err as Error).message,
    });
  }

  log.info("Memory added", { memoryId, content: op.content.slice(0, 100) });
  return memoryId;
}

/**
 * Execute an UPDATE operation — modify an existing MemoryNote.
 */
async function executeUpdate(
  op: ExtractionOperation,
  episode: InteractionEpisode,
  config: MemoryConfig,
): Promise<string | null> {
  if (!op.target_memory_id) {
    log.warn("UPDATE operation missing target_memory_id");
    return null;
  }

  const existing = await findMemory(op.target_memory_id);
  if (!existing) {
    log.warn("UPDATE target memory not found", { targetId: op.target_memory_id });
    return null;
  }

  const updatedContent = op.updated_content ?? op.content;
  const updatedKeywords = op.keywords.length > 0 ? op.keywords : existing.keywords;
  const updatedTags = op.tags.length > 0 ? op.tags : existing.tags;
  const embeddingText = buildEmbeddingText(updatedContent, existing.context, updatedKeywords);

  // Add this episode to source_episodes if not already there
  const sourceEpisodes = existing.source_episodes.includes(episode.episode_id)
    ? existing.source_episodes
    : [...existing.source_episodes, episode.episode_id];

  await updateMemory(op.target_memory_id, {
    content: updatedContent,
    keywords: updatedKeywords,
    tags: updatedTags,
    importance: Math.max(existing.importance, op.importance),
    embedding_text: embeddingText,
  });

  // Re-embed and re-index
  try {
    const embeddingProvider = getEmbeddingProvider();
    const [vector] = await embeddingProvider.embed([embeddingText]);

    await addToMemoryTable(existing.owner, [
      {
        id: op.target_memory_id,
        owner: existing.owner,
        content: embeddingText,
        memory_type: existing.memory_type,
        vector,
        tags: JSON.stringify(updatedTags),
        importance: Math.max(existing.importance, op.importance),
        created_at: existing.created_at.toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    deleteFromMemoryFTS(existing.owner, op.target_memory_id);
    addToMemoryFTS(existing.owner, [
      {
        memory_id: op.target_memory_id,
        owner: existing.owner,
        content: embeddingText,
        keywords: updatedKeywords.join(" "),
        tags: updatedTags.join(" "),
        memory_type: existing.memory_type,
      },
    ]);
  } catch (err) {
    log.warn("Failed to re-embed/re-index updated memory", {
      memoryId: op.target_memory_id,
      error: (err as Error).message,
    });
  }

  log.info("Memory updated", {
    memoryId: op.target_memory_id,
    content: updatedContent.slice(0, 100),
  });
  return op.target_memory_id;
}

/**
 * Execute a DELETE operation — invalidate an existing MemoryNote.
 */
async function executeDelete(op: ExtractionOperation): Promise<boolean> {
  if (!op.target_memory_id) {
    log.warn("DELETE operation missing target_memory_id");
    return false;
  }

  const result = await invalidateMemory(op.target_memory_id);
  if (!result) {
    log.warn("DELETE target memory not found", { targetId: op.target_memory_id });
    return false;
  }

  log.info("Memory invalidated", {
    memoryId: op.target_memory_id,
    reason: op.reason,
  });
  return true;
}
