import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { InteractionEpisode } from "../../shared/memoryTypes.js";
import { _setTestDb } from "../mongo.js";
import {
  appendSignals,
  countEpisodes,
  ensureEpisodeIndexes,
  findEpisode,
  insertEpisode,
  listEpisodes,
  updateExtractionStatus,
} from "./episodeRepo.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

function makeEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
  return {
    episode_id: `ep-${Math.random().toString(36).slice(2, 10)}`,
    owner: "test-owner",
    source: "slack",
    source_ref: { channel_id: "C123", thread_ts: "111.222" },
    user_message: "How do I configure strict mode?",
    routed_action: "chat",
    action_args_summary: '{"response":"Here is how..."}',
    response_summary: "Here is how to configure strict mode in TypeScript...",
    signals: [],
    timestamp: new Date(),
    extraction_status: "pending",
    extracted_memory_ids: [],
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test_episode_repo");
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

describe("episodeRepo", () => {
  describe("insertEpisode", () => {
    it("creates an episode and returns it", async () => {
      const ep = makeEpisode();
      const result = await insertEpisode(ep);
      expect(result.episode_id).toBe(ep.episode_id);
      expect(result.user_message).toBe(ep.user_message);
    });

    it("persists to MongoDB", async () => {
      const ep = makeEpisode();
      await insertEpisode(ep);
      const found = await findEpisode(ep.episode_id);
      expect(found).not.toBeNull();
      expect(found?.routed_action).toBe("chat");
    });

    it("enforces unique episode_id", async () => {
      const ep = makeEpisode();
      await insertEpisode(ep);
      await expect(insertEpisode(ep)).rejects.toThrow();
    });
  });

  describe("findEpisode", () => {
    it("returns null for non-existent episode", async () => {
      const result = await findEpisode("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("listEpisodes", () => {
    it("lists episodes for an owner", async () => {
      await insertEpisode(makeEpisode({ episode_id: "e1", owner: "alice" }));
      await insertEpisode(makeEpisode({ episode_id: "e2", owner: "alice" }));
      await insertEpisode(makeEpisode({ episode_id: "e3", owner: "bob" }));

      const { episodes, total } = await listEpisodes({ owner: "alice" });
      expect(total).toBe(2);
      expect(episodes).toHaveLength(2);
    });

    it("filters by routed_action", async () => {
      await insertEpisode(makeEpisode({ episode_id: "e1", routed_action: "chat" }));
      await insertEpisode(makeEpisode({ episode_id: "e2", routed_action: "create_job" }));

      const { episodes } = await listEpisodes({ routed_action: "create_job" });
      expect(episodes).toHaveLength(1);
      expect(episodes[0].routed_action).toBe("create_job");
    });

    it("filters by extraction_status", async () => {
      await insertEpisode(makeEpisode({ episode_id: "e1", extraction_status: "pending" }));
      await insertEpisode(makeEpisode({ episode_id: "e2", extraction_status: "extracted" }));

      const { episodes } = await listEpisodes({ extraction_status: "pending" });
      expect(episodes).toHaveLength(1);
    });

    it("supports pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await insertEpisode(makeEpisode({ episode_id: `e${i}` }));
      }

      const { episodes, total } = await listEpisodes({ limit: 2, offset: 1 });
      expect(total).toBe(5);
      expect(episodes).toHaveLength(2);
    });
  });

  describe("updateExtractionStatus", () => {
    it("transitions extraction status", async () => {
      const ep = makeEpisode({ extraction_status: "pending" });
      await insertEpisode(ep);

      const updated = await updateExtractionStatus(ep.episode_id, "extracted", ["mem-1", "mem-2"]);
      expect(updated?.extraction_status).toBe("extracted");
      expect(updated?.extracted_memory_ids).toEqual(["mem-1", "mem-2"]);
    });

    it("transitions to skipped", async () => {
      const ep = makeEpisode();
      await insertEpisode(ep);

      const updated = await updateExtractionStatus(ep.episode_id, "skipped");
      expect(updated?.extraction_status).toBe("skipped");
    });

    it("returns null for non-existent episode", async () => {
      const result = await updateExtractionStatus("non-existent", "extracted");
      expect(result).toBeNull();
    });
  });

  describe("appendSignals", () => {
    it("appends signals to an episode", async () => {
      const ep = makeEpisode();
      await insertEpisode(ep);

      const updated = await appendSignals(ep.episode_id, [
        { signal_type: "gratitude", detected_at: new Date(), strength: 0.8 },
        { signal_type: "continuation", detected_at: new Date(), strength: 0.2 },
      ]);

      expect(updated?.signals).toHaveLength(2);
      expect(updated?.signals[0].signal_type).toBe("gratitude");
      expect(updated?.signal_collected_at).toBeDefined();
    });

    it("appends additional signals to existing ones", async () => {
      const ep = makeEpisode({
        signals: [{ signal_type: "continuation", detected_at: new Date(), strength: 0.2 }],
      });
      await insertEpisode(ep);

      const updated = await appendSignals(ep.episode_id, [
        { signal_type: "gratitude", detected_at: new Date(), strength: 0.8 },
      ]);

      expect(updated?.signals).toHaveLength(2);
    });

    it("handles empty signals array gracefully", async () => {
      const ep = makeEpisode();
      await insertEpisode(ep);

      const updated = await appendSignals(ep.episode_id, []);
      expect(updated?.signals).toHaveLength(0);
    });
  });

  describe("countEpisodes", () => {
    it("counts all episodes", async () => {
      await insertEpisode(makeEpisode({ episode_id: "e1" }));
      await insertEpisode(makeEpisode({ episode_id: "e2" }));

      const count = await countEpisodes();
      expect(count).toBe(2);
    });

    it("counts episodes for a specific owner", async () => {
      await insertEpisode(makeEpisode({ episode_id: "e1", owner: "alice" }));
      await insertEpisode(makeEpisode({ episode_id: "e2", owner: "bob" }));

      const count = await countEpisodes("alice");
      expect(count).toBe(1);
    });
  });
});
