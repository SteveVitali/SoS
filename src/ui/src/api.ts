const BASE = "/api/web";

function getHeaders(): HeadersInit {
  const token = localStorage.getItem("sos_token") || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

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
  events?: Array<{ at: string; node_id?: string; type: string; payload?: any }>;
  parent_task_id?: string;
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

export async function createRespondToCommentsJob(data: {
  requested_by: string;
  pr_url: string;
}): Promise<{ job: Job }> {
  return request("POST", "/jobs/respond-to-comments", data);
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
