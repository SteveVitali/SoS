# Advanced RAG Research Pipeline — Design Document

> **Status:** ✅ Implemented
> **Author:** Steve + Human
> **Date:** 2026-03-03
> **Last Updated:** 2026-03-04

### Implementation Status

| Feature | Status |
|---------|--------|
| Phase 1 — Query Enhancement & Reranking (simple) | ✅ Implemented |
| Phase 2 — Iterative Retrieval & Correction (deep) | ✅ Implemented |
| Phase 3 — RAPTOR Tree Preprocessing | ✅ Implemented |
| Phase 4 — ReAct Research Agent (agent) | ✅ Implemented |
| Agent tools: `search_kb`, `search_specific_kb`, `list_knowledge_bases`, `synthesize_answer` | ✅ Implemented |
| Agent tools: `evaluate_relevance`, `generate_hyde` | ✅ Implemented |
| Audit Logging (AuditEmitter + MongoDB) | ✅ Implemented |
| Research Playground UI (strategy, scope, timeline) | ✅ Implemented |
| Research LLM model selector (per-session override) | ✅ Implemented |
| RAPTOR Tree visualization (`RaptorTree.tsx`) | ✅ Implemented |
| Chat integration (`kb_research_strategy` in routing config) | ✅ Implemented |
| NDJSON streaming (web + worker endpoints) | ✅ Implemented |
| Per-job research audit section (`JobDetail.tsx`) | ✅ Implemented |
| Worker streaming client (`researchKnowledgeBasesStreaming`) | ✅ Implemented |
| Hybrid search (vector + FTS5 keyword via RRF) | ✅ Implemented |
| Agent tool: `keyword_search` (BM25 keyword search with metadata) | ✅ Implemented |

## Table of Contents

1. [Overview](#1-overview)
2. [Current System](#2-current-system)
3. [Core Architecture](#3-core-architecture)
4. [Type System](#4-type-system)
5. [Phase 1 — Query Enhancement & Reranking](#5-phase-1--query-enhancement--reranking)
6. [Phase 2 — Iterative Retrieval & Correction](#6-phase-2--iterative-retrieval--correction)
7. [Phase 3 — RAPTOR Tree Preprocessing](#7-phase-3--raptor-tree-preprocessing)
8. [Phase 4 — ReAct Research Agent](#8-phase-4--react-research-agent)
9. [Audit Logging](#9-audit-logging)
10. [Visualization & UI](#10-visualization--ui)
11. [Integration Points](#11-integration-points)
12. [File Structure](#12-file-structure)
13. [Strategy Profiles](#13-strategy-profiles)
14. [API Surface](#14-api-surface)
15. [LLM Client Design](#15-llm-client-design)
16. [Cost & Latency Budget](#16-cost--latency-budget)
17. [Implementation Order](#17-implementation-order)
18. [Open Questions](#18-open-questions)

---

## 1. Overview

The current KB system performs **single-shot retrieval**: embed the user's query, probe
relevant KBs, return top-K chunks, inject into the LLM prompt. This works well for
simple, focused questions but falls short when:

- The question is **compound** ("How does Steve handle rate limiting across workspaces?")
  and requires information scattered across multiple document sections.
- The question needs **multi-hop reasoning** — understanding concept A to know what to
  search for regarding concept B.
- The initial retrieval returns **topically adjacent but not quite right** chunks, and a
  small query reformulation would find the real answer.
- The corpus is **deep** (100K+ words, multiple KBs) and single-vector-search recall
  degrades.

This design introduces a **Research Pipeline** — a composable, multi-stage system that
transforms a raw user query into deeply-researched, high-quality context through
iterative retrieval, LLM-driven reasoning, and self-correction.

### Design Principles

1. **Composable stages** — Each technique is an independent stage. Stages can be enabled,
   disabled, or reordered via strategy profiles.
2. **Budget-aware** — Every pipeline run has a configurable cap on LLM calls, retrieval
   calls, and wall-clock time. No runaway costs.
3. **Fully auditable** — Every decision, LLM call, retrieval, and score is recorded in a
   structured audit log. Nothing is a black box.
4. **Backward compatible** — The existing `searchKnowledgeBases()` API continues to work.
   The research pipeline is an opt-in upgrade path.
5. **Incremental delivery** — Phases 1–4 build on each other. Each phase is independently
   valuable and shippable.

---

## 2. Current System

### Retrieval Flow (today)

```
User Query
  │
  ▼
embed(query)  →  queryVector
  │
  ▼
Stage 1: Probe each enabled KB (limit=1)
  │  filter by min_similarity_score
  ▼
Stage 2: Full search on passing KBs (limit=max_chunks_per_query)
  │  sort by score descending
  ▼
Return top-K KBSearchResult[]
```

### Integration Points (today)

| Consumer | File | How it calls search |
|----------|------|-------------------|
| Worker (jobs) | `runJob.ts:258-273` | `api.searchKnowledgeBases(task_text, [scope, "all"])` |
| Worker (plans) | `runPlanJob.ts:117-133` | `api.searchKnowledgeBases(task_text, ["plan_job", "all"])` |
| Chat (web UI) | `chatRoutes.ts` → `messageRouter` | Indirectly via Slack command routing |
| Web playground | `KBPlayground.tsx` | `POST /api/web/kb/search` |
| Worker API | `kbRoutes.ts:316-341` | `POST /api/worker/kb/search` |

### Key Files

| File | Purpose |
|------|---------|
| `kbService.ts` | Orchestrates CRUD, ingestion, search |
| `vectorStore.ts` | LanceDB wrapper (search, add, delete) |
| `embeddings.ts` | OpenAI-compatible embedding provider |
| `chunker.ts` | Markdown-aware text chunking |
| `kbTypes.ts` | Shared types |
| `kbRoutes.ts` | Express routes for web + worker |

---

## 3. Core Architecture

The research pipeline is a **directed acyclic graph of stages** executed by a pipeline
runner. In the simple case it's linear; in the iterative case, the runner loops stages
3–5 until convergence or budget exhaustion.

```
                    ┌──────────────────────────────────────────────┐
                    │           ResearchPipeline                    │
                    │                                              │
 User Query ──────▶│  ┌─────────────┐    ┌──────────────┐        │
                    │  │ 1. Analyzer │───▶│ 2. Expander  │        │
                    │  └─────────────┘    └──────┬───────┘        │
                    │                            │                │
                    │                   ┌────────▼────────┐       │
                    │              ┌───▶│ 3. Retriever    │       │
                    │              │    └────────┬────────┘       │
                    │              │             │                │
                    │              │    ┌────────▼────────┐       │
                    │              │    │ 4. Evaluator    │       │
                    │              │    └────────┬────────┘       │
                    │              │             │                │
                    │              │    ┌────────▼────────┐       │
                    │              │    │ 5. Reasoner     │──┐    │
                    │              │    └─────────────────┘  │    │
                    │              │                         │    │
                    │              └──── (if !sufficient) ◀──┘    │
                    │                                             │
                    │                   ┌─────────────────┐       │
                    │                   │ 6. Synthesizer   │      │
                    │                   └────────┬────────┘       │
                    │                            │                │
                    └────────────────────────────┼────────────────┘
                                                 │
                                                 ▼
                                    ResearchResult + AuditLog
```

### Pipeline Runner

```typescript
async function runResearchPipeline(
  query: string,
  scopes: KBScope[],
  config: ResearchConfig,
  owner?: string,
): Promise<ResearchResult>
```

The runner:
1. Creates a `ResearchSession` with a unique `session_id`.
2. Executes stages in order, passing accumulated state between them.
3. For stages 3–5, loops until `reasoner.is_sufficient === true` or budget exhausted.
4. Records every stage execution as a `ResearchStep` in the audit log.
5. Returns the final assembled context plus the full audit trail.

---

## 4. Type System

All types live in `src/shared/researchTypes.ts` so they're available to server, worker,
and UI.

```typescript
// ─── Strategy ───────────────────────────────────────────────────

export type ResearchStrategy = "simple" | "deep" | "agent";

export interface ResearchConfig {
  strategy: ResearchStrategy;

  // Budget caps
  max_iterations: number;       // max retrieval→evaluate→reason loops
  max_llm_calls: number;        // total LLM calls across all stages
  max_retrieval_calls: number;  // total vector searches
  max_wall_time_ms: number;     // hard timeout

  // Stage toggles
  enable_decomposition: boolean;
  enable_hyde: boolean;
  enable_step_back: boolean;
  enable_crag: boolean;
  enable_ircot: boolean;

  // Retrieval params
  max_chunks_per_query: number;
  min_similarity_score: number;
  dedup_threshold: number;      // cosine similarity for dedup (e.g. 0.95)
}

// ─── Session & Steps ────────────────────────────────────────────

export interface ResearchSession {
  session_id: string;
  original_query: string;
  scopes: KBScope[];
  config: ResearchConfig;
  steps: ResearchStep[];
  created_at: Date;
}

export type ResearchStage =
  | "query_analysis"
  | "query_expansion"
  | "retrieval"
  | "evaluation"
  | "reasoning"
  | "synthesis";

export interface ResearchStep {
  step_id: string;
  stage: ResearchStage;
  iteration: number;          // which loop iteration (0 for non-looping stages)
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  duration_ms: number;
  llm_calls: LLMCallRecord[];
  retrieval_calls: RetrievalRecord[];
}

// ─── LLM Call Tracking ──────────────────────────────────────────

export interface LLMCallRecord {
  call_id: string;
  stage: ResearchStage;
  purpose: string;            // e.g. "decompose_query", "evaluate_chunk", "hyde_generate"
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd?: number;
  duration_ms: number;
  // Truncated input/output for audit display (not full prompt)
  input_preview: string;
  output_preview: string;
}

// ─── Retrieval Tracking ─────────────────────────────────────────

export interface RetrievalRecord {
  call_id: string;
  query_text: string;
  query_type: "original" | "decomposed" | "hyde" | "step_back" | "follow_up";
  kb_ids_searched: string[];
  results_count: number;
  top_score: number;
  duration_ms: number;
}

// ─── Stage I/O Types ────────────────────────────────────────────

/** Output of the QueryAnalyzer stage */
export interface QueryAnalysis {
  complexity: "simple" | "compound" | "multi_hop";
  sub_queries: string[];          // empty for simple queries
  step_back_query?: string;       // broader conceptual query
  recommended_strategy?: ResearchStrategy;
}

/** A query ready for retrieval, with its embedding */
export interface ExpandedQuery {
  text: string;
  vector: number[];
  type: "original" | "decomposed" | "hyde" | "step_back" | "follow_up";
  source_query?: string;          // which query this was derived from
}

/** CRAG evaluation result for a single chunk */
export interface ChunkEvaluation {
  chunk: KBSearchResult;
  relevance: "correct" | "incorrect" | "ambiguous";
  reasoning: string;              // one-line LLM explanation
}

/** Output of the Reasoner stage */
export interface ReasoningResult {
  reasoning_text: string;         // chain-of-thought
  is_sufficient: boolean;         // true → stop iterating
  follow_up_queries: string[];    // new queries for next iteration
  missing_info: string[];         // what's still unknown
}

// ─── Final Result ───────────────────────────────────────────────

export interface ResearchResult {
  session_id: string;
  strategy: ResearchStrategy;
  original_query: string;

  // The goods
  context: string;                // formatted context string for LLM injection
  chunks: KBSearchResult[];       // deduplicated, ranked chunks used
  reasoning_trace: string;        // human-readable reasoning chain

  // Metrics
  metrics: ResearchMetrics;

  // Full audit trail
  audit: ResearchSession;
}

export interface ResearchMetrics {
  total_duration_ms: number;
  iterations: number;
  llm_calls: number;
  retrieval_calls: number;
  chunks_retrieved: number;       // before dedup/filtering
  chunks_used: number;            // after dedup/filtering
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
}
```

---

## 5. Phase 1 — Query Enhancement & Reranking

**Goal:** Dramatically improve retrieval quality with minimal latency increase (+1-3 LLM
calls).

### 5a. Query Analyzer (`stages/queryAnalyzer.ts`)

Classifies the query and optionally decomposes it.

**Input:** Raw user query
**Output:** `QueryAnalysis`
**LLM calls:** 1

**Prompt design:**
```
You are a query analyzer for a knowledge base search system.

Given the user's question, analyze it and respond in JSON:
{
  "complexity": "simple" | "compound" | "multi_hop",
  "sub_queries": ["...", "..."],
  "step_back_query": "..."
}

Rules:
- "simple": Question can be answered from a single passage. sub_queries = [].
- "compound": Question has multiple distinct parts. Decompose into sub_queries.
- "multi_hop": Answering requires finding fact A to know what to search for about B.
  Decompose into ordered sub_queries.
- step_back_query: A broader, more abstract version of the question that retrieves
  background context. Always provide this.

User question: {query}
```

**Complexity-based short-circuit:** If `complexity === "simple"` and strategy is
`"simple"`, skip decomposition — just use the original query + HyDE.

### 5b. Query Expander (`stages/queryExpander.ts`)

Generates HyDE hypothetical documents and embeds all query variants.

**Input:** `QueryAnalysis`
**Output:** `ExpandedQuery[]`
**LLM calls:** 1 per unique query (batched)
**Embedding calls:** 1 (batch all texts)

**HyDE prompt:**
```
Write a short, detailed paragraph that would be found in a technical knowledge base
as an answer to this question. Do not hedge or say "I don't know" — write as if you
are the documentation itself.

Question: {query}
```

**Process:**
1. Collect all queries: `[original, ...sub_queries, step_back_query]`
2. For each, generate a HyDE hypothetical answer (batched in one LLM call with
   structured output)
3. Embed all texts (originals + HyDE answers) in one batch embedding call
4. Return `ExpandedQuery[]` with vectors attached

**Dedup:** If two expanded queries have cosine similarity > `dedup_threshold`, drop
the lower-priority one (priority: original > decomposed > hyde > step_back).

### 5c. Reranker (inside `stages/evaluator.ts`)

After retrieval, use an LLM to rerank the top results.

**Input:** Retrieved chunks + original query
**Output:** Reranked, filtered chunks
**LLM calls:** 1

**Reranking prompt:**
```
Given the user's question and the following search results, rate each result's
relevance on a scale of 1-5 and provide a one-sentence explanation.

Question: {query}

Results:
[1] {chunk_1_content_truncated}
[2] {chunk_2_content_truncated}
...

Respond as JSON array: [{"index": 1, "score": 5, "reason": "..."}, ...]
```

This replaces pure vector-distance ranking with semantic relevance ranking — a huge
quality improvement for ambiguous queries.

### Phase 1 Pipeline Flow

```
query → Analyzer(1 LLM) → Expander(1 LLM + 1 embed) → Retriever(N searches)
      → Evaluator/Reranker(1 LLM) → Synthesizer → Result

Total: ~3 LLM calls, 1 embed call, N vector searches
Latency: ~2-4 seconds additional
```

---

## 6. Phase 2 — Iterative Retrieval & Correction

**Goal:** Enable multi-hop reasoning and self-correction through retrieval loops.

### 6a. CRAG Evaluator (`stages/evaluator.ts`)

After retrieval, evaluate each chunk for relevance (not just rerank).

**Extension to Phase 1 evaluator:**
```typescript
// Phase 1: just reranking scores
// Phase 2: adds relevance classification

interface ChunkEvaluation {
  chunk: KBSearchResult;
  relevance: "correct" | "incorrect" | "ambiguous";
  score: number;         // 1-5 from reranker
  reasoning: string;
}
```

**Decision logic after evaluation:**
- If ≥60% of chunks are "correct" → proceed to synthesis (or reasoning)
- If ≥40% are "incorrect" → flag `needs_requery = true`, generate reformulated queries
- If mostly "ambiguous" → flag `needs_requery = true` with broadened queries

**Reformulation prompt (triggered when needs_requery):**
```
The following search results were retrieved for the user's question but many are
not relevant. Suggest 2-3 alternative search queries that would find better results.

Question: {query}
Poor results: {summaries_of_incorrect_chunks}

Respond as JSON: {"reformulated_queries": ["...", "..."]}
```

### 6b. IRCoT Reasoner (`stages/reasoner.ts`)

The core iterative reasoning engine. After evaluating retrieved chunks, the reasoner
decides whether enough information has been gathered or whether follow-up queries are
needed.

**Input:** Original query + all accumulated chunks (across iterations) + previous
reasoning steps
**Output:** `ReasoningResult`
**LLM calls:** 1 per iteration

**Reasoning prompt:**
```
You are a research assistant analyzing search results to answer a question.

Original question: {query}

Information gathered so far:
{accumulated_chunks_formatted}

Previous reasoning:
{previous_reasoning_or_"(first iteration)"}

Think step-by-step:
1. What parts of the question can you now answer with the information above?
2. What parts remain unanswered?
3. What follow-up searches would help fill the gaps?

Respond as JSON:
{
  "reasoning": "Step-by-step analysis...",
  "is_sufficient": true/false,
  "follow_up_queries": ["...", "..."],
  "missing_info": ["...", "..."]
}
```

**Convergence detection:**
- `is_sufficient === true` → stop
- `follow_up_queries` is empty → stop
- New retrieval returns no chunks above min score → stop
- New chunks are all duplicates of existing ones → stop
- Budget exhausted → stop

### 6c. Multi-KB Routing Enhancement

Currently, the two-stage search probes all KBs with the same query. With decomposed
queries, different sub-queries may be relevant to different KBs.

**Enhancement:** The retriever stage maintains a per-query × per-KB relevance matrix.
If the analyzer identifies that sub-query #2 is about "deployment config" and KB #3 is
"Infrastructure Docs", the retriever can prioritize that combination.

This is a soft optimization — the system still searches all passing KBs for all queries,
but weights results by the routing affinity.

### Phase 2 Pipeline Flow

```
query → Analyzer → Expander → Retriever → Evaluator ─┐
                                                       │
          ┌──────────────────── (if !sufficient) ◀─────┤
          │                                            │
          ▼                                            │
      Reasoner → new queries → Expander → Retriever →─┘
          │
          │ (sufficient or budget exhausted)
          ▼
      Synthesizer → Result

Iterations: 1-3 (configurable)
Total: ~5-10 LLM calls
Latency: ~5-15 seconds additional
```

---

## 7. Phase 3 — RAPTOR Tree Preprocessing

**Goal:** Build hierarchical summary layers over the corpus at ingestion time so
retrieval can operate at multiple levels of abstraction.

### How RAPTOR Works

RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval) builds a tree
where:
- **Leaf nodes** are the original chunks (level 0)
- **Level 1 nodes** are summaries of semantically clustered chunks
- **Level 2 nodes** are summaries of level 1 summaries
- And so on, until the top level has a manageable number of nodes

At query time, the retriever searches **all levels simultaneously**, getting both
specific details (leaves) and thematic overviews (higher levels).

### Schema Changes

Add a `level` field to `VectorRecord`:

```typescript
export interface VectorRecord {
  // ... existing fields ...
  level: number;          // 0 = raw chunk, 1+ = summary level
  children_ids?: string[]; // IDs of child nodes this summarizes
}
```

This is backward-compatible: all existing records have `level = 0`.

### RAPTOR Build Pipeline

Triggered as a background task after ingestion (or manually from the UI).

```
src/server/kb/raptor/
  ├── clusterer.ts    — Semantic clustering of chunks
  ├── summarizer.ts   — LLM-based cluster summarization
  └── treeBuilder.ts  — Orchestrates the recursive build
```

**Algorithm:**

```
function buildRaptorTree(kbId: string, config: RaptorConfig):
  1. Load all level-0 chunks + embeddings for this KB
  2. While current_level nodes > config.min_cluster_size:
     a. Cluster nodes at current_level using k-means on embeddings
        - k = ceil(num_nodes / config.target_cluster_size)
        - config.target_cluster_size default: 5-10 chunks per cluster
     b. For each cluster:
        - Concatenate chunk contents (truncated to fit context window)
        - LLM call: "Summarize the following related passages into a single
          coherent paragraph that captures all key information..."
        - Embed the summary
        - Store as new VectorRecord at level = current_level + 1
          with children_ids pointing to the cluster members
     c. current_level += 1
  3. Record tree metadata in KB document (levels, node counts, build date)
```

**Clustering approach:** Use k-means on the embedding vectors. The LanceDB vectors are
already stored — we can load them and cluster in-memory. For very large KBs (>10K
chunks), use approximate clustering via random sampling.

**RaptorConfig:**
```typescript
export interface RaptorConfig {
  target_cluster_size: number;    // chunks per cluster (default: 8)
  min_cluster_size: number;       // stop when fewer nodes than this (default: 5)
  max_levels: number;             // safety cap (default: 4)
  summary_model: string;          // LLM for summarization
  max_summary_input_tokens: number; // truncate cluster content (default: 4000)
}
```

### RAPTOR-Aware Retrieval

Modify the retriever stage to search across all levels:

```typescript
// In retriever stage:
const results = await searchKBTable(kbId, queryVector, limit);
// LanceDB returns results from all levels, ranked by similarity.
// No filter needed — higher-level summaries naturally rank high for
// broad queries, leaf nodes rank high for specific queries.
```

The beauty of RAPTOR is that it requires **zero changes to the retrieval code** — the
vector store doesn't care about levels. Broad queries naturally match higher-level
summaries; specific queries naturally match leaf chunks.

### RAPTOR UI

- Show RAPTOR tree status on KB detail page (levels built, node counts per level,
  last build date)
- "Build RAPTOR Index" button that triggers background build
- Tree visualization showing cluster hierarchy (collapsible tree view)
- Per-search-result, show which level it came from (badge: "L0 Chunk" vs "L2 Summary")

---

## 8. Phase 4 — ReAct Research Agent

**Goal:** A fully autonomous research agent that uses the pipeline stages as tools,
with dynamic decision-making about what to search, when to stop, and how to synthesize.

### Agent Architecture

The agent is an LLM with access to **tools** that map to pipeline stages:

```typescript
interface AgentTool {
  name: string;
  description: string;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

const AGENT_TOOLS: AgentTool[] = [
  {
    name: "search_kb",
    description: "Search knowledge bases with a specific query. Returns ranked chunks.",
    // Wraps: embed → twoStageSearch
  },
  {
    name: "search_specific_kb",
    description: "Search a specific knowledge base by name or ID.",
    // Wraps: searchSingleKB
  },
  {
    name: "evaluate_relevance",
    description: "Evaluate whether retrieved chunks are relevant to the question.",
    // Wraps: evaluator stage
  },
  {
    name: "generate_hyde",
    description: "Generate a hypothetical answer to improve search quality.",
    // Wraps: HyDE generation
  },
  {
    name: "list_knowledge_bases",
    description: "List available knowledge bases with their descriptions.",
    // Wraps: listEnabledKBsByScope
  },
  {
    name: "synthesize_answer",
    description: "Synthesize a final answer from accumulated research. Call when done.",
    // Wraps: synthesizer stage — terminates the agent loop
  },
];
```

### Agent Loop

```typescript
async function runResearchAgent(
  query: string,
  scopes: KBScope[],
  config: ResearchConfig,
  owner?: string,
): Promise<ResearchResult> {
  const session = createSession(query, scopes, config);
  const context: AgentContext = {
    query,
    accumulated_chunks: [],
    reasoning_history: [],
    tool_calls: [],
  };

  const systemPrompt = buildAgentSystemPrompt(query, scopes);

  for (let turn = 0; turn < config.max_iterations; turn++) {
    checkBudget(session, config);

    // Ask LLM what to do next
    const response = await llmClient.chatWithTools(
      systemPrompt,
      context.reasoning_history,
      AGENT_TOOLS,
    );

    // Execute tool calls
    for (const toolCall of response.tool_calls) {
      const result = await executeTool(toolCall, context, session);
      context.tool_calls.push({ call: toolCall, result });
    }

    // Check if agent called synthesize_answer (terminal action)
    if (response.tool_calls.some(tc => tc.name === "synthesize_answer")) {
      break;
    }

    // Check if agent has no more tool calls (implicit termination)
    if (response.tool_calls.length === 0) {
      break;
    }
  }

  return buildResult(session, context);
}
```

### Agent System Prompt

```
You are a research agent with access to a knowledge base system. Your goal is to
thoroughly answer the user's question by searching, evaluating, and synthesizing
information from the knowledge bases.

**Available Knowledge Bases:**
{kb_list_with_descriptions}

**Process:**
1. Think about what information you need
2. Search for it using the most specific queries possible
3. Evaluate whether the results are sufficient
4. If not, search again with refined queries
5. When you have enough information, synthesize the final answer

**Rules:**
- Start broad, then narrow down
- Try different phrasings if initial searches don't return good results
- Search different knowledge bases for different aspects of the question
- Always call synthesize_answer when done — don't just stop
- Budget: max {max_iterations} tool calls total

User question: {query}
```

### Agent vs Pipeline

The agent (Phase 4) is an **alternative** to the structured pipeline (Phases 1-2), not
a replacement. They coexist:

| Strategy | Implementation | Best for |
|----------|---------------|----------|
| `"simple"` | Pipeline, Phases 1 only | Low-latency, simple queries |
| `"deep"` | Pipeline, Phases 1+2 | Complex queries, predictable behavior |
| `"agent"` | Agent loop, Phase 4 | Exploratory queries, maximum quality |

The pipeline is more predictable and cheaper; the agent is more flexible but less
deterministic.

---

## 9. Audit Logging

### Design Goals

1. **Every decision is traceable** — from input query to final context, every
   intermediate step is recorded.
2. **Queryable** — audit logs can be filtered by session, stage, time range.
3. **Displayable** — the UI can render a step-by-step timeline of any research session.
4. **Lightweight** — audit records are small (truncated previews, not full prompts).

### Storage

Audit logs are stored in MongoDB in a `research_sessions` collection:

```typescript
// MongoDB document
interface ResearchSessionDoc {
  _id: ObjectId;
  session_id: string;
  original_query: string;
  scopes: KBScope[];
  strategy: ResearchStrategy;
  config: ResearchConfig;

  // Denormalized summary for list views
  metrics: ResearchMetrics;
  status: "running" | "completed" | "failed" | "budget_exhausted";

  // Full step log
  steps: ResearchStep[];

  // Link to consumer
  consumer: {
    type: "worker_job" | "chat" | "playground" | "api";
    id?: string;  // task_id or conversation_id
  };

  created_at: Date;
  completed_at?: Date;
}
```

### Audit Emitter

Every stage receives an `AuditEmitter` that records steps:

```typescript
class AuditEmitter {
  constructor(private session: ResearchSession) {}

  startStep(stage: ResearchStage, iteration: number): StepRecorder {
    const step: ResearchStep = {
      step_id: uuidv4(),
      stage,
      iteration,
      input: {},
      output: {},
      duration_ms: 0,
      llm_calls: [],
      retrieval_calls: [],
    };
    return new StepRecorder(step, this.session);
  }
}

class StepRecorder {
  private startTime = Date.now();

  recordInput(input: Record<string, unknown>): void { ... }
  recordOutput(output: Record<string, unknown>): void { ... }
  recordLLMCall(call: LLMCallRecord): void { ... }
  recordRetrieval(call: RetrievalRecord): void { ... }

  finish(): void {
    this.step.duration_ms = Date.now() - this.startTime;
    this.session.steps.push(this.step);
  }
}
```

### Real-Time Streaming

For the playground UI, audit events can be streamed as NDJSON (same pattern as
ingestion streaming):

```
POST /api/web/kb/research (Accept: text/x-ndjson)

→ {"type": "session_start", "session_id": "...", "strategy": "deep"}
→ {"type": "step_start", "stage": "query_analysis", "iteration": 0}
→ {"type": "llm_call", "purpose": "decompose_query", "duration_ms": 850}
→ {"type": "step_complete", "stage": "query_analysis", "duration_ms": 870}
→ {"type": "step_start", "stage": "query_expansion", "iteration": 0}
→ {"type": "llm_call", "purpose": "hyde_generate", "duration_ms": 1200}
→ {"type": "step_complete", "stage": "query_expansion", "queries": 5}
→ {"type": "step_start", "stage": "retrieval", "iteration": 0}
→ {"type": "retrieval", "kb": "Design Docs", "results": 4, "top_score": 0.87}
→ {"type": "retrieval", "kb": "Steve Lore", "results": 2, "top_score": 0.72}
→ {"type": "step_complete", "stage": "retrieval", "total_chunks": 6}
→ {"type": "step_start", "stage": "evaluation", "iteration": 0}
→ {"type": "step_complete", "stage": "evaluation", "correct": 5, "incorrect": 1}
→ {"type": "step_start", "stage": "reasoning", "iteration": 0}
→ {"type": "step_complete", "stage": "reasoning", "is_sufficient": true}
→ {"type": "step_start", "stage": "synthesis", "iteration": 0}
→ {"type": "step_complete", "stage": "synthesis", "chunks_used": 5}
→ {"type": "session_complete", "total_ms": 5420, "llm_calls": 4, "cost_usd": 0.012}
```

---

## 10. Visualization & UI

### 10a. Research Playground

Extend the existing `KBPlayground.tsx` (or create a new `ResearchPlayground.tsx`) with:

**Query panel:**
- Text input for the query
- Strategy selector: `simple` / `deep` / `agent`
- Scope selector (existing)
- Advanced config toggles (HyDE, decomposition, step-back, CRAG, IRCoT)
- "Research" button

**Results panel (existing, enhanced):**
- Final context output
- Chunk cards with scores + RAPTOR level badges
- Source file links

**New: Pipeline Timeline panel:**
A vertical timeline showing each research step:

```
┌──────────────────────────────────────────────────────┐
│ 🔍 Research Pipeline — "deep" strategy               │
│ Total: 5.4s | 4 LLM calls | 6 retrievals | $0.012  │
├──────────────────────────────────────────────────────┤
│                                                      │
│ ⓵ Query Analysis                          870ms     │
│   ├─ Complexity: compound                           │
│   ├─ Sub-queries: 3                                 │
│   │   • "How does Steve receive Slack messages?"    │
│   │   • "What is the routing configuration?"        │
│   │   • "How are LLM providers selected?"           │
│   └─ Step-back: "Slack bot message routing arch."   │
│                                                      │
│ ⓶ Query Expansion                        1,200ms    │
│   ├─ HyDE documents generated: 4                    │
│   ├─ Total expanded queries: 8                      │
│   └─ Deduped to: 6                                  │
│                                                      │
│ ⓷ Retrieval (iteration 1)                 340ms     │
│   ├─ KBs searched: 2/3                              │
│   │   ✓ Design Docs (probe: 0.87)                  │
│   │   ✓ Steve Lore (probe: 0.72)                   │
│   │   ✗ Slack History (probe: 0.31)                │
│   ├─ Chunks retrieved: 12                           │
│   └─ After dedup: 8                                 │
│                                                      │
│ ⓸ Evaluation (iteration 1)                950ms     │
│   ├─ Correct: 6 | Ambiguous: 1 | Incorrect: 1     │
│   └─ Decision: sufficient (75% correct)             │
│                                                      │
│ ⓹ Reasoning (iteration 1)               1,100ms    │
│   ├─ Status: ✅ Sufficient                          │
│   └─ "All aspects of the routing pipeline are       │
│       covered by the retrieved context..."           │
│                                                      │
│ ⓺ Synthesis                               420ms    │
│   ├─ Chunks used: 6                                 │
│   └─ Context length: 3,200 tokens                   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

Each step is expandable to show:
- Full LLM prompts and responses (in a code block)
- Individual retrieval results with scores
- Timing breakdown

### 10b. Research History View

A table/list of past research sessions:
- Query text
- Strategy used
- Metrics (duration, LLM calls, cost)
- Status (completed, failed, budget exhausted)
- Click to view full timeline

### 10c. Per-Job Research Audit

On the job detail page, if KB context was fetched via the research pipeline, show a
collapsible "Research Audit" section with the timeline view.

### 10d. RAPTOR Tree Visualization

On the KB detail page:
- Summary card showing RAPTOR status (built/not built, levels, node counts)
- "Build/Rebuild RAPTOR Index" button
- Interactive tree view:
  - Each node shows a preview of the summary text
  - Click to expand and see child nodes
  - Color-coded by level
  - Search results highlighted in the tree to show which nodes were retrieved

### 10e. Comparative View

Side-by-side comparison of research strategies for the same query:
- Run the same query with `simple`, `deep`, and `agent` strategies
- Show results, quality scores, latency, and cost side by side
- Useful for tuning and debugging

---

## 11. Integration Points

### 11a. Worker Integration

**Current** (`runJob.ts:258-273`):
```typescript
const kbResults = await api.searchKnowledgeBases(job.task_text, [scope, "all"]);
```

**New:**
```typescript
const research = await api.researchKnowledgeBases({
  query: job.task_text,
  scopes: [scope, "all"],
  strategy: job.research_strategy || "deep",  // new field on JobDoc
  consumer: { type: "worker_job", id: job.task_id },
});
// research.context is the pre-formatted context string
// research.audit is available for metrics/logging
kbContext = research.context;
```

The worker API client gets a new method:
```typescript
async researchKnowledgeBases(params: {
  query: string;
  scopes: string[];
  strategy?: ResearchStrategy;
  consumer?: { type: string; id?: string };
}): Promise<{
  context: string;
  chunks: KBSearchResult[];
  metrics: ResearchMetrics;
  session_id: string;
}>
```

**Backward compat:** The existing `searchKnowledgeBases()` method stays, functioning
as before. The new `researchKnowledgeBases()` is opt-in.

### 11b. Chat Integration

The chat message router (`messageRouter.ts`) can use the research pipeline for
"chat" scoped KBs. The `routeMessage` function would call the pipeline before
generating the LLM response.

This is a deeper integration since the chat route currently delegates to the
Slack message router which has its own LLM calls. The research pipeline context
would need to be passed through the routing chain:

```typescript
// In chatRoutes.ts, before routeMessage:
const research = await runResearchPipeline(
  text.trim(),
  ["chat", "all"],
  getStrategyConfig("simple"),  // chat uses fast strategy by default
);

// Pass to routeMessage or inject into the routing context
const action = await routeMessage(text.trim(), owner, threadMessages, {
  kbContext: research.context,
  researchSessionId: research.session_id,
});
```

### 11c. New API Endpoints

```
POST /api/web/kb/research
  Body: { query, scopes, strategy, config_overrides? }
  Accept: application/json → full result
  Accept: text/x-ndjson → streaming audit events

GET /api/web/kb/research/sessions
  Query: ?limit=20&offset=0&strategy=deep
  → list past research sessions

GET /api/web/kb/research/sessions/:id
  → full research session with audit log

POST /api/worker/kb/research
  Body: { query, scopes, strategy, consumer? }
  → { context, chunks, metrics, session_id }

POST /api/web/kb/:id/raptor/build
  → triggers RAPTOR index build (async, returns job ID)

GET /api/web/kb/:id/raptor/status
  → { built: boolean, levels: number, nodes_per_level: {...}, last_built: Date }

GET /api/web/kb/:id/raptor/tree
  → { nodes: RaptorNode[] } for tree visualization
```

### 11d. Existing Search (Backward Compat)

The existing `POST /api/web/kb/search` and `POST /api/worker/kb/search` endpoints
continue to work exactly as before. They call `twoStageSearch()` directly, bypassing
the research pipeline.

The research pipeline internally uses the same `twoStageSearch()` (or its underlying
`searchKBTable()`) as its retrieval stage — it wraps, not replaces.

---

## 12. File Structure

```
src/
  shared/
    kbTypes.ts                    # (existing) — add level field to KBChunk
    researchTypes.ts              # NEW — all research pipeline types

  server/
    kb/
      # ─── Existing (unchanged) ───
      chunker.ts
      embeddings.ts
      ingestion.ts
      kbRepo.ts
      kbService.ts                # add researchKnowledgeBases() entry point
      vectorStore.ts              # add level field support
      kbRoutes.ts                 # add research endpoints

      # ─── New: Research Pipeline ───
      research/
        pipeline.ts               # Pipeline runner / orchestrator
        llmClient.ts              # Thin LLM wrapper for research calls
        auditLog.ts               # Audit logging + MongoDB persistence
        auditRepo.ts              # MongoDB CRUD for research sessions
        strategies.ts             # Strategy profile definitions

        stages/
          queryAnalyzer.ts        # Phase 1: decomposition, step-back
          queryExpander.ts        # Phase 1: HyDE, multi-query, embedding
          retriever.ts            # Phases 1-2: vector search wrapper
          evaluator.ts            # Phases 1-2: reranking + CRAG
          reasoner.ts             # Phase 2: IRCoT reasoning loop
          synthesizer.ts          # All phases: final context assembly

        agent/
          agentLoop.ts            # Phase 4: ReAct agent loop
          agentTools.ts           # Tool definitions for the agent
          agentPrompts.ts         # System prompts

      # ─── New: RAPTOR ───
      raptor/
        clusterer.ts              # Phase 3: k-means clustering
        summarizer.ts             # Phase 3: LLM summarization
        treeBuilder.ts            # Phase 3: recursive tree construction
        raptorRepo.ts             # Phase 3: MongoDB metadata for trees
        # Note: RAPTOR API routes are in kbRoutes.ts (merged with other KB routes)

  ui/
    src/
      components/
        kb/
          # ─── Existing (unchanged) ───
          KBPlayground.tsx
          KBDetail.tsx

          # ─── New ───
          ResearchPlayground.tsx   # Research pipeline playground
          ResearchTimeline.tsx     # Step-by-step timeline component
          ResearchHistory.tsx      # Past sessions list
          RaptorStatus.tsx         # RAPTOR build status card
          RaptorTree.tsx           # Interactive tree visualization
          StrategyComparison.tsx   # Side-by-side strategy comparison
```

---

## 13. Strategy Profiles

Predefined configurations that balance quality vs cost vs latency.

```typescript
export const STRATEGY_PROFILES: Record<ResearchStrategy, ResearchConfig> = {
  simple: {
    strategy: "simple",
    max_iterations: 1,
    max_llm_calls: 3,
    max_retrieval_calls: 10,
    max_wall_time_ms: 10_000,
    enable_decomposition: false,
    enable_hyde: true,
    enable_step_back: false,
    enable_crag: true,      // reranking only, no re-query
    enable_ircot: false,
    max_chunks_per_query: 5,
    min_similarity_score: 0.3,
    dedup_threshold: 0.92,
  },

  deep: {
    strategy: "deep",
    max_iterations: 3,
    max_llm_calls: 10,
    max_retrieval_calls: 20,
    max_wall_time_ms: 30_000,
    enable_decomposition: true,
    enable_hyde: true,
    enable_step_back: true,
    enable_crag: true,
    enable_ircot: true,
    max_chunks_per_query: 8,
    min_similarity_score: 0.25,
    dedup_threshold: 0.90,
  },

  agent: {
    strategy: "agent",
    max_iterations: 8,
    max_llm_calls: 20,
    max_retrieval_calls: 30,
    max_wall_time_ms: 60_000,
    enable_decomposition: true,
    enable_hyde: true,
    enable_step_back: true,
    enable_crag: true,
    enable_ircot: true,
    max_chunks_per_query: 10,
    min_similarity_score: 0.20,
    dedup_threshold: 0.88,
  },
};
```

Users can also provide `config_overrides` to tweak individual parameters.

---

## 14. API Surface

### Server-Side (kbService.ts)

```typescript
// New primary entry point
export async function researchKnowledgeBases(params: {
  query: string;
  scopes: KBScope[];
  strategy?: ResearchStrategy;
  config_overrides?: Partial<ResearchConfig>;
  consumer?: { type: string; id?: string };
  owner?: string;
}): Promise<ResearchResult>;

// Existing (unchanged)
export async function searchKnowledgeBases(...): Promise<KBSearchResult[]>;
export async function searchKnowledgeBasesWithRouting(...): Promise<KBSearchWithRoutingResult>;
```

### Worker API Client (apiClient.ts)

```typescript
// New
async researchKnowledgeBases(params: {
  query: string;
  scopes: string[];
  strategy?: ResearchStrategy;
  consumer?: { type: string; id?: string };
}): Promise<{
  context: string;
  chunks: KBSearchResult[];
  metrics: ResearchMetrics;
  session_id: string;
}>;

// Existing (unchanged)
async searchKnowledgeBases(...): Promise<KBSearchResult[]>;
```

### REST Endpoints (kbRoutes.ts)

```
# Research
POST   /api/web/kb/research              # playground: run research pipeline
GET    /api/web/kb/research/sessions      # list past sessions
GET    /api/web/kb/research/sessions/:id  # get full session + audit
POST   /api/worker/kb/research            # worker: run research pipeline

# RAPTOR
POST   /api/web/kb/:id/raptor/build       # trigger RAPTOR build
GET    /api/web/kb/:id/raptor/status       # get build status
GET    /api/web/kb/:id/raptor/tree         # get tree for visualization
```

---

## 15. LLM Client Design

The research pipeline needs a lightweight LLM client for its internal reasoning calls
(not the final answer generation — that's still Claude Code / the chat LLM).

### Requirements

- Uses the same LLM provider configuration as the rest of the system
- Supports structured JSON output (for stage prompts)
- Supports tool-use (for Phase 4 agent)
- Tracks token usage and cost per call
- Fast models preferred (e.g., `gpt-4o-mini`, `claude-3-haiku`) — research
  reasoning doesn't need the most powerful model

### Implementation

```typescript
// research/llmClient.ts

export interface LLMClientConfig {
  model: string;              // default: "bedrock/amazon.nova-pro-v1:0" (overridable via SOS_RESEARCH_LLM_MODEL)
  api_key: string;
  base_url: string;           // OpenAI-compatible endpoint
  temperature: number;        // default: 0.0 (deterministic for research)
  max_tokens: number;         // default: 1024
}

export interface LLMResponse {
  content: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  cost_usd?: number;
}

export interface LLMClient {
  chat(messages: ChatMessage[], options?: { json_mode?: boolean }): Promise<LLMResponse>;
  chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse & { tool_calls: ToolCall[] }>;
}

export function createResearchLLMClient(config?: Partial<LLMClientConfig>): LLMClient;
```

**Config via environment:**
```
SOS_RESEARCH_LLM_MODEL=bedrock/amazon.nova-pro-v1:0
SOS_RESEARCH_LLM_API_KEY=...     # falls back to OPENAI_API_KEY
SOS_RESEARCH_LLM_BASE_URL=...    # falls back to https://api.openai.com/v1
SOS_RESEARCH_LLM_TEMPERATURE=0.0
```

Using a fast, cheap model keeps research pipeline costs minimal even with 10+
LLM calls. The default is `bedrock/amazon.nova-pro-v1:0` but any OpenAI-compatible
model works (e.g., `gpt-4o-mini` at ~$0.15/1M input tokens).

---

## 16. Cost & Latency Budget

### Per-Strategy Estimates

Assuming gpt-4o-mini for research LLM calls and text-embedding-3-small for embeddings:

| Strategy | LLM Calls | Embed Calls | Vector Searches | Latency | Est. Cost |
|----------|-----------|-------------|-----------------|---------|-----------|
| simple   | 2-3       | 1           | 3-6             | 2-4s    | $0.001-0.003 |
| deep     | 5-10      | 2-3         | 8-15            | 5-15s   | $0.005-0.015 |
| agent    | 8-20      | 3-5         | 10-25           | 10-30s  | $0.010-0.040 |

### Budget Enforcement

The pipeline runner enforces hard limits:

```typescript
function checkBudget(session: ResearchSession, config: ResearchConfig): void {
  const llmCalls = session.steps.flatMap(s => s.llm_calls).length;
  const retrievalCalls = session.steps.flatMap(s => s.retrieval_calls).length;
  const elapsed = Date.now() - session.created_at.getTime();

  if (llmCalls >= config.max_llm_calls) throw new BudgetExhaustedError("llm_calls");
  if (retrievalCalls >= config.max_retrieval_calls) throw new BudgetExhaustedError("retrieval_calls");
  if (elapsed >= config.max_wall_time_ms) throw new BudgetExhaustedError("wall_time");
}
```

Budget exhaustion is a graceful stop — the pipeline synthesizes the best answer it
can from whatever has been gathered so far, rather than throwing an error.

---

## 17. Implementation Order

Phased delivery where each phase is independently shippable.

### Sprint 1: Foundation + Phase 1 (Simple)

1. **Types** — `researchTypes.ts` with all shared types
2. **LLM Client** — `research/llmClient.ts`
3. **Audit system** — `auditLog.ts`, `auditRepo.ts` (MongoDB)
4. **Pipeline runner** — `pipeline.ts` (skeleton)
5. **Query Analyzer** — `stages/queryAnalyzer.ts`
6. **Query Expander** — `stages/queryExpander.ts` (HyDE)
7. **Retriever** — `stages/retriever.ts` (wraps existing search)
8. **Evaluator** — `stages/evaluator.ts` (reranking only)
9. **Synthesizer** — `stages/synthesizer.ts`
10. **Strategy profiles** — `strategies.ts`
11. **API endpoints** — research routes in `kbRoutes.ts`
12. **Worker integration** — `researchKnowledgeBases()` in apiClient
13. **UI: ResearchPlayground** — basic query + results + timeline

### Sprint 2: Phase 2 (Deep)

14. **Evaluator extension** — CRAG relevance classification + re-query
15. **Reasoner** — `stages/reasoner.ts` (IRCoT)
16. **Pipeline loop** — retriever → evaluator → reasoner iteration
17. **Convergence detection** — dedup, budget, sufficiency
18. **Streaming audit** — NDJSON streaming for playground
19. **UI: Enhanced Timeline** — iteration visualization, expandable steps
20. **UI: Research History** — session list + detail view

### Sprint 3: Phase 3 (RAPTOR)

21. **Schema migration** — add `level` field to VectorRecord
22. **Clusterer** — `raptor/clusterer.ts` (k-means on embeddings)
23. **Summarizer** — `raptor/summarizer.ts` (LLM cluster summaries)
24. **Tree builder** — `raptor/treeBuilder.ts` (recursive orchestrator)
25. **RAPTOR routes** — build/status/tree endpoints
26. **UI: RAPTOR Status** — build button + status card
27. **UI: RAPTOR Tree** — interactive tree visualization
28. **Retriever update** — level-aware result display (no search change needed)

### Sprint 4: Phase 4 (Agent)

29. **Agent tools** — `agent/agentTools.ts`
30. **Agent loop** — `agent/agentLoop.ts`
31. **Agent prompts** — `agent/agentPrompts.ts`
32. **Tool-use LLM client** — extend llmClient with tool calling
33. **UI: Agent view** — tool-call timeline, reasoning display
34. **UI: Strategy Comparison** — side-by-side comparison view

### Sprint 5: Polish & Optimization

35. **Per-job strategy config** — UI for setting research strategy on jobs
36. **Chat integration** — research pipeline in web chat
37. **Cost tracking dashboard** — cumulative cost by strategy, time period
38. **Performance tuning** — parallel retrieval, caching, prompt optimization
39. **Testing** — unit tests for each stage, integration tests for pipeline

---

## 18. Open Questions & Answers

1. **Research LLM model:** Should we use `gpt-4o-mini` (cheapest, fastest) or a
   slightly more capable model like `claude-3.5-haiku` for the research reasoning?
   The reasoning quality directly impacts query decomposition and CRAG evaluation.
   Answer: more capable model; but user should be able to toggle from list in UI.

2. **RAPTOR rebuild triggers:** Should RAPTOR trees auto-rebuild when new documents
   are ingested? Or only on manual trigger? Auto-rebuild is convenient but could be
   expensive for frequently-updated KBs.
   Answer: only on manual trigger.

3. **Per-KB strategy overrides:** Should individual KBs be able to specify their
   preferred research strategy? E.g., a small "Steve Lore" KB might always use
   `simple`, while a large "Design Docs" KB prefers `deep`.
   Answer: no need for this.

4. **Agent tool extensibility:** Phase 4 agent tools are hardcoded. Should we
   support user-defined tools (e.g., "search the web", "query a database")?
   This could be powerful but adds significant complexity.
   Answer: not yet, but build in a way to leave the option open in the future.

5. **Caching:** Should we cache research results for identical queries? This could
   save significant cost for repeated questions, but cache invalidation (when KBs
   are updated) needs careful design.
   Answer: no need for this yet.

6. **Embedding model for RAPTOR summaries:** Should RAPTOR summaries use the same
   embedding model as the source chunks? Or could a different model that better
   captures abstract concepts improve retrieval at higher tree levels?
   Answer: use th models according to your best judgement; in both cases, should be toggleable via UI.

7. **Streaming to worker:** The worker currently gets a synchronous response from
   the research endpoint. For the `agent` strategy (which can take 30+ seconds),
   should the worker API also support streaming? Or is a long HTTP timeout
   sufficient?
   Answer: Yes, for 'deep' and 'agent' mode the worker should stream to client -> chat/Slack messages

8. **Chunk-level citations:** The synthesizer assembles context from multiple chunks.
   Should the final context include inline citations (e.g., `[1]`, `[2]`) that map
   back to specific chunks? This would let the consuming LLM cite its sources.
   Answer: Yes.
