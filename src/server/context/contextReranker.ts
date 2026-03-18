/**
 * LLM listwise reranker + sufficiency evaluator for the unified context layer.
 *
 * Combines cross-source ranking and sufficiency assessment in a single LLM call.
 * When items come from both KB and Memory, the LLM reasons about relevance,
 * complementarity, deduplication, and whether the assembled context is sufficient
 * to answer the query.
 *
 * Research basis:
 * - RankRAG (NeurIPS 2024): listwise reranking outperforms pointwise for heterogeneous sources
 * - EverMemOS (2026): sufficiency checking enables adaptive depth escalation
 * - CRAG (2024): corrective retrieval triggered by quality assessment
 * - ZeroEntropy production data: LLM listwise of top-10 is optimal for low-QPS, high-value
 */

import { createLogger } from "../../shared/logger.js";
import { getModelForRole } from "../../shared/modelConfig.js";
import type { ContextConfig } from "./contextConfig.js";
import type { ContextItem, RerankerResult, Sufficiency } from "./contextTypes.js";

const log = createLogger("server:context:reranker");

// ─── Prompt (stable system message for prompt caching) ───────

const RERANKER_SYSTEM_PROMPT = `You are a context relevance evaluator for a coding agent called Steve.
Given a user query and candidate context items from knowledge bases and learned memories, produce an optimal ranking and assess sufficiency.

For each candidate, consider:
- Direct relevance to the query
- Complementarity (items that together give a fuller picture)
- Deduplication (same info from two sources → keep the richer one)
- Personal context (user preferences, corrections) often overrides generic documentation

Respond with JSON only. No markdown fences.`;

function buildRerankerUserPrompt(query: string, items: ContextItem[], maxChars: number): string {
  const candidateLines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tags: string[] = [item.source];
    if (item.metadata.memory_type) tags.push(item.metadata.memory_type);
    if (item.metadata.kb_name) tags.push(item.metadata.kb_name);
    if (item.metadata.temporal_tag) tags.push(item.metadata.temporal_tag);

    const truncatedContent =
      item.content.length > maxChars ? `${item.content.slice(0, maxChars)}…` : item.content;

    candidateLines.push(`[${i}] (${tags.join(", ")})\n${truncatedContent}\n---`);
  }

  return `## Query
${query}

## Candidates
${candidateLines.join("\n")}

## Tasks
1. Rank candidates by usefulness for answering this query.
2. Assess sufficiency: given ONLY these candidates, can the query be answered well?
   - "sufficient": the context covers the query adequately
   - "insufficient": important information appears to be missing
   - "not_knowledge_query": this is conversational/operational, not a knowledge question
3. If insufficient, suggest 1-3 follow-up search queries that would find the missing info.

Return JSON:
{
  "ranked_indices": [3, 1, 7],
  "dropped_indices": [2, 5],
  "sufficiency": "sufficient",
  "follow_up_queries": null,
  "reasoning": "Brief explanation"
}`;
}

// ─── LLM Client ──────────────────────────────────────────────

interface RerankerLLMConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
}

function loadRerankerLLMConfig(): RerankerLLMConfig {
  return {
    model: getModelForRole("context"),
    apiKey: process.env.SOS_CONTEXT_LLM_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.SOS_CONTEXT_LLM_BASE_URL || "https://api.openai.com/v1",
  };
}

async function callRerankerLLM(
  systemPrompt: string,
  userPrompt: string,
  config: RerankerLLMConfig,
): Promise<string> {
  const start = Date.now();

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.0,
      max_tokens: 512,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Context reranker LLM error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const content = data.choices[0]?.message?.content || "";
  const duration = Date.now() - start;

  log.info("Reranker LLM call complete", {
    model: config.model,
    prompt_tokens: data.usage?.prompt_tokens,
    completion_tokens: data.usage?.completion_tokens,
    duration_ms: duration,
  });

  return content;
}

// ─── Parsing ─────────────────────────────────────────────────

interface RawRerankerResponse {
  ranked_indices?: number[];
  dropped_indices?: number[];
  sufficiency?: string;
  follow_up_queries?: string[] | null;
  reasoning?: string;
}

function parseRerankerResponse(raw: string, items: ContextItem[]): RerankerResult {
  let parsed: RawRerankerResponse;
  try {
    parsed = JSON.parse(raw) as RawRerankerResponse;
  } catch {
    log.warn("Failed to parse reranker response, using fallback ordering", {
      raw: raw.slice(0, 200),
    });
    return fallbackResult(items);
  }

  // Validate ranked_indices
  const rankedIndices = Array.isArray(parsed.ranked_indices) ? parsed.ranked_indices : [];
  const droppedIndices = new Set(
    Array.isArray(parsed.dropped_indices) ? parsed.dropped_indices : [],
  );

  // Build ranked items from valid indices
  const ranked: ContextItem[] = [];
  const seen = new Set<number>();
  for (const idx of rankedIndices) {
    if (typeof idx === "number" && idx >= 0 && idx < items.length && !seen.has(idx)) {
      ranked.push(items[idx]);
      seen.add(idx);
    }
  }

  // Any items not in ranked or dropped get appended (defensive — LLM might miss some)
  for (let i = 0; i < items.length; i++) {
    if (!seen.has(i) && !droppedIndices.has(i)) {
      ranked.push(items[i]);
      seen.add(i);
    }
  }

  // Build dropped list
  const dropped: ContextItem[] = [];
  for (const idx of droppedIndices) {
    if (typeof idx === "number" && idx >= 0 && idx < items.length) {
      dropped.push(items[idx]);
    }
  }

  // Validate sufficiency
  const validSufficiency = new Set(["sufficient", "insufficient", "not_knowledge_query"]);
  const sufficiency: Sufficiency = validSufficiency.has(parsed.sufficiency || "")
    ? (parsed.sufficiency as Sufficiency)
    : "sufficient";

  // Validate follow-up queries
  const followUpQueries =
    sufficiency === "insufficient" && Array.isArray(parsed.follow_up_queries)
      ? parsed.follow_up_queries.filter((q) => typeof q === "string" && q.trim())
      : null;

  return {
    ranked_items: ranked,
    dropped_items: dropped,
    sufficiency,
    follow_up_queries: followUpQueries,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
  };
}

/** Fallback when the LLM call fails — sort by raw_score descending. */
function fallbackResult(items: ContextItem[]): RerankerResult {
  const sorted = [...items].sort((a, b) => b.raw_score - a.raw_score);
  return {
    ranked_items: sorted,
    dropped_items: [],
    sufficiency: "sufficient",
    follow_up_queries: null,
    reasoning: "Fallback: sorted by raw score (reranker unavailable)",
  };
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Run the LLM listwise reranker + sufficiency evaluator.
 *
 * Takes normalized ContextItem[] from both KB and Memory, sends them to
 * a fast LLM for joint ranking and sufficiency assessment.
 *
 * Returns ranked items in optimal order and a sufficiency verdict that
 * drives adaptive depth escalation in the assembler.
 */
export async function rerankAndEvaluate(
  query: string,
  items: ContextItem[],
  config: ContextConfig,
): Promise<RerankerResult> {
  if (items.length === 0) {
    return {
      ranked_items: [],
      dropped_items: [],
      sufficiency: "not_knowledge_query",
      follow_up_queries: null,
      reasoning: "No candidates to rank",
    };
  }

  // If reranker is disabled, fall back to raw score ordering
  if (!config.rerankerEnabled) {
    log.info("Reranker disabled, using raw score ordering", { items: items.length });
    return fallbackResult(items);
  }

  const llmConfig = loadRerankerLLMConfig();
  if (!llmConfig.apiKey) {
    log.warn("No API key for context reranker, falling back to raw score ordering");
    return fallbackResult(items);
  }

  try {
    const userPrompt = buildRerankerUserPrompt(query, items, config.maxContentCharsForReranker);
    const rawResponse = await callRerankerLLM(RERANKER_SYSTEM_PROMPT, userPrompt, llmConfig);
    const result = parseRerankerResponse(rawResponse, items);

    log.info("Reranker complete", {
      input_items: items.length,
      ranked: result.ranked_items.length,
      dropped: result.dropped_items.length,
      sufficiency: result.sufficiency,
      follow_up_queries: result.follow_up_queries?.length ?? 0,
    });

    return result;
  } catch (err) {
    log.warn("Reranker LLM call failed, falling back to raw score ordering", {
      error: (err as Error).message,
    });
    return fallbackResult(items);
  }
}

/**
 * Check whether the reranker should be invoked.
 * Skip when results come from only one source (nothing to cross-rank).
 */
export function shouldRunReranker(
  kbItems: ContextItem[],
  memoryItems: ContextItem[],
  config: ContextConfig,
): boolean {
  if (!config.rerankerEnabled) return false;
  // Only run when both sources have results — cross-source reasoning is the value
  return kbItems.length > 0 && memoryItems.length > 0;
}
