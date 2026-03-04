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
import { saveRaptorStatus } from "./raptorRepo.js";
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
 * Delete all RAPTOR summary records (level > 0) for a KB.
 */
async function _deleteRaptorLevels(kbId: string): Promise<void> {
  // LanceDB doesn't have great support for conditional deletes on all fields.
  // We'll rely on the fact that RAPTOR records have source_file = "__raptor__"
  // For now, we store RAPTOR summaries with a distinctive source_file prefix.
  // This is handled in the addRaptorRecords function.

  // Note: A full implementation would delete where level > 0, but LanceDB
  // has limitations on filter-based deletes. We use the source_file convention.
  // Note: A full delete-by-level implementation requires LanceDB filter support.
  // For now, RAPTOR summaries are identified by their source_file prefix.
  log.info("RAPTOR level cleanup requested", { kbId });
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

  log.info("RAPTOR tree build started", { kbId, config });

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

  while (currentNodes.length > config.min_cluster_size && currentLevel < config.max_levels) {
    const k = Math.max(1, Math.ceil(currentNodes.length / config.target_cluster_size));

    if (k >= currentNodes.length) {
      // Can't cluster further
      break;
    }

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

    // Summarize each cluster and create next-level records
    const nextLevelNodes: Array<{ id: string; content: string; vector: number[] }> = [];
    const newRecords: VectorRecord[] = [];

    for (const cluster of clusters) {
      if (cluster.members.length === 0) continue;

      // Summarize
      const summaryText = await summarizeCluster(
        cluster.members.map((m) => ({ id: m.id, content: m.content })),
        llm,
        { maxInputTokens: config.max_summary_input_tokens },
      );

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
}
