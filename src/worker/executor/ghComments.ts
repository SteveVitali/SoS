import { execSync } from "node:child_process";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("worker:ghComments");

export interface ReviewComment {
  id: string;
  body: string;
  author: string;
  diffHunk: string;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  comments: ReviewComment[];
}

export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

/** Parse a GitHub PR URL into owner, repo, and PR number. */
export function parsePrUrl(prUrl: string): ParsedPrUrl {
  // Handles: https://github.com/OWNER/REPO/pull/123
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Cannot parse GitHub PR URL: ${prUrl}`);
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** Get the head branch name from a PR URL. */
export function getPrBranch(prUrl: string): string {
  const result = execSync(`gh pr view "${prUrl}" --json headRefName -q .headRefName`, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
  if (!result) throw new Error(`Could not determine branch for PR: ${prUrl}`);
  return result;
}

/** Fetch all unresolved review threads for a PR via GitHub GraphQL API. */
export function fetchUnresolvedThreads(prUrl: string): ReviewThread[] {
  const { owner, repo, number } = parsePrUrl(prUrl);

  const query = `
    query {
      repository(owner: "${owner}", name: "${repo}") {
        pullRequest(number: ${number}) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              startLine
              comments(first: 20) {
                nodes {
                  id
                  body
                  author { login }
                  diffHunk
                }
              }
            }
          }
        }
      }
    }
  `;

  const raw = execSync(`gh api graphql -f query='${query.replace(/'/g, "'\\''")}'`, {
    encoding: "utf-8",
    timeout: 30_000,
  });

  const data = JSON.parse(raw);
  const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(threads)) {
    log.warn("Unexpected GraphQL response shape", { raw: raw.slice(0, 500) });
    return [];
  }

  const unresolved: ReviewThread[] = [];
  for (const t of threads) {
    if (t.isResolved) continue;
    // biome-ignore lint/suspicious/noExplicitAny: dynamic type
    const comments: ReviewComment[] = (t.comments?.nodes || []).map((c: any) => ({
      id: c.id,
      body: c.body,
      author: c.author?.login || "unknown",
      diffHunk: c.diffHunk || "",
    }));
    if (comments.length === 0) continue;
    unresolved.push({
      id: t.id,
      path: t.path || "",
      line: t.line ?? null,
      startLine: t.startLine ?? null,
      comments,
    });
  }

  log.info("Fetched unresolved review threads", {
    total: threads.length,
    unresolved: unresolved.length,
  });
  return unresolved;
}

/** Reply to a review thread on GitHub. Uses the last comment's ID to post a reply. */
export function replyToThread(prUrl: string, thread: ReviewThread, body: string): void {
  // biome-ignore lint/correctness/noUnusedVariables: lint suppression
  const { owner: _owner, repo: _repo, number: _number } = parsePrUrl(prUrl);
  const lastComment = thread.comments[thread.comments.length - 1];
  if (!lastComment) return;

  // Use REST API to reply to the comment
  // The comment ID from GraphQL is a node ID; we need the database ID for REST.
  // Instead, use the GraphQL mutation which accepts the thread node ID directly.
  const mutation = `
    mutation {
      addPullRequestReviewThreadReply(input: {
        pullRequestReviewThreadId: "${thread.id}",
        body: ${JSON.stringify(body)}
      }) {
        comment { id }
      }
    }
  `;

  try {
    execSync(`gh api graphql -f query='${mutation.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 30_000,
    });
    log.info("Replied to review thread", {
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
    });
  } catch (err: unknown) {
    log.warn("Failed to reply to review thread", {
      threadId: thread.id,
      error: (err as Error).message,
    });
  }
}
