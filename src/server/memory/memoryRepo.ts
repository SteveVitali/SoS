/**
 * MongoDB repository for the `memories` collection.
 * Stores MemoryNote documents — facts, reflections, and user profiles.
 */

import type { Collection } from "mongodb";
import { createLogger } from "../../shared/logger.js";
import type { MemoryNote, MemoryType } from "../../shared/memoryTypes.js";
import { getDb } from "../mongo.js";

const log = createLogger("server:memory:repo");

function memoriesCol(): Collection<MemoryNote> {
  return getDb().collection<MemoryNote>("memories");
}

/**
 * Ensure indexes on the memories collection.
 */
export async function ensureMemoryNoteIndexes(): Promise<void> {
  const col = memoriesCol();
  await col.createIndex({ memory_id: 1 }, { unique: true, name: "idx_memory_id_unique" });
  await col.createIndex(
    { owner: 1, memory_type: 1, updated_at: -1 },
    { name: "idx_owner_type_updated" },
  );
  await col.createIndex({ owner: 1, invalidated_at: 1 }, { name: "idx_owner_invalidated" });
  await col.createIndex({ owner: 1, tags: 1 }, { name: "idx_owner_tags" });
  await col.createIndex({ source_episodes: 1 }, { name: "idx_source_episodes" });
  log.info("Memory note indexes ensured");
}

/**
 * Insert a new memory note.
 */
export async function insertMemory(memory: MemoryNote): Promise<MemoryNote> {
  await memoriesCol().insertOne(memory);
  log.info("Memory created", { memory_id: memory.memory_id, type: memory.memory_type });
  return memory;
}

/**
 * Find a memory note by its memory_id.
 */
export async function findMemory(memoryId: string): Promise<MemoryNote | null> {
  return memoriesCol().findOne({ memory_id: memoryId });
}

/**
 * List memory notes for an owner with optional filters.
 */
export async function listMemories(options: {
  owner?: string;
  memory_type?: MemoryType;
  tags?: string[];
  include_invalidated?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ memories: MemoryNote[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (options.owner) filter.owner = options.owner;
  if (options.memory_type) filter.memory_type = options.memory_type;
  if (options.tags && options.tags.length > 0) filter.tags = { $in: options.tags };
  if (!options.include_invalidated) filter.invalidated_at = { $exists: false };

  const col = memoriesCol();
  const total = await col.countDocuments(filter);
  const memories = await col
    .find(filter)
    .sort({ updated_at: -1 })
    .skip(options.offset ?? 0)
    .limit(options.limit ?? 50)
    .toArray();

  return { memories, total };
}

/**
 * Update a memory note's fields.
 */
export async function updateMemory(
  memoryId: string,
  updates: Partial<
    Pick<
      MemoryNote,
      | "content"
      | "context"
      | "keywords"
      | "tags"
      | "importance"
      | "confidence"
      | "embedding_text"
      | "source_episodes"
      | "linked_memory_ids"
      | "link_reasons"
      | "access_count"
      | "last_accessed_at"
    >
  >,
): Promise<MemoryNote | null> {
  const result = await memoriesCol().findOneAndUpdate(
    { memory_id: memoryId },
    { $set: { ...updates, updated_at: new Date() } },
    { returnDocument: "after" },
  );
  return result ?? null;
}

/**
 * Invalidate a memory note (soft-delete).
 */
export async function invalidateMemory(
  memoryId: string,
  invalidatedBy?: string,
): Promise<MemoryNote | null> {
  const result = await memoriesCol().findOneAndUpdate(
    { memory_id: memoryId },
    {
      $set: {
        invalidated_at: new Date(),
        ...(invalidatedBy ? { invalidated_by: invalidatedBy } : {}),
        updated_at: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  return result ?? null;
}

/**
 * Increment access_count and update last_accessed_at for retrieved memories.
 */
export async function incrementAccessCount(memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  await memoriesCol().updateMany(
    { memory_id: { $in: memoryIds } },
    { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } },
  );
}

/**
 * Find memories by source episode ID.
 */
export async function findMemoriesByEpisode(episodeId: string): Promise<MemoryNote[]> {
  return memoriesCol().find({ source_episodes: episodeId }).toArray();
}

/**
 * Count memories by type for an owner.
 */
export async function countMemoriesByType(owner?: string): Promise<Record<MemoryType, number>> {
  const filter: Record<string, unknown> = {};
  if (owner) filter.owner = owner;

  const col = memoriesCol();
  const pipeline = [{ $match: filter }, { $group: { _id: "$memory_type", count: { $sum: 1 } } }];
  const results = await col.aggregate(pipeline).toArray();

  const counts: Record<MemoryType, number> = { fact: 0, reflection: 0, user_profile: 0 };
  for (const r of results) {
    const type = r._id as MemoryType;
    if (type in counts) counts[type] = r.count;
  }
  return counts;
}
