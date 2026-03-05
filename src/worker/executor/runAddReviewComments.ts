import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { runClaudeGenerateReviewComments } from "./claude.js";
import { RequeueError } from "./errors.js";
import { ExecutorContext } from "./executorContext.js";
import {
  createPullRequestReview,
  getPrBaseBranch,
  getPrBranch,
  parsePrUrl,
  type ReviewCommentInput,
} from "./ghComments.js";
import { getDiffVsBase } from "./git.js";
import { findRepoByGitHubUrl, loadRegistry } from "./repoRegistry.js";
import { ensureClone } from "./workspace.js";
import { worktreePool } from "./worktreePool.js";

const log = createLogger("worker:addReviewComments");

/**
 * Parse Claude's output to extract JSON review comments from a fenced code block.
 */
function parseReviewComments(text: string): ReviewCommentInput[] {
  // Look for ```json ... ``` block
  const match = text.match(/```json\s*\n([\s\S]*?)```/);
  if (!match) {
    log.warn("No JSON code block found in Claude output");
    return [];
  }
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c: Record<string, unknown>) =>
          typeof c.path === "string" && typeof c.line === "number" && typeof c.body === "string",
      )
      .map((c: Record<string, unknown>) => ({
        path: c.path as string,
        line: c.line as number,
        body: c.body as string,
      }));
  } catch (err) {
    log.warn("Failed to parse review comments JSON", { error: (err as Error).message });
    return [];
  }
}

/** Max characters for the review body posted to GitHub (well under the 65536 API limit). */
const MAX_REVIEW_BODY_LENGTH = 10_000;

/**
 * Extract a review summary from Claude's output.
 * Looks for text AFTER the ```json block; if empty, uses the default.
 * The old regex `/```[\s\S]*?```/` matched ANY code block, so a ```diff or
 * ```scala block before the JSON block would cause everything after it
 * (including the JSON + reasoning text) to be captured as the body.
 */
function extractReviewSummary(fullText: string, commentCount: number): string {
  const fallback = `Automated code review — ${commentCount} comment(s)`;

  // Specifically match the ```json ... ``` block
  const jsonBlockMatch = fullText.match(/```json\s*\n[\s\S]*?```/);
  if (!jsonBlockMatch || jsonBlockMatch.index == null) return fallback;

  const afterJson = fullText.slice(jsonBlockMatch.index + jsonBlockMatch[0].length).trim();
  if (afterJson.length > 10) {
    return afterJson.slice(0, MAX_REVIEW_BODY_LENGTH);
  }

  return fallback;
}

/**
 * Analyze a PR diff and post inline review comments on GitHub.
 */
export async function runAddReviewComments(
  job: JobDoc,
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient,
  leaseSignal?: AbortSignal,
): Promise<void> {
  const ctx = new ExecutorContext(job, workerId, config, api, leaseSignal, "addReviewComments");

  const prUrl = job.pr_url;
  if (!prUrl) {
    await api.fail(job.task_id, workerId, {
      error: { code: "MISSING_PR_URL", message: "Job has no pr_url set" },
    });
    return;
  }

  try {
    // 1) Resolve repo from PR URL
    let t0 = Date.now();
    await ctx.events.emit("PHASE_STARTED", { phase: "resolve_repo" });
    const { owner, repo: repoName } = parsePrUrl(prUrl);
    const registry = loadRegistry(config.repoRegistryPath);
    const repo = findRepoByGitHubUrl(registry, owner, repoName);
    if (!repo) {
      throw new Error(
        `No repo registry entry matches ${owner}/${repoName}. Check repo-registry.yaml.`,
      );
    }
    ctx.resolvedRepoId = repo.id;
    await ctx.events.emit("REPO_RESOLVED", { repoId: repo.id, method: "pr_url" });
    ctx.durations.resolve_repo_ms = Date.now() - t0;

    // 2) Get PR branch info and prepare workspace
    t0 = Date.now();
    await ctx.events.emit("PHASE_STARTED", { phase: "prepare_workspace" });
    const branch = getPrBranch(prUrl);
    const baseBranch = getPrBaseBranch(prUrl);
    const clonePath = await ensureClone(config.workspaceRoot, repo);

    ctx.acquiredSlot = await worktreePool.acquireExistingBranch(
      repo,
      clonePath,
      job.task_id,
      branch,
    );
    if (!ctx.acquiredSlot) {
      throw new RequeueError(
        `No worktree slots available for ${repo.id} (max: ${repo.max_worktrees})`,
      );
    }

    const worktreePath = ctx.acquiredSlot.worktreePath;
    await ctx.events.emit("WORKTREE_READY", {
      path: worktreePath,
      branch,
      worktree_slot: ctx.acquiredSlot.slotName,
    });
    ctx.durations.prepare_workspace_ms = Date.now() - t0;
    ctx.checkTimeout();

    // 3) Get diff vs base branch
    await ctx.checkCanceled();
    t0 = Date.now();
    const diff = getDiffVsBase(worktreePath, baseBranch);
    if (!diff) {
      await api.complete(job.task_id, workerId, {
        result_summary: "No diff found between PR branch and base. Nothing to review.",
        pr_urls: [prUrl],
        metrics: ctx.buildMetrics(),
      });
      return;
    }

    await ctx.events.emit("PHASE_STARTED", { phase: "generate_review_comments" });

    // 4) Run Claude to generate review comments
    const claudeResult = await runClaudeGenerateReviewComments(
      worktreePath,
      repo,
      diff,
      leaseSignal,
    );
    ctx.pushClaudeSession(claudeResult, "review");
    ctx.durations.claude_review_ms = Date.now() - t0;

    await ctx.events.emit("REVIEW_GENERATED", {
      success: claudeResult.success,
      summary: claudeResult.summary.slice(0, 1000),
    });
    ctx.checkTimeout();

    // 5) Parse the review comments from Claude's output
    const comments = parseReviewComments(claudeResult.fullText);

    await ctx.events.emit("COMMENTS_PARSED", { comment_count: comments.length });

    if (comments.length === 0) {
      await api.complete(job.task_id, workerId, {
        result_summary: `Code review complete. No issues found.\n\n${claudeResult.summary}`,
        pr_urls: [prUrl],
        metrics: ctx.buildMetrics(),
      });
      return;
    }

    // 6) Post the review on GitHub
    await ctx.checkCanceled();
    t0 = Date.now();
    // Extract summary text: prefer text after the ```json block, fall back to default
    const reviewSummary = extractReviewSummary(claudeResult.fullText, comments.length);

    createPullRequestReview(prUrl, comments, reviewSummary, "COMMENT");
    ctx.durations.post_review_ms = Date.now() - t0;

    await ctx.events.emit("REVIEW_POSTED", { comment_count: comments.length });

    await api.complete(job.task_id, workerId, {
      result_summary: `Posted ${comments.length} inline review comment(s) on PR.\n\n${reviewSummary}`,
      pr_urls: [prUrl],
      metrics: ctx.buildMetrics(),
    });
  } catch (err: unknown) {
    await ctx.handleError(err);
  } finally {
    await ctx.releaseWorktree();
  }
}
