/**
 * Express routes for the memory system HTTP API.
 * Mounted at /api/web/memory.
 *
 * See §11 of the memory design spec.
 */

import { type Request, type Response, Router } from "express";
import { createLogger } from "../../shared/logger.js";
import type { MemoryConfig, MemoryType } from "../../shared/memoryTypes.js";
import type { ServerConfig } from "../config.js";
import { getEmbeddingProvider } from "../kb/embeddings.js";
import { getDb as mongoGetDb } from "../mongo.js";
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

const MEMORY_CONFIG_COLLECTION = "memory_config";

/**
 * Get or create the persisted config overrides document from MongoDB.
 */
async function getPersistedConfigOverrides(): Promise<Partial<MemoryConfig>> {
  try {
    const doc = await mongoGetDb()
      .collection(MEMORY_CONFIG_COLLECTION)
      .findOne({ _id: "config" as any });
    if (!doc) return {};
    const { _id, ...rest } = doc;
    return rest as Partial<MemoryConfig>;
  } catch {
    return {};
  }
}

/**
 * Persist config overrides to MongoDB.
 */
async function persistConfigOverrides(overrides: Partial<MemoryConfig>): Promise<void> {
  await mongoGetDb()
    .collection(MEMORY_CONFIG_COLLECTION)
    .updateOne({ _id: "config" as any }, { $set: overrides }, { upsert: true });
}

/**
 * Build effective config: env var defaults merged with persisted overrides.
 */
async function getEffectiveConfig(): Promise<MemoryConfig> {
  const base = loadMemoryConfig();
  const overrides = await getPersistedConfigOverrides();
  return { ...base, ...overrides };
}

export function createMemoryRoutes(config: ServerConfig): Router {
  const router = Router();

  // ─── GET /stats ────────────────────────────────────────────────
  router.get("/stats", async (_req: Request, res: Response) => {
    try {
      const memoriesByType = await countMemoriesByType();
      const totalMemories = Object.values(memoriesByType).reduce((a, b) => a + b, 0);

      const { total: activeMemories } = await listMemories({
        include_invalidated: false,
        limit: 0,
      });
      const { total: allMemories } = await listMemories({
        include_invalidated: true,
        limit: 0,
      });
      const invalidatedMemories = allMemories - activeMemories;

      const totalEpisodes = await countEpisodes();

      res.json({
        total_memories: totalMemories,
        active_memories: activeMemories,
        invalidated_memories: invalidatedMemories,
        total_episodes: totalEpisodes,
        memories_by_type: memoriesByType,
      });
    } catch (err) {
      log.warn("Failed to get memory stats", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to get memory stats" });
    }
  });

  // ─── GET /memories ─────────────────────────────────────────────
  router.get("/memories", async (req: Request, res: Response) => {
    try {
      const memoryType = req.query.type as MemoryType | undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Number(req.query.offset) || 0;
      const tag = req.query.tag as string | undefined;

      const result = await listMemories({
        memory_type: memoryType,
        tags: tag ? [tag] : undefined,
        include_invalidated: false,
        limit,
        offset,
      });

      res.json({ memories: result.memories, total: result.total });
    } catch (err) {
      log.warn("Failed to list memories", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to list memories" });
    }
  });

  // ─── GET /memories/:memory_id ──────────────────────────────────
  router.get("/memories/:memory_id", async (req: Request, res: Response) => {
    try {
      const memoryId = String(req.params.memory_id);
      const memory = await findMemory(memoryId);
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }

      // Fetch linked memories
      const linked = [];
      for (const linkedId of memory.linked_memory_ids) {
        const linkedMemory = await findMemory(linkedId);
        if (linkedMemory) linked.push(linkedMemory);
      }

      res.json({ memory, linked });
    } catch (err) {
      log.warn("Failed to get memory", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to get memory" });
    }
  });

  // ─── POST /search ──────────────────────────────────────────────
  router.post("/search", async (req: Request, res: Response) => {
    try {
      const { query, owner, memory_types, tags, limit, min_score } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const effectiveConfig = await getEffectiveConfig();
      const results = await searchMemories(query, owner || "global", effectiveConfig, {
        memory_types,
        tags,
        limit,
        min_score,
      });

      res.json({ results });
    } catch (err) {
      log.warn("Memory search failed", { error: (err as Error).message });
      res.status(500).json({ error: "Memory search failed" });
    }
  });

  // ─── POST /reflect ─────────────────────────────────────────────
  router.post("/reflect", async (req: Request, res: Response) => {
    try {
      const owner = (req.body.owner as string) || config.slackJobOwner || "global";
      const effectiveConfig = await getEffectiveConfig();
      const result = await runReflection(owner, effectiveConfig);
      res.json({ result });
    } catch (err) {
      log.warn("Reflection trigger failed", { error: (err as Error).message });
      res.status(500).json({ error: "Reflection failed" });
    }
  });

  // ─── DELETE /memories/:memory_id ───────────────────────────────
  router.delete("/memories/:memory_id", async (req: Request, res: Response) => {
    try {
      const result = await invalidateMemory(String(req.params.memory_id));
      if (!result) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.warn("Failed to invalidate memory", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to invalidate memory" });
    }
  });

  // ─── PUT /memories/:memory_id ──────────────────────────────────
  router.put("/memories/:memory_id", async (req: Request, res: Response) => {
    try {
      const { content, importance, tags } = req.body;
      const memoryId = String(req.params.memory_id);

      const existing = await findMemory(memoryId);
      if (!existing) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }

      const updates: Record<string, unknown> = {};
      if (content !== undefined) updates.content = content;
      if (importance !== undefined) updates.importance = importance;
      if (tags !== undefined) updates.tags = tags;

      // Rebuild embedding text if content or tags changed
      const needsReembed = content !== undefined || tags !== undefined;
      const updatedContent = content ?? existing.content;
      const updatedTags = tags ?? existing.tags;

      if (needsReembed) {
        const embeddingText = buildEmbeddingText(
          updatedContent,
          existing.context,
          existing.keywords,
        );
        updates.embedding_text = embeddingText;
      }

      const updated = await updateMemory(memoryId, updates as any);
      if (!updated) {
        res.status(500).json({ error: "Failed to update memory" });
        return;
      }

      // Re-embed if content or tags changed
      if (needsReembed) {
        try {
          const embeddingProvider = getEmbeddingProvider();
          const embeddingText = buildEmbeddingText(
            updatedContent,
            existing.context,
            existing.keywords,
          );
          const [vector] = await embeddingProvider.embed([embeddingText]);

          await addToMemoryTable(existing.owner, [
            {
              id: memoryId,
              owner: existing.owner,
              content: embeddingText,
              memory_type: existing.memory_type,
              vector,
              tags: JSON.stringify(updatedTags),
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
              tags: updatedTags.join(" "),
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

      res.json({ memory: updated });
    } catch (err) {
      log.warn("Failed to edit memory", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to edit memory" });
    }
  });

  // ─── GET /profile ──────────────────────────────────────────────
  router.get("/profile", async (req: Request, res: Response) => {
    try {
      const owner = req.query.owner as string | undefined;
      const { memories } = await listMemories({
        owner,
        memory_type: "user_profile",
        include_invalidated: false,
        limit: 1,
      });

      res.json({ profile: memories.length > 0 ? memories[0] : null });
    } catch (err) {
      log.warn("Failed to get user profile", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to get user profile" });
    }
  });

  // ─── GET /episodes ─────────────────────────────────────────────
  router.get("/episodes", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Number(req.query.offset) || 0;
      const action = req.query.action as string | undefined;

      const result = await listEpisodes({
        routed_action: action,
        limit,
        offset,
      });

      res.json({ episodes: result.episodes, total: result.total });
    } catch (err) {
      log.warn("Failed to list episodes", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to list episodes" });
    }
  });

  // ─── GET /episodes/:episode_id ─────────────────────────────────
  router.get("/episodes/:episode_id", async (req: Request, res: Response) => {
    try {
      const episode = await findEpisode(String(req.params.episode_id));
      if (!episode) {
        res.status(404).json({ error: "Episode not found" });
        return;
      }

      const memories = await findMemoriesByEpisode(episode.episode_id);
      res.json({ episode, memories });
    } catch (err) {
      log.warn("Failed to get episode", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to get episode" });
    }
  });

  // ─── GET /config ───────────────────────────────────────────────
  router.get("/config", async (_req: Request, res: Response) => {
    try {
      const effectiveConfig = await getEffectiveConfig();
      res.json({ config: effectiveConfig });
    } catch (err) {
      log.warn("Failed to get memory config", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to get memory config" });
    }
  });

  // ─── PUT /config ───────────────────────────────────────────────
  router.put("/config", async (req: Request, res: Response) => {
    try {
      const overrides = req.body as Partial<MemoryConfig>;
      if (!overrides || typeof overrides !== "object") {
        res.status(400).json({ error: "Request body must be a partial MemoryConfig object" });
        return;
      }

      await persistConfigOverrides(overrides);
      const effectiveConfig = await getEffectiveConfig();
      res.json({ config: effectiveConfig });
    } catch (err) {
      log.warn("Failed to update memory config", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to update memory config" });
    }
  });

  return router;
}
