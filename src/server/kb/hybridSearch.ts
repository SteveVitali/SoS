/**
 * Hybrid search — combines vector (semantic) and keyword (lexical) retrieval
 * using Reciprocal Rank Fusion (RRF) for score merging.
 *
 * Vector search (LanceDB) excels at semantic similarity but misses exact strings,
 * code symbols, config flags, and rare terms. Keyword search (SQLite FTS5) excels
 * at those but misses semantic meaning. Hybrid search gives you both.
 *
 * RRF formula: score(chunk) = Σ 1 / (k + rank_i)
 * where k=60 (standard constant) and rank_i is the 1-based rank in each result list.
 * Chunks appearing in only one list receive a single RRF contribution.
 */

import type { KBSearchResult } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import { searchFTS } from "./ftsStore.js";
import { distanceToSimilarity } from "./kbService.js";
import { searchKBTable, type VectorSearchResult } from "./vectorStore.js";

const log = createLogger("server:kb:hybridSearch");

/** RRF constant — standard value from the original RRF paper. */
const RRF_K = 60;

/** Default number of candidates to retrieve from each index before fusion. */
const DEFAULT_PER_INDEX_LIMIT = 25;

export interface HybridSearchConfig {
  /** Max candidates to pull from each index (vector and keyword). Default: 25. */
  perIndexLimit?: number;
  /** Minimum similarity score (0-1) for vector results. Applied pre-fusion. */
  minSimilarityScore?: number;
  /** KB name to attach to results (for display). */
  kbName?: string;
}

interface RankedCandidate {
  /** Unique key for deduplication (chunk_id or content-based fallback). */
  key: string;
  /** The search result. */
  result: KBSearchResult;
  /** 1-based rank in vector results (undefined if not in vector results). */
  vectorRank?: number;
  /** 1-based rank in keyword results (undefined if not in keyword results). */
  keywordRank?: number;
  /** Fused RRF score. */
  rrfScore: number;
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
 * Convert a LanceDB VectorSearchResult to a KBSearchResult.
 */
function vectorToKBResult(r: VectorSearchResult, kbName: string): KBSearchResult {
  return {
    content: r.content,
    source_file: r.source_file,
    kb_name: kbName,
    kb_id: r.kb_id,
    score: distanceToSimilarity(r._distance),
    metadata: {
      section: r.section || undefined,
      page: r.page || undefined,
      file_path: r.file_path || undefined,
      parent_dir: r.parent_dir || undefined,
    },
  };
}

/**
 * Run hybrid search on a single KB, combining vector and keyword results via RRF.
 *
 * @param kbId - Knowledge base ID to search
 * @param queryVector - Embedding vector for semantic search
 * @param queryText - Raw query text for keyword search
 * @param limit - Maximum number of fused results to return
 * @param config - Optional configuration overrides
 * @returns Merged, deduplicated, RRF-ranked search results
 */
export async function hybridSearch(
  kbId: string,
  queryVector: number[],
  queryText: string,
  limit: number,
  config?: HybridSearchConfig,
): Promise<KBSearchResult[]> {
  const perIndexLimit = config?.perIndexLimit ?? DEFAULT_PER_INDEX_LIMIT;
  const minScore = config?.minSimilarityScore ?? 0;
  const kbName = config?.kbName ?? "";

  // --- Run both searches in parallel (FTS is synchronous, vector is async) ---
  const keywordResults = searchFTS(kbId, queryText, perIndexLimit);
  const vectorResults = await searchKBTable(kbId, queryVector, perIndexLimit);

  // If both are empty, short-circuit
  if (vectorResults.length === 0 && keywordResults.length === 0) {
    return [];
  }

  // --- Build candidate map keyed by chunk ID ---
  const candidates = new Map<string, RankedCandidate>();

  // Process vector results (already sorted by distance)
  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const similarity = distanceToSimilarity(r._distance);
    if (similarity < minScore) continue;

    const kbResult = vectorToKBResult(r, kbName);
    const key = r.id; // LanceDB records have stable IDs

    candidates.set(key, {
      key,
      result: kbResult,
      vectorRank: i + 1,
      keywordRank: undefined,
      rrfScore: 0, // computed below
    });
  }

  // Process keyword results (already sorted by BM25 score)
  for (let i = 0; i < keywordResults.length; i++) {
    const fts = keywordResults[i];
    const key = fts.chunk_id;

    const existing = candidates.get(key);
    if (existing) {
      // Chunk found in both indexes — add keyword rank
      existing.keywordRank = i + 1;
    } else {
      // Chunk found only in keyword index — create new candidate
      candidates.set(key, {
        key,
        result: {
          content: fts.content,
          source_file: fts.source_file,
          kb_name: kbName,
          kb_id: fts.kb_id,
          score: 0, // no vector similarity available
          metadata: {},
        },
        vectorRank: undefined,
        keywordRank: i + 1,
        rrfScore: 0,
      });
    }
  }

  // --- Compute RRF scores ---
  for (const candidate of candidates.values()) {
    candidate.rrfScore = computeRRFScore(candidate.vectorRank, candidate.keywordRank);
    // Use RRF score as the result score for downstream consumers
    candidate.result.score = candidate.rrfScore;
  }

  // --- Sort by RRF score descending and return top N ---
  const sorted = Array.from(candidates.values()).sort((a, b) => b.rrfScore - a.rrfScore);

  log.info("Hybrid search complete", {
    kbId,
    vectorHits: vectorResults.length,
    keywordHits: keywordResults.length,
    mergedCandidates: candidates.size,
    returned: Math.min(sorted.length, limit),
    topRRF: sorted[0]?.rrfScore.toFixed(4),
  });

  return sorted.slice(0, limit).map((c) => c.result);
}
