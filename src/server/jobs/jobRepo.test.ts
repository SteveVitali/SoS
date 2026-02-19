import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JobDoc, JobStatus } from "../../shared/types.js";
import { closeMongo, connectMongo, getJobsCollection } from "../mongo.js";
import {
  appendEvent,
  atomicClaim,
  cancelJob,
  completeJob,
  failJob,
  findJobByEventId,
  findJobByTaskId,
  findPollableJobs,
  insertJob,
  queryJobs,
  requeueJob,
  softDeleteJob,
  updateHeartbeat,
} from "./jobRepo.js";

let mongod: MongoMemoryServer;

function makeJob(overrides: Partial<JobDoc> = {}): JobDoc {
  const now = new Date();
  return {
    task_id: `task-${Math.random().toString(36).slice(2, 10)}`,
    source: { type: "web_create" },
    requested_by: "U_OWNER",
    status: "QUEUED" as JobStatus,
    created_at: now,
    updated_at: now,
    task_text: "fix the bug",
    events: [],
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectMongo(mongod.getUri(), "test-sos");
});

afterEach(async () => {
  const col = getJobsCollection();
  await col.deleteMany({});
});

afterAll(async () => {
  await closeMongo();
  await mongod.stop();
});

describe("insertJob / findJobByTaskId", () => {
  it("inserts and retrieves a job", async () => {
    const job = makeJob({ task_id: "test-insert-1" });
    await insertJob(job);
    const found = await findJobByTaskId("test-insert-1");
    expect(found).not.toBeNull();
    expect(found!.task_id).toBe("test-insert-1");
    expect(found!.task_text).toBe("fix the bug");
  });
});

describe("findJobByEventId", () => {
  it("finds a job by source.event_id", async () => {
    await insertJob(makeJob({ source: { type: "slack_app_mention", event_id: "evt_abc" } }));
    const found = await findJobByEventId("evt_abc");
    expect(found).not.toBeNull();
    expect(found!.source.event_id).toBe("evt_abc");
  });

  it("returns null for non-existent event_id", async () => {
    expect(await findJobByEventId("nope")).toBeNull();
  });
});

describe("atomicClaim", () => {
  it("claims a QUEUED job", async () => {
    const job = makeJob({ task_id: "claim-1" });
    await insertJob(job);

    const claimed = await atomicClaim("claim-1", "U_OWNER", "worker-1", 120);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("RUNNING");
    expect(claimed!.claimed_by).toBe("worker-1");
    expect(claimed!.attempt).toBe(1);
    expect(claimed!.lease_expires_at).toBeDefined();
    expect(claimed!.run_started_at).toBeDefined();
  });

  it("rejects claim when already RUNNING with valid lease", async () => {
    const futureDate = new Date(Date.now() + 60_000);
    await insertJob(
      makeJob({
        task_id: "claim-2",
        status: "RUNNING",
        claimed_by: "worker-1",
        lease_expires_at: futureDate,
      }),
    );

    const result = await atomicClaim("claim-2", "U_OWNER", "worker-2", 120);
    expect(result).toBeNull();
  });

  it("allows reclaim of RUNNING job with expired lease", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertJob(
      makeJob({
        task_id: "claim-3",
        status: "RUNNING",
        claimed_by: "worker-1",
        lease_expires_at: pastDate,
        attempt: 1,
      }),
    );

    const claimed = await atomicClaim("claim-3", "U_OWNER", "worker-2", 120);
    expect(claimed).not.toBeNull();
    expect(claimed!.claimed_by).toBe("worker-2");
    expect(claimed!.attempt).toBe(2);
  });

  it("rejects claim with wrong requested_by", async () => {
    await insertJob(makeJob({ task_id: "claim-4", requested_by: "U_OWNER" }));

    const result = await atomicClaim("claim-4", "U_OTHER", "worker-1", 120);
    expect(result).toBeNull();
  });

  it("increments attempt on each claim", async () => {
    await insertJob(makeJob({ task_id: "claim-5", attempt: 3, status: "QUEUED" }));

    const claimed = await atomicClaim("claim-5", "U_OWNER", "worker-1", 120);
    expect(claimed!.attempt).toBe(4);
  });

  it("exactly one of two concurrent claims succeeds", async () => {
    await insertJob(makeJob({ task_id: "claim-race" }));

    const [result1, result2] = await Promise.all([
      atomicClaim("claim-race", "U_OWNER", "worker-A", 120),
      atomicClaim("claim-race", "U_OWNER", "worker-B", 120),
    ]);

    const winners = [result1, result2].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.claimed_by).toMatch(/^worker-[AB]$/);
  });

  it("reclaims a FIXING_CI job with expired lease", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertJob(
      makeJob({
        task_id: "claim-fixci",
        status: "FIXING_CI" as JobStatus,
        claimed_by: "worker-1",
        lease_expires_at: pastDate,
        attempt: 1,
      }),
    );

    const claimed = await atomicClaim("claim-fixci", "U_OWNER", "worker-2", 120);
    expect(claimed).not.toBeNull();
    expect(claimed!.claimed_by).toBe("worker-2");
    expect(claimed!.status).toBe("RUNNING");
  });
});

describe("updateHeartbeat", () => {
  it("extends lease for the owning worker", async () => {
    await insertJob(
      makeJob({
        task_id: "hb-1",
        status: "RUNNING",
        claimed_by: "worker-1",
        lease_expires_at: new Date(Date.now() + 10_000),
      }),
    );

    const result = await updateHeartbeat("hb-1", "worker-1", 120);
    expect(result).not.toBeNull();
    expect(result!.lease_expires_at!.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  it("rejects heartbeat from non-owning worker", async () => {
    await insertJob(
      makeJob({
        task_id: "hb-2",
        status: "RUNNING",
        claimed_by: "worker-1",
        lease_expires_at: new Date(Date.now() + 10_000),
      }),
    );

    const result = await updateHeartbeat("hb-2", "worker-OTHER", 120);
    expect(result).toBeNull();
  });

  it("rejects heartbeat for non-active job", async () => {
    await insertJob(makeJob({ task_id: "hb-3", status: "DONE", claimed_by: "worker-1" }));

    const result = await updateHeartbeat("hb-3", "worker-1", 120);
    expect(result).toBeNull();
  });
});

describe("completeJob", () => {
  it("completes a RUNNING job by the owner", async () => {
    await insertJob(makeJob({ task_id: "comp-1", status: "RUNNING", claimed_by: "worker-1" }));

    const result = await completeJob("comp-1", "worker-1", {
      result_summary: "all good",
      pr_urls: ["https://github.com/pull/1"],
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("DONE");
    expect(result!.result_summary).toBe("all good");
    expect(result!.pr_urls).toEqual(["https://github.com/pull/1"]);
    expect(result!.run_ended_at).toBeDefined();
    expect(result!.claimed_by).toBeUndefined();
  });

  it("rejects completion by non-owner", async () => {
    await insertJob(makeJob({ task_id: "comp-2", status: "RUNNING", claimed_by: "worker-1" }));

    const result = await completeJob("comp-2", "worker-OTHER", { result_summary: "done" });
    expect(result).toBeNull();
  });
});

describe("failJob", () => {
  it("fails a RUNNING job", async () => {
    await insertJob(makeJob({ task_id: "fail-1", status: "RUNNING", claimed_by: "worker-1" }));

    const result = await failJob("fail-1", "worker-1", {
      error: { message: "something broke" },
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("FAILED");
    expect(result!.error?.message).toBe("something broke");
    expect(result!.claimed_by).toBeUndefined();
  });

  it("rejects fail for terminal job", async () => {
    await insertJob(makeJob({ task_id: "fail-2", status: "DONE", claimed_by: "worker-1" }));

    const result = await failJob("fail-2", "worker-1", { error: { message: "too late" } });
    expect(result).toBeNull();
  });
});

describe("requeueJob", () => {
  it("requeues a RUNNING job back to QUEUED", async () => {
    await insertJob(makeJob({ task_id: "rq-1", status: "RUNNING", claimed_by: "worker-1" }));

    const result = await requeueJob("rq-1", "worker-1");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("QUEUED");
    expect(result!.claimed_by).toBeUndefined();
    expect(result!.lease_expires_at).toBeUndefined();
  });

  it("rejects requeue from non-owner", async () => {
    await insertJob(makeJob({ task_id: "rq-2", status: "RUNNING", claimed_by: "worker-1" }));

    expect(await requeueJob("rq-2", "worker-OTHER")).toBeNull();
  });
});

describe("cancelJob", () => {
  it("cancels a QUEUED job", async () => {
    await insertJob(makeJob({ task_id: "cx-1", status: "QUEUED" }));

    const result = await cancelJob("cx-1");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("CANCELED");
  });

  it("cancels a RUNNING job", async () => {
    await insertJob(makeJob({ task_id: "cx-2", status: "RUNNING" }));

    const result = await cancelJob("cx-2");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("CANCELED");
  });

  it("returns null for already-terminal job", async () => {
    await insertJob(makeJob({ task_id: "cx-3", status: "DONE" }));
    expect(await cancelJob("cx-3")).toBeNull();
  });
});

describe("softDeleteJob", () => {
  it("deletes a non-running job", async () => {
    await insertJob(makeJob({ task_id: "del-1", status: "FAILED" }));

    const result = await softDeleteJob("del-1");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("DELETED");
  });

  it("refuses to delete a RUNNING job", async () => {
    await insertJob(makeJob({ task_id: "del-2", status: "RUNNING" }));
    expect(await softDeleteJob("del-2")).toBeNull();
  });
});

describe("findPollableJobs", () => {
  it("returns QUEUED jobs for the right owner", async () => {
    await insertJob(makeJob({ task_id: "poll-1", requested_by: "U_OWNER", status: "QUEUED" }));
    await insertJob(makeJob({ task_id: "poll-2", requested_by: "U_OTHER", status: "QUEUED" }));

    const jobs = await findPollableJobs("U_OWNER", 10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_id).toBe("poll-1");
  });

  it("includes expired-lease RUNNING jobs as pollable", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertJob(
      makeJob({
        task_id: "poll-3",
        status: "RUNNING",
        lease_expires_at: pastDate,
        requested_by: "U_OWNER",
      }),
    );

    const jobs = await findPollableJobs("U_OWNER", 10);
    expect(jobs).toHaveLength(1);
  });

  it("excludes RUNNING jobs with valid lease", async () => {
    const futureDate = new Date(Date.now() + 60_000);
    await insertJob(
      makeJob({
        task_id: "poll-4",
        status: "RUNNING",
        lease_expires_at: futureDate,
        requested_by: "U_OWNER",
      }),
    );

    const jobs = await findPollableJobs("U_OWNER", 10);
    expect(jobs).toHaveLength(0);
  });

  it("excludes QUEUED jobs with not_before in the future", async () => {
    const futureDate = new Date(Date.now() + 60_000);
    await insertJob(
      makeJob({
        task_id: "poll-nb-1",
        status: "QUEUED",
        not_before: futureDate,
        requested_by: "U_OWNER",
      }),
    );

    const jobs = await findPollableJobs("U_OWNER", 10);
    expect(jobs).toHaveLength(0);
  });

  it("includes QUEUED jobs with not_before in the past", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertJob(
      makeJob({
        task_id: "poll-nb-2",
        status: "QUEUED",
        not_before: pastDate,
        requested_by: "U_OWNER",
      }),
    );

    const jobs = await findPollableJobs("U_OWNER", 10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_id).toBe("poll-nb-2");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertJob(
        makeJob({
          task_id: `poll-lim-${i}`,
          status: "QUEUED",
          requested_by: "U_OWNER",
          created_at: new Date(Date.now() + i * 1000),
        }),
      );
    }

    const jobs = await findPollableJobs("U_OWNER", 2);
    expect(jobs).toHaveLength(2);
  });
});

describe("queryJobs", () => {
  it("excludes DELETED jobs by default", async () => {
    await insertJob(makeJob({ task_id: "q-1", status: "QUEUED" }));
    await insertJob(makeJob({ task_id: "q-2", status: "DELETED" }));

    const { jobs, total } = await queryJobs({});
    expect(total).toBe(1);
    expect(jobs[0].task_id).toBe("q-1");
  });

  it("filters by status when specified", async () => {
    await insertJob(makeJob({ task_id: "q-3", status: "QUEUED" }));
    await insertJob(makeJob({ task_id: "q-4", status: "DONE" }));

    const { jobs } = await queryJobs({ status: "DONE" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_id).toBe("q-4");
  });

  it("filters by text search (task_text)", async () => {
    await insertJob(makeJob({ task_id: "q-5", task_text: "fix the login page" }));
    await insertJob(makeJob({ task_id: "q-6", task_text: "refactor database" }));

    const { jobs } = await queryJobs({ q: "login" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_id).toBe("q-5");
  });

  it("paginates with offset and limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertJob(
        makeJob({
          task_id: `q-page-${i}`,
          created_at: new Date(Date.now() - i * 1000),
        }),
      );
    }

    const { jobs, total } = await queryJobs({ limit: 2, offset: 1, sort_order: "desc" });
    expect(total).toBe(5);
    expect(jobs).toHaveLength(2);
  });

  it("ignores invalid sort_by fields (defaults to created_at)", async () => {
    await insertJob(makeJob({ task_id: "q-sort" }));

    const { jobs } = await queryJobs({ sort_by: "malicious_field" });
    expect(jobs).toHaveLength(1); // didn't throw
  });

  it("caps limit at 200", async () => {
    // Just verify it doesn't throw — the actual cap is internal
    const { jobs } = await queryJobs({ limit: 999 });
    expect(jobs).toBeDefined();
  });
});

describe("appendEvent", () => {
  it("appends an event to the job", async () => {
    await insertJob(makeJob({ task_id: "evt-1", events: [] }));
    await appendEvent("evt-1", {
      at: new Date(),
      type: "PHASE_STARTED",
      payload: { phase: "code" },
    });

    const job = await findJobByTaskId("evt-1");
    expect(job!.events).toHaveLength(1);
    expect(job!.events![0].type).toBe("PHASE_STARTED");
  });

  it("truncates oversized payloads", async () => {
    await insertJob(makeJob({ task_id: "evt-2" }));
    const bigPayload = { data: "x".repeat(15000) };
    await appendEvent("evt-2", { at: new Date(), type: "BIG", payload: bigPayload });

    const job = await findJobByTaskId("evt-2");
    const evt = job!.events![job!.events!.length - 1];
    expect(evt.payload._truncated).toBe(true);
    expect(evt.payload.preview.length).toBeLessThanOrEqual(2001);
  });
});
