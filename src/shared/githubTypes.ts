/**
 * Shared types for the GitHub Hub feature.
 * Used by both server sync engine and UI.
 */

// --- MongoDB Document Types ---

export interface GitHubOrgMember {
  _id: string; // github login (lowercase)
  login: string; // original case
  avatar_url: string;
  name?: string;
  teams: string[]; // team slugs
  org: string;
  synced_at: Date;
}

export interface GitHubTeam {
  _id: string; // "org/team-slug"
  org: string;
  slug: string;
  name: string;
  description?: string;
  member_count: number;
  synced_at: Date;
}

export interface GitHubPrReview {
  author: string;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED
  submitted_at: Date;
}

export interface GitHubPrCommentStats {
  total_threads: number;
  total_comments: number;
  unresolved_threads: number;
}

export interface GitHubPrDoc {
  _id: string; // "owner/repo#123"
  org: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;
  author: string; // login
  state: "open" | "closed" | "merged";
  is_draft: boolean;
  head_ref: string;
  base_ref: string;
  additions: number;
  deletions: number;
  changed_files: number;
  labels: string[];
  review_decision?: string;
  created_at: Date;
  updated_at: Date;
  merged_at?: Date;
  closed_at?: Date;
  comment_stats?: GitHubPrCommentStats;
  requested_reviewers: string[];
  reviews: GitHubPrReview[];
  synced_at: Date;
  detail_synced_at?: Date;
  chunk_id?: string;
}

export interface GitHubContribution {
  _id: string; // "login:2026-03-04"
  login: string;
  org: string;
  date: Date; // day truncated to midnight UTC
  prs_opened: number;
  prs_merged: number;
  prs_closed: number;
  reviews_submitted: number;
  review_comments: number;
  commits: number;
  additions: number;
  deletions: number;
  repos_touched: string[];
  synced_at: Date;
}

export type SyncChunkStatus = "pending" | "in_progress" | "complete" | "failed";

export interface GitHubSyncChunk {
  _id: string; // "prs:MyOrganization:2025-07-07..2025-08-04"
  org: string;
  data_type: "prs" | "reviews" | "contributions";
  chunk_start: Date;
  chunk_end: Date;
  status: SyncChunkStatus;
  pages_fetched: number;
  total_items: number;
  started_at?: Date;
  completed_at?: Date;
  error?: string;
  attempt: number;
}

export type SyncLogLevel = "info" | "warn" | "error" | "debug";
export type SyncLogCategory =
  | "backfill"
  | "hot_sync"
  | "rate_limit"
  | "org_sync"
  | "live_fallback"
  | "contribution_sync";

export interface GitHubSyncLogEntry {
  ts: Date;
  level: SyncLogLevel;
  category: SyncLogCategory;
  message: string;
  details?: {
    chunk_id?: string;
    api_endpoint?: string;
    status_code?: number;
    rate_limit_remaining?: number;
    rate_limit_reset?: string;
    items_fetched?: number;
    duration_ms?: number;
    error?: string;
  };
}

export interface GitHubSettings {
  _id: "global";
  org: string;
  team_slug: string;
  username: string;
  history_days: number;
  default_scope: "me" | "team" | "org";
  pinned_repos: string[];
  contribution_range: string;
  sync_enabled: boolean;
}

// --- API Response Types ---

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

export interface RateLimitStatus {
  rest: { remaining: number; limit: number; resets_at: string };
  search: { tokens_available: number; limit: number };
  backfill_budget_available: number;
}

export interface SyncStatusResponse {
  enabled: boolean;
  backfill: BackfillProgress;
  rate_limit: RateLimitStatus;
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

export interface ChunkInfo {
  start: string;
  end: string;
  id: string;
}

export type GitHubScope = "me" | "team" | "org";

export interface GitHubPrsQuery {
  scope: GitHubScope;
  team?: string;
  state?: "open" | "merged" | "closed" | "all";
  author?: string;
  repo?: string;
  sort?: "updated" | "created";
  limit?: number;
  offset?: number;
}

export interface GitHubContributionsQuery {
  scope: GitHubScope;
  team?: string;
  login?: string;
  range?: string; // "7d" | "30d" | "90d" | "1y" | "custom"
  start?: string;
  end?: string;
  group_by?: "day" | "week" | "month";
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
  period: string; // date string for the period start
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
