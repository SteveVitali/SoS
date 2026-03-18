# Persistent Agent Memory System — Design Specification

> **Status**: Implemented (Phases 1–7 complete). See `src/server/memory/` and `src/shared/memoryTypes.ts`.
> **Authors**: Steve Vitali + Cascade AI
> **Date**: March 2026

---

## 1. Motivation & Context

### 1.1 The Problem

Son of Steve is a local-first coding agent orchestrator with a rich interaction surface: conversational chat (Slack, Discord, web UI), knowledge retrieval and research, GitHub analytics, job creation and management, image generation, and custom actions. It already has excellent static knowledge infrastructure — LanceDB vector search, SQLite FTS5 keyword search, hybrid retrieval via RRF, RAPTOR tree hierarchical indexing, and a multi-strategy research pipeline (simple/deep/agent).

**What's missing is evolving memory.** Today, every interaction starts with the same blank slate. The system prompt gets `{KB_CONTEXT}` from static knowledge bases and `{JOBS_CONTEXT}` from recent jobs, but Steve never learns from:

- Past conversations (corrections, preferences, domain knowledge shared by users)
- Research queries (what topics come up, what KBs are useful for what, what strategies work)
- Job outcomes (what approaches succeeded/failed, what CI issues recur, what repos are tricky)
- User patterns (communication style, common repos, expertise areas)
- Interaction patterns (what types of questions get asked, what follow-ups are common)

The raw material for all of this learning is already in MongoDB — conversations, job event logs, research sessions, GitHub data — but it's never extracted, distilled, or fed back into future interactions.

### 1.2 The Goal

Build a persistent, evolving memory system that:

1. **Learns from every interaction type** — chat, research, jobs, GitHub queries, etc.
2. **Extracts and curates facts** — preferences, corrections, domain knowledge, patterns
3. **Self-organizes** — memories link to each other and evolve as new information arrives
4. **Provides feedback-aware learning** — implicit and explicit signals from user behavior inform what's valuable
5. **Injects relevant context** — retrieved memories augment the system prompt alongside existing KB context
6. **Consolidates over time** — periodic reflection distills episodic experiences into higher-level knowledge
7. **Operates asynchronously** — memory writing never blocks the interaction hot path

### 1.3 Design Principles

- **Interaction-agnostic**: The unit of learning is any exchange between a user and Steve, not specifically a job. Chat, research, GitHub queries, and job creation are all equal sources of learning.
- **Async writes, sync reads**: Memory extraction and evolution happen post-hoc in background pipelines. Memory retrieval happens synchronously during context assembly, using the same fast infrastructure as KB search.
- **Additive to existing systems**: The memory system layers on top of existing KB, routing, and conversation infrastructure. It does not replace or modify existing functionality.
- **Incremental complexity**: Designed in tiers so that basic fact extraction provides value immediately, with self-organization, reflection, and RL-style utility scoring layered on later.
- **Local-first**: All memory storage uses the existing MongoDB + LanceDB infrastructure. No external services required.

---

## 2. Research Foundation

This design synthesizes ideas from the following frontier research:

| Source | Paper/Project | Key Ideas Adopted | Where Used |
|---|---|---|---|
| **Mem0** (Apr 2025) | arXiv:2504.19413 | Two-phase extract+curate pipeline; ADD/UPDATE/DELETE/NOOP operations; graph variant for entity relationships | Pipeline B (Fact Extraction) |
| **A-MEM** (NeurIPS 2025) | arXiv:2502.12110 | Zettelkasten note structure; LLM-generated keywords/tags/context; link generation; memory evolution | MemoryNote schema, Pipeline E |
| **MemRL** (Jan 2026) | arXiv:2601.03192 | Intent-Experience-Utility triplets; value-aware retrieval; RL on memory utility | `access_count`/`importance` fields; future utility scoring |
| **Memento 2** (Dec 2025) | arXiv:2512.22716 | Stateful Reflective Decision Process; reflection as learning mechanism | Pipeline D (Reflection) |
| **EverMemOS** (Jan 2026) | arXiv:2601.02163 | Engram lifecycle (formation→consolidation→recollection); MemCells→MemScenes | Three-layer architecture (episodes→facts→reflections) |
| **Graphiti/Zep** (2025) | Temporal KG paper | Bi-temporal model; conflict detection with temporal invalidation | `valid_from`/`invalidated_at` fields |
| **Generative Agents** (Stanford 2023) | arXiv:2304.03442 | Memory stream with importance scoring; periodic reflection | Retrieval scoring (recency+importance+relevance) |
| **Anthropic Harness** (2025) | anthropic.com/engineering | Cross-session state via progress files | User profile document |

---

## 3. System Overview

### 3.1 Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Memory System                                     │
│                                                                     │
│  READ PATH (sync)                  WRITE PATH (async)               │
│  ┌──────────────────────┐         ┌──────────────────────────────┐  │
│  │ 1. Embed user msg    │         │ A. Episode Recording (0 LLM) │  │
│  │ 2. Hybrid search     │         │ B. Fact Extraction (1-2 LLM) │  │
│  │    memories           │         │ C. Signal Collection (0 LLM) │  │
│  │ 3. Fetch user profile │         │ D. Reflection (periodic, N)  │  │
│  │ 4. Format context     │         │ E. Memory Evolution (0-K)    │  │
│  │ 5. Inject into prompt │         └──────────────────────────────┘  │
│  └──────────────────────┘                                           │
│                                                                     │
│  STORAGE                                                            │
│  ├── MongoDB: memories, interaction_episodes                        │
│  ├── LanceDB: mem_{owner} tables (vectors)                         │
│  └── SQLite FTS5: mem_fts_{owner} (keywords)                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 File Organization

```
src/server/memory/
├── memoryTypes.ts            # TypeScript interfaces
├── memoryRepo.ts             # MongoDB CRUD for memories
├── episodeRepo.ts            # MongoDB CRUD for episodes
├── memoryVectorStore.ts      # LanceDB wrapper for memory embeddings
├── memoryFtsStore.ts         # SQLite FTS5 wrapper for memory keywords
├── memorySearch.ts           # Hybrid search (vector + keyword + scoring)
├── contextBuilder.ts         # Build {MEMORY_CONTEXT} and {USER_CONTEXT}
├── pipelines/
│   ├── episodeRecorder.ts    # Pipeline A
│   ├── factExtractor.ts      # Pipeline B
│   ├── signalCollector.ts    # Pipeline C
│   ├── reflectionEngine.ts   # Pipeline D
│   └── memoryEvolver.ts      # Pipeline E
├── prompts.ts                # LLM prompt templates
├── memoryConfig.ts           # Configuration
├── memoryService.ts          # Orchestration + init/shutdown
├── memoryRoutes.ts           # Express routes for UI
└── index.ts                  # Barrel export

src/shared/memoryTypes.ts     # Types shared with UI
```

---

## 4. Data Model

### 4.1 MongoDB: `memories` Collection

```typescript
interface MemoryNote {
  _id?: any;
  memory_id: string;              // UUID v4
  owner: string;                  // User ID or "global"
  memory_type: "fact" | "reflection" | "user_profile";

  // Content (A-MEM note structure)
  content: string;                // The memory itself
  context: string;                // LLM-generated contextual description
  keywords: string[];             // LLM-generated keywords
  tags: string[];                 // LLM-generated tags

  // Provenance
  source_episodes: string[];      // episode IDs that contributed
  source_type: InteractionSource; // "slack" | "discord" | "web_chat" | "system"
  created_at: Date;
  updated_at: Date;

  // Temporal validity (Graphiti-inspired)
  valid_from: Date;
  invalidated_at?: Date;          // null = still valid
  invalidated_by?: string;        // memory_id of superseding memory

  // Links (A-MEM-inspired)
  linked_memory_ids: string[];
  link_reasons: string[];

  // Scoring & Utility
  access_count: number;           // Times retrieved into context
  last_accessed_at?: Date;
  importance: number;             // 0.0–1.0
  confidence: number;             // 0.0–1.0

  // Embedding reference
  embedding_text: string;         // Text that was embedded (content+context+keywords)
}
```

**Indexes**:
- `{ memory_id: 1 }` — unique
- `{ owner: 1, memory_type: 1, updated_at: -1 }`
- `{ owner: 1, invalidated_at: 1 }`
- `{ owner: 1, tags: 1 }`
- `{ source_episodes: 1 }`

### 4.2 MongoDB: `interaction_episodes` Collection

```typescript
interface InteractionEpisode {
  _id?: any;
  episode_id: string;             // UUID v4
  owner: string;

  // Source
  source: InteractionSource;      // "slack" | "discord" | "web_chat"
  source_ref: {
    conversation_id?: string;
    thread_ts?: string;
    channel_id?: string;
    thread_id?: string;
    message_id?: string;
  };

  // Interaction content
  user_message: string;
  routed_action: string;          // "chat", "create_job", "kb_search", etc.
  action_args_summary: string;    // ≤200 chars, stripped of sensitive data
  response_summary: string;       // ≤500 chars

  // Downstream effects
  task_id?: string;
  research_session_id?: string;

  // Outcome signals (populated by Pipeline C)
  signals: OutcomeSignal[];

  // Timestamps
  timestamp: Date;
  signal_collected_at?: Date;

  // Processing state
  extraction_status: "pending" | "extracted" | "skipped";
  extracted_memory_ids: string[];
}

type InteractionSource = "slack" | "discord" | "web_chat" | "system";

interface OutcomeSignal {
  signal_type: SignalType;
  detected_at: Date;
  details?: string;
  strength: number;               // -1.0 to 1.0
}

type SignalType =
  | "continuation"        // +0.2
  | "gratitude"           // +0.8
  | "correction"          // -0.6
  | "rephrase"            // -0.4
  | "follow_up_deeper"    // +0.4
  | "topic_change"        // 0.0
  | "no_response"         // -0.1
  | "job_completed"       // +1.0
  | "job_failed"          // -0.5
  | "explicit_positive"   // +0.9
  | "explicit_negative";  // -0.9
```

**Indexes**:
- `{ episode_id: 1 }` — unique
- `{ owner: 1, timestamp: -1 }`
- `{ owner: 1, extraction_status: 1 }`
- `{ task_id: 1 }`

### 4.3 LanceDB: `mem_{owner}` Table

```typescript
interface MemoryVectorRecord {
  id: string;           // memory_id
  owner: string;
  content: string;      // embedding_text
  memory_type: string;
  vector: number[];
  tags: string;         // JSON-encoded string[]
  importance: number;
  created_at: string;
  updated_at: string;
}
```

### 4.4 SQLite FTS5: `mem_fts_{owner}` Table

```typescript
interface MemoryFTSRecord {
  memory_id: string;
  owner: string;
  content: string;
  keywords: string;     // space-separated
  tags: string;         // space-separated
  memory_type: string;
}
```

---

## 5. Shared Types

File: `src/shared/memoryTypes.ts` — exported types used by server and UI.

```typescript
export type MemoryType = "fact" | "reflection" | "user_profile";
export type InteractionSource = "slack" | "discord" | "web_chat" | "system";

// Re-export MemoryNote, InteractionEpisode, OutcomeSignal, SignalType
// (defined in §4 above)

export interface MemorySearchRequest {
  query: string;
  owner?: string;
  memory_types?: MemoryType[];
  tags?: string[];
  limit?: number;
  min_score?: number;
  include_invalidated?: boolean;
}

export interface MemorySearchResult {
  memory: MemoryNote;
  score: number;              // Combined
  similarity_score: number;
  keyword_score?: number;
  recency_score: number;
  importance_score: number;
  access_score: number;
}

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  invalidated_memories: number;
  total_episodes: number;
  memories_by_type: Record<MemoryType, number>;
  last_extraction_at?: Date;
  last_reflection_at?: Date;
}

export interface MemoryConfig {
  enabled: boolean;

  // Extraction
  extraction_model: string;
  extraction_min_turns: number;           // default: 1
  extraction_skip_actions: string[];      // default: ["no_op"]
  extraction_max_facts_per_call: number;  // default: 5

  // Retrieval
  retrieval_max_memories: number;         // default: 8
  retrieval_max_tokens: number;           // default: 1500
  retrieval_min_score: number;            // default: 0.3
  retrieval_recency_halflife_days: number; // default: 30

  // Scoring weights (sum to 1.0)
  weight_similarity: number;              // default: 0.45
  weight_recency: number;                 // default: 0.20
  weight_importance: number;              // default: 0.20
  weight_access: number;                  // default: 0.15

  // Evolution (A-MEM)
  evolution_enabled: boolean;
  evolution_max_neighbors: number;        // default: 5
  evolution_link_threshold: number;       // default: 0.6

  // Reflection
  reflection_enabled: boolean;
  reflection_interval_hours: number;      // default: 24
  reflection_min_episodes: number;        // default: 10

  // Signals
  signal_delay_ms: number;               // default: 300000 (5 min)
  signal_no_response_timeout_ms: number; // default: 1800000 (30 min)
}
```

---

## 6. Write Path — Async Pipelines

All write pipelines are fire-and-forget from the hot path. They are triggered by `memoryService.ts` after each interaction completes.

### 6.1 Pipeline A: Episode Recording

**File**: `src/server/memory/pipelines/episodeRecorder.ts`

**Trigger**: After every interaction response is sent (Slack, Discord, and web chat handlers).

**Operations**:
1. Construct an `InteractionEpisode` document
2. Truncate `response_summary` to ≤500 chars, `action_args_summary` to ≤200 chars
3. Insert into MongoDB `interaction_episodes`
4. Set `extraction_status` to `"pending"`

**LLM cost**: Zero.

**Function signature**:
```typescript
export async function recordEpisode(params: {
  owner: string;
  source: InteractionSource;
  sourceRef: InteractionEpisode["source_ref"];
  userMessage: string;
  routedAction: string;
  actionArgs: Record<string, unknown>;
  responseSummary: string;
  taskId?: string;
  researchSessionId?: string;
}): Promise<string>  // Returns episode_id
```

### 6.2 Pipeline B: Fact Extraction (Mem0-style)

**File**: `src/server/memory/pipelines/factExtractor.ts`

**Trigger**: After Pipeline A, if the episode passes the extraction filter.

**Extraction filter** (skip if any of these are true):
- `routed_action` is in `extraction_skip_actions` (default: `["no_op"]`)
- `user_message` is < 10 characters
- Action is purely mechanical (`job_status`, `cancel_job`, `retry_job`, `list_jobs`) AND no correction signal detected

**Always extract from**:
- Conversations with ≥ `extraction_min_turns` messages
- Episodes with detected correction or gratitude signals
- `chat`, `kb_search`, `create_job`, `plan_job`, `github` actions (information-rich)

**Operations**:
1. Fetch episode + up to 5 prior episodes in same conversation/thread (for context)
2. Call LLM with extraction prompt → structured JSON with candidate facts
3. For each candidate fact:
   a. Embed the fact text
   b. Search existing memories for top-5 similar (similarity > 0.5)
   c. Call LLM with curation prompt → decides ADD / UPDATE / DELETE / NOOP
   d. Execute the operation:
      - **ADD**: Create `MemoryNote`, embed in LanceDB + FTS5, trigger Pipeline E
      - **UPDATE**: Modify existing note's content/context/keywords/tags, re-embed, trigger Pipeline E
      - **DELETE**: Set `invalidated_at` on existing memory (never physically delete)
      - **NOOP**: Skip
4. Update episode's `extraction_status` → `"extracted"`, record `extracted_memory_ids`

**Batching optimization**: Combine extraction and curation into a single LLM call that outputs all candidates with their operations. Reduces to 1–2 LLM calls per episode.

**LLM cost**: 1–2 calls per episode using a fast/cheap model (e.g., `gpt-4.1-mini`).

**Function signature**:
```typescript
export async function extractFactsFromEpisode(
  episodeId: string,
  config: MemoryConfig,
): Promise<{
  extracted: number;
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
}>
```

### 6.3 Pipeline C: Signal Collection

**File**: `src/server/memory/pipelines/signalCollector.ts`

**Trigger**: Timer-based — runs every 2 minutes, batch-processes episodes past the signal delay threshold.

**Operations** for each pending episode:
1. Look at subsequent messages in the same conversation/thread
2. Detect signals via pattern matching and embedding similarity:

| Signal | Detection Method | Strength |
|---|---|---|
| `continuation` | Next message exists from same user | +0.2 |
| `gratitude` | Regex: `/\b(thanks|thank you|perfect|exactly|great|awesome)\b/i` | +0.8 |
| `correction` | Regex: `/\b(no|wrong|incorrect|that's not|actually|not what I meant)\b/i` | -0.6 |
| `rephrase` | Next user msg has embedding similarity > 0.8 to original | -0.4 |
| `follow_up_deeper` | Next msg similarity 0.5–0.8 and longer than original | +0.4 |
| `topic_change` | Next msg similarity < 0.3 | 0.0 |
| `no_response` | No follow-up within `signal_no_response_timeout_ms` | -0.1 |
| `job_completed` | Linked job status = DONE | +1.0 |
| `job_failed` | Linked job status = FAILED | -0.5 |

3. Update episode's `signals` array and `signal_collected_at`

**LLM cost**: Zero. Pure pattern matching + embedding comparison + MongoDB lookups.

**Function signature**:
```typescript
export async function collectSignals(config: MemoryConfig): Promise<{
  episodes_processed: number;
  signals_detected: number;
}>
```

### 6.4 Pipeline D: Reflection & Consolidation

**File**: `src/server/memory/pipelines/reflectionEngine.ts`

**Trigger**: Periodic — every `reflection_interval_hours` (default 24h), or manual API trigger.

**Preconditions**: ≥ `reflection_min_episodes` new episodes since last reflection.

**Operations**:
1. Fetch recent episodes with their signals since last reflection
2. Cluster by topic using embedding similarity (agglomerative, threshold-based)
3. For each cluster of ≥ 3 episodes:
   a. Build reflection prompt with episodes, signals, and related existing memories
   b. LLM generates 1–3 reflections (higher-level insights)
   c. Store as `MemoryNote` with `memory_type: "reflection"`
   d. Link to source episodes and related factual memories
4. Synthesize/update user profile:
   a. Fetch all active factual memories + new reflections
   b. LLM generates concise profile summary
   c. Upsert the `user_profile` memory note (one per owner)

**LLM cost**: 1 call per cluster + 1 for profile. Typical day: 5–7 LLM calls.

**Function signature**:
```typescript
export async function runReflection(
  owner: string,
  config: MemoryConfig,
): Promise<{
  episodes_reviewed: number;
  clusters_found: number;
  reflections_created: number;
  profile_updated: boolean;
}>
```

### 6.5 Pipeline E: Memory Evolution (A-MEM style)

**File**: `src/server/memory/pipelines/memoryEvolver.ts`

**Trigger**: Called by Pipeline B on ADD or UPDATE operations.

**Operations**:
1. For affected memory `m_new`:
   a. Find top-K nearest memories (K = `evolution_max_neighbors`)
   b. Filter by `evolution_link_threshold` (default 0.6)
   c. For each qualifying neighbor:
      - Create bidirectional link if not already linked
      - LLM decides if neighbor's context/keywords/tags should evolve
      - If yes: update neighbor, re-embed
2. Update `m_new.linked_memory_ids` and `m_new.link_reasons`

**Batching**: Package all neighbors into one LLM call returning structured JSON.

**LLM cost**: 0–1 calls (batched). Skip LLM if similarity > 0.9 (near-duplicate — link only).

**Function signature**:
```typescript
export async function evolveMemory(
  memoryId: string,
  config: MemoryConfig,
): Promise<{
  links_created: number;
  neighbors_evolved: number;
}>
```

---

## 7. Read Path — Context Assembly

### 7.1 Memory Search

**File**: `src/server/memory/memorySearch.ts`

Hybrid search combining vector similarity, keyword matching, recency, importance, and access frequency. Same pattern as `src/server/kb/hybridSearch.ts`.

**Algorithm**:
1. Embed query text (reuse existing `EmbeddingProvider`)
2. Vector search in LanceDB `mem_{owner}` → top-N candidates
3. Keyword search in FTS5 `mem_fts_{owner}` → top-N candidates
4. Merge via RRF (k=60, same as KB hybrid search)
5. Compute composite score per candidate:
   ```
   score = w_similarity * similarity_score
         + w_recency   * exp(-ln(2) * days_since_update / halflife_days)
         + w_importance * importance
         + w_access     * min(1.0, log2(1 + access_count) / 5)
   ```
6. Filter: exclude invalidated memories, apply `min_score`
7. Sort by composite score descending, return top `retrieval_max_memories`
8. Async: increment `access_count` and `last_accessed_at` on returned memories

**Latency target**: < 200ms (vector + FTS5 search, same infra as KB search).

**Function signature**:
```typescript
export async function searchMemories(
  query: string,
  owner: string,
  config: MemoryConfig,
  options?: {
    memory_types?: MemoryType[];
    tags?: string[];
    limit?: number;
    min_score?: number;
  },
): Promise<MemorySearchResult[]>
```

### 7.2 Context Builder

**File**: `src/server/memory/contextBuilder.ts`

**`buildMemoryContext(userMessage, owner, config)`**:
1. Call `searchMemories()`
2. Format as:
   ```
   - [fact, learned Mar 15] The user prefers TypeScript strict mode
   - [reflection, from 12 interactions] Auth questions usually mean the OAuth flow
   ```
3. Truncate to `retrieval_max_tokens`

**`buildUserContext(owner)`**:
1. Direct MongoDB lookup for `user_profile` memory note
2. Format as the profile content string
3. Return empty string if no profile exists

**Function signatures**:
```typescript
export async function buildMemoryContext(
  userMessage: string,
  owner: string,
  config: MemoryConfig,
): Promise<string>

export async function buildUserContext(owner: string): Promise<string>
```

---

## 8. LLM Prompt Templates

**File**: `src/server/memory/prompts.ts`

### 8.1 Fact Extraction Prompt

```
You are a memory extraction system. Analyze the following interaction and extract
important facts, preferences, corrections, or domain knowledge worth remembering.

## Interaction
User: {{user_message}}
Action taken: {{routed_action}}
Response summary: {{response_summary}}
{{#if prior_context}}
## Recent conversation context
{{prior_context}}
{{/if}}

## Instructions
Extract 0–{{max_facts}} distinct facts. For each:
- State as a clear, standalone statement
- Assign importance (0.0–1.0): chit-chat=0.1, preferences=0.5, corrections=0.8, critical knowledge=0.9
- Generate 2–5 keywords and 1–3 tags (lowercase_snake_case)

Return JSON: { "facts": [{ "content": "...", "importance": 0.6, "keywords": [...], "tags": [...] }] }
If nothing worth remembering: { "facts": [] }
```

### 8.2 Memory Curation Prompt

```
You are a memory curation system. A new fact has been extracted. Compare against
existing similar memories and decide the operation.

## New fact
{{new_fact_content}}

## Existing similar memories
{{#each similar_memories}}
[{{memory_id}}] {{content}} (learned: {{created_at}}, importance: {{importance}})
{{/each}}

## Operations
- ADD: Genuinely new information.
- UPDATE <memory_id>: Refines or extends an existing memory. Provide updated content.
- DELETE <memory_id>: Contradicts/supersedes existing. Old memory will be invalidated.
- NOOP: Already known.

Return JSON: { "operation": "ADD"|"UPDATE"|"DELETE"|"NOOP", "target_memory_id": null|"<id>",
  "updated_content": null|"new content", "reason": "brief explanation" }
```

### 8.3 Combined Extraction + Curation Prompt (Batched)

For efficiency, extraction and curation can be combined into one call:

```
You are a memory system. Analyze this interaction, extract facts, and for each,
compare against existing memories to decide the operation.

## Interaction
User: {{user_message}}
Action: {{routed_action}}
Response: {{response_summary}}

## Existing memories (potentially related)
{{#each existing_memories}}
[{{memory_id}}] {{content}} (importance: {{importance}})
{{/each}}

## Instructions
Extract 0–{{max_facts}} facts. For each, decide: ADD (new), UPDATE <id> (refine existing),
DELETE <id> (contradicts existing), or NOOP (already known).

Return JSON:
{ "operations": [{
    "content": "the fact",
    "importance": 0.6,
    "keywords": [...],
    "tags": [...],
    "operation": "ADD"|"UPDATE"|"DELETE"|"NOOP",
    "target_memory_id": null|"<id>",
    "updated_content": null|"...",
    "reason": "..."
}]}
```

### 8.4 Memory Evolution Prompt

```
A memory was just created/updated. Determine if neighboring memories should evolve.

## New/Updated memory
{{new_memory_content}}
Keywords: {{keywords}}, Tags: {{tags}}

## Neighbors
{{#each neighbors}}
[{{memory_id}}] {{content}} | Context: {{context}} | Keywords: {{keywords}}
{{/each}}

For each neighbor: should a link be created? Should its context/keywords/tags update?

Return JSON: { "decisions": [{ "memory_id": "<id>", "create_link": bool,
  "link_reason": "...", "update_context": null|"...",
  "update_keywords": null|[...], "update_tags": null|[...] }] }
```

### 8.5 Reflection Prompt

```
Review this cluster of recent interactions. Identify patterns and higher-level insights.

## Cluster ({{cluster_size}} episodes, topic: {{topic_summary}})
{{#each episodes}}
- [{{timestamp}}] User: {{user_message}} → {{routed_action}} | Signals: {{signals_summary}}
{{/each}}

## Related existing memories
{{#each related_memories}}
- [{{memory_type}}] {{content}}
{{/each}}

Generate 1–3 reflections — higher-level insights, NOT restatements. Focus on:
- Patterns in what the user asks about
- What approaches work well vs. poorly
- Recurring themes or knowledge gaps

Return JSON: { "reflections": [{ "content": "...", "importance": 0.7,
  "keywords": [...], "tags": [...] }] }
```

### 8.6 User Profile Synthesis Prompt

```
Synthesize a user profile from accumulated memories.

## Active memories ({{memory_count}} total)
{{#each memories}}
- [{{memory_type}}, imp={{importance}}] {{content}}
{{/each}}

Write a concise profile (200–400 words) covering: preferences, expertise areas,
common repos/projects, interaction patterns, notable corrections.
Write in third person. Be factual — do not speculate.
```

---

## 9. Configuration

### 9.1 Environment Variables

Added to `src/server/config.ts` and `.env.example`:

```bash
# ─── Memory System ─────────────────────────────────────────────
SOS_MEMORY_ENABLED=true                    # Enable/disable memory system
SOS_MEMORY_MODEL=gpt-4.1-mini             # LLM for extraction/curation/reflection
SOS_MEMORY_RETRIEVAL_MAX_MEMORIES=8        # Max memories in {MEMORY_CONTEXT}
SOS_MEMORY_RETRIEVAL_MAX_TOKENS=1500       # Token budget for {MEMORY_CONTEXT}
SOS_MEMORY_REFLECTION_INTERVAL_HOURS=24    # Reflection pipeline interval
SOS_MEMORY_SIGNAL_DELAY_MS=300000          # Signal collection delay (5 min)
```

### 9.2 Model Config Integration

New role in `model-config.yaml`:

```yaml
memory:
  model: gpt-4.1-mini
```

Read via existing `getModelForRole("memory")` in `src/shared/modelConfig.ts`.

### 9.3 Routing Config Integration

New placeholders in `routing-config.yaml` system prompt:

```yaml
system_prompt: >
  ...existing...

  ## Memory Context
  The following is relevant context from past interactions and learned knowledge.
  Use it naturally — don't mention the memory system explicitly.
  {MEMORY_CONTEXT}

  ## User Profile
  {USER_CONTEXT}

  ## Knowledge Base Context
  {KB_CONTEXT}

  ## Recent Jobs Context
  {JOBS_CONTEXT}
```

---

## 10. Integration Points — Detailed Change List

### 10.1 `src/server/slack/eventHandlers.ts`

In `createAppMentionHandler()`, after `executeCommand()` returns:

```typescript
// After: const result = await executeCommand(action, { ...ctx, attachments, ... });

import { onInteractionComplete } from "../memory/index.js";
onInteractionComplete({
  owner: config.slackJobOwner,
  source: "slack",
  sourceRef: { channel_id: event.channel, thread_ts: threadTs },
  userMessage: cleanText,
  routedAction: action.command,
  actionArgs: action.args,
  responseSummary: result.reply.slice(0, 500),
  taskId: result.taskId,
}).catch((err) => log.warn("Memory episode recording failed", { error: err.message }));
```

### 10.2 `src/server/discord/eventHandlers.ts`

Same pattern in `createDiscordMentionHandler()`:

```typescript
onInteractionComplete({
  owner: config.discordJobOwner,
  source: "discord",
  sourceRef: {
    channel_id: event.channelId,
    thread_id: event.threadId,
    message_id: event.messageId,
  },
  userMessage: cleanText,
  routedAction: action.command,
  actionArgs: action.args,
  responseSummary: result.reply.slice(0, 500),
  taskId: result.taskId,
}).catch((err) => log.warn("Memory episode recording failed", { error: err.message }));
```

### 10.3 `src/server/chat/chatRoutes.ts`

In `POST /:id/messages`, after assistant message is appended:

```typescript
onInteractionComplete({
  owner: config.slackJobOwner,
  source: "web_chat",
  sourceRef: { conversation_id: conversation.conversation_id },
  userMessage: text.trim(),
  routedAction: action.command,
  actionArgs: action.args,
  responseSummary: slackToMarkdown(result.reply).slice(0, 500),
  taskId: result.taskId,
}).catch((err) => log.warn("Memory episode recording failed", { error: err.message }));
```

### 10.4 `src/server/slack/messageRouter.ts`

Modify `routeMessage()` to build memory context in parallel with existing calls:

```typescript
// BEFORE (existing):
const jobsContext = await buildJobsContext();
const kbContext = await buildKBContext(userMessage, ["chat", "all"]);

// AFTER (parallel, with graceful fallback):
import { getMemoryContext } from "../memory/index.js";

const [jobsContext, kbContext, memoryResult] = await Promise.all([
  buildJobsContext(),
  buildKBContext(userMessage, ["chat", "all"]),
  getMemoryContext(userMessage, slackUserId).catch(() => ({
    memoryContext: "",
    userContext: "",
  })),
]);

// Then in system prompt assembly:
systemPrompt = systemPrompt.replace("{MEMORY_CONTEXT}", memoryResult.memoryContext);
systemPrompt = systemPrompt.replace("{USER_CONTEXT}", memoryResult.userContext);
```

### 10.5 `src/server/mongo.ts`

Add memory index initialization in `connectMongo()`:

```typescript
try {
  const { ensureMemoryIndexes } = await import("./memory/index.js");
  await ensureMemoryIndexes();
} catch (err: unknown) {
  log.warn("Failed to ensure memory indexes (non-fatal)", {
    error: (err as Error).message,
  });
}
```

### 10.6 `src/server/index.ts`

**Startup** — after KB initialization, before Express server start:

```typescript
try {
  const { initMemorySystem } = await import("./memory/index.js");
  await initMemorySystem(config);
  log.info("Memory system initialized");
} catch (err: unknown) {
  log.warn("Failed to initialize memory system (non-fatal)", {
    error: (err as Error).message,
  });
}
```

**Shutdown** — in the existing graceful shutdown handler:

```typescript
try {
  const { shutdownMemorySystem } = await import("./memory/index.js");
  shutdownMemorySystem();
} catch { /* best effort */ }
```

### 10.7 `src/server/config.ts`

Add memory config fields to `loadServerConfig()`:

```typescript
memoryEnabled: optional("SOS_MEMORY_ENABLED", "true") === "true",
memoryModel: process.env.SOS_MEMORY_MODEL || "",
memoryRetrievalMaxMemories: optionalInt("SOS_MEMORY_RETRIEVAL_MAX_MEMORIES", 8),
memoryRetrievalMaxTokens: optionalInt("SOS_MEMORY_RETRIEVAL_MAX_TOKENS", 1500),
memoryReflectionIntervalHours: optionalInt("SOS_MEMORY_REFLECTION_INTERVAL_HOURS", 24),
memorySignalDelayMs: optionalInt("SOS_MEMORY_SIGNAL_DELAY_MS", 300000),
```

### 10.8 `src/shared/modelConfig.ts`

Add `"memory"` to the `ModelRole` type and `MODEL_ROLE_DEFAULTS`:

```typescript
// In MODEL_ROLE_DEFAULTS:
memory: { model: "gpt-4.1-mini", source: "default" },
```

### 10.9 `routing-config.yaml`

Add `{MEMORY_CONTEXT}` and `{USER_CONTEXT}` placeholders to the system prompt. These are added **before** `{KB_CONTEXT}` so memory context appears first (more personal/relevant), with KB context providing background knowledge.

### 10.10 `.env.example`

Add documented memory environment variables (see §9.1).

### 10.11 `src/server/api/router.ts`

Mount memory routes:

```typescript
import { createMemoryRoutes } from "../memory/memoryRoutes.js";
// In createRouter():
router.use("/api/web/memory", authMiddleware, createMemoryRoutes(config));
```

---

## 11. HTTP API Surface

**File**: `src/server/memory/memoryRoutes.ts`

All routes under `/api/web/memory/`, authenticated via `SOS_INTERNAL_API_TOKEN`.

```
GET  /api/web/memory/stats
     → MemoryStats (total counts, breakdowns, timestamps)

GET  /api/web/memory/memories?type=fact|reflection&limit=50&offset=0&tag=<tag>
     → { memories: MemoryNote[], total: number }

GET  /api/web/memory/memories/:memory_id
     → { memory: MemoryNote, linked: MemoryNote[] }

POST /api/web/memory/search
     Body: MemorySearchRequest
     → { results: MemorySearchResult[] }

POST /api/web/memory/reflect
     → { result: ReflectionResult } (triggers Pipeline D manually)

DELETE /api/web/memory/memories/:memory_id
     → { ok: true } (sets invalidated_at, does not physically delete)

PUT  /api/web/memory/memories/:memory_id
     Body: { content?: string, importance?: number, tags?: string[] }
     → { memory: MemoryNote } (manual correction)

GET  /api/web/memory/profile
     → { profile: MemoryNote | null }

GET  /api/web/memory/episodes?limit=50&offset=0&action=<routed_action>
     → { episodes: InteractionEpisode[], total: number }

GET  /api/web/memory/episodes/:episode_id
     → { episode: InteractionEpisode, memories: MemoryNote[] }

GET  /api/web/memory/config
     → { config: MemoryConfig }

PUT  /api/web/memory/config
     Body: Partial<MemoryConfig>
     → { config: MemoryConfig }
```

---

## 12. Implementation Phases

This is a complex multi-stage project. Each phase is designed to be independently deployable and testable.

### Phase 1: Foundation — Episode Recording + Memory Storage + Basic Retrieval

**Goal**: Instrument all interaction paths to record episodes, set up storage infrastructure, inject empty `{MEMORY_CONTEXT}` placeholder.

**Files to create**:
- `src/shared/memoryTypes.ts` — all shared type definitions
- `src/server/memory/memoryTypes.ts` — server-only type extensions
- `src/server/memory/memoryRepo.ts` — MongoDB CRUD for `memories`
- `src/server/memory/episodeRepo.ts` — MongoDB CRUD for `interaction_episodes`
- `src/server/memory/memoryVectorStore.ts` — LanceDB wrapper
- `src/server/memory/memoryFtsStore.ts` — SQLite FTS5 wrapper
- `src/server/memory/memoryConfig.ts` — config loading with defaults
- `src/server/memory/memoryService.ts` — init/shutdown orchestration
- `src/server/memory/pipelines/episodeRecorder.ts` — Pipeline A
- `src/server/memory/index.ts` — barrel export

**Files to modify**:
- `src/server/config.ts` — add memory env vars
- `src/server/mongo.ts` — add memory index initialization
- `src/server/index.ts` — add memory init/shutdown
- `src/server/slack/eventHandlers.ts` — add episode recording hook
- `src/server/discord/eventHandlers.ts` — add episode recording hook
- `src/server/chat/chatRoutes.ts` — add episode recording hook
- `src/shared/modelConfig.ts` — add `memory` model role
- `.env.example` — add memory env vars
- `routing-config.yaml` — add `{MEMORY_CONTEXT}` and `{USER_CONTEXT}` placeholders
- `src/server/slack/messageRouter.ts` — add placeholder replacement (returns empty for now)

**Tests**:
- `src/server/memory/episodeRepo.test.ts` — CRUD tests
- `src/server/memory/memoryRepo.test.ts` — CRUD tests
- `src/server/memory/pipelines/episodeRecorder.test.ts` — recording with truncation
- Integration: verify episodes are recorded from Slack/Discord/web chat paths

**Deliverable**: All interactions are recorded as episodes. Memory infrastructure exists but isn't populated yet. `{MEMORY_CONTEXT}` and `{USER_CONTEXT}` are empty strings (no-op).

### Phase 2: Fact Extraction + Context Injection

**Goal**: Extract facts from interactions and inject them into the system prompt.

**Files to create**:
- `src/server/memory/pipelines/factExtractor.ts` — Pipeline B
- `src/server/memory/prompts.ts` — LLM prompt templates
- `src/server/memory/memorySearch.ts` — hybrid search
- `src/server/memory/contextBuilder.ts` — build `{MEMORY_CONTEXT}` and `{USER_CONTEXT}`

**Files to modify**:
- `src/server/memory/memoryService.ts` — wire Pipeline B to fire after Pipeline A
- `src/server/slack/messageRouter.ts` — call `buildMemoryContext()` and `buildUserContext()`, replace placeholders with real content

**Tests**:
- `src/server/memory/pipelines/factExtractor.test.ts` — extraction + curation logic with mocked LLM
- `src/server/memory/memorySearch.test.ts` — hybrid search scoring
- `src/server/memory/contextBuilder.test.ts` — formatting and truncation
- `src/server/memory/prompts.test.ts` — prompt template rendering
- Integration: verify facts extracted from a conversation appear in subsequent routing context

**Deliverable**: Steve learns facts from conversations and injects them into future interactions.

### Phase 3: Memory Evolution (A-MEM)

**Goal**: Memories self-organize — link to each other and evolve when new memories arrive.

**Files to create**:
- `src/server/memory/pipelines/memoryEvolver.ts` — Pipeline E

**Files to modify**:
- `src/server/memory/pipelines/factExtractor.ts` — trigger Pipeline E on ADD/UPDATE

**Tests**:
- `src/server/memory/pipelines/memoryEvolver.test.ts` — link generation + evolution logic

**Deliverable**: Memory notes form an interconnected, self-organizing knowledge structure.

### Phase 4: Signal Collection

**Goal**: Detect implicit and explicit feedback signals from user behavior.

**Files to create**:
- `src/server/memory/pipelines/signalCollector.ts` — Pipeline C

**Files to modify**:
- `src/server/memory/memoryService.ts` — start signal collection timer

**Tests**:
- `src/server/memory/pipelines/signalCollector.test.ts` — signal detection patterns
- Test: gratitude detection, correction detection, rephrase detection, job outcome signals

**Deliverable**: Episodes accumulate outcome signals that inform future reflection.

### Phase 5: Reflection & User Profile

**Goal**: Periodic consolidation of episodes into reflections + persistent user profile.

**Files to create**:
- `src/server/memory/pipelines/reflectionEngine.ts` — Pipeline D

**Files to modify**:
- `src/server/memory/memoryService.ts` — start reflection scheduler
- `src/server/memory/contextBuilder.ts` — `buildUserContext()` returns real profile

**Tests**:
- `src/server/memory/pipelines/reflectionEngine.test.ts` — clustering, reflection generation, profile synthesis
- Integration: verify reflection output quality with real episodes

**Deliverable**: Steve consolidates interaction patterns into higher-level knowledge and maintains a persistent user profile.

### Phase 6: HTTP API + UI Integration

**Goal**: Web UI memory browser for viewing, searching, editing, and managing memories.

**Files to create**:
- `src/server/memory/memoryRoutes.ts` — Express routes

**Files to modify**:
- `src/server/api/router.ts` — mount memory routes

**UI work** (separate phase, not covered in this backend spec):
- Memory browser page in `src/ui/`
- Episode viewer
- Memory search playground
- Manual memory editing
- Reflection trigger button
- Memory stats dashboard

**Tests**:
- `src/server/memory/memoryRoutes.test.ts` — API endpoint tests

**Deliverable**: Full HTTP API for memory management, ready for UI integration.

### Phase 7: Documentation & Observability

**Goal**: Update all documentation, add logging, add metrics.

**Files to modify**:
- `docs/ARCHITECTURE.md` — add memory system section
- `docs/CONFIGURATION.md` — add memory env vars
- `docs/API.md` — add memory API endpoints
- `README.md` — add memory system to feature list
- `CHANGELOG.md` — document the feature

**Logging**: All pipelines use `createLogger("server:memory:*")` namespace. Key log events:
- Episode recorded (info)
- Facts extracted with operation counts (info)
- Memory created/updated/invalidated (info)
- Signal detected (debug)
- Reflection completed with stats (info)
- Memory search performed with result count (debug)
- Pipeline errors (warn/error)

---

## 13. Testing Strategy

### 13.1 Unit Tests

Every module gets a corresponding `.test.ts` file:

| File | What to test |
|---|---|
| `memoryRepo.test.ts` | CRUD, index behavior, filtering, invalidation |
| `episodeRepo.test.ts` | CRUD, extraction status transitions, signal append |
| `memorySearch.test.ts` | Composite scoring formula, RRF merge, filtering, access_count increment |
| `contextBuilder.test.ts` | Formatting, truncation at token limit, empty state handling |
| `episodeRecorder.test.ts` | Truncation, field mapping, source_ref construction |
| `factExtractor.test.ts` | Extraction filter logic, ADD/UPDATE/DELETE/NOOP execution, batched prompt |
| `signalCollector.test.ts` | Each signal type detection, batch processing, timeout handling |
| `reflectionEngine.test.ts` | Clustering, reflection storage, profile synthesis |
| `memoryEvolver.test.ts` | Link generation, bidirectional linking, neighbor evolution |
| `prompts.test.ts` | Template rendering with various inputs |
| `memoryConfig.test.ts` | Default values, env var overrides, weight normalization |
| `memoryRoutes.test.ts` | All HTTP endpoints, auth, validation, error handling |

### 13.2 Integration Tests

- **End-to-end episode recording**: Send a message through the chat route, verify an episode document exists in MongoDB with correct fields
- **End-to-end extraction**: Record an episode, run extraction, verify memory notes exist in MongoDB + LanceDB + FTS5
- **End-to-end retrieval**: Create memory notes, send a related query, verify `{MEMORY_CONTEXT}` contains the relevant memories
- **Signal collection**: Record an episode, simulate a follow-up message, run signal collector, verify signals on the episode
- **Reflection**: Create N episodes, run reflection, verify reflection memories and user profile exist

### 13.3 LLM Mocking Strategy

All LLM calls in the memory system go through the research LLM client (`src/server/kb/research/llmClient.ts`) or a dedicated memory LLM client with the same interface. Tests mock this client to return deterministic structured JSON responses. This avoids real LLM calls in CI while testing the full pipeline logic.

### 13.4 Test Data Fixtures

Create fixture files with representative interaction episodes:
- A chat conversation about code preferences (should extract preference facts)
- A KB search that the user corrected (should extract correction + domain knowledge)
- A job creation that resulted in a failed job (should record job_failed signal)
- A GitHub query with follow-up questions (should extract team knowledge)
- A multi-turn conversation with gratitude (should extract multiple facts + gratitude signal)

---

## 14. Future Extensions (Out of Scope for Initial Implementation)

These are documented for future reference but NOT part of the current implementation plan:

1. **Knowledge Graph Layer** (Graphiti-inspired) — entity/relationship extraction from memories, Neo4j or MongoDB graph queries, multi-hop reasoning
2. **RL-Based Utility Scoring** (full MemRL) — formal Q-value updates on memories based on downstream task success, utility-weighted retrieval
3. **Procedural Memory / Skill Library** (Voyager-inspired) — successful solution patterns as reusable composable skills
4. **Cross-Agent Memory** — shared memory pool across multiple workers for collaborative learning
5. **Memory Decay / Garbage Collection** — automatic pruning of low-utility, rarely-accessed memories after a configurable retention period
6. **Web UI Memory Browser** — full React UI for memory exploration, search playground, manual editing, reflection triggers, and stats dashboard
7. **Memory Export/Import** — backup and restore memory state, or seed from another instance
8. **Multi-User Memory** — per-user memory isolation with optional shared team memories
