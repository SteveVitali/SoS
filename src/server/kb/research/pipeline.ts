/**
 * Research Pipeline runner — orchestrates the multi-stage RAG research process.
 *
 * Supports three strategies:
 * - "simple": Linear pipeline (analyze → expand → retrieve → evaluate → synthesize)
 * - "deep": Iterative pipeline with IRCoT reasoning loop
 * - "agent": Delegates to the agent loop (Phase 4)
 *
 * Budget enforcement ensures graceful termination on resource exhaustion.
 */

import type { KBScope, KBSearchResult } from "../../../shared/kbTypes.js";
import { createLogger } from "../../../shared/logger.js";
import type {
  ResearchConfig,
  ResearchConsumer,
  ResearchResult,
  ResearchSession,
  ResearchStreamEvent,
} from "../../../shared/researchTypes.js";
import { getEmbeddingProvider } from "../embeddings.js";
import { runResearchAgent } from "./agent/agentLoop.js";
import { AuditEmitter } from "./auditLog.js";
import { saveResearchSession } from "./auditRepo.js";
import { createResearchLLMClient, getResearchLLMClient } from "./llmClient.js";
import { runEvaluator } from "./stages/evaluator.js";
import { runQueryAnalyzer } from "./stages/queryAnalyzer.js";
import { runQueryExpander } from "./stages/queryExpander.js";
import { runReasoner } from "./stages/reasoner.js";
import { runRetriever } from "./stages/retriever.js";
import { runSynthesizer, type SynthesisResult } from "./stages/synthesizer.js";

const log = createLogger("server:kb:research:pipeline");

// ─── Budget enforcement ─────────────────────────────────────────

export class BudgetExhaustedError extends Error {
  constructor(public readonly resource: "llm_calls" | "retrieval_calls" | "wall_time") {
    super(`Research budget exhausted: ${resource}`);
    this.name = "BudgetExhaustedError";
  }
}

function checkBudget(session: ResearchSession, config: ResearchConfig): void {
  const llmCalls = session.steps.flatMap((s) => s.llm_calls).length;
  const retrievalCalls = session.steps.flatMap((s) => s.retrieval_calls).length;
  const elapsed = Date.now() - session.created_at.getTime();

  if (llmCalls >= config.max_llm_calls) throw new BudgetExhaustedError("llm_calls");
  if (retrievalCalls >= config.max_retrieval_calls)
    throw new BudgetExhaustedError("retrieval_calls");
  if (elapsed >= config.max_wall_time_ms) throw new BudgetExhaustedError("wall_time");
}

// ─── Chunk dedup key ────────────────────────────────────────────

/** Stable key for deduplicating search result chunks. */
export function chunkKey(c: KBSearchResult): string {
  return `${c.kb_id}:${c.source_file}:${c.content.slice(0, 100)}`;
}

// ─── Convergence detection ──────────────────────────────────────

function hasNewChunks(existingChunks: KBSearchResult[], newChunks: KBSearchResult[]): boolean {
  const existingKeys = new Set(existingChunks.map(chunkKey));
  return newChunks.some((c) => !existingKeys.has(chunkKey(c)));
}

// ─── Main pipeline ──────────────────────────────────────────────

export async function runResearchPipeline(
  query: string,
  scopes: KBScope[],
  config: ResearchConfig,
  options?: {
    owner?: string;
    consumer?: ResearchConsumer;
    onEvent?: (event: ResearchStreamEvent) => void;
  },
): Promise<ResearchResult> {
  const { owner, consumer, onEvent } = options ?? {};

  // Phase 4: delegate to agent loop
  if (config.strategy === "agent") {
    return runResearchAgent(query, scopes, config, { owner, consumer, onEvent });
  }

  const audit = new AuditEmitter(query, scopes, config, consumer, onEvent);
  const llm = config.model
    ? createResearchLLMClient({ model: config.model })
    : getResearchLLMClient();
  const embeddingProvider = getEmbeddingProvider();

  let allAccumulatedChunks: KBSearchResult[] = [];
  let reasoningTrace = "";

  try {
    // ─── Stage 1: Query Analysis ───────────────────────────
    checkBudget(audit.getSession(), config);
    const analysisRecorder = audit.startStep("query_analysis", 0);
    const analysis = await runQueryAnalyzer(query, config, llm, analysisRecorder);

    // ─── Stage 2: Query Expansion ──────────────────────────
    checkBudget(audit.getSession(), config);
    const expanderRecorder = audit.startStep("query_expansion", 0);
    let expandedQueries = await runQueryExpander(
      query,
      analysis,
      config,
      llm,
      embeddingProvider,
      expanderRecorder,
    );

    // ─── Iterative Retrieval Loop ──────────────────────────
    let previousReasoning: string | undefined;

    for (let iteration = 0; iteration < config.max_iterations; iteration++) {
      // Stage 3: Retrieval
      checkBudget(audit.getSession(), config);
      const retrieveRecorder = audit.startStep("retrieval", iteration);
      const { chunks: newChunks } = await runRetriever(
        expandedQueries,
        scopes,
        config,
        retrieveRecorder,
        owner,
      );

      // Check for convergence: no new chunks found
      if (iteration > 0 && !hasNewChunks(allAccumulatedChunks, newChunks)) {
        log.info("Convergence: no new chunks found", { iteration });
        break;
      }

      // Merge new chunks (deduplicate by key)
      const existingKeys = new Set(allAccumulatedChunks.map(chunkKey));
      for (const chunk of newChunks) {
        const key = chunkKey(chunk);
        if (!existingKeys.has(key)) {
          allAccumulatedChunks.push(chunk);
          existingKeys.add(key);
        }
      }

      // Re-sort accumulated chunks by score
      allAccumulatedChunks.sort((a, b) => b.score - a.score);

      // Stage 4: Evaluation
      checkBudget(audit.getSession(), config);
      const evalRecorder = audit.startStep("evaluation", iteration);
      const evaluation = await runEvaluator(
        query,
        allAccumulatedChunks.slice(0, config.max_chunks_per_query * 2),
        config,
        llm,
        evalRecorder,
      );

      // Replace accumulated chunks with evaluated ones sorted by LLM score
      allAccumulatedChunks = evaluation.evaluations
        .filter((e) => e.relevance !== "incorrect")
        .map((e) => ({ ...e.chunk, score: e.score / 5 })); // normalize 1-5 to 0-1 range

      // For simple strategy, skip reasoning loop
      if (config.strategy === "simple" || !config.enable_ircot) {
        break;
      }

      // Stage 5: Reasoning (IRCoT)
      checkBudget(audit.getSession(), config);
      const reasonRecorder = audit.startStep("reasoning", iteration);
      const reasoning = await runReasoner(
        query,
        allAccumulatedChunks,
        previousReasoning,
        config,
        llm,
        reasonRecorder,
      );

      // Accumulate reasoning trace
      reasoningTrace += `\n**Iteration ${iteration + 1}:** ${reasoning.reasoning_text}`;
      previousReasoning = reasoning.reasoning_text;

      // Check for convergence: reasoning says sufficient
      if (reasoning.is_sufficient) {
        log.info("Convergence: reasoning sufficient", { iteration });
        break;
      }

      // Check for convergence: no follow-up queries
      if (reasoning.follow_up_queries.length === 0) {
        log.info("Convergence: no follow-up queries", { iteration });
        break;
      }

      // Prepare follow-up queries for next iteration
      // Also include any CRAG reformulated queries
      const followUpTexts = [...reasoning.follow_up_queries, ...evaluation.reformulated_queries];

      if (followUpTexts.length === 0) break;

      // Embed follow-up queries
      checkBudget(audit.getSession(), config);
      const followUpExpandRecorder = audit.startStep("query_expansion", iteration + 1);
      const followUpAnalysis = {
        complexity: "simple" as const,
        sub_queries: followUpTexts,
      };
      expandedQueries = await runQueryExpander(
        query,
        followUpAnalysis,
        { ...config, enable_hyde: false }, // skip HyDE for follow-ups to save budget
        llm,
        embeddingProvider,
        followUpExpandRecorder,
      );
    }

    // ─── Stage 6: Synthesis ────────────────────────────────
    const synthRecorder = audit.startStep("synthesis", 0);
    const synthesis = await runSynthesizer(
      query,
      allAccumulatedChunks,
      reasoningTrace.trim(),
      config,
      synthRecorder,
      llm,
    );

    // Complete the session
    const session = audit.complete();
    return buildResult(query, config, session, audit, synthesis);
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      // Graceful degradation: synthesize what we have
      log.warn("Budget exhausted, synthesizing partial results", {
        resource: err.resource,
        chunks: allAccumulatedChunks.length,
      });

      const synthRecorder = audit.startStep("synthesis", 0);
      const synthesis = await runSynthesizer(
        query,
        allAccumulatedChunks,
        reasoningTrace.trim(),
        config,
        synthRecorder,
        llm,
      );

      const session = audit.budgetExhausted();
      return buildResult(query, config, session, audit, synthesis);
    }

    // Unexpected error
    const session = audit.fail((err as Error).message);
    await persistSession(session);
    throw err;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

async function buildResult(
  query: string,
  config: ResearchConfig,
  session: ResearchSession,
  audit: AuditEmitter,
  synthesis: SynthesisResult,
): Promise<ResearchResult> {
  const metrics = audit.computeMetrics();
  metrics.chunks_used = synthesis.chunks_used.length;
  await persistSession(session);
  return {
    session_id: session.session_id,
    strategy: config.strategy,
    original_query: query,
    context: synthesis.context,
    chunks: synthesis.chunks_used,
    reasoning_trace: synthesis.reasoning_trace,
    metrics,
    audit: session,
  };
}

async function persistSession(session: ResearchSession): Promise<void> {
  try {
    await saveResearchSession(session);
  } catch (err) {
    log.warn("Failed to persist research session", {
      session_id: session.session_id,
      error: (err as Error).message,
    });
  }
}
