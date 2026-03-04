import { z } from "zod";

// --- Job Status ---
export const JobStatus = z.enum([
  "QUEUED",
  "BLOCKED",
  "PLANNING",
  "PENDING_CONFIRMATION",
  "RUNNING",
  "FIXING_CI",
  "WAITING_FOR_APPROVAL",
  "DONE",
  "FAILED",
  "CANCELED",
  "DELETED",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "DONE",
  "FAILED",
  "CANCELED",
  "DELETED",
] as const;
export const ACTIVE_STATUSES: readonly JobStatus[] = ["RUNNING", "FIXING_CI", "PLANNING"] as const;

// --- Test Level ---
export const TestLevel = z.enum(["fast", "full", "none"]);
export type TestLevel = z.infer<typeof TestLevel>;

// --- Source ---
export const JobSourceType = z.enum(["slack_app_mention", "web_create"]);
export type JobSourceType = z.infer<typeof JobSourceType>;

export const JobSource = z.object({
  type: JobSourceType,
  event_id: z.string().optional(),
});
export type JobSource = z.infer<typeof JobSource>;

// --- Slack Pointers ---
export const SlackPointers = z.object({
  channel_id: z.string().optional(),
  thread_ts: z.string().optional(),
  message_ts: z.string().optional(),
  permalink: z.string().optional(),
});
export type SlackPointers = z.infer<typeof SlackPointers>;

// --- CI Run ---
export const CIRun = z.object({
  url: z.string(),
  status: z.string(),
  conclusion: z.string().optional(),
  updated_at: z.coerce.date().optional(),
});
export type CIRun = z.infer<typeof CIRun>;

export const CIInfo = z.object({
  provider: z.string().optional(),
  runs: z.array(CIRun).optional(),
});
export type CIInfo = z.infer<typeof CIInfo>;

// --- Job Error ---
export const JobError = z.object({
  code: z.string().optional(),
  message: z.string(),
  details: z.any().optional(),
});
export type JobError = z.infer<typeof JobError>;

// --- Job Event ---
export const JobEvent = z.object({
  at: z.coerce.date(),
  node_id: z.string().optional(),
  type: z.string(),
  payload: z.any().optional(),
});
export type JobEvent = z.infer<typeof JobEvent>;

// --- Metrics ---
export type JobType =
  | "create"
  | "respond_to_pr_comments"
  | "self_review_pr"
  | "add_pr_review_comments"
  | "github_summary";

export type GithubQueryType =
  | "my_review_requests"
  | "my_open_prs"
  | "my_merged_prs"
  | "team_open_prs"
  | "team_review_requests"
  | "my_recap"
  | "team_recap";

export const GITHUB_INSTANT_QUERIES: readonly GithubQueryType[] = [
  "my_review_requests",
  "my_open_prs",
  "my_merged_prs",
  "team_open_prs",
  "team_review_requests",
] as const;

export const GITHUB_SUMMARY_QUERIES: readonly GithubQueryType[] = [
  "my_recap",
  "team_recap",
] as const;

export interface ClaudeSession {
  phase: "plan" | "code" | "review" | "fix" | "respond_comments" | "summary";
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  cost_usd?: number;
  cost_source?: "provider" | "computed";
}

export interface JobMetrics {
  durations?: {
    total_ms?: number;
    resolve_repo_ms?: number;
    prepare_workspace_ms?: number;
    claude_code_ms?: number;
    claude_review_ms?: number;
    local_checks_ms?: number;
    self_review_ms?: number;
    commit_push_ms?: number;
    post_review_ms?: number;
    plan_ms?: number;
    ci_wait_ms?: number;
    ci_fix_ms?: number;
  };
  claude?: {
    sessions?: ClaudeSession[];
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_cost_usd?: number;
    cost_source?: "provider" | "computed";
  };
}

// --- Job Attachment ---
export interface JobAttachment {
  file_id: string;
  filename: string;
  mimetype: string;
  size_bytes: number;
  base64: string;
}

// --- Job Document ---
export interface JobDoc {
  // biome-ignore lint/suspicious/noExplicitAny: shared type definition
  _id?: any;
  task_id: string;
  job_type?: JobType;
  source: JobSource;
  requested_by: string;
  slack_requester?: string;
  status: JobStatus;
  created_at: Date;
  updated_at: Date;
  slack?: SlackPointers;
  title?: string;
  task_text: string;
  repo_hint?: string;
  pr_url?: string;
  test_level?: TestLevel;
  ci_fix_enabled?: boolean;
  reviewers?: string[];

  // Lease / claim
  claimed_by?: string;
  lease_expires_at?: Date;
  heartbeat_at?: Date;
  attempt?: number;
  not_before?: Date;
  run_started_at?: Date;
  run_ended_at?: Date;

  // Outputs
  repos_resolved?: string[];
  branch_name?: string;
  worktree_slot?: string;
  pr_urls?: string[];
  ci?: CIInfo;
  result_summary?: string;
  error?: JobError;

  // Attachments (files from Slack thread)
  attachments?: JobAttachment[];

  // Events
  events?: JobEvent[];

  // Metrics
  metrics?: JobMetrics;

  // GitHub query params (for github_summary jobs)
  github_query?: {
    query_type: GithubQueryType;
    time_range?: string;
    org?: string;
    team_slug?: string;
    github_username?: string;
  };

  // Pre-flight planning
  needs_plan?: boolean;
  plan?: {
    summary: string;
    generated_at: Date;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };

  // Custom instructions from YAML routing config (for agent_task execution)
  custom_instructions?: string;

  // Linking
  parent_task_id?: string;

  // Per-PR queue: this job is blocked until the referenced job finishes
  blocked_by?: string;
}

// --- Event Types ---
export type WorkerEventType =
  | "PHASE_STARTED"
  | "REPO_RESOLVED"
  | "WORKTREE_READY"
  | "CLAUDE_STARTED"
  | "CLAUDE_FINISHED"
  | "LOCAL_CHECKS_STARTED"
  | "LOCAL_CHECKS_FINISHED"
  | "SELF_REVIEW_STARTED"
  | "SELF_REVIEW_FINISHED"
  | "COMMIT_CREATED"
  | "BRANCH_PUSHED"
  | "PR_CREATED"
  | "CI_STATUS"
  | "CI_FAILED"
  | "CI_FIX_STARTED"
  | "CI_FIX_FINISHED"
  | "PLAN_STARTED"
  | "PLAN_GENERATED"
  | "PLAN_CONFIRMED"
  | "PR_READY_FOR_APPROVAL"
  | "PR_PROMOTED"
  | "COMMENTS_FETCHED"
  | "COMMENT_ADDRESSED"
  | "COMMENTS_PUSHED"
  | "REVIEW_GENERATED"
  | "COMMENTS_PARSED"
  | "REVIEW_POSTED"
  | "DONE"
  | "FAILED"
  | "CANCELED";

// Events that trigger Slack updates
// Terminal states (DONE, FAILED, CANCELED) are NOT included here because
// the service functions (complete, fail, cancel) already post to Slack.
// Including them would cause duplicate notifications.
export const SLACK_NOTIFY_EVENTS: readonly WorkerEventType[] = [
  "PR_CREATED",
  "CI_FAILED",
  "CI_STATUS",
];

// --- API Request/Response Types ---
export interface ClaimRequest {
  requested_by: string;
  node_id: string;
  lease_seconds: number;
}

export interface HeartbeatRequest {
  node_id: string;
  extend_seconds: number;
}

export interface WorkerEventRequest {
  node_id: string;
  type: WorkerEventType;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic payload type
  payload?: any;
}

export interface CompleteRequest {
  node_id: string;
  result_summary: string;
  pr_urls?: string[];
  ci?: CIInfo;
}

export interface FailRequest {
  node_id: string;
  error: JobError;
  pr_urls?: string[];
  ci?: CIInfo;
}

export interface SubmitPlanRequest {
  node_id: string;
  plan_summary: string;
  metrics?: JobMetrics;
}

export interface WebCreateJobRequest {
  requested_by: string;
  task_text: string;
  repo_hint?: string;
  test_level?: TestLevel;
  ci_fix_enabled?: boolean;
  reviewers?: string[];
  needs_plan?: boolean;
}

export interface WebRespondToCommentsRequest {
  requested_by: string;
  pr_url: string;
  parent_task_id?: string;
}

// --- Worker Registry Types ---

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

export interface WorkerRegisterRequest {
  worker_id: string;
  hostname: string;
  pid: number;
  version?: string;
}

export interface WorkerStatusReport {
  worker_id: string;
  loops: WorkerLoopInfo[];
}

export interface WorkerCommand {
  command: "shutdown";
}

export interface WorkerLogLine {
  worker_id: string;
  loop_index: number;
  task_id?: string;
  line: string;
  ts: string;
}

export interface WebJobsQuery {
  status?: string;
  requested_by?: string;
  q?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: "asc" | "desc";
}
