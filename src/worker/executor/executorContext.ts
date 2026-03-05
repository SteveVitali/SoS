import { createLogger } from "../../shared/logger.js";
import { computeTokenCost } from "../../shared/modelPricing.js";
import type { ClaudeSession, JobDoc, JobMetrics } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { EventEmitter } from "../events.js";
import type { ClaudeResult } from "./claude.js";
import { CanceledError, LeaseAbortedError, RequeueError } from "./errors.js";
import type { WorktreeSlot } from "./worktreePool.js";
import { worktreePool } from "./worktreePool.js";

const log = createLogger("worker:executorContext");

/**
 * Shared context and helpers for PR-scoped job executors.
 *
 * Centralises boilerplate that was previously duplicated across
 * runRespondToComments, runSelfReviewPr, and runAddReviewComments:
 *   - Claude session tracking + cost computation
 *   - Metric aggregation
 *   - Timeout / lease / cancelation guards
 *   - Error handling (catch block)
 *   - Worktree cleanup (finally block)
 */
export class ExecutorContext {
  readonly events: EventEmitter;
  readonly startTime = Date.now();
  readonly maxRuntimeMs: number;
  readonly durations: NonNullable<JobMetrics["durations"]> = {};
  readonly claudeSessions: ClaudeSession[] = [];

  /** Set after acquiring a worktree slot so cleanup happens in `finally`. */
  acquiredSlot: WorktreeSlot | null = null;
  resolvedRepoId: string | undefined;

  constructor(
    readonly job: JobDoc,
    readonly workerId: string,
    readonly config: WorkerConfig,
    readonly api: WorkerApiClient,
    readonly leaseSignal: AbortSignal | undefined,
    readonly logLabel: string,
  ) {
    this.events = new EventEmitter(api, workerId, job.task_id);
    this.maxRuntimeMs = config.maxRuntimeMinutes * 60 * 1000;
  }

  // --- Claude session helpers ---

  toClaudeSession(result: ClaudeResult, phase: ClaudeSession["phase"]): ClaudeSession {
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

  pushClaudeSession(result: ClaudeResult, phase: ClaudeSession["phase"]): void {
    this.claudeSessions.push(this.toClaudeSession(result, phase));
  }

  // --- Metrics ---

  buildMetrics(): JobMetrics {
    this.durations.total_ms = Date.now() - this.startTime;
    const totalIn = this.claudeSessions.reduce((s, c) => s + (c.input_tokens ?? 0), 0);
    const totalOut = this.claudeSessions.reduce((s, c) => s + (c.output_tokens ?? 0), 0);
    const totalCost = this.claudeSessions.reduce((s, c) => s + (c.cost_usd ?? 0), 0);
    const hasProviderCost = this.claudeSessions.some((c) => c.cost_source === "provider");
    const hasCost = this.claudeSessions.some((c) => c.cost_usd != null);
    return {
      durations: this.durations,
      claude: {
        sessions: this.claudeSessions,
        total_input_tokens: totalIn > 0 ? totalIn : undefined,
        total_output_tokens: totalOut > 0 ? totalOut : undefined,
        total_cost_usd: hasCost ? totalCost : undefined,
        cost_source: hasProviderCost ? "provider" : hasCost ? "computed" : undefined,
      },
    };
  }

  // --- Guards ---

  checkTimeout(): void {
    if (Date.now() - this.startTime > this.maxRuntimeMs) {
      throw new Error(`Job exceeded max runtime of ${this.config.maxRuntimeMinutes} minutes`);
    }
  }

  checkLeaseAborted(): void {
    if (this.leaseSignal?.aborted) {
      throw new LeaseAbortedError(String(this.leaseSignal.reason || ""));
    }
  }

  async checkCanceled(): Promise<void> {
    this.checkLeaseAborted();
    const status = await this.api.getJobStatus(this.job.task_id);
    if (status === "CANCELED") {
      throw new CanceledError();
    }
  }

  // --- Error handling (shared catch block) ---

  async handleError(err: unknown): Promise<void> {
    const taskId = this.job.task_id;

    if (err instanceof CanceledError) {
      log.info("Job canceled during execution", { task_id: taskId });
      return;
    }

    if (err instanceof LeaseAbortedError) {
      log.warn("Job aborted due to lease loss", {
        task_id: taskId,
        reason: (err as Error).message,
      });
      return;
    }

    if (err instanceof RequeueError) {
      log.info("Requeuing job", { task_id: taskId, reason: err.reason });
      try {
        await this.api.requeue(taskId, this.workerId, err.reason);
        // biome-ignore lint/suspicious/noExplicitAny: error handling
      } catch (reqErr: any) {
        log.error("Failed to requeue job", { task_id: taskId, error: reqErr.message });
      }
      return;
    }

    log.error("Job failed", { task_id: taskId, error: (err as Error).message });
    try {
      await this.events.emit("FAILED", { error: (err as Error).message });
    } catch {
      /* best-effort */
    }

    try {
      const metrics = this.buildMetrics();
      await this.api.fail(taskId, this.workerId, {
        error: {
          code: (err as { code?: string }).code || "EXECUTION_ERROR",
          message: (err as Error).message,
          details: (err as Error).stack?.slice(0, 2000),
        },
        metrics,
      });
      // biome-ignore lint/suspicious/noExplicitAny: error handling
    } catch (failErr: any) {
      log.error("Failed to report job failure to server", {
        task_id: taskId,
        error: failErr.message,
      });
    }
  }

  // --- Worktree cleanup (shared finally block) ---

  async releaseWorktree(): Promise<void> {
    if (this.acquiredSlot && this.resolvedRepoId) {
      await worktreePool.release(this.resolvedRepoId, this.acquiredSlot.slotName);
    }
  }
}
