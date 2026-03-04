/**
 * MongoDB repository for upload job tracking.
 * Persists per-file ingestion state so progress survives page refreshes
 * and navigation between the KB listing and detail pages.
 */

import type { Collection } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import type { UploadFileState, UploadJob } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getDb } from "../mongo.js";

const log = createLogger("server:kb:uploadRepo");

const COLLECTION = "kb_upload_jobs";

function col(): Collection<UploadJob> {
  return getDb().collection<UploadJob>(COLLECTION);
}

/**
 * Ensure indexes on the kb_upload_jobs collection.
 * Called once during server startup.
 */
export async function ensureUploadJobIndexes(): Promise<void> {
  const c = col();
  await c.createIndex({ job_id: 1 }, { unique: true, name: "idx_upload_job_id_unique" });
  await c.createIndex({ kb_id: 1, status: 1 }, { name: "idx_upload_kb_status" });
  await c.createIndex({ status: 1 }, { name: "idx_upload_status" });
  // Auto-clean completed/failed jobs after 24 hours
  await c.createIndex({ updated_at: 1 }, { expireAfterSeconds: 86400, name: "idx_upload_ttl" });
  log.info("Upload job indexes ensured");
}

/**
 * Create a new upload job with all files initially in "pending" state.
 */
export async function createUploadJob(kbId: string, fileNames: string[]): Promise<UploadJob> {
  const job: UploadJob = {
    job_id: uuidv4(),
    kb_id: kbId,
    status: "processing",
    files: fileNames.map((name) => ({ name, status: "pending" })),
    created_at: new Date(),
    updated_at: new Date(),
  };
  await col().insertOne(job);
  log.info("Upload job created", { job_id: job.job_id, kb_id: kbId, files: fileNames.length });
  return job;
}

/**
 * Update a single file's status within an upload job.
 */
export async function updateUploadFileStatus(
  jobId: string,
  fileName: string,
  status: UploadFileState,
  extra?: { chunks?: number; error?: string; skip_reason?: string },
): Promise<void> {
  const setFields: Record<string, unknown> = {
    "files.$[f].status": status,
    updated_at: new Date(),
  };
  if (extra?.chunks !== undefined) setFields["files.$[f].chunks"] = extra.chunks;
  if (extra?.error !== undefined) setFields["files.$[f].error"] = extra.error;
  if (extra?.skip_reason !== undefined) setFields["files.$[f].skip_reason"] = extra.skip_reason;

  await col().updateOne(
    { job_id: jobId },
    { $set: setFields },
    { arrayFilters: [{ "f.name": fileName }] },
  );
}

/**
 * Mark an upload job as completed with summary stats.
 */
export async function completeUploadJob(
  jobId: string,
  summary: {
    documents_added: number;
    chunks_added: number;
    skipped: number;
    errors: number;
  },
): Promise<void> {
  await col().updateOne(
    { job_id: jobId },
    {
      $set: {
        status: "completed",
        summary,
        updated_at: new Date(),
      },
    },
  );
  log.info("Upload job completed", { job_id: jobId, ...summary });
}

/**
 * Mark an upload job as failed.
 */
export async function failUploadJob(jobId: string, error: string): Promise<void> {
  await col().updateOne(
    { job_id: jobId },
    {
      $set: {
        status: "failed",
        "summary.errors": 1,
        updated_at: new Date(),
      },
    },
  );
  log.warn("Upload job failed", { job_id: jobId, error });
}

/**
 * Get a single upload job by ID.
 */
export async function getUploadJob(jobId: string): Promise<UploadJob | null> {
  return col().findOne({ job_id: jobId });
}

/**
 * Get active (processing) upload jobs for a specific KB.
 */
export async function getActiveUploadsForKB(kbId: string): Promise<UploadJob[]> {
  return col().find({ kb_id: kbId, status: "processing" }).sort({ created_at: -1 }).toArray();
}

/**
 * Get recent upload jobs for a KB (active + recently completed/failed).
 */
export async function getRecentUploadsForKB(kbId: string, limit = 10): Promise<UploadJob[]> {
  return col().find({ kb_id: kbId }).sort({ created_at: -1 }).limit(limit).toArray();
}

/**
 * Get all active upload jobs across all KBs.
 * Used by the listing page to show upload badges.
 */
export async function getAllActiveUploads(): Promise<UploadJob[]> {
  return col().find({ status: "processing" }).sort({ created_at: -1 }).toArray();
}

/**
 * Delete all upload jobs for a KB (called when KB is deleted).
 */
export async function deleteUploadJobsForKB(kbId: string): Promise<void> {
  await col().deleteMany({ kb_id: kbId });
}
