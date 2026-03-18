/**
 * Normalizes KB and Memory search results into a common ContextItem format
 * for cross-source ranking and serialization.
 */

import type { KBSearchResult } from "../../shared/kbTypes.js";
import type { MemorySearchResult } from "../../shared/memoryTypes.js";
import type { ContextItem } from "./contextTypes.js";

/**
 * Normalize KB search results into ContextItem[].
 */
export function normalizeKBResults(results: KBSearchResult[]): ContextItem[] {
  return results.map((r, i) => {
    const sectionSuffix = r.metadata.section ? ` > ${r.metadata.section}` : "";
    const filePath = r.metadata.file_path || r.source_file;
    const tag = `${r.kb_name} > ${filePath}${sectionSuffix}`;

    return {
      id: `kb-${r.kb_id}-${i}`,
      content: r.content,
      source: "kb" as const,
      raw_score: r.score,
      metadata: {
        kb_name: r.kb_name,
        kb_id: r.kb_id,
        source_file: r.source_file,
        section: r.metadata.section,
        file_path: r.metadata.file_path,
        parent_dir: r.metadata.parent_dir,
        rrf_score: r.rrf_score,
        retrieval_source: r.retrieval_source,
        temporal_tag: tag,
      },
    };
  });
}

/**
 * Normalize Memory search results into ContextItem[].
 */
export function normalizeMemoryResults(results: MemorySearchResult[]): ContextItem[] {
  return results.map((r) => {
    const { memory } = r;
    let tag: string;

    if (memory.memory_type === "reflection") {
      const episodeCount = memory.source_episodes.length;
      tag = `reflection, from ${episodeCount} interaction${episodeCount !== 1 ? "s" : ""}`;
    } else {
      const dateStr = memory.updated_at.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      tag = `${memory.memory_type}, learned ${dateStr}`;
    }

    return {
      id: `mem-${memory.memory_id}`,
      content: memory.content,
      source: "memory" as const,
      raw_score: r.score,
      metadata: {
        memory_type: memory.memory_type,
        memory_id: memory.memory_id,
        importance: r.importance_score,
        recency_score: r.recency_score,
        access_count: memory.access_count,
        temporal_tag: tag,
      },
    };
  });
}
