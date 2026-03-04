/**
 * Reasoner stage — IRCoT (Interleaving Retrieval with Chain-of-Thought).
 * Phase 2: Decides whether accumulated information is sufficient or if
 * follow-up queries are needed.
 */

import type { KBSearchResult } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type { ReasoningResult, ResearchConfig } from "../../../../shared/researchTypes.js";
import type { StepRecorder } from "../auditLog.js";
import type { LLMClient } from "../llmClient.js";

const log = createLogger("server:kb:research:reasoner");

const REASONING_PROMPT = `You are a research assistant analyzing search results to answer a question.

Think step-by-step:
1. What parts of the question can you now answer with the information above?
2. What parts remain unanswered?
3. What follow-up searches would help fill the gaps?

Respond as JSON:
{
  "reasoning": "Step-by-step analysis of what is covered and what is missing...",
  "is_sufficient": true or false,
  "follow_up_queries": ["specific search query 1", "specific search query 2"],
  "missing_info": ["description of missing info 1", "description of missing info 2"]
}

Rules:
- Set is_sufficient to true if the gathered information can adequately answer the question.
- Set is_sufficient to true if further searching is unlikely to improve the answer significantly.
- Keep follow_up_queries concise and specific — they will be used as search queries.
- Limit follow_up_queries to at most 3.
- Respond ONLY with valid JSON, no markdown fences.`;

const MAX_CONTEXT_CHARS = 6000;

function formatChunksForReasoning(chunks: KBSearchResult[]): string {
  let text = "";
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const source = c.metadata.section
      ? `${c.kb_name}: ${c.source_file} > ${c.metadata.section}`
      : `${c.kb_name}: ${c.source_file}`;
    const entry = `[${i + 1}] (${source}, score: ${c.score.toFixed(2)})\n${c.content}\n\n`;

    if (text.length + entry.length > MAX_CONTEXT_CHARS) break;
    text += entry;
  }
  return text;
}

export async function runReasoner(
  query: string,
  accumulatedChunks: KBSearchResult[],
  previousReasoning: string | undefined,
  config: ResearchConfig,
  llm: LLMClient,
  recorder: StepRecorder,
): Promise<ReasoningResult> {
  recorder.recordInput({
    query,
    accumulated_chunks: accumulatedChunks.length,
    has_previous_reasoning: !!previousReasoning,
  });

  if (!config.enable_ircot) {
    // If IRCoT is disabled, always mark as sufficient
    const result: ReasoningResult = {
      reasoning_text: "IRCoT disabled — skipping reasoning.",
      is_sufficient: true,
      follow_up_queries: [],
      missing_info: [],
    };
    recorder.recordOutput(result as unknown as Record<string, unknown>);
    recorder.finish({ is_sufficient: true });
    return result;
  }

  const chunksFormatted = formatChunksForReasoning(accumulatedChunks);

  const userMessage = [
    `Original question: ${query}`,
    "",
    "Information gathered so far:",
    chunksFormatted,
    "",
    "Previous reasoning:",
    previousReasoning || "(first iteration)",
  ].join("\n");

  const response = await llm.chat(
    [
      { role: "system", content: REASONING_PROMPT },
      { role: "user", content: userMessage },
    ],
    { json_mode: true },
  );

  recorder.recordLLMCall(llm.toAuditRecord(response, "reasoning", "ircot_reason", query));

  let result: ReasoningResult;
  try {
    const parsed = JSON.parse(response.content);
    result = {
      reasoning_text: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      is_sufficient: parsed.is_sufficient === true,
      follow_up_queries: Array.isArray(parsed.follow_up_queries)
        ? parsed.follow_up_queries.filter((q: unknown) => typeof q === "string").slice(0, 3)
        : [],
      missing_info: Array.isArray(parsed.missing_info)
        ? parsed.missing_info.filter((m: unknown) => typeof m === "string")
        : [],
    };
  } catch (err) {
    log.warn("Failed to parse reasoning response, marking as sufficient", {
      error: (err as Error).message,
    });
    result = {
      reasoning_text: "Failed to parse reasoning — stopping iteration.",
      is_sufficient: true,
      follow_up_queries: [],
      missing_info: [],
    };
  }

  log.info("Reasoning complete", {
    is_sufficient: result.is_sufficient,
    follow_up_queries: result.follow_up_queries.length,
    missing_info: result.missing_info.length,
  });

  recorder.recordOutput({
    is_sufficient: result.is_sufficient,
    follow_up_queries: result.follow_up_queries,
    missing_info: result.missing_info,
    reasoning_preview: result.reasoning_text.slice(0, 200),
  });
  recorder.finish({
    is_sufficient: result.is_sufficient,
    follow_ups: result.follow_up_queries.length,
  });

  return result;
}
