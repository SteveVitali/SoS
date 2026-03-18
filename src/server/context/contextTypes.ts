/**
 * Type definitions for the unified context assembly layer.
 *
 * The context module unifies Knowledge Base (static documents) and Memory
 * (learned facts/reflections) into a single ranked context stream for
 * injection into LLM prompts.
 */

import type { KBScope } from "../../shared/kbTypes.js";

// ─── Core Types ──────────────────────────────────────────────

/** A normalized item from either KB or Memory, ready for cross-source ranking. */
export interface ContextItem {
  id: string;
  content: string;
  source: "kb" | "memory";
  /** Score from originating system, normalized 0-1. */
  raw_score: number;
  metadata: {
    // KB-specific
    kb_name?: string;
    kb_id?: string;
    source_file?: string;
    section?: string;
    file_path?: string;
    parent_dir?: string;
    rrf_score?: number;
    retrieval_source?: "vector" | "keyword" | "both";
    // Memory-specific
    memory_type?: "fact" | "reflection" | "user_profile";
    memory_id?: string;
    importance?: number;
    recency_score?: number;
    access_count?: number;
    // Common
    temporal_tag?: string;
  };
}

/** Sufficiency assessment from the reranker. */
export type Sufficiency = "sufficient" | "insufficient" | "not_knowledge_query";

/** Result from the LLM listwise reranker + sufficiency evaluator. */
export interface RerankerResult {
  ranked_items: ContextItem[];
  dropped_items: ContextItem[];
  sufficiency: Sufficiency;
  follow_up_queries: string[] | null;
  reasoning: string;
}

/** Final result from the context assembler. */
export interface AssemblyResult {
  /** Unified context string for prompt injection. */
  context: string;
  /** User profile string (always-included preamble). */
  profile: string;
  /** Whether deep escalation was triggered. */
  was_deep: boolean;
  metadata: {
    kb_items_used: number;
    memory_items_used: number;
    reranker_called: boolean;
    deep_escalation: boolean;
    total_duration_ms: number;
  };
}

/** Parameters for the context assembler. */
export interface AssembleContextParams {
  query: string;
  owner: string;
  scopes: KBScope[];
  /** Shared token budget for the final context string. Default: 3500. */
  maxTokens?: number;
  /** Whether to allow automatic escalation to deep research. Default: true. */
  allowDeepEscalation?: boolean;
}
