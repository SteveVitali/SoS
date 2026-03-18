/**
 * Unified context assembler — main orchestrator for the unified knowledge layer.
 *
 * Searches both KB and Memory in parallel, optionally cross-ranks via LLM,
 * automatically escalates to deep retrieval when context is insufficient,
 * and produces a single optimized context string for prompt injection.
 *
 * This module lives in src/server/context/ and imports from both kb/ and memory/
 * — it never modifies their internals, only calls their public APIs.
 *
 * Flow:
 *   1. Fast parallel retrieval (KB + Memory + user profile)
 *   2. Gating: skip reranker if single-source or empty
 *   3. LLM reranker + sufficiency evaluation (1 LLM call)
 *   4. If insufficient: deep escalation via researchKnowledgeBases()
 *   5. Position-aware serialization within shared token budget
 */

import type { KBScope } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import type { MemoryConfig } from "../../shared/memoryTypes.js";
import { researchKnowledgeBases, searchKnowledgeBases } from "../kb/kbService.js";
import { buildUserContext } from "../memory/contextBuilder.js";
import { loadMemoryConfig } from "../memory/memoryConfig.js";
import { searchMemories } from "../memory/memorySearch.js";
import { loadContextConfig } from "./contextConfig.js";
import { normalizeKBResults, normalizeMemoryResults } from "./contextNormalizer.js";
import { rerankAndEvaluate, shouldRunReranker } from "./contextReranker.js";
import { serializeContext } from "./contextSerializer.js";
import type { AssembleContextParams, AssemblyResult, ContextItem } from "./contextTypes.js";

const log = createLogger("server:context:assembler");

// ─── Helpers ─────────────────────────────────────────────────

function isMemoryEnabled(): boolean {
  return (process.env.SOS_MEMORY_ENABLED ?? "true") === "true";
}

/**
 * Merge and interleave items from multiple sources by raw_score descending.
 * Used as fallback when reranker is skipped or fails.
 */
function interleaveByScore(items: ContextItem[]): ContextItem[] {
  return [...items].sort((a, b) => b.raw_score - a.raw_score);
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Assemble unified context from KB and Memory for prompt injection.
 *
 * This is the single entry point for all context assembly — used by both
 * the routing LLM (messageRouter.ts) and workers (via HTTP endpoint).
 */
export async function assembleContext(params: AssembleContextParams): Promise<AssemblyResult> {
  const start = Date.now();
  const config = loadContextConfig();
  const maxTokens = params.maxTokens ?? config.maxTokens;
  const allowDeep = params.allowDeepEscalation ?? config.deepEscalationEnabled;

  // ─── Step 1: Fast Parallel Retrieval ─────────────────────
  const memoryEnabled = isMemoryEnabled();
  let memoryConfig: MemoryConfig | undefined;
  if (memoryEnabled) {
    try {
      memoryConfig = loadMemoryConfig();
    } catch {
      // Memory config load failed — proceed without memory
    }
  }

  const [kbResults, memoryResults, userProfile] = await Promise.all([
    // KB search — always enabled
    searchKnowledgeBases({ query: params.query, scopes: params.scopes }).catch((err) => {
      log.warn("KB search failed in context assembly", { error: (err as Error).message });
      return [];
    }),

    // Memory search — only if enabled and configured
    memoryEnabled && memoryConfig
      ? searchMemories(params.query, params.owner, memoryConfig, {
          limit: config.maxCandidatesPerSource,
        }).catch((err) => {
          log.warn("Memory search failed in context assembly", { error: (err as Error).message });
          return [];
        })
      : Promise.resolve([]),

    // User profile — always fetched if memory enabled
    memoryEnabled ? buildUserContext(params.owner).catch(() => "") : Promise.resolve(""),
  ]);

  // ─── Step 2: Normalize ───────────────────────────────────
  const kbItems = normalizeKBResults(kbResults.slice(0, config.maxCandidatesPerSource));
  const memoryItems = normalizeMemoryResults(memoryResults);

  log.info("Context retrieval complete", {
    kb_results: kbItems.length,
    memory_results: memoryItems.length,
    has_profile: !!userProfile,
  });

  // If both sources are empty, return early with just the profile
  if (kbItems.length === 0 && memoryItems.length === 0) {
    return {
      context: "",
      profile: userProfile,
      was_deep: false,
      metadata: {
        kb_items_used: 0,
        memory_items_used: 0,
        reranker_called: false,
        deep_escalation: false,
        total_duration_ms: Date.now() - start,
      },
    };
  }

  // ─── Step 3: Gating + Reranker ───────────────────────────
  let allItems = [...kbItems, ...memoryItems];
  let rerankerCalled = false;
  let deepEscalation = false;

  if (shouldRunReranker(kbItems, memoryItems, config)) {
    // Both sources have results — run the LLM reranker + sufficiency evaluator
    const rerankerResult = await rerankAndEvaluate(params.query, allItems, config);
    rerankerCalled = true;
    allItems = rerankerResult.ranked_items;

    // ─── Step 4: Deep Escalation (if insufficient) ─────────
    if (
      allowDeep &&
      rerankerResult.sufficiency === "insufficient" &&
      rerankerResult.follow_up_queries &&
      rerankerResult.follow_up_queries.length > 0
    ) {
      log.info("Context insufficient, escalating to deep research", {
        follow_up_queries: rerankerResult.follow_up_queries,
        reasoning: rerankerResult.reasoning,
      });

      try {
        const deepResult = await researchKnowledgeBases({
          query: rerankerResult.follow_up_queries.join("; "),
          scopes: params.scopes,
          strategy: "deep",
          consumer: { type: "chat", id: `context-assembler:${params.owner}` },
        });

        deepEscalation = true;

        if (deepResult.chunks && deepResult.chunks.length > 0) {
          // Normalize and merge deep results with existing
          const deepItems = normalizeKBResults(deepResult.chunks);

          // Deduplicate by content similarity (simple prefix match)
          const existingContentPrefixes = new Set(
            allItems.map((item) => item.content.slice(0, 100)),
          );
          const newItems = deepItems.filter(
            (item) => !existingContentPrefixes.has(item.content.slice(0, 100)),
          );

          // Append new deep results after existing ranked items
          allItems = [...allItems, ...newItems];

          log.info("Deep escalation complete", {
            new_chunks: newItems.length,
            total_items: allItems.length,
            session_id: deepResult.session_id,
          });
        }
      } catch (err) {
        log.warn("Deep escalation failed, continuing with existing context", {
          error: (err as Error).message,
        });
      }
    }
  } else {
    // Single source or reranker disabled — sort by raw score
    allItems = interleaveByScore(allItems);
  }

  // ─── Step 5: Serialize ───────────────────────────────────
  const { context, kbItemsUsed, memoryItemsUsed } = serializeContext(allItems, maxTokens);

  const result: AssemblyResult = {
    context,
    profile: userProfile,
    was_deep: deepEscalation,
    metadata: {
      kb_items_used: kbItemsUsed,
      memory_items_used: memoryItemsUsed,
      reranker_called: rerankerCalled,
      deep_escalation: deepEscalation,
      total_duration_ms: Date.now() - start,
    },
  };

  log.info("Context assembly complete", {
    kb_items: kbItemsUsed,
    memory_items: memoryItemsUsed,
    reranker: rerankerCalled,
    deep: deepEscalation,
    duration_ms: result.metadata.total_duration_ms,
  });

  return result;
}
