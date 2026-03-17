/**
 * Shared type definitions for the persistent memory system.
 * Used by both server and UI.
 */

// ─── Enums & Literals ────────────────────────────────────────

export type MemoryType = "fact" | "reflection" | "user_profile";
export type InteractionSource = "slack" | "discord" | "web_chat" | "system";

export type SignalType =
  | "continuation"
  | "gratitude"
  | "correction"
  | "rephrase"
  | "follow_up_deeper"
  | "topic_change"
  | "no_response"
  | "job_completed"
  | "job_failed"
  | "explicit_positive"
  | "explicit_negative";

// ─── Core Documents ──────────────────────────────────────────

export interface MemoryNote {
  _id?: any; // MongoDB ObjectId
  memory_id: string;
  owner: string;
  memory_type: MemoryType;

  // Content (A-MEM note structure)
  content: string;
  context: string;
  keywords: string[];
  tags: string[];

  // Provenance
  source_episodes: string[];
  source_type: InteractionSource;
  created_at: Date;
  updated_at: Date;

  // Temporal validity (Graphiti-inspired)
  valid_from: Date;
  invalidated_at?: Date;
  invalidated_by?: string;

  // Links (A-MEM-inspired)
  linked_memory_ids: string[];
  link_reasons: string[];

  // Scoring & Utility
  access_count: number;
  last_accessed_at?: Date;
  importance: number;
  confidence: number;

  // Embedding reference
  embedding_text: string;
}

export interface OutcomeSignal {
  signal_type: SignalType;
  detected_at: Date;
  details?: string;
  strength: number;
}

export interface InteractionEpisode {
  _id?: any; // MongoDB ObjectId
  episode_id: string;
  owner: string;

  // Source
  source: InteractionSource;
  source_ref: {
    conversation_id?: string;
    thread_ts?: string;
    channel_id?: string;
    thread_id?: string;
    message_id?: string;
  };

  // Interaction content
  user_message: string;
  routed_action: string;
  action_args_summary: string;
  response_summary: string;

  // Downstream effects
  task_id?: string;
  research_session_id?: string;

  // Outcome signals (populated by Pipeline C)
  signals: OutcomeSignal[];

  // Timestamps
  timestamp: Date;
  signal_collected_at?: Date;

  // Processing state
  extraction_status: "pending" | "extracted" | "skipped";
  extracted_memory_ids: string[];
}

// ─── Vector & FTS Records ────────────────────────────────────

export interface MemoryVectorRecord {
  [key: string]: unknown;
  id: string;
  owner: string;
  content: string;
  memory_type: string;
  vector: number[];
  tags: string;
  importance: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryFTSRecord {
  memory_id: string;
  owner: string;
  content: string;
  keywords: string;
  tags: string;
  memory_type: string;
}

// ─── Search ──────────────────────────────────────────────────

export interface MemorySearchRequest {
  query: string;
  owner?: string;
  memory_types?: MemoryType[];
  tags?: string[];
  limit?: number;
  min_score?: number;
  include_invalidated?: boolean;
}

export interface MemorySearchResult {
  memory: MemoryNote;
  score: number;
  similarity_score: number;
  keyword_score?: number;
  recency_score: number;
  importance_score: number;
  access_score: number;
}

// ─── Stats ───────────────────────────────────────────────────

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  invalidated_memories: number;
  total_episodes: number;
  memories_by_type: Record<MemoryType, number>;
  last_extraction_at?: Date;
  last_reflection_at?: Date;
}

// ─── Configuration ───────────────────────────────────────────

export interface MemoryConfig {
  enabled: boolean;

  // Extraction
  extraction_model: string;
  extraction_min_turns: number;
  extraction_skip_actions: string[];
  extraction_max_facts_per_call: number;

  // Retrieval
  retrieval_max_memories: number;
  retrieval_max_tokens: number;
  retrieval_min_score: number;
  retrieval_recency_halflife_days: number;

  // Scoring weights (sum to 1.0)
  weight_similarity: number;
  weight_recency: number;
  weight_importance: number;
  weight_access: number;

  // Evolution (A-MEM)
  evolution_enabled: boolean;
  evolution_max_neighbors: number;
  evolution_link_threshold: number;

  // Reflection
  reflection_enabled: boolean;
  reflection_interval_hours: number;
  reflection_min_episodes: number;

  // Signals
  signal_delay_ms: number;
  signal_no_response_timeout_ms: number;
}
