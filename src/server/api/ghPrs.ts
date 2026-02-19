import { execSync } from "node:child_process";
import { createLogger } from "../../shared/logger.js";
import {
  loadRegistry,
  type RepoEntry,
  type RepoRegistry,
} from "../../worker/executor/repoRegistry.js";

const log = createLogger("server:ghPrs");

// --- Types ---

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

// --- Helpers ---

/** Extract owner/repo from a clone URL. */
function parseCloneUrl(cloneUrl: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:foursquare/fsq-graph.git
  const sshMatch = cloneUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  // HTTPS: https://github.com/foursquare/fsq-graph.git
  const httpsMatch = cloneUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return null;
}

/** List PRs for a single repo via `gh pr list`. */
function listPrsForRepo(
  owner: string,
  repo: string,
  state: "open" | "closed" | "merged" | "all",
  limit: number,
): any[] {
  const stateFlag = state === "all" ? "--state=all" : `--state=${state}`;
  const cmd = `gh pr list --repo "${owner}/${repo}" ${stateFlag} --limit ${limit} --json number,title,state,headRefName,updatedAt,createdAt,author,isDraft,additions,deletions,url`;
  try {
    const raw = execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
    return JSON.parse(raw);
  } catch (err: any) {
    log.warn("Failed to list PRs for repo", { owner, repo, error: err.message });
    return [];
  }
}

/** Fetch comment stats for a single PR via GraphQL. */
function fetchPrCommentStats(
  owner: string,
  repo: string,
  prNumber: number,
  botLogins: string[],
): PrCommentStats {
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
    const raw = execSync(`gh api graphql -f query='${query.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 30_000,
    });
    const data = JSON.parse(raw);
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
        // "un-addressed" = unresolved AND last comment is not from our bot
        const comments = t.comments?.nodes || [];
        if (comments.length > 0) {
          const lastAuthor = comments[comments.length - 1]?.author?.login || "";
          if (!botLogins.includes(lastAuthor.toLowerCase())) {
            unaddressedThreads++;
          }
        }
      }
    }

    return {
      total_comments: totalComments,
      total_threads: threads.length,
      unresolved_threads: unresolvedThreads,
      unaddressed_threads: unaddressedThreads,
    };
  } catch (err: any) {
    log.warn("Failed to fetch comment stats", { owner, repo, prNumber, error: err.message });
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
export function fetchBatchPrStats(
  prUrls: string[],
  botLogins: string[] = ["son-of-steve", "son-of-steve[bot]"],
): Record<string, PrCommentStats> {
  const normalizedBotLogins = botLogins.map((l) => l.toLowerCase());
  const results: Record<string, PrCommentStats> = {};

  for (const url of prUrls) {
    const parsed = parsePrUrl(url);
    if (!parsed) continue;
    results[url] = fetchPrCommentStats(
      parsed.owner,
      parsed.repo,
      parsed.number,
      normalizedBotLogins,
    );
  }

  return results;
}

// --- Public API ---

export interface ListPrsOptions {
  registryPath: string;
  state?: "open" | "closed" | "merged" | "all";
  limit?: number;
  includeComments?: boolean;
  botLogins?: string[];
  repoFilter?: string;
}

/**
 * List PRs across all registered repos.
 * Returns PRs sorted by updatedAt descending (most recent first).
 */
export function listPrs(opts: ListPrsOptions): GitHubPr[] {
  const {
    registryPath,
    state = "open",
    limit = 20,
    includeComments = true,
    botLogins = ["son-of-steve", "son-of-steve[bot]"],
    repoFilter,
  } = opts;

  const registry = loadRegistry(registryPath);
  const normalizedBotLogins = botLogins.map((l) => l.toLowerCase());
  const allPrs: GitHubPr[] = [];

  for (const [repoId, entry] of registry.repos) {
    if (repoFilter && repoId !== repoFilter) continue;

    const parsed = parseCloneUrl(entry.clone);
    if (!parsed) {
      log.warn("Cannot parse clone URL, skipping repo", { repoId, clone: entry.clone });
      continue;
    }

    const rawPrs = listPrsForRepo(parsed.owner, parsed.repo, state, limit);

    for (const pr of rawPrs) {
      let comments: PrCommentStats | null = null;
      if (includeComments) {
        comments = fetchPrCommentStats(parsed.owner, parsed.repo, pr.number, normalizedBotLogins);
      }

      allPrs.push({
        url: pr.url,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        headRefName: pr.headRefName,
        updatedAt: pr.updatedAt,
        createdAt: pr.createdAt,
        author: pr.author?.login || "unknown",
        repo: repoId,
        repoFullName: `${parsed.owner}/${parsed.repo}`,
        isDraft: pr.isDraft ?? false,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        comments,
      });
    }
  }

  // Sort by updatedAt descending
  allPrs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return allPrs;
}
