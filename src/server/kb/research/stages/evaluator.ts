/**
 * Evaluator stage — LLM-based reranking and CRAG relevance classification.
 * Phase 1: Reranking with scores.
 * Phase 2: CRAG relevance classification (correct/incorrect/ambiguous) + reformulation.
 */

import type { KBSearchResult } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type {
  ChunkEvaluation,
  EvaluationResult,
  ResearchConfig,
} from "../../../../shared/researchTypes.js";
import type { StepRecorder } from "../auditLog.js";
import type { LLMClient } from "../llmClient.js";

const log = createLogger("server:kb:research:evaluator");

const RERANK_PROMPT = `You are a search result evaluator. Given a user's question and search results, rate each result's relevance.

For each result, provide:
- "index": the result number (1-based)
- "score": relevance score from 1 to 5 (5 = directly answers the question, 1 = completely irrelevant)
- "relevance": "correct" if the result contains information that helps answer the question, "incorrect" if it is not relevant at all, or "ambiguous" if it is tangentially related
- "reason": a one-sentence explanation

Respond as a JSON object: {"evaluations": [{"index": 1, "score": 5, "relevance": "correct", "reason": "..."}, ...]}
Respond ONLY with valid JSON, no markdown fences.`;

const REFORMULATE_PROMPT = `The following search results were retrieved for the user's question but many are not relevant. Suggest 2-3 alternative search queries that would find better results.

Respond as JSON: {"reformulated_queries": ["...", "..."]}
Respond ONLY with valid JSON, no markdown fences.`;

const MAX_CHUNK_PREVIEW_CHARS = 500;

export async function runEvaluator(
  query: string,
  chunks: KBSearchResult[],
  config: ResearchConfig,
  llm: LLMClient,
  recorder: StepRecorder,
): Promise<EvaluationResult> {
  recorder.recordInput({
    query,
    num_chunks: chunks.length,
    enable_crag: config.enable_crag,
  });

  if (chunks.length === 0) {
    const emptyResult: EvaluationResult = {
      evaluations: [],
      needs_requery: false,
      reformulated_queries: [],
      correct_count: 0,
      incorrect_count: 0,
      ambiguous_count: 0,
    };
    recorder.recordOutput(emptyResult as unknown as Record<string, unknown>);
    recorder.finish({ correct: 0, incorrect: 0, ambiguous: 0 });
    return emptyResult;
  }

  // Build the results block for the LLM
  const resultsBlock = chunks
    .map((c, i) => {
      const preview = c.content.slice(0, MAX_CHUNK_PREVIEW_CHARS);
      const source = c.metadata.section
        ? `${c.source_file} > ${c.metadata.section}`
        : c.source_file;
      return `[${i + 1}] (${c.kb_name}: ${source}, score: ${c.score.toFixed(2)})\n${preview}`;
    })
    .join("\n\n");

  const userMessage = `Question: ${query}\n\nResults:\n${resultsBlock}`;

  const response = await llm.chat(
    [
      { role: "system", content: RERANK_PROMPT },
      { role: "user", content: userMessage },
    ],
    { json_mode: true },
  );

  recorder.recordLLMCall(llm.toAuditRecord(response, "evaluation", "rerank_evaluate", query));

  // Parse evaluations
  let evaluations: ChunkEvaluation[] = [];
  try {
    const parsed = JSON.parse(response.content);
    const rawEvals = Array.isArray(parsed.evaluations) ? parsed.evaluations : [];

    evaluations = rawEvals
      // biome-ignore lint/suspicious/noExplicitAny: dynamic JSON parse result
      .filter((e: any) => typeof e.index === "number" && e.index >= 1 && e.index <= chunks.length)
      // biome-ignore lint/suspicious/noExplicitAny: dynamic JSON parse result
      .map((e: any) => ({
        chunk: chunks[e.index - 1],
        relevance: (["correct", "incorrect", "ambiguous"].includes(e.relevance)
          ? e.relevance
          : "ambiguous") as "correct" | "incorrect" | "ambiguous",
        score: typeof e.score === "number" ? Math.max(1, Math.min(5, e.score)) : 3,
        reasoning: typeof e.reason === "string" ? e.reason : "",
      }));
  } catch (err) {
    log.warn("Failed to parse evaluation response, treating all as ambiguous", {
      error: (err as Error).message,
    });
    evaluations = chunks.map((chunk) => ({
      chunk,
      relevance: "ambiguous" as const,
      score: 3,
      reasoning: "Evaluation parse failed",
    }));
  }

  // Ensure all chunks have evaluations (in case LLM missed some)
  const evaluatedIndices = new Set(evaluations.map((e) => e.chunk));
  for (const chunk of chunks) {
    if (!evaluatedIndices.has(chunk)) {
      evaluations.push({
        chunk,
        relevance: "ambiguous",
        score: 3,
        reasoning: "Not evaluated by LLM",
      });
    }
  }

  // Sort by score descending
  evaluations.sort((a, b) => b.score - a.score);

  // Count relevance categories
  const correct_count = evaluations.filter((e) => e.relevance === "correct").length;
  const incorrect_count = evaluations.filter((e) => e.relevance === "incorrect").length;
  const ambiguous_count = evaluations.filter((e) => e.relevance === "ambiguous").length;
  const total = evaluations.length;

  // CRAG decision logic (Phase 2)
  let needs_requery = false;
  let reformulated_queries: string[] = [];

  if (config.enable_crag) {
    // If ≥40% are incorrect, or all are ambiguous, trigger re-query
    const incorrectRatio = total > 0 ? incorrect_count / total : 0;
    const correctRatio = total > 0 ? correct_count / total : 0;

    if (incorrectRatio >= 0.4 || (correctRatio < 0.6 && total > 0)) {
      needs_requery = true;

      // Generate reformulated queries
      const incorrectSummaries = evaluations
        .filter((e) => e.relevance === "incorrect")
        .map((e) => `- ${e.chunk.content.slice(0, 100)}`)
        .join("\n");

      try {
        const reformResponse = await llm.chat(
          [
            { role: "system", content: REFORMULATE_PROMPT },
            {
              role: "user",
              content: `Question: ${query}\n\nPoor results:\n${incorrectSummaries}`,
            },
          ],
          { json_mode: true },
        );

        recorder.recordLLMCall(
          llm.toAuditRecord(reformResponse, "evaluation", "reformulate_queries", query),
        );

        const parsed = JSON.parse(reformResponse.content);
        reformulated_queries = Array.isArray(parsed.reformulated_queries)
          ? parsed.reformulated_queries.filter((q: unknown) => typeof q === "string")
          : [];
      } catch (err) {
        log.warn("Reformulation failed", { error: (err as Error).message });
      }
    }
  }

  const result: EvaluationResult = {
    evaluations,
    needs_requery,
    reformulated_queries,
    correct_count,
    incorrect_count,
    ambiguous_count,
  };

  log.info("Evaluation complete", {
    correct: correct_count,
    incorrect: incorrect_count,
    ambiguous: ambiguous_count,
    needs_requery,
    reformulated: reformulated_queries.length,
  });

  recorder.recordOutput({
    correct: correct_count,
    incorrect: incorrect_count,
    ambiguous: ambiguous_count,
    needs_requery,
    reformulated_queries: reformulated_queries.length,
  });
  recorder.finish({
    correct: correct_count,
    incorrect: incorrect_count,
    ambiguous: ambiguous_count,
    needs_requery,
  });

  return result;
}
