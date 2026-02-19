import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../shared/logger.js";
import {
  loadRegistry,
  type RepoEntry,
  type RepoRegistry,
} from "../../worker/executor/repoRegistry.js";

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
  } catch (err: any) {
    log.warn("Failed to resolve current GitHub user", { error: err.message });
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
  const normalized = cloneUrl.replace(/\.git$/, "");
  // SSH: git@github.com:foursquare/foursquare.web
  const sshMatch = normalized.match(/github\.com[:/]([^/]+)\/(.+)$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  // HTTPS: https://github.com/foursquare/foursquare.web
  const httpsMatch = normalized.match(/github\.com\/([^/]+)\/(.+)$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return null;
}

/** List PRs for a single repo via `gh pr list`. */
async function listPrsForRepo(
  owner: string,
  repo: string,
  state: "open" | "closed" | "merged" | "all",
  limit: number,
): Promise<any[]> {
  const stateFlag = state === "all" ? "--state=all" : `--state=${state}`;
  const cmd = `gh pr list --repo "${owner}/${repo}" ${stateFlag} --limit ${limit} --json number,title,state,headRefName,updatedAt,createdAt,author,isDraft,additions,deletions,url`;
  try {
    const { stdout } = await exec(cmd, { timeout: 30_000 });
    return JSON.parse(stdout);
  } catch (err: any) {
    log.warn("Failed to list PRs for repo", { owner, repo, error: err.message });
    return [];
  }
}

/** Fetch comment stats for a single PR via GraphQL. */
async function fetchPrCommentStats(
  owner: string,
  repo: string,
  prNumber: number,
  currentUser: string,
): Promise<PrCommentStats> {
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

// --- Public API ---

export interface ListPrsOptions {
  registryPath: string;
  state?: "open" | "closed" | "merged" | "all";
  limit?: number;
  includeComments?: boolean;
  repoFilter?: string;
}

/**
 * List PRs across all registered repos.
 * Returns PRs sorted by updatedAt descending (most recent first).
 */
export async function listPrs(opts: ListPrsOptions): Promise<GitHubPr[]> {
  const { registryPath, state = "open", limit = 20, includeComments = true, repoFilter } = opts;

  const registry = loadRegistry(registryPath);
  const currentUser = await getCurrentGitHubUser();
  const allPrs: GitHubPr[] = [];

  // List PRs for all repos in parallel
  const repoEntries: Array<{
    repoId: string;
    owner: string;
    repo: string;
  }> = [];

  for (const [repoId, entry] of registry.repos) {
    if (repoFilter && repoId !== repoFilter) continue;
    const parsed = parseCloneUrl(entry.clone);
    if (!parsed) {
      log.warn("Cannot parse clone URL, skipping repo", { repoId, clone: entry.clone });
      continue;
    }
    repoEntries.push({ repoId, owner: parsed.owner, repo: parsed.repo });
  }

  const prListResults = await Promise.all(
    repoEntries.map((r) => listPrsForRepo(r.owner, r.repo, state, limit)),
  );

  // Collect all raw PRs with their repo metadata
  const rawPrsWithMeta: Array<{ pr: any; repoId: string; owner: string; repo: string }> = [];
  for (let i = 0; i < repoEntries.length; i++) {
    const r = repoEntries[i];
    for (const pr of prListResults[i]) {
      rawPrsWithMeta.push({ pr, repoId: r.repoId, owner: r.owner, repo: r.repo });
    }
  }

  // Fetch comment stats for all PRs in parallel
  let commentResults: Array<PrCommentStats | null> = rawPrsWithMeta.map(() => null);
  if (includeComments) {
    commentResults = await Promise.all(
      rawPrsWithMeta.map((item) =>
        fetchPrCommentStats(item.owner, item.repo, item.pr.number, currentUser),
      ),
    );
  }

  for (let i = 0; i < rawPrsWithMeta.length; i++) {
    const { pr, repoId, owner, repo } = rawPrsWithMeta[i];
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
      repoFullName: `${owner}/${repo}`,
      isDraft: pr.isDraft ?? false,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      comments: commentResults[i],
    });
  }

  // Sort by updatedAt descending
  allPrs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return allPrs;
}
