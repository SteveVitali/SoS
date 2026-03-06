/**
 * Retriever stage — searches knowledge bases using hybrid retrieval (vector + keyword).
 * Wraps hybridSearch with multi-query support and deduplication.
 */

import { v4 as uuidv4 } from "uuid";
import type { KBScope, KBSearchResult } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type {
  ExpandedQuery,
  ResearchConfig,
  RetrievalRecord,
} from "../../../../shared/researchTypes.js";
import { hybridSearch } from "../../hybridSearch.js";
import { listEnabledKBsByScope } from "../../kbRepo.js";
import { distanceToSimilarity } from "../../kbService.js";
import { searchKBTable } from "../../vectorStore.js";
import type { StepRecorder } from "../auditLog.js";

const log = createLogger("server:kb:research:retriever");

export interface RetrievalStageResult {
  chunks: KBSearchResult[];
  retrievalRecords: RetrievalRecord[];
}

/**
 * Deduplicate chunks by content similarity (exact content match + score-based).
 */
function deduplicateChunks(chunks: KBSearchResult[]): KBSearchResult[] {
  const seen = new Set<string>();
  const deduped: KBSearchResult[] = [];
  for (const chunk of chunks) {
    // Deduplicate by content hash (first 200 chars + source)
    const key = `${chunk.kb_id}:${chunk.source_file}:${chunk.content.slice(0, 200)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(chunk);
    }
  }
  return deduped;
}

export async function runRetriever(
  expandedQueries: ExpandedQuery[],
  scopes: KBScope[],
  config: ResearchConfig,
  recorder: StepRecorder,
  owner?: string,
): Promise<RetrievalStageResult> {
  recorder.recordInput({
    num_queries: expandedQueries.length,
    query_types: expandedQueries.map((q) => q.type),
    scopes,
  });

  // Find all enabled KBs matching the requested scopes
  const kbs = await listEnabledKBsByScope(scopes, owner);
  if (kbs.length === 0) {
    recorder.recordOutput({ kbs_found: 0, chunks_retrieved: 0 });
    recorder.finish({ kbs_searched: 0, chunks: 0 });
    return { chunks: [], retrievalRecords: [] };
  }

  const allChunks: KBSearchResult[] = [];
  const retrievalRecords: RetrievalRecord[] = [];

  // For each expanded query, probe KBs and do full search on passing ones
  for (const eq of expandedQueries) {
    const start = Date.now();
    const kbIdsSearched: string[] = [];
    let queryResultCount = 0;
    let queryTopScore = 0;
    let queryVectorHits = 0;
    let queryKeywordHits = 0;
    let queryBothHits = 0;

    for (const kb of kbs) {
      const minScore = config.min_similarity_score;
      const perKBLimit = config.max_chunks_per_query;

      try {
        // Probe first (limit=1, vector-only) to check relevance
        const probe = await searchKBTable(kb.kb_id, eq.vector, 1);
        if (probe.length === 0) continue;

        const probeScore = distanceToSimilarity(probe[0]._distance);
        if (probeScore < minScore) continue;

        // Hybrid search (vector + keyword)
        kbIdsSearched.push(kb.kb_id);
        const { results, stats } = await hybridSearch(kb.kb_id, eq.vector, eq.text, perKBLimit, {
          minSimilarityScore: minScore,
          kbName: kb.name,
        });

        queryVectorHits += stats.vector_only;
        queryKeywordHits += stats.keyword_only;
        queryBothHits += stats.both;

        for (const r of results) {
          allChunks.push(r);
          queryResultCount++;
          if (r.score > queryTopScore) queryTopScore = r.score;
        }
      } catch (err: unknown) {
        log.warn("Retrieval failed for KB, skipping", {
          kbId: kb.kb_id,
          query_type: eq.type,
          error: (err as Error).message,
        });
      }
    }

    retrievalRecords.push({
      call_id: uuidv4(),
      query_text: eq.text.slice(0, 200),
      query_type: eq.type,
      kb_ids_searched: kbIdsSearched,
      results_count: queryResultCount,
      top_score: queryTopScore,
      duration_ms: Date.now() - start,
      vector_hits: queryVectorHits,
      keyword_hits: queryKeywordHits,
      both_hits: queryBothHits,
    });

    // Record each retrieval in the audit
    for (const rec of retrievalRecords.slice(-1)) {
      recorder.recordRetrieval(rec);
    }
  }

  // Deduplicate across all queries
  allChunks.sort((a, b) => b.score - a.score);
  const deduped = deduplicateChunks(allChunks);

  log.info("Retrieval complete", {
    queries: expandedQueries.length,
    kbs_available: kbs.length,
    total_chunks: allChunks.length,
    deduped_chunks: deduped.length,
  });

  recorder.recordOutput({
    total_chunks: allChunks.length,
    deduped_chunks: deduped.length,
    kbs_searched: new Set(allChunks.map((c) => c.kb_id)).size,
  });
  recorder.finish({
    chunks: deduped.length,
    kbs_searched: new Set(allChunks.map((c) => c.kb_id)).size,
  });

  return { chunks: deduped, retrievalRecords };
}
