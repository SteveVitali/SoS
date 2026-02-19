import { createLogger } from "../shared/logger.js";
import type { JobDoc } from "../shared/types.js";
import type { WorkerApiClient } from "./apiClient.js";
import type { WorkerConfig } from "./config.js";
import { runJob } from "./executor/runJob.js";
import { runRespondToComments } from "./executor/runRespondToComments.js";
import { HeartbeatManager } from "./heartbeat.js";

const log = createLogger("worker:poller");

export async function startWorkerLoop(
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient,
  signal: AbortSignal,
): Promise<void> {
  const heartbeatManager = new HeartbeatManager(
    api,
    workerId,
    config.leaseSeconds,
    15_000, // heartbeat every 15s
  );

  log.info("Worker loop started", { workerId, requestedBy: config.requestedBy });

  while (!signal.aborted) {
    try {
      // Poll for jobs
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

      // Start heartbeat
      heartbeatManager.start(claimed.task_id);

      try {
        await dispatchJob(claimed, workerId, config, api);
      } catch (jobErr: any) {
        // Last-resort: runJob's own catch block already tried api.fail(),
        // but if that also threw, try one final time from here.
        log.error("runJob threw unexpectedly", { task_id: claimed.task_id, error: jobErr.message });
        try {
          await api.fail(claimed.task_id, workerId, {
            error: {
              code: "WORKER_CRASH",
              message: `Worker-level failure: ${jobErr.message}`,
            },
          });
        } catch {
          /* truly nothing we can do */
        }
      } finally {
        heartbeatManager.stop(claimed.task_id);
      }

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
): Promise<void> {
  if (job.job_type === "respond_to_pr_comments") {
    return runRespondToComments(job, workerId, config, api);
  }
  return runJob(job, workerId, config, api);
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
