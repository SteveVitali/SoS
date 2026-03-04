/**
 * Query Expander stage — generates HyDE hypothetical documents and embeds all query variants.
 * Phase 1: HyDE generation + batch embedding of all expanded queries.
 */

import { createLogger } from "../../../../shared/logger.js";
import type {
  ExpandedQuery,
  QueryAnalysis,
  QueryType,
  ResearchConfig,
} from "../../../../shared/researchTypes.js";
import type { EmbeddingProvider } from "../../embeddings.js";
import type { StepRecorder } from "../auditLog.js";
import type { LLMClient } from "../llmClient.js";

const log = createLogger("server:kb:research:queryExpander");

const HYDE_PROMPT = `You are a technical documentation writer. For each question below, write a short, detailed paragraph that would be found in a technical knowledge base as an answer. Do not hedge or say "I don't know" — write as if you are the documentation itself.

Respond in JSON format:
{
  "answers": ["paragraph for question 1", "paragraph for question 2", ...]
}

Respond ONLY with valid JSON, no markdown fences.

Questions:`;

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Deduplicate expanded queries by cosine similarity.
 * Keeps higher-priority types (original > decomposed > hyde > step_back > follow_up).
 */
function dedup(queries: ExpandedQuery[], threshold: number): ExpandedQuery[] {
  const priority: Record<QueryType, number> = {
    original: 0,
    decomposed: 1,
    follow_up: 2,
    hyde: 3,
    step_back: 4,
  };

  // Sort by priority (lower = higher priority)
  const sorted = [...queries].sort((a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99));

  const kept: ExpandedQuery[] = [];
  for (const q of sorted) {
    const isDuplicate = kept.some(
      (existing) => cosineSimilarity(existing.vector, q.vector) >= threshold,
    );
    if (!isDuplicate) {
      kept.push(q);
    }
  }

  return kept;
}

export async function runQueryExpander(
  originalQuery: string,
  analysis: QueryAnalysis,
  config: ResearchConfig,
  llm: LLMClient,
  embeddingProvider: EmbeddingProvider,
  recorder: StepRecorder,
): Promise<ExpandedQuery[]> {
  // Collect all queries to process
  const queryTexts: Array<{ text: string; type: QueryType; source?: string }> = [
    { text: originalQuery, type: "original" },
  ];

  for (const sub of analysis.sub_queries) {
    queryTexts.push({ text: sub, type: "decomposed", source: originalQuery });
  }

  if (analysis.step_back_query) {
    queryTexts.push({ text: analysis.step_back_query, type: "step_back", source: originalQuery });
  }

  recorder.recordInput({
    original_query: originalQuery,
    sub_queries: analysis.sub_queries,
    step_back_query: analysis.step_back_query,
    enable_hyde: config.enable_hyde,
  });

  // Generate HyDE hypothetical answers
  let hydeTexts: string[] = [];
  if (config.enable_hyde) {
    const questionsBlock = queryTexts.map((q, i) => `${i + 1}. ${q.text}`).join("\n");

    try {
      const hydeResponse = await llm.chat(
        [
          { role: "system", content: HYDE_PROMPT },
          { role: "user", content: questionsBlock },
        ],
        { json_mode: true },
      );

      recorder.recordLLMCall(
        llm.toAuditRecord(hydeResponse, "query_expansion", "hyde_generate", questionsBlock),
      );

      const parsed = JSON.parse(hydeResponse.content);
      hydeTexts = Array.isArray(parsed.answers) ? parsed.answers : [];
    } catch (err) {
      log.warn("HyDE generation failed, continuing without", {
        error: (err as Error).message,
      });
    }
  }

  // Add HyDE answers as additional queries
  for (let i = 0; i < hydeTexts.length && i < queryTexts.length; i++) {
    if (typeof hydeTexts[i] === "string" && hydeTexts[i].length > 0) {
      queryTexts.push({
        text: hydeTexts[i],
        type: "hyde",
        source: queryTexts[i].text,
      });
    }
  }

  // Batch embed all query texts
  const allTexts = queryTexts.map((q) => q.text);
  let embeddings: number[][];
  try {
    embeddings = await embeddingProvider.embed(allTexts);
  } catch (err) {
    log.error("Embedding failed for query expansion", { error: (err as Error).message });
    throw err;
  }

  // Build expanded queries
  const expanded: ExpandedQuery[] = queryTexts.map((q, i) => ({
    text: q.text,
    vector: embeddings[i],
    type: q.type,
    source_query: q.source,
  }));

  // Deduplicate
  const deduped = dedup(expanded, config.dedup_threshold);

  log.info("Queries expanded", {
    total_before_dedup: expanded.length,
    after_dedup: deduped.length,
    hyde_generated: hydeTexts.length,
  });

  recorder.recordOutput({
    total_queries: expanded.length,
    deduped_queries: deduped.length,
    hyde_generated: hydeTexts.length,
    query_types: deduped.map((q) => q.type),
  });
  recorder.finish({
    total_queries: expanded.length,
    deduped: deduped.length,
    hyde: hydeTexts.length,
  });

  return deduped;
}
