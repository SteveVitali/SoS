/**
 * Tool definitions and executors for the ReAct research agent (Phase 4).
 */

import type { KBScope, KBSearchResult } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type { ResearchConfig } from "../../../../shared/researchTypes.js";
import { getEmbeddingProvider } from "../../embeddings.js";
import { searchFTS } from "../../ftsStore.js";
import { hybridSearch } from "../../hybridSearch.js";
import { listEnabledKBsByScope } from "../../kbRepo.js";
import { distanceToSimilarity, searchSingleKB } from "../../kbService.js";
import { searchKBTable } from "../../vectorStore.js";
import type { LLMClient, ToolDefinition } from "../llmClient.js";

const log = createLogger("server:kb:research:agentTools");

// ─── Tool definitions for the LLM ──────────────────────────────

export const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_kb",
      description:
        "Search all relevant knowledge bases with a specific query. Returns ranked chunks from the most relevant KBs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query — be specific and concise",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_specific_kb",
      description: "Search a specific knowledge base by name.",
      parameters: {
        type: "object",
        properties: {
          kb_name: {
            type: "string",
            description: "Name of the knowledge base to search",
          },
          query: {
            type: "string",
            description: "The search query",
          },
        },
        required: ["kb_name", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_knowledge_bases",
      description:
        "List available knowledge bases with their names, descriptions, and chunk counts.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evaluate_relevance",
      description:
        "Evaluate whether previously retrieved chunks are relevant to the question. Returns a relevance classification (correct/incorrect/ambiguous) and score for each chunk.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to evaluate relevance against",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_hyde",
      description:
        "Generate a hypothetical answer (HyDE) for a question to improve search quality. The generated text is embedded and used as a search query, which often retrieves better results than the raw question.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to generate a hypothetical answer for",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "keyword_search",
      description:
        "Search knowledge bases using exact keyword/text matching (BM25). Use this when looking for specific terms, code symbols, config flags, error messages, IDs, or exact strings that semantic search might miss.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The exact text or keywords to search for",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "synthesize_answer",
      description:
        "Synthesize a final context from all accumulated research. Call this when you have enough information to answer the question. This terminates the research session.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "A brief summary of the key findings from your research that answer the user's question",
          },
        },
        required: ["summary"],
      },
    },
  },
];

// ─── Tool executor ──────────────────────────────────────────────

export interface AgentToolContext {
  scopes: KBScope[];
  config: ResearchConfig;
  accumulatedChunks: KBSearchResult[];
  owner?: string;
  llm: LLMClient;
}

export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<{ result: string; chunks?: KBSearchResult[] }> {
  switch (toolName) {
    case "search_kb":
      return executeSearchKB(args, ctx);
    case "search_specific_kb":
      return executeSearchSpecificKB(args, ctx);
    case "keyword_search":
      return executeKeywordSearch(args, ctx);
    case "list_knowledge_bases":
      return executeListKBs(ctx);
    case "evaluate_relevance":
      return executeEvaluateRelevance(args, ctx);
    case "generate_hyde":
      return executeGenerateHyde(args, ctx);
    case "synthesize_answer":
      return executeSynthesizeAnswer(args, ctx);
    default:
      return { result: `Unknown tool: ${toolName}` };
  }
}

async function executeSearchKB(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<{ result: string; chunks?: KBSearchResult[] }> {
  const query = String(args.query || "");
  if (!query) return { result: "Error: query is required" };

  const embeddingProvider = getEmbeddingProvider();
  const kbs = await listEnabledKBsByScope(ctx.scopes, ctx.owner);
  if (kbs.length === 0) return { result: "No knowledge bases available for the current scopes." };

  let queryVector: number[];
  try {
    [queryVector] = await embeddingProvider.embed([query]);
  } catch (err) {
    return { result: `Embedding failed: ${(err as Error).message}` };
  }

  const allResults: KBSearchResult[] = [];

  for (const kb of kbs) {
    try {
      // Probe first (vector-only) to check relevance
      const probe = await searchKBTable(kb.kb_id, queryVector, 1);
      if (probe.length === 0) continue;
      const probeScore = distanceToSimilarity(probe[0]._distance);
      if (probeScore < ctx.config.min_similarity_score) continue;

      // Hybrid search (vector + keyword)
      const results = await hybridSearch(
        kb.kb_id,
        queryVector,
        query,
        ctx.config.max_chunks_per_query,
        {
          minSimilarityScore: ctx.config.min_similarity_score,
          kbName: kb.name,
        },
      );
      allResults.push(...results);
    } catch (err) {
      log.warn("Agent search_kb failed for KB", { kbId: kb.kb_id, error: (err as Error).message });
    }
  }

  allResults.sort((a, b) => b.score - a.score);
  const topResults = allResults.slice(0, ctx.config.max_chunks_per_query);

  if (topResults.length === 0) {
    return { result: `No results found for query: "${query}"` };
  }

  const formatted = topResults
    .map(
      (r, i) =>
        `[${i + 1}] (${r.kb_name}: ${r.source_file}${r.metadata.section ? ` > ${r.metadata.section}` : ""}, score: ${r.score.toFixed(2)})\n${r.content.slice(0, 400)}`,
    )
    .join("\n\n");

  return { result: `Found ${topResults.length} results:\n\n${formatted}`, chunks: topResults };
}

async function executeSearchSpecificKB(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<{ result: string; chunks?: KBSearchResult[] }> {
  const kbName = String(args.kb_name || "");
  const query = String(args.query || "");
  if (!kbName || !query) return { result: "Error: kb_name and query are required" };

  const kbs = await listEnabledKBsByScope(ctx.scopes, ctx.owner);
  const targetKB = kbs.find((kb) => kb.name.toLowerCase() === kbName.toLowerCase());

  if (!targetKB) {
    const available = kbs.map((kb) => kb.name).join(", ");
    return {
      result: `Knowledge base "${kbName}" not found. Available: ${available || "none"}`,
    };
  }

  try {
    const results = await searchSingleKB(targetKB.kb_id, query, ctx.config.max_chunks_per_query);

    if (results.length === 0) {
      return { result: `No results found in "${kbName}" for query: "${query}"` };
    }

    const formatted = results
      .map(
        (r, i) =>
          `[${i + 1}] (${r.source_file}${r.metadata.section ? ` > ${r.metadata.section}` : ""}, score: ${r.score.toFixed(2)})\n${r.content.slice(0, 400)}`,
      )
      .join("\n\n");

    return {
      result: `Found ${results.length} results in "${kbName}":\n\n${formatted}`,
      chunks: results,
    };
  } catch (err) {
    return { result: `Search failed: ${(err as Error).message}` };
  }
}

async function executeKeywordSearch(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<{ result: string; chunks?: KBSearchResult[] }> {
  const query = String(args.query || "");
  if (!query) return { result: "Error: query is required" };

  const kbs = await listEnabledKBsByScope(ctx.scopes, ctx.owner);
  if (kbs.length === 0) return { result: "No knowledge bases available for the current scopes." };

  const allResults: KBSearchResult[] = [];

  for (const kb of kbs) {
    try {
      const ftsResults = searchFTS(kb.kb_id, query, ctx.config.max_chunks_per_query);
      for (const fts of ftsResults) {
        allResults.push({
          content: fts.content,
          source_file: fts.source_file,
          kb_name: kb.name,
          kb_id: fts.kb_id,
          score: fts.bm25_score,
          metadata: {},
        });
      }
    } catch (err) {
      log.warn("Agent keyword_search failed for KB", {
        kbId: kb.kb_id,
        error: (err as Error).message,
      });
    }
  }

  allResults.sort((a, b) => b.score - a.score);
  const topResults = allResults.slice(0, ctx.config.max_chunks_per_query);

  if (topResults.length === 0) {
    return { result: `No keyword matches found for: "${query}"` };
  }

  const formatted = topResults
    .map(
      (r, i) =>
        `[${i + 1}] (${r.kb_name}: ${r.source_file}, bm25: ${r.score.toFixed(2)})\n${r.content.slice(0, 400)}`,
    )
    .join("\n\n");

  return {
    result: `Found ${topResults.length} keyword matches:\n\n${formatted}`,
    chunks: topResults,
  };
}

async function executeListKBs(ctx: AgentToolContext): Promise<{ result: string }> {
  const kbs = await listEnabledKBsByScope(ctx.scopes, ctx.owner);
  if (kbs.length === 0) {
    return { result: "No knowledge bases available for the current scopes." };
  }

  const list = kbs
    .map(
      (kb) =>
        `- **${kb.name}** (${kb.chunk_count} chunks, ${kb.document_count} docs): ${kb.description}`,
    )
    .join("\n");

  return { result: `Available knowledge bases:\n${list}` };
}

async function executeEvaluateRelevance(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<{ result: string }> {
  const question = String(args.question || "");
  if (!question) return { result: "Error: question is required" };

  if (ctx.accumulatedChunks.length === 0) {
    return { result: "No chunks accumulated yet. Search first before evaluating relevance." };
  }

  const MAX_CHUNKS_TO_EVAL = 10;
  const chunksToEval = ctx.accumulatedChunks.slice(0, MAX_CHUNKS_TO_EVAL);

  const resultsBlock = chunksToEval
    .map((c, i) => {
      const source = c.metadata.section
        ? `${c.source_file} > ${c.metadata.section}`
        : c.source_file;
      return `[${i + 1}] (${c.kb_name}: ${source}, score: ${c.score.toFixed(2)})\n${c.content.slice(0, 400)}`;
    })
    .join("\n\n");

  try {
    const response = await ctx.llm.chat(
      [
        {
          role: "system",
          content: `You are a search result evaluator. Given a user's question and search results, evaluate each result's relevance.

For each result, provide:
- "index": the result number (1-based)
- "score": relevance score from 1 to 5
- "relevance": "correct", "incorrect", or "ambiguous"
- "reason": a one-sentence explanation

Respond as JSON: {"evaluations": [{"index": 1, "score": 5, "relevance": "correct", "reason": "..."}]}
Respond ONLY with valid JSON, no markdown fences.`,
        },
        { role: "user", content: `Question: ${question}\n\nResults:\n${resultsBlock}` },
      ],
      { json_mode: true },
    );

    const parsed = JSON.parse(response.content);
    const evals = Array.isArray(parsed.evaluations) ? parsed.evaluations : [];

    const correct = evals.filter((e: { relevance?: string }) => e.relevance === "correct").length;
    const incorrect = evals.filter(
      (e: { relevance?: string }) => e.relevance === "incorrect",
    ).length;
    const ambiguous = evals.filter(
      (e: { relevance?: string }) => e.relevance === "ambiguous",
    ).length;

    const details = evals
      .map(
        (e: { index?: number; score?: number; relevance?: string; reason?: string }) =>
          `[${e.index}] ${e.relevance} (${e.score}/5): ${e.reason}`,
      )
      .join("\n");

    return {
      result: `Evaluated ${chunksToEval.length} chunks:\n- Correct: ${correct}\n- Incorrect: ${incorrect}\n- Ambiguous: ${ambiguous}\n\nDetails:\n${details}`,
    };
  } catch (err) {
    return { result: `Evaluation failed: ${(err as Error).message}` };
  }
}

async function executeGenerateHyde(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<{ result: string; chunks?: KBSearchResult[] }> {
  const question = String(args.question || "");
  if (!question) return { result: "Error: question is required" };

  const embeddingProvider = getEmbeddingProvider();

  try {
    // Generate hypothetical answer
    const hydeResponse = await ctx.llm.chat([
      {
        role: "system",
        content: `Write a short, detailed paragraph that would be found in a technical knowledge base as an answer to this question. Do not hedge or say "I don't know" — write as if you are the documentation itself.`,
      },
      { role: "user", content: question },
    ]);

    const hydeText = hydeResponse.content.trim();
    if (!hydeText) {
      return { result: "HyDE generation produced empty output." };
    }

    // Embed the hypothetical answer and search with it
    const [hydeVector] = await embeddingProvider.embed([hydeText]);

    const kbs = await listEnabledKBsByScope(ctx.scopes, ctx.owner);
    const allResults: KBSearchResult[] = [];

    for (const kb of kbs) {
      try {
        // Probe first (vector-only) to check relevance
        const probe = await searchKBTable(kb.kb_id, hydeVector, 1);
        if (probe.length === 0) continue;
        const probeScore = distanceToSimilarity(probe[0]._distance);
        if (probeScore < ctx.config.min_similarity_score) continue;

        // Hybrid search — use HyDE vector + original question text for keyword
        const results = await hybridSearch(
          kb.kb_id,
          hydeVector,
          question,
          ctx.config.max_chunks_per_query,
          {
            minSimilarityScore: ctx.config.min_similarity_score,
            kbName: kb.name,
          },
        );
        allResults.push(...results);
      } catch (err) {
        log.warn("Agent generate_hyde search failed for KB", {
          kbId: kb.kb_id,
          error: (err as Error).message,
        });
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, ctx.config.max_chunks_per_query);

    if (topResults.length === 0) {
      return {
        result: `Generated hypothetical answer:\n"${hydeText.slice(0, 200)}"\n\nBut no matching results found when searching with it.`,
      };
    }

    const formatted = topResults
      .map(
        (r, i) =>
          `[${i + 1}] (${r.kb_name}: ${r.source_file}${r.metadata.section ? ` > ${r.metadata.section}` : ""}, score: ${r.score.toFixed(2)})\n${r.content.slice(0, 400)}`,
      )
      .join("\n\n");

    return {
      result: `Generated hypothetical answer:\n"${hydeText.slice(0, 200)}"\n\nSearched with HyDE embedding — found ${topResults.length} results:\n\n${formatted}`,
      chunks: topResults,
    };
  } catch (err) {
    return { result: `HyDE generation failed: ${(err as Error).message}` };
  }
}

async function executeSynthesizeAnswer(
  args: Record<string, unknown>,
  _ctx: AgentToolContext,
): Promise<{ result: string }> {
  const summary = String(args.summary || "Research complete.");
  return { result: summary };
}
