/**
 * Synthesizer stage — assembles final context string from accumulated chunks
 * with inline citations mapping back to specific sources.
 */

import type { KBSearchResult } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type { ResearchConfig } from "../../../../shared/researchTypes.js";
import type { StepRecorder } from "../auditLog.js";

const log = createLogger("server:kb:research:synthesizer");

export interface SynthesisResult {
  context: string;
  chunks_used: KBSearchResult[];
  reasoning_trace: string;
}

/**
 * Build a formatted context string with inline citations.
 *
 * Format:
 *   ## Knowledge Base Context
 *   The following context was retrieved via deep research...
 *
 *   ### Sources
 *   [1] KB Name: source_file > Section (score: 0.87)
 *   [2] KB Name: source_file (score: 0.72)
 *   ...
 *
 *   ### Retrieved Context
 *   [1] <chunk content>
 *   ---
 *   [2] <chunk content>
 *   ...
 */
export function runSynthesizer(
  query: string,
  chunks: KBSearchResult[],
  reasoningTrace: string,
  config: ResearchConfig,
  recorder: StepRecorder,
): SynthesisResult {
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

  // Build context blocks with citation markers
  const contextBlocks: string[] = [];
  for (let i = 0; i < topChunks.length; i++) {
    contextBlocks.push(`[${i + 1}] ${topChunks[i].content}`);
  }

  // Assemble final context
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

  // Optionally include reasoning trace for deep/agent strategies
  if (reasoningTrace && config.strategy !== "simple") {
    parts.push("");
    parts.push("### Research Reasoning");
    parts.push(reasoningTrace);
  }

  const context = parts.join("\n");

  log.info("Synthesis complete", {
    chunks_used: topChunks.length,
    context_length: context.length,
    strategy: config.strategy,
  });

  recorder.recordOutput({
    chunks_used: topChunks.length,
    context_length: context.length,
  });
  recorder.finish({ chunks_used: topChunks.length });

  return {
    context,
    chunks_used: topChunks,
    reasoning_trace: reasoningTrace,
  };
}
