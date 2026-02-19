import { createLogger } from "../../shared/logger.js";
import { computeTokenCost } from "../../shared/modelPricing.js";
import type { ClaudeSession, JobDoc, JobMetrics } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { EventEmitter } from "../events.js";
import { type ClaudeResult, runClaudeRespondToComment } from "./claude.js";
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
import { type WorktreeSlot, worktreePool } from "./worktreePool.js";

const log = createLogger("worker:respondToComments");

/** Sentinel error when a job is canceled mid-execution. */
class CanceledError extends Error {
  constructor() {
    super("Job was canceled during execution");
    this.name = "CanceledError";
  }
}

/** Sentinel error to signal the job should be requeued. */
class RequeueError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "RequeueError";
  }
}

/** Sentinel error when the heartbeat signals lease loss / server unreachable. */
class LeaseAbortedError extends Error {
  constructor(reason?: string) {
    super(reason || "Job aborted: lease lost or server unreachable");
    this.name = "LeaseAbortedError";
  }
}

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
  const events = new EventEmitter(api, workerId, job.task_id);
  const startTime = Date.now();
  const maxRuntimeMs = config.maxRuntimeMinutes * 60 * 1000;

  let acquiredSlot: WorktreeSlot | null = null;
  let resolvedRepoId: string | undefined;

  const durations: NonNullable<JobMetrics["durations"]> = {};
  const claudeSessions: ClaudeSession[] = [];

  function toClaudeSession(result: ClaudeResult, phase: ClaudeSession["phase"]): ClaudeSession {
    const session: ClaudeSession = { phase, duration_ms: result.duration_ms };
    if (result.model) session.model = result.model;
    if (result.input_tokens != null) session.input_tokens = result.input_tokens;
    if (result.output_tokens != null) session.output_tokens = result.output_tokens;
    if (result.duration_api_ms != null) session.duration_api_ms = result.duration_api_ms;
    if (result.num_turns != null) session.num_turns = result.num_turns;
    if (result.cost_usd != null) {
      session.cost_usd = result.cost_usd;
      session.cost_source = "provider";
    } else if (result.model && result.input_tokens != null && result.output_tokens != null) {
      const computed = computeTokenCost(result.model, result.input_tokens, result.output_tokens);
      if (computed != null) {
        session.cost_usd = computed;
        session.cost_source = "computed";
      }
    }
    return session;
  }

  function buildMetrics(): JobMetrics {
    durations.total_ms = Date.now() - startTime;
    const totalIn = claudeSessions.reduce((s, c) => s + (c.input_tokens ?? 0), 0);
    const totalOut = claudeSessions.reduce((s, c) => s + (c.output_tokens ?? 0), 0);
    const totalCost = claudeSessions.reduce((s, c) => s + (c.cost_usd ?? 0), 0);
    const hasProviderCost = claudeSessions.some((c) => c.cost_source === "provider");
    const hasCost = claudeSessions.some((c) => c.cost_usd != null);
    return {
      durations,
      claude: {
        sessions: claudeSessions,
        total_input_tokens: totalIn > 0 ? totalIn : undefined,
        total_output_tokens: totalOut > 0 ? totalOut : undefined,
        total_cost_usd: hasCost ? totalCost : undefined,
        cost_source: hasProviderCost ? "provider" : hasCost ? "computed" : undefined,
      },
    };
  }

  function checkTimeout() {
    if (Date.now() - startTime > maxRuntimeMs) {
      throw new Error(`Job exceeded max runtime of ${config.maxRuntimeMinutes} minutes`);
    }
  }

  function checkLeaseAborted() {
    if (leaseSignal?.aborted) {
      throw new LeaseAbortedError(String(leaseSignal.reason || ""));
    }
  }

  async function checkCanceled() {
    checkLeaseAborted();
    const status = await api.getJobStatus(job.task_id);
    if (status === "CANCELED") {
      throw new CanceledError();
    }
  }

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
    await events.emit("PHASE_STARTED", { phase: "resolve_repo" });
    const { owner, repo: repoName } = parsePrUrl(prUrl);
    const registry = loadRegistry(config.repoRegistryPath);
    const repo = findRepoByGitHubUrl(registry, owner, repoName);
    if (!repo) {
      throw new Error(
        `No repo registry entry matches ${owner}/${repoName}. Check repo-registry.yaml.`,
      );
    }
    resolvedRepoId = repo.id;
    await events.emit("REPO_RESOLVED", { repoId: repo.id, method: "pr_url" });
    durations.resolve_repo_ms = Date.now() - t0;

    // 2) Get PR branch and prepare workspace
    t0 = Date.now();
    await events.emit("PHASE_STARTED", { phase: "prepare_workspace" });
    const branch = getPrBranch(prUrl);
    const clonePath = ensureClone(config.workspaceRoot, repo);

    acquiredSlot = worktreePool.acquireExistingBranch(repo, clonePath, job.task_id, branch);
    if (!acquiredSlot) {
      throw new RequeueError(
        `No worktree slots available for ${repo.id} (max: ${repo.max_worktrees})`,
      );
    }

    const worktreePath = acquiredSlot.worktreePath;
    await events.emit("WORKTREE_READY", {
      path: worktreePath,
      branch,
      worktree_slot: acquiredSlot.slotName,
    });
    durations.prepare_workspace_ms = Date.now() - t0;
    checkTimeout();

    // 3) Fetch unresolved review threads
    await checkCanceled();
    t0 = Date.now();
    const threads = fetchUnresolvedThreads(prUrl);
    await events.emit("COMMENTS_FETCHED", {
      thread_count: threads.length,
      comment_count: threads.reduce((s, t) => s + t.comments.length, 0),
    });

    if (threads.length === 0) {
      await api.complete(job.task_id, workerId, {
        result_summary: "No unresolved review comments found.",
        pr_urls: [prUrl],
        metrics: buildMetrics(),
      });
      return;
    }

    // 4) Process each thread sequentially
    const results: ThreadResult[] = [];
    let commitCount = 0;
    const claudeStartTime = Date.now();

    for (let i = 0; i < threads.length; i++) {
      checkTimeout();
      await checkCanceled();

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
      claudeSessions.push(toClaudeSession(claudeResult, "respond_comments"));

      // Check if Claude made changes
      const madeChanges = hasChanges(worktreePath);
      let commitSha: string | undefined;
      if (madeChanges) {
        const shortDesc = thread.comments[0]?.body.slice(0, 50) || "review comment";
        commitSha = commitAll(worktreePath, `sos: address review — ${locationStr} (${shortDesc})`);
        commitCount++;
      }

      const explanation = claudeResult.summary.slice(0, 1000).trim();
      results.push({
        thread,
        commitSha,
        explanation,
        hasCodeChange: !!commitSha,
      });

      await events.emit("COMMENT_ADDRESSED", {
        thread_id: thread.id,
        path: thread.path,
        line: thread.line,
        has_code_change: !!commitSha,
        commit_sha: commitSha,
      });
    }

    durations.claude_code_ms = Date.now() - claudeStartTime;

    // 5) Push all commits at once
    if (commitCount > 0) {
      t0 = Date.now();
      push(worktreePath, branch);
      await events.emit("COMMENTS_PUSHED", { commit_count: commitCount });
      durations.commit_push_ms = Date.now() - t0;
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

    const metrics = buildMetrics();
    await api.complete(job.task_id, workerId, {
      result_summary: resultSummary,
      pr_urls: [prUrl],
      metrics,
    });
  } catch (err: any) {
    if (err instanceof CanceledError) {
      log.info("Job canceled during execution", { task_id: job.task_id });
      return;
    }

    if (err instanceof LeaseAbortedError) {
      log.warn("Job aborted due to lease loss", { task_id: job.task_id, reason: err.message });
      return;
    }

    if (err instanceof RequeueError) {
      log.info("Requeuing job", { task_id: job.task_id, reason: err.reason });
      try {
        await api.requeue(job.task_id, workerId, err.reason);
      } catch (reqErr: any) {
        log.error("Failed to requeue job", { task_id: job.task_id, error: reqErr.message });
      }
      return;
    }

    log.error("Job failed", { task_id: job.task_id, error: err.message });
    try {
      await events.emit("FAILED", { error: err.message });
    } catch {
      /* best-effort */
    }

    try {
      const metrics = buildMetrics();
      await api.fail(job.task_id, workerId, {
        error: {
          code: err.code || "EXECUTION_ERROR",
          message: err.message,
          details: err.stack?.slice(0, 2000),
        },
        metrics,
      });
    } catch (failErr: any) {
      log.error("Failed to report job failure to server", {
        task_id: job.task_id,
        error: failErr.message,
      });
    }
  } finally {
    if (acquiredSlot && resolvedRepoId) {
      worktreePool.release(resolvedRepoId, acquiredSlot.slotName);
    }
  }
}
