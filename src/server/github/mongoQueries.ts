/**
 * MongoDB-backed GitHub instant query implementations.
 *
 * Replaces the old gh-CLI-based queries.ts. All data comes from the
 * github_prs and github_org_members collections populated by the
 * GitHubSyncService.
 */

import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import type { GithubQueryType } from "../../shared/types.js";
import { resolveGitHubConfig } from "../githubSync/githubConfig.js";
import {
  getChunkStats,
  getOrgMembersCollection,
  getPrsCollection,
  getSyncCursor,
} from "../githubSync/githubRepo.js";

const log = createLogger("server:github:mongoQueries");

// --- Public types ---

export interface SyncReadiness {
  hasPrData: boolean;
  hasTeamData: boolean;
  backfillPercent: number;
  lastHotSync?: Date;
}

export interface InstantQueryResult {
  queryType: GithubQueryType;
  prs: GitHubPrDoc[];
  syncStatus: SyncReadiness;
}

// --- Main entry point ---

export async function executeInstantQueryFromMongo(
  queryType: GithubQueryType,
  params: {
    githubUsername?: string;
    org?: string;
    team_slug?: string;
    time_range?: string;
  },
): Promise<InstantQueryResult> {
  const config = await resolveGitHubConfig();
  const org = (params.org || config.org).toLowerCase();
  const username = (params.githubUsername || config.username || "").toLowerCase();
  const teamSlug = params.team_slug || config.teamSlug;

  const prs = await runQuery(queryType, org, username, teamSlug, params.time_range);
  const syncStatus = await getSyncReadiness(org);

  log.debug("Instant query executed", {
    queryType,
    org,
    resultCount: prs.length,
    backfillPercent: syncStatus.backfillPercent,
  });

  return { queryType, prs, syncStatus };
}

// --- Query implementations ---

async function runQuery(
  queryType: GithubQueryType,
  org: string,
  username: string,
  teamSlug: string,
  timeRange?: string,
): Promise<GitHubPrDoc[]> {
  switch (queryType) {
    case "my_review_requests":
      return myReviewRequests(org, username);
    case "my_open_prs":
      return myOpenPrs(org, username);
    case "my_merged_prs":
      return myMergedPrs(org, username, timeRange);
    case "team_open_prs":
      return teamOpenPrs(org, teamSlug);
    case "team_review_requests":
      return teamReviewRequests(org, teamSlug);
    default:
      throw new Error(`Unknown instant query type: ${queryType}`);
  }
}

async function myReviewRequests(org: string, username: string): Promise<GitHubPrDoc[]> {
  return getPrsCollection()
    .find({ org, state: "open", requested_reviewers: username })
    .sort({ updated_at: -1 })
    .limit(100)
    .toArray();
}

async function myOpenPrs(org: string, username: string): Promise<GitHubPrDoc[]> {
  return getPrsCollection()
    .find({ org, state: "open", author: username })
    .sort({ updated_at: -1 })
    .limit(100)
    .toArray();
}

async function myMergedPrs(
  org: string,
  username: string,
  timeRange?: string,
): Promise<GitHubPrDoc[]> {
  const since = parseTimeRange(timeRange);
  return getPrsCollection()
    .find({
      org,
      state: "merged",
      author: username,
      merged_at: { $gte: since },
    })
    .sort({ merged_at: -1 })
    .limit(100)
    .toArray();
}

async function teamOpenPrs(org: string, teamSlug: string): Promise<GitHubPrDoc[]> {
  const members = await getTeamMemberLogins(org, teamSlug);
  if (members.length === 0) return [];
  return getPrsCollection()
    .find({ org, state: "open", author: { $in: members } })
    .sort({ updated_at: -1 })
    .limit(200)
    .toArray();
}

async function teamReviewRequests(org: string, teamSlug: string): Promise<GitHubPrDoc[]> {
  const members = await getTeamMemberLogins(org, teamSlug);
  if (members.length === 0) return [];
  return getPrsCollection()
    .find({
      org,
      state: "open",
      is_draft: { $ne: true },
      requested_reviewers: { $in: members },
    })
    .sort({ updated_at: -1 })
    .limit(200)
    .toArray();
}

// --- Helpers ---

async function getTeamMemberLogins(org: string, teamSlug: string): Promise<string[]> {
  const members = await getOrgMembersCollection()
    .find({ org: org.toLowerCase(), teams: teamSlug })
    .project<{ _id: string }>({ _id: 1 })
    .toArray();
  return members.map((m) => m._id);
}

/**
 * Parse a relative time range string like "7d", "2w", "1m" into a Date.
 * Returns the start date (now minus the range). Defaults to 7 days.
 * Only relative ranges are supported (e.g. "7d", "2w", "3m").
 */
export function parseTimeRange(timeRange?: string): Date {
  if (!timeRange) return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const match = timeRange.match(/^(\d+)([dwm])$/);
  if (!match) return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const days = unit === "w" ? val * 7 : unit === "m" ? val * 30 : val;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

let readinessCache: { org: string; data: SyncReadiness; at: number } | null = null;
const READINESS_TTL_MS = 30_000;

async function getSyncReadiness(org: string): Promise<SyncReadiness> {
  if (
    readinessCache &&
    readinessCache.org === org &&
    Date.now() - readinessCache.at < READINESS_TTL_MS
  ) {
    return readinessCache.data;
  }

  const [prCount, memberCount, chunkStats, cursor] = await Promise.all([
    getPrsCollection().countDocuments({ org }),
    getOrgMembersCollection().countDocuments({ org }),
    getChunkStats(org, "prs"),
    getSyncCursor(org),
  ]);
  const data: SyncReadiness = {
    hasPrData: prCount > 0,
    hasTeamData: memberCount > 0,
    backfillPercent:
      chunkStats.total > 0 ? Math.round((chunkStats.completed / chunkStats.total) * 100) : 0,
    lastHotSync: cursor.last_hot_sync_at,
  };
  readinessCache = { org, data, at: Date.now() };
  return data;
}
