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

export interface GitHubPr {
  url: string;
  number: number;
  title: string;
  state: string;
  headRefName: string;
  updatedAt: string;
  createdAt: string;
  author: string;
  repo: string;
  repoFullName: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  comments: PrCommentStats | null;
  linkedJobTaskId?: string;
}

export async function listPrs(params: {
  state?: string;
  limit?: number;
  include_comments?: boolean;
  repo?: string;
}): Promise<{ prs: GitHubPr[] }> {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.include_comments === false) qs.set("include_comments", "false");
  if (params.repo) qs.set("repo", params.repo);
  return request("GET", `/prs?${qs.toString()}`);
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
