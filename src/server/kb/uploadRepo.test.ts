import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UploadJob } from "../../shared/kbTypes.js";
import { _setTestDb } from "../mongo.js";
import {
  completeUploadJob,
  createUploadJob,
  deleteUploadJobsForKB,
  ensureUploadJobIndexes,
  failUploadJob,
  getActiveUploadsForKB,
  getAllActiveUploads,
  getRecentUploadsForKB,
  getUploadJob,
  updateUploadFileStatus,
} from "./uploadRepo.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test_upload_repo");
  _setTestDb(db);
  await ensureUploadJobIndexes();
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  await db.collection("kb_upload_jobs").deleteMany({});
});

describe("uploadRepo", () => {
  describe("createUploadJob", () => {
    it("creates a job with all files as pending", async () => {
      const job = await createUploadJob("kb-1", ["file1.txt", "file2.pdf"]);

      expect(job.job_id).toBeTruthy();
      expect(job.kb_id).toBe("kb-1");
      expect(job.status).toBe("processing");
      expect(job.files).toHaveLength(2);
      expect(job.files[0]).toEqual({ name: "file1.txt", status: "pending" });
      expect(job.files[1]).toEqual({ name: "file2.pdf", status: "pending" });
      expect(job.created_at).toBeInstanceOf(Date);
      expect(job.updated_at).toBeInstanceOf(Date);
    });

    it("persists to MongoDB", async () => {
      const job = await createUploadJob("kb-1", ["test.txt"]);
      const found = await getUploadJob(job.job_id);

      expect(found).not.toBeNull();
      expect(found!.job_id).toBe(job.job_id);
      expect(found!.kb_id).toBe("kb-1");
    });
  });

  describe("updateUploadFileStatus", () => {
    it("updates a file to processing", async () => {
      const job = await createUploadJob("kb-1", ["a.txt", "b.txt"]);
      await updateUploadFileStatus(job.job_id, "a.txt", "processing");

      const updated = await getUploadJob(job.job_id);
      expect(updated!.files[0].status).toBe("processing");
      expect(updated!.files[1].status).toBe("pending");
    });

    it("updates a file to done with chunk count", async () => {
      const job = await createUploadJob("kb-1", ["a.txt"]);
      await updateUploadFileStatus(job.job_id, "a.txt", "done", { chunks: 12 });

      const updated = await getUploadJob(job.job_id);
      expect(updated!.files[0].status).toBe("done");
      expect(updated!.files[0].chunks).toBe(12);
    });

    it("updates a file to error with message", async () => {
      const job = await createUploadJob("kb-1", ["a.txt"]);
      await updateUploadFileStatus(job.job_id, "a.txt", "error", {
        error: "parse failed",
      });

      const updated = await getUploadJob(job.job_id);
      expect(updated!.files[0].status).toBe("error");
      expect(updated!.files[0].error).toBe("parse failed");
    });

    it("updates a file to skipped with reason", async () => {
      const job = await createUploadJob("kb-1", ["img.png"]);
      await updateUploadFileStatus(job.job_id, "img.png", "skipped", {
        skip_reason: "unsupported format",
      });

      const updated = await getUploadJob(job.job_id);
      expect(updated!.files[0].status).toBe("skipped");
      expect(updated!.files[0].skip_reason).toBe("unsupported format");
    });
  });

  describe("completeUploadJob", () => {
    it("marks job as completed with summary", async () => {
      const job = await createUploadJob("kb-1", ["a.txt"]);
      await completeUploadJob(job.job_id, {
        documents_added: 1,
        chunks_added: 5,
        skipped: 0,
        errors: 0,
      });

      const updated = await getUploadJob(job.job_id);
      expect(updated!.status).toBe("completed");
      expect(updated!.summary).toEqual({
        documents_added: 1,
        chunks_added: 5,
        skipped: 0,
        errors: 0,
      });
    });
  });

  describe("failUploadJob", () => {
    it("marks job as failed", async () => {
      const job = await createUploadJob("kb-1", ["a.txt"]);
      await failUploadJob(job.job_id, "fatal error");

      const updated = await getUploadJob(job.job_id);
      expect(updated!.status).toBe("failed");
    });
  });

  describe("query functions", () => {
    beforeEach(async () => {
      // Create a mix of jobs
      const j1 = await createUploadJob("kb-1", ["a.txt"]);
      const j2 = await createUploadJob("kb-1", ["b.txt"]);
      await completeUploadJob(j1.job_id, {
        documents_added: 1,
        chunks_added: 3,
        skipped: 0,
        errors: 0,
      });
      // j2 stays processing
      await createUploadJob("kb-2", ["c.txt"]); // processing
    });

    it("getActiveUploadsForKB returns only processing jobs", async () => {
      const active = await getActiveUploadsForKB("kb-1");
      expect(active).toHaveLength(1);
      expect(active[0].files[0].name).toBe("b.txt");
    });

    it("getRecentUploadsForKB returns all jobs for the KB", async () => {
      const recent = await getRecentUploadsForKB("kb-1");
      expect(recent).toHaveLength(2);
    });

    it("getAllActiveUploads returns processing jobs across all KBs", async () => {
      const active = await getAllActiveUploads();
      expect(active).toHaveLength(2); // one from kb-1, one from kb-2
      expect(active.every((j) => j.status === "processing")).toBe(true);
    });
  });

  describe("deleteUploadJobsForKB", () => {
    it("deletes all jobs for a KB", async () => {
      await createUploadJob("kb-1", ["a.txt"]);
      await createUploadJob("kb-1", ["b.txt"]);
      await createUploadJob("kb-2", ["c.txt"]);

      await deleteUploadJobsForKB("kb-1");

      const kb1Jobs = await getRecentUploadsForKB("kb-1");
      const kb2Jobs = await getRecentUploadsForKB("kb-2");
      expect(kb1Jobs).toHaveLength(0);
      expect(kb2Jobs).toHaveLength(1);
    });
  });

  describe("full lifecycle", () => {
    it("tracks a multi-file upload from creation to completion", async () => {
      const job = await createUploadJob("kb-1", ["doc1.md", "doc2.pdf", "image.png"]);

      // Start processing file 1
      await updateUploadFileStatus(job.job_id, "doc1.md", "processing");
      let current = await getUploadJob(job.job_id);
      expect(current!.files.filter((f) => f.status === "processing")).toHaveLength(1);
      expect(current!.files.filter((f) => f.status === "pending")).toHaveLength(2);

      // File 1 done
      await updateUploadFileStatus(job.job_id, "doc1.md", "done", { chunks: 8 });

      // File 2 processing then done
      await updateUploadFileStatus(job.job_id, "doc2.pdf", "processing");
      await updateUploadFileStatus(job.job_id, "doc2.pdf", "done", { chunks: 3 });

      // File 3 skipped
      await updateUploadFileStatus(job.job_id, "image.png", "skipped", {
        skip_reason: "unsupported or empty",
      });

      // Complete
      await completeUploadJob(job.job_id, {
        documents_added: 2,
        chunks_added: 11,
        skipped: 1,
        errors: 0,
      });

      current = await getUploadJob(job.job_id);
      expect(current!.status).toBe("completed");
      expect(current!.files[0]).toMatchObject({ name: "doc1.md", status: "done", chunks: 8 });
      expect(current!.files[1]).toMatchObject({ name: "doc2.pdf", status: "done", chunks: 3 });
      expect(current!.files[2]).toMatchObject({
        name: "image.png",
        status: "skipped",
        skip_reason: "unsupported or empty",
      });
      expect(current!.summary).toEqual({
        documents_added: 2,
        chunks_added: 11,
        skipped: 1,
        errors: 0,
      });

      // Should no longer appear in active uploads
      const active = await getActiveUploadsForKB("kb-1");
      expect(active).toHaveLength(0);
    });
  });
});
