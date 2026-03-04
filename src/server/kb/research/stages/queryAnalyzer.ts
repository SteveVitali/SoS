/**
 * Query Analyzer stage — classifies query complexity and decomposes compound queries.
 * Phase 1: decomposition + step-back question generation.
 */

import { createLogger } from "../../../../shared/logger.js";
import type { QueryAnalysis, ResearchConfig } from "../../../../shared/researchTypes.js";
import type { StepRecorder } from "../auditLog.js";
import type { LLMClient } from "../llmClient.js";

const log = createLogger("server:kb:research:queryAnalyzer");

const ANALYZE_PROMPT = `You are a query analyzer for a knowledge base search system.

Given the user's question, analyze it and respond in JSON:
{
  "complexity": "simple" | "compound" | "multi_hop",
  "sub_queries": ["...", "..."],
  "step_back_query": "..."
}

Rules:
- "simple": Question can be answered from a single passage. sub_queries should be empty [].
- "compound": Question has multiple distinct parts. Decompose into 2-4 sub_queries.
- "multi_hop": Answering requires finding fact A to know what to search for about B. Decompose into ordered sub_queries (2-4).
- step_back_query: A broader, more abstract version of the question that retrieves background context. Always provide this.
- Keep sub_queries concise and specific — they will be used as search queries.
- Respond ONLY with valid JSON, no markdown fences.`;

export async function runQueryAnalyzer(
  query: string,
  config: ResearchConfig,
  llm: LLMClient,
  recorder: StepRecorder,
): Promise<QueryAnalysis> {
  recorder.recordInput({
    query,
    enable_decomposition: config.enable_decomposition,
    enable_step_back: config.enable_step_back,
  });

  // If decomposition is disabled in simple strategy, do a lightweight analysis
  if (!config.enable_decomposition && !config.enable_step_back) {
    const result: QueryAnalysis = {
      complexity: "simple",
      sub_queries: [],
    };
    recorder.recordOutput(result);
    recorder.finish({ complexity: "simple", sub_queries: 0 });
    return result;
  }

  const response = await llm.chat(
    [
      { role: "system", content: ANALYZE_PROMPT },
      { role: "user", content: query },
    ],
    { json_mode: true },
  );

  recorder.recordLLMCall(llm.toAuditRecord(response, "query_analysis", "analyze_query", query));

  let analysis: QueryAnalysis;
  try {
    const parsed = JSON.parse(response.content);
    analysis = {
      complexity: parsed.complexity || "simple",
      sub_queries: Array.isArray(parsed.sub_queries) ? parsed.sub_queries : [],
      step_back_query:
        typeof parsed.step_back_query === "string" ? parsed.step_back_query : undefined,
    };
  } catch (err) {
    log.warn("Failed to parse query analysis, defaulting to simple", {
      error: (err as Error).message,
      content: response.content.slice(0, 200),
    });
    analysis = { complexity: "simple", sub_queries: [] };
  }

  // Enforce config toggles
  if (!config.enable_decomposition) {
    analysis.sub_queries = [];
  }
  if (!config.enable_step_back) {
    analysis.step_back_query = undefined;
  }

  log.info("Query analyzed", {
    complexity: analysis.complexity,
    sub_queries: analysis.sub_queries.length,
    has_step_back: !!analysis.step_back_query,
  });

  recorder.recordOutput(analysis);
  recorder.finish({
    complexity: analysis.complexity,
    sub_queries: analysis.sub_queries.length,
    has_step_back: !!analysis.step_back_query,
  });

  return analysis;
}
