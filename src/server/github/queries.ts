import { execSync } from "node:child_process";
import { createLogger } from "../../shared/logger.js";
import type { GithubQueryType } from "../../shared/types.js";
import { getAuthenticatedUser, getTeamMembers } from "./teamCache.js";

const log = createLogger("server:github:queries");

function gh(cmd: string): string {
  return execSync(`gh ${cmd}`, { encoding: "utf-8", timeout: 60_000 }).trim();
}

// --- Shared PR result type ---

export interface PrResult {
  title: string;
  url: string;
  repo: string;
  author: string;
  number: number;
  state: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  additions?: number;
  deletions?: number;
  mergedAt?: string;
  reviewDecision?: string;
  isDraft?: boolean;
}

// --- Time range parsing ---

export function parseTimeRange(timeRange?: string): Date {
  if (!timeRange) {
    // Default: 7 days
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  // Handle relative: 7d, 2w, 30d
  const relMatch = timeRange.match(/^(\d+)([dwm])$/i);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms =
      unit === "d"
        ? n * 24 * 60 * 60 * 1000
        : unit === "w"
          ? n * 7 * 24 * 60 * 60 * 1000
          : n * 30 * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms);
  }

  // Handle absolute range: YYYY-MM-DD..YYYY-MM-DD (use the start date)
  const rangeMatch = timeRange.match(/^(\d{4}-\d{2}-\d{2})\.\./);
  if (rangeMatch) {
    return new Date(rangeMatch[1]);
  }

  // Handle single date
  const parsed = new Date(timeRange);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  // Fallback: 7 days
  log.warn("Could not parse time_range, defaulting to 7d", { timeRange });
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

function parsePrSearchResults(raw: string): PrResult[] {
  if (!raw) return [];
  try {
    const items = JSON.parse(raw) as Array<Record<string, any>>;
    return items.map((item) => ({
      title: item.title || "",
      url: item.url || "",
      repo: item.repository?.nameWithOwner || item.repository?.name || "",
      author: item.author?.login || "",
      number: item.number || 0,
      state: item.state || "",
      createdAt: item.createdAt || "",
      updatedAt: item.updatedAt || "",
      labels: (item.labels || []).map((l: any) => (typeof l === "string" ? l : l.name || "")),
      additions: item.additions,
      deletions: item.deletions,
      mergedAt: item.mergedAt || undefined,
      reviewDecision: item.reviewDecision || undefined,
      isDraft: item.isDraft || false,
    }));
  } catch (err: any) {
    log.warn("Failed to parse PR search results", { error: err.message });
    return [];
  }
}

// Fields available in `gh search prs --json`. Note: additions, deletions,
// mergedAt, reviewDecision are NOT available in search — use enrichPrDetails()
// to fetch those via `gh pr view` when needed (e.g. recap jobs).
const SEARCH_FIELDS = "title,url,repository,author,number,state,createdAt,updatedAt,labels,isDraft";

const DETAIL_FIELDS = "additions,deletions,mergedAt,reviewDecision";

/**
 * Enrich PRs with fields only available via `gh pr view` (additions, deletions,
 * mergedAt, reviewDecision). O(N) calls — use only for async recap jobs, not
 * instant queries.
 */
function enrichPrDetails(prs: PrResult[]): PrResult[] {
  for (const pr of prs) {
    try {
      const raw = gh(`pr view "${pr.url}" --json ${DETAIL_FIELDS}`);
      const details = JSON.parse(raw);
      pr.additions = details.additions;
      pr.deletions = details.deletions;
      pr.mergedAt = details.mergedAt || pr.mergedAt;
      pr.reviewDecision = details.reviewDecision || pr.reviewDecision;
    } catch (err: any) {
      log.warn("Failed to enrich PR details", { url: pr.url, error: err.message });
    }
  }
  return prs;
}

// --- Individual query functions ---

export function myReviewRequests(githubUsername?: string): PrResult[] {
  const user = githubUsername || getAuthenticatedUser();
  const raw = gh(
    `search prs --review-requested="${user}" --state=open --json ${SEARCH_FIELDS} --limit 50`,
  );
  return parsePrSearchResults(raw);
}

export function myOpenPrs(githubUsername?: string): PrResult[] {
  const user = githubUsername || getAuthenticatedUser();
  const raw = gh(`search prs --author="${user}" --state=open --json ${SEARCH_FIELDS} --limit 50`);
  return parsePrSearchResults(raw);
}

export function myMergedPrs(githubUsername?: string, timeRange?: string): PrResult[] {
  const user = githubUsername || getAuthenticatedUser();
  const since = toDateStr(parseTimeRange(timeRange));
  const raw = gh(
    `search prs --author="${user}" "is:merged merged:>=${since}" --json ${SEARCH_FIELDS} --limit 100`,
  );
  return parsePrSearchResults(raw);
}

export function teamOpenPrs(org: string, teamSlug: string): PrResult[] {
  const members = getTeamMembers(org, teamSlug);
  const allPrs: PrResult[] = [];
  const seen = new Set<string>();

  for (const member of members) {
    try {
      const prs = myOpenPrs(member);
      for (const pr of prs) {
        if (!seen.has(pr.url)) {
          seen.add(pr.url);
          allPrs.push(pr);
        }
      }
    } catch (err: any) {
      log.warn("Failed to fetch open PRs for team member", { member, error: err.message });
    }
  }

  // Sort by updatedAt descending
  allPrs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return allPrs;
}

export interface TeamReviewRequestsResult {
  member: string;
  prs: PrResult[];
}

export function teamReviewRequests(org: string, teamSlug: string): TeamReviewRequestsResult[] {
  const members = getTeamMembers(org, teamSlug);
  const results: TeamReviewRequestsResult[] = [];

  for (const member of members) {
    try {
      const prs = myReviewRequests(member);
      if (prs.length > 0) {
        results.push({ member, prs });
      }
    } catch (err: any) {
      log.warn("Failed to fetch review requests for team member", { member, error: err.message });
    }
  }

  // Sort by most outstanding reviews first
  results.sort((a, b) => b.prs.length - a.prs.length);
  return results;
}

// --- Summary data fetchers (for recap jobs) ---

export interface RecapData {
  mergedPrs: PrResult[];
  reviewsCompleted: PrResult[];
  totalAdditions: number;
  totalDeletions: number;
  reposTouched: string[];
}

export function fetchRecapData(githubUsername: string, timeRange?: string): RecapData {
  const since = toDateStr(parseTimeRange(timeRange));

  // Merged PRs authored
  const mergedPrs = myMergedPrs(githubUsername, timeRange);

  // Enrich merged PRs with additions/deletions/mergedAt for recap stats
  enrichPrDetails(mergedPrs);

  // PRs reviewed by this user that were merged in the range
  let reviewsCompleted: PrResult[] = [];
  try {
    const raw = gh(
      `search prs --reviewed-by="${githubUsername}" "is:merged merged:>=${since}" --json ${SEARCH_FIELDS} --limit 100`,
    );
    reviewsCompleted = parsePrSearchResults(raw).filter((pr) => pr.author !== githubUsername);
  } catch (err: any) {
    log.warn("Failed to fetch reviews completed", { user: githubUsername, error: err.message });
  }

  const totalAdditions = mergedPrs.reduce((s, pr) => s + (pr.additions || 0), 0);
  const totalDeletions = mergedPrs.reduce((s, pr) => s + (pr.deletions || 0), 0);
  const reposTouched = [...new Set(mergedPrs.map((pr) => pr.repo))];

  return { mergedPrs, reviewsCompleted, totalAdditions, totalDeletions, reposTouched };
}

export interface TeamRecapData {
  members: Array<{ username: string; recap: RecapData }>;
  totalPrsMerged: number;
  totalAdditions: number;
  totalDeletions: number;
  reposActive: string[];
}

export function fetchTeamRecapData(
  org: string,
  teamSlug: string,
  timeRange?: string,
): TeamRecapData {
  const members = getTeamMembers(org, teamSlug);
  const memberRecaps: Array<{ username: string; recap: RecapData }> = [];

  for (const member of members) {
    try {
      const recap = fetchRecapData(member, timeRange);
      if (recap.mergedPrs.length > 0 || recap.reviewsCompleted.length > 0) {
        memberRecaps.push({ username: member, recap });
      }
    } catch (err: any) {
      log.warn("Failed to fetch recap for team member", { member, error: err.message });
    }
  }

  // Sort by most merged PRs first
  memberRecaps.sort((a, b) => b.recap.mergedPrs.length - a.recap.mergedPrs.length);

  const totalPrsMerged = memberRecaps.reduce((s, m) => s + m.recap.mergedPrs.length, 0);
  const totalAdditions = memberRecaps.reduce((s, m) => s + m.recap.totalAdditions, 0);
  const totalDeletions = memberRecaps.reduce((s, m) => s + m.recap.totalDeletions, 0);
  const reposActive = [...new Set(memberRecaps.flatMap((m) => m.recap.reposTouched))];

  return { members: memberRecaps, totalPrsMerged, totalAdditions, totalDeletions, reposActive };
}

// --- Dispatcher for instant queries ---

export interface GithubQueryResult {
  queryType: GithubQueryType;
  prs?: PrResult[];
  teamReviews?: TeamReviewRequestsResult[];
}

function requireTeamParams(params: { org?: string; team_slug?: string }): {
  org: string;
  team_slug: string;
} {
  if (!params.org || !params.team_slug) {
    throw new Error(
      "GitHub org and team slug are required for team queries. Set SOS_GITHUB_ORG and SOS_GITHUB_TEAM_SLUG.",
    );
  }
  return { org: params.org, team_slug: params.team_slug };
}

export function executeInstantQuery(
  queryType: GithubQueryType,
  params: { githubUsername?: string; org?: string; team_slug?: string; time_range?: string },
): GithubQueryResult {
  switch (queryType) {
    case "my_review_requests":
      return { queryType, prs: myReviewRequests(params.githubUsername) };
    case "my_open_prs":
      return { queryType, prs: myOpenPrs(params.githubUsername) };
    case "my_merged_prs":
      return { queryType, prs: myMergedPrs(params.githubUsername, params.time_range) };
    case "team_open_prs": {
      const { org, team_slug } = requireTeamParams(params);
      return { queryType, prs: teamOpenPrs(org, team_slug) };
    }
    case "team_review_requests": {
      const { org, team_slug } = requireTeamParams(params);
      return { queryType, teamReviews: teamReviewRequests(org, team_slug) };
    }
    default:
      throw new Error(`Unknown instant query type: ${queryType}`);
  }
}
