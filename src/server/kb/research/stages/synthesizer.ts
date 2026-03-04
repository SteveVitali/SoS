/**
 * Synthesizer stage — assembles final context string from accumulated chunks
 * with inline citations mapping back to specific sources.
 *
 * When an LLM client is provided and `skip_llm_synthesis` is false, the
 * synthesizer calls the LLM to produce a single coherent answer that reasons
 * over ALL chunks and cites sources inline, rather than dumping raw chunks.
 * Falls back to the mechanical chunk-dump format on LLM failure.
 */

import type { KBSearchResult } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type { ResearchConfig } from "../../../../shared/researchTypes.js";
import type { StepRecorder } from "../auditLog.js";
import type { LLMClient } from "../llmClient.js";

const log = createLogger("server:kb:research:synthesizer");

export interface SynthesisResult {
  context: string;
  chunks_used: KBSearchResult[];
  reasoning_trace: string;
}

// ─── LLM synthesis prompt ────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a research assistant. You will receive a user's question and a set of numbered excerpts retrieved from knowledge bases.

Your task:
1. Reason over ALL provided excerpts to produce a single, coherent, well-structured answer.
2. Cite sources inline using bracketed numbers like [1], [2], etc. You may cite multiple sources for a single statement, e.g. [1][3].
3. After your answer, include a "Sources" section listing each cited source number. Only list sources you actually cited.
4. Do NOT reproduce the raw excerpts verbatim — synthesize and rephrase the information.
5. If the excerpts don't contain enough information to fully answer the question, say so clearly and share what you can.
6. Keep the answer concise but thorough. Use markdown formatting (headers, bullets, bold) where appropriate.`;

function buildSynthesisUserPrompt(
  query: string,
  topChunks: KBSearchResult[],
  sourceLines: string[],
  reasoningTrace: string,
): string {
  const excerpts = topChunks.map((c, i) => `--- Excerpt [${i + 1}] ---\n${c.content}`).join("\n\n");

  const parts = [`**Question:** ${query}`, "", "**Source Index:**", ...sourceLines, "", excerpts];

  if (reasoningTrace) {
    parts.push("", "**Research reasoning so far:**", reasoningTrace);
  }

  return parts.join("\n");
}

// ─── Raw chunk-dump format (fallback / background context) ───────

function buildRawChunkContext(
  topChunks: KBSearchResult[],
  sourceLines: string[],
  reasoningTrace: string,
  config: ResearchConfig,
): string {
  const contextBlocks: string[] = [];
  for (let i = 0; i < topChunks.length; i++) {
    contextBlocks.push(`[${i + 1}] ${topChunks[i].content}`);
  }

  const parts: string[] = [
    "The following context was retrieved from knowledge bases via semantic search.",
    `Research strategy: ${config.strategy} | Sources: ${topChunks.length} chunks`,
    "",
    "### Sources",
    ...sourceLines,
    "",
    "### Retrieved Context",
    contextBlocks.join("\n\n---\n\n"),
  ];

  if (reasoningTrace && config.strategy !== "simple") {
    parts.push("");
    parts.push("### Research Reasoning");
    parts.push(reasoningTrace);
  }

  return parts.join("\n");
}

// ─── Main entry point ────────────────────────────────────────────

/**
 * Synthesize a final context string from accumulated chunks.
 *
 * When `config.skip_llm_synthesis` is false and an `llm` client is provided,
 * calls the LLM to produce a coherent unified answer with inline citations.
 * Otherwise (or on LLM failure) falls back to the raw chunk-dump format.
 */
export async function runSynthesizer(
  query: string,
  chunks: KBSearchResult[],
  reasoningTrace: string,
  config: ResearchConfig,
  recorder: StepRecorder,
  llm?: LLMClient,
): Promise<SynthesisResult> {
  recorder.recordInput({
    query,
    num_chunks: chunks.length,
    has_reasoning_trace: reasoningTrace.length > 0,
  });

  if (chunks.length === 0) {
    const result: SynthesisResult = {
      context: "",
      chunks_used: [],
      reasoning_trace: reasoningTrace,
    };
    recorder.recordOutput({ chunks_used: 0, context_length: 0 });
    recorder.finish({ chunks_used: 0 });
    return result;
  }

  // Take the top chunks (already sorted by evaluation score / vector score)
  const topChunks = chunks.slice(0, config.max_chunks_per_query);

  // Build source citation index
  const sourceLines: string[] = [];
  for (let i = 0; i < topChunks.length; i++) {
    const c = topChunks[i];
    const section = c.metadata.section ? ` > ${c.metadata.section}` : "";
    sourceLines.push(
      `[${i + 1}] ${c.kb_name}: ${c.source_file}${section} (score: ${c.score.toFixed(2)})`,
    );
  }

  // Attempt LLM synthesis if enabled and client available
  const shouldSynthesize = !config.skip_llm_synthesis && !!llm;
  let context: string;

  if (shouldSynthesize) {
    try {
      const userPrompt = buildSynthesisUserPrompt(query, topChunks, sourceLines, reasoningTrace);

      const response = await llm.chat([
        { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ]);

      recorder.recordLLMCall(llm.toAuditRecord(response, "synthesis", "llm_synthesis", query));

      context = response.content.trim();

      // Append the source index so downstream consumers can resolve citation numbers
      context += "\n\n### Source Index\n" + sourceLines.join("\n");

      log.info("LLM synthesis complete", {
        chunks_used: topChunks.length,
        context_length: context.length,
        strategy: config.strategy,
      });
    } catch (err) {
      log.warn("LLM synthesis failed, falling back to raw chunk format", {
        error: (err as Error).message,
      });
      context = buildRawChunkContext(topChunks, sourceLines, reasoningTrace, config);
    }
  } else {
    context = buildRawChunkContext(topChunks, sourceLines, reasoningTrace, config);
  }

  log.info("Synthesis complete", {
    chunks_used: topChunks.length,
    context_length: context.length,
    strategy: config.strategy,
    llm_synthesis: shouldSynthesize,
  });

  recorder.recordOutput({
    chunks_used: topChunks.length,
    context_length: context.length,
    llm_synthesis: shouldSynthesize,
  });
  recorder.finish({ chunks_used: topChunks.length });

  return {
    context,
    chunks_used: topChunks,
    reasoning_trace: reasoningTrace,
  };
}
