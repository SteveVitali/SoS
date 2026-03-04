import { createLogger } from "../../shared/logger.js";
import { computeTokenCost } from "../../shared/modelPricing.js";
import type { ClaudeSession, JobDoc, JobMetrics } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { EventEmitter } from "../events.js";
import { type ClaudeResult, runClaudePlan } from "./claude.js";
import { LeaseAbortedError, RequeueError } from "./errors.js";
import { loadRegistry } from "./repoRegistry.js";
import { resolveRepo } from "./repoResolver.js";
import { ensureClone } from "./workspace.js";
import { type WorktreeSlot, worktreePool } from "./worktreePool.js";

const log = createLogger("worker:runPlanJob");

function toClaudeSession(result: ClaudeResult): ClaudeSession {
  const session: ClaudeSession = { phase: "plan", duration_ms: result.duration_ms };
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

/**
 * Runs the planning phase for a job that has needs_plan=true.
 * 1. Resolves repo
 * 2. Acquires worktree
 * 3. Runs read-only Claude Code CLI session to generate a plan
 * 4. Submits the plan back to the server (job → PENDING_CONFIRMATION)
 * 5. Releases the worktree immediately (no resources held during confirmation wait)
 */
export async function runPlanJob(
  job: JobDoc,
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient,
  leaseSignal?: AbortSignal,
): Promise<void> {
  const events = new EventEmitter(api, workerId, job.task_id);
  const startTime = Date.now();

  let acquiredSlot: WorktreeSlot | null = null;
  let resolvedRepoId: string | undefined;

  function checkLeaseAborted() {
    if (leaseSignal?.aborted) {
      throw new LeaseAbortedError(String(leaseSignal.reason || ""));
    }
  }

  try {
    // 1) Resolve repo
    await events.emit("PHASE_STARTED", { phase: "plan_resolve_repo" });
    const registry = loadRegistry(config.repoRegistryPath);
    const resolved = resolveRepo(registry, job.task_text, job.repo_hint);

    if (!resolved) {
      throw new Error(
        "Could not resolve a repository. Please specify repo=<id> in your request. " +
          `Available repos: ${[...registry.repos.keys()].join(", ")}`,
      );
    }

    const repo = resolved.repo;
    resolvedRepoId = repo.id;
    await events.emit("REPO_RESOLVED", {
      repoId: repo.id,
      method: resolved.method,
      warning: resolved.warning,
    });

    // 2) Prepare workspace via worktree pool
    await events.emit("PHASE_STARTED", { phase: "plan_prepare_workspace" });
    const clonePath = ensureClone(config.workspaceRoot, repo);
    const branch = `sos/plan-${job.task_id.slice(0, 8)}`;

    acquiredSlot = worktreePool.acquire(repo, clonePath, job.task_id, branch);
    if (!acquiredSlot) {
      throw new RequeueError(
        `No worktree slots available for ${repo.id} (max: ${repo.max_worktrees})`,
      );
    }

    const worktreePath = acquiredSlot.worktreePath;

    // 3) Fetch Slack thread context (optional)
    let threadContext: string | undefined;
    if (job.slack?.channel_id && job.slack?.thread_ts) {
      try {
        const messages = await api.fetchSlackThread(job.slack.channel_id, job.slack.thread_ts);
        if (messages.length > 0) {
          threadContext = messages
            // biome-ignore lint/suspicious/noExplicitAny: dynamic type
            .map((m: any) => `[${m.user}]: ${m.text}`)
            .join("\n")
            .slice(0, 5000);
        }
      } catch {
        // Non-fatal
      }
    }

    // 4) Fetch KB context via research pipeline (non-fatal, falls back to simple search)
    let kbContext: string | undefined;
    try {
      const research = await api.researchKnowledgeBases({
        query: job.task_text,
        scopes: ["plan_job", "all"],
        strategy: "simple",
        consumer: { type: "worker_job", id: job.task_id },
      });
      if (research.context) {
        kbContext = research.context;
        log.info("KB research context fetched for plan job", {
          task_id: job.task_id,
          session_id: research.session_id,
          chunks: research.metrics.chunks_used,
        });
      }
    } catch {
      // Fall back to legacy simple search
      try {
        const kbResults = await api.searchKnowledgeBases(job.task_text, ["plan_job", "all"]);
        if (kbResults.length > 0) {
          kbContext = kbResults
            .map(
              (r) =>
                `[${r.kb_name}${r.metadata.section ? ` > ${r.metadata.section}` : ""}] (${r.source_file}, score: ${r.score.toFixed(2)}):\n${r.content}`,
            )
            .join("\n\n---\n\n");
          log.info("KB context fetched via fallback for plan job", {
            task_id: job.task_id,
            chunks: kbResults.length,
          });
        }
      } catch {
        // Non-fatal
      }
    }

    // 5) Run Claude Code CLI in planning mode (read-only)
    checkLeaseAborted();
    await events.emit("PLAN_STARTED", {});
    const planResult = await runClaudePlan(
      worktreePath,
      job.task_text,
      repo,
      threadContext,
      job.attachments,
      leaseSignal,
      kbContext,
    );

    const planSession = toClaudeSession(planResult);
    const durations = {
      total_ms: Date.now() - startTime,
      plan_ms: planResult.duration_ms,
    };
    const metrics: JobMetrics = {
      durations,
      claude: {
        sessions: [planSession],
        total_input_tokens: planSession.input_tokens,
        total_output_tokens: planSession.output_tokens,
        total_cost_usd: planSession.cost_usd,
        cost_source: planSession.cost_source,
      },
    };

    if (!planResult.success) {
      throw new Error(`Planning failed: ${planResult.summary.slice(0, 500)}`);
    }

    // 5) Submit the plan — moves job to PENDING_CONFIRMATION and releases worker lease
    const planSummary = planResult.summary.slice(0, 5000);
    log.info("Submitting plan", { task_id: job.task_id, plan_len: planSummary.length });

    await api.submitPlan(job.task_id, workerId, {
      plan_summary: planSummary,
      metrics,
    });

    log.info("Plan submitted, job awaiting confirmation", { task_id: job.task_id });
  } catch (err: unknown) {
    if (err instanceof LeaseAbortedError) {
      log.warn("Planning job aborted due to lease loss", { task_id: job.task_id });
      return;
    }

    if (err instanceof RequeueError) {
      log.info("Requeuing planning job", { task_id: job.task_id, reason: err.reason });
      try {
        await api.requeue(job.task_id, workerId, err.reason);
        // biome-ignore lint/suspicious/noExplicitAny: error handling
      } catch (reqErr: any) {
        log.error("Failed to requeue planning job", {
          task_id: job.task_id,
          error: reqErr.message,
        });
      }
      return;
    }

    log.error("Planning job failed", { task_id: job.task_id, error: (err as Error).message });
    try {
      await events.emit("FAILED", { error: (err as Error).message });
    } catch {
      /* best-effort */
    }

    try {
      await api.fail(job.task_id, workerId, {
        error: {
          code: (err as { code?: string }).code || "PLANNING_ERROR",
          message: (err as Error).message,
          details: (err as Error).stack?.slice(0, 2000),
        },
      });
      // biome-ignore lint/suspicious/noExplicitAny: error handling
    } catch (failErr: any) {
      log.error("Failed to report planning failure", {
        task_id: job.task_id,
        error: failErr.message,
      });
    }
  } finally {
    // Always release the worktree slot — planning doesn't hold it during confirmation
    if (acquiredSlot && resolvedRepoId) {
      worktreePool.release(resolvedRepoId, acquiredSlot.slotName);
    }
  }
}
