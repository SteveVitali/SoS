import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDoc } from "../../shared/types.js";
import { closeMongo, connectMongo, getJobsCollection } from "../mongo.js";
import {
  cancel,
  complete,
  createJobFromSlack,
  createJobFromWeb,
  fail,
  findJobByTaskId,
  handleWorkerEvent,
  requeue,
  retry,
  setSlackPoster,
} from "./jobService.js";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectMongo(mongod.getUri(), "test-jobservice");
  // Ensure no Slack poster is set for most tests
  setSlackPoster(null as any);
});

afterEach(async () => {
  await getJobsCollection().deleteMany({});
});

afterAll(async () => {
  await closeMongo();
  await mongod.stop();
});

describe("createJobFromSlack", () => {
  const baseInput = {
    event_id: "evt_1",
    requested_by: "U_OWNER",
    slack_requester: "U_REQ",
    task_text: "fix the bug",
    channel_id: "C123",
    thread_ts: "1234567890.123456",
  };

  it("creates a new job", async () => {
    const { job, created } = await createJobFromSlack(baseInput);
    expect(created).toBe(true);
    expect(job.status).toBe("QUEUED");
    expect(job.task_id).toBeDefined();
    expect(job.source.event_id).toBe("evt_1");
    expect(job.ci_fix_enabled).toBe(true); // default
  });

  it("returns existing job for duplicate event_id (idempotency)", async () => {
    const first = await createJobFromSlack(baseInput);
    const second = await createJobFromSlack(baseInput);

    expect(second.created).toBe(false);
    expect(second.job.task_id).toBe(first.job.task_id);
  });

  it("sets ci_fix_enabled from input", async () => {
    const { job } = await createJobFromSlack({
      ...baseInput,
      event_id: "evt_ci",
      ci_fix_enabled: false,
    });
    expect(job.ci_fix_enabled).toBe(false);
  });

  it("stores attachments", async () => {
    const { job } = await createJobFromSlack({
      ...baseInput,
      event_id: "evt_att",
      attachments: [
        {
          file_id: "F1",
          filename: "test.png",
          mimetype: "image/png",
          size_bytes: 1024,
          base64: "abc",
        },
      ],
    });
    expect(job.attachments).toHaveLength(1);
    expect(job.attachments![0].filename).toBe("test.png");
  });
});

describe("createJobFromWeb", () => {
  it("creates a web job with correct source type", async () => {
    const job = await createJobFromWeb({
      requested_by: "web-user",
      task_text: "implement feature X",
    });
    expect(job.source.type).toBe("web_create");
    expect(job.status).toBe("QUEUED");
    expect(job.requested_by).toBe("web-user");
  });
});

describe("handleWorkerEvent", () => {
  let jobId: string;

  beforeEach(async () => {
    const { job } = await createJobFromSlack({
      event_id: `evt_${Math.random().toString(36).slice(2)}`,
      requested_by: "U_OWNER",
      task_text: "test job",
      channel_id: "C1",
      thread_ts: "111.222",
    });
    jobId = job.task_id;
  });

  it("appends PR_CREATED URL without duplicates", async () => {
    await handleWorkerEvent(jobId, "w1", "PR_CREATED", {
      url: "https://github.com/pull/1",
    });
    await handleWorkerEvent(jobId, "w1", "PR_CREATED", {
      url: "https://github.com/pull/1",
    });
    await handleWorkerEvent(jobId, "w1", "PR_CREATED", {
      url: "https://github.com/pull/2",
    });

    const job = await findJobByTaskId(jobId);
    expect(job!.pr_urls).toEqual(["https://github.com/pull/1", "https://github.com/pull/2"]);
  });

  it("sets status to FIXING_CI on CI_FIX_STARTED", async () => {
    // First claim the job so it's RUNNING
    const col = getJobsCollection();
    await col.updateOne({ task_id: jobId }, { $set: { status: "RUNNING" } });

    await handleWorkerEvent(jobId, "w1", "CI_FIX_STARTED", {});

    const job = await findJobByTaskId(jobId);
    expect(job!.status).toBe("FIXING_CI");
  });

  it("sets branch_name and worktree_slot on WORKTREE_READY", async () => {
    await handleWorkerEvent(jobId, "w1", "WORKTREE_READY", {
      branch: "sos/fix-bug-abc123",
      worktree_slot: "my-repo-n-1",
    });

    const job = await findJobByTaskId(jobId);
    expect(job!.branch_name).toBe("sos/fix-bug-abc123");
    expect(job!.worktree_slot).toBe("my-repo-n-1");
  });

  it("appends to repos_resolved without duplicates on REPO_RESOLVED", async () => {
    await handleWorkerEvent(jobId, "w1", "REPO_RESOLVED", { repoId: "frontend" });
    await handleWorkerEvent(jobId, "w1", "REPO_RESOLVED", { repoId: "frontend" });

    const job = await findJobByTaskId(jobId);
    expect(job!.repos_resolved).toEqual(["frontend"]);
  });
});

describe("retry", () => {
  it("creates a new job from a FAILED job", async () => {
    const { job: original } = await createJobFromSlack({
      event_id: "evt_retry_1",
      requested_by: "U_OWNER",
      task_text: "fix it",
      channel_id: "C1",
      thread_ts: "111.222",
      repo_hint: "my-repo",
      test_level: "fast",
    });

    // Mark as FAILED
    const col = getJobsCollection();
    await col.updateOne({ task_id: original.task_id }, { $set: { status: "FAILED" } });

    const retried = await retry(original.task_id);
    expect(retried).not.toBeNull();
    expect(retried!.task_id).not.toBe(original.task_id);
    expect(retried!.parent_task_id).toBe(original.task_id);
    expect(retried!.status).toBe("QUEUED");
    expect(retried!.task_text).toBe("fix it");
    expect(retried!.repo_hint).toBe("my-repo");
    expect(retried!.test_level).toBe("fast");
  });

  it("strips event_id from source to avoid idempotency collision", async () => {
    const { job: original } = await createJobFromSlack({
      event_id: "evt_retry_2",
      requested_by: "U_OWNER",
      task_text: "fix it",
      channel_id: "C1",
      thread_ts: "111.222",
    });

    const col = getJobsCollection();
    await col.updateOne({ task_id: original.task_id }, { $set: { status: "FAILED" } });

    const retried = await retry(original.task_id);
    // Should not have event_id (would cause unique index collision on retry)
    expect(retried!.source.event_id).toBeUndefined();
  });

  it("returns null for non-existent job", async () => {
    expect(await retry("nonexistent")).toBeNull();
  });

  it("returns null for RUNNING job (only FAILED/CANCELED eligible)", async () => {
    const { job } = await createJobFromSlack({
      event_id: "evt_retry_3",
      requested_by: "U_OWNER",
      task_text: "fix it",
      channel_id: "C1",
      thread_ts: "111.222",
    });
    const col = getJobsCollection();
    await col.updateOne({ task_id: job.task_id }, { $set: { status: "RUNNING" } });

    expect(await retry(job.task_id)).toBeNull();
  });

  it("retries a CANCELED job", async () => {
    const { job } = await createJobFromSlack({
      event_id: "evt_retry_4",
      requested_by: "U_OWNER",
      task_text: "fix it",
      channel_id: "C1",
      thread_ts: "111.222",
    });
    const col = getJobsCollection();
    await col.updateOne({ task_id: job.task_id }, { $set: { status: "CANCELED" } });

    const retried = await retry(job.task_id);
    expect(retried).not.toBeNull();
    expect(retried!.status).toBe("QUEUED");
  });
});

describe("cancel", () => {
  it("cancels a QUEUED job", async () => {
    const job = await createJobFromWeb({ requested_by: "u1", task_text: "test" });
    const result = await cancel(job.task_id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("CANCELED");
  });

  it("returns null for already-terminal job", async () => {
    const job = await createJobFromWeb({ requested_by: "u1", task_text: "test" });
    await cancel(job.task_id);
    // Cancel again — already CANCELED
    expect(await cancel(job.task_id)).toBeNull();
  });
});

describe("complete / fail", () => {
  it("completes a running job", async () => {
    const job = await createJobFromWeb({ requested_by: "u1", task_text: "test" });
    // Set to RUNNING with a claimed_by
    const col = getJobsCollection();
    await col.updateOne(
      { task_id: job.task_id },
      { $set: { status: "RUNNING", claimed_by: "w1" } },
    );

    const result = await complete(job.task_id, "w1", {
      result_summary: "done",
      pr_urls: ["https://pr"],
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("DONE");

    // Verify DONE event was appended
    const updated = await findJobByTaskId(job.task_id);
    const doneEvent = updated!.events!.find((e: any) => e.type === "DONE");
    expect(doneEvent).toBeDefined();
  });

  it("fails a running job", async () => {
    const job = await createJobFromWeb({ requested_by: "u1", task_text: "test" });
    const col = getJobsCollection();
    await col.updateOne(
      { task_id: job.task_id },
      { $set: { status: "RUNNING", claimed_by: "w1" } },
    );

    const result = await fail(job.task_id, "w1", {
      error: { message: "oops" },
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("FAILED");
  });
});

describe("requeue", () => {
  it("requeues a running job back to QUEUED", async () => {
    const job = await createJobFromWeb({ requested_by: "u1", task_text: "test" });
    const col = getJobsCollection();
    await col.updateOne(
      { task_id: job.task_id },
      { $set: { status: "RUNNING", claimed_by: "w1" } },
    );

    const result = await requeue(job.task_id, "w1", "no worktree available");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("QUEUED");

    // Verify REQUEUED event was appended
    const updated = await findJobByTaskId(job.task_id);
    const rqEvent = updated!.events!.find((e: any) => e.type === "REQUEUED");
    expect(rqEvent).toBeDefined();
    expect(rqEvent!.payload.reason).toBe("no worktree available");
  });
});
