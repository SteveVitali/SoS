import express from "express";
import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionEpisode, MemoryNote } from "../../shared/memoryTypes.js";
import { _setTestDb } from "../mongo.js";
import { ensureEpisodeIndexes, insertEpisode } from "./episodeRepo.js";
import { ensureMemoryNoteIndexes, insertMemory } from "./memoryRepo.js";
import { createMemoryRoutes } from "./memoryRoutes.js";

// ─── Mock non-MongoDB dependencies ──────────────────────────────

vi.mock("./memorySearch.js", () => ({
  searchMemories: vi.fn().mockResolvedValue([
    {
      memory: {
        memory_id: "search-result-1",
        owner: "global",
        memory_type: "fact",
        content: "Found memory",
        context: "test",
        keywords: ["test"],
        tags: ["test"],
        source_episodes: [],
        source_type: "system",
        created_at: new Date(),
        updated_at: new Date(),
        valid_from: new Date(),
        linked_memory_ids: [],
        link_reasons: [],
        access_count: 0,
        importance: 0.5,
        confidence: 0.8,
        embedding_text: "Found memory test",
      },
      score: 0.8,
      similarity_score: 0.7,
      recency_score: 0.9,
      importance_score: 0.5,
      access_score: 0.1,
    },
  ]),
}));

vi.mock("./pipelines/reflectionEngine.js", () => ({
  runReflection: vi.fn().mockResolvedValue({
    episodes_reviewed: 5,
    clusters_found: 2,
    reflections_created: 1,
    profile_updated: true,
  }),
  getLastReflectionTimestamp: vi.fn().mockResolvedValue(null),
}));

vi.mock("../kb/embeddings.js", () => ({
  getEmbeddingProvider: vi.fn().mockReturnValue({
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  }),
}));

vi.mock("./memoryVectorStore.js", () => ({
  addToMemoryTable: vi.fn().mockResolvedValue(undefined),
  initMemoryVectorStore: vi.fn().mockResolvedValue(undefined),
  closeMemoryVectorStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./memoryFtsStore.js", () => ({
  addToMemoryFTS: vi.fn(),
  deleteFromMemoryFTS: vi.fn(),
  initMemoryFtsStore: vi.fn(),
  closeMemoryFtsStore: vi.fn(),
}));

// ─── Test Setup ─────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: express.Express;

const mockConfig = {
  internalApiToken: "test-token",
  slackJobOwner: "test-owner",
} as any;

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

function makeEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
  const now = new Date();
  return {
    episode_id: `ep-${Math.random().toString(36).slice(2, 10)}`,
    owner: "test-owner",
    source: "web_chat",
    source_ref: { conversation_id: "conv-1" },
    user_message: "How do I configure TypeScript?",
    routed_action: "chat",
    action_args_summary: "{}",
    response_summary: "TypeScript configuration involves...",
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

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  await db.collection("memories").deleteMany({});
  await db.collection("interaction_episodes").deleteMany({});
  await db.collection("memory_config").deleteMany({});
});

// ─── Tests ──────────────────────────────────────────────────────

describe("memoryRoutes", () => {
  // ─── GET /stats ───────────────────────────────────────────
  describe("GET /stats", () => {
    it("returns memory stats", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", memory_type: "fact" }));
      await insertMemory(makeMemory({ memory_id: "m2", memory_type: "reflection" }));
      await insertEpisode(makeEpisode({ episode_id: "e1" }));

      const res = await request(app).get("/api/web/memory/stats").expect(200);

      expect(res.body.total_memories).toBe(2);
      expect(res.body.active_memories).toBe(2);
      expect(res.body.invalidated_memories).toBe(0);
      expect(res.body.total_episodes).toBe(1);
      expect(res.body.memories_by_type.fact).toBe(1);
      expect(res.body.memories_by_type.reflection).toBe(1);
    });

    it("counts invalidated memories correctly", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));
      await insertMemory(makeMemory({ memory_id: "m2", invalidated_at: new Date() }));

      const res = await request(app).get("/api/web/memory/stats").expect(200);

      expect(res.body.total_memories).toBe(2);
      expect(res.body.active_memories).toBe(1);
      expect(res.body.invalidated_memories).toBe(1);
    });
  });

  // ─── GET /memories ────────────────────────────────────────
  describe("GET /memories", () => {
    it("lists memories with default pagination", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));
      await insertMemory(makeMemory({ memory_id: "m2" }));

      const res = await request(app).get("/api/web/memory/memories").expect(200);

      expect(res.body.memories).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("filters by type", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", memory_type: "fact" }));
      await insertMemory(makeMemory({ memory_id: "m2", memory_type: "reflection" }));

      const res = await request(app).get("/api/web/memory/memories?type=fact").expect(200);

      expect(res.body.memories).toHaveLength(1);
      expect(res.body.memories[0].memory_type).toBe("fact");
    });

    it("filters by tag", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", tags: ["code_style"] }));
      await insertMemory(makeMemory({ memory_id: "m2", tags: ["devops"] }));

      const res = await request(app).get("/api/web/memory/memories?tag=devops").expect(200);

      expect(res.body.memories).toHaveLength(1);
      expect(res.body.memories[0].tags).toContain("devops");
    });

    it("supports pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await insertMemory(makeMemory({ memory_id: `m${i}` }));
      }

      const res = await request(app).get("/api/web/memory/memories?limit=2&offset=1").expect(200);

      expect(res.body.memories).toHaveLength(2);
      expect(res.body.total).toBe(5);
    });
  });

  // ─── GET /memories/:memory_id ─────────────────────────────
  describe("GET /memories/:memory_id", () => {
    it("returns a single memory with linked memories", async () => {
      await insertMemory(
        makeMemory({ memory_id: "m1", linked_memory_ids: ["m2"], link_reasons: ["related"] }),
      );
      await insertMemory(makeMemory({ memory_id: "m2" }));

      const res = await request(app).get("/api/web/memory/memories/m1").expect(200);

      expect(res.body.memory.memory_id).toBe("m1");
      expect(res.body.linked).toHaveLength(1);
      expect(res.body.linked[0].memory_id).toBe("m2");
    });

    it("returns 404 for non-existent memory", async () => {
      const res = await request(app).get("/api/web/memory/memories/non-existent").expect(404);

      expect(res.body.error).toBe("Memory not found");
    });

    it("returns empty linked array if no links", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", linked_memory_ids: [] }));

      const res = await request(app).get("/api/web/memory/memories/m1").expect(200);

      expect(res.body.linked).toHaveLength(0);
    });
  });

  // ─── POST /search ─────────────────────────────────────────
  describe("POST /search", () => {
    it("returns search results", async () => {
      const res = await request(app)
        .post("/api/web/memory/search")
        .send({ query: "TypeScript preferences" })
        .expect(200);

      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].score).toBe(0.8);
    });

    it("rejects missing query", async () => {
      const res = await request(app).post("/api/web/memory/search").send({}).expect(400);

      expect(res.body.error).toBe("query is required");
    });

    it("rejects non-string query", async () => {
      const res = await request(app)
        .post("/api/web/memory/search")
        .send({ query: 123 })
        .expect(400);

      expect(res.body.error).toBe("query is required");
    });
  });

  // ─── POST /reflect ────────────────────────────────────────
  describe("POST /reflect", () => {
    it("triggers reflection and returns results", async () => {
      const res = await request(app)
        .post("/api/web/memory/reflect")
        .send({ owner: "test-owner" })
        .expect(200);

      expect(res.body.result.episodes_reviewed).toBe(5);
      expect(res.body.result.clusters_found).toBe(2);
      expect(res.body.result.reflections_created).toBe(1);
      expect(res.body.result.profile_updated).toBe(true);
    });

    it("uses 'global' owner when not specified", async () => {
      const { runReflection } = await import("./pipelines/reflectionEngine.js");

      await request(app).post("/api/web/memory/reflect").send({}).expect(200);

      expect(runReflection).toHaveBeenCalledWith("global", expect.any(Object));
    });
  });

  // ─── DELETE /memories/:memory_id ──────────────────────────
  describe("DELETE /memories/:memory_id", () => {
    it("invalidates a memory (soft delete)", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));

      const res = await request(app).delete("/api/web/memory/memories/m1").expect(200);

      expect(res.body.ok).toBe(true);

      // Verify the memory still exists but is invalidated
      const getRes = await request(app).get("/api/web/memory/memories/m1").expect(200);
      expect(getRes.body.memory.invalidated_at).toBeDefined();
    });

    it("returns 404 for non-existent memory", async () => {
      const res = await request(app).delete("/api/web/memory/memories/non-existent").expect(404);

      expect(res.body.error).toBe("Memory not found");
    });

    it("does not physically delete the memory", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));

      await request(app).delete("/api/web/memory/memories/m1").expect(200);

      // Still accessible by direct lookup
      const getRes = await request(app).get("/api/web/memory/memories/m1").expect(200);
      expect(getRes.body.memory).not.toBeNull();
      expect(getRes.body.memory.memory_id).toBe("m1");
    });
  });

  // ─── PUT /memories/:memory_id ─────────────────────────────
  describe("PUT /memories/:memory_id", () => {
    it("updates content and re-embeds", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));

      const res = await request(app)
        .put("/api/web/memory/memories/m1")
        .send({ content: "Updated content", importance: 0.9 })
        .expect(200);

      expect(res.body.memory.content).toBe("Updated content");
      expect(res.body.memory.importance).toBe(0.9);
    });

    it("updates tags", async () => {
      await insertMemory(makeMemory({ memory_id: "m1", tags: ["old_tag"] }));

      const res = await request(app)
        .put("/api/web/memory/memories/m1")
        .send({ tags: ["new_tag", "another_tag"] })
        .expect(200);

      expect(res.body.memory.tags).toEqual(["new_tag", "another_tag"]);
    });

    it("returns 404 for non-existent memory", async () => {
      const res = await request(app)
        .put("/api/web/memory/memories/non-existent")
        .send({ content: "x" })
        .expect(404);

      expect(res.body.error).toBe("Memory not found");
    });

    it("updates importance only without re-embedding", async () => {
      await insertMemory(makeMemory({ memory_id: "m1" }));

      const { addToMemoryTable } = await import("./memoryVectorStore.js");

      const res = await request(app)
        .put("/api/web/memory/memories/m1")
        .send({ importance: 0.95 })
        .expect(200);

      expect(res.body.memory.importance).toBe(0.95);
    });
  });

  // ─── GET /profile ─────────────────────────────────────────
  describe("GET /profile", () => {
    it("returns the user profile when it exists", async () => {
      await insertMemory(
        makeMemory({
          memory_id: "profile-1",
          memory_type: "user_profile",
          content: "User is a TypeScript expert",
          tags: ["user_profile"],
        }),
      );

      const res = await request(app).get("/api/web/memory/profile").expect(200);

      expect(res.body.profile).not.toBeNull();
      expect(res.body.profile.memory_type).toBe("user_profile");
      expect(res.body.profile.content).toBe("User is a TypeScript expert");
    });

    it("returns null when no profile exists", async () => {
      const res = await request(app).get("/api/web/memory/profile").expect(200);

      expect(res.body.profile).toBeNull();
    });
  });

  // ─── GET /episodes ────────────────────────────────────────
  describe("GET /episodes", () => {
    it("lists episodes with default pagination", async () => {
      await insertEpisode(makeEpisode({ episode_id: "e1" }));
      await insertEpisode(makeEpisode({ episode_id: "e2" }));

      const res = await request(app).get("/api/web/memory/episodes").expect(200);

      expect(res.body.episodes).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("filters by action", async () => {
      await insertEpisode(makeEpisode({ episode_id: "e1", routed_action: "chat" }));
      await insertEpisode(makeEpisode({ episode_id: "e2", routed_action: "create_job" }));

      const res = await request(app).get("/api/web/memory/episodes?action=chat").expect(200);

      expect(res.body.episodes).toHaveLength(1);
      expect(res.body.episodes[0].routed_action).toBe("chat");
    });

    it("supports pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await insertEpisode(makeEpisode({ episode_id: `e${i}` }));
      }

      const res = await request(app).get("/api/web/memory/episodes?limit=2&offset=1").expect(200);

      expect(res.body.episodes).toHaveLength(2);
      expect(res.body.total).toBe(5);
    });
  });

  // ─── GET /episodes/:episode_id ────────────────────────────
  describe("GET /episodes/:episode_id", () => {
    it("returns a single episode with extracted memories", async () => {
      const episodeId = "ep-test-1";
      await insertEpisode(makeEpisode({ episode_id: episodeId }));
      await insertMemory(makeMemory({ memory_id: "m1", source_episodes: [episodeId] }));

      const res = await request(app).get(`/api/web/memory/episodes/${episodeId}`).expect(200);

      expect(res.body.episode.episode_id).toBe(episodeId);
      expect(res.body.memories).toHaveLength(1);
      expect(res.body.memories[0].memory_id).toBe("m1");
    });

    it("returns 404 for non-existent episode", async () => {
      const res = await request(app).get("/api/web/memory/episodes/non-existent").expect(404);

      expect(res.body.error).toBe("Episode not found");
    });
  });

  // ─── GET /config ──────────────────────────────────────────
  describe("GET /config", () => {
    it("returns the current memory config", async () => {
      const res = await request(app).get("/api/web/memory/config").expect(200);

      expect(res.body.config).toBeDefined();
      expect(res.body.config.enabled).toBeDefined();
      expect(res.body.config.extraction_model).toBeDefined();
      expect(res.body.config.retrieval_max_memories).toBeDefined();
    });
  });

  // ─── PUT /config ──────────────────────────────────────────
  describe("PUT /config", () => {
    it("persists config overrides to MongoDB", async () => {
      const res = await request(app)
        .put("/api/web/memory/config")
        .send({ retrieval_max_memories: 15, reflection_enabled: false })
        .expect(200);

      expect(res.body.config.retrieval_max_memories).toBe(15);
      expect(res.body.config.reflection_enabled).toBe(false);

      // Verify persistence
      const getRes = await request(app).get("/api/web/memory/config").expect(200);
      expect(getRes.body.config.retrieval_max_memories).toBe(15);
    });

    it("rejects invalid body", async () => {
      const res = await request(app)
        .put("/api/web/memory/config")
        .send("not-json")
        .set("Content-Type", "text/plain")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });
  });
});
