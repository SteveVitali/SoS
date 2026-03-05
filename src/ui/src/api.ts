const BASE = "/api/web";

function getHeaders(): HeadersInit {
  const token = localStorage.getItem("sos_token") || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic API type
async function request<T>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: getHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export interface Job {
  _id?: string;
  task_id: string;
  job_type?: string;
  source: { type: string; event_id?: string };
  requested_by: string;
  status: string;
  created_at: string;
  updated_at: string;
  slack?: { channel_id?: string; thread_ts?: string; message_ts?: string; permalink?: string };
  title?: string;
  task_text: string;
  repo_hint?: string;
  pr_url?: string;
  test_level?: string;
  ci_fix_enabled?: boolean;
  reviewers?: string[];
  claimed_by?: string;
  lease_expires_at?: string;
  heartbeat_at?: string;
  attempt?: number;
  run_started_at?: string;
  run_ended_at?: string;
  repos_resolved?: string[];
  branch_name?: string;
  worktree_slot?: string;
  pr_urls?: string[];
  ci?: {
    provider?: string;
    runs?: Array<{ url: string; status: string; conclusion?: string; updated_at?: string }>;
  };
  result_summary?: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
  error?: { code?: string; message: string; details?: any };
  metrics?: {
    durations?: Record<string, number>;
    claude?: {
      sessions?: Array<{
        phase: string;
        model?: string;
        input_tokens?: number;
        output_tokens?: number;
        duration_ms?: number;
        duration_api_ms?: number;
        num_turns?: number;
        cost_usd?: number;
        cost_source?: string;
      }>;
      total_input_tokens?: number;
      total_output_tokens?: number;
      total_cost_usd?: number;
      cost_source?: string;
    };
  };
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
  events?: Array<{ at: string; node_id?: string; type: string; payload?: any }>;
  parent_task_id?: string;
  needs_plan?: boolean;
  plan?: {
    summary: string;
    generated_at?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
}

export async function listJobs(params: {
  status?: string;
  requested_by?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ jobs: Job[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.requested_by) qs.set("requested_by", params.requested_by);
  if (params.q) qs.set("q", params.q);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  return request("GET", `/jobs?${qs.toString()}`);
}

export async function getJob(taskId: string): Promise<{ job: Job }> {
  return request("GET", `/jobs/${taskId}`);
}

export async function createJob(data: {
  requested_by: string;
  task_text: string;
  repo_hint?: string;
  test_level?: string;
  ci_fix_enabled?: boolean;
  reviewers?: string[];
}): Promise<{ job: Job }> {
  return request("POST", "/jobs", data);
}

export async function cancelJob(taskId: string): Promise<{ job: Job }> {
  return request("POST", `/jobs/${taskId}/cancel`);
}

export async function retryJob(taskId: string): Promise<{ job: Job }> {
  return request("POST", `/jobs/${taskId}/retry`);
}

export async function deleteJob(taskId: string): Promise<{ job: Job }> {
  return request("DELETE", `/jobs/${taskId}`);
}

export async function promotePr(taskId: string, reviewers?: string[]): Promise<{ job: Job }> {
  return request("POST", `/jobs/${taskId}/promote-pr`, { reviewers });
}

export async function respondToComments(taskId: string): Promise<{ job: Job }> {
  return request("POST", `/jobs/${taskId}/respond-to-comments`);
}

export async function confirmPlan(taskId: string, revisedTaskText?: string): Promise<{ job: Job }> {
  return request("POST", `/jobs/${taskId}/confirm-plan`, {
    ...(revisedTaskText ? { revised_task_text: revisedTaskText } : {}),
  });
}

export async function createRespondToCommentsJob(data: {
  requested_by: string;
  pr_url: string;
}): Promise<{ job: Job }> {
  return request("POST", "/jobs/respond-to-comments", data);
}

export async function createSelfReviewPrJob(data: {
  requested_by: string;
  pr_url: string;
}): Promise<{ job: Job }> {
  return request("POST", "/jobs/self-review-pr", data);
}

export async function createAddReviewCommentsJob(data: {
  requested_by: string;
  pr_url: string;
}): Promise<{ job: Job }> {
  return request("POST", "/jobs/add-review-comments", data);
}

export async function getIdentity(): Promise<{ jobOwner: string }> {
  return request("GET", "/identity");
}

export async function getUsers(): Promise<{ users: string[] }> {
  return request("GET", "/users");
}

export interface SlackUser {
  id: string;
  displayName: string;
  realName: string;
  avatar?: string;
}

export async function resolveSlackUsers(userIds: string[]): Promise<Record<string, SlackUser>> {
  if (userIds.length === 0) return {};
  const res = await request<{ users: Record<string, SlackUser> }>("POST", "/slack/users", {
    user_ids: userIds,
  });
  return res.users;
}

export interface PrCommentStats {
  total_comments: number;
  total_threads: number;
  unresolved_threads: number;
  unaddressed_threads: number;
}

export async function fetchPrStats(urls: string[]): Promise<Record<string, PrCommentStats>> {
  if (urls.length === 0) return {};
  const res = await request<{ stats: Record<string, PrCommentStats> }>("POST", "/prs/stats", {
    urls,
  });
  return res.stats;
}

export interface RepoConfig {
  clone: string;
  default_branch?: string;
  max_worktrees?: number;
  clean_mode?: "light" | "full";
  detect?: { keywords?: string[] };
  commands?: {
    lint?: string[];
    test_fast?: string[];
    test_full?: string[];
  };
  pr?: {
    reviewers_default?: string[];
    draft_by_default?: boolean;
  };
  ci?: {
    provider?: string;
  };
}

export interface RegistryData {
  repos: Record<string, RepoConfig>;
}

export async function getRegistry(): Promise<{ registry: RegistryData; path: string }> {
  return request("GET", "/registry");
}

export async function saveRegistry(registry: RegistryData): Promise<{ ok: boolean }> {
  return request("PUT", "/registry", { registry });
}

// --- Routing Config ---

// biome-ignore lint/suspicious/noExplicitAny: dynamic config type
export async function getRoutingConfig(): Promise<{ config: any; path: string }> {
  return request("GET", "/routing-config");
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic config type
export async function saveRoutingConfig(config: any): Promise<{ ok: boolean }> {
  return request("PUT", "/routing-config", { config });
}

export async function reloadRoutingConfig(): Promise<{ ok: boolean }> {
  return request("POST", "/routing-config/reload");
}

// --- Model Config ---

export interface ModelRoleInfo {
  model: string;
  description: string;
  envVar: string;
  default: string;
  fileOverride?: string;
  envOverride?: string;
  source: "default" | "file" | "env";
}

export interface ProviderSettings {
  provider?: string;
  base_url?: string;
  api_key?: string;
}

export interface ProviderResolved {
  provider: string;
  base_url: string;
  api_key_set: boolean;
  source: { provider: string; base_url: string; api_key: string };
}

export interface ModelConfigResponse {
  models: Record<string, ModelRoleInfo>;
  overrides: Record<string, string>;
  path: string;
  provider?: ProviderSettings;
  providerResolved?: ProviderResolved;
}

export async function getModelConfig(): Promise<ModelConfigResponse> {
  return request("GET", "/model-config");
}

export async function saveModelConfig(
  overrides: Record<string, string>,
  provider?: ProviderSettings,
): Promise<{ ok: boolean; models: Record<string, ModelRoleInfo> }> {
  return request("PUT", "/model-config", { overrides, provider });
}

export async function reloadModelConfig(): Promise<{
  ok: boolean;
  models: Record<string, ModelRoleInfo>;
}> {
  return request("POST", "/model-config/reload");
}

export interface AvailableModelsResponse {
  models: string[];
  imageModels?: string[];
  provider: string;
  message?: string;
  error?: string;
}

export async function fetchAvailableModels(): Promise<AvailableModelsResponse> {
  return request("GET", "/available-models");
}

export interface WorktreeSlotStatus {
  slotName: string;
  inUse: boolean;
  taskId?: string;
  acquiredAt?: string;
}

export async function getWorktreeStatus(): Promise<Record<string, WorktreeSlotStatus[]>> {
  const res = await request<{ worktrees: Record<string, WorktreeSlotStatus[]> }>(
    "GET",
    "/worktrees",
  );
  return res.worktrees;
}

// --- Workers ---

export interface WorkerLoopInfo {
  index: number;
  status: "idle" | "busy";
  task_id?: string;
  worktree_slot?: string;
  busy_since?: string;
}

export interface WorkerInfo {
  worker_id: string;
  hostname: string;
  pid: number;
  started_at: string;
  last_seen: string;
  status: "online" | "degraded" | "offline";
  loops: WorkerLoopInfo[];
  version?: string;
}

export async function listWorkerNodes(): Promise<{ workers: WorkerInfo[] }> {
  return request("GET", "/workers");
}

export async function getWorkerNode(id: string): Promise<{ worker: WorkerInfo }> {
  return request("GET", `/workers/${encodeURIComponent(id)}`);
}

export async function spawnWorker(): Promise<{ ok: boolean; pid: number }> {
  return request("POST", "/workers/spawn");
}

export async function shutdownWorker(id: string): Promise<{ ok: boolean }> {
  return request("POST", `/workers/${encodeURIComponent(id)}/shutdown`);
}

export async function removeWorkerEntry(id: string): Promise<{ ok: boolean }> {
  return request("DELETE", `/workers/${encodeURIComponent(id)}`);
}

/**
 * Open an SSE connection for live worker logs.
 * Returns a cleanup function to close the connection.
 */
export function subscribeWorkerLogs(
  workerId: string,
  onLine: (line: {
    worker_id: string;
    loop_index: number;
    task_id?: string;
    line: string;
    ts: string;
  }) => void,
): () => void {
  // EventSource can't send custom headers, so pass token as query param.
  // The server's internalAuth middleware accepts ?token= as a fallback.
  const token = localStorage.getItem("sos_token") || "";
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  const url = `${BASE}/workers/${encodeURIComponent(workerId)}/logs?${params.toString()}`;

  const es = new EventSource(url);

  es.onmessage = (ev) => {
    try {
      onLine(JSON.parse(ev.data));
    } catch {
      // ignore
    }
  };

  es.addEventListener("close", () => {
    es.close();
  });

  es.onerror = () => {
    // Will auto-reconnect
  };

  return () => es.close();
}

// --- Chat ---

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  action?: { command: string; task_id?: string };
  images?: Array<{ url: string; alt?: string }>;
}

export interface Conversation {
  conversation_id: string;
  owner: string;
  title?: string;
  created_at: string;
  updated_at: string;
  messages: ConversationMessage[];
  linked_task_ids: string[];
}

export async function listConversations(params?: {
  limit?: number;
  offset?: number;
}): Promise<{ conversations: Conversation[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  return request("GET", `/chats?${qs.toString()}`);
}

export async function createConversation(): Promise<{ conversation: Conversation }> {
  return request("POST", "/chats");
}

export async function getConversation(id: string): Promise<{ conversation: Conversation }> {
  return request("GET", `/chats/${id}`);
}

export async function sendMessage(
  conversationId: string,
  text: string,
): Promise<{
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  action: { command: string; taskId?: string };
}> {
  return request("POST", `/chats/${conversationId}/messages`, { text });
}

export async function pollConversationUpdates(
  conversationId: string,
  since: string,
): Promise<{ messages: ConversationMessage[]; linked_task_ids: string[] }> {
  return request("GET", `/chats/${conversationId}/updates?since=${encodeURIComponent(since)}`);
}

export async function deleteConversation(id: string): Promise<{ ok: boolean }> {
  return request("DELETE", `/chats/${id}`);
}

// --- Knowledge Bases ---

export type KBScope = "chat" | "create_job" | "plan_job" | "agent_task" | "all";

export interface KnowledgeBase {
  kb_id: string;
  name: string;
  description: string;
  enabled: boolean;
  owner: string;
  created_at: string;
  updated_at: string;
  scopes: KBScope[];
  chunk_count: number;
  document_count: number;
  total_size_bytes: number;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  max_chunks_per_query: number;
  min_similarity_score: number;
}

export interface KBDocument {
  name: string;
  size_bytes: number;
  chunk_count: number;
  ingested_at: string;
}

export interface KBSearchResult {
  content: string;
  source_file: string;
  kb_name: string;
  kb_id: string;
  score: number;
  metadata: { section?: string; page?: number };
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

export async function searchAllKBs(params: {
  query: string;
  scopes?: KBScope[];
  max_chunks?: number;
  min_score?: number;
}): Promise<KBSearchWithRoutingResult> {
  return request("POST", "/kb/search", {
    query: params.query,
    scopes: params.scopes || ["chat", "create_job", "plan_job", "agent_task", "all"],
    max_chunks: params.max_chunks,
    min_score: params.min_score,
  });
}

export async function listKBs(): Promise<{
  kbs: KnowledgeBase[];
  raptor_status: Record<string, RaptorStatus>;
}> {
  return request("GET", "/kb");
}

export async function getKB(id: string): Promise<{ kb: KnowledgeBase; documents: KBDocument[] }> {
  return request("GET", `/kb/${id}`);
}

export async function createKB(data: {
  name: string;
  description?: string;
  scopes?: KBScope[];
  chunk_size?: number;
  chunk_overlap?: number;
  max_chunks_per_query?: number;
  min_similarity_score?: number;
}): Promise<{ kb: KnowledgeBase }> {
  return request("POST", "/kb", data);
}

export async function updateKB(
  id: string,
  data: Partial<
    Pick<
      KnowledgeBase,
      | "name"
      | "description"
      | "enabled"
      | "scopes"
      | "chunk_size"
      | "chunk_overlap"
      | "max_chunks_per_query"
      | "min_similarity_score"
    >
  >,
): Promise<{ kb: KnowledgeBase }> {
  return request("PUT", `/kb/${id}`, data);
}

export async function deleteKB(id: string): Promise<{ ok: boolean }> {
  return request("DELETE", `/kb/${id}`);
}

// Mirrors IngestProgressEvent in src/shared/kbTypes.ts (UI build is separate).
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

// Mirrors UploadJob types in src/shared/kbTypes.ts
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
  created_at: string;
  updated_at: string;
}

/**
 * Upload and ingest files into a KB, streaming NDJSON progress events.
 * Calls `onProgress` for each event. Returns `{ job_id, complete }` so the
 * caller can reconnect via polling if the stream drops.
 */
export async function ingestKBFiles(
  kbId: string,
  files: File[],
  onProgress?: (event: IngestProgressEvent) => void,
): Promise<{
  job_id: string;
  complete: Extract<IngestProgressEvent, { type: "complete" }> | null;
}> {
  const token = localStorage.getItem("sos_token") || "";
  const formData = new FormData();
  for (const file of files) {
    // When uploading a folder, webkitRelativePath preserves the hierarchy
    // (e.g. "my-folder/sub/file.txt"). Pass it as the filename so the
    // server sees the full relative path instead of just the basename.
    const name = file.webkitRelativePath || file.name;
    formData.append("files", file, name);
  }
  const res = await fetch(`${BASE}/kb/${kbId}/ingest`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "text/x-ndjson",
    },
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }

  // Read the NDJSON stream line by line
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completeEvent: Extract<IngestProgressEvent, { type: "complete" }> | null = null;
  let jobId = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    for (;;) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) break;
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const event: IngestProgressEvent = JSON.parse(line);
        if (event.type === "job_created") jobId = event.job_id;
        if (event.type === "complete") completeEvent = event;
        onProgress?.(event);
      } catch {
        // skip malformed lines
      }
    }
  }

  return { job_id: jobId, complete: completeEvent };
}

/**
 * Start a file upload without streaming (fire-and-forget).
 * Returns the job_id immediately for polling.
 */
export async function ingestKBFilesAsync(kbId: string, files: File[]): Promise<{ job_id: string }> {
  const token = localStorage.getItem("sos_token") || "";
  const formData = new FormData();
  for (const file of files) {
    const name = file.webkitRelativePath || file.name;
    formData.append("files", file, name);
  }
  const res = await fetch(`${BASE}/kb/${kbId}/ingest`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export async function searchKB(
  kbId: string,
  query: string,
  limit?: number,
): Promise<{ results: KBSearchResult[] }> {
  return request("POST", `/kb/${kbId}/search`, { query, limit });
}

export async function listKBDocuments(kbId: string): Promise<{ documents: KBDocument[] }> {
  return request("GET", `/kb/${kbId}/documents`);
}

export interface ChunkRecord {
  id: string;
  content: string;
  section: string;
  page: number;
  created_at: string;
}

export async function listDocumentChunks(
  kbId: string,
  docName: string,
  offset = 0,
  limit = 20,
): Promise<{ chunks: ChunkRecord[]; total: number }> {
  return request(
    "GET",
    `/kb/${kbId}/documents/${encodeURIComponent(docName)}/chunks?offset=${offset}&limit=${limit}`,
  );
}

export async function deleteKBDocument(kbId: string, docName: string): Promise<{ ok: boolean }> {
  return request("DELETE", `/kb/${kbId}/documents/${encodeURIComponent(docName)}`);
}

// --- Upload Jobs ---

export async function getUploadJob(kbId: string, jobId: string): Promise<{ job: UploadJob }> {
  return request("GET", `/kb/${kbId}/uploads/${jobId}`);
}

export async function getActiveUploadsForKB(kbId: string): Promise<{ uploads: UploadJob[] }> {
  return request("GET", `/kb/${kbId}/uploads?active=true`);
}

export async function getRecentUploadsForKB(kbId: string): Promise<{ uploads: UploadJob[] }> {
  return request("GET", `/kb/${kbId}/uploads`);
}

export async function getAllActiveUploads(): Promise<{ uploads: UploadJob[] }> {
  return request("GET", "/kb/uploads/active");
}

// --- RAPTOR ---

export interface RaptorStatus {
  kb_id: string;
  built: boolean;
  building: boolean;
  levels: number;
  nodes_per_level: Record<number, number>;
  total_nodes: number;
  build_duration_ms?: number;
  last_built?: string;
  build_started_at?: string;
  error?: string;
}

export async function getRaptorStatus(kbId: string): Promise<{ status: RaptorStatus }> {
  return request("GET", `/kb/${kbId}/raptor/status`);
}

export interface RaptorNode {
  id: string;
  level: number;
  children_ids: string[];
  content: string;
  source_file: string;
  section: string;
}

export async function getRaptorTree(kbId: string): Promise<{ nodes: RaptorNode[] }> {
  return request("GET", `/kb/${kbId}/raptor/tree`);
}

export async function buildRaptorTree(
  kbId: string,
  config?: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  return request("POST", `/kb/${kbId}/raptor/build`, { config });
}

// --- Research Pipeline ---

export type ResearchStrategy = "simple" | "deep" | "agent";

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
  llm_calls: Array<{
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
  }>;
  retrieval_calls: Array<{
    call_id: string;
    query_text: string;
    query_type: string;
    kb_ids_searched: string[];
    results_count: number;
    top_score: number;
    duration_ms: number;
  }>;
}

export interface ResearchSession {
  session_id: string;
  original_query: string;
  scopes: string[];
  config: {
    strategy: ResearchStrategy;
    max_iterations: number;
    max_llm_calls: number;
    max_retrieval_calls: number;
    max_wall_time_ms: number;
    [key: string]: unknown;
  };
  steps: ResearchStep[];
  status: "running" | "completed" | "failed" | "budget_exhausted";
  consumer?: { type: string; id?: string };
  created_at: string;
  completed_at?: string;
}

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
  | { type: "session_error"; session_id: string; error: string }
  | ({ type: "result" } & ResearchResult);

/**
 * Run the research pipeline, returning the full result.
 */
export async function runResearch(params: {
  query: string;
  scopes?: KBScope[];
  strategy?: ResearchStrategy;
  config_overrides?: Record<string, unknown>;
}): Promise<ResearchResult> {
  return request("POST", "/kb/research", {
    query: params.query,
    scopes: params.scopes || ["chat", "all"],
    strategy: params.strategy || "deep",
    config_overrides: params.config_overrides,
  });
}

/**
 * Run the research pipeline with NDJSON streaming for real-time progress.
 */
export async function runResearchStreaming(
  params: {
    query: string;
    scopes?: KBScope[];
    strategy?: ResearchStrategy;
    config_overrides?: Record<string, unknown>;
  },
  onEvent?: (event: ResearchStreamEvent) => void,
): Promise<ResearchResult | null> {
  const token = localStorage.getItem("sos_token") || "";
  const res = await fetch(`${BASE}/kb/research`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/x-ndjson",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      query: params.query,
      scopes: params.scopes || ["chat", "all"],
      strategy: params.strategy || "deep",
      config_overrides: params.config_overrides,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ResearchResult | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event: ResearchStreamEvent = JSON.parse(line);
        if (event.type === "result") {
          const { type, ...rest } = event;
          result = rest as ResearchResult;
        }
        onEvent?.(event);
      } catch {
        // skip
      }
    }
  }

  return result;
}

export async function listResearchSessions(params?: {
  limit?: number;
  offset?: number;
  strategy?: ResearchStrategy;
  consumer_type?: string;
  consumer_id?: string;
}): Promise<{ sessions: ResearchSession[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  if (params?.strategy) qs.set("strategy", params.strategy);
  if (params?.consumer_type) qs.set("consumer_type", params.consumer_type);
  if (params?.consumer_id) qs.set("consumer_id", params.consumer_id);
  return request("GET", `/kb/research/sessions?${qs.toString()}`);
}

export async function getResearchSession(sessionId: string): Promise<{ session: ResearchSession }> {
  return request("GET", `/kb/research/sessions/${sessionId}`);
}

// --- GitHub Hub ---

export type GitHubScope = "me" | "team" | "org";

export interface GitHubHubPr {
  _id: string;
  org: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  is_draft: boolean;
  head_ref: string;
  base_ref: string;
  additions: number;
  deletions: number;
  changed_files: number;
  labels: string[];
  review_decision?: string;
  created_at: string;
  updated_at: string;
  merged_at?: string;
  closed_at?: string;
  comment_stats?: PrCommentStats;
  requested_reviewers: string[];
  reviews: Array<{
    author: string;
    state: string;
    submitted_at: string;
  }>;
  synced_at: string;
  detail_synced_at?: string;
  linked_job_task_id?: string;
}

export interface GitHubHubPrsResponse {
  prs: GitHubHubPr[];
  total: number;
  data_source: "cache" | "partial-cache";
  backfill_progress: {
    completed: number;
    total: number;
    percentage: number;
  };
}

export type PrSortField =
  | "updated"
  | "created"
  | "title"
  | "author"
  | "repo"
  | "state"
  | "size"
  | "reviews";

export async function listGitHubPrs(params: {
  scope?: GitHubScope;
  team?: string;
  state?: string;
  author?: string;
  repo?: string;
  sort?: PrSortField;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}): Promise<GitHubHubPrsResponse> {
  const qs = new URLSearchParams();
  if (params.scope) qs.set("scope", params.scope);
  if (params.team) qs.set("team", params.team);
  if (params.state) qs.set("state", params.state);
  if (params.author) qs.set("author", params.author);
  if (params.repo) qs.set("repo", params.repo);
  if (params.sort) qs.set("sort", params.sort);
  if (params.order) qs.set("order", params.order);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  return request("GET", `/github/prs?${qs.toString()}`);
}

export interface ContributionSummary {
  prs_opened: number;
  prs_merged: number;
  prs_closed: number;
  reviews_submitted: number;
  review_comments: number;
  commits: number;
  additions: number;
  deletions: number;
  repos_touched: string[];
}

export interface ContributionDataPoint {
  period: string;
  prs_merged: number;
  reviews_submitted: number;
  commits: number;
  additions: number;
  deletions: number;
}

export interface LeaderboardEntry {
  login: string;
  avatar_url?: string;
  name?: string;
  prs_merged: number;
  reviews_submitted: number;
  additions: number;
  deletions: number;
  repos_touched: string[];
}

export interface ContributionsResponse {
  summary: ContributionSummary;
  data_points: ContributionDataPoint[];
  leaderboard: LeaderboardEntry[];
  data_source: "cache" | "partial-cache";
}

export async function getGitHubContributions(params: {
  scope?: GitHubScope;
  team?: string;
  login?: string;
  range?: string;
  start?: string;
  end?: string;
  group_by?: "day" | "week" | "month";
}): Promise<ContributionsResponse> {
  const qs = new URLSearchParams();
  if (params.scope) qs.set("scope", params.scope);
  if (params.team) qs.set("team", params.team);
  if (params.login) qs.set("login", params.login);
  if (params.range) qs.set("range", params.range);
  if (params.start) qs.set("start", params.start);
  if (params.end) qs.set("end", params.end);
  if (params.group_by) qs.set("group_by", params.group_by);
  return request("GET", `/github/contributions?${qs.toString()}`);
}

export interface GitHubTeamInfo {
  _id: string;
  org: string;
  slug: string;
  name: string;
  description?: string;
  member_count: number;
}

export interface GitHubMemberInfo {
  _id: string;
  login: string;
  avatar_url: string;
  name?: string;
  teams: string[];
  org: string;
}

export async function listGitHubTeams(): Promise<{ teams: GitHubTeamInfo[] }> {
  return request("GET", "/github/teams");
}

export async function listGitHubMembers(): Promise<{ members: GitHubMemberInfo[] }> {
  return request("GET", "/github/members");
}

export async function listGitHubTeamMembers(
  slug: string,
): Promise<{ members: GitHubMemberInfo[] }> {
  return request("GET", `/github/teams/${encodeURIComponent(slug)}/members`);
}

export interface BackfillProgress {
  total_chunks: number;
  completed_chunks: number;
  in_progress_chunk?: string;
  failed_chunks: number;
  estimated_completion?: string;
  oldest_data_available?: string;
  newest_data_available?: string;
  prs_total: number;
}

export interface SyncStatusResponse {
  enabled: boolean;
  active_task?: {
    type: string;
    started_at: string;
  };
  rate_limit_blocked?: {
    blocked: boolean;
    reason: string;
    unblocks_at?: string;
  };
  backfill: BackfillProgress;
  rate_limit: {
    rest: { remaining: number; limit: number; resets_at: string };
    search: { tokens_available: number; limit: number };
    backfill_budget_available: number;
  };
  cached_counts: {
    prs: number;
    open_prs: number;
    members: number;
    teams: number;
  };
  hot_sync: {
    last_run_at?: string;
    next_run_at?: string;
    interval_seconds: number;
  };
  warm_sync: {
    last_run_at?: string;
    next_run_at?: string;
    interval_seconds: number;
  };
}

export async function getGitHubSyncStatus(): Promise<SyncStatusResponse> {
  return request("GET", "/github/sync-status");
}

export interface SyncLogEntry {
  ts: string;
  level: string;
  category: string;
  message: string;
  details?: Record<string, unknown>;
}

export async function getGitHubSyncLog(params?: {
  limit?: number;
  since?: string;
  category?: string;
}): Promise<{ entries: SyncLogEntry[] }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.since) qs.set("since", params.since);
  if (params?.category) qs.set("category", params.category);
  return request("GET", `/github/sync-log?${qs.toString()}`);
}

export interface SyncChunkInfo {
  id: string;
  start: string;
  end: string;
  status: "pending" | "in_progress" | "complete" | "failed";
  total_items: number;
  attempt: number;
  error?: string;
  completed_at?: string;
}

export async function getGitHubSyncChunks(): Promise<{ chunks: SyncChunkInfo[] }> {
  return request("GET", "/github/sync-chunks");
}

export async function triggerGitHubSync(
  scope: "prs" | "teams" | "contributions" | "backfill",
): Promise<{ ok: boolean }> {
  return request("POST", "/github/sync/trigger", { scope });
}

export interface GitHubSettingsResponse {
  resolved: {
    org: string;
    team_slug: string;
    username: string;
    history_days: number;
    default_scope: GitHubScope;
    pinned_repos: string[];
    contribution_range: string;
    sync_enabled: boolean;
    hot_interval_seconds: number;
    warm_interval_seconds: number;
  };
  db_overrides: Record<string, unknown> | null;
  token: {
    configured: boolean;
    valid: boolean;
    scopes: string[];
  };
}

export async function getGitHubSettings(): Promise<GitHubSettingsResponse> {
  return request("GET", "/github/settings");
}

export async function saveGitHubSettings(
  settings: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  return request("POST", "/github/settings", settings);
}

/**
 * SSE subscription for live GitHub sync log events.
 */
export function subscribeGitHubSyncLog(onEntry: (entry: SyncLogEntry) => void): () => void {
  const token = localStorage.getItem("sos_token") || "";
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  const url = `${BASE}/github/sync-log/stream?${params.toString()}`;

  const es = new EventSource(url);

  es.onmessage = (ev) => {
    try {
      onEntry(JSON.parse(ev.data));
    } catch {
      // ignore
    }
  };

  es.onerror = () => {
    // Will auto-reconnect
  };

  return () => es.close();
}
