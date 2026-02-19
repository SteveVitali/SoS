import { createLogger } from "../shared/logger.js";
import type { JobDoc } from "../shared/types.js";
import type { WorkerApiClient } from "./apiClient.js";
import type { WorkerConfig } from "./config.js";
import { setClaudeLogContext } from "./executor/claude.js";
import { runJob } from "./executor/runJob.js";
import { runRespondToComments } from "./executor/runRespondToComments.js";
import { HeartbeatManager } from "./heartbeat.js";

const log = createLogger("worker:poller");

export async function startWorkerLoop(
  workerId: string,
  loopIndex: number,
  config: WorkerConfig,
  api: WorkerApiClient,
  signal: AbortSignal,
  processWorkerId?: string,
): Promise<void> {
  const heartbeatManager = new HeartbeatManager(
    api,
    workerId,
    config.leaseSeconds,
    15_000, // heartbeat every 15s
  );

  log.info("Worker loop started", { workerId, loopIndex, requestedBy: config.requestedBy });

  // Track current state for status reporting
  let currentTaskId: string | undefined;
  let currentWorktreeSlot: string | undefined;
  let busySince: string | undefined;

  // Report loop status to server periodically (piggyback on poll cycle)
  async function reportStatus(status: "idle" | "busy") {
    if (!processWorkerId) return;
    try {
      await api.reportStatus(processWorkerId, [
        {
          index: loopIndex,
          status,
          task_id: currentTaskId,
          worktree_slot: currentWorktreeSlot,
          busy_since: busySince,
        },
      ]);
    } catch {
      // Non-critical
    }
  }

  while (!signal.aborted) {
    try {
      // Poll for jobs
      await reportStatus("idle");
      const jobs = await api.poll(config.requestedBy, 5);

      if (jobs.length === 0) {
        await sleep(config.pollIntervalSeconds * 1000, signal);
        continue;
      }

      // Attempt to claim a job (pick randomly for fairness)
      const idx = Math.floor(Math.random() * jobs.length);
      const target = jobs[idx];

      const claimed = await api.claim(
        target.task_id,
        config.requestedBy,
        workerId,
        config.leaseSeconds,
      );

      if (!claimed) {
        // Someone else got it, try again shortly
        await sleep(1000, signal);
        continue;
      }

      log.info("Job claimed, executing", {
        workerId,
        task_id: claimed.task_id,
        attempt: claimed.attempt,
      });

      currentTaskId = claimed.task_id;
      currentWorktreeSlot = claimed.worktree_slot;
      busySince = new Date().toISOString();
      await reportStatus("busy");

      // Set log context so Claude output is tagged with correct loop/task
      setClaudeLogContext(loopIndex, claimed.task_id);

      // Start heartbeat — returns abort signal that fires on lease loss
      const leaseSignal = heartbeatManager.start(claimed.task_id);

      // Keep worker registry status fresh while job runs (stale timeout = 60s)
      const statusTimer = setInterval(() => reportStatus("busy"), 30_000);

      try {
        await dispatchJob(claimed, workerId, config, api, leaseSignal);
      } catch (jobErr: unknown) {
        // Last-resort: runJob's own catch block already tried api.fail(),
        // but if that also threw, try one final time from here.
        const msg = jobErr instanceof Error ? jobErr.message : String(jobErr);
        log.error("runJob threw unexpectedly", { task_id: claimed.task_id, error: msg });
        try {
          await api.fail(claimed.task_id, workerId, {
            error: {
              code: "WORKER_CRASH",
              message: `Worker-level failure: ${msg}`,
            },
          });
        } catch {
          /* truly nothing we can do */
        }
      } finally {
        clearInterval(statusTimer);
        heartbeatManager.stop(claimed.task_id);
      }

      currentTaskId = undefined;
      currentWorktreeSlot = undefined;
      busySince = undefined;

      log.info("Job execution finished", { workerId, task_id: claimed.task_id });
    } catch (err: any) {
      if (signal.aborted) break;
      log.error("Worker loop error", { workerId, error: err.message });
      await sleep(5000, signal);
    }
  }

  heartbeatManager.stopAll();
  log.info("Worker loop stopped", { workerId });
}

function dispatchJob(
  job: JobDoc,
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient,
  leaseSignal: AbortSignal,
): Promise<void> {
  if (job.job_type === "respond_to_pr_comments") {
    return runRespondToComments(job, workerId, config, api, leaseSignal);
  }
  return runJob(job, workerId, config, api, leaseSignal);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
