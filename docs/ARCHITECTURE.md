# Architecture Guide

> For humans and AI agents working on or with Son of Steve.

## System Overview

Son of Steve is a **local-first coding agent orchestrator**. It receives coding tasks via Slack mentions, Discord mentions, or a web UI, queues them in MongoDB, and dispatches them to local worker processes that use Claude Code CLI to implement changes end-to-end: resolve repo → create worktree → generate code → lint/test → commit → push → open PR → monitor CI → fix CI failures.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Local Machine                            │
│                                                                 │
│  ┌──────────────┐  HTTP + WS      ┌──────────────────────────┐  │
│  │  sos-server   │◄──────────────►│  sos-worker (N loops)    │  │
│  │              │                 │                          │  │
│  │  • Express   │                 │  • Poll/claim jobs       │  │
│  │  • Slack Bot │                 │  • Heartbeat leases      │  │
│  │  • Web UI    │                 │  • Claude Code CLI       │  │
│  │  • Mongo     │                 │  • git / gh CLI          │  │
│  │  • Worker WS │ (log stream)    │  • WS log streaming     │  │
│  │  • Chat API  │                 │  • Status reporting      │  │
│  └──────┬───────┘                 └──────────────────────────┘  │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │   MongoDB     │ (local or Atlas)                             │
│  │  • jobs col   │
│  │  • convos col │                                              │
│  │  • kb cols    │                                              │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────┐                                               │
│  │  LanceDB      │ (local vector store for KB embeddings)       │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────┐                                               │
│  │  SQLite FTS5  │ (per-KB keyword index for hybrid search)     │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────┐                                               │
│  │  Slack (WS)   │ Socket Mode — no public URL needed           │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────┐                                               │
│  │ Discord (WS) │ Gateway — no public URL needed               │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### sos-server (`src/server/`)

The server is the **single source of truth** for job state. It:

1. **Receives Slack `app_mention` events** via Socket Mode and **Discord `messageCreate` events** via Gateway (no public endpoint needed for either)
2. **Creates jobs idempotently** in MongoDB (deduplicated by Slack/Discord event IDs)
3. **Exposes an HTTP API** for workers to poll/claim/heartbeat/update/complete/fail jobs
4. **Exposes an HTTP API** for the web UI to list/view/create/cancel/retry/delete jobs
5. **Posts Slack/Discord thread updates** for key lifecycle events (queued, claimed, PR, CI, done/failed) via a `CompositePoster` that fans out to all enabled platforms
6. **Manages an in-memory worker registry** (register, deregister, status, stale detection)
7. **Runs a WebSocket server** for real-time worker log streaming and command dispatch
8. **Provides a chat/conversation API** backed by the same LLM routing as Slack
9. **Manages knowledge bases** with vector-indexed document storage (hierarchical path metadata, breadcrumb-enriched embeddings), **hybrid search** (LanceDB vector similarity + SQLite FTS5 keyword search merged via Reciprocal Rank Fusion), streaming ingestion progress, context injection into LLM calls, an **advanced research pipeline** (multi-stage RAG with simple/deep/agent strategies, LLM-driven query analysis, CRAG evaluation, IRCoT reasoning, and a ReAct agent with `keyword_search` tool), full **audit logging** of research sessions, **RAPTOR tree** preprocessing (recursive clustering and summarization of KB chunks for hierarchical retrieval), and **KB-enriched image generation** (vector search + evaluator filtering + LLM prompt rewriting)
10. **Runs the GitHub Hub sync engine** — background priority-queue loop that hot-syncs open PRs, backfills historical chunks, warm-syncs org/team membership, and rebuilds contribution aggregations. Uses Octokit with dual rate limiters (REST 5,000/hr + Search 30/min token bucket) and deterministic epoch-anchored 28-day chunks stored in MongoDB. See [docs/GITHUB_HUB_DESIGN.md](GITHUB_HUB_DESIGN.md) for details.
11. **Caches GitHub PR stats** (TTL-based) to avoid API rate limit exhaustion
12. **Can spawn and kill worker processes** via `child_process` (detached process groups for reliable cleanup)
13. **Serves the React SPA** as static files (production build)
14. **Runs the persistent memory system** — an interaction-agnostic learning system that records episodes from all interaction paths (Slack, Discord, web chat), extracts facts via LLM (Mem0-style ADD/UPDATE/DELETE/NOOP curation), collects implicit feedback signals (gratitude, correction, rephrase, job outcomes), runs periodic reflection to consolidate episodes into higher-level insights and user profiles, and self-organizes memories via A-MEM-inspired link evolution. Retrieved memories are injected into the system prompt as `{MEMORY_CONTEXT}` and `{USER_CONTEXT}` alongside existing KB context, using hybrid search (LanceDB vector + SQLite FTS5 keyword + RRF) with composite scoring (similarity + recency + importance + access frequency). Five async pipelines (Episode Recording, Fact Extraction, Signal Collection, Reflection & Consolidation, Memory Evolution) run post-hoc so memory writing never blocks the interaction hot path. See [docs/MEMORY_SYSTEM_DESIGN.md](MEMORY_SYSTEM_DESIGN.md) for the full design.
15. **Unified context assembly** (`src/server/context/`) — searches both Knowledge Bases and Memory in parallel, normalizes results into a common `ContextItem` format, optionally cross-ranks via an LLM listwise reranker (research basis: RankRAG, EverMemOS, CRAG), assesses context sufficiency, and automatically escalates to deep research when context is insufficient. The assembled context is serialized within a shared token budget and injected into the system prompt via the `{CONTEXT}` placeholder (with fallback to legacy `{KB_CONTEXT}` + `{MEMORY_CONTEXT}` placeholders). A worker-facing HTTP endpoint (`POST /api/worker/context`) exposes the same assembly pipeline to workers. See [docs/UNIFIED_KNOWLEDGE_LAYER_DESIGN.md](UNIFIED_KNOWLEDGE_LAYER_DESIGN.md) for the full design.

The server **holds all Slack and Discord credentials**. Workers never touch Slack or Discord directly.

### sos-worker (`src/worker/`)

The worker runs a **single execution loop**. The loop:

1. **Polls** the server for eligible jobs matching its configured `requested_by` user
2. **Claims** a job atomically with a lease
3. **Heartbeats** to extend the lease during execution
4. **Executes** the full workflow: resolve repo → worktree → Claude → checks → commit → PR → CI
5. **Reports** structured events back to the server (which may trigger Slack updates)
6. **Completes or fails** the job

The worker also supports additional job types:
- **`respond_to_pr_comments`** — fetches unresolved PR review threads, runs Claude to address each thread, commits, pushes, and replies to the threads.
- **`self_review_pr`** — checks out an existing PR branch, runs a self-review pass (Claude as Staff Engineer code reviewer), fixes issues found, and pushes.
- **`add_pr_review_comments`** — reviews a PR and posts inline review comments on GitHub as the bot.

On startup, the worker **registers** with the server (worker ID, hostname, PID) and opens a **WebSocket** connection for real-time log streaming and receiving commands (e.g., shutdown). Each loop reports its status (idle/busy, current task) on every poll cycle. Claude's raw stream-json output is teed to the server via WebSocket so it can be viewed live in the web UI.

Workers are **stateless** — all persistent state lives in MongoDB via the server API. If a worker crashes, its lease expires and another worker can reclaim the job.

### MongoDB

Nineteen collections:

- **`jobs`** — Full job document including status, lease info, outputs, metrics, and an append-only events log.
- **`conversations`** — Chat conversations from the web UI (messages, linked job IDs, titles).
- **`knowledge_bases`** — Knowledge base metadata (name, scopes, embedding config, stats).
- **`kb_documents`** — Per-document metadata for ingested files (name, size, chunk count).
- **`kb_upload_jobs`** — Upload job tracking for async ingestion.
- **`research_sessions`** — Research pipeline audit logs (query, strategy, config, steps with LLM/retrieval call records, metrics, consumer link).
- **`github_org_members`** — Cached GitHub org member profiles.
- **`github_teams`** — Cached GitHub team metadata.
- **`github_prs`** — Cached pull request documents with review and comment stats.
- **`github_contributions`** — Pre-aggregated contribution metrics per user.
- **`github_sync_chunks`** — Backfill chunk state tracking (status, pages fetched, resumability).
- **`github_sync_state`** — Sync engine cursor/state tracking (e.g., last hot/warm sync timestamps).
- **`github_sync_log`** — Timestamped sync activity log (displayed in UI via SSE stream).
- **`github_settings`** — UI-editable GitHub Hub configuration (org, team, sync toggles, etc.).
- **`generated_images`** — Stored generated images (base64 data, metadata, 90-day TTL index).
- **`raptor_trees`** — RAPTOR tree build status and metadata per knowledge base.
- **`memories`** — Memory notes: facts extracted from interactions, reflections consolidated from episode clusters, and user profiles synthesized from accumulated knowledge. Each note has content, context, keywords, tags, temporal validity (`valid_from`/`invalidated_at`), bidirectional links to related memories, and scoring fields (`importance`, `confidence`, `access_count`).
- **`interaction_episodes`** — Records of every user interaction across Slack, Discord, and web chat. Each episode captures the user message, routed action, response summary, downstream effects (task IDs), outcome signals (gratitude, correction, rephrase, job outcomes), and extraction processing state.
- **`memory_config`** — Persisted memory system configuration overrides (from the web UI config editor), merged with environment-variable defaults at runtime.

**Key indexes:**
- `source.event_id` — unique partial (idempotency for Slack/Discord events)
- `task_id` — unique (primary lookup key)
- `{ requested_by, status, created_at }` — compound (poll queries)
- `{ status, lease_expires_at }` — compound (reclaim expired leases)
- `kb_id` — unique (knowledge base lookup)
- `{ kb_id, name }` — compound unique (document dedup within a KB)
- `{ org, data_type, chunk_start }` — compound (GitHub sync chunk lookup)
- `memory_id` — unique (memory note lookup)
- `{ owner, memory_type, updated_at }` — compound (memory listing by owner/type, sorted by recency)
- `{ owner, invalidated_at }` — compound (active/invalidated memory filtering)
- `{ owner, tags }` — compound (tag-based memory filtering)
- `source_episodes` — multikey (find memories extracted from a given episode)
- `episode_id` — unique (episode lookup)
- `{ owner, timestamp }` — compound (episode listing by owner, sorted by recency)
- `{ owner, extraction_status }` — compound (pending extraction queue)
- `task_id` — (episode → job linking)

### Web UI (`src/ui/`)

A React + Vite SPA that calls `/api/web/*` endpoints. Authenticated via the same `SOS_INTERNAL_API_TOKEN` (stored in localStorage). Provides:

- **Chats** — conversational interface using the same LLM routing as Slack; can create jobs, check status, and chat
- **Jobs** — list with filters (status, user, search), detail view with full event timeline and cost metrics, create/cancel/retry/delete, respond-to-PR-comments
- **Workers** — live worker health dashboard with per-loop status, spawn new workers, shutdown, live log terminal with Claude output streaming via SSE
- **Git** — GitHub Hub dashboard with five sub-tabs: **Pull Requests** (cached PRs with filtering by scope, repo, author, status), **Contributions** (charts and leaderboards, team/member browser), **Sync** (backfill progress, chunk timeline, rate limit gauges, live SSE activity feed, manual triggers), **Repos** (in-browser YAML editor for the repo registry), and **Settings** (org, team, history depth, sync intervals, token validation)
- **Knowledge** — create/manage knowledge bases, upload documents or folders (with real-time per-file progress), test semantic search in the KBPlayground, configure scopes and chunking parameters, **RAPTOR tree** visualization (build/rebuild indices, interactive cluster hierarchy explorer)
- **Research** — global research config controls (chat/Slack strategy, max context tokens persisted to routing-config.yaml), **Research Playground** (run queries with simple/deep/agent strategies, real-time NDJSON-streamed pipeline timeline, model selector), **Strategy Comparison** (side-by-side all-strategies benchmark), **Research History** (paginated session browser with timeline drill-down), and per-job **Research Audit** sections on the Jobs detail page
- **Memory** — browse and search persistent memories (facts, reflections, user profiles), view interaction episodes with extracted memories and feedback signals, manually edit or invalidate memories, trigger reflection, and edit memory system configuration
- **Routing** — visual editor for the YAML-driven routing config: structured parameter editing, type-aware execution editors for all 14 execution types, reply template management, with a raw YAML fallback view
- **Models** — view and override model assignments for all roles (routing, titleGeneration, research, raptorSummarization, embedding, imageGeneration, memory, context) with autocomplete from available models

The UI uses a component-based architecture under `src/ui/src/components/` with shared state in `AppDataContext` (polling jobs every 3s, worktrees every 5s, workers every 5s, PRs every 10min).

## Job Lifecycle

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
  Slack mention ──► QUEUED ──► RUNNING ──► DONE                   │
  Discord mention ►      │          │  ▲                             │
  Web create ──►      │          │  ▲                             │
                      │          │  │                              │
                      ▼          ▼  │                              │
                   BLOCKED   FIXING_CI ────► (back to RUNNING)     │
                      │          │                                 │
                      │          ▼                                 │
                      │        FAILED                              │
                      │          │                                 │
                      ▼          ▼                                 │
                   CANCELED   (retry creates new QUEUED job)       │
                      │          │                                 │
                      ▼          ▼                                 │
                   DELETED (soft — doc preserved)                  │
                    └──────────────────────────────────────────────┘

  Planning flow (complex tasks):
  QUEUED ──► PLANNING ──► PENDING_CONFIRMATION ──► QUEUED ──► (normal flow)
                                    │
                                    ▼
                                 CANCELED
```

### Status Descriptions

| Status | Meaning |
|---|---|
| `QUEUED` | Waiting for a worker to claim |
| `BLOCKED` | Waiting for a blocking job (same PR) to finish before becoming claimable |
| `PLANNING` | Worker is running a read-only Claude session to generate a technical plan |
| `PENDING_CONFIRMATION` | Plan generated and presented to user; awaiting explicit confirmation |
| `RUNNING` | Claimed and being executed by a worker |
| `FIXING_CI` | Worker is attempting a CI fix iteration |
| `WAITING_FOR_APPROVAL` | PR created as draft; awaiting human approval before promotion |
| `DONE` | Successfully completed — PR created, CI passed (or warned) |
| `FAILED` | Execution failed — error details in job doc |
| `CANCELED` | Manually canceled via web UI (or API) |
| `DELETED` | Soft-deleted — hidden from default queries, doc preserved |

## Lease-Based Concurrency

The system uses **optimistic lease-based concurrency** for crash safety with N workers:

1. **Claim** is an atomic `findOneAndUpdate` with a filter that checks:
   - `task_id` matches AND `requested_by` matches
   - AND (`status == QUEUED` OR (`status IN [RUNNING, FIXING_CI]` AND `lease_expires_at < now`))
2. **Heartbeat** extends `lease_expires_at` every 15s during execution
3. **Reclaim**: if a worker crashes, the lease expires and any other worker can reclaim on the next poll cycle
4. **Attempt counter** increments on each claim, allowing detection of reclaimed jobs

This means there is **no single point of failure** for job execution — as long as at least one worker is running, jobs will be picked up.

## Data Flow: Slack Mention → PR

```
1. User types: @SonOfSteve fix the auth bug repo=my-api tests=full
2. Slack sends app_mention event via Socket Mode to sos-server
3. Server:
   a. Extracts event_id, user, channel, thread_ts, text
   b. Strips bot mention, parses modifiers (repo=, tests=, etc.)
   c. Inserts job doc with status=QUEUED (idempotent by event_id)
   d. Posts "Queued ✅ task_id=..." to Slack thread
4. Worker (polling):
   a. GET /api/worker/jobs/poll?requested_by=U... → returns QUEUED jobs
   b. POST /api/worker/jobs/:task_id/claim → atomic claim with lease
   c. Server posts "Claimed 🔧" to Slack thread
5. Worker (executing):
   a. Loads repo-registry.yaml, resolves repo by hint or keywords
   b. Ensures clone exists, acquires worktree slot from pool, checks out fresh branch
   c. Optionally fetches Slack thread context via server API
   d. Writes attachments to .sonofsteve/attachments/ in worktree
   e. Writes prompt, runs Claude Code CLI
   f. Runs lint/tests per registry config
   g. Runs self-review: feeds diff through Claude as a Staff Engineer reviewer, fixes issues
   h. Commits, pushes, creates PR via gh CLI
   i. Polls CI via gh pr checks
   j. If CI fails and ci_fix=on, runs bounded fix loop (max N attempts)
   k. Calls /complete or /fail on server
   l. Releases worktree slot back to pool
6. Server:
   a. Updates job doc to DONE/FAILED
   b. Posts final summary to Slack thread
```

## Authentication Model

- **Worker ↔ Server (HTTP)**: Bearer token (`SOS_INTERNAL_API_TOKEN`), shared secret
- **Worker ↔ Server (WebSocket)**: Same token, passed as `?token=` query param on `ws://host/api/worker/ws`
- **Web UI ↔ Server**: Same Bearer token (stored in browser localStorage) OR optional HTTP Basic Auth
- **Server → Slack**: Bot token (`SLACK_BOT_TOKEN`) and App token (`SLACK_APP_TOKEN`)
- **Server → Discord**: Bot token (`DISCORD_BOT_TOKEN`) via `discord.js` Gateway
- **Worker → GitHub**: Relies on local `gh` CLI auth (user must run `gh auth login`)
- **Worker → Claude**: Relies on local `claude` CLI auth

Workers **never** hold Slack or Discord tokens. All platform communication goes through the server.

## Repo Registry

The file `repo-registry.yaml` maps logical repo IDs to git URLs, detection keywords, commands, and CI config.

**Resolution order:**
1. Explicit `repo=<id>` hint in task text → direct lookup
2. Keyword matching: count keyword hits in task text, pick highest score
3. If ambiguous (tie), pick first match and emit warning event

## Routing System

The routing system (`src/server/routing/`) is the mechanism that turns a YAML config file into the LLM's understanding of what actions are available and how to execute them. It's the bridge between "user said something in Slack" and "the right thing happens."

### How It Works

```
routing-config.yaml
        │
        ▼
  routingConfig.ts ──► parse YAML into typed RoutingConfig
        │
        ├──► toolBuilder.ts ──► generate LLM ToolDefinition[] from action defs
        │                       + generate "Available Actions" prompt section
        │
        └──► executors.ts  ──► dispatch routed action to the right handler
                                using the action's ExecutionDef
```

1. On server startup, `initRoutingConfig()` loads `routing-config.yaml`, parses it into a typed `RoutingConfig`, and watches the file for changes (auto-reloads on edit).
2. If the file doesn't exist, a default config is generated. If it exists but is missing newer built-in actions, they're backfilled automatically.
3. When the message router needs to classify a Slack/chat message, `buildToolsFromConfig()` converts each enabled action's parameters into JSON Schema tool definitions for the LLM. `buildActionsPromptSection()` generates a human-readable action list that's injected into the system prompt.
4. The LLM picks a tool (action) and returns arguments. The `commandExecutor` looks up the action's `execution` definition from the config and calls `executeAction()`, which dispatches to the right handler.

### Config Structure

```yaml
system_prompt: "You are Steve, a senior staff engineer..."  # LLM system prompt
model: "claude-opus-4.5"                                   # optional model override

actions:
  create_job:
    enabled: true
    description: "Create a new coding task..."
    routing_hint: "The user wants you to write code..."     # appended to description for LLM
    parameters:
      task_text:
        type: string
        description: "Clean task description"
        required: true
      repo_hint:
        type: string
        description: "Repository ID hint"
    execution:
      type: create_job
      reply_success: "📋 Task queued: `{{task_id:0:8}}…`"
      reply_error: "⚠️ Failed: {{error}}"

custom_actions: {}  # user-defined actions (same schema as actions)
```

The system prompt supports six placeholders: `{ACTIONS}` (replaced with the auto-generated action list), `{JOBS_CONTEXT}` (replaced with recent jobs for status awareness), `{CONTEXT}` (replaced with unified KB + Memory context from the context assembler — preferred), `{KB_CONTEXT}` (replaced with knowledge base context from semantic search — legacy), `{MEMORY_CONTEXT}` (replaced with relevant learned memories — legacy), and `{USER_CONTEXT}` (replaced with the synthesized user profile from the memory system). If `{CONTEXT}` is present, the unified context assembly layer is used; otherwise the legacy `{KB_CONTEXT}` + `{MEMORY_CONTEXT}` path is used as fallback.

### Execution Types

Each action has an `execution` block that determines what happens when the LLM picks it. There are 14 execution types:

| Type | What it does |
|---|---|
| `reply` | Return the LLM's text response (or nothing if `silent: true`) |
| `create_job` | Create a coding job (optionally with `needs_plan: true` for pre-flight planning) |
| `job_action` | Resolve a task_id and call a lifecycle method: `cancel`, `retry`, `confirm`, or `promote` |
| `job_query` | Resolve a task_id and render job info with a template |
| `job_list` | List recent jobs, render each with an item template |
| `create_respond_job` | Create a respond-to-PR-comments job from a task_id or direct PR URL |
| `github_query` | Dispatch to instant GitHub queries or run inline recap generation |
| `shell` | Run a shell command and return stdout |
| `webhook` | HTTP request to an external URL |
| `agent_task` | Create a job with custom YAML-defined instructions injected into the Claude prompt |
| `leave_channel` | Leave the current Slack channel |
| `dispatch` | Route to sub-executions based on a parameter value (polymorphic dispatch) |
| `generate_image` | Generate an image from a text prompt, optionally enriched with KB context |
| `research` | Run the advanced research pipeline against knowledge bases (supports simple/deep/agent strategies) |

### Template Engine

Reply templates use a lightweight Mustache-style syntax:

- `{{var}}` — interpolate a variable
- `{{var:0:8}}` — interpolate with slice (e.g., first 8 chars of task_id)
- `{{?var}}...{{/var}}` — conditional block (render only if truthy)
- `{{args.field}}` — nested access into the LLM's tool arguments
- `{{var | default:"fallback"}}` — default value if empty

### Extensibility

Users can add `custom_actions` in the YAML with the same schema as built-in actions. Custom actions are merged with built-in ones when generating LLM tools, so the LLM can route to them just like any other action. The web UI provides a visual editor for the routing config (structured parameter editing, type-aware execution editors, reply template management) with a raw YAML fallback.

## Pre-flight Planning

For complex or ambiguous tasks, the system can run a **pre-flight planning phase** before execution. The LLM router decides whether a task warrants this — simple tasks go straight to `create_job`, while complex ones get `plan_job`.

### Planning Flow

```
QUEUED ──► PLANNING ──► PENDING_CONFIRMATION ──► QUEUED ──► RUNNING ──► ...
                                                   ▲
                                          user confirms ("go")
```

1. The LLM routes a complex task to `plan_job` instead of `create_job`
2. A job is created with `needs_plan: true` and status `QUEUED`
3. A worker claims it, detects `needs_plan`, and runs `runPlanJob()` instead of `runJob()`
4. `runPlanJob()` resolves the repo, acquires a worktree, and runs Claude Code CLI in **read-only mode** (`--allowedTools` restricts to read operations only — no file modifications)
5. Claude analyzes the codebase and produces a numbered implementation plan
6. The worker submits the plan via `api.submitPlan()` → job moves to `PENDING_CONFIRMATION`
7. The plan is posted to the Slack thread / web chat with a prompt to confirm
8. The worktree slot is **released immediately** — no resources held during the confirmation wait
9. When the user confirms ("go", "ship it", "looks good"), the LLM sees the `PENDING_CONFIRMATION` job in its context and calls `confirm_job`
10. The job moves back to `QUEUED` and a worker picks it up for normal execution via `runJob()`, with the plan injected into Claude's prompt as additional context

### Key Design Choices

- **The LLM decides** whether to plan or execute directly — no user-facing flag needed (though `needs_plan` can be set explicitly via the web UI)
- **Read-only planning** — the planning Claude session cannot modify files, only read them
- **No resource holding** — worktree slots are released after planning, not held during the potentially long confirmation wait
- **Plan as context** — when the confirmed job executes, the plan summary is injected into the Claude prompt so the execution session benefits from the analysis without re-reading everything
- **Cancellation works at any stage** — `PLANNING` and `PENDING_CONFIRMATION` can both transition to `CANCELED`

## Event System

Workers emit structured events to the server via `POST /api/worker/jobs/:task_id/events`. Events are:

1. **Stored** in the `jobs.events[]` array (truncated to 10KB per payload)
2. **Used to update job fields** (e.g., `PR_CREATED` adds to `pr_urls`, `WORKTREE_READY` sets `branch_name`)
3. **Selectively forwarded to Slack** for key types: `PR_CREATED`, `CI_FAILED`, `CI_STATUS`
4. **Forwarded to linked chat conversations** for key lifecycle events (claimed, PR created, done, failed, etc.)

Terminal states (`DONE`, `FAILED`, `CANCELED`) are posted to Slack by the service functions directly (not via the event system) to avoid duplicate notifications.

See `src/shared/types.ts` for the full `WorkerEventType` union, which includes:
`PHASE_STARTED`, `REPO_RESOLVED`, `WORKTREE_READY`, `CLAUDE_STARTED`, `CLAUDE_FINISHED`, `LOCAL_CHECKS_STARTED`, `LOCAL_CHECKS_FINISHED`, `SELF_REVIEW_STARTED`, `SELF_REVIEW_FINISHED`, `COMMIT_CREATED`, `BRANCH_PUSHED`, `PR_CREATED`, `CI_STATUS`, `CI_FAILED`, `CI_FIX_STARTED`, `CI_FIX_FINISHED`, `PLAN_STARTED`, `PLAN_GENERATED`, `PLAN_CONFIRMED`, `PR_READY_FOR_APPROVAL`, `PR_PROMOTED`, `COMMENTS_FETCHED`, `COMMENT_ADDRESSED`, `COMMENTS_PUSHED`, `REVIEW_GENERATED`, `COMMENTS_PARSED`, `REVIEW_POSTED`, `DONE`, `FAILED`, `CANCELED`

## Directory Structure

```
son-of-steve/
├── src/
│   ├── shared/                # Shared between server and worker
│   │   ├── types.ts           # Zod schemas, JobDoc, event types, worker registry types
│   │   ├── githubTypes.ts     # GitHub Hub shared types (PR docs, contributions, sync chunks, settings, API responses)
│   │   ├── kbTypes.ts         # Knowledge base shared types (KnowledgeBase, KBDocument, KBSearchResult, IngestProgressEvent)
│   │   ├── researchTypes.ts   # Research pipeline types (strategies, sessions, steps, metrics, RAPTOR, agent, streaming events)
│   │   ├── memoryTypes.ts     # Memory system shared types (MemoryNote, InteractionEpisode, MemoryConfig, search results)
│   │   ├── modelConfig.ts     # Centralized LLM model config registry (roles, defaults, YAML/env overrides)
│   │   ├── kbUtils.ts         # KB utilities (pathToBreadcrumb, formatPathBreadcrumb)
│   │   ├── modelPricing.ts    # Claude model pricing for cost estimation
│   │   ├── cache.ts           # Generic TTL cache with getOrSet
│   │   ├── time.ts            # Date helpers (nowDate, addSeconds, isExpired)
│   │   ├── slug.ts            # Text slugification for branch names
│   │   ├── slackMarkdown.ts   # Slack mrkdwn → plain text conversion
│   │   ├── discordMarkdown.ts # Discord mention normalization + Slack link cleanup
│   │   └── logger.ts          # Structured JSON logger with secret redaction
│   │
│   ├── server/                # sos-server process
│   │   ├── index.ts           # Entry point: Express + Slack + WebSocket startup
│   │   ├── config.ts          # Environment variable parsing
│   │   ├── mongo.ts           # MongoDB connection + index creation
│   │   ├── auth/
│   │   │   └── internalAuth.ts    # Bearer token + optional Basic Auth middleware
│   │   ├── jobs/
│   │   │   ├── jobModel.ts        # Zod validation schemas for API inputs
│   │   │   ├── jobRepo.ts         # MongoDB queries (CRUD, claim, heartbeat, poll)
│   │   │   ├── jobService.ts      # Business logic orchestrating repo + Slack + events
│   │   │   ├── lease.ts           # Claim + heartbeat helpers
│   │   │   ├── leaseReaper.ts     # Periodic check for stale RUNNING jobs
│   │   │   ├── idempotency.ts     # Slack event deduplication
│   │   │   └── titleGenerator.ts  # LLM-based job title generation
│   │   ├── chat/
│   │   │   ├── chatRoutes.ts          # /api/web/chats/* CRUD + message send
│   │   │   ├── conversationRepo.ts    # MongoDB CRUD for conversations
│   │   │   ├── conversationNotifier.ts # Push job status updates into linked chats
│   │   │   └── titleGen.ts            # LLM-based conversation title generation
│   │   ├── context/             # Unified context assembly layer (KB + Memory → LLM prompt)
│   │   │   ├── index.ts              # Barrel export
│   │   │   ├── contextAssembler.ts   # Main orchestrator: parallel retrieval → reranker → deep escalation → serialization
│   │   │   ├── contextReranker.ts    # LLM listwise reranker + sufficiency evaluator (RankRAG/CRAG-inspired)
│   │   │   ├── contextNormalizer.ts  # Normalize KB and Memory results into common ContextItem format
│   │   │   ├── contextSerializer.ts  # Position-aware serialization within shared token budget
│   │   │   ├── contextConfig.ts      # Config loading from env vars (reranker, deep escalation, token budget)
│   │   │   ├── contextTypes.ts       # ContextItem, RerankerResult, AssemblyResult, Sufficiency types
│   │   │   └── contextRoutes.ts      # Worker-facing route: POST /api/worker/context
│   │   ├── routing/
│   │   │   ├── routingConfig.ts    # Load, save, reload, watch routing-config.yaml
│   │   │   ├── routingTypes.ts     # TypeScript interfaces for YAML config schema (14 execution types)
│   │   │   ├── defaultConfig.ts    # Default routing-config.yaml generation
│   │   │   ├── executors.ts        # Action execution dispatch (14 handlers, one per execution type)
│   │   │   ├── toolBuilder.ts      # Build LLM tool definitions + prompt sections from YAML actions
│   │   │   ├── template.ts         # Mustache-style template rendering for replies
│   │   │   ├── researchExecutor.ts # Bridge between routing and the research pipeline (kb_search action)
│   │   │   └── index.ts            # Barrel export
│   │   ├── workers/
│   │   │   ├── spawnWorker.ts     # Spawn/kill worker processes (detached process groups)
│   │   │   ├── workerRegistry.ts  # In-memory registry (status, logs, SSE fan-out)
│   │   │   └── workerWs.ts        # WebSocket server for worker log streaming + commands
│   │   ├── llm/
│   │   │   ├── llmProvider.ts         # LLM provider interface
│   │   │   ├── anthropicProvider.ts   # Anthropic API implementation
│   │   │   ├── openaiProvider.ts      # OpenAI-compatible implementation
│   │   │   └── index.ts               # Provider factory
│   │   ├── github/                # GitHub queries via MongoDB cache (instant queries, inline recaps)
│   │   │   ├── mongoQueries.ts    # MongoDB-backed GitHub queries (PRs, reviews, team activity)
│   │   │   ├── mongoFormatting.ts # Slack formatting for query results + LLM prompt builders
│   │   │   ├── recapService.ts    # Inline recap generation using MongoDB data + LLM provider
│   │   │   └── index.ts           # Barrel export
│   │   ├── githubSync/            # GitHub Hub sync engine (REST API + MongoDB cache)
│   │   │   ├── syncService.ts     # Main orchestrator: priority-queue loop (hot PRs, backfill, org sync, contributions)
│   │   │   ├── githubConfig.ts    # Config resolution (DB settings > env vars > defaults)
│   │   │   ├── chunks.ts          # Deterministic epoch-anchored chunk math
│   │   │   ├── prSyncer.ts        # PR fetching via GitHub Search API + chunk-based backfill
│   │   │   ├── orgSyncer.ts       # Org member + team sync via GitHub REST API
│   │   │   ├── contributionSyncer.ts  # Contribution aggregation from cached PR data
│   │   │   ├── octokitClient.ts   # Octokit client with throttling plugin + rate limit budget
│   │   │   ├── rateLimitBudget.ts  # Dual rate limiter (REST 5K/hr + Search 30/min token bucket)
│   │   │   ├── githubRepo.ts      # MongoDB CRUD for all GitHub Hub collections
│   │   │   ├── syncEventLog.ts    # Sync activity log + SSE subscriber fan-out
│   │   │   └── index.ts           # Barrel export
│   │   ├── notifications/
│   │   │   └── poster.ts          # NotificationPoster interface + CompositePoster (multi-platform fan-out)
│   │   ├── slack/
│   │   │   ├── socketMode.ts      # Slack Bolt app with Socket Mode
│   │   │   ├── eventHandlers.ts   # app_mention → job creation logic
│   │   │   ├── messageRouter.ts   # LLM-powered intent classification (shared by Slack + Discord)
│   │   │   ├── commandExecutor.ts # Execute routed actions (shared by Slack + Discord)
│   │   │   ├── slackClient.ts     # SlackPoster: Slack Web API posting + thread fetching
│   │   │   ├── userResolver.ts    # Resolve Slack user IDs to display names
│   │   │   └── formatting.ts      # Status message templates (shared by Slack + Discord)
│   │   ├── discord/
│   │   │   ├── gatewayBot.ts      # Discord.js gateway bot (messageCreate listener)
│   │   │   ├── eventHandlers.ts   # Discord mention → job creation logic
│   │   │   ├── discordClient.ts   # DiscordPoster: Discord API posting + thread fetching
│   │   │   └── userResolver.ts    # Resolve Discord user IDs to display names
│   │   ├── kb/
│   │   │   ├── vectorStore.ts     # LanceDB wrapper (init, create/add/search/delete tables, RAPTOR node listing)
│   │   │   ├── ftsStore.ts        # SQLite FTS5 wrapper (per-KB keyword index, BM25 search, schema migration)
│   │   │   ├── hybridSearch.ts    # Hybrid retrieval: vector + FTS5 keyword search merged via RRF
│   │   │   ├── chunker.ts         # Markdown-aware text chunking (headings → paragraphs → sentences)
│   │   │   ├── embeddings.ts      # OpenAI/LiteLLM embedding provider with batching
│   │   │   ├── ingestion.ts       # File ingestion pipeline (text, PDF, archives)
│   │   │   ├── kbRepo.ts          # MongoDB CRUD for KB + document metadata
│   │   │   ├── kbService.ts       # Orchestration: CRUD, ingestion, embedding, search, researchKnowledgeBases() entry point
│   │   │   ├── kbRoutes.ts        # Express routes: web + worker KB, research, RAPTOR, and FTS endpoints; NDJSON streaming
│   │   │   ├── uploadRepo.ts      # MongoDB CRUD for durable upload job tracking (per-file status, progress)
│   │   │   ├── index.ts           # Barrel export
│   │   │   ├── research/          # Advanced RAG research pipeline
│   │   │   │   ├── pipeline.ts        # Pipeline runner/orchestrator (simple + deep strategies, budget enforcement)
│   │   │   │   ├── llmClient.ts       # Lightweight OpenAI-compatible LLM client for research reasoning calls
│   │   │   │   ├── auditLog.ts        # AuditEmitter + StepRecorder for structured audit logging
│   │   │   │   ├── auditRepo.ts       # MongoDB CRUD for research_sessions collection
│   │   │   │   ├── strategies.ts      # Strategy profile definitions (simple/deep/agent budget caps + toggles)
│   │   │   │   ├── stages/
│   │   │   │   │   ├── queryAnalyzer.ts   # Query decomposition, complexity classification, step-back queries
│   │   │   │   │   ├── queryExpander.ts   # HyDE hypothetical document generation + multi-query embedding
│   │   │   │   │   ├── retriever.ts       # Multi-query vector search wrapper (wraps existing twoStageSearch)
│   │   │   │   │   ├── evaluator.ts       # LLM reranking + CRAG relevance evaluation + re-query generation
│   │   │   │   │   ├── reasoner.ts        # IRCoT iterative reasoning loop (convergence detection)
│   │   │   │   │   └── synthesizer.ts     # Final context assembly with inline citations
│   │   │   │   └── agent/
│   │   │   │       ├── agentLoop.ts       # ReAct agent loop (Phase 4)
│   │   │   │       ├── agentTools.ts      # Tool definitions: search_kb, keyword_search, evaluate_relevance, generate_hyde, etc.
│   │   │   │       └── agentPrompts.ts    # Agent system prompt builder
│   │   │   └── raptor/            # RAPTOR tree preprocessing
│   │   │       ├── clusterer.ts       # K-means clustering of chunk embeddings
│   │   │       ├── summarizer.ts      # LLM-based cluster summarization
│   │   │       ├── treeBuilder.ts     # Recursive tree construction orchestrator
│   │   │       └── raptorRepo.ts      # MongoDB metadata for RAPTOR build status
│   │   ├── memory/              # Persistent memory system
│   │   │   ├── index.ts              # Barrel export of public API
│   │   │   ├── memoryConfig.ts       # Config loading from env vars with defaults
│   │   │   ├── memoryService.ts      # Orchestration: init, shutdown, interaction hooks, context retrieval
│   │   │   ├── memoryRepo.ts         # MongoDB CRUD for `memories` collection
│   │   │   ├── episodeRepo.ts        # MongoDB CRUD for `interaction_episodes` collection
│   │   │   ├── memoryVectorStore.ts  # LanceDB wrapper for memory embeddings (per-owner tables)
│   │   │   ├── memoryFtsStore.ts     # SQLite FTS5 wrapper for memory keyword search
│   │   │   ├── memorySearch.ts       # Hybrid search (vector + keyword + RRF + composite scoring)
│   │   │   ├── contextBuilder.ts     # Build {MEMORY_CONTEXT} and {USER_CONTEXT} for prompt injection
│   │   │   ├── memoryRoutes.ts       # Express routes for /api/web/memory/* (UI integration)
│   │   │   ├── memoryUtils.ts        # Shared utilities (distance conversion, LLM client, embedding text builder)
│   │   │   ├── prompts.ts            # LLM prompt templates for extraction, curation, reflection, evolution
│   │   │   └── pipelines/
│   │   │       ├── episodeRecorder.ts    # Pipeline A: record interaction episodes (zero LLM)
│   │   │       ├── factExtractor.ts      # Pipeline B: Mem0-style fact extraction + curation (1-2 LLM calls)
│   │   │       ├── signalCollector.ts    # Pipeline C: implicit feedback signal detection (zero LLM)
│   │   │       ├── reflectionEngine.ts   # Pipeline D: periodic reflection + user profile synthesis (N LLM calls)
│   │   │       └── memoryEvolver.ts      # Pipeline E: A-MEM-style memory linking + evolution (0-1 LLM calls)
│   │   └── api/
│   │       ├── router.ts        # Mount worker + web + chat + KB + GitHub routes with auth
│   │       ├── workerRoutes.ts  # /api/worker/* (jobs + registration)
│   │       ├── webRoutes.ts     # /api/web/* (jobs, PRs, workers, registry, routing, models, worktrees, images)
│   │       └── githubRoutes.ts  # /api/web/github/* (PRs, contributions, teams, sync, settings)
│   │
│   ├── worker/                # sos-worker process
│   │   ├── index.ts           # Entry point: register, start loops, connect WS
│   │   ├── config.ts          # Environment variable parsing
│   │   ├── apiClient.ts       # Typed HTTP client for server API (KB search, research pipeline w/ NDJSON streaming)
│   │   ├── poller.ts          # Poll → claim → report status → execute → repeat
│   │   ├── heartbeat.ts       # Interval-based lease extension manager
│   │   ├── events.ts          # Event emission helper
│   │   ├── workerWs.ts        # WebSocket client for log streaming + commands
│   │   └── executor/
│   │       ├── runJob.ts              # Main orchestrator: full create-job workflow
│   │       ├── runPlanJob.ts          # Pre-flight planning workflow (read-only Claude)
│   │       ├── runRespondToComments.ts # PR comment review workflow
│   │       ├── runSelfReviewPr.ts      # Self-review existing PR (Claude as reviewer → fix → push)
│   │       ├── runAddReviewComments.ts # Review PR and post inline comments on GitHub
│   │       ├── errors.ts              # Sentinel errors (RequeueError, LeaseAbortedError)
│   │       ├── repoRegistry.ts        # YAML registry loader
│   │       ├── repoResolver.ts        # Hint/keyword-based repo resolution
│   │       ├── workspace.ts           # Git clone management (ensureClone)
│   │       ├── worktreePool.ts        # Reusable worktree slot pool (singleton)
│   │       ├── claude.ts              # Claude Code CLI + stream-json output + WS tee + KB context
│   │       ├── ghComments.ts          # GitHub PR thread fetching + replying
│   │       ├── git.ts                 # Git operations (commit, push, diff)
│   │       ├── pr.ts                  # GitHub PR creation via gh CLI
│   │       ├── summarize.ts           # Result summary builder
│   │       └── ci/
│   │           ├── ciProvider.ts       # CI provider interface
│   │           ├── githubActions.ts    # GitHub Actions check polling
│   │           └── jenkins.ts          # Jenkins stub (not yet implemented)
│   │
│   └── ui/                    # React + Vite SPA
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx            # SPA shell: nav tabs + routing
│           ├── api.ts             # Typed fetch client for /api/web/*
│           ├── stores/
│           │   └── AppDataContext.tsx  # Shared state + polling (jobs, PRs, workers, etc.)
│           └── components/
│               ├── chat/          # ChatsList, ChatDetail (with inline image rendering)
│               ├── jobs/          # JobsList, JobDetail (incl. ResearchAudit), JobRow, etc.
│               ├── kb/            # KBList, KBDetail, KBPlayground, kbShared, ResearchPlayground, ResearchTimeline, ResearchHistory, RaptorStatus, RaptorTree, StrategyComparison
│               ├── github/        # GitHubPage, GitHubPrsView, GitHubContributionsView, GitHubSyncDashboard, GitHubSettingsView, TeamMemberRoster
│               ├── workers/       # WorkersList, WorkerCard, WorkerDetail, SpawnWorkerModal
│               ├── registry/      # RepoRegistryEditor
│               ├── routing/       # RoutingConfigEditor, ParameterListEditor, ExecutionEditor
│               ├── models/        # ModelsPage, ModelAutocomplete
│               ├── research/      # ResearchPage (global config, strategy comparison)
│               └── shared/        # PageHeader, NavTab, HoverRow, Badge, Spinner, etc.
│
├── docs/                  # Documentation
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── biome.json
├── docker-compose.yml     # Local MongoDB for development
├── .env.example
├── .gitignore
├── repo-registry.example.yaml
├── routing-config.yaml    # YAML-driven LLM action routing (auto-generated if missing)
└── README.md
```

## Key Design Decisions

### Why lease-based claims instead of a message queue?

For a local-first system with N workers on one machine, a Mongo-backed lease is simpler than running RabbitMQ/Redis. The atomic `findOneAndUpdate` provides exactly-once claim semantics, and lease expiry provides automatic recovery from crashes.

### Why Socket Mode instead of HTTP webhooks?

Socket Mode avoids the need for a public URL (ngrok, Cloudflare tunnel, etc.) which is critical for a local dev tool. The trade-off is that Socket Mode requires the server process to be running to receive events.

### Why the server posts all Slack messages?

Workers don't hold Slack tokens. This centralizes credential management and allows the server to control message frequency (only key events are posted to avoid spam).

### Why soft-delete instead of hard-delete?

Job documents are audit trails. Soft-delete (status=DELETED) preserves the history while hiding jobs from default UI queries. Running jobs cannot be deleted — they must be canceled first.

### Why create new job on retry instead of resetting?

Creating a new job with a `parent_task_id` link preserves the original job's error details and event history for debugging, while giving the retry a clean slate.

### Why a worktree pool?

Creating a fresh git worktree per job is expensive for large repos — especially monorepos with build systems like Bazel that produce significant `.gitignore`'d output trees. The worktree pool maintains a fixed set of reusable worktree slots per repo. On reuse, it detaches HEAD, resets, cleans, and checks out a fresh branch — but in `light` clean mode it preserves `.gitignore`'d files, keeping build caches intact. If all slots are occupied, the job is requeued (not failed) with a backoff, so it retries once a slot frees up.

### Why a self-review pass?

After Claude Code generates changes, the diff is fed back through a second Claude invocation acting as a Staff Engineer code reviewer. This catches dead code, naming issues, missing error handling, test gaps, and security concerns before the PR is even created. The review prompt is opinionated (checks correctness, design, naming, error handling, tests, security, performance) and instructs Claude to fix issues directly rather than just listing them. Post-review local checks are re-run to ensure the fixes don't break anything.

### Why an in-memory worker registry instead of persisting to MongoDB?

Worker state is inherently ephemeral — a worker's PID, loop status, and log buffer are only meaningful while the process is alive. An in-memory `Map` with 60-second stale detection is simpler and faster than a MongoDB collection that would need constant cleanup. If the server restarts, workers re-register automatically on their next heartbeat.

### Why WebSocket for worker logs instead of HTTP polling?

Claude Code can produce hundreds of stream-json lines per second during an active session. HTTP polling at any reasonable interval would either miss output or waste bandwidth. A persistent WebSocket lets the worker tee every line to the server in real time with minimal overhead. The server buffers the last 1000 lines per worker in a ring buffer and fans out to UI clients via SSE.

### Why a separate "respond to PR comments" job type?

Responding to PR review comments is fundamentally different from creating new code: the worker needs to check out the existing PR branch, read specific review threads, fix each one, and reply inline. Rather than cramming this into the `create` pipeline with flags, a dedicated `respond_to_pr_comments` job type has its own clean workflow in `runRespondToComments.ts`.

### Why split GitHub queries into instant vs. recap?

GitHub queries like "my open PRs" or "team review requests" read directly from the MongoDB sync cache and return instantly in the Slack reply. Recap summaries ("my weekly recap", "team recap") also read from MongoDB but additionally run an LLM call to generate a narrative — these execute inline on the server using `recapService.ts` and the LLM provider (no background jobs or `claude` CLI). A single polymorphic `github` tool in the LLM router handles both; the `commandExecutor` dispatches to the right path based on the `query_type`.

### Why a local vector database for knowledge bases?

LanceDB is embedded (no external service), stores data on the local filesystem alongside the rest of Son of Steve, and supports efficient vector similarity search. This aligns with the local-first philosophy — no data leaves the machine. The alternative (Pinecone, Weaviate, etc.) would add an external dependency and potentially send embeddings to a cloud service. LanceDB tables are per-KB, so creating/dropping a KB is just creating/dropping a table.

### Why scope-based KB filtering?

Different knowledge bases contain different types of context (design docs, coding standards, incident history). Not all KB content is relevant to all actions — injecting irrelevant context wastes tokens and can confuse the LLM. Scopes (`chat`, `create_job`, `plan_job`, `agent_task`, `all`) let users control which KBs are queried for which action types. A KB scoped to `chat` will be searched when answering questions but not when generating code.

### Why hybrid search (vector + keyword) instead of vector-only?

Vector similarity search is powerful for semantic matching but can miss exact keyword matches — e.g., a query for "RAPTOR" might rank a semantically-similar chunk about "tree indexing" higher than a chunk that literally contains "RAPTOR" in the text. SQLite FTS5 provides BM25-scored keyword search that catches these cases. The two result sets are merged via **Reciprocal Rank Fusion (RRF)** with k=60, which produces a unified ranking that respects both semantic relevance and keyword precision. Each KB gets its own SQLite FTS5 database file (`fts_{kb_id}.sqlite`) stored alongside LanceDB data, with lazy schema migration via the `user_version` pragma. FTS records also store `UNINDEXED` metadata columns (`section`, `page`, `file_path`, `parent_dir`) so keyword-only hits can provide the same rich metadata as vector results. The `hybridSearch()` function wraps both retrieval paths and is the primary search interface used by the research pipeline retriever and the ReAct agent's `keyword_search` tool.

### Why per-KB SQLite files instead of a single database?

Matching the LanceDB pattern (one table per KB), each KB gets its own FTS5 SQLite file. This means dropping a KB is a simple file deletion — no orphan cleanup, no shared-table bookkeeping. It also avoids cross-KB index contention and makes backup/restore granular.
