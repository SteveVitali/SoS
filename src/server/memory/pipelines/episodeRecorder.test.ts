import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { _setTestDb } from "../../mongo.js";
import { ensureEpisodeIndexes, findEpisode } from "../episodeRepo.js";
import { recordEpisode } from "./episodeRecorder.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test_episode_recorder");
  _setTestDb(db);
  await ensureEpisodeIndexes();
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  await db.collection("interaction_episodes").deleteMany({});
});

describe("episodeRecorder", () => {
  describe("recordEpisode", () => {
    it("creates an episode and returns the episode_id", async () => {
      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "slack",
        sourceRef: { channel_id: "C123", thread_ts: "111.222" },
        userMessage: "How do I enable strict mode?",
        routedAction: "chat",
        actionArgs: { response: "Here is how..." },
        responseSummary: "Here is how to enable strict mode in TypeScript.",
      });

      expect(episodeId).toBeTruthy();
      expect(typeof episodeId).toBe("string");

      const found = await findEpisode(episodeId);
      expect(found).not.toBeNull();
      expect(found?.owner).toBe("test-owner");
      expect(found?.source).toBe("slack");
      expect(found?.routed_action).toBe("chat");
      expect(found?.extraction_status).toBe("pending");
      expect(found?.signals).toEqual([]);
      expect(found?.extracted_memory_ids).toEqual([]);
    });

    it("truncates response_summary to 500 chars", async () => {
      const longResponse = "A".repeat(600);
      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "web_chat",
        sourceRef: { conversation_id: "conv-1" },
        userMessage: "test",
        routedAction: "chat",
        actionArgs: {},
        responseSummary: longResponse,
      });

      const found = await findEpisode(episodeId);
      expect(found?.response_summary.length).toBeLessThanOrEqual(500);
      expect(found?.response_summary.endsWith("…")).toBe(true);
    });

    it("truncates action_args_summary to 200 chars", async () => {
      const longArgs: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        longArgs[`key_${i}`] = `value_${i}_with_some_padding`;
      }

      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "slack",
        sourceRef: { channel_id: "C123" },
        userMessage: "test",
        routedAction: "create_job",
        actionArgs: longArgs,
        responseSummary: "OK",
      });

      const found = await findEpisode(episodeId);
      expect(found?.action_args_summary.length).toBeLessThanOrEqual(200);
    });

    it("redacts sensitive fields in action args", async () => {
      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "slack",
        sourceRef: { channel_id: "C123" },
        userMessage: "test",
        routedAction: "chat",
        actionArgs: {
          response: "hello",
          api_key: "sk-secret-value",
          password: "supersecret",
        },
        responseSummary: "hello",
      });

      const found = await findEpisode(episodeId);
      expect(found?.action_args_summary).not.toContain("sk-secret-value");
      expect(found?.action_args_summary).not.toContain("supersecret");
      expect(found?.action_args_summary).toContain("[REDACTED]");
    });

    it("maps source_ref fields correctly for Slack", async () => {
      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "slack",
        sourceRef: { channel_id: "C123", thread_ts: "111.222" },
        userMessage: "test",
        routedAction: "chat",
        actionArgs: {},
        responseSummary: "reply",
      });

      const found = await findEpisode(episodeId);
      expect(found?.source_ref.channel_id).toBe("C123");
      expect(found?.source_ref.thread_ts).toBe("111.222");
    });

    it("maps source_ref fields correctly for Discord", async () => {
      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "discord",
        sourceRef: {
          channel_id: "discord-ch-1",
          thread_id: "discord-thread-1",
          message_id: "discord-msg-1",
        },
        userMessage: "test",
        routedAction: "chat",
        actionArgs: {},
        responseSummary: "reply",
      });

      const found = await findEpisode(episodeId);
      expect(found?.source_ref.channel_id).toBe("discord-ch-1");
      expect(found?.source_ref.thread_id).toBe("discord-thread-1");
      expect(found?.source_ref.message_id).toBe("discord-msg-1");
    });

    it("maps source_ref fields correctly for web_chat", async () => {
      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "web_chat",
        sourceRef: { conversation_id: "conv-abc" },
        userMessage: "test",
        routedAction: "chat",
        actionArgs: {},
        responseSummary: "reply",
      });

      const found = await findEpisode(episodeId);
      expect(found?.source_ref.conversation_id).toBe("conv-abc");
    });

    it("includes optional taskId and researchSessionId", async () => {
      const episodeId = await recordEpisode({
        owner: "test-owner",
        source: "slack",
        sourceRef: { channel_id: "C123" },
        userMessage: "create a job to fix the bug",
        routedAction: "create_job",
        actionArgs: { task_text: "fix the bug" },
        responseSummary: "Task queued",
        taskId: "task-abc-123",
        researchSessionId: "rs-xyz",
      });

      const found = await findEpisode(episodeId);
      expect(found?.task_id).toBe("task-abc-123");
      expect(found?.research_session_id).toBe("rs-xyz");
    });
  });
});
