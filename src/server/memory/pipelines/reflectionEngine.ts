/**
 * Pipeline D: Reflection & Consolidation
 *
 * Periodic pipeline that clusters recent episodes by topic, generates
 * higher-level reflections via LLM, and synthesizes/updates user profiles.
 *
 * See §6.4 of the memory design spec.
 */

import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../../shared/logger.js";
import type { InteractionEpisode, MemoryConfig, MemoryNote } from "../../../shared/memoryTypes.js";
import { getEmbeddingProvider } from "../../kb/embeddings.js";
import { listEpisodes } from "../episodeRepo.js";
import { addToMemoryFTS, deleteFromMemoryFTS } from "../memoryFtsStore.js";
import { findMemory, insertMemory, listMemories, updateMemory } from "../memoryRepo.js";
import { searchMemories } from "../memorySearch.js";
import { buildEmbeddingText, createMemoryLLMClient } from "../memoryUtils.js";
import { addToMemoryTable } from "../memoryVectorStore.js";
import { buildProfileSynthesisPrompt, buildReflectionPrompt } from "../prompts.js";
import { cosineSimilarity } from "./signalCollector.js";

const log = createLogger("server:memory:reflectionEngine");

// ─── Reflection Metadata Tracking ───────────────────────────────

/**
 * Key used to store the last reflection timestamp as a special MemoryNote.
 * We use a well-known memory_id prefix so we can find it quickly.
 */
const REFLECTION_META_PREFIX = "__reflection_meta__";

function reflectionMetaId(owner: string): string {
  return `${REFLECTION_META_PREFIX}${owner}`;
}

/**
 * Get the timestamp of the last reflection for an owner.
 */
export async function getLastReflectionTimestamp(owner: string): Promise<Date | null> {
  const meta = await findMemory(reflectionMetaId(owner));
  if (!meta) return null;
  return meta.updated_at;
}

/**
 * Record that a reflection was completed for an owner.
 */
async function recordReflectionTimestamp(owner: string): Promise<void> {
  const metaId = reflectionMetaId(owner);
  const existing = await findMemory(metaId);
  const now = new Date();

  if (existing) {
    await updateMemory(metaId, { content: `Last reflection: ${now.toISOString()}` });
  } else {
    const meta: MemoryNote = {
      memory_id: metaId,
      owner,
      memory_type: "fact",
      content: `Last reflection: ${now.toISOString()}`,
      context: "Internal reflection metadata",
      keywords: ["__internal__", "__reflection_meta__"],
      tags: ["__internal__"],
      source_episodes: [],
      source_type: "system",
      created_at: now,
      updated_at: now,
      valid_from: now,
      linked_memory_ids: [],
      link_reasons: [],
      access_count: 0,
      importance: 0,
      confidence: 1.0,
      embedding_text: "",
    };
    await insertMemory(meta);
  }
}

// ─── Clustering ─────────────────────────────────────────────────

export interface EpisodeCluster {
  episodes: InteractionEpisode[];
  embeddings: number[][];
  centroid: number[];
}

/**
 * Compute the centroid (mean) of a set of embeddings.
 */
export function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dims = embeddings[0].length;
  const centroid = new Array(dims).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dims; i++) {
      centroid[i] += emb[i];
    }
  }
  for (let i = 0; i < dims; i++) {
    centroid[i] /= embeddings.length;
  }
  return centroid;
}

/**
 * Cluster episodes by topic using a simple threshold-based greedy approach.
 * Assigns each episode to the nearest existing cluster if similarity > threshold,
 * otherwise creates a new cluster.
 */
export function clusterEpisodes(
  episodes: InteractionEpisode[],
  embeddings: number[][],
  similarityThreshold = 0.6,
): EpisodeCluster[] {
  const clusters: EpisodeCluster[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const emb = embeddings[i];
    let bestClusterIdx = -1;
    let bestSimilarity = -1;

    // Find the nearest existing cluster
    for (let j = 0; j < clusters.length; j++) {
      const sim = cosineSimilarity(emb, clusters[j].centroid);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestClusterIdx = j;
      }
    }

    if (bestClusterIdx >= 0 && bestSimilarity >= similarityThreshold) {
      // Add to existing cluster and update centroid
      clusters[bestClusterIdx].episodes.push(episodes[i]);
      clusters[bestClusterIdx].embeddings.push(emb);
      clusters[bestClusterIdx].centroid = computeCentroid(clusters[bestClusterIdx].embeddings);
    } else {
      // Create a new cluster
      clusters.push({
        episodes: [episodes[i]],
        embeddings: [emb],
        centroid: [...emb],
      });
    }
  }

  return clusters;
}

// ─── Reflection Generation ──────────────────────────────────────

interface ReflectionResult {
  content: string;
  importance: number;
  keywords: string[];
  tags: string[];
}

/**
 * Generate reflections for a cluster of episodes via LLM.
 */
async function generateReflections(
  cluster: EpisodeCluster,
  relatedMemories: MemoryNote[],
  config: MemoryConfig,
): Promise<ReflectionResult[]> {
  const llm = createMemoryLLMClient();

  // Summarize the topic from the first few episode messages
  const topicMessages = cluster.episodes.slice(0, 3).map((ep) => ep.user_message.slice(0, 80));
  const topicSummary = topicMessages.join("; ").slice(0, 200);

  const prompt = buildReflectionPrompt({
    cluster_size: cluster.episodes.length,
    topic_summary: topicSummary,
    episodes: cluster.episodes.map((ep) => ({
      timestamp: ep.timestamp.toISOString(),
      user_message: ep.user_message.slice(0, 300),
      routed_action: ep.routed_action,
      signals_summary:
        ep.signals.length > 0
          ? ep.signals.map((s) => `${s.signal_type}(${s.strength})`).join(", ")
          : "none",
    })),
    related_memories: relatedMemories.map((m) => ({
      memory_type: m.memory_type,
      content: m.content,
    })),
  });

  try {
    const response = await llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "Generate reflections from this cluster of interactions." },
      ],
      { json_mode: true },
    );

    const parsed = JSON.parse(response.content) as { reflections: ReflectionResult[] };
    if (!parsed.reflections || !Array.isArray(parsed.reflections)) {
      log.warn("Invalid reflection response format", {
        content: response.content.slice(0, 200),
      });
      return [];
    }

    return parsed.reflections;
  } catch (err) {
    log.warn("Reflection LLM call failed", { error: (err as Error).message });
    return [];
  }
}

/**
 * Store a reflection as a MemoryNote, embed in LanceDB + FTS5.
 */
async function storeReflection(
  reflection: ReflectionResult,
  cluster: EpisodeCluster,
  owner: string,
): Promise<string | null> {
  const memoryId = uuidv4();
  const now = new Date();
  const context = `Reflection from ${cluster.episodes.length} interactions`;
  const embeddingText = buildEmbeddingText(reflection.content, context, reflection.keywords);

  const memory: MemoryNote = {
    memory_id: memoryId,
    owner,
    memory_type: "reflection",
    content: reflection.content,
    context,
    keywords: reflection.keywords,
    tags: reflection.tags,
    source_episodes: cluster.episodes.map((ep) => ep.episode_id),
    source_type: cluster.episodes[0]?.source ?? "system",
    created_at: now,
    updated_at: now,
    valid_from: now,
    linked_memory_ids: [],
    link_reasons: [],
    access_count: 0,
    importance: reflection.importance,
    confidence: 0.7,
    embedding_text: embeddingText,
  };

  await insertMemory(memory);

  // Embed and index
  try {
    const embeddingProvider = getEmbeddingProvider();
    const [vector] = await embeddingProvider.embed([embeddingText]);

    await addToMemoryTable(owner, [
      {
        id: memoryId,
        owner,
        content: embeddingText,
        memory_type: "reflection",
        vector,
        tags: JSON.stringify(reflection.tags),
        importance: reflection.importance,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ]);

    addToMemoryFTS(owner, [
      {
        memory_id: memoryId,
        owner,
        content: embeddingText,
        keywords: reflection.keywords.join(" "),
        tags: reflection.tags.join(" "),
        memory_type: "reflection",
      },
    ]);
  } catch (err) {
    log.warn("Failed to embed/index reflection", {
      memoryId,
      error: (err as Error).message,
    });
  }

  log.info("Reflection stored", { memoryId, content: reflection.content.slice(0, 100) });
  return memoryId;
}

// ─── User Profile Synthesis ─────────────────────────────────────

/**
 * Synthesize or update the user profile for an owner.
 */
async function synthesizeUserProfile(owner: string, config: MemoryConfig): Promise<boolean> {
  // Fetch all active factual memories + reflections
  const { memories: factMemories } = await listMemories({
    owner,
    memory_type: "fact",
    include_invalidated: false,
    limit: 100,
  });

  const { memories: reflectionMemories } = await listMemories({
    owner,
    memory_type: "reflection",
    include_invalidated: false,
    limit: 50,
  });

  const allMemories = [...factMemories, ...reflectionMemories];
  if (allMemories.length === 0) return false;

  // Sort by importance descending, take top memories for the prompt
  allMemories.sort((a, b) => b.importance - a.importance);
  const topMemories = allMemories.slice(0, 80);

  const llm = createMemoryLLMClient();
  const prompt = buildProfileSynthesisPrompt({
    memory_count: allMemories.length,
    memories: topMemories.map((m) => ({
      memory_type: m.memory_type,
      importance: m.importance,
      content: m.content,
    })),
  });

  let profileContent: string;
  try {
    const response = await llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "Synthesize the user profile from these memories." },
      ],
      {},
    );
    profileContent = response.content.trim();
  } catch (err) {
    log.warn("Profile synthesis LLM call failed", { error: (err as Error).message });
    return false;
  }

  if (!profileContent) return false;

  // Find existing user_profile for this owner
  const { memories: existingProfiles } = await listMemories({
    owner,
    memory_type: "user_profile",
    include_invalidated: false,
    limit: 1,
  });

  const now = new Date();
  const keywords = ["user_profile", "preferences", "patterns"];
  const tags = ["user_profile"];
  const context = `Synthesized from ${allMemories.length} memories`;
  const embeddingText = buildEmbeddingText(profileContent, context, keywords);

  if (existingProfiles.length > 0) {
    // Update existing profile
    const existing = existingProfiles[0];
    await updateMemory(existing.memory_id, {
      content: profileContent,
      context,
      keywords,
      tags,
      embedding_text: embeddingText,
      source_episodes: [
        ...new Set([
          ...existing.source_episodes,
          ...allMemories.flatMap((m) => m.source_episodes).slice(0, 20),
        ]),
      ],
    });

    // Re-embed
    try {
      const embeddingProvider = getEmbeddingProvider();
      const [vector] = await embeddingProvider.embed([embeddingText]);

      await addToMemoryTable(owner, [
        {
          id: existing.memory_id,
          owner,
          content: embeddingText,
          memory_type: "user_profile",
          vector,
          tags: JSON.stringify(tags),
          importance: 0.9,
          created_at: existing.created_at.toISOString(),
          updated_at: now.toISOString(),
        },
      ]);

      deleteFromMemoryFTS(owner, existing.memory_id);
      addToMemoryFTS(owner, [
        {
          memory_id: existing.memory_id,
          owner,
          content: embeddingText,
          keywords: keywords.join(" "),
          tags: tags.join(" "),
          memory_type: "user_profile",
        },
      ]);
    } catch (err) {
      log.warn("Failed to re-embed user profile", { error: (err as Error).message });
    }

    log.info("User profile updated", { owner, memoryId: existing.memory_id });
  } else {
    // Create new profile
    const memoryId = uuidv4();
    const profile: MemoryNote = {
      memory_id: memoryId,
      owner,
      memory_type: "user_profile",
      content: profileContent,
      context,
      keywords,
      tags,
      source_episodes: allMemories.flatMap((m) => m.source_episodes).slice(0, 20),
      source_type: "system",
      created_at: now,
      updated_at: now,
      valid_from: now,
      linked_memory_ids: [],
      link_reasons: [],
      access_count: 0,
      importance: 0.9,
      confidence: 0.8,
      embedding_text: embeddingText,
    };

    await insertMemory(profile);

    try {
      const embeddingProvider = getEmbeddingProvider();
      const [vector] = await embeddingProvider.embed([embeddingText]);

      await addToMemoryTable(owner, [
        {
          id: memoryId,
          owner,
          content: embeddingText,
          memory_type: "user_profile",
          vector,
          tags: JSON.stringify(tags),
          importance: 0.9,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
      ]);

      addToMemoryFTS(owner, [
        {
          memory_id: memoryId,
          owner,
          content: embeddingText,
          keywords: keywords.join(" "),
          tags: tags.join(" "),
          memory_type: "user_profile",
        },
      ]);
    } catch (err) {
      log.warn("Failed to embed new user profile", { error: (err as Error).message });
    }

    log.info("User profile created", { owner, memoryId });
  }

  return true;
}

// ─── Main Reflection Function ───────────────────────────────────

/**
 * Run reflection and consolidation for an owner.
 *
 * 1. Fetch episodes since last reflection
 * 2. Embed all episode user_messages
 * 3. Cluster by topic
 * 4. For each cluster of >= 3 episodes, generate reflections
 * 5. Synthesize/update user profile
 * 6. Record last reflection timestamp
 */
export async function runReflection(
  owner: string,
  config: MemoryConfig,
): Promise<{
  episodes_reviewed: number;
  clusters_found: number;
  reflections_created: number;
  profile_updated: boolean;
}> {
  const result = {
    episodes_reviewed: 0,
    clusters_found: 0,
    reflections_created: 0,
    profile_updated: false,
  };

  if (!config.reflection_enabled) return result;

  // 1. Fetch episodes since last reflection
  const lastReflection = await getLastReflectionTimestamp(owner);
  const { episodes: allEpisodes } = await listEpisodes({ owner, limit: 200 });

  const episodes = lastReflection
    ? allEpisodes.filter((ep) => ep.timestamp > lastReflection)
    : allEpisodes;

  result.episodes_reviewed = episodes.length;

  // Precondition: enough episodes
  if (episodes.length < config.reflection_min_episodes) {
    log.debug("Not enough episodes for reflection", {
      owner,
      episodes: episodes.length,
      threshold: config.reflection_min_episodes,
    });
    return result;
  }

  // 2. Embed all episode user_messages
  const embeddingProvider = getEmbeddingProvider();
  let embeddings: number[][];
  try {
    embeddings = await embeddingProvider.embed(episodes.map((ep) => ep.user_message));
  } catch (err) {
    log.warn("Failed to embed episodes for reflection", { error: (err as Error).message });
    return result;
  }

  // 3. Cluster by topic
  const clusters = clusterEpisodes(episodes, embeddings);
  result.clusters_found = clusters.length;

  // 4. For each cluster of >= 3 episodes, generate reflections
  for (const cluster of clusters) {
    if (cluster.episodes.length < 3) continue;

    // Fetch related existing memories via embedding search on centroid
    let relatedMemories: MemoryNote[] = [];
    try {
      const searchResults = await searchMemories(cluster.episodes[0].user_message, owner, config, {
        memory_types: ["fact", "reflection"],
        limit: 5,
      });
      relatedMemories = searchResults.map((r) => r.memory);
    } catch (err) {
      log.debug("Failed to fetch related memories for reflection", {
        error: (err as Error).message,
      });
    }

    const reflections = await generateReflections(cluster, relatedMemories, config);

    for (const reflection of reflections) {
      const memoryId = await storeReflection(reflection, cluster, owner);
      if (memoryId) result.reflections_created++;
    }
  }

  // 5. Synthesize/update user profile
  result.profile_updated = await synthesizeUserProfile(owner, config);

  // 6. Record last reflection timestamp
  await recordReflectionTimestamp(owner);

  log.info("Reflection complete", { owner, ...result });
  return result;
}
