import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InteractionEpisode, MemoryNote } from "../../shared/memoryTypes.js";
import { _setTestDb } from "../mongo.js";
import { ensureEpisodeIndexes, insertEpisode } from "./episodeRepo.js";
import { ensureMemoryNoteIndexes, findMemory, insertMemory } from "./memoryRepo.js";

// Mock embedding provider and vector/FTS stores to avoid real infra dependencies
vi.mock("../kb/embeddings.js", () => ({
  getEmbeddingProvider: () => ({
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  }),
}));

vi.mock("./memoryVectorStore.js", () => ({
  addToMemoryTable: vi.fn().mockResolvedValue(undefined),
  searchMemoryTable: vi.fn().mockResolvedValue([]),
}));

vi.mock("./memoryFtsStore.js", () => ({
  addToMemoryFTS: vi.fn(),
  deleteFromMemoryFTS: vi.fn(),
  searchMemoryFTS: vi.fn().mockReturnValue([]),
}));

vi.mock("./pipelines/reflectionEngine.js", () => ({
  runReflection: vi.fn().mockResolvedValue({
    episodes_reviewed: 0,
    clusters_found: 0,
    reflections_created: 0,
    profile_updated: false,
  }),
}));

// Import after mocks
import express from "express";
import request from "supertest";
import { createMemoryRoutes } from "./memoryRoutes.js";
import { runReflection } from "./pipelines/reflectionEngine.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: express.Express;

const mockConfig = {
  slackJobOwner: "test-owner",
  internalApiToken: "test-token",
} as any;

function makeMemory(overrides: Partial<MemoryNote> = {}): MemoryNote {
  const now = new Date();
  return {
    memory_id: `mem-${Math.random().toString(36).slice(2, 10)}`,
    owner: "test-owner",
    memory_type: "fact",
    content: "The user prefers TypeScript strict mode",
    context: "Mentioned during a code review discussion",
    keywords: ["typescript", "strict-mode"],
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
    embedding_text: "The user prefers TypeScript strict mode.",
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
  const now = new Date();
  return {
    episode_id: `ep-${Math.random().toString(36).slice(2, 10)}`,
    owner: "test-owner",
    source: "slack",
    source_ref: { channel_id: "C123" },
    user_message: "What is TypeScript strict mode?",
    routed_action: "chat",
    action_args_summary: "{}",
    response_summary: "TypeScript strict mode enables...",
    signals: [],
    timestamp: now,
    extraction_status: "pending",
    extracted_memory_ids: [],
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test_memory_routes");
  _setTestDb(db);
  await ensureMemoryNoteIndexes();
  await ensureEpisodeIndexes();

  app = express();
  app.use(express.json());
  app.use("/api/web/memory", createMemoryRoutes(mockConfig));
});

afterEach(async () => {
  await db.collection("memories").deleteMany({});
  await db.collection("interaction_episodes").deleteMany({});
  await db.collection("memory_config").deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe("memoryRoutes", () => {
  describe("GET /stats", () => {
    it("returns stats with zero counts when empty", async () => {
      const res = await request(app).get("/api/web/memory/stats");
      expect(res.status).toBe(200);
      expect(res.body.total_memories).toBe(0);
      expect(res.body.active_memories).toBe(0);
      expect(res.body.invalidated_memories).toBe(0);
      expect(res.body.total_episodes).toBe(0);
      expect(res.body.memories_by_type).toEqual({ fact: 0, reflection: 0, user_profile: 0 });
    });

    it("returns correct counts with data", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", memory_type: "fact" }));
      await insertMemory(makeMemory({ memory_id: "m2", memory_type: "reflection" }));
      await insertEpisode(makeEpisode({ episode_id: "e1" }));

      const res = await request(app).get("/api/web/memory/stats");
      expect(res.status).toBe(200);
      expect(res.body.total_memories).toBe(2);
      expect(res.body.total_episodes).toBe(1);
      expect(res.body.memories_by_type.fact).toBe(1);
      expect(res.body.memories_by_type.reflection).toBe(1);
    });
  });

  describe("GET /memories", () => {
    it("returns empty list when no memories exist", async () => {
      const res = await request(app).get("/api/web/memory/memories");
      expect(res.status).toBe(200);
      expect(res.body.memories).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("lists memories with pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await insertMemory(makeMemory({ memory_id: `m-${i}` }));
      }

      const res = await request(app).get("/api/web/memory/memories?limit=2&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.memories).toHaveLength(2);
      expect(res.body.total).toBe(5);
    });

    it("filters by type", async () => {
      await insertMemory(makeMemory({ memory_id: "m-fact", memory_type: "fact" }));
      await insertMemory(makeMemory({ memory_id: "m-refl", memory_type: "reflection" }));

      const res = await request(app).get("/api/web/memory/memories?type=reflection");
      expect(res.status).toBe(200);
      expect(res.body.memories).toHaveLength(1);
      expect(res.body.memories[0].memory_type).toBe("reflection");
    });

    it("filters by tag", async () => {
      await insertMemory(makeMemory({ memory_id: "m-tag", tags: ["special"] }));
      await insertMemory(makeMemory({ memory_id: "m-other", tags: ["other"] }));

      const res = await request(app).get("/api/web/memory/memories?tag=special");
      expect(res.status).toBe(200);
      expect(res.body.memories).toHaveLength(1);
      expect(res.body.memories[0].tags).toContain("special");
    });

    it("caps limit at 100", async () => {
      const res = await request(app).get("/api/web/memory/memories?limit=999");
      expect(res.status).toBe(200);
      // Should not error — just cap internally
    });
  });

  describe("GET /memories/:memory_id", () => {
    it("returns a single memory with linked memories", async () => {
      const linked = makeMemory({ memory_id: "linked-1" });
      await insertMemory(linked);
      await insertMemory(
        makeMemory({
          memory_id: "main-1",
          linked_memory_ids: ["linked-1"],
          link_reasons: ["related"],
        }),
      );

      const res = await request(app).get("/api/web/memory/memories/main-1");
      expect(res.status).toBe(200);
      expect(res.body.memory.memory_id).toBe("main-1");
      expect(res.body.linked).toHaveLength(1);
      expect(res.body.linked[0].memory_id).toBe("linked-1");
    });

    it("returns 404 for non-existent memory", async () => {
      const res = await request(app).get("/api/web/memory/memories/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Memory not found");
    });
  });

  describe("POST /search", () => {
    it("rejects request without query", async () => {
      const res = await request(app).post("/api/web/memory/search").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("query is required");
    });

    it("returns results for valid query", async () => {
      const res = await request(app)
        .post("/api/web/memory/search")
        .send({ query: "TypeScript preferences" });
      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
      expect(Array.isArray(res.body.results)).toBe(true);
    });
  });

  describe("POST /reflect", () => {
    it("triggers reflection and returns result", async () => {
      const res = await request(app).post("/api/web/memory/reflect").send({});
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(runReflection).toHaveBeenCalled();
    });
  });

  describe("DELETE /memories/:memory_id", () => {
    it("invalidates a memory (soft delete)", async () => {
      await insertMemory(makeMemory({ memory_id: "to-delete" }));

      const res = await request(app).delete("/api/web/memory/memories/to-delete");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verify it's invalidated (not physically deleted)
      const memory = await findMemory("to-delete");
      expect(memory).not.toBeNull();
      expect(memory?.invalidated_at).toBeDefined();
    });

    it("returns 404 for non-existent memory", async () => {
      const res = await request(app).delete("/api/web/memory/memories/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Memory not found");
    });
  });

  describe("PUT /memories/:memory_id", () => {
    it("updates memory content", async () => {
      await insertMemory(makeMemory({ memory_id: "to-edit" }));

      const res = await request(app)
        .put("/api/web/memory/memories/to-edit")
        .send({ content: "Updated content" });
      expect(res.status).toBe(200);
      expect(res.body.memory.content).toBe("Updated content");
    });

    it("updates memory importance", async () => {
      await insertMemory(makeMemory({ memory_id: "to-edit-imp", importance: 0.5 }));

      const res = await request(app)
        .put("/api/web/memory/memories/to-edit-imp")
        .send({ importance: 0.9 });
      expect(res.status).toBe(200);
      expect(res.body.memory.importance).toBe(0.9);
    });

    it("updates memory tags", async () => {
      await insertMemory(makeMemory({ memory_id: "to-edit-tags" }));

      const res = await request(app)
        .put("/api/web/memory/memories/to-edit-tags")
        .send({ tags: ["new_tag", "another"] });
      expect(res.status).toBe(200);
      expect(res.body.memory.tags).toEqual(["new_tag", "another"]);
    });

    it("returns 404 for non-existent memory", async () => {
      const res = await request(app)
        .put("/api/web/memory/memories/nonexistent")
        .send({ content: "nope" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Memory not found");
    });
  });

  describe("GET /profile", () => {
    it("returns null when no profile exists", async () => {
      const res = await request(app).get("/api/web/memory/profile");
      expect(res.status).toBe(200);
      expect(res.body.profile).toBeNull();
    });

    it("returns the user profile when it exists", async () => {
      await insertMemory(
        makeMemory({
          memory_id: "profile-1",
          memory_type: "user_profile",
          content: "The user is a TypeScript expert.",
        }),
      );

      const res = await request(app).get("/api/web/memory/profile");
      expect(res.status).toBe(200);
      expect(res.body.profile).not.toBeNull();
      expect(res.body.profile.memory_type).toBe("user_profile");
    });

    it("filters by owner", async () => {
      await insertMemory(
        makeMemory({
          memory_id: "profile-owner",
          memory_type: "user_profile",
          owner: "specific-owner",
        }),
      );

      const res = await request(app).get("/api/web/memory/profile?owner=specific-owner");
      expect(res.status).toBe(200);
      expect(res.body.profile).not.toBeNull();

      const res2 = await request(app).get("/api/web/memory/profile?owner=other-owner");
      expect(res2.status).toBe(200);
      expect(res2.body.profile).toBeNull();
    });
  });

  describe("GET /episodes", () => {
    it("returns empty list when no episodes exist", async () => {
      const res = await request(app).get("/api/web/memory/episodes");
      expect(res.status).toBe(200);
      expect(res.body.episodes).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("lists episodes with pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await insertEpisode(makeEpisode({ episode_id: `ep-${i}` }));
      }

      const res = await request(app).get("/api/web/memory/episodes?limit=2&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.episodes).toHaveLength(2);
      expect(res.body.total).toBe(5);
    });

    it("filters by action", async () => {
      await insertEpisode(makeEpisode({ episode_id: "ep-chat", routed_action: "chat" }));
      await insertEpisode(makeEpisode({ episode_id: "ep-job", routed_action: "create_job" }));

      const res = await request(app).get("/api/web/memory/episodes?action=chat");
      expect(res.status).toBe(200);
      expect(res.body.episodes).toHaveLength(1);
      expect(res.body.episodes[0].routed_action).toBe("chat");
    });
  });

  describe("GET /episodes/:episode_id", () => {
    it("returns a single episode with extracted memories", async () => {
      const ep = makeEpisode({ episode_id: "ep-detail", extracted_memory_ids: ["m-from-ep"] });
      await insertEpisode(ep);
      await insertMemory(makeMemory({ memory_id: "m-from-ep", source_episodes: ["ep-detail"] }));

      const res = await request(app).get("/api/web/memory/episodes/ep-detail");
      expect(res.status).toBe(200);
      expect(res.body.episode.episode_id).toBe("ep-detail");
      expect(res.body.memories).toHaveLength(1);
      expect(res.body.memories[0].memory_id).toBe("m-from-ep");
    });

    it("returns 404 for non-existent episode", async () => {
      const res = await request(app).get("/api/web/memory/episodes/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Episode not found");
    });
  });

  describe("GET /config", () => {
    it("returns the effective memory config", async () => {
      const res = await request(app).get("/api/web/memory/config");
      expect(res.status).toBe(200);
      expect(res.body.config).toBeDefined();
      expect(res.body.config.enabled).toBeDefined();
      expect(res.body.config.retrieval_max_memories).toBeDefined();
    });
  });

  describe("PUT /config", () => {
    it("persists config overrides and returns merged config", async () => {
      const res = await request(app)
        .put("/api/web/memory/config")
        .send({ retrieval_max_memories: 15 });
      expect(res.status).toBe(200);
      expect(res.body.config.retrieval_max_memories).toBe(15);

      // Verify it persists
      const res2 = await request(app).get("/api/web/memory/config");
      expect(res2.body.config.retrieval_max_memories).toBe(15);
    });

    it("handles empty object body gracefully", async () => {
      const res = await request(app).put("/api/web/memory/config").send({});
      expect(res.status).toBe(200);
      expect(res.body.config).toBeDefined();
    });
  });
});
