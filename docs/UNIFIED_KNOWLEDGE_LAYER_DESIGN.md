# Unified Knowledge Layer — Design Specification

> **Status**: Proposed
> **Authors**: Steve Vitali + Cascade AI
> **Date**: March 2026
> **Prerequisites**: Knowledge Base system (implemented), Memory system (implemented, Phases 1–7)
> **Related Docs**: `MEMORY_SYSTEM_DESIGN.md`, `RESEARCH_PIPELINE_DESIGN.md`, `ARCHITECTURE.md`

---

## Table of Contents

1. [Motivation & Problem Statement](#1-motivation--problem-statement)
2. [Current Architecture — Two Parallel Systems](#2-current-architecture--two-parallel-systems)
3. [Literature Review](#3-literature-review)
4. [Design Decision: Why NOT to Merge the Data Stores](#4-design-decision-why-not-to-merge-the-data-stores)
5. [Architecture: Unified Context Module with Adaptive Depth](#5-architecture-unified-context-module-with-adaptive-depth)
6. [Seamless Adaptive Depth — Eliminating kb_search](#6-seamless-adaptive-depth--eliminating-kb_search)
7. [Detailed Design — Each Component](#7-detailed-design--each-component)
8. [Graceful Degradation & Configuration](#8-graceful-degradation--configuration)
9. [Shared Retrieval Primitives](#9-shared-retrieval-primitives)
10. [Worker Memory Context](#10-worker-memory-context)
11. [Prompt Structure Changes](#11-prompt-structure-changes)
12. [Cost & Latency Analysis](#12-cost--latency-analysis)
13. [Implementation Phases](#13-implementation-phases)
14. [What NOT to Do (Anti-Patterns)](#14-what-not-to-do-anti-patterns)
15. [Testing Strategy](#15-testing-strategy)
16. [Future Extensions](#16-future-extensions)

---

## 1. Motivation & Problem Statement

### 1.1 The Gap

Son of Steve has two powerful but completely disconnected knowledge systems:

- **Knowledge Base (KB)**: Static document retrieval — users upload files (PDFs, text, archives), which are chunked, embedded, and stored for semantic search. Features include RAPTOR tree hierarchical indexing, hybrid search (vector + FTS5 + RRF), two-stage KB routing, and a multi-strategy research pipeline (simple/deep/agent).

- **Memory System**: Evolving learned knowledge — facts, reflections, and user profiles extracted from interactions via LLM pipelines. Features include A-MEM-style evolution and linking, signal collection, periodic reflection/consolidation, and four-factor composite scoring (similarity + recency + importance + access).

Both systems independently produce high-quality context. But they are **assembled independently, injected into separate prompt sections, and compete for the same scarce context window with no coordination**.

### 1.2 Specific Failures

1. **Wasted context budget**: `{MEMORY_CONTEXT}` gets up to 1500 tokens and `{KB_CONTEXT}` gets up to 2000 tokens. These budgets are independent — a question perfectly answered by KB alone still wastes tokens searching for memories, and vice versa.

2. **No cross-ranking**: If a memory note and a KB chunk are both about the same topic, there is no mechanism to compare, deduplicate, or rank them against each other.

3. **No cross-source reasoning**: A memory that says "the user previously struggled with the auth module" and a KB chunk explaining the auth architecture are *complementary*. The current system cannot detect this.

4. **Workers have no memory**: `runJob.ts` and `runPlanJob.ts` fetch KB context via `api.researchKnowledgeBases()` but have **zero access to memory context**.

5. **Position bias vulnerability**: The "Lost in the Middle" research shows LLMs pay most attention to the beginning and end of context. The current system dumps KB and memory context in arbitrary order.

6. **The `kb_search` action is a workaround**: The routing LLM must explicitly decide "this question needs deeper search" by picking `kb_search` instead of `chat`. This is a chicken-and-egg problem — the LLM decides it needs deeper context *using the shallow context it already has*. The system should automatically determine the right depth.

### 1.3 The Goal

Build a **Unified Context Module** that:

1. Searches both KB and Memory in parallel for every interaction
2. Cross-ranks results using LLM-based listwise reranking
3. **Automatically escalates to deep retrieval when context is insufficient** — no special actions needed
4. Constructs a single, optimally-ordered context block within a shared token budget
5. Serves both the routing LLM and the worker
6. Lives in a new `src/server/context/` module — does NOT modify the research pipeline internals

---

## 2. Current Architecture — Two Parallel Systems

### 2.1 Knowledge Base System

**Location**: `src/server/kb/`

**Data model**: `KnowledgeBase` (container) → `KBDocument` (file) → chunks in LanceDB

**Storage**:
- MongoDB: `knowledge_bases` collection, `kb_documents` collection
- LanceDB: Tables `kb_{kb_id}`, separate Connection in `vectorStore.ts`
- SQLite FTS5: Files `fts_{kb_id}.sqlite`, separate storagePath in `ftsStore.ts`

**Search flow** (`kbService.ts`):
```
searchKnowledgeBases(request, owner?)
  → twoStageSearch()
    → Stage 1: Probe each enabled KB (limit=1, filter by min_similarity_score)
    → Stage 2: hybridSearch() on passing KBs (vector + FTS5 + RRF)
    → Sort by score, limit to max_chunks
```

**Scoring**: Similarity (`1/(1+distance)`) + BM25, fused via RRF (k=60).

**Scoping**: Per-KB `scopes` field (`chat`, `create_job`, `plan_job`, `agent_task`, `all`).

**Consumers** (KB flows to BOTH routing AND workers):

| Consumer | File | Method |
|----------|------|--------|
| Routing LLM | `messageRouter.ts` | `buildKBContext()` → `searchKnowledgeBases()` or `researchKnowledgeBases()` |
| Worker (job) | `runJob.ts` | `api.researchKnowledgeBases()` via HTTP |
| Worker (plan) | `runPlanJob.ts` | `api.researchKnowledgeBases()` via HTTP |
| Image enrichment | `executors.ts` | `searchKnowledgeBases()` |
| `kb_search` action | `researchExecutor.ts` | `researchKnowledgeBases()` + `synthesizeForUser()` |

**Critical detail for routine chat**: `buildKBContext()` in `messageRouter.ts` has TWO paths:
- If `kb_research_strategy` is set in routing config → research pipeline (multi-LLM)
- **Default (no config set)**: `basicKBSearch()` → `searchKnowledgeBases()` with **zero LLM calls**

The research pipeline is NOT what runs on every chat message. The default path is fast vector search with no LLM involvement. This is a critical constraint for the unified design.

**Research pipeline** (`src/server/kb/research/pipeline.ts`): Multi-stage RAG with strategies simple/deep/agent. Has query analysis, expansion, retrieval, LLM evaluation, IRCoT reasoning, synthesis, budget enforcement, audit logging.

### 2.2 Memory System

**Location**: `src/server/memory/`

**Data model**: `InteractionEpisode` → `MemoryNote` (fact/reflection/profile) with A-MEM links

**Storage**: MongoDB (`memories`, `interaction_episodes`), LanceDB (`mem_{owner_id}`), SQLite FTS5 (`mem_fts_{owner_id}.sqlite`). All **separate** connections from KB.

**Scoring**: Four-factor composite — `w_sim * similarity + w_rec * recency + w_imp * importance + w_acc * access`. Defaults: 0.45/0.20/0.20/0.15.

**Consumers**: **Only the routing LLM** via `getMemoryContext()`. Workers have no access.

**Write path**: Five async pipelines (A: Episode Recording, B: Fact Extraction, C: Signal Collection, D: Reflection, E: Memory Evolution).

### 2.3 How Context Is Currently Assembled

In `messageRouter.ts` `routeMessage()` (line 233):

```typescript
const [jobsContext, kbContext, memoryResult] = await Promise.all([
  buildJobsContext(),
  buildKBContext(userMessage, ["chat", "all"]),
  getMemoryContext(userMessage, slackUserId).catch(() => ({
    memoryContext: "", userContext: "",
  })),
]);
systemPrompt = systemPrompt.replace("{KB_CONTEXT}", kbContext);
systemPrompt = systemPrompt.replace("{MEMORY_CONTEXT}", memoryResult.memoryContext);
systemPrompt = systemPrompt.replace("{USER_CONTEXT}", memoryResult.userContext);
```

Three independent searches, three independent budgets, three independent prompt sections, zero coordination. All three platforms (Slack, Discord, web chat) flow through this same `routeMessage()` entry point.

### 2.4 The kb_search Problem

Today, `kb_search` is a routing action the LLM picks when it thinks the user needs a knowledge-base answer. It triggers the research pipeline + `synthesizeForUser()` to produce a cited answer. The problems:

1. **Chicken-and-egg**: The routing LLM decides it needs deep search *using the shallow context it already has*. If shallow context missed the answer, the LLM might not even know there's relevant KB content.
2. **Separate UX path**: `kb_search` produces a different kind of response (LLM-synthesized answer with citations) than `chat` (Steve's persona response). The user experiences an inconsistent voice.
3. **The LLM must learn meta-reasoning**: The routing hint says "Prefer this over chat when the question is about something that might be documented." This forces the LLM to reason about retrieval strategy — a concern that should be handled by infrastructure, not the routing LLM.
4. **No memory in kb_search**: The research pipeline searches only KBs, not memory. A deep search triggered by `kb_search` still misses learned knowledge.

### 2.5 Infrastructure Duplication

| Component | KB File | Memory File | ~Lines Each |
|-----------|---------|-------------|-------------|
| LanceDB wrapper | `kb/vectorStore.ts` | `memory/memoryVectorStore.ts` | ~200 |
| FTS5 wrapper | `kb/ftsStore.ts` | `memory/memoryFtsStore.ts` | ~300 |
| Hybrid search (RRF) | `kb/hybridSearch.ts` | `memory/memorySearch.ts` | ~230 |
| Distance→similarity | `kb/kbService.ts` | `memory/memoryUtils.ts` | ~3 |
| FTS query sanitizer | `kb/ftsStore.ts` | `memory/memoryFtsStore.ts` | ~15 |

Both use RRF k=60, same embedding provider, same LanceDB/better-sqlite3 patterns.

---

## 3. Literature Review

### 3.1 Key Insight

Every production system and frontier paper maintains **separate data stores with separate write paths**, but **unifies at the read/retrieval layer**. None flatten everything into one table.

### 3.2 MAGMA (Jiang et al., Jan 2026, arXiv:2601.03236)

Multi-graph memory with semantic/temporal/causal/entity relation types.

- **Intent-Aware Router**: LLM-driven query classification that dynamically weights retrieval sources.
- **Adaptive Traversal**: Dynamic transition scores fusing structural alignment with semantic relevance.
- **Dual-stream write**: Fast path (no LLM) + slow path (async LLM). Mirrors our episode recording + fact extraction.

Performance: ~1.46s latency, moderate token cost.

### 3.3 Zep / Graphiti (Rasmussen et al., Jan 2025, arXiv:2501.13956)

Temporal knowledge graph engine.

- **Unified retrieval returning heterogeneous types**: Semantic edges, entity nodes, community nodes — passed through a dedicated **reranker** (not RRF). Validates cross-source reranking.
- **Bi-temporal model**: Timeline of events + timeline of ingestion. Similar to our `valid_from`/`invalidated_at`.

Performance: 18% higher accuracy than full-context baselines, 1/10th processing time.

### 3.4 EverMemOS (Hu et al., Jan 2026, arXiv:2601.02163)

Brain-inspired memory with three-phase engram lifecycle.

- **Reconstructive Recollection with sufficiency check**: After assembling context, verifies completeness. If incomplete, rewrites query and retrieves again. **This is the key mechanism for our adaptive depth design.**

Performance: 92.3% LoCoMo, 82% LongMemEval-S (SOTA).

### 3.5 RankRAG (Yu et al., NeurIPS 2024)

LLM instruction-tuned for both ranking and generation significantly outperforms systems with separate retriever → reranker → generator pipelines, especially for heterogeneous sources. Validates that for merging KB + Memory results, an LLM that reasons about relevance and complementarity is necessary — RRF is insufficient.

### 3.6 LLM Listwise Reranking — Production Data (ZeroEntropy, 2025)

- Listwise reranking enables **cross-document reasoning** impossible for pointwise methods
- For low-QPS, high-value workloads: LLM reranking of top-10 is optimal
- **Prompt caching** reduces reranker cost by ~50% (stable instruction prefix cached across calls)

### 3.7 "Lost in the Middle" (Liu et al., Stanford 2023, TACL 2024)

~20% accuracy drop for middle-positioned information. BUT: tested on 2023-era models. Current models have improved through training-time mitigations. The effect still exists but is less dramatic. **Implication**: trust the LLM reranker's ordering rather than applying a rigid positional template.

### 3.8 CRAG (Yan et al., 2024)

Lightweight evaluator assesses retrieval quality before generation. If "Incorrect", triggers fallback. If "Ambiguous", combines with additional retrieval. **Key insight for our design: sufficiency evaluation and reranking can be the same LLM call.**

### 3.9 "Anatomy of Agentic Memory" Survey (Feb 2026, arXiv:2602.19320)

- "Main bottlenecks lie less in architectural novelty and more in evaluation validity and system scalability"
- MemoryOS (strict hierarchical paging) >32 seconds latency — over-structured approaches impractical
- "Excessive maintenance time risks throughput collapse" — async fire-and-forget is correct
- MAGMA achieves best Pareto balance of accuracy vs. cost

---

## 4. Design Decision: Why NOT to Merge the Data Stores

### 4.1 Fundamental Differences

| Property | KB Chunk | Memory Note |
|----------|----------|-------------|
| **Lifecycle** | Static until re-ingested | Evolving (update, invalidate, supersede) |
| **Provenance** | Document hierarchy (file → section → chunk) | Interaction provenance (episodes → extraction → linking) |
| **Scoring** | Pure similarity + BM25 | 4-factor composite (similarity + recency + importance + access) |
| **Temporality** | Atemporal | Deeply temporal (valid_from, invalidated_at, recency decay) |
| **Scoping** | Per-action (chat, create_job, etc.) | Per-owner (user-level) |
| **Consumers** | Routing LLM AND workers | Currently routing LLM only |

### 4.2 What Merging Would Break

- Memory evolution searches *only* memories for neighbors — a unified table pollutes this
- KB two-stage routing doesn't apply to memory
- RAPTOR tree hierarchical chunks have no memory equivalent
- Score normalization would force artificial fields on both types

### 4.3 Frontier Consensus

Zep, MAGMA, Mem0, EverMemOS all maintain separate stores but unify at the read layer.

---

## 5. Architecture: Unified Context Module with Adaptive Depth

### 5.1 Core Design Decisions

**Decision 1: New `src/server/context/` module** — does NOT modify the research pipeline internals. The context module imports from both `kb/` and `memory/` — clean dependency tree, no bidirectional coupling.

**Decision 2: Adaptive depth via combined reranker+sufficiency call** — a single LLM call simultaneously ranks candidates AND decides whether deeper retrieval is needed. This replaces the `kb_search` action entirely.

**Decision 3: Two modes, same entry point** — lightweight (fast retrieval → rerank → serialize) and deep (research pipeline → merge with memory → rerank → serialize) are both handled by the same orchestrator. The decision to escalate is made by the LLM, not by action routing.

### 5.2 Module Structure

```
src/server/context/
├── contextAssembler.ts     # Main orchestrator (adaptive depth)
├── contextReranker.ts      # LLM listwise reranker + sufficiency evaluator
├── contextSerializer.ts    # Position-aware serialization with shared budget
├── contextNormalizer.ts    # KBSearchResult/MemorySearchResult → ContextItem
├── contextTypes.ts         # ContextItem, AssemblyResult, etc.
├── contextConfig.ts        # Configuration loading
└── index.ts                # Barrel export
```

### 5.3 High-Level Flow

```
User Query + Owner ID + Scopes
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│              Context Assembler (contextAssembler.ts)           │
│                                                               │
│  STEP 1: Fast Parallel Retrieval          [~100ms, 0 LLM]    │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ searchKnowledge  │  │ searchMemories│  │ getUserProfile│    │
│  │ Bases()          │  │ ()            │  │ ()            │    │
│  └────────┬────────┘  └──────┬───────┘  └──────┬───────┘    │
│           └──────────┬───────┘                  │             │
│                      ▼                          │             │
│  STEP 2: Gating Check                          │             │
│  ├── Both sources have results → STEP 3         │             │
│  ├── Single source only → skip reranker → STEP 5│             │
│  └── Neither source → return empty + profile    │             │
│                      ▼                          │             │
│  STEP 3: LLM Rerank + Sufficiency  [~300ms, 1 LLM]          │
│  ┌──────────────────────────────┐               │             │
│  │ Combined reranker prompt:     │               │             │
│  │ - Rank items by usefulness    │               │             │
│  │ - Assess: sufficient?         │               │             │
│  │ - If not: what's missing?     │               │             │
│  └──────────┬───────────────────┘               │             │
│             │                                    │             │
│             ├── sufficient → STEP 5              │             │
│             └── insufficient → STEP 4            │             │
│                      ▼                           │             │
│  STEP 4: Deep Escalation          [~1-2s, 2-3 LLM]          │
│  ┌──────────────────────────────┐                │             │
│  │ researchKnowledgeBases()     │  (existing      │             │
│  │ with follow_up_queries       │   pipeline,     │             │
│  │ from sufficiency check       │   unchanged)    │             │
│  └──────────┬───────────────────┘                │             │
│             │ merge new KB results with existing  │             │
│             ▼                                    │             │
│  STEP 5: Serialize              [~5ms, 0 LLM]   │             │
│  ┌──────────────────────────────┐                │             │
│  │ Profile (preamble)           │ ◄──────────────┘             │
│  │ + Reranker-ordered items     │                              │
│  │ within shared token budget   │                              │
│  └──────────┬───────────────────┘                              │
│             ▼                                                  │
│  Unified context string                                        │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
  {CONTEXT} placeholder (routing prompt OR worker prompt)
```

### 5.4 Why This Is NOT "Extending the Research Pipeline"

The original design proposed modifying the research pipeline's internal stages (retriever, evaluator, synthesizer). This was wrong because:

1. **The research pipeline does NOT run on routine chat by default.** The default path is `basicKBSearch()` with zero LLM calls. Forcing all messages through the research pipeline would add 2-4 LLM calls where there were previously 0.
2. **Bidirectional coupling**: Modifying `src/server/kb/research/` to import from `src/server/memory/` creates KB ↔ Memory dependency. The new `src/server/context/` module imports from both — clean one-way dependencies.
3. **Risk**: The research pipeline is complex and well-tested. Modifying its internal stages risks breaking the existing `kb_search` action, worker KB fetching, and the research playground UI.

The context module calls the research pipeline's PUBLIC API (`researchKnowledgeBases()`) only in deep escalation mode — it never modifies pipeline internals.

---

## 6. Seamless Adaptive Depth — Eliminating kb_search

### 6.1 The Problem with kb_search

The `kb_search` action in `routing-config.yaml` requires the routing LLM to:
1. See shallow context (basic vector search)
2. Decide this isn't enough → pick `kb_search` instead of `chat`
3. The research executor runs the full pipeline + `synthesizeForUser()`
4. A separate, non-Steve-persona answer is returned with citations

This is a workaround. The real solution: **the context assembler automatically escalates to deep retrieval when shallow results are insufficient, BEFORE the routing LLM ever sees the context.**

### 6.2 The Combined Reranker + Sufficiency Evaluator

The key insight (from EverMemOS + CRAG): the LLM that reranks candidates can simultaneously assess sufficiency — it already sees all the evidence. One call, two outputs.

When the reranker returns `"sufficient"`:
- The routing LLM sees excellent context and handles the question via `chat`
- Steve's persona is preserved
- Total: 1 LLM call for context assembly

When the reranker returns `"insufficient"` with `follow_up_queries`:
- The context assembler runs `researchKnowledgeBases()` with the suggested follow-up queries (using the existing research pipeline, unchanged)
- New KB results are merged with existing results + memory
- The serializer constructs the final context
- The routing LLM sees deep, well-researched context and handles it via `chat`
- Steve's persona is preserved
- Total: 1 + 2-3 LLM calls (reranker + research pipeline)

When the reranker returns `"not_knowledge_query"`:
- The query is conversational ("hi", "list jobs", "cancel job xyz")
- Context is serialized as-is (may be empty or minimal)
- Total: 1 LLM call (but see §8 for optimization that skips this)

### 6.3 What Happens to kb_search

**Recommended: Deprecate and remove `kb_search` from routing-config.yaml.** The routing LLM no longer needs to decide between `chat` and `kb_search` — every knowledge question is handled by `chat` with automatically-deepened context.

Benefits:
- **Simpler routing config**: One fewer action for the LLM to learn
- **Consistent UX**: All answers come through Steve's persona
- **Memory included in deep search**: The research pipeline provides deep KB context, AND memory is always present
- **No chicken-and-egg**: The depth decision is made by the context assembler based on actual retrieval results, not by the routing LLM guessing

The `researchExecutor.ts` and `synthesizeForUser()` continue to exist for the worker-side research pipeline and the web UI playground — they just aren't exposed as a routing action.

### 6.4 Edge Case: User Explicitly Wants "Search the Docs"

If the user says "search the docs for deployment instructions", the routing LLM picks `chat` with context that includes deep-researched KB results (because the reranker flagged the initial results as insufficient for this clearly knowledge-seeking query). Steve responds with a great answer using the deep context. The user doesn't notice or care that there's no separate `kb_search` action.

If the research trace/metrics are desired, they can be exposed through the memory UI's audit panel or a future `/context/debug` endpoint.

---

## 7. Detailed Design — Each Component

### 7.1 Context Types (`contextTypes.ts`)

```typescript
interface ContextItem {
  id: string;
  content: string;
  source: "kb" | "memory";
  raw_score: number;
  metadata: {
    // KB-specific
    kb_name?: string; source_file?: string; section?: string;
    retrieval_source?: "vector" | "keyword" | "both";
    // Memory-specific
    memory_type?: "fact" | "reflection" | "user_profile";
    memory_id?: string; importance?: number; recency_score?: number;
    // Common
    temporal_tag?: string; // "from API docs", "learned Mar 15"
  };
}

type Sufficiency = "sufficient" | "insufficient" | "not_knowledge_query";

interface RerankerResult {
  ranked_items: ContextItem[];
  dropped_items: ContextItem[];
  sufficiency: Sufficiency;
  follow_up_queries: string[] | null;  // Only when insufficient
  reasoning: string;
}

interface AssemblyResult {
  context: string;           // Unified context string for prompt injection
  profile: string;           // User profile (always-included preamble)
  was_deep: boolean;         // Whether deep escalation was triggered
  metadata: {
    kb_items_used: number;
    memory_items_used: number;
    reranker_called: boolean;
    deep_escalation: boolean;
    total_duration_ms: number;
  };
}
```

### 7.2 Context Assembler (`contextAssembler.ts`)

Main orchestrator. Public API:

```typescript
export async function assembleContext(params: {
  query: string;
  owner: string;
  scopes: KBScope[];
  maxTokens?: number;           // Shared budget (default: 3500)
  allowDeepEscalation?: boolean; // Default: true
}): Promise<AssemblyResult>
```

**Step 1**: Parallel fast retrieval — `searchKnowledgeBases()` + `searchMemories()` + `buildUserContext()`. All three run via `Promise.all()`.

**Step 2**: Gating — If only one source returned results (or neither), skip the LLM reranker entirely. If both sources have results, proceed to Step 3.

**Step 3**: Combined reranker + sufficiency evaluation (1 LLM call). See §7.3.

**Step 4**: If `insufficient` AND `allowDeepEscalation` is true, call `researchKnowledgeBases()` with the follow-up queries from the reranker. Merge new results, re-normalize. The reranker is NOT called again — the research pipeline's internal evaluation already ranks the deep results. Just merge and serialize.

**Step 5**: Serialize via `contextSerializer.ts` — profile preamble + items in reranker's order (or raw_score order if reranker was skipped), within the shared token budget.

### 7.3 Context Reranker (`contextReranker.ts`)

**Prompt design** (stable instruction as system message for prompt caching):

```
SYSTEM:
You are a context relevance evaluator for a coding agent called Steve.
Given a user query and candidate context items from knowledge bases and
learned memories, produce an optimal ranking and assess sufficiency.

For each candidate, consider:
- Direct relevance to the query
- Complementarity (items that together give a fuller picture)
- Deduplication (same info from two sources → keep the richer one)
- Personal context (user preferences/corrections) often overrides generic docs

Respond with JSON only.

USER:
## Query
{{query}}

## Candidates
{{#each items}}
[{{index}}] ({{source}}{{#if memory_type}}, {{memory_type}}{{/if}}{{#if kb_name}}, {{kb_name}}{{/if}}{{#if temporal_tag}}, {{temporal_tag}}{{/if}})
{{content_truncated_to_200_chars}}
---
{{/each}}

## Tasks
1. Rank candidates by usefulness for answering this query.
2. Assess sufficiency: given ONLY these candidates, can the query be answered well?
   - "sufficient": the context covers the query adequately
   - "insufficient": important information appears to be missing
   - "not_knowledge_query": this is conversational/operational, not a knowledge question
3. If insufficient, suggest 1-3 follow-up search queries that would find the missing info.

Return:
{
  "ranked_indices": [3, 1, 7, ...],
  "dropped_indices": [2, 5],
  "sufficiency": "sufficient" | "insufficient" | "not_knowledge_query",
  "follow_up_queries": ["...", "..."] | null,
  "reasoning": "Brief explanation"
}
```

**LLM**: Uses the `context` model role (default: `gpt-4.1-mini`). The stable system message enables prompt caching — ~50% cost reduction on cache hits.

**Cost**: ~10 items × ~200 tokens each truncated content = ~2000 input tokens + ~200 output. At gpt-4.1-mini: ~$0.001/call, ~$0.0005 with cache hit.

### 7.4 Context Serializer (`contextSerializer.ts`)

Constructs the final context string within a shared token budget.

**Ordering**: Uses the reranker's ranked order directly. The LLM has already determined the optimal ordering considering relevance, complementarity, and deduplication. We do NOT apply a rigid "bookend" template — the reranker's ordering is the ordering.

The one exception: the user profile is always the preamble (it's identity context, not a search result).

**Format**: Each item gets a lightweight source tag:

```
[fact, learned Mar 15] The user prefers TypeScript strict mode with no-any rules.

[Design Docs > auth-module.md > JWT Implementation] (score: 0.89)
The auth module uses a custom JWT implementation with rotating refresh tokens...

[reflection, from 8 interactions] Auth questions usually relate to the OAuth flow, not JWT.
```

**Budget**: Single shared budget (configurable, default ~3500 tokens). Items serialized in order until budget exhausted. `estimateTokens()` (~4 chars/token) used for fast estimation.

### 7.5 Context Normalizer (`contextNormalizer.ts`)

Pure functions that convert system-specific results into `ContextItem[]`:

```typescript
export function normalizeKBResults(results: KBSearchResult[]): ContextItem[];
export function normalizeMemoryResults(results: MemorySearchResult[]): ContextItem[];
```

KB items get temporal_tag from `kb_name` + `source_file`. Memory items get temporal_tag from `memory_type` + `updated_at` date.

---

## 8. Graceful Degradation & Configuration

### 8.1 Configuration

```bash
# Environment variables
SOS_CONTEXT_RERANKER_ENABLED=true       # Enable LLM reranker (default: true)
SOS_CONTEXT_DEEP_ENABLED=true           # Allow auto-escalation (default: true)
SOS_CONTEXT_MAX_TOKENS=3500             # Shared token budget
```

```yaml
# model-config.yaml — new role
context:
  model: gpt-4.1-mini
```

### 8.2 Degradation Chain

```
Full pipeline:
  KB + Memory search → LLM reranker → auto-deep if needed → serialize

Reranker fails (API error, timeout):
  KB + Memory search → interleave by raw_score → serialize
  (No LLM call, still better than independent injection)

Memory system disabled (SOS_MEMORY_ENABLED=false):
  KB search only → skip reranker (single source) → serialize
  (Equivalent to current behavior)

Reranker disabled (SOS_CONTEXT_RERANKER_ENABLED=false):
  KB + Memory search → interleave by raw_score → serialize
  (Independent budgets, similar to current behavior)

Both systems empty:
  Return empty context string + user profile only

Deep escalation disabled (SOS_CONTEXT_DEEP_ENABLED=false):
  Never call researchKnowledgeBases() from context assembler
  (Reranker still works, just no escalation on "insufficient")
```

**Key principle**: The context assembler is a **strict improvement** — never worse than the current system, even under failure conditions. Every degradation path produces output at least as good as the current independent injection.

### 8.3 Reranker Skip Optimization

The LLM reranker exists for *cross-source* reasoning. When there's nothing to cross-rank, skip it:

```
KB results > 0 AND memory results > 0  → run LLM reranker
Only one source has results             → skip reranker, pass through directly
Neither source has results              → return empty context
```

This saves the LLM call on a significant fraction of interactions — especially early in the system's life when memory is sparse, or for users who haven't configured knowledge bases.

---

## 9. Shared Retrieval Primitives

### 9.1 New Directory: `src/server/retrieval/`

```
src/server/retrieval/
├── vectorStore.ts      # Generic LanceDB wrapper
├── ftsStore.ts         # Generic FTS5 wrapper
├── hybridSearch.ts     # Generic RRF fusion (k=60)
├── utils.ts            # distanceToSimilarity, sanitizeFTSQuery, estimateTokens
├── types.ts            # Shared interfaces
└── index.ts
```

KB and Memory become thin adapters over shared primitives. Connections and schemas remain separate.

**Note**: This is Phase 5 (dedup), not Phase 1. It adds no user-facing value and is not a prerequisite for the context assembler.

---

## 10. Worker Memory Context

### 10.1 New Endpoint: `POST /api/worker/context`

```typescript
// Request
{ query: string; owner: string; scopes: string[];
  allowDeep?: boolean; maxTokens?: number; }

// Response
{ context: string; profile: string;
  metadata: { kb_items_used: number; memory_items_used: number;
              was_deep: boolean; duration_ms: number; } }
```

### 10.2 Worker Integration

In `runJob.ts` and `runPlanJob.ts`, replace KB-only context fetching with `api.getUnifiedContext()`. In `claude.ts`, `## Knowledge Base Context` becomes `## Knowledge Context`.

Workers use `allowDeep: false` by default for latency-sensitive job execution. The fast path (search + optional reranker + serialize) is sufficient for worker context.

---

## 11. Prompt Structure Changes

### 11.1 New routing-config.yaml Structure

```yaml
system_prompt: >
  ...
  ## About This User
  {USER_CONTEXT}

  ## Relevant Context
  The following is relevant context from knowledge bases and past interactions.
  Use it naturally — don't mention these systems explicitly.
  {CONTEXT}

  ## Recent Jobs
  {JOBS_CONTEXT}
```

### 11.2 Changes

- `{MEMORY_CONTEXT}` and `{KB_CONTEXT}` replaced by single `{CONTEXT}`
- `{USER_CONTEXT}` remains separate (fixed-cost identity preamble)
- **Backward compatible**: If `{CONTEXT}` not in template, fall back to legacy `{KB_CONTEXT}` + `{MEMORY_CONTEXT}`
- **Remove `kb_research_strategy`** from routing config (replaced by automatic depth)
- **Remove or deprecate `kb_search` action** from routing-config.yaml

### 11.3 Multi-Platform Coverage

All three interaction surfaces (Slack, Discord, web chat) flow through `routeMessage()` in `messageRouter.ts`. The prompt structure change covers all platforms automatically.

---

## 12. Cost & Latency Analysis

### 12.1 Common Case (Sufficient Context)

| Step | LLM Calls | Latency |
|------|-----------|---------|
| Parallel retrieval (KB + Memory) | 0 | ~100ms |
| Gating + LLM reranker | 0-1 | ~0-300ms |
| Serialization | 0 | ~5ms |
| **Total** | **0-1** | **~100-400ms** |

The reranker is skipped when only one source returns results (single-source optimization). With prompt caching, the reranker call is ~200ms.

### 12.2 Deep Escalation (Insufficient Context)

| Step | LLM Calls | Latency |
|------|-----------|---------|
| Parallel retrieval | 0 | ~100ms |
| LLM reranker + sufficiency | 1 | ~300ms |
| Research pipeline (deep) | 2-3 | ~1-2s |
| Serialization | 0 | ~5ms |
| **Total** | **3-4** | **~1.5-2.5s** |

This is comparable to the current `kb_search` action latency (~2-3s), but automatic and includes memory.

### 12.3 Monthly Cost

At 50 interactions/day, ~30% triggering the reranker, ~10% triggering deep:
- Reranker: ~15 calls/day × $0.001 = ~$0.45/month
- Deep escalation: ~5 calls/day × $0.003 = ~$0.45/month
- **Total: ~$1/month**

### 12.4 Prompt Caching

The reranker prompt has a ~200-token stable instruction prefix (system message). With prompt caching:
- First call: full price
- Subsequent calls: ~50% token discount on the instruction portion
- Net effect: ~10-15% total cost reduction, ~50ms latency reduction on cache hits

The prompt should be structured with stable instructions as the system message and variable candidates as the user message to maximize cache hit rate.

---

## 13. Implementation Phases

### Phase 1: Context Assembler + Reranker (Core Value)
Build `src/server/context/` module: assembler, reranker, serializer, normalizer, types, config. Wire into `messageRouter.ts` replacing the three independent calls.

**Files to create**: `src/server/context/*.ts` (6 files)
**Files to modify**: `src/server/slack/messageRouter.ts`, `routing-config.yaml`
**Effort**: 3-4 days. **Highest value change.**

### Phase 2: Adaptive Depth + kb_search Deprecation
Add sufficiency evaluation to the reranker prompt. Add deep escalation path (calls `researchKnowledgeBases()` with follow-up queries). Deprecate `kb_search` from routing-config.yaml.

**Files to modify**: `contextReranker.ts`, `contextAssembler.ts`, `routing-config.yaml`
**Effort**: 2-3 days. **Eliminates the kb_search workaround.**

### Phase 3: Worker Memory Context
New `/api/worker/context` endpoint. Update `apiClient.ts`, `runJob.ts`, `runPlanJob.ts`, `claude.ts`.

**Effort**: 2-3 days. **Closes biggest functional gap.**

### Phase 4: Prompt Unification + Cleanup
Single `{CONTEXT}` placeholder, backward compatibility, remove `kb_research_strategy`, update system prompt structure.

**Effort**: 1-2 days. **Low risk.**

### Phase 5: Shared Retrieval Primitives (Dedup)
Extract `src/server/retrieval/` from duplicate infrastructure. Pure refactor.

**Effort**: 2-3 days. **No user-facing value. Can be deferred.**

### Phase 6: Advanced — Iterative Deep Retrieval
Enable multi-round sufficiency checking: if first deep escalation is still insufficient, generate more follow-up queries for another round. Budget-capped.

**Effort**: 2-3 days. **Future optimization.**

---

## 14. What NOT to Do (Anti-Patterns)

1. **Don't merge MongoDB collections** — different purposes, discriminator queries are worse
2. **Don't merge vector tables** — different schemas, memory evolution needs memory-only search
3. **Don't use heuristic intent classification** — the LLM reranker handles source-weighting naturally
4. **Don't use cross-system RRF** — RRF is for same-search different-method fusion, not heterogeneous stores
5. **Don't add KB→Memory cross-ingestion** — confusing ownership, unified read path gives the benefit
6. **Don't over-engineer the write path** — async fire-and-forget is correct per Anatomy survey
7. **Don't modify research pipeline internals** — call its public API, don't reach into its stages
8. **Don't apply rigid positional templates** — trust the LLM reranker's ordering
9. **Don't force the reranker on single-source results** — skip when there's nothing to cross-rank

---

## 15. Testing Strategy

### Unit Tests
- `context/contextAssembler.test.ts` — Full flow with mocked KB/memory/LLM, gating logic, deep escalation
- `context/contextReranker.test.ts` — Listwise reranking with mocked LLM, sufficiency detection, edge cases
- `context/contextSerializer.test.ts` — Budget enforcement, source tagging, profile preamble
- `context/contextNormalizer.test.ts` — KB → ContextItem, Memory → ContextItem, metadata preservation

### Integration Tests
- End-to-end: KB chunks + memory notes → assembler → verify mixed-source output
- Deep escalation: Thin initial results → reranker says insufficient → research pipeline called → verify merged output
- Single-source optimization: Only KB results → verify reranker skipped
- Worker endpoint: `/api/worker/context` returns unified context
- Backward compat: Old template with `{KB_CONTEXT}` + `{MEMORY_CONTEXT}` still works
- Graceful degradation: Reranker API failure → verify fallback to raw-score interleaving

### Regression
All existing KB, memory, and research pipeline tests must pass unchanged.

---

## 16. Future Extensions

1. **Adaptive retrieval weights** — Track which context items the LLM references (citation detection). Auto-tune reranker behavior over time (MemRL utility scoring).
2. **EverMemOS foresight** — Forward-looking inferences on memory notes with time validity intervals.
3. **Additional context sources** — GitHub sync data, job outcome summaries, procedural memory. Each becomes a new source in the normalizer.
4. **Cross-encoder pre-filter** — For large result sets (>50 candidates), add cross-encoder between retrieval and LLM reranker.
5. **Streaming deep escalation** — When deep mode triggers, stream a "thinking..." indicator to the user while the research pipeline runs.

---

## Appendix A: Research References

| Source | Citation | Key Ideas Used |
|--------|----------|----------------|
| MAGMA | Jiang et al., arXiv:2601.03236, Jan 2026 | Intent-aware routing, adaptive traversal, dual-stream write |
| Zep/Graphiti | Rasmussen et al., arXiv:2501.13956, Jan 2025 | Temporal KG, unified retrieval with reranker |
| EverMemOS | Hu et al., arXiv:2601.02163, Jan 2026 | Reconstructive recollection, sufficiency check |
| Mem0 | Singh & Yadav, arXiv:2504.19413, Apr 2025 | Hybrid vector+graph+KV, unified read path |
| A-MEM | Xu et al., arXiv:2502.12110, NeurIPS 2025 | Zettelkasten notes, memory evolution |
| Anatomy Survey | arXiv:2602.19320, Feb 2026 | Taxonomy, scalability warnings, Pareto analysis |
| RankRAG | Yu et al., NeurIPS 2024 | LLM listwise reranking for heterogeneous sources |
| Lost in the Middle | Liu et al., TACL 2024 | Positional bias (applied with nuance for modern models) |
| CRAG | Yan et al., 2024 | Corrective retrieval, sufficiency evaluation |
| Generative Agents | Park et al., Stanford 2023 | Memory stream, importance scoring, reflection |
| MemRL | Zhang et al., arXiv:2601.03192 | Utility Q-values, value-aware retrieval |
| Memento 2 | arXiv:2512.22716, Dec 2025 | Stateful reflective decision process |

## Appendix B: Codebase References

| Component | File | Relevance |
|-----------|------|-----------|
| KB search | `src/server/kb/kbService.ts` | `searchKnowledgeBases()`, `twoStageSearch()`, `researchKnowledgeBases()` |
| KB hybrid search | `src/server/kb/hybridSearch.ts` | RRF fusion pattern |
| KB vector store | `src/server/kb/vectorStore.ts` | LanceDB wrapper pattern |
| KB FTS store | `src/server/kb/ftsStore.ts` | FTS5 wrapper pattern |
| KB research pipeline | `src/server/kb/research/pipeline.ts` | Multi-stage RAG (called by context assembler in deep mode) |
| KB evaluator | `src/server/kb/research/stages/evaluator.ts` | Existing LLM evaluation pattern (NOT modified) |
| KB synthesizer | `src/server/kb/research/stages/synthesizer.ts` | Existing serialization pattern (NOT modified) |
| Research executor | `src/server/routing/researchExecutor.ts` | Current kb_search implementation (to be deprecated) |
| Memory search | `src/server/memory/memorySearch.ts` | `searchMemories()` with composite scoring |
| Memory context | `src/server/memory/contextBuilder.ts` | `buildMemoryContext()`, `buildUserContext()` |
| Memory vector store | `src/server/memory/memoryVectorStore.ts` | LanceDB wrapper (duplicate of KB) |
| Memory FTS store | `src/server/memory/memoryFtsStore.ts` | FTS5 wrapper (duplicate of KB) |
| Memory service | `src/server/memory/memoryService.ts` | `getMemoryContext()` entry point |
| Routing assembly | `src/server/slack/messageRouter.ts` | `routeMessage()`, `buildKBContext()`, `basicKBSearch()` |
| Routing config | `routing-config.yaml` | System prompt, kb_search action (to be deprecated) |
| Worker job | `src/worker/executor/runJob.ts` | KB-only context fetching (to be unified) |
| Worker plan | `src/worker/executor/runPlanJob.ts` | KB-only context fetching (to be unified) |
| Worker prompt | `src/worker/executor/claude.ts` | `buildContextSections()` — KB injection point |
| Worker API | `src/worker/apiClient.ts` | `searchKnowledgeBases()`, `researchKnowledgeBases()` |
| Embeddings | `src/server/kb/embeddings.ts` | Shared singleton provider |
| KB types | `src/shared/kbTypes.ts` | `KBSearchResult`, `KBScope`, etc. |
| Memory types | `src/shared/memoryTypes.ts` | `MemoryNote`, `MemorySearchResult`, etc. |
| Slack events | `src/server/slack/eventHandlers.ts` | Calls `routeMessage()` |
| Discord events | `src/server/discord/eventHandlers.ts` | Calls `routeMessage()` |
| Web chat | `src/server/chat/chatRoutes.ts` | Calls `routeMessage()` |
