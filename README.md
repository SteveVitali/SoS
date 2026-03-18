# Son of Steve 🤖

[![CI](https://github.com/svitali/son-of-steve/actions/workflows/ci.yml/badge.svg)](https://github.com/svitali/son-of-steve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

Son of Steve is a **self-hosted coding agent orchestrator**. Point it at your repos, mention it in Slack or Discord (or use the web UI), and it autonomously writes code, runs tests, opens PRs, monitors CI, and fixes failures — all on your own machine. It also provides persistent knowledge bases with advanced hybrid retrieval and multi-strategy RAG research, a GitHub analytics hub, and LLM-powered conversational interfaces. Your code and data never leave your infrastructure.

### Why Son of Steve?

- **Local-first** — runs on your machine; code never sent to a third-party cloud
- **Full pipeline** — not just code generation: lint → test → self-review → commit → PR → CI → auto-fix CI failures
- **PR comment review** — point it at any PR and it reads unresolved review threads, fixes each one, pushes, and replies
- **Slack & Discord native** — LLM-powered intent routing turns @-mentions into jobs, status checks, cancellations, or conversation on both platforms
- **Chat interface** — conversational web UI with the same LLM routing as Slack/Discord, including job creation, status checks, and inline image generation
- **Multi-repo** — a repo registry with per-repo commands, CI providers, and keyword-based detection
- **Enterprise-ready** — worktree pooling with build cache preservation for large monorepos (Bazel, etc.)
- **Worker management** — spawn, monitor, and shut down worker processes from the web UI with live log streaming
- **Persistent memory** — learns from every interaction (chat, research, jobs, GitHub queries), extracts facts via LLM, builds user profiles, and self-organizes with periodic reflection; memories are injected into future conversations alongside KB context
- **Knowledge bases** — upload documents (text, PDF, archives) or entire folders, chunk and embed them locally with hierarchical path metadata, and inject relevant context into LLM calls; real-time per-file ingestion progress
- **Hybrid search** — vector similarity (LanceDB) + keyword search (SQLite FTS5) merged via Reciprocal Rank Fusion; keyword-only hits get full metadata for rich results even without vector matches
- **Advanced research pipeline** — multi-stage RAG with three strategy profiles (simple/deep/agent): LLM-driven query analysis and decomposition, HyDE expansion, CRAG evaluation, IRCoT iterative reasoning, and a ReAct research agent with keyword search tool — all with full audit logging, NDJSON streaming, and a Research Playground UI
- **RAPTOR tree indexing** — recursive clustering and LLM summarization of KB chunks for hierarchical retrieval at multiple abstraction levels; interactive tree visualization in the UI
- **Image generation** — text-to-image via OpenAI-compatible APIs with optional KB-enriched prompts (vector search → evaluator filtering → LLM rewriting)
- **GitHub Hub** — MongoDB-cached view of your org's GitHub activity with background sync: deterministic chunked backfill, contribution charts and leaderboards, team/member browser, sync dashboard with rate limit gauges and live activity feed, all configurable from the UI
- **Observable** — web dashboard with job timeline, PR stats, worker health, live Claude output, and Slack thread updates
- **Crash-safe** — lease-based job claims with automatic recovery when workers crash
- **Cost tracking** — per-session token counts and estimated USD cost from Claude API pricing

---

## How It Works

```
Slack ──Socket Mode──▶ sos-server ◀──HTTP+WS──▶ sos-worker (N loops)
Discord ──Gateway──▶       │                        │
                           ▼                        ▼
                        MongoDB               Claude Code CLI
                       LanceDB (vectors)        git / gh
                       SQLite FTS5 (keywords)
                           ▲
                           │
                     Web UI (React)
```

1. You **@-mention the bot** in Slack or Discord (or create a job via the web UI)
2. An LLM classifies your intent — coding task, status check, cancel, retry, or just chat
3. Coding tasks are **queued in MongoDB** and a worker claims the job with a lease
4. The worker **resolves the repo** from the registry, prepares a git worktree, and runs **Claude Code CLI**
5. After Claude finishes, the worker runs **lint and tests**, then feeds the diff through a **self-review pass** (a second Claude invocation acting as a Staff Engineer code reviewer)
6. Changes are **committed, pushed, and a PR is opened** via `gh` CLI
7. The worker **monitors CI** and, if it fails, runs a **bounded fix loop** — Claude reads the failure, fixes the code, pushes, and re-checks CI
8. **Slack/Discord thread updates** are posted at every stage: queued, claimed, PR created, CI status, done/failed

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, data flow, and key decisions.

---

## How Is This Different?

The AI coding agent space is crowded. Here's where Son of Steve fits:

| | Son of Steve | GitHub Copilot Coding Agent | Devin / Factory | OpenHands | Aider |
|---|---|---|---|---|---|
| **Hosting** | Self-hosted, local | GitHub cloud | Cloud SaaS | Self-hosted (Docker) | Local CLI |
| **Interface** | Slack + Web UI + Chat | GitHub Issues / Slack | Web IDE / Slack | Web UI | Terminal (interactive) |
| **Full pipeline** (test → PR → CI → fix) | ✅ | Partial | ✅ | ❌ | ❌ |
| **Self-review pass** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **CI fix loop** | ✅ (bounded, configurable) | ❌ | Varies | ❌ | ❌ |
| **Persistent memory** | ✅ (learns from interactions, user profiles) | ❌ | ❌ | ❌ | ❌ |
| **Knowledge bases + RAG** | ✅ (hybrid search, RAPTOR, research agent) | ❌ | ❌ | ❌ | ❌ |
| **Worktree pooling / build cache** | ✅ | ❌ (ephemeral runners) | ❌ | ❌ | ❌ |
| **Custom CI providers** | Pluggable (GH Actions, Jenkins, …) | GitHub Actions only | Proprietary | N/A | N/A |
| **Multi-repo registry** | ✅ | One repo per task | Varies | ❌ | One repo at a time |
| **Code leaves your machine** | Never | Yes | Yes | Optional | Never |
| **Cost model** | Your compute + LLM API | Per-seat + Actions minutes | Per-seat SaaS | Your compute | Your compute + LLM API |

**In short:** Son of Steve is for teams that want an all-in-one AI engineering platform — autonomous coding with full CI integration, persistent knowledge bases with advanced retrieval, GitHub analytics, and conversational interfaces — running entirely on their own infrastructure.

---

## Quick Start

### Prerequisites

- **Node.js 20+**
- **MongoDB** (local or Atlas)
- **GitHub CLI** (`gh`) authenticated (`gh auth login`)
- **Claude Code CLI** (`claude`) installed and configured
- A **Slack App** with Socket Mode (optional — see [docs/SLACK_SETUP.md](docs/SLACK_SETUP.md))
- A **Discord Bot** (optional — see [docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md))

### 1. Install Dependencies

```bash
cd ~/son-of-steve
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values — see docs/CONFIGURATION.md for the full reference
```

### 3. Set Up Repo Registry

```bash
cp repo-registry.example.yaml repo-registry.yaml
# Edit repo-registry.yaml with your actual repos
```

### 4. Build the Web UI

```bash
npm run build:ui
```

### 5. Run

```bash
# Terminal 1: Start server (HTTP API + Slack Socket Mode)
npm run server

# Terminal 2: Start worker pool
npm run worker
```

Or run both together:
```bash
npm run dev
```

The web UI is available at `http://localhost:3000` (or `http://localhost:5173` in dev mode with hot reload via `npm run dev:ui`).

---

## Usage

### Via Slack / Discord

Mention the bot in any Slack or Discord channel. Messages are routed through an LLM ("Steve" persona) that classifies intent and responds conversationally. Both platforms support the same commands:

```
@SonOfSteve fix the broken unit test in the auth module
@SonOfSteve what's the status of abc123?
@SonOfSteve cancel that last job
@SonOfSteve list recent jobs
@SonOfSteve retry abc123
@SonOfSteve hey what can you do?
```

GitHub queries (reads from the MongoDB sync cache; configure `SOS_GITHUB_ORG` and `SOS_GITHUB_TEAM_SLUG`):

```
@SonOfSteve what PRs need my review?
@SonOfSteve what are my open PRs?
@SonOfSteve what did I merge this week?
@SonOfSteve what's the team working on?
@SonOfSteve who has outstanding reviews on the team?
@SonOfSteve give me my weekly recap          (inline LLM recap from cached data)
@SonOfSteve team recap for the last 2 weeks  (inline LLM recap from cached data)
```

Optional modifiers (for job creation):

```
@SonOfSteve repo=my-api tests=full ci_fix=on review=@alice fix the login endpoint
```

The bot will:
1. Route your message through the LLM to determine intent
2. Execute the appropriate action (create job, check status, cancel, retry, or just chat)
3. Reply in-thread with a natural language response
4. For coding tasks: a worker claims the job and posts progress (claimed, PR created, CI status, done/failed)

See [docs/SLACK_SETUP.md](docs/SLACK_SETUP.md) for Slack setup and [docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md) for Discord setup. Both share the same LLM routing configuration and thread context / file attachment capabilities.

### Via Web UI

1. Open `http://localhost:3000`
2. Enter your `SOS_INTERNAL_API_TOKEN`
3. Use the dashboard:
   - **Chats** — conversational interface with the same LLM routing as Slack
   - **Jobs** — create, view, cancel, retry, or delete jobs; full event timeline with cost metrics
   - **GitHub** — GitHub Hub dashboard: cached PRs with filtering, contribution charts and leaderboards, team/member browser, sync dashboard (backfill progress, chunk timeline, rate limit gauges, SSE activity feed, manual triggers), and settings editor
   - **Workers** — monitor worker health, view live Claude output, spawn new workers, shut down existing ones
   - **Repos** — edit the repo registry (YAML) directly from the browser
   - **Knowledge** — create knowledge bases, upload documents or folders (with real-time progress), test semantic search in the playground, configure scopes and chunking, RAPTOR tree visualization and build management
   - **Memory** — browse and search persistent memories (facts, reflections, user profiles), view interaction episodes with extracted memories and feedback signals, manually edit or invalidate memories, trigger reflection, configure memory system parameters
   - **Research** — global research config (chat/Slack strategy, max context tokens), Research Playground (run queries with simple/deep/agent strategies, real-time pipeline timeline, model selector), Strategy Comparison (side-by-side benchmark), Research History (session browser with timeline drill-down)
   - **Routing** — visual editor for LLM action routing config (parameters, execution types, reply templates) with raw YAML fallback
   - **Models** — view and override model assignments for all roles with autocomplete from available models

---

## Repo Registry

Define your repos in `repo-registry.yaml`:

```yaml
repos:
  my-app:
    clone: "git@github.com:yourorg/my-app.git"
    default_branch: "main"
    detect:
      keywords: ["my-app", "frontend", "react"]
    commands:
      lint: ["npm", "run", "lint"]
      test_fast: ["npm", "test"]
      test_full: ["npm", "run", "test:full"]
    pr:
      reviewers_default: ["alice"]
    ci:
      provider: "github_actions"
    max_worktrees: 2          # concurrent worktree slots (default: 1)
    clean_mode: "light"       # "light" preserves .gitignore'd build caches; "full" cleans everything
```

The worker resolves which repo to use based on:
1. Explicit `repo=<id>` hint in the task
2. Keyword matching against `detect.keywords`

---

## Job Types

| Type | Description |
|---|---|
| `create` (default) | Full pipeline: resolve repo → worktree → Claude → lint/test → self-review → commit → PR → CI → fix CI |
| `respond_to_pr_comments` | Read unresolved PR review threads → Claude fixes each → commit → push → reply to threads |
| `self_review_pr` | Check out an existing PR branch → Claude self-review pass → fix issues → push |
| `add_pr_review_comments` | Review a PR → post inline review comments on GitHub as the bot |

## Job Lifecycle

```
QUEUED → RUNNING → WAITING_FOR_APPROVAL → DONE
  ↓              → (FIXING_CI →)*          ↗
BLOCKED                           ↘ FAILED
                                   ↘ CANCELED

Planning flow (complex tasks):
QUEUED → PLANNING → PENDING_CONFIRMATION → QUEUED → (normal flow)
```

Workers claim jobs atomically with a lease. Heartbeats extend the lease every 15 seconds. If a worker crashes, the lease expires and another worker reclaims the job on the next poll cycle.

---

## Roadmap

- **Jenkins CI provider** — complete the existing stub for Jenkins-based repos
- **Human-in-the-loop approval** — full UI flow for the existing `WAITING_FOR_APPROVAL` status (show diff, approve/reject)
- **Worker cancellation checks** — honor cancel requests mid-execution before expensive steps
- **Cost budgets** — per-user/team spending limits based on the existing per-job cost tracking
- **Multi-model executors** — plug in Aider, OpenHands, or custom scripts alongside Claude Code

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — system design, data flow, key decisions
- **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** — full environment variable reference
- **[docs/SLACK_SETUP.md](docs/SLACK_SETUP.md)** — Slack app creation, LLM routing, thread context & attachments
- **[docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md)** — Discord bot creation, gateway intents, invite setup
- **[docs/API.md](docs/API.md)** — HTTP API reference for worker and web endpoints
- **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** — development setup, conventions, and how to add features
- **[docs/RESEARCH_PIPELINE_DESIGN.md](docs/RESEARCH_PIPELINE_DESIGN.md)** — advanced RAG research pipeline design (strategies, stages, RAPTOR, agent, audit logging)
- **[docs/GITHUB_HUB_DESIGN.md](docs/GITHUB_HUB_DESIGN.md)** — GitHub Hub sync engine design (chunked backfill, rate limiting, MongoDB cache, REST API)

---

## Troubleshooting

### Slack not receiving events
- Verify Socket Mode is enabled in your Slack app settings
- Check `SLACK_APP_TOKEN` is an app-level token (`xapp-...`), not a bot token
- Ensure the bot is invited to the channel where you mention it
- Check server logs for connection errors

### Discord bot not responding
- Verify **Message Content Intent** is enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents)
- Check `DISCORD_BOT_TOKEN` is set and the token is valid (not expired/regenerated)
- Ensure the bot has `Send Messages` and `Read Message History` permissions in the channel
- Check server logs for "Discord bot gateway connected" or connection errors

### MongoDB connection issues
- Verify `MONGO_URI` is correct
- For local: ensure `mongod` is running
- For Atlas: check network access / IP whitelist

### GitHub CLI auth
- Run `gh auth login` and authenticate
- Run `gh auth status` to verify

### Worker not picking up jobs
- Check `SOS_REQUESTED_BY_SLACK_USER` matches the Slack user who created the job
- Verify `SOS_INTERNAL_API_TOKEN` matches between server and worker
- Check worker logs for poll/claim errors
- Open the **Workers** tab in the web UI to verify the worker is registered and online

### Worktree cleanup
Worktrees are not auto-deleted. To clean up:
```bash
# List worktrees for a clone
cd /path/to/workspace/clones/my-app
git worktree list

# Remove a specific worktree
git worktree remove /path/to/worktree --force

# Prune stale worktree refs
git worktree prune
```
