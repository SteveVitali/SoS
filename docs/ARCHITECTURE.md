# Architecture Guide

> For humans and AI agents working on or with Son of Steve.

## System Overview

Son of Steve is a **local-first coding agent orchestrator**. It receives coding tasks via Slack mentions or a web UI, queues them in MongoDB, and dispatches them to local worker processes that use Claude Code CLI to implement changes end-to-end: resolve repo → create worktree → generate code → lint/test → commit → push → open PR → monitor CI → fix CI failures.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Local Machine                            │
│                                                                 │
│  ┌──────────────┐    HTTP API     ┌──────────────────────────┐  │
│  │  sos-server   │◄──────────────►│  sos-worker (N loops)    │  │
│  │              │                 │                          │  │
│  │  • Express   │                 │  • Poll/claim jobs       │  │
│  │  • Slack Bot │                 │  • Heartbeat leases      │  │
│  │  • Web UI    │                 │  • Claude Code CLI       │  │
│  │  • Mongo     │                 │  • git / gh CLI          │  │
│  └──────┬───────┘                 └──────────────────────────┘  │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │   MongoDB     │ (local or Atlas)                             │
│  │  • jobs col   │                                              │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────┐                                               │
│  │  Slack (WS)   │ Socket Mode — no public URL needed           │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### sos-server (`src/server/`)

The server is the **single source of truth** for job state. It:

1. **Receives Slack `app_mention` events** via Socket Mode (no public endpoint needed)
2. **Creates jobs idempotently** in MongoDB (deduplicated by Slack `event_id`)
3. **Exposes an HTTP API** for workers to poll/claim/heartbeat/update/complete/fail jobs
4. **Exposes an HTTP API** for the web UI to list/view/create/cancel/retry/delete jobs
5. **Posts Slack thread updates** for key lifecycle events (queued, claimed, PR, CI, done/failed)
6. **Serves the React SPA** as static files (production build)

The server **holds all Slack credentials**. Workers never touch Slack directly.

### sos-worker (`src/worker/`)

The worker runs a **configurable pool of independent loops** (default 4). Each loop:

1. **Polls** the server for eligible jobs matching its configured `requested_by` user
2. **Claims** a job atomically with a lease
3. **Heartbeats** to extend the lease during execution
4. **Executes** the full workflow: resolve repo → worktree → Claude → checks → commit → PR → CI
5. **Reports** structured events back to the server (which may trigger Slack updates)
6. **Completes or fails** the job

Workers are **stateless** — all persistent state lives in MongoDB via the server API. If a worker crashes, its lease expires and another worker can reclaim the job.

### MongoDB

Single collection: `jobs`. Stores the full job document including status, lease info, outputs, and an append-only events log.

**Key indexes:**
- `source.event_id` — unique partial (idempotency for Slack events)
- `task_id` — unique (primary lookup key)
- `{ requested_by, status, created_at }` — compound (poll queries)
- `{ status, lease_expires_at }` — compound (reclaim expired leases)

### Web UI (`src/ui/`)

A React + Vite SPA that calls `/api/web/*` endpoints. Authenticated via the same `SOS_INTERNAL_API_TOKEN` (stored in localStorage). Provides:

- Job list with filters (status, user, search)
- Job detail with full event timeline
- Create job form
- Cancel / retry / delete actions

## Job Lifecycle

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
  Slack mention ──► QUEUED ──► RUNNING ──► DONE               │
  Web create ──►      │          │  ▲                         │
                      │          │  │                          │
                      │          ▼  │                          │
                      │      FIXING_CI ────► (back to RUNNING) │
                      │          │                             │
                      ▼          ▼                             │
                   CANCELED    FAILED                          │
                      │          │                             │
                      ▼          ▼                             │
                   (retry creates new QUEUED job)              │
                      │                                        │
                      ▼                                        │
                   DELETED (soft — doc preserved)              │
                    └──────────────────────────────────────────┘
```

### Status Descriptions

| Status | Meaning |
|---|---|
| `QUEUED` | Waiting for a worker to claim |
| `RUNNING` | Claimed and being executed by a worker |
| `FIXING_CI` | Worker is attempting a CI fix iteration |
| `WAITING_FOR_APPROVAL` | Reserved for future use (manual approval flow) |
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

- **Worker ↔ Server**: Bearer token (`SOS_INTERNAL_API_TOKEN`), shared secret
- **Web UI ↔ Server**: Same Bearer token (stored in browser localStorage) OR optional HTTP Basic Auth
- **Server → Slack**: Bot token (`SLACK_BOT_TOKEN`) and App token (`SLACK_APP_TOKEN`)
- **Worker → GitHub**: Relies on local `gh` CLI auth (user must run `gh auth login`)
- **Worker → Claude**: Relies on local `claude` CLI auth

Workers **never** hold Slack tokens. All Slack communication goes through the server.

## Repo Registry

The file `repo-registry.yaml` maps logical repo IDs to git URLs, detection keywords, commands, and CI config.

**Resolution order:**
1. Explicit `repo=<id>` hint in task text → direct lookup
2. Keyword matching: count keyword hits in task text, pick highest score
3. If ambiguous (tie), pick first match and emit warning event

## Event System

Workers emit structured events to the server via `POST /api/worker/jobs/:task_id/events`. Events are:

1. **Stored** in the `jobs.events[]` array (truncated to 10KB per payload)
2. **Used to update job fields** (e.g., `PR_CREATED` adds to `pr_urls`, `WORKTREE_READY` sets `branch_name`)
3. **Selectively forwarded to Slack** for key types: `PR_CREATED`, `CI_FAILED`, `CI_STATUS`, `DONE`, `FAILED`, `CANCELED`

See `src/shared/types.ts` for the full `WorkerEventType` union.

## Directory Structure

```
son-of-steve/
├── src/
│   ├── shared/              # Shared between server and worker
│   │   ├── types.ts         # Zod schemas, JobDoc interface, event types
│   │   ├── time.ts          # Date helpers (nowDate, addSeconds, isExpired)
│   │   ├── slug.ts          # Text slugification for branch names
│   │   └── logger.ts        # Structured JSON logger with secret redaction
│   │
│   ├── server/              # sos-server process
│   │   ├── index.ts         # Entry point: Express + Slack Socket Mode startup
│   │   ├── config.ts        # Environment variable parsing
│   │   ├── mongo.ts         # MongoDB connection + index creation
│   │   ├── auth/
│   │   │   └── internalAuth.ts  # Bearer token + optional Basic Auth middleware
│   │   ├── jobs/
│   │   │   ├── jobModel.ts      # Zod validation schemas for API inputs
│   │   │   ├── jobRepo.ts       # MongoDB queries (CRUD, claim, heartbeat, poll)
│   │   │   ├── jobService.ts    # Business logic orchestrating repo + Slack + events
│   │   │   ├── lease.ts         # Claim + heartbeat helpers
│   │   │   ├── leaseReaper.ts   # Periodic check for stale RUNNING jobs
│   │   │   ├── idempotency.ts   # Slack event deduplication
│   │   │   └── titleGenerator.ts # LLM-based job title generation
│   │   ├── llm/
│   │   │   ├── llmProvider.ts       # LLM provider interface
│   │   │   ├── anthropicProvider.ts # Anthropic API implementation
│   │   │   ├── openaiProvider.ts    # OpenAI-compatible implementation
│   │   │   └── index.ts             # Provider factory
│   │   ├── slack/
│   │   │   ├── socketMode.ts      # Slack Bolt app with Socket Mode
│   │   │   ├── eventHandlers.ts   # app_mention → job creation logic
│   │   │   ├── messageRouter.ts   # LLM-powered intent classification
│   │   │   ├── commandExecutor.ts # Execute routed actions (create, status, cancel, etc.)
│   │   │   ├── slackClient.ts     # Slack Web API posting + thread fetching
│   │   │   ├── userResolver.ts    # Resolve Slack user IDs to display names
│   │   │   └── formatting.ts      # Slack message templates
│   │   └── api/
│   │       ├── router.ts        # Mount worker + web routes with auth
│   │       ├── workerRoutes.ts  # /api/worker/* endpoints
│   │       └── webRoutes.ts     # /api/web/* endpoints
│   │
│   ├── worker/              # sos-worker process
│   │   ├── index.ts         # Entry point: start N worker loops
│   │   ├── config.ts        # Environment variable parsing
│   │   ├── apiClient.ts     # Typed HTTP client for server API
│   │   ├── poller.ts        # Poll → claim → execute → repeat loop
│   │   ├── heartbeat.ts     # Interval-based lease extension manager
│   │   ├── events.ts        # Event emission helper
│   │   └── executor/
│   │       ├── runJob.ts        # Main orchestrator: the full job workflow
│   │       ├── repoRegistry.ts  # YAML registry loader
│   │       ├── repoResolver.ts  # Hint/keyword-based repo resolution
│   │       ├── workspace.ts     # Git clone management (ensureClone)
│   │       ├── worktreePool.ts  # Reusable worktree slot pool (singleton)
│   │       ├── claude.ts        # Claude Code CLI subprocess integration
│   │       ├── git.ts           # Git operations (commit, push, diff)
│   │       ├── pr.ts            # GitHub PR creation via gh CLI
│   │       ├── summarize.ts     # Result summary builder
│   │       └── ci/
│   │           ├── ciProvider.ts     # CI provider interface
│   │           ├── githubActions.ts  # GitHub Actions check polling
│   │           └── jenkins.ts        # Jenkins stub (not yet implemented)
│   │
│   └── ui/                  # React + Vite SPA
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx      # Full SPA: list, detail, create views
│           └── api.ts       # Typed fetch client for /api/web/*
│
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── repo-registry.example.yaml
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
