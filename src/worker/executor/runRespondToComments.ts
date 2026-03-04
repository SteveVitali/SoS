import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { runClaudeRespondToComment } from "./claude.js";
import { RequeueError } from "./errors.js";
import { ExecutorContext } from "./executorContext.js";
import {
  fetchUnresolvedThreads,
  getPrBranch,
  parsePrUrl,
  type ReviewThread,
  replyToThread,
} from "./ghComments.js";
import { commitAll, hasChanges, push } from "./git.js";
import { findRepoByGitHubUrl, loadRegistry } from "./repoRegistry.js";
import { ensureClone } from "./workspace.js";
import { worktreePool } from "./worktreePool.js";

const log = createLogger("worker:respondToComments");

interface ThreadResult {
  thread: ReviewThread;
  commitSha?: string;
  explanation: string;
  hasCodeChange: boolean;
}

export async function runRespondToComments(
  job: JobDoc,
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient,
  leaseSignal?: AbortSignal,
): Promise<void> {
  const ctx = new ExecutorContext(job, workerId, config, api, leaseSignal, "respondToComments");

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

    // 2) Get PR branch and prepare workspace
    t0 = Date.now();
    await ctx.events.emit("PHASE_STARTED", { phase: "prepare_workspace" });
    const branch = getPrBranch(prUrl);
    const clonePath = ensureClone(config.workspaceRoot, repo);

    ctx.acquiredSlot = worktreePool.acquireExistingBranch(repo, clonePath, job.task_id, branch);
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

    // 3) Fetch unresolved review threads
    await ctx.checkCanceled();
    t0 = Date.now();
    const threads = fetchUnresolvedThreads(prUrl);
    await ctx.events.emit("COMMENTS_FETCHED", {
      thread_count: threads.length,
      comment_count: threads.reduce((s, t) => s + t.comments.length, 0),
    });

    if (threads.length === 0) {
      await api.complete(job.task_id, workerId, {
        result_summary: "No unresolved review comments found.",
        pr_urls: [prUrl],
        metrics: ctx.buildMetrics(),
      });
      return;
    }

    // 4) Process each thread sequentially
    const results: ThreadResult[] = [];
    let commitCount = 0;
    const claudeStartTime = Date.now();

    for (let i = 0; i < threads.length; i++) {
      ctx.checkTimeout();
      await ctx.checkCanceled();

      const thread = threads[i];
      const locationStr = thread.line != null ? `${thread.path}:${thread.line}` : thread.path;

      log.info("Processing review thread", {
        index: i + 1,
        total: threads.length,
        file: locationStr,
      });

      const claudeResult = await runClaudeRespondToComment({
        worktreePath,
        repo,
        threadIndex: i,
        path: thread.path,
        line: thread.line,
        comments: thread.comments,
        branch,
        abortSignal: leaseSignal,
      });
      ctx.pushClaudeSession(claudeResult, "respond_comments");

      // Check if Claude made changes
      const madeChanges = hasChanges(worktreePath);
      let commitSha: string | undefined;
      if (madeChanges) {
        const shortDesc = thread.comments[0]?.body.slice(0, 50) || "review comment";
        commitSha = commitAll(worktreePath, `sos: address review — ${locationStr} (${shortDesc})`);
        commitCount++;
      }

      const explanation = claudeResult.fullText.trim();
      results.push({
        thread,
        commitSha,
        explanation,
        hasCodeChange: !!commitSha,
      });

      await ctx.events.emit("COMMENT_ADDRESSED", {
        thread_id: thread.id,
        path: thread.path,
        line: thread.line,
        has_code_change: !!commitSha,
        commit_sha: commitSha,
      });
    }

    ctx.durations.claude_code_ms = Date.now() - claudeStartTime;

    // 5) Push all commits at once
    if (commitCount > 0) {
      t0 = Date.now();
      push(worktreePath, branch);
      await ctx.events.emit("COMMENTS_PUSHED", { commit_count: commitCount });
      ctx.durations.commit_push_ms = Date.now() - t0;
    }

    // 6) Reply to each thread on GitHub
    for (const result of results) {
      const body = result.commitSha
        ? `Addressed in \`${result.commitSha.slice(0, 7)}\`.\n\n${result.explanation}`
        : result.explanation;
      replyToThread(prUrl, result.thread, body);
    }

    // 7) Build summary and complete
    const codeChanges = results.filter((r) => r.hasCodeChange).length;
    const explanationOnly = results.filter((r) => !r.hasCodeChange).length;
    const resultSummary = [
      `Responded to ${results.length} review thread(s).`,
      codeChanges > 0 ? `${codeChanges} addressed with code changes.` : "",
      explanationOnly > 0 ? `${explanationOnly} responded with explanation only.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    await api.complete(job.task_id, workerId, {
      result_summary: resultSummary,
      pr_urls: [prUrl],
      metrics: ctx.buildMetrics(),
    });
  } catch (err: unknown) {
    await ctx.handleError(err);
  } finally {
    ctx.releaseWorktree();
  }
}
