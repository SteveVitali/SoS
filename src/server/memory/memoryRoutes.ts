/**
 * API routes for memory system management.
 * Mounted at /api/web/memory.
 */

import { type Request, type Response, Router } from "express";
import { createLogger } from "../../shared/logger.js";
import type {
  MemoryConfig,
  MemoryNote,
  MemorySearchRequest,
  MemoryType,
} from "../../shared/memoryTypes.js";
import type { ServerConfig } from "../config.js";
import { getEmbeddingProvider } from "../kb/embeddings.js";
import { getDb } from "../mongo.js";
import { countEpisodes, findEpisode, listEpisodes } from "./episodeRepo.js";
import { loadMemoryConfig } from "./memoryConfig.js";
import { addToMemoryFTS, deleteFromMemoryFTS } from "./memoryFtsStore.js";
import {
  countMemoriesByType,
  findMemoriesByEpisode,
  findMemory,
  invalidateMemory,
  listMemories,
  updateMemory,
} from "./memoryRepo.js";
import { searchMemories } from "./memorySearch.js";
import { buildEmbeddingText } from "./memoryUtils.js";
import { addToMemoryTable } from "./memoryVectorStore.js";
import { runReflection } from "./pipelines/reflectionEngine.js";

const log = createLogger("server:memory:routes");

/** Memory config collection name in MongoDB for persisted overrides. */
const MEMORY_CONFIG_COLLECTION = "memory_config";

function pstr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/**
 * Load memory config, merging persisted overrides from MongoDB.
 */
async function getEffectiveConfig(): Promise<MemoryConfig> {
  const base = loadMemoryConfig();
  try {
    const col = getDb().collection(MEMORY_CONFIG_COLLECTION);
    const doc = await col.findOne({ _id: "config" as any });
    if (doc) {
      const { _id, ...overrides } = doc;
      return { ...base, ...overrides } as MemoryConfig;
    }
  } catch {
    // Fall through to base config if DB read fails
  }
  return base;
}

/**
 * Persist partial config overrides to MongoDB.
 */
async function persistConfigOverrides(overrides: Partial<MemoryConfig>): Promise<MemoryConfig> {
  const col = getDb().collection(MEMORY_CONFIG_COLLECTION);
  await col.updateOne({ _id: "config" as any }, { $set: overrides }, { upsert: true });
  return getEffectiveConfig();
}

/**
 * Web-facing memory routes (mounted at /api/web/memory).
 */
export function createMemoryRoutes(_config: ServerConfig): Router {
  const router = Router();

  // GET /api/web/memory/stats → MemoryStats
  router.get("/stats", async (_req: Request, res: Response) => {
    try {
      const memoriesByType = await countMemoriesByType();
      const totalEpisodes = await countEpisodes();

      const { total: totalMemories } = await listMemories({ include_invalidated: true, limit: 0 });
      const { total: activeMemories } = await listMemories({
        include_invalidated: false,
        limit: 0,
      });
      const invalidatedMemories = totalMemories - activeMemories;

      // Get last extraction and reflection timestamps from most recent episodes/reflections
      const { episodes: recentEpisodes } = await listEpisodes({ limit: 1 });
      const lastExtractionAt =
        recentEpisodes.length > 0 && recentEpisodes[0].extraction_status === "extracted"
          ? recentEpisodes[0].timestamp
          : undefined;

      const { memories: recentReflections } = await listMemories({
        memory_type: "reflection",
        limit: 1,
      });
      const lastReflectionAt =
        recentReflections.length > 0 ? recentReflections[0].updated_at : undefined;

      res.json({
        total_memories: totalMemories,
        active_memories: activeMemories,
        invalidated_memories: invalidatedMemories,
        total_episodes: totalEpisodes,
        memories_by_type: memoriesByType,
        last_extraction_at: lastExtractionAt,
        last_reflection_at: lastReflectionAt,
      });
    } catch (err: any) {
      log.error("Memory stats error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/memory/memories?type=fact|reflection&limit=50&offset=0&tag=<tag>
  router.get("/memories", async (req: Request, res: Response) => {
    try {
      const memoryType = req.query.type ? (pstr(req.query.type) as MemoryType) : undefined;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const tag = req.query.tag ? pstr(req.query.tag) : undefined;

      const result = await listMemories({
        memory_type: memoryType,
        tags: tag ? [tag] : undefined,
        limit,
        offset,
      });

      res.json({ memories: result.memories, total: result.total });
    } catch (err: any) {
      log.error("List memories error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/memory/memories/:memory_id → single memory + linked memories
  router.get("/memories/:memory_id", async (req: Request, res: Response) => {
    try {
      const memoryId = pstr(req.params.memory_id);
      const memory = await findMemory(memoryId);
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }

      // Fetch linked memories
      let linked: MemoryNote[] = [];
      if (memory.linked_memory_ids.length > 0) {
        const linkPromises = memory.linked_memory_ids.map((id) => findMemory(id));
        const results = await Promise.all(linkPromises);
        linked = results.filter((m): m is MemoryNote => m !== null);
      }

      res.json({ memory, linked });
    } catch (err: any) {
      log.error("Get memory error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/web/memory/search → hybrid search
  router.post("/search", async (req: Request, res: Response) => {
    try {
      const body = req.body as MemorySearchRequest;

      if (!body.query || typeof body.query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const config = await getEffectiveConfig();
      const results = await searchMemories(body.query, body.owner ?? "global", config, {
        memory_types: body.memory_types,
        tags: body.tags,
        limit: body.limit,
        min_score: body.min_score,
      });

      res.json({ results });
    } catch (err: any) {
      log.error("Memory search error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/web/memory/reflect → trigger reflection pipeline manually
  router.post("/reflect", async (req: Request, res: Response) => {
    try {
      const owner = req.body?.owner || "global";
      const config = await getEffectiveConfig();

      const result = await runReflection(owner, config);
      res.json({ result });
    } catch (err: any) {
      log.error("Reflection trigger error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/web/memory/memories/:memory_id → invalidate (NOT physical delete)
  router.delete("/memories/:memory_id", async (req: Request, res: Response) => {
    try {
      const memoryId = pstr(req.params.memory_id);
      const existing = await findMemory(memoryId);
      if (!existing) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }

      await invalidateMemory(memoryId);
      res.json({ ok: true });
    } catch (err: any) {
      log.error("Invalidate memory error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/web/memory/memories/:memory_id → manual edit
  router.put("/memories/:memory_id", async (req: Request, res: Response) => {
    try {
      const memoryId = pstr(req.params.memory_id);
      const existing = await findMemory(memoryId);
      if (!existing) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }

      const { content, importance, tags } = req.body;
      const updates: Partial<
        Pick<MemoryNote, "content" | "importance" | "tags" | "embedding_text">
      > = {};
      if (content !== undefined) updates.content = content;
      if (importance !== undefined) updates.importance = importance;
      if (tags !== undefined) updates.tags = tags;

      // Rebuild embedding text if content or tags changed
      if (content !== undefined || tags !== undefined) {
        const newContent = content ?? existing.content;
        const newTags = tags ?? existing.tags;
        const embeddingText = buildEmbeddingText(newContent, existing.context, existing.keywords);
        updates.embedding_text = embeddingText;

        // Re-embed in vector and FTS stores
        try {
          const embeddingProvider = getEmbeddingProvider();
          const [vector] = await embeddingProvider.embed([embeddingText]);

          await addToMemoryTable(existing.owner, [
            {
              id: memoryId,
              owner: existing.owner,
              content: embeddingText,
              memory_type: existing.memory_type,
              vector,
              tags: JSON.stringify(newTags),
              importance: importance ?? existing.importance,
              created_at: existing.created_at.toISOString(),
              updated_at: new Date().toISOString(),
            },
          ]);

          deleteFromMemoryFTS(existing.owner, memoryId);
          addToMemoryFTS(existing.owner, [
            {
              memory_id: memoryId,
              owner: existing.owner,
              content: embeddingText,
              keywords: existing.keywords.join(" "),
              tags: (newTags as string[]).join(" "),
              memory_type: existing.memory_type,
            },
          ]);
        } catch (err) {
          log.warn("Failed to re-embed edited memory", {
            memoryId,
            error: (err as Error).message,
          });
        }
      }

      const updated = await updateMemory(memoryId, updates);
      res.json({ memory: updated });
    } catch (err: any) {
      log.error("Edit memory error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/memory/profile → user profile MemoryNote
  router.get("/profile", async (req: Request, res: Response) => {
    try {
      const owner = req.query.owner ? pstr(req.query.owner) : undefined;
      const { memories } = await listMemories({
        owner,
        memory_type: "user_profile",
        include_invalidated: false,
        limit: 1,
      });

      res.json({ profile: memories.length > 0 ? memories[0] : null });
    } catch (err: any) {
      log.error("Get profile error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/memory/episodes?limit=50&offset=0&action=<routed_action>
  router.get("/episodes", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const routedAction = req.query.action ? pstr(req.query.action) : undefined;

      const result = await listEpisodes({
        routed_action: routedAction,
        limit,
        offset,
      });

      res.json({ episodes: result.episodes, total: result.total });
    } catch (err: any) {
      log.error("List episodes error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/memory/episodes/:episode_id → single episode + extracted memories
  router.get("/episodes/:episode_id", async (req: Request, res: Response) => {
    try {
      const episodeId = pstr(req.params.episode_id);
      const episode = await findEpisode(episodeId);
      if (!episode) {
        res.status(404).json({ error: "Episode not found" });
        return;
      }

      // Fetch memories extracted from this episode
      const memories = await findMemoriesByEpisode(episodeId);

      res.json({ episode, memories });
    } catch (err: any) {
      log.error("Get episode error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/memory/config → current MemoryConfig
  router.get("/config", async (_req: Request, res: Response) => {
    try {
      const config = await getEffectiveConfig();
      res.json({ config });
    } catch (err: any) {
      log.error("Get memory config error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/web/memory/config → update config (persist to MongoDB)
  router.put("/config", async (req: Request, res: Response) => {
    try {
      const updates = req.body as Partial<MemoryConfig>;
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        res.status(400).json({ error: "Request body must be a partial MemoryConfig object" });
        return;
      }

      const config = await persistConfigOverrides(updates);
      res.json({ config });
    } catch (err: any) {
      log.error("Update memory config error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
