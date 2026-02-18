import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";
import { atomicClaim, updateHeartbeat } from "./jobRepo.js";

const log = createLogger("server:lease");

export async function claimJob(
  taskId: string,
  requestedBy: string,
  nodeId: string,
  leaseSeconds: number,
): Promise<JobDoc | null> {
  const job = await atomicClaim(taskId, requestedBy, nodeId, leaseSeconds);
  if (job) {
    log.info("Job claimed", { task_id: taskId, node_id: nodeId, attempt: job.attempt });
  } else {
    log.info("Claim failed (already claimed or not eligible)", {
      task_id: taskId,
      node_id: nodeId,
    });
  }
  return job;
}

export async function extendLease(
  taskId: string,
  nodeId: string,
  extendSeconds: number,
): Promise<JobDoc | null> {
  const job = await updateHeartbeat(taskId, nodeId, extendSeconds);
  if (!job) {
    log.warn("Heartbeat rejected (not owner or not active)", { task_id: taskId, node_id: nodeId });
  }
  return job;
}
