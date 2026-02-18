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
  source: { type: string; event_id?: string };
  requested_by: string;
  status: string;
  created_at: string;
  updated_at: string;
  slack?: { channel_id?: string; thread_ts?: string; message_ts?: string; permalink?: string };
  task_text: string;
  repo_hint?: string;
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
  pr_urls?: string[];
  ci?: { provider?: string; runs?: Array<{ url: string; status: string; conclusion?: string; updated_at?: string }> };
  result_summary?: string;
  error?: { code?: string; message: string; details?: any };
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

export async function getUsers(): Promise<{ users: string[] }> {
  return request("GET", "/users");
}
