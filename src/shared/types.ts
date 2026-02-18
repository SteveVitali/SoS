import { z } from "zod";

// --- Job Status ---
export const JobStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "FIXING_CI",
  "WAITING_FOR_APPROVAL",
  "DONE",
  "FAILED",
  "CANCELED",
  "DELETED",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const TERMINAL_STATUSES: readonly JobStatus[] = ["DONE", "FAILED", "CANCELED", "DELETED"] as const;
export const ACTIVE_STATUSES: readonly JobStatus[] = ["RUNNING", "FIXING_CI"] as const;

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

// --- Job Document ---
export interface JobDoc {
  _id?: any;
  task_id: string;
  source: JobSource;
  requested_by: string;
  slack_requester?: string;
  status: JobStatus;
  created_at: Date;
  updated_at: Date;
  slack?: SlackPointers;
  task_text: string;
  repo_hint?: string;
  test_level?: TestLevel;
  ci_fix_enabled?: boolean;
  reviewers?: string[];

  // Lease / claim
  claimed_by?: string;
  lease_expires_at?: Date;
  heartbeat_at?: Date;
  attempt?: number;
  run_started_at?: Date;
  run_ended_at?: Date;

  // Outputs
  repos_resolved?: string[];
  branch_name?: string;
  pr_urls?: string[];
  ci?: CIInfo;
  result_summary?: string;
  error?: JobError;

  // Events
  events?: JobEvent[];

  // Linking
  parent_task_id?: string;
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
  | "DONE"
  | "FAILED"
  | "CANCELED";

// Events that trigger Slack updates
export const SLACK_NOTIFY_EVENTS: string[] = [
  "PR_CREATED",
  "CI_FAILED",
  "CI_STATUS",
  "DONE",
  "FAILED",
  "CANCELED",
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

export interface WebCreateJobRequest {
  requested_by: string;
  task_text: string;
  repo_hint?: string;
  test_level?: TestLevel;
  ci_fix_enabled?: boolean;
  reviewers?: string[];
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
