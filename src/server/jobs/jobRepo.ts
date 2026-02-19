import type { Filter, Sort } from "mongodb";
import { createLogger } from "../../shared/logger.js";
import { addSeconds, nowDate } from "../../shared/time.js";
import type {
  CIInfo,
  JobDoc,
  JobError,
  JobMetrics,
  JobStatus,
  WebJobsQuery,
} from "../../shared/types.js";
import { getJobsCollection } from "../mongo.js";

const _log = createLogger("server:jobRepo");

export async function insertJob(doc: JobDoc): Promise<JobDoc> {
  const col = getJobsCollection();
  await col.insertOne(doc as any);
  return doc;
}

export async function findJobByTaskId(taskId: string): Promise<JobDoc | null> {
  const col = getJobsCollection();
  return col.findOne({ task_id: taskId }) as Promise<JobDoc | null>;
}

export async function findJobByEventId(eventId: string): Promise<JobDoc | null> {
  const col = getJobsCollection();
  return col.findOne({ "source.event_id": eventId }) as Promise<JobDoc | null>;
}

export async function findPollableJobs(requestedBy: string, limit: number): Promise<JobDoc[]> {
  const col = getJobsCollection();
  const now = nowDate();
  const filter: Filter<JobDoc> = {
    requested_by: requestedBy,
    $or: [
      {
        status: "QUEUED",
        $or: [{ not_before: { $exists: false } }, { not_before: { $lte: now } }],
      },
      {
        status: { $in: ["RUNNING", "FIXING_CI"] },
        lease_expires_at: { $lt: now },
      },
    ],
  };
  return col.find(filter).sort({ created_at: 1 }).limit(limit).toArray() as Promise<JobDoc[]>;
}

export async function atomicClaim(
  taskId: string,
  requestedBy: string,
  nodeId: string,
  leaseSeconds: number,
): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const now = nowDate();
  const leaseExpires = addSeconds(now, leaseSeconds);

  const result = await col.findOneAndUpdate(
    {
      task_id: taskId,
      requested_by: requestedBy,
      $or: [
        { status: "QUEUED" },
        {
          status: { $in: ["RUNNING", "FIXING_CI"] },
          lease_expires_at: { $lt: now },
        },
      ],
    },
    {
      $set: {
        status: "RUNNING" as JobStatus,
        claimed_by: nodeId,
        lease_expires_at: leaseExpires,
        heartbeat_at: now,
        updated_at: now,
      },
      $inc: { attempt: 1 },
      $unset: { not_before: "" },
      $setOnInsert: { run_started_at: now },
    },
    { returnDocument: "after" },
  );

  // $setOnInsert doesn't work on update — use a second pass if run_started_at is not set
  if (result && !result.run_started_at) {
    await col.updateOne(
      { task_id: taskId, run_started_at: { $exists: false } },
      { $set: { run_started_at: now } },
    );
    result.run_started_at = now;
  }

  return result as JobDoc | null;
}

export async function updateHeartbeat(
  taskId: string,
  nodeId: string,
  extendSeconds: number,
): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const now = nowDate();
  const leaseExpires = addSeconds(now, extendSeconds);

  const result = await col.findOneAndUpdate(
    {
      task_id: taskId,
      claimed_by: nodeId,
      status: { $in: ["RUNNING", "FIXING_CI"] },
    },
    {
      $set: {
        lease_expires_at: leaseExpires,
        heartbeat_at: now,
        updated_at: now,
      },
    },
    { returnDocument: "after" },
  );

  return result as JobDoc | null;
}

export async function appendEvent(
  taskId: string,
  event: { at: Date; node_id?: string; type: string; payload?: any },
): Promise<void> {
  const col = getJobsCollection();
  // Truncate payload if too large (safely handle slice breaking JSON)
  let payload = event.payload;
  if (payload) {
    try {
      const serialized = JSON.stringify(payload);
      payload =
        serialized.length > 10000
          ? { _truncated: true, preview: serialized.slice(0, 2000) }
          : payload;
    } catch {
      payload = { _error: "unserializable payload" };
    }
  }

  await col.updateOne(
    { task_id: taskId },
    {
      $push: { events: { ...event, payload } } as any,
      $set: { updated_at: nowDate() },
    },
  );
}

export async function updateJobFields(
  taskId: string,
  fields: Partial<JobDoc>,
): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const result = await col.findOneAndUpdate(
    { task_id: taskId },
    { $set: { ...fields, updated_at: nowDate() } },
    { returnDocument: "after" },
  );
  return result as JobDoc | null;
}

interface TransitionData {
  result_summary: string;
  pr_urls?: string[];
  ci?: CIInfo;
  metrics?: JobMetrics;
}

/** Shared helper: transition an active job to a target status, clearing the lease. */
async function transitionJob(
  taskId: string,
  nodeId: string,
  targetStatus: JobStatus,
  data: TransitionData,
): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const now = nowDate();
  const result = await col.findOneAndUpdate(
    {
      task_id: taskId,
      claimed_by: nodeId,
      status: { $in: ["RUNNING", "FIXING_CI"] },
    },
    {
      $set: {
        status: targetStatus,
        result_summary: data.result_summary,
        ...(data.pr_urls ? { pr_urls: data.pr_urls } : {}),
        ...(data.ci ? { ci: data.ci } : {}),
        ...(data.metrics ? { metrics: data.metrics } : {}),
        run_ended_at: now,
        updated_at: now,
      },
      $unset: { claimed_by: "", lease_expires_at: "" },
    },
    { returnDocument: "after" },
  );
  return result as JobDoc | null;
}

export function completeJob(
  taskId: string,
  nodeId: string,
  data: TransitionData,
): Promise<JobDoc | null> {
  return transitionJob(taskId, nodeId, "DONE", data);
}

export function awaitApprovalJob(
  taskId: string,
  nodeId: string,
  data: TransitionData,
): Promise<JobDoc | null> {
  return transitionJob(taskId, nodeId, "WAITING_FOR_APPROVAL", data);
}

export async function promoteJob(taskId: string): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const now = nowDate();
  const result = await col.findOneAndUpdate(
    { task_id: taskId, status: "WAITING_FOR_APPROVAL" },
    { $set: { status: "DONE" as JobStatus, updated_at: now } },
    { returnDocument: "after" },
  );
  return result as JobDoc | null;
}

export async function failJob(
  taskId: string,
  nodeId: string,
  data: { error: JobError; pr_urls?: string[]; ci?: CIInfo; metrics?: JobMetrics },
): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const now = nowDate();
  const result = await col.findOneAndUpdate(
    {
      task_id: taskId,
      claimed_by: nodeId,
      status: { $in: ["RUNNING", "FIXING_CI", "QUEUED"] },
    },
    {
      $set: {
        status: "FAILED" as JobStatus,
        error: data.error,
        ...(data.pr_urls ? { pr_urls: data.pr_urls } : {}),
        ...(data.ci ? { ci: data.ci } : {}),
        ...(data.metrics ? { metrics: data.metrics } : {}),
        run_ended_at: now,
        updated_at: now,
      },
      $unset: { claimed_by: "", lease_expires_at: "" },
    },
    { returnDocument: "after" },
  );
  return result as JobDoc | null;
}

export async function requeueJob(
  taskId: string,
  nodeId: string,
  notBefore?: Date,
): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const now = nowDate();
  const result = await col.findOneAndUpdate(
    {
      task_id: taskId,
      claimed_by: nodeId,
      status: { $in: ["RUNNING", "FIXING_CI"] },
    },
    {
      $set: {
        status: "QUEUED" as JobStatus,
        updated_at: now,
        ...(notBefore ? { not_before: notBefore } : {}),
      },
      $unset: { claimed_by: "", lease_expires_at: "", heartbeat_at: "" },
    },
    { returnDocument: "after" },
  );
  return result as JobDoc | null;
}

export async function cancelJob(taskId: string): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const now = nowDate();
  const result = await col.findOneAndUpdate(
    {
      task_id: taskId,
      status: { $nin: ["DONE", "FAILED", "CANCELED", "DELETED"] },
    },
    {
      $set: {
        status: "CANCELED" as JobStatus,
        run_ended_at: now,
        updated_at: now,
      },
    },
    { returnDocument: "after" },
  );
  return result as JobDoc | null;
}

export async function softDeleteJob(taskId: string): Promise<JobDoc | null> {
  const col = getJobsCollection();
  const result = await col.findOneAndUpdate(
    {
      task_id: taskId,
      status: { $nin: ["RUNNING", "FIXING_CI"] },
    },
    {
      $set: {
        status: "DELETED" as JobStatus,
        updated_at: nowDate(),
      },
    },
    { returnDocument: "after" },
  );
  return result as JobDoc | null;
}

export async function queryJobs(query: WebJobsQuery): Promise<{ jobs: JobDoc[]; total: number }> {
  const col = getJobsCollection();
  const filter: Filter<JobDoc> = {};

  // Exclude DELETED by default
  if (query.status) {
    filter.status = query.status as any;
  } else {
    filter.status = { $ne: "DELETED" } as any;
  }

  if (query.requested_by) {
    filter.requested_by = query.requested_by;
  }

  if (query.q) {
    const regex = { $regex: query.q, $options: "i" };
    filter.$or = [{ task_text: regex }, { task_id: regex }, { title: regex }];
  }

  const limit = Math.min(query.limit || 50, 200);
  const offset = query.offset || 0;

  const ALLOWED_SORT_FIELDS = ["created_at", "updated_at", "status", "requested_by"];
  const sortField = ALLOWED_SORT_FIELDS.includes(query.sort_by || "")
    ? query.sort_by!
    : "created_at";
  const sortOrder = query.sort_order === "asc" ? 1 : -1;
  const sort: Sort = { [sortField]: sortOrder };

  const [jobs, total] = await Promise.all([
    col.find(filter).sort(sort).skip(offset).limit(limit).toArray() as Promise<JobDoc[]>,
    col.countDocuments(filter),
  ]);

  return { jobs, total };
}

export async function getDistinctRequestedBy(): Promise<string[]> {
  const col = getJobsCollection();
  return col.distinct("requested_by", { status: { $ne: "DELETED" } });
}
