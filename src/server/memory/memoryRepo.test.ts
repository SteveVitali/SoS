import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MemoryNote } from "../../shared/memoryTypes.js";
import { _setTestDb } from "../mongo.js";
import {
  countMemoriesByType,
  ensureMemoryNoteIndexes,
  findMemoriesByEpisode,
  findMemory,
  incrementAccessCount,
  insertMemory,
  invalidateMemory,
  listMemories,
  updateMemory,
} from "./memoryRepo.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

function makeMemory(overrides: Partial<MemoryNote> = {}): MemoryNote {
  const now = new Date();
  return {
    memory_id: `mem-${Math.random().toString(36).slice(2, 10)}`,
    owner: "test-owner",
    memory_type: "fact",
    content: "The user prefers TypeScript strict mode",
    context: "Mentioned during a code review discussion",
    keywords: ["typescript", "strict-mode", "preferences"],
    tags: ["code_style"],
    source_episodes: ["ep-1"],
    source_type: "slack",
    created_at: now,
    updated_at: now,
    valid_from: now,
    linked_memory_ids: [],
    link_reasons: [],
    access_count: 0,
    importance: 0.5,
    confidence: 0.8,
    embedding_text: "The user prefers TypeScript strict mode. Code review discussion.",
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test_memory_repo");
  _setTestDb(db);
  await ensureMemoryNoteIndexes();
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  await db.collection("memories").deleteMany({});
});

describe("memoryRepo", () => {
  describe("insertMemory", () => {
    it("creates a memory and returns it", async () => {
      const mem = makeMemory();
      const result = await insertMemory(mem);
      expect(result.memory_id).toBe(mem.memory_id);
      expect(result.content).toBe(mem.content);
    });

    it("persists to MongoDB", async () => {
      const mem = makeMemory();
      await insertMemory(mem);
      const found = await findMemory(mem.memory_id);
      expect(found).not.toBeNull();
      expect(found?.content).toBe(mem.content);
    });

    it("enforces unique memory_id", async () => {
      const mem = makeMemory();
      await insertMemory(mem);
      await expect(insertMemory(mem)).rejects.toThrow();
    });
  });

  describe("findMemory", () => {
    it("returns null for non-existent memory", async () => {
      const result = await findMemory("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("listMemories", () => {
    it("lists memories for an owner", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", owner: "alice" }));
      await insertMemory(makeMemory({ memory_id: "m2", owner: "alice" }));
      await insertMemory(makeMemory({ memory_id: "m3", owner: "bob" }));

      const { memories, total } = await listMemories({ owner: "alice" });
      expect(total).toBe(2);
      expect(memories).toHaveLength(2);
    });

    it("filters by memory_type", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", memory_type: "fact" }));
      await insertMemory(makeMemory({ memory_id: "m2", memory_type: "reflection" }));

      const { memories } = await listMemories({ memory_type: "fact" });
      expect(memories).toHaveLength(1);
      expect(memories[0].memory_type).toBe("fact");
    });

    it("filters by tags", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", tags: ["code_style", "ts"] }));
      await insertMemory(makeMemory({ memory_id: "m2", tags: ["devops"] }));

      const { memories } = await listMemories({ tags: ["code_style"] });
      expect(memories).toHaveLength(1);
    });

    it("excludes invalidated memories by default", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));
      await insertMemory(makeMemory({ memory_id: "m2", invalidated_at: new Date() }));

      const { total } = await listMemories({});
      expect(total).toBe(1);
    });

    it("includes invalidated memories when requested", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));
      await insertMemory(makeMemory({ memory_id: "m2", invalidated_at: new Date() }));

      const { total } = await listMemories({ include_invalidated: true });
      expect(total).toBe(2);
    });

    it("supports pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await insertMemory(makeMemory({ memory_id: `m${i}` }));
      }

      const { memories, total } = await listMemories({ limit: 2, offset: 1 });
      expect(total).toBe(5);
      expect(memories).toHaveLength(2);
    });
  });

  describe("updateMemory", () => {
    it("updates specified fields", async () => {
      const mem = makeMemory();
      await insertMemory(mem);

      const updated = await updateMemory(mem.memory_id, {
        content: "Updated content",
        importance: 0.9,
      });
      expect(updated?.content).toBe("Updated content");
      expect(updated?.importance).toBe(0.9);
      expect(updated?.updated_at.getTime()).toBeGreaterThanOrEqual(mem.updated_at.getTime());
    });

    it("returns null for non-existent memory", async () => {
      const result = await updateMemory("non-existent", { content: "x" });
      expect(result).toBeNull();
    });
  });

  describe("invalidateMemory", () => {
    it("soft-deletes a memory", async () => {
      const mem = makeMemory();
      await insertMemory(mem);

      const result = await invalidateMemory(mem.memory_id, "superseding-mem-id");
      expect(result?.invalidated_at).toBeDefined();
      expect(result?.invalidated_by).toBe("superseding-mem-id");
    });

    it("makes the memory excluded from default listing", async () => {
      const mem = makeMemory();
      await insertMemory(mem);
      await invalidateMemory(mem.memory_id);

      const { total } = await listMemories({});
      expect(total).toBe(0);
    });
  });

  describe("incrementAccessCount", () => {
    it("increments access_count and sets last_accessed_at", async () => {
      const mem = makeMemory({ access_count: 0 });
      await insertMemory(mem);

      await incrementAccessCount([mem.memory_id]);

      const found = await findMemory(mem.memory_id);
      expect(found?.access_count).toBe(1);
      expect(found?.last_accessed_at).toBeDefined();
    });

    it("handles empty array gracefully", async () => {
      await incrementAccessCount([]);
      // No error thrown
    });
  });

  describe("findMemoriesByEpisode", () => {
    it("finds memories linked to an episode", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", source_episodes: ["ep-1", "ep-2"] }));
      await insertMemory(makeMemory({ memory_id: "m2", source_episodes: ["ep-2"] }));
      await insertMemory(makeMemory({ memory_id: "m3", source_episodes: ["ep-3"] }));

      const results = await findMemoriesByEpisode("ep-2");
      expect(results).toHaveLength(2);
    });
  });

  describe("countMemoriesByType", () => {
    it("counts memories grouped by type", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", memory_type: "fact" }));
      await insertMemory(makeMemory({ memory_id: "m2", memory_type: "fact" }));
      await insertMemory(makeMemory({ memory_id: "m3", memory_type: "reflection" }));

      const counts = await countMemoriesByType();
      expect(counts.fact).toBe(2);
      expect(counts.reflection).toBe(1);
      expect(counts.user_profile).toBe(0);
    });
  });
});
