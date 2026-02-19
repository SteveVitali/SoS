# Son of Steve 🤖

[![CI](https://github.com/svitali/son-of-steve/actions/workflows/ci.yml/badge.svg)](https://github.com/svitali/son-of-steve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

Son of Steve is a **self-hosted coding agent orchestrator**. Point it at your repos, mention it in Slack (or use the web UI), and it autonomously writes code, runs tests, opens PRs, monitors CI, and fixes failures — all on your own machine. Your code never leaves your infrastructure.

### Why Son of Steve?

- **Local-first** — runs on your machine; code never sent to a third-party cloud
- **Full pipeline** — not just code generation: lint → test → self-review → commit → PR → CI → auto-fix CI failures
- **Slack-native** — LLM-powered intent routing turns @-mentions into jobs, status checks, cancellations, or conversation
- **Multi-repo** — a repo registry with per-repo commands, CI providers, and keyword-based detection
- **Enterprise-ready** — worktree pooling with build cache preservation for large monorepos (Bazel, etc.)
- **Observable** — web dashboard with full event timeline, Slack thread updates at every lifecycle stage
- **Crash-safe** — lease-based job claims with automatic recovery when workers crash

---

## How It Works

```
Slack ──Socket Mode──▶ sos-server ◀──HTTP──▶ sos-worker (N loops)
                           │                      │
                           ▼                      ▼
                        MongoDB             Claude Code CLI
                           ▲                  git / gh
                           │
                        Web UI
```

1. You **@-mention the bot** in Slack (or create a job via the web UI)
2. An LLM classifies your intent — coding task, status check, cancel, retry, or just chat
3. Coding tasks are **queued in MongoDB** and a worker claims the job with a lease
4. The worker **resolves the repo** from the registry, prepares a git worktree, and runs **Claude Code CLI**
5. After Claude finishes, the worker runs **lint and tests**, then feeds the diff through a **self-review pass** (a second Claude invocation acting as a Staff Engineer code reviewer)
6. Changes are **committed, pushed, and a PR is opened** via `gh` CLI
7. The worker **monitors CI** and, if it fails, runs a **bounded fix loop** — Claude reads the failure, fixes the code, pushes, and re-checks CI
8. **Slack thread updates** are posted at every stage: queued, claimed, PR created, CI status, done/failed

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, data flow, and key decisions.

---

## How Is This Different?

The AI coding agent space is crowded. Here's where Son of Steve fits:

| | Son of Steve | GitHub Copilot Coding Agent | Devin / Factory | OpenHands | Aider |
|---|---|---|---|---|---|
| **Hosting** | Self-hosted, local | GitHub cloud | Cloud SaaS | Self-hosted (Docker) | Local CLI |
| **Interface** | Slack + Web UI | GitHub Issues / Slack | Web IDE / Slack | Web UI | Terminal (interactive) |
| **Full pipeline** (test → PR → CI → fix) | ✅ | Partial | ✅ | ❌ | ❌ |
| **Self-review pass** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **CI fix loop** | ✅ (bounded, configurable) | ❌ | Varies | ❌ | ❌ |
| **Worktree pooling / build cache** | ✅ | ❌ (ephemeral runners) | ❌ | ❌ | ❌ |
| **Custom CI providers** | Pluggable (GH Actions, Jenkins, …) | GitHub Actions only | Proprietary | N/A | N/A |
| **Multi-repo registry** | ✅ | One repo per task | Varies | ❌ | One repo at a time |
| **Code leaves your machine** | Never | Yes | Yes | Optional | Never |
| **Cost model** | Your compute + Claude API | Per-seat + Actions minutes | Per-seat SaaS | Your compute | Your compute + LLM API |

**In short:** Son of Steve is for teams that want autonomous AI coding with full CI integration, but need their code to stay on their own infrastructure — especially teams with monorepos, custom CI pipelines, and Slack-centric workflows.

---

## Quick Start

### Prerequisites

- **Node.js 20+**
- **MongoDB** (local or Atlas)
- **GitHub CLI** (`gh`) authenticated (`gh auth login`)
- **Claude Code CLI** (`claude`) installed and configured
- A **Slack App** with Socket Mode (optional — see [docs/SLACK_SETUP.md](docs/SLACK_SETUP.md))

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

### Via Slack

Mention the bot in any channel. Messages are routed through an LLM ("Steve" persona) that classifies intent and responds conversationally:

```
@SonOfSteve fix the broken unit test in the auth module
@SonOfSteve what's the status of abc123?
@SonOfSteve cancel that last job
@SonOfSteve list recent jobs
@SonOfSteve retry abc123
@SonOfSteve hey what can you do?
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

See [docs/SLACK_SETUP.md](docs/SLACK_SETUP.md) for Slack app creation, LLM routing configuration, and thread context / file attachment details.

### Via Web UI

1. Open `http://localhost:3000`
2. Enter your `SOS_INTERNAL_API_TOKEN`
3. Use the dashboard to create, view, cancel, retry, or delete jobs

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

## Job Lifecycle

```
QUEUED → RUNNING → (FIXING_CI →)* DONE
                                   ↘ FAILED
                                   ↘ CANCELED
```

Workers claim jobs atomically with a lease. Heartbeats extend the lease every 15 seconds. If a worker crashes, the lease expires and another worker reclaims the job on the next poll cycle.

---

## Roadmap

- **Jenkins CI provider** — complete the existing stub for Jenkins-based repos
- **Human-in-the-loop approval** — pause before PR, show diff in Slack/web, wait for sign-off (`WAITING_FOR_APPROVAL` status)
- **Worker cancellation checks** — honor cancel requests mid-execution before expensive steps
- **Cost tracking** — Claude API token usage per job, budgets per user/team
- **Multi-model executors** — plug in Aider, OpenHands, or custom scripts alongside Claude Code

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — system design, data flow, key decisions
- **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** — full environment variable reference
- **[docs/SLACK_SETUP.md](docs/SLACK_SETUP.md)** — Slack app creation, LLM routing, thread context & attachments
- **[docs/API.md](docs/API.md)** — HTTP API reference for worker and web endpoints
- **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** — development setup, conventions, and how to add features

---

## Troubleshooting

### Slack not receiving events
- Verify Socket Mode is enabled in your Slack app settings
- Check `SLACK_APP_TOKEN` is an app-level token (`xapp-...`), not a bot token
- Ensure the bot is invited to the channel where you mention it
- Check server logs for connection errors

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
