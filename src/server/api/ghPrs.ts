import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/logger.js";

const exec = promisify(execCb);
const log = createLogger("server:ghPrs");

// --- Current GitHub User ---

let cachedGhUser: string | null = null;

/** Get the login of the currently authenticated `gh` CLI user (cached). */
export async function getCurrentGitHubUser(): Promise<string> {
  if (cachedGhUser) return cachedGhUser;
  try {
    const { stdout } = await exec("gh api user --jq .login", { timeout: 10_000 });
    cachedGhUser = stdout.trim().toLowerCase();
    log.info("Resolved current GitHub user", { login: cachedGhUser });
    return cachedGhUser;
  } catch (err: unknown) {
    log.warn("Failed to resolve current GitHub user", { error: (err as Error).message });
    return "";
  }
}

// --- Types ---

export interface PrCommentStats {
  total_comments: number;
  total_threads: number;
  unresolved_threads: number;
  unaddressed_threads: number;
}

// --- PR Comment Stats Cache (TTL-based) ---

const PR_STATS_TTL_MS = 120_000; // 2 minutes

interface CachedStats {
  stats: PrCommentStats;
  fetchedAt: number;
}

const prStatsCache = new Map<string, CachedStats>();

function getCachedStats(key: string): PrCommentStats | null {
  const entry = prStatsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PR_STATS_TTL_MS) {
    prStatsCache.delete(key);
    return null;
  }
  return entry.stats;
}

function setCachedStats(key: string, stats: PrCommentStats): void {
  prStatsCache.set(key, { stats, fetchedAt: Date.now() });
}

/** Fetch comment stats for a single PR via GraphQL (with TTL cache). */
async function fetchPrCommentStats(
  owner: string,
  repo: string,
  prNumber: number,
  currentUser: string,
): Promise<PrCommentStats> {
  const cacheKey = `${owner}/${repo}#${prNumber}`;
  const cached = getCachedStats(cacheKey);
  if (cached) return cached;
  const query = `
    query {
      repository(owner: "${owner}", name: "${repo}") {
        pullRequest(number: ${prNumber}) {
          reviewThreads(first: 100) {
            nodes {
              isResolved
              comments(first: 50) {
                totalCount
                nodes {
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const { stdout } = await exec(`gh api graphql -f query='${query.replace(/'/g, "'\\''")}'`, {
      timeout: 30_000,
    });
    const data = JSON.parse(stdout);
    const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!Array.isArray(threads)) {
      return { total_comments: 0, total_threads: 0, unresolved_threads: 0, unaddressed_threads: 0 };
    }

    let totalComments = 0;
    let unresolvedThreads = 0;
    let unaddressedThreads = 0;

    for (const t of threads) {
      const commentCount = t.comments?.totalCount ?? t.comments?.nodes?.length ?? 0;
      totalComments += commentCount;

      if (!t.isResolved) {
        unresolvedThreads++;
        // "un-addressed" = unresolved AND last comment is not from the current user
        const comments = t.comments?.nodes || [];
        if (comments.length > 0) {
          const lastAuthor = (comments[comments.length - 1]?.author?.login || "").toLowerCase();
          if (currentUser && lastAuthor !== currentUser) {
            unaddressedThreads++;
          }
        }
      }
    }

    const stats: PrCommentStats = {
      total_comments: totalComments,
      total_threads: threads.length,
      unresolved_threads: unresolvedThreads,
      unaddressed_threads: unaddressedThreads,
    };
    setCachedStats(cacheKey, stats);
    return stats;
  } catch (err: unknown) {
    log.warn("Failed to fetch comment stats", {
      owner,
      repo,
      prNumber,
      error: (err as Error).message,
    });
    return { total_comments: 0, total_threads: 0, unresolved_threads: 0, unaddressed_threads: 0 };
  }
}

/** Parse a GitHub PR URL into owner, repo, number. Returns null on failure. */
function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * Fetch comment stats for a batch of PR URLs.
 * Returns a map of URL → stats (only includes URLs that could be parsed and fetched).
 */
export async function fetchBatchPrStats(prUrls: string[]): Promise<Record<string, PrCommentStats>> {
  const currentUser = await getCurrentGitHubUser();
  const results: Record<string, PrCommentStats> = {};

  // Fetch all PR stats in parallel
  const entries = prUrls
    .map((url) => ({ url, parsed: parsePrUrl(url) }))
    .filter((e) => e.parsed !== null) as Array<{
    url: string;
    parsed: { owner: string; repo: string; number: number };
  }>;

  const statsResults = await Promise.all(
    entries.map((e) =>
      fetchPrCommentStats(e.parsed.owner, e.parsed.repo, e.parsed.number, currentUser),
    ),
  );

  for (let i = 0; i < entries.length; i++) {
    results[entries[i].url] = statsResults[i];
  }

  return results;
}
