/**
 * Shared state and types for LangGraph-based execution graphs.
 *
 * Each graph operates on a GraphState that flows through nodes.
 * The state is a superset — individual graphs use what they need.
 */

import type { KBScope, KBSearchResult } from "../../../shared/kbTypes.js";

// --- Graph State ---

export interface RAGGraphState {
  /** The original user query / message */
  query: string;

  /** The current search query (may be reformulated) */
  search_query: string;

  /** KB scopes to search within */
  scopes: KBScope[];

  /** Retrieved chunks from knowledge bases */
  retrieved_chunks: KBSearchResult[];

  /** Number of retrieval iterations completed */
  retrieval_count: number;

  /** Maximum retrieval iterations before forcing an answer */
  max_retrievals: number;

  /** The LLM's relevance grade for the current retrieved set */
  relevance_grade: "sufficient" | "insufficient" | "empty";

  /** The final synthesized answer (populated by the answer node) */
  answer: string;

  /** Optional trace of reasoning steps for observability */
  reasoning_trace: string[];
}

// --- Graph Execution Config (from YAML) ---

export interface RAGGraphConfig {
  /** KB scopes to search (overrides action-level KB config) */
  scopes?: KBScope[];

  /** Max retrieval iterations before forcing answer */
  max_retrievals?: number;

  /** Max chunks per retrieval pass */
  max_chunks?: number;

  /** Minimum similarity score */
  min_score?: number;

  /** LLM model to use for grading + answering */
  model?: string;

  /** Max tokens for the final answer */
  max_answer_tokens?: number;

  /** Whether to append a trace summary footer to the reply (default: true) */
  show_trace?: boolean;

  /** Total timeout in ms for the entire graph execution (default: Infinity) */
  timeout_ms?: number;
}

// --- Graph Result ---

export interface GraphResult {
  /** The final answer text to send back as a reply */
  reply: string;

  /** Action description for logging */
  actionTaken: string;

  /** Full reasoning trace for observability */
  trace: string[];

  /** How many retrieval rounds occurred */
  retrievalRounds: number;
}
