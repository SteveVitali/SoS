/**
 * Tool definitions and executors for the ReAct research agent (Phase 4).
 */

import type { KBScope, KBSearchResult } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type { ResearchConfig } from "../../../../shared/researchTypes.js";
import { getEmbeddingProvider } from "../../embeddings.js";
import { listEnabledKBsByScope } from "../../kbRepo.js";
import { distanceToSimilarity, searchSingleKB } from "../../kbService.js";
import { searchKBTable } from "../../vectorStore.js";
import type { ToolDefinition } from "../llmClient.js";

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
    case "list_knowledge_bases":
      return executeListKBs(ctx);
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
      const probe = await searchKBTable(kb.kb_id, queryVector, 1);
      if (probe.length === 0) continue;
      const probeScore = distanceToSimilarity(probe[0]._distance);
      if (probeScore < ctx.config.min_similarity_score) continue;

      const results = await searchKBTable(kb.kb_id, queryVector, ctx.config.max_chunks_per_query);
      for (const r of results) {
        const similarity = distanceToSimilarity(r._distance);
        if (similarity >= ctx.config.min_similarity_score) {
          allResults.push({
            content: r.content,
            source_file: r.source_file,
            kb_name: kb.name,
            kb_id: kb.kb_id,
            score: similarity,
            metadata: {
              section: r.section || undefined,
              page: r.page || undefined,
              file_path: r.file_path || undefined,
              parent_dir: r.parent_dir || undefined,
            },
          });
        }
      }
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

async function executeSynthesizeAnswer(
  args: Record<string, unknown>,
  _ctx: AgentToolContext,
): Promise<{ result: string }> {
  const summary = String(args.summary || "Research complete.");
  return { result: summary };
}
