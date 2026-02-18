import { createLogger } from "../../shared/logger.js";
import { nowDate } from "../../shared/time.js";
import type { JobDoc, JobStatus } from "../../shared/types.js";
import { getJobsCollection } from "../mongo.js";
import type { SlackPoster } from "../slack/slackClient.js";

const log = createLogger("server:leaseReaper");

const REAP_INTERVAL_MS = 60_000; // check every 60s
const GRACE_PERIOD_MS = 5 * 60_000; // 5 min past lease expiry before reaping

let timer: ReturnType<typeof setInterval> | null = null;
let slackPoster: SlackPoster | null = null;

export function startLeaseReaper(poster?: SlackPoster) {
  slackPoster = poster || null;
  if (timer) return;

  timer = setInterval(reapStaleJobs, REAP_INTERVAL_MS);
  log.info("Lease reaper started", { intervalMs: REAP_INTERVAL_MS, graceMs: GRACE_PERIOD_MS });
}

export function stopLeaseReaper() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function reapStaleJobs() {
  try {
    const col = getJobsCollection();
    const now = nowDate();
    const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);

    const staleJobs = (await col
      .find({
        status: { $in: ["RUNNING", "FIXING_CI"] as JobStatus[] },
        lease_expires_at: { $lt: cutoff },
      })
      .toArray()) as JobDoc[];

    for (const job of staleJobs) {
      const result = await col.findOneAndUpdate(
        {
          task_id: job.task_id,
          status: { $in: ["RUNNING", "FIXING_CI"] },
          lease_expires_at: { $lt: cutoff },
        },
        {
          $set: {
            status: "FAILED" as JobStatus,
            run_ended_at: now,
            updated_at: now,
            error: {
              code: "LEASE_EXPIRED",
              message: `Job reaped: lease expired at ${job.lease_expires_at?.toISOString()} (${Math.round((now.getTime() - (job.lease_expires_at?.getTime() || 0)) / 1000)}s ago). Worker may have crashed.`,
            },
          },
          $push: {
            events: { at: now, type: "REAPED", payload: { reason: "lease_expired" } },
          } as any,
          $unset: { claimed_by: "", lease_expires_at: "" },
        },
        { returnDocument: "after" },
      );

      if (result) {
        log.warn("Reaped stale job", {
          task_id: job.task_id,
          claimed_by: job.claimed_by,
          lease_expired_at: job.lease_expires_at?.toISOString(),
        });

        if (slackPoster && result.slack?.channel_id && result.slack?.thread_ts) {
          try {
            await slackPoster.postFailed(result);
          } catch {
            /* best-effort */
          }
        }
      }
    }

    if (staleJobs.length > 0) {
      log.info("Lease reaper cycle complete", { reaped: staleJobs.length });
    }
  } catch (err: any) {
    log.error("Lease reaper error", { error: err.message });
  }
}
