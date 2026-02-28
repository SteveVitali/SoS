/**
 * Corrective RAG graph — iterative retrieve → grade → decide → answer loop.
 *
 * Graph topology:
 *
 *   retrieve → grade_relevance → ─┬─ sufficient ──→ answer
 *                                  │
 *                                  ├─ empty ───────→ answer_without_context
 *                                  │
 *                                  └─ insufficient ─→ reformulate_query ──→ retrieve
 *                                       (if under max_retrievals,          (loop)
 *                                        else → answer)
 *
 * This graph reuses the existing KB search infrastructure (kbService.ts)
 * and LLM provider (llmProvider.ts) — no LangChain model wrappers needed.
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { KBScope, KBSearchResult } from "../../../shared/kbTypes.js";
import { createLogger } from "../../../shared/logger.js";
import { searchKnowledgeBases } from "../../kb/kbService.js";
import type { LLMProvider } from "../../llm/llmProvider.js";
import type { RAGGraphConfig, RAGGraphState } from "./types.js";

const log = createLogger("server:routing:graphs:corrective-rag");

// ---------------------------------------------------------------------------
// LangGraph Annotation (defines how state channels merge across nodes)
// ---------------------------------------------------------------------------

const RAGState = Annotation.Root({
  query: Annotation<string>(),
  search_query: Annotation<string>(),
  scopes: Annotation<KBScope[]>(),
  retrieved_chunks: Annotation<KBSearchResult[]>(),
  retrieval_count: Annotation<number>(),
  max_retrievals: Annotation<number>(),
  relevance_grade: Annotation<"sufficient" | "insufficient" | "empty">(),
  answer: Annotation<string>(),
  reasoning_trace: Annotation<string[]>({
    // Traces accumulate across nodes rather than overwriting
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

// ---------------------------------------------------------------------------
// Node: retrieve
// ---------------------------------------------------------------------------

function makeRetrieveNode(config: RAGGraphConfig) {
  return async (state: RAGGraphState): Promise<Partial<RAGGraphState>> => {
    const scopes = config.scopes ?? state.scopes;
    const maxChunks = config.max_chunks ?? 8;
    const minScore = config.min_score ?? 0.3;

    log.info("Corrective RAG: retrieving", {
      query: state.search_query.slice(0, 100),
      round: state.retrieval_count + 1,
    });

    const results = await searchKnowledgeBases({
      query: state.search_query,
      scopes,
      max_chunks: maxChunks,
      min_score: minScore,
    });

    return {
      retrieved_chunks: results,
      retrieval_count: state.retrieval_count + 1,
      reasoning_trace: [
        `[retrieve round ${state.retrieval_count + 1}] query="${state.search_query}" → ${results.length} chunks`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// Node: grade_relevance
// ---------------------------------------------------------------------------

const GRADING_SYSTEM_PROMPT = `You are a relevance grading assistant. Given a user question and a set of retrieved document chunks, assess whether the chunks contain sufficient information to answer the question.

Respond with EXACTLY one of:
- "sufficient" — the chunks contain enough relevant information to produce a good answer
- "insufficient" — the chunks are partially relevant but missing key information; a reformulated search query might help
- "empty" — the chunks are completely irrelevant or no chunks were retrieved

Output ONLY the single word. No explanation.`;

function makeGradeNode(provider: LLMProvider, model: string) {
  return async (state: RAGGraphState): Promise<Partial<RAGGraphState>> => {
    if (state.retrieved_chunks.length === 0) {
      return {
        relevance_grade: "empty",
        reasoning_trace: ["[grade] no chunks retrieved → empty"],
      };
    }

    const chunksText = state.retrieved_chunks
      .map(
        (c, i) =>
          `[${i + 1}] (${c.kb_name} > ${c.source_file}, score: ${c.score.toFixed(2)})\n${c.content}`,
      )
      .join("\n\n---\n\n");

    const userMessage = `Question: ${state.query}\n\nRetrieved chunks:\n${chunksText}`;

    const response = await provider.chat({
      model,
      maxTokens: 16,
      system: GRADING_SYSTEM_PROMPT,
      tools: [],
      messages: [{ role: "user", content: userMessage }],
    });

    const grade = response.text.trim().toLowerCase();
    const validGrades = ["sufficient", "insufficient", "empty"] as const;
    // biome-ignore lint/suspicious/noExplicitAny: narrowing string to union via includes
    const parsedGrade = validGrades.includes(grade as any)
      ? (grade as RAGGraphState["relevance_grade"])
      : "insufficient";

    log.info("Corrective RAG: graded", {
      grade: parsedGrade,
      chunks: state.retrieved_chunks.length,
    });

    return {
      relevance_grade: parsedGrade,
      reasoning_trace: [`[grade] ${state.retrieved_chunks.length} chunks → "${parsedGrade}"`],
    };
  };
}

// ---------------------------------------------------------------------------
// Node: reformulate_query
// ---------------------------------------------------------------------------

const REFORMULATE_SYSTEM_PROMPT = `You are a search query optimizer. Given the original user question and a search query that didn't return sufficient results, generate an improved search query.

Rules:
- Output ONLY the new search query, nothing else
- Try a different angle, use synonyms, or broaden/narrow the scope
- Keep it concise (under 50 words)
- Do not repeat the exact same query`;

function makeReformulateNode(provider: LLMProvider, model: string) {
  return async (state: RAGGraphState): Promise<Partial<RAGGraphState>> => {
    const response = await provider.chat({
      model,
      maxTokens: 100,
      system: REFORMULATE_SYSTEM_PROMPT,
      tools: [],
      messages: [
        {
          role: "user",
          content: `Original question: ${state.query}\nPrevious search query: ${state.search_query}\n\nGenerate an improved search query:`,
        },
      ],
    });

    const newQuery = response.text.trim();
    log.info("Corrective RAG: reformulated", {
      from: state.search_query.slice(0, 80),
      to: newQuery.slice(0, 80),
    });

    return {
      search_query: newQuery,
      reasoning_trace: [`[reformulate] "${state.search_query}" → "${newQuery}"`],
    };
  };
}

// ---------------------------------------------------------------------------
// Node: answer (with context)
// ---------------------------------------------------------------------------

const ANSWER_SYSTEM_PROMPT = `You are a helpful assistant answering questions using the provided knowledge base context. 

Rules:
- Answer based on the retrieved context. If the context is insufficient, say so honestly.
- Cite sources by mentioning the knowledge base name and file when referencing specific information.
- Be concise and direct.
- Use Slack-compatible markdown formatting.`;

function makeAnswerNode(provider: LLMProvider, model: string, maxTokens: number) {
  return async (state: RAGGraphState): Promise<Partial<RAGGraphState>> => {
    const chunksText =
      state.retrieved_chunks.length > 0
        ? state.retrieved_chunks
            .map(
              (c, i) =>
                `[${i + 1}] (${c.kb_name} > ${c.source_file}, score: ${c.score.toFixed(2)})\n${c.content}`,
            )
            .join("\n\n---\n\n")
        : "(No relevant context was found in the knowledge bases)";

    const response = await provider.chat({
      model,
      maxTokens,
      system: ANSWER_SYSTEM_PROMPT,
      tools: [],
      messages: [
        {
          role: "user",
          content: `Context from knowledge bases:\n${chunksText}\n\nQuestion: ${state.query}`,
        },
      ],
    });

    return {
      answer: response.text,
      reasoning_trace: [
        `[answer] generated ${response.text.length} chars from ${state.retrieved_chunks.length} chunks`,
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// Conditional edge: after grading, decide next step
// ---------------------------------------------------------------------------

function gradeRouter(state: RAGGraphState): "synthesize" | "reformulate_query" {
  // If sufficient or empty → go straight to synthesize answer
  if (state.relevance_grade !== "insufficient") {
    return "synthesize";
  }

  // If insufficient but we've hit the retrieval cap → answer with what we have
  if (state.retrieval_count >= state.max_retrievals) {
    log.info("Corrective RAG: max retrievals reached, answering with available context", {
      rounds: state.retrieval_count,
    });
    return "synthesize";
  }

  // Otherwise → reformulate and try again
  return "reformulate_query";
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

export function buildCorrectiveRAGGraph(provider: LLMProvider, config: RAGGraphConfig) {
  const model = config.model ?? "claude-sonnet-4-20250514";
  const maxAnswerTokens = config.max_answer_tokens ?? 1024;

  const graph = new StateGraph(RAGState)
    // Nodes
    .addNode("retrieve", makeRetrieveNode(config))
    .addNode("grade_relevance", makeGradeNode(provider, model))
    .addNode("reformulate_query", makeReformulateNode(provider, model))
    .addNode("synthesize", makeAnswerNode(provider, model, maxAnswerTokens))

    // Edges
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "grade_relevance")
    .addConditionalEdges("grade_relevance", gradeRouter, {
      synthesize: "synthesize",
      reformulate_query: "reformulate_query",
    })
    .addEdge("reformulate_query", "retrieve")
    .addEdge("synthesize", END);

  return graph.compile();
}

// ---------------------------------------------------------------------------
// Convenience runner
// ---------------------------------------------------------------------------

export async function runCorrectiveRAG(
  provider: LLMProvider,
  query: string,
  config: RAGGraphConfig,
): Promise<{ answer: string; trace: string[]; retrievalRounds: number }> {
  const app = buildCorrectiveRAGGraph(provider, config);

  const initialState: RAGGraphState = {
    query,
    search_query: query,
    scopes: config.scopes ?? ["chat", "all"],
    retrieved_chunks: [],
    retrieval_count: 0,
    max_retrievals: config.max_retrievals ?? 3,
    relevance_grade: "insufficient",
    answer: "",
    reasoning_trace: [],
  };

  const result = await app.invoke(initialState);

  return {
    answer: result.answer,
    trace: result.reasoning_trace,
    retrievalRounds: result.retrieval_count,
  };
}
