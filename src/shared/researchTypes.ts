/**
 * Shared types for the Advanced RAG Research Pipeline.
 * Used by server, worker, and UI.
 */

import type { KBScope, KBSearchResult } from "./kbTypes.js";

// ─── Strategy ───────────────────────────────────────────────────

export type ResearchStrategy = "simple" | "deep" | "agent";

export interface ResearchConfig {
  strategy: ResearchStrategy;

  // LLM model override (if unset, uses env default)
  model?: string;

  // Budget caps
  max_iterations: number;
  max_llm_calls: number;
  max_retrieval_calls: number;
  max_wall_time_ms: number;

  // Stage toggles
  enable_decomposition: boolean;
  enable_hyde: boolean;
  enable_step_back: boolean;
  enable_crag: boolean;
  enable_ircot: boolean;

  // Retrieval params
  max_chunks_per_query: number;
  min_similarity_score: number;
  dedup_threshold: number;

  // Synthesis
  skip_llm_synthesis: boolean;
}

// ─── Session & Steps ────────────────────────────────────────────

export interface ResearchSession {
  session_id: string;
  original_query: string;
  scopes: KBScope[];
  config: ResearchConfig;
  steps: ResearchStep[];
  status: ResearchSessionStatus;
  consumer?: ResearchConsumer;
  created_at: Date;
  completed_at?: Date;
}

export type ResearchSessionStatus = "running" | "completed" | "failed" | "budget_exhausted";

export interface ResearchConsumer {
  type: "worker_job" | "chat" | "playground" | "api";
  id?: string;
}

export type ResearchStage =
  | "query_analysis"
  | "query_expansion"
  | "retrieval"
  | "evaluation"
  | "reasoning"
  | "synthesis";

export interface ResearchStep {
  step_id: string;
  stage: ResearchStage;
  iteration: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  duration_ms: number;
  llm_calls: LLMCallRecord[];
  retrieval_calls: RetrievalRecord[];
}

// ─── LLM Call Tracking ──────────────────────────────────────────

export interface LLMCallRecord {
  call_id: string;
  stage: ResearchStage;
  purpose: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd?: number;
  duration_ms: number;
  input_preview: string;
  output_preview: string;
}

// ─── Retrieval Tracking ─────────────────────────────────────────

export type QueryType = "original" | "decomposed" | "hyde" | "step_back" | "follow_up";

export interface RetrievalRecord {
  call_id: string;
  query_text: string;
  query_type: QueryType;
  kb_ids_searched: string[];
  results_count: number;
  top_score: number;
  duration_ms: number;
}

// ─── Stage I/O Types ────────────────────────────────────────────

export interface QueryAnalysis {
  complexity: "simple" | "compound" | "multi_hop";
  sub_queries: string[];
  step_back_query?: string;
  recommended_strategy?: ResearchStrategy;
}

export interface ExpandedQuery {
  text: string;
  vector: number[];
  type: QueryType;
  source_query?: string;
}

export type ChunkRelevance = "correct" | "incorrect" | "ambiguous";

export interface ChunkEvaluation {
  chunk: KBSearchResult;
  relevance: ChunkRelevance;
  score: number;
  reasoning: string;
}

export interface EvaluationResult {
  evaluations: ChunkEvaluation[];
  needs_requery: boolean;
  reformulated_queries: string[];
  correct_count: number;
  incorrect_count: number;
  ambiguous_count: number;
}

export interface ReasoningResult {
  reasoning_text: string;
  is_sufficient: boolean;
  follow_up_queries: string[];
  missing_info: string[];
}

// ─── Final Result ───────────────────────────────────────────────

export interface ResearchResult {
  session_id: string;
  strategy: ResearchStrategy;
  original_query: string;

  context: string;
  chunks: KBSearchResult[];
  reasoning_trace: string;

  metrics: ResearchMetrics;
  audit: ResearchSession;
}

export interface ResearchMetrics {
  total_duration_ms: number;
  iterations: number;
  llm_calls: number;
  retrieval_calls: number;
  chunks_retrieved: number;
  chunks_used: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
}

// ─── Streaming Events (NDJSON) ──────────────────────────────────

export type ResearchStreamEvent =
  | { type: "session_start"; session_id: string; strategy: ResearchStrategy }
  | { type: "step_start"; stage: ResearchStage; iteration: number }
  | { type: "llm_call"; purpose: string; duration_ms: number; model: string }
  | { type: "retrieval"; kb: string; results: number; top_score: number }
  | {
      type: "step_complete";
      stage: ResearchStage;
      duration_ms: number;
      details?: Record<string, unknown>;
    }
  | {
      type: "session_complete";
      session_id: string;
      total_ms: number;
      llm_calls: number;
      cost_usd: number;
    }
  | { type: "session_error"; session_id: string; error: string };

// ─── RAPTOR Types ───────────────────────────────────────────────

export interface RaptorConfig {
  target_cluster_size: number;
  min_cluster_size: number;
  max_levels: number;
  summary_model: string;
  max_summary_input_tokens: number;
}

export interface RaptorStatus {
  built: boolean;
  building?: boolean;
  levels: number;
  nodes_per_level: Record<number, number>;
  total_nodes: number;
  last_built?: Date;
  build_duration_ms?: number;

  // ─── Build progress (populated while building === true) ───
  /** The level currently being built (0-indexed) */
  current_level?: number;
  /** How many levels the builder expects to create (may shrink as it progresses) */
  estimated_total_levels?: number;
  /** Number of clusters summarized so far in the current level */
  clusters_completed?: number;
  /** Total clusters to summarize in the current level */
  clusters_total?: number;
  /** Human-readable label for the current phase, e.g. "Clustering", "Summarizing" */
  phase?: string;
  /** Timestamp when the current build started */
  build_started_at?: Date;
  /** If the last build failed, the error message */
  error_message?: string;
}

export interface RaptorNode {
  id: string;
  level: number;
  content: string;
  children_ids: string[];
  source_file?: string;
  score?: number;
}

// ─── Agent Types (Phase 4) ──────────────────────────────────────

export interface AgentToolCall {
  tool_name: string;
  parameters: Record<string, unknown>;
  result?: unknown;
  duration_ms?: number;
}

export interface AgentTurn {
  turn: number;
  reasoning: string;
  tool_calls: AgentToolCall[];
}
