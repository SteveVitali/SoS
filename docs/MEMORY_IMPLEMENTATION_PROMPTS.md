# Memory System Implementation — Agent Session Prompts

> **Status**: Historical — all sessions have been executed and the memory system is fully implemented (see `docs/MEMORY_SYSTEM_DESIGN.md`, Phases 1–7 complete). Retained as a record of the implementation process.
>
> Copy-paste each prompt into a fresh agent session. Execute in order.
> Each session creates a branch, implements, tests, and opens a PR.

---

## Session 1: Foundation — Types, Storage, Episode Recording, Wiring

```
Read the design specification at docs/MEMORY_SYSTEM_DESIGN.md in full. This is a
multi-session implementation project and you are executing Phase 1 (Foundation).

Your job is to build the entire foundation layer for the persistent memory system:
types, MongoDB repos, LanceDB vector store, SQLite FTS5 store, episode recording,
configuration, server initialization, and all integration hooks into existing code.

BRANCH: Create branch `memory/phase-1-foundation` off `main`.

IMPLEMENTATION SCOPE (from the design doc):

1. Create src/shared/memoryTypes.ts — all shared type definitions from §4 and §5
   of the design doc (MemoryNote, InteractionEpisode, OutcomeSignal, SignalType,
   MemorySearchRequest, MemorySearchResult, MemoryStats, MemoryConfig, etc.)

2. Create src/server/memory/memoryRepo.ts — MongoDB CRUD for the `memories`
   collection with all indexes from §4.1. Follow the exact patterns used in
   src/server/kb/kbRepo.ts (collection accessor, ensureIndexes, CRUD functions).

3. Create src/server/memory/episodeRepo.ts — MongoDB CRUD for the
   `interaction_episodes` collection with all indexes from §4.2. Same patterns.

4. Create src/server/memory/memoryVectorStore.ts — LanceDB wrapper for memory
   embeddings. Follow the patterns in src/server/kb/vectorStore.ts exactly. Table
   naming: `mem_{owner_id}` with hyphens replaced by underscores.

5. Create src/server/memory/memoryFtsStore.ts — SQLite FTS5 wrapper for memory
   keyword search. Follow src/server/kb/ftsStore.ts patterns. Table naming:
   `mem_fts_{owner_id}`.

6. Create src/server/memory/memoryConfig.ts — load memory configuration from env
   vars with all defaults from §5 MemoryConfig. Follow src/server/config.ts patterns.

7. Create src/server/memory/pipelines/episodeRecorder.ts — Pipeline A from §6.1.
   The recordEpisode() function that creates InteractionEpisode documents.

8. Create src/server/memory/memoryService.ts — orchestration: initMemorySystem()
   and shutdownMemorySystem(). Init should ensure indexes, initialize vector store
   and FTS store. Export onInteractionComplete() which calls recordEpisode() async
   (fire-and-forget with error logging). Export getMemoryContext() as a stub that
   returns { memoryContext: "", userContext: "" } for now.

9. Create src/server/memory/index.ts — barrel export of public API:
   initMemorySystem, shutdownMemorySystem, onInteractionComplete, getMemoryContext,
   ensureMemoryIndexes.

10. Modify src/server/config.ts — add memory config fields per §10.7.

11. Modify src/shared/modelConfig.ts — add "memory" to ModelRole type and defaults
    per §10.8.

12. Modify src/server/mongo.ts — add memory index initialization per §10.5.

13. Modify src/server/index.ts — add memory system init on startup and shutdown
    per §10.6.

14. Modify src/server/slack/eventHandlers.ts — add onInteractionComplete() call
    after executeCommand() per §10.1. Fire-and-forget with .catch() error logging.

15. Modify src/server/discord/eventHandlers.ts — same pattern per §10.2.

16. Modify src/server/chat/chatRoutes.ts — same pattern per §10.3.

17. Modify src/server/slack/messageRouter.ts — add getMemoryContext() call in
    parallel with existing buildJobsContext() and buildKBContext() per §10.4. Add
    placeholder replacements for {MEMORY_CONTEXT} and {USER_CONTEXT}. Use .catch()
    fallback so memory failures never break routing.

18. Modify routing-config.yaml — add {MEMORY_CONTEXT} and {USER_CONTEXT}
    placeholders to the system prompt per §10.9. Place them BEFORE {KB_CONTEXT}.

19. Modify .env.example — add memory env vars per §9.1.

TESTS (write these):
- src/server/memory/memoryRepo.test.ts — CRUD, filtering, invalidation
- src/server/memory/episodeRepo.test.ts — CRUD, status transitions, signal append
- src/server/memory/pipelines/episodeRecorder.test.ts — truncation, field mapping

VERIFICATION:
- Run `npm run typecheck` — must pass
- Run `npm run check` — must pass (biome lint/format)
- Run `npm test` — all existing + new tests must pass
- Verify the memory system initializes cleanly in server startup logs

After everything passes, commit with message:
"feat(memory): Phase 1 — foundation types, storage, episode recording, wiring"

Then open a PR to main with title: "feat(memory): Phase 1 — Foundation"
```

---

## Session 2: Core Intelligence — Extraction, Search, Context Injection, Evolution

```
Read the design specification at docs/MEMORY_SYSTEM_DESIGN.md in full. This is a
multi-session implementation project and you are executing Phases 2 + 3 (Core
Intelligence). Phase 1 (Foundation) has already been implemented — the memory types,
MongoDB repos, vector store, FTS store, episode recording, and all integration hooks
are in place.

Start by reading the Phase 1 code to understand what's already built:
- src/shared/memoryTypes.ts
- src/server/memory/ (all files)
- The integration hooks in eventHandlers.ts, chatRoutes.ts, messageRouter.ts

BRANCH: Create branch `memory/phase-2-core-intelligence` off `memory/phase-1-foundation`.

IMPLEMENTATION SCOPE:

1. Create src/server/memory/prompts.ts — all LLM prompt templates from §8 of the
   design doc. Implement as functions that accept template variables and return
   formatted prompt strings. Include: fact extraction prompt (§8.1), memory
   curation prompt (§8.2), combined batched prompt (§8.3), memory evolution
   prompt (§8.4). Use simple string interpolation (the codebase does not use a
   template engine for prompts — follow the patterns in
   src/server/kb/research/agent/agentPrompts.ts).

2. Create src/server/memory/pipelines/factExtractor.ts — Pipeline B from §6.2.
   Implement the extraction filter logic, the Mem0-style extraction + curation
   pipeline, and the ADD/UPDATE/DELETE/NOOP execution. Use the batched prompt
   (§8.3) by default for efficiency. Use the research LLM client pattern from
   src/server/kb/research/llmClient.ts — create a similar lightweight client or
   reuse it directly with the memory model. The function should:
   - Check the extraction filter (skip no_op, short messages, mechanical actions)
   - Fetch context episodes from the same conversation/thread
   - Fetch existing potentially-related memories via embedding search
   - Call LLM with batched extraction+curation prompt
   - Execute each operation (ADD → create MemoryNote + embed + FTS index,
     UPDATE → modify + re-embed, DELETE → set invalidated_at, NOOP → skip)
   - Update episode extraction_status and extracted_memory_ids

3. Create src/server/memory/memorySearch.ts — hybrid search from §7.1. Follow
   the exact pattern of src/server/kb/hybridSearch.ts:
   - Vector search in LanceDB mem_{owner} table
   - Keyword search in FTS5 mem_fts_{owner} table
   - RRF merge (k=60)
   - Composite scoring with the four-factor formula from §7.1 (similarity,
     recency, importance, access_count)
   - Filter invalidated memories
   - Async access_count increment on returned results

4. Create src/server/memory/contextBuilder.ts — from §7.2:
   - buildMemoryContext(userMessage, owner, config) → searches memories,
     formats as labeled list with type and date, truncates to token limit
   - buildUserContext(owner) → fetches user_profile memory note from MongoDB,
     formats as profile string

5. Create src/server/memory/pipelines/memoryEvolver.ts — Pipeline E from §6.5.
   Implement A-MEM-style link generation and memory evolution:
   - Find top-K nearest memories by embedding similarity
   - Filter by evolution_link_threshold
   - Batch all neighbors into one LLM call (evolution prompt §8.4)
   - Create bidirectional links
   - Update neighbor content/keywords/tags if the LLM says to evolve them
   - Re-embed evolved neighbors

6. Modify src/server/memory/pipelines/factExtractor.ts — after ADD or UPDATE
   operations, call evolveMemory() from memoryEvolver.ts (fire-and-forget).

7. Modify src/server/memory/memoryService.ts:
   - Wire Pipeline B: onInteractionComplete() should call recordEpisode() then
     call extractFactsFromEpisode() async (fire-and-forget with error logging)
   - Update getMemoryContext() to call the real buildMemoryContext() and
     buildUserContext() instead of returning empty strings

TESTS:
- src/server/memory/prompts.test.ts — template rendering with various inputs
- src/server/memory/pipelines/factExtractor.test.ts — extraction filter logic,
  ADD/UPDATE/DELETE/NOOP execution with mocked LLM responses
- src/server/memory/memorySearch.test.ts — composite scoring math, RRF merge,
  filtering, access_count increment
- src/server/memory/contextBuilder.test.ts — formatting, truncation, empty states
- src/server/memory/pipelines/memoryEvolver.test.ts — link generation, evolution

For LLM mocking in tests: mock the LLM client to return deterministic JSON
responses. Do NOT make real LLM calls in tests.

VERIFICATION:
- `npm run typecheck` — must pass
- `npm run check` — must pass
- `npm test` — all existing + new tests must pass

After everything passes, commit with message:
"feat(memory): Phase 2+3 — fact extraction, hybrid search, context injection, memory evolution"

Then open a PR targeting `memory/phase-1-foundation` with title:
"feat(memory): Phase 2+3 — Core Intelligence"
```

---

## Session 3: Feedback & Reflection — Signal Collection, Reflection Engine, User Profile

```
Read the design specification at docs/MEMORY_SYSTEM_DESIGN.md in full. This is a
multi-session implementation project and you are executing Phases 4 + 5 (Feedback
& Reflection). Phases 1-3 have already been implemented — episode recording, fact
extraction, memory search, context injection, and memory evolution are all working.

Start by reading the existing memory system code to understand what's built:
- src/shared/memoryTypes.ts
- src/server/memory/ (all files, especially memoryService.ts and the pipelines/)

BRANCH: Create branch `memory/phase-3-feedback-reflection` off
`memory/phase-2-core-intelligence`.

IMPLEMENTATION SCOPE:

1. Create src/server/memory/pipelines/signalCollector.ts — Pipeline C from §6.3.
   Implement the signal detection system:
   - collectSignals(config) function that batch-processes episodes past the
     signal delay threshold
   - For each pending episode (signal_collected_at unset or stale):
     a. Look up subsequent messages in the same conversation/thread. For web_chat,
        query the conversations collection for messages after the episode timestamp.
        For Slack/Discord, query interaction_episodes for the same source_ref
        thread/channel with a later timestamp.
     b. Detect signals using the detection methods from the table in §6.3:
        - continuation: next message exists from same user → +0.2
        - gratitude: regex match on next user message → +0.8
        - correction: regex match → -0.6 (include the correction text in details)
        - rephrase: embedding similarity > 0.8 between user messages → -0.4
        - follow_up_deeper: similarity 0.5-0.8 and longer message → +0.4
        - topic_change: similarity < 0.3 → 0.0
        - no_response: no follow-up within timeout → -0.1
        - job_completed: linked job status DONE → +1.0
        - job_failed: linked job status FAILED → -0.5
     c. Update episode.signals array and set signal_collected_at
   - For rephrase/follow_up detection: use the existing EmbeddingProvider from
     src/server/kb/embeddings.ts to embed and compare messages. Cache the
     episode's user_message embedding to avoid re-embedding.
   - For job signals: query the jobs collection by task_id.

2. Create src/server/memory/pipelines/reflectionEngine.ts — Pipeline D from §6.4.
   Implement reflection and consolidation:
   - runReflection(owner, config) function:
     a. Fetch episodes since last reflection (track via a metadata document in
        the memories collection, or a simple key-value in a new small collection)
     b. Embed all episode user_messages
     c. Cluster by topic using agglomerative clustering on embeddings. Use a
        simple threshold-based approach: greedily assign episodes to the nearest
        existing cluster if similarity > 0.6, otherwise create a new cluster.
     d. For each cluster of >= 3 episodes:
        - Fetch any existing memories related to the cluster's topic (via
          embedding search on the cluster centroid)
        - Build reflection prompt (§8.5) with episodes, their signals, and
          related existing memories
        - LLM generates 1-3 reflections
        - Store each as a MemoryNote with memory_type "reflection", linking to
          source episodes
     e. Synthesize/update user profile:
        - Fetch all active factual memories + new reflections for the owner
        - Build profile synthesis prompt (§8.6)
        - Upsert the user_profile MemoryNote (find existing by owner +
          memory_type="user_profile", update or create)
        - Embed the profile in LanceDB + FTS5
     f. Record last reflection timestamp

3. Add reflection and profile prompts to src/server/memory/prompts.ts:
   - Reflection prompt (§8.5)
   - User profile synthesis prompt (§8.6)

4. Modify src/server/memory/memoryService.ts:
   - Start a signal collection timer: setInterval calling collectSignals()
     every 2 minutes. Store the interval ID for shutdown cleanup.
   - Start a reflection scheduler: setInterval checking if reflection should
     run (enough new episodes + enough time elapsed). Store interval ID.
   - In shutdownMemorySystem(), clear both intervals.

5. Modify src/server/memory/contextBuilder.ts:
   - buildUserContext() should now return the real user profile content if a
     user_profile MemoryNote exists for the owner.

TESTS:
- src/server/memory/pipelines/signalCollector.test.ts:
  - Test each signal type detection (gratitude regex, correction regex, etc.)
  - Test batch processing of multiple episodes
  - Test no_response timeout detection
  - Test job_completed/job_failed signal from job status lookup (mock job repo)
  - Test that embedding similarity thresholds work for rephrase/follow_up

- src/server/memory/pipelines/reflectionEngine.test.ts:
  - Test clustering algorithm (episodes group by topic)
  - Test reflection generation with mocked LLM
  - Test user profile synthesis and upsert logic
  - Test that reflection skips when not enough episodes

Mock all LLM calls and embedding calls in tests.

VERIFICATION:
- `npm run typecheck` — must pass
- `npm run check` — must pass
- `npm test` — all existing + new tests must pass

After everything passes, commit with message:
"feat(memory): Phase 4+5 — signal collection, reflection engine, user profiles"

Then open a PR targeting `memory/phase-2-core-intelligence` with title:
"feat(memory): Phase 4+5 — Feedback & Reflection"
```

---

## Session 4: HTTP API + Documentation

```
Read the design specification at docs/MEMORY_SYSTEM_DESIGN.md in full. This is a
multi-session implementation project and you are executing Phases 6 + 7 (API +
Docs). Phases 1-5 have already been implemented — the complete memory system is
functional (episode recording, fact extraction, memory evolution, signal collection,
reflection, user profiles, context injection into routing).

Start by reading the existing memory system code:
- src/shared/memoryTypes.ts
- src/server/memory/ (all files)

BRANCH: Create branch `memory/phase-4-api-docs` off
`memory/phase-3-feedback-reflection`.

IMPLEMENTATION SCOPE:

1. Create src/server/memory/memoryRoutes.ts — Express routes from §11:
   Follow the exact patterns used in src/server/kb/kbRoutes.ts for route
   structure, error handling, and response formatting.

   Endpoints to implement:
   - GET /api/web/memory/stats → MemoryStats
   - GET /api/web/memory/memories → list with ?type, ?limit, ?offset, ?tag
   - GET /api/web/memory/memories/:memory_id → single memory + linked memories
   - POST /api/web/memory/search → hybrid search (body: MemorySearchRequest)
   - POST /api/web/memory/reflect → trigger reflection pipeline manually
   - DELETE /api/web/memory/memories/:memory_id → invalidate (NOT physical delete)
   - PUT /api/web/memory/memories/:memory_id → manual edit
   - GET /api/web/memory/profile → user profile MemoryNote
   - GET /api/web/memory/episodes → list with ?limit, ?offset, ?action filter
   - GET /api/web/memory/episodes/:episode_id → single episode + extracted memories
   - GET /api/web/memory/config → current MemoryConfig
   - PUT /api/web/memory/config → update config (persist to a MongoDB document)

2. Modify src/server/api/router.ts — mount memory routes per §10.11. Use the
   existing auth middleware (same as KB routes).

3. Update docs/ARCHITECTURE.md:
   - Add a "Memory System" section to Component Responsibilities describing the
     persistent memory system, its five pipelines, and how it integrates with
     the existing routing and KB infrastructure
   - Add `memories` and `interaction_episodes` to the MongoDB collections list
     with key index descriptions
   - Update the directory structure to include src/server/memory/

4. Update docs/CONFIGURATION.md:
   - Add all SOS_MEMORY_* environment variables with descriptions and defaults
   - Add the `memory` model role to the model config section

5. Update docs/API.md:
   - Add the full /api/web/memory/* endpoint documentation with request/response
     schemas, following the existing documentation format in that file

6. Update README.md:
   - Add "Persistent memory" to the feature bullet list (near "Knowledge bases")
     with a brief description: learns from interactions, extracts facts, builds
     user profiles, self-organizing memory with reflection
   - Add "Persistent memory" row to the comparison table
   - Add Memory to the Web UI section description

7. Update CHANGELOG.md:
   - Add a new entry for the memory system feature

TESTS:
- src/server/memory/memoryRoutes.test.ts:
  - Test all endpoints with valid requests
  - Test auth requirement (reject without token)
  - Test 404 for non-existent memory/episode IDs
  - Test validation (reject bad request bodies)
  - Test DELETE invalidates but doesn't physically delete
  - Test PUT manual edit updates content and re-embeds
  - Test POST /reflect triggers reflection and returns results
  - Mock MongoDB and memory service functions.

VERIFICATION:
- `npm run typecheck` — must pass
- `npm run check` — must pass
- `npm test` — all existing + new tests must pass
- Manually verify docs read correctly and are consistent with implementation

After everything passes, commit with message:
"feat(memory): Phase 6+7 — HTTP API routes, documentation updates"

Then open a PR targeting `memory/phase-3-feedback-reflection` with title:
"feat(memory): Phase 6+7 — API & Documentation"
```

---

## PR Chain Summary

After all four sessions complete, you'll have a PR chain:

```
main
 └── memory/phase-1-foundation          (PR #1 → main)
      └── memory/phase-2-core-intelligence   (PR #2 → phase-1)
           └── memory/phase-3-feedback-reflection  (PR #3 → phase-2)
                └── memory/phase-4-api-docs         (PR #4 → phase-3)
```

Merge order: PR #1 first, then #2, then #3, then #4. Or squash-merge #4 into
#3 into #2 into #1 and merge #1 to main as one combined feature.
