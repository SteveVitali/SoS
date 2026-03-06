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
    file_path?: string;
    parent_dir?: string;
    created_at: string;
  };
}

export interface KBSearchResult {
  content: string;
  source_file: string;
  kb_name: string;
  kb_id: string;
  /** Similarity score (0–1) for vector results, or BM25 score for keyword-only results. */
  score: number;
  /** Reciprocal Rank Fusion score when returned from hybrid search. */
  rrf_score?: number;
  metadata: {
    section?: string;
    page?: number;
    file_path?: string;
    parent_dir?: string;
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

// ---------------------------------------------------------------------------
// Upload job tracking (persisted in MongoDB for cross-session state)
// ---------------------------------------------------------------------------

export type UploadFileState = "pending" | "processing" | "done" | "skipped" | "error";

export interface UploadFileStatus {
  name: string;
  status: UploadFileState;
  chunks?: number;
  error?: string;
  skip_reason?: string;
}

export type UploadJobStatus = "processing" | "completed" | "failed";

export interface UploadJob {
  _id?: any;
  job_id: string;
  kb_id: string;
  status: UploadJobStatus;
  files: UploadFileStatus[];
  summary?: {
    documents_added: number;
    chunks_added: number;
    skipped: number;
    errors: number;
  };
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Ingestion progress events (streamed as NDJSON from the ingest endpoint)
// ---------------------------------------------------------------------------

export type IngestProgressEvent =
  | { type: "job_created"; job_id: string }
  | { type: "start"; total_uploads: number }
  | { type: "file_start"; file: string }
  | { type: "file_done"; file: string; chunks: number }
  | { type: "file_skip"; file: string; reason: string }
  | { type: "file_error"; file: string; error: string }
  | {
      type: "complete";
      documents_added: number;
      chunks_added: number;
      skipped: string[];
      errors: Array<{ file: string; error: string }>;
    };
