/**
 * Synthesizer stage — assembles final context string from accumulated chunks
 * with inline citations mapping back to specific sources.
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

export interface UserSynthesisResult {
  answer: string;
  chunks_used: KBSearchResult[];
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
// ─── LLM Synthesis Prompt (for user-facing answers) ──────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a knowledgeable assistant answering questions using retrieved documentation.

Rules:
- Answer the question directly and thoroughly using ONLY the provided context.
- Use inline citation numbers like [1], [2] to reference your sources.
- If the context doesn't contain enough information, say so clearly.
- Format your answer with markdown: use headings, lists, bold, and code blocks where appropriate.
- Be concise but complete. Avoid repeating the question back.
- Do NOT mention "the context" or "the documents" — just answer naturally as if you know the material.`;

function buildSynthesisUserPrompt(
  query: string,
  chunks: KBSearchResult[],
  reasoningTrace: string,
): string {
  const sourceLines: string[] = [];
  const contextBlocks: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const section = c.metadata.section ? ` > ${c.metadata.section}` : "";
    sourceLines.push(`[${i + 1}] ${c.kb_name}: ${c.source_file}${section}`);
    contextBlocks.push(`[${i + 1}] ${c.content}`);
  }

  const parts = [
    `Question: ${query}`,
    "",
    "Sources:",
    ...sourceLines,
    "",
    "Retrieved context:",
    contextBlocks.join("\n\n---\n\n"),
  ];

  if (reasoningTrace) {
    parts.push("", "Research reasoning:", reasoningTrace);
  }

  return parts.join("\n");
}

/**
 * Synthesize a user-facing answer by calling the research LLM.
 * Used by the kb_search executor to produce a coherent response instead
 * of returning raw chunks.
 */
export async function synthesizeForUser(
  query: string,
  chunks: KBSearchResult[],
  reasoningTrace: string,
  config: ResearchConfig,
  llm: LLMClient,
): Promise<UserSynthesisResult> {
  const topChunks = chunks.slice(0, config.max_chunks_per_query);

  if (topChunks.length === 0) {
    return { answer: "", chunks_used: [] };
  }

  const userMessage = buildSynthesisUserPrompt(query, topChunks, reasoningTrace);

  try {
    const response = await llm.chat(
      [
        { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      { max_tokens: 2048 },
    );

    log.info("User-facing synthesis complete", {
      chunks_used: topChunks.length,
      answer_length: response.content.length,
      duration_ms: response.duration_ms,
    });

    return {
      answer: response.content,
      chunks_used: topChunks,
    };
  } catch (err) {
    log.warn("LLM synthesis failed, falling back to raw context", {
      error: (err as Error).message,
    });
    // Graceful fallback: return raw chunk dump
    const fallback = topChunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
    return { answer: fallback, chunks_used: topChunks };
  }
}

// ─── Raw Context Builder (for system prompt injection) ───────

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
