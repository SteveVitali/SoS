import type { JobDoc } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { runClaudeReview } from "./claude.js";
import { RequeueError } from "./errors.js";
import { ExecutorContext } from "./executorContext.js";
import { getPrBaseBranch, getPrBranch, parsePrUrl } from "./ghComments.js";
import { commitAll, getDiffVsBase, hasChanges, push } from "./git.js";
import { findRepoByGitHubUrl, loadRegistry } from "./repoRegistry.js";
import { ensureClone } from "./workspace.js";
import { worktreePool } from "./worktreePool.js";

/**
 * Self-review a PR: check out the branch, get the diff vs base,
 * run Claude to fix issues, commit and push.
 */
export async function runSelfReviewPr(
  job: JobDoc,
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient,
  leaseSignal?: AbortSignal,
): Promise<void> {
  const ctx = new ExecutorContext(job, workerId, config, api, leaseSignal, "selfReviewPr");

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

    await ctx.events.emit("PHASE_STARTED", { phase: "self_review" });

    // 4) Run Claude self-review
    const reviewResult = await runClaudeReview(worktreePath, repo, diff, leaseSignal);
    ctx.pushClaudeSession(reviewResult, "review");
    ctx.durations.self_review_ms = Date.now() - t0;

    await ctx.events.emit("SELF_REVIEW_FINISHED", {
      success: reviewResult.success,
      summary: reviewResult.summary.slice(0, 1000),
    });
    ctx.checkTimeout();

    // 5) Commit and push if there are changes
    if (hasChanges(worktreePath)) {
      t0 = Date.now();
      const sha = commitAll(worktreePath, "sos: self-review fixes");
      push(worktreePath, branch);
      ctx.durations.commit_push_ms = Date.now() - t0;

      await ctx.events.emit("BRANCH_PUSHED", { branch, commit_sha: sha });

      await api.complete(job.task_id, workerId, {
        result_summary: `Self-review complete. Fixed issues and pushed commit \`${sha.slice(0, 7)}\`.\n\n${reviewResult.summary}`,
        pr_urls: [prUrl],
        metrics: ctx.buildMetrics(),
      });
    } else {
      await api.complete(job.task_id, workerId, {
        result_summary: `Self-review complete. No issues found — no changes made.\n\n${reviewResult.summary}`,
        pr_urls: [prUrl],
        metrics: ctx.buildMetrics(),
      });
    }
  } catch (err: unknown) {
    await ctx.handleError(err);
  } finally {
    ctx.releaseWorktree();
  }
}
