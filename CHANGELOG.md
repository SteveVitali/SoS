# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Persistent memory system** — evolving memory that learns from every interaction (Slack, Discord, web chat), extracts facts via LLM (Mem0-style ADD/UPDATE/DELETE/NOOP curation), builds user profiles, and self-organizes with periodic reflection
  - Five async pipelines: episode recording (zero LLM), fact extraction (1-2 LLM calls), signal collection (zero LLM — detects gratitude, correction, rephrase, job outcomes), reflection & consolidation (periodic LLM), memory evolution (A-MEM-style linking)
  - Hybrid memory search: LanceDB vector + SQLite FTS5 keyword + RRF fusion + four-factor composite scoring (similarity, recency, importance, access frequency)
  - `{MEMORY_CONTEXT}` and `{USER_CONTEXT}` injected into the system prompt alongside existing `{KB_CONTEXT}`
  - HTTP API: 12 endpoints under `/api/web/memory/` for stats, listing, search, manual editing, reflection triggers, episode browsing, and runtime config
  - MongoDB collections: `memories` (facts, reflections, user profiles) and `interaction_episodes` (interaction records with outcome signals)
  - New `memory` model role (default: `gpt-4.1-mini`) for extraction, curation, reflection, and evolution
- **Unified context assembly layer** (`src/server/context/`) — searches KB and Memory in parallel, normalizes results into a common `ContextItem` format, cross-ranks via an LLM listwise reranker (RankRAG/EverMemOS/CRAG-inspired), evaluates context sufficiency, and automatically escalates to deep research when insufficient
  - New `{CONTEXT}` system prompt placeholder for unified KB + Memory context (with fallback to legacy `{KB_CONTEXT}` + `{MEMORY_CONTEXT}`)
  - LLM reranker with sufficiency assessment and follow-up query suggestion for deep escalation
  - Position-aware serialization within a shared token budget
  - Worker-facing HTTP endpoint: `POST /api/worker/context`
  - New `context` model role (default: `gpt-4.1-mini`) for the reranker LLM
  - 7 new `SOS_CONTEXT_*` environment variables for configuration
- **Hybrid search (FTS5 + vector + RRF)** — each knowledge base now has a parallel SQLite FTS5 keyword index alongside its LanceDB vector store; `hybridSearch()` merges vector similarity and BM25 keyword results via Reciprocal Rank Fusion (k=60); the ReAct research agent gains a `keyword_search` tool; FTS indexes are auto-created on ingestion and support lazy schema migration via `user_version` pragma; new API endpoints `GET /api/web/kb/:id/fts/status` and `POST /api/web/kb/:id/fts/rebuild`
- **FTS metadata columns** — FTS5 index stores `section`, `page`, `file_path`, and `parent_dir` as `UNINDEXED` columns so keyword-only hits carry the same rich metadata as vector results; `FTSSearchResult` and `FTSRecord` interfaces expanded; schema version migration auto-rebuilds old indexes
- **Image generation** — new `generate_image` execution type with text-to-image via OpenAI-compatible APIs (gpt-image-1 default); images stored in MongoDB `generated_images` collection with 90-day TTL; optional KB-enriched prompts (vector search → evaluator filtering → LLM rewriting); new `imageGeneration` model role; inline image rendering in chat UI
- **GitHub Hub** — MongoDB-cached view of org-wide GitHub activity with background sync engine: Octokit with dual rate limiters (REST 5K/hr + Search 30/min token bucket), deterministic epoch-anchored 28-day chunked backfill, hot sync for open PRs, warm sync for org/team membership, contribution aggregation; 7 new MongoDB collections; full UI with PR filtering, contribution charts and leaderboards, team/member browser, sync dashboard (backfill progress, chunk timeline, rate limit gauges, live SSE activity feed, manual triggers), and settings editor
- **GitHub action unification** — all GitHub data access now reads from the MongoDB sync cache; instant queries via `mongoQueries.ts`, inline recaps via `recapService.ts` + LLM provider (no `gh` CLI, no background `github_summary` jobs); PR body caching in sync engine; deleted `queries.ts`, `teamCache.ts`, `formatting.ts`, `ghPrs.ts`, `runGithubSummaryJob.ts`; removed `github_summary` job type
- **KB hierarchical path metadata & contextual chunking** — vector records now store `file_path` and `parent_dir` for each chunk; chunk content is enriched with breadcrumb paths (e.g., `Source: docs > api > auth.md`) before embedding, improving retrieval for queries referencing document structure
- **Streaming ingestion progress** — `POST /api/web/kb/:id/ingest` now supports `Accept: text/x-ndjson` for real-time per-file progress events; new `ingestIntoKBStreaming` async generator yields `file_start`, `file_done`, `file_skip`, `file_error`, and `complete` events as NDJSON
- **Real-time ingestion progress UI** — KBDetail upload section shows all files upfront with per-file status indicators (pending ◦, processing ⟳, done ✓, skipped –, error ✗) that update in real time as streaming events arrive; summary line shows final counts
- **Unified upload dropdown** — single "Upload ▾" button with dropdown menu for selecting files or entire folders; folder upload uses `webkitdirectory` and preserves the relative path hierarchy
- **KB shared utilities** — new `src/shared/kbUtils.ts` with `pathToBreadcrumb()` and `formatPathBreadcrumb()` helpers (with tests)
- **KBPlayground component** — dedicated playground UI for testing KB search queries interactively
- **Research execution type** — new `research` execution type that bridges the YAML-driven routing system to the advanced research pipeline; the `kb_search` action lets the LLM select a strategy (`simple`/`deep`/`agent`) per query
  - New `kb_search` action in `routing-config.yaml` for KB-powered question answering
  - Strategy resolution: LLM-selected strategy > YAML `default_strategy` > `"simple"`
  - Configurable per-action: `scopes`, `default_strategy`, `show_trace`, `timeout_ms`
  - Separate `kb_research_strategy` field in routing config controls background KB context injection for every chat/Slack message
- **YAML-driven routing config** — `routing-config.yaml` controls LLM action routing: system prompt, model, per-action parameters, execution types, and reply templates; auto-generated with sensible defaults if missing
- **Routing config visual editor** — new Routing tab in the web UI with structured editors for all 13 execution types (ParameterListEditor, ExecutionEditor with type-aware fields, ReplyTemplatesEditor), plus raw YAML fallback view
- **Routing config API** — `GET/PUT /api/web/routing-config` and `POST /api/web/routing-config/reload` for reading, saving, and hot-reloading the routing config
- **Worker management system** — spawn, monitor, and shut down worker processes from the web UI
  - In-memory worker registry on the server with 60s stale detection
  - WebSocket server (`/api/worker/ws`) for real-time log streaming and command dispatch
  - Worker registration on startup, status reporting per loop, deregistration on shutdown
  - Claude output teed to server via WebSocket for live viewing
  - Web UI: Workers tab with health dashboard, per-loop status, live log terminal, spawn modal
  - SSE endpoint for streaming worker logs to the browser
- **Chat / conversation system** — web UI chat interface using the same LLM routing as Slack
  - MongoDB-backed conversation storage with message history
  - Job status updates pushed into linked conversations
  - LLM-generated conversation titles
- **Respond to PR comments** job type — reads unresolved review threads, fixes each with Claude, commits, pushes, replies
  - `ghComments.ts` for GitHub GraphQL thread fetching and replying
  - `runRespondToComments.ts` for the per-thread pipeline
  - Web UI and Slack support for creating respond-to-comments jobs
- **PR dashboard** — web UI tab listing open PRs across registered repos with review thread stats
  - TTL-cached GitHub GraphQL queries to avoid API rate limits
- **Cost tracking** — per-session token counts and estimated USD cost from Claude API pricing
  - `modelPricing.ts` with pricing lookup for Anthropic models
  - `JobMetrics` with `claude.sessions[]`, `total_cost_usd`, per-phase breakdown
- **Waiting for approval** status — draft PR creation with `WAITING_FOR_APPROVAL` status and promote-PR endpoint
- **Repo registry editor** — edit `repo-registry.yaml` directly from the web UI
- **Worktree status dashboard** — web UI view of worktree slot lock status
- **Job requeue with backoff** — `POST /requeue` endpoint for when no worktree slot is available
- MIT license
- Biome linter and formatter with project-specific rules
- Husky pre-commit hooks with lint-staged (auto-lint on commit)
- Vitest test runner with unit tests for shared utilities
- GitHub Actions CI workflow (lint, typecheck, test, build)
- SECURITY.md with responsible disclosure guidelines
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
- GitHub issue templates (bug report, feature request) and PR template
- `.editorconfig` for consistent editor settings
- `.nvmrc` for Node.js version pinning
- `engines` field in package.json enforcing Node >= 20

### Changed

- Expanded `.gitignore` with common Node/TS/macOS patterns
- Auto-formatted entire codebase with Biome
- Decoupled PR stats fetching from job polling to avoid GitHub API rate limit exhaustion
- Web UI expanded from single-page to tabbed layout (Chats, Jobs, GitHub, Workers, Repos, Knowledge, Research, Routing, Models)
- `KBSearchResult.score` now preserves original similarity/BM25 score; new `rrf_score` field stores the RRF score when returned from hybrid search
- GitHub queries no longer shell out to `gh` CLI; all data reads from the MongoDB sync cache
- Recaps execute inline on the server using the LLM provider instead of spawning background `github_summary` worker jobs

### Fixed

- **Worker process cleanup** — spawned workers now use detached process groups (`detached: true` + `process.kill(-pid)`) so both the `tsx` wrapper and its `node` grandchild are reliably killed on shutdown
- **Fatal error cleanup** — `shutdownAllWorkers()` is now called in the server's fatal error handler to prevent orphaned worker processes on crashes
- **Draft PRs excluded from team review requests** — `teamReviewRequests` query now includes `-draft:true` so draft PRs don't appear in "who has outstanding reviews" results

## [0.1.0] - 2025-06-01

### Added

- Initial release
- Server: Express v5 HTTP API + Slack Socket Mode bot
- Worker: Configurable pool of Claude Code CLI executors
- Web UI: React + Vite SPA for job management
- MongoDB-backed job queue with lease-based concurrency
- LLM-powered Slack message routing (Anthropic / OpenAI-compatible)
- Slack thread context fetching and file attachment support
- Worktree pool for efficient git workspace management
- GitHub Actions and Jenkins CI provider support
- Repo registry with keyword-based auto-detection
