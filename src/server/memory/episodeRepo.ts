/**
 * MongoDB repository for the `interaction_episodes` collection.
 * Stores InteractionEpisode documents — records of every user interaction.
 */

import type { Collection } from "mongodb";
import { createLogger } from "../../shared/logger.js";
import type { InteractionEpisode, OutcomeSignal } from "../../shared/memoryTypes.js";
import { getDb } from "../mongo.js";

const log = createLogger("server:memory:episodeRepo");

function episodesCol(): Collection<InteractionEpisode> {
  return getDb().collection<InteractionEpisode>("interaction_episodes");
}

/**
 * Ensure indexes on the interaction_episodes collection.
 */
export async function ensureEpisodeIndexes(): Promise<void> {
  const col = episodesCol();
  await col.createIndex({ episode_id: 1 }, { unique: true, name: "idx_episode_id_unique" });
  await col.createIndex({ owner: 1, timestamp: -1 }, { name: "idx_owner_timestamp" });
  await col.createIndex(
    { owner: 1, extraction_status: 1 },
    { name: "idx_owner_extraction_status" },
  );
  await col.createIndex({ task_id: 1 }, { name: "idx_task_id" });
  log.info("Episode indexes ensured");
}

/**
 * Insert a new interaction episode.
 */
export async function insertEpisode(episode: InteractionEpisode): Promise<InteractionEpisode> {
  await episodesCol().insertOne(episode);
  log.debug("Episode inserted", { episode_id: episode.episode_id });
  return episode;
}

/**
 * Find an episode by its episode_id.
 */
export async function findEpisode(episodeId: string): Promise<InteractionEpisode | null> {
  return episodesCol().findOne({ episode_id: episodeId });
}

/**
 * List episodes for an owner with optional filters.
 */
export async function listEpisodes(options: {
  owner?: string;
  routed_action?: string;
  extraction_status?: InteractionEpisode["extraction_status"];
  limit?: number;
  offset?: number;
}): Promise<{ episodes: InteractionEpisode[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (options.owner) filter.owner = options.owner;
  if (options.routed_action) filter.routed_action = options.routed_action;
  if (options.extraction_status) filter.extraction_status = options.extraction_status;

  const col = episodesCol();
  const total = await col.countDocuments(filter);
  const episodes = await col
    .find(filter)
    .sort({ timestamp: -1 })
    .skip(options.offset ?? 0)
    .limit(options.limit ?? 50)
    .toArray();

  return { episodes, total };
}

/**
 * Update an episode's extraction status and extracted memory IDs.
 */
export async function updateExtractionStatus(
  episodeId: string,
  status: InteractionEpisode["extraction_status"],
  extractedMemoryIds?: string[],
): Promise<InteractionEpisode | null> {
  const updates: Record<string, unknown> = { extraction_status: status };
  if (extractedMemoryIds) updates.extracted_memory_ids = extractedMemoryIds;

  const result = await episodesCol().findOneAndUpdate(
    { episode_id: episodeId },
    { $set: updates },
    { returnDocument: "after" },
  );
  return result ?? null;
}

/**
 * Append outcome signals to an episode.
 */
export async function appendSignals(
  episodeId: string,
  signals: OutcomeSignal[],
): Promise<InteractionEpisode | null> {
  if (signals.length === 0) {
    // Still mark as collected so the signal collector doesn't reprocess this episode
    const result = await episodesCol().findOneAndUpdate(
      { episode_id: episodeId },
      { $set: { signal_collected_at: new Date() } },
      { returnDocument: "after" },
    );
    return result ?? null;
  }

  const result = await episodesCol().findOneAndUpdate(
    { episode_id: episodeId },
    {
      $push: { signals: { $each: signals } },
      $set: { signal_collected_at: new Date() },
    },
    { returnDocument: "after" },
  );
  return result ?? null;
}

/**
 * Count total episodes for an owner.
 */
export async function countEpisodes(owner?: string): Promise<number> {
  const filter: Record<string, unknown> = {};
  if (owner) filter.owner = owner;
  return episodesCol().countDocuments(filter);
}
