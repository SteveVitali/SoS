/**
 * Shared types for the Knowledge Base plugin.
 * Used by both server and worker.
 */

export type KBScope = "chat" | "create_job" | "plan_job" | "agent_task" | "all";

export interface KnowledgeBase {
  _id?: any;
  kb_id: string;
  name: string;
  description: string;
  enabled: boolean;
  owner: string;
  created_at: Date;
  updated_at: Date;

  // Per-action scoping
  scopes: KBScope[];

  // Ingestion stats
  chunk_count: number;
  document_count: number;
  total_size_bytes: number;

  // User-configurable embedding/chunking settings
  embedding_model: string;
  chunk_size: number; // tokens
  chunk_overlap: number; // tokens
  max_chunks_per_query: number;
  min_similarity_score: number;
}

export interface KBDocument {
  name: string;
  size_bytes: number;
  chunk_count: number;
  ingested_at: Date;
}

export interface KBChunk {
  id: string;
  kb_id: string;
  source_file: string;
  content: string;
  vector: number[];
  metadata: {
    section?: string;
    page?: number;
    created_at: string;
  };
}

export interface KBSearchResult {
  content: string;
  source_file: string;
  kb_name: string;
  kb_id: string;
  score: number;
  metadata: {
    section?: string;
    page?: number;
  };
}

export interface KBSearchRequest {
  query: string;
  scopes: KBScope[];
  max_chunks?: number;
  min_score?: number;
}

export interface KBProbeResult {
  kb_id: string;
  kb_name: string;
  probe_score: number;
  passed: boolean;
}

export interface KBSearchWithRoutingResult {
  results: KBSearchResult[];
  routing: {
    total_kbs: number;
    relevant_kbs: number;
    probes: KBProbeResult[];
  };
}
