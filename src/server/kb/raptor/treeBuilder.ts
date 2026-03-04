/**
 * RAPTOR tree builder — recursively clusters and summarizes chunks to build
 * a hierarchical summary tree for multi-level retrieval.
 */

import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../../shared/logger.js";
import type { RaptorConfig, RaptorStatus } from "../../../shared/researchTypes.js";
import { getEmbeddingProvider } from "../embeddings.js";
import { createResearchLLMClient } from "../research/llmClient.js";
import { addToKBTable, searchKBTable, type VectorRecord } from "../vectorStore.js";
import { type ClusterInput, kMeansClusters } from "./clusterer.js";
import { getRaptorStatus, saveRaptorStatus } from "./raptorRepo.js";
import { summarizeCluster } from "./summarizer.js";

const log = createLogger("server:kb:raptor:treeBuilder");

const DEFAULT_RAPTOR_CONFIG: RaptorConfig = {
  target_cluster_size: 8,
  min_cluster_size: 5,
  max_levels: 4,
  summary_model: "",
  max_summary_input_tokens: 4000,
};

/**
 * Load all records at a given level from a KB's vector store.
 * Uses a broad search to pull all records, then filters by level.
 */
async function loadRecordsAtLevel(
  kbId: string,
  level: number,
  totalChunks: number,
): Promise<Array<{ id: string; content: string; vector: number[] }>> {
  // We need to load embeddings for clustering. LanceDB doesn't support
  // filtering without a vector query, so we use a zero-vector search
  // with a large limit to pull all records, then filter by level.
  // This is a workaround; for very large KBs, sampling may be needed.

  const embeddingProvider = getEmbeddingProvider();
  const dim = embeddingProvider.dimensions;

  // Use a zero-vector to get all records (distance doesn't matter, we want all)
  const zeroVector = new Array(dim).fill(0);
  const limit = Math.min(totalChunks * 2, 10000); // safety cap

  const results = await searchKBTable(kbId, zeroVector, limit);

  // Filter by level
  const filtered = results.filter((r) => (r.level ?? 0) === level);

  log.info("Loaded records at level", {
    kbId,
    level,
    total_scanned: results.length,
    at_level: filtered.length,
  });

  // We need the vectors for clustering. Since LanceDB search returns results
  // without vectors, we'll need to re-embed the content.
  // This is an optimization opportunity — for now, re-embed.
  const contents = filtered.map((r) => r.content);
  let vectors: number[][] = [];

  if (contents.length > 0) {
    vectors = await embeddingProvider.embed(contents);
  }

  return filtered.map((r, i) => ({
    id: r.id,
    content: r.content,
    vector: vectors[i] || [],
  }));
}

/**
 * Build a RAPTOR tree for a knowledge base.
 *
 * Algorithm:
 * 1. Load all level-0 chunks + embeddings
 * 2. While current_level nodes > min_cluster_size:
 *    a. Cluster nodes at current_level using k-means
 *    b. For each cluster, LLM-summarize and embed
 *    c. Store as new records at level = current_level + 1
 *    d. Increment current_level
 * 3. Record tree metadata
 */
export async function buildRaptorTree(
  kbId: string,
  totalChunkCount: number,
  userConfig?: Partial<RaptorConfig>,
): Promise<RaptorStatus> {
  const config = { ...DEFAULT_RAPTOR_CONFIG, ...userConfig };
  const startTime = Date.now();

  // Concurrency guard: check if a build is already in progress
  const existing = await getRaptorStatus(kbId);
  if (existing?.building) {
    log.warn("RAPTOR build already in progress, skipping", { kbId });
    return existing;
  }

  // Mark build as in-progress with initial progress info
  await saveRaptorStatus(kbId, {
    built: existing?.built ?? false,
    building: true,
    levels: existing?.levels ?? 0,
    nodes_per_level: existing?.nodes_per_level ?? {},
    total_nodes: existing?.total_nodes ?? 0,
    last_built: existing?.last_built,
    build_duration_ms: existing?.build_duration_ms,
    phase: "Loading chunks",
    current_level: 0,
    build_started_at: new Date(),
  });

  log.info("RAPTOR tree build started", { kbId, config });

  try {
    const embeddingProvider = getEmbeddingProvider();
    const llm = createResearchLLMClient(
      config.summary_model ? { model: config.summary_model } : undefined,
    );

    const nodesPerLevel: Record<number, number> = {};
    let currentLevel = 0;

    // Load level-0 chunks
    let currentNodes = await loadRecordsAtLevel(kbId, 0, totalChunkCount);
    nodesPerLevel[0] = currentNodes.length;

    if (currentNodes.length === 0) {
      log.warn("No level-0 chunks found, cannot build RAPTOR tree", { kbId });
      const status: RaptorStatus = {
        built: false,
        levels: 0,
        nodes_per_level: {},
        total_nodes: 0,
      };
      await saveRaptorStatus(kbId, status);
      return status;
    }

    let totalNodes = currentNodes.length;

    // Rough estimate of total levels (may shrink as we progress)
    let estimatedTotalLevels = Math.min(
      config.max_levels,
      Math.max(
        1,
        Math.ceil(
          Math.log(currentNodes.length / config.min_cluster_size) /
            Math.log(config.target_cluster_size),
        ),
      ),
    );

    while (currentNodes.length > config.min_cluster_size && currentLevel < config.max_levels) {
      const k = Math.max(1, Math.ceil(currentNodes.length / config.target_cluster_size));

      if (k >= currentNodes.length) {
        // Can't cluster further
        break;
      }

      // Save progress: clustering phase
      await saveRaptorStatus(kbId, {
        built: existing?.built ?? false,
        building: true,
        levels: currentLevel,
        nodes_per_level: nodesPerLevel,
        total_nodes: totalNodes,
        last_built: existing?.last_built,
        current_level: currentLevel,
        estimated_total_levels: estimatedTotalLevels,
        clusters_completed: 0,
        clusters_total: k,
        phase: "Clustering",
        build_started_at: new Date(startTime),
      });

      log.info("RAPTOR clustering level", {
        kbId,
        level: currentLevel,
        nodes: currentNodes.length,
        k,
      });

      // Cluster
      const clusterInputs: ClusterInput[] = currentNodes.map((n) => ({
        id: n.id,
        vector: n.vector,
        content: n.content,
      }));

      const clusters = kMeansClusters(clusterInputs, k);

      // Save progress: entering summarization phase
      const nonEmptyClusters = clusters.filter((c) => c.members.length > 0);
      await saveRaptorStatus(kbId, {
        built: existing?.built ?? false,
        building: true,
        levels: currentLevel,
        nodes_per_level: nodesPerLevel,
        total_nodes: totalNodes,
        last_built: existing?.last_built,
        current_level: currentLevel,
        estimated_total_levels: estimatedTotalLevels,
        clusters_completed: 0,
        clusters_total: nonEmptyClusters.length,
        phase: "Summarizing",
        build_started_at: new Date(startTime),
      });

      // Summarize each cluster and create next-level records
      const nextLevelNodes: Array<{ id: string; content: string; vector: number[] }> = [];
      const newRecords: VectorRecord[] = [];
      let clustersCompleted = 0;

      for (const cluster of clusters) {
        if (cluster.members.length === 0) continue;

        // Summarize
        const summaryText = await summarizeCluster(
          cluster.members.map((m) => ({ id: m.id, content: m.content })),
          llm,
          { maxInputTokens: config.max_summary_input_tokens },
        );

        clustersCompleted++;

        // Save progress after each cluster summarization
        await saveRaptorStatus(kbId, {
          built: existing?.built ?? false,
          building: true,
          levels: currentLevel,
          nodes_per_level: nodesPerLevel,
          total_nodes: totalNodes,
          last_built: existing?.last_built,
          current_level: currentLevel,
          estimated_total_levels: estimatedTotalLevels,
          clusters_completed: clustersCompleted,
          clusters_total: nonEmptyClusters.length,
          phase: "Summarizing",
          build_started_at: new Date(startTime),
        });

        if (!summaryText.trim()) continue;

        // Embed the summary
        const [summaryVector] = await embeddingProvider.embed([summaryText]);

        const nodeId = uuidv4();
        const childIds = cluster.members.map((m) => m.id);

        const record: VectorRecord = {
          id: nodeId,
          kb_id: kbId,
          source_file: `__raptor_L${currentLevel + 1}__`,
          content: summaryText,
          vector: summaryVector,
          section: `RAPTOR Level ${currentLevel + 1} Summary`,
          page: 0,
          file_path: "",
          parent_dir: "",
          created_at: new Date().toISOString(),
          level: currentLevel + 1,
          children_ids: JSON.stringify(childIds),
        };

        newRecords.push(record);
        nextLevelNodes.push({
          id: nodeId,
          content: summaryText,
          vector: summaryVector,
        });
      }

      // Store new level records
      if (newRecords.length > 0) {
        await addToKBTable(kbId, newRecords);
      }

      currentLevel++;
      nodesPerLevel[currentLevel] = nextLevelNodes.length;
      totalNodes += nextLevelNodes.length;
      currentNodes = nextLevelNodes;

      // Re-estimate remaining levels
      if (currentNodes.length <= config.min_cluster_size) {
        estimatedTotalLevels = currentLevel;
      }

      log.info("RAPTOR level built", {
        kbId,
        level: currentLevel,
        nodes: nextLevelNodes.length,
        total_nodes: totalNodes,
      });
    }

    const buildDuration = Date.now() - startTime;

    const status: RaptorStatus = {
      built: true,
      building: false,
      levels: currentLevel + 1,
      nodes_per_level: nodesPerLevel,
      total_nodes: totalNodes,
      last_built: new Date(),
      build_duration_ms: buildDuration,
    };

    await saveRaptorStatus(kbId, status);

    log.info("RAPTOR tree build complete", {
      kbId,
      levels: status.levels,
      total_nodes: totalNodes,
      duration_ms: buildDuration,
    });

    return status;
  } catch (err) {
    // Clear building flag on failure so the user can retry
    log.error("RAPTOR tree build failed", { kbId, error: (err as Error).message });
    await saveRaptorStatus(kbId, {
      built: existing?.built ?? false,
      building: false,
      levels: existing?.levels ?? 0,
      nodes_per_level: existing?.nodes_per_level ?? {},
      total_nodes: existing?.total_nodes ?? 0,
      last_built: existing?.last_built,
      build_duration_ms: existing?.build_duration_ms,
      error_message: (err as Error).message,
    });
    throw err;
  }
}
