/**
 * Hybrid memory search — combines vector (semantic) and keyword (lexical) retrieval
 * using Reciprocal Rank Fusion (RRF) with composite scoring.
 *
 * Same pattern as src/server/kb/hybridSearch.ts but with the four-factor
 * composite scoring formula from §7.1 of the memory design spec.
 */

import { createLogger } from "../../shared/logger.js";
import type {
  MemoryConfig,
  MemoryNote,
  MemorySearchResult,
  MemoryType,
} from "../../shared/memoryTypes.js";
import { getEmbeddingProvider } from "../kb/embeddings.js";
import { type MemoryFTSSearchResult, searchMemoryFTS } from "./memoryFtsStore.js";
import { findMemory, incrementAccessCount } from "./memoryRepo.js";
import { type MemoryVectorSearchResult, searchMemoryTable } from "./memoryVectorStore.js";

const log = createLogger("server:memory:search");

/** RRF constant — standard value from the original RRF paper. */
const RRF_K = 60;

/** Default number of candidates to retrieve from each index before fusion. */
const DEFAULT_PER_INDEX_LIMIT = 25;

/**
 * Convert LanceDB L2 distance to a 0-1 similarity score.
 */
function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

/**
 * Compute the RRF score for a candidate given its ranks in each result list.
 */
function computeRRFScore(vectorRank?: number, keywordRank?: number): number {
  let score = 0;
  if (vectorRank !== undefined) {
    score += 1 / (RRF_K + vectorRank);
  }
  if (keywordRank !== undefined) {
    score += 1 / (RRF_K + keywordRank);
  }
  return score;
}

/**
 * Compute the recency score using exponential decay.
 * Formula: exp(-ln(2) * days_since_update / halflife_days)
 */
export function computeRecencyScore(updatedAt: Date, halflifeDays: number): number {
  const now = Date.now();
  const daysSinceUpdate = (now - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.LN2 * daysSinceUpdate) / halflifeDays);
}

/**
 * Compute the access score.
 * Formula: min(1.0, log2(1 + access_count) / 5)
 */
export function computeAccessScore(accessCount: number): number {
  return Math.min(1.0, Math.log2(1 + accessCount) / 5);
}

/**
 * Compute the composite score using the four-factor formula from §7.1.
 */
export function computeCompositeScore(
  similarityScore: number,
  recencyScore: number,
  importance: number,
  accessScore: number,
  config: MemoryConfig,
): number {
  return (
    config.weight_similarity * similarityScore +
    config.weight_recency * recencyScore +
    config.weight_importance * importance +
    config.weight_access * accessScore
  );
}

interface RankedCandidate {
  memoryId: string;
  vectorRank?: number;
  keywordRank?: number;
  rrfScore: number;
  similarityScore: number;
  keywordScore?: number;
}

/**
 * Search memories using hybrid vector + keyword retrieval with composite scoring.
 *
 * Algorithm:
 * 1. Embed query text
 * 2. Vector search in LanceDB mem_{owner}
 * 3. Keyword search in FTS5 mem_fts_{owner}
 * 4. RRF merge (k=60)
 * 5. Fetch full MemoryNote from MongoDB
 * 6. Compute composite score (similarity + recency + importance + access)
 * 7. Filter invalidated, apply min_score
 * 8. Sort descending, return top N
 * 9. Async increment access_count
 */
export async function searchMemories(
  query: string,
  owner: string,
  config: MemoryConfig,
  options?: {
    memory_types?: MemoryType[];
    tags?: string[];
    limit?: number;
    min_score?: number;
  },
): Promise<MemorySearchResult[]> {
  const limit = options?.limit ?? config.retrieval_max_memories;
  const minScore = options?.min_score ?? config.retrieval_min_score;

  // 1. Embed query
  const embeddingProvider = getEmbeddingProvider();
  let queryVector: number[];
  try {
    [queryVector] = await embeddingProvider.embed([query]);
  } catch (err) {
    log.warn("Failed to embed memory search query", { error: (err as Error).message });
    return [];
  }

  // 2 + 3. Run vector and keyword search in parallel
  const perIndexLimit = DEFAULT_PER_INDEX_LIMIT;
  const [vectorResults, keywordResults] = await Promise.all([
    searchMemoryTable(owner, queryVector, perIndexLimit),
    Promise.resolve(searchMemoryFTS(owner, query, perIndexLimit)),
  ]);

  if (vectorResults.length === 0 && keywordResults.length === 0) {
    return [];
  }

  // 4. Build candidate map and compute RRF
  const candidates = new Map<string, RankedCandidate>();

  // Process vector results
  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const similarity = distanceToSimilarity(r._distance);
    candidates.set(r.id, {
      memoryId: r.id,
      vectorRank: i + 1,
      rrfScore: 0,
      similarityScore: similarity,
    });
  }

  // Process keyword results
  for (let i = 0; i < keywordResults.length; i++) {
    const fts = keywordResults[i];
    const existing = candidates.get(fts.memory_id);
    if (existing) {
      existing.keywordRank = i + 1;
      existing.keywordScore = fts.bm25_score;
    } else {
      candidates.set(fts.memory_id, {
        memoryId: fts.memory_id,
        keywordRank: i + 1,
        rrfScore: 0,
        similarityScore: 0,
        keywordScore: fts.bm25_score,
      });
    }
  }

  // Compute RRF scores
  for (const candidate of candidates.values()) {
    candidate.rrfScore = computeRRFScore(candidate.vectorRank, candidate.keywordRank);
  }

  // Sort by RRF score and take top candidates for MongoDB lookup
  const sortedCandidates = Array.from(candidates.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, perIndexLimit);

  // 5. Fetch full MemoryNote documents from MongoDB
  const results: MemorySearchResult[] = [];
  const fetchPromises = sortedCandidates.map(async (candidate) => {
    const memory = await findMemory(candidate.memoryId);
    if (!memory) return null;

    // 6. Filter invalidated
    if (memory.invalidated_at) return null;

    // Filter by memory_types if specified
    if (options?.memory_types && !options.memory_types.includes(memory.memory_type)) {
      return null;
    }

    // Filter by tags if specified
    if (options?.tags && options.tags.length > 0) {
      const hasMatchingTag = options.tags.some((t) => memory.tags.includes(t));
      if (!hasMatchingTag) return null;
    }

    // Compute composite score components
    const recencyScore = computeRecencyScore(
      memory.updated_at,
      config.retrieval_recency_halflife_days,
    );
    const accessScore = computeAccessScore(memory.access_count);
    const similarityScore = candidate.similarityScore;

    const compositeScore = computeCompositeScore(
      similarityScore,
      recencyScore,
      memory.importance,
      accessScore,
      config,
    );

    // 7. Apply min_score filter
    if (compositeScore < minScore) return null;

    return {
      memory,
      score: compositeScore,
      similarity_score: similarityScore,
      keyword_score: candidate.keywordScore,
      recency_score: recencyScore,
      importance_score: memory.importance,
      access_score: accessScore,
    } satisfies MemorySearchResult;
  });

  const fetched = await Promise.all(fetchPromises);
  for (const r of fetched) {
    if (r) results.push(r);
  }

  // 8. Sort by composite score descending, take top N
  results.sort((a, b) => b.score - a.score);
  const finalResults = results.slice(0, limit);

  log.info("Memory search complete", {
    owner,
    query: query.slice(0, 100),
    vectorHits: vectorResults.length,
    keywordHits: keywordResults.length,
    candidates: candidates.size,
    returned: finalResults.length,
  });

  // 9. Async: increment access_count on returned results (fire-and-forget)
  const returnedIds = finalResults.map((r) => r.memory.memory_id);
  if (returnedIds.length > 0) {
    incrementAccessCount(returnedIds).catch((err) => {
      log.warn("Failed to increment access counts", { error: (err as Error).message });
    });
  }

  return finalResults;
}
