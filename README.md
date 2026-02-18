# Son of Steve 🤖

[![CI](https://github.com/svitali/son-of-steve/actions/workflows/ci.yml/badge.svg)](https://github.com/svitali/son-of-steve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

An internal coding agent tool: Slack mentions queue jobs to MongoDB, local Claude Code CLI workers execute them end-to-end (worktree → code → test → PR → CI), and a web dashboard provides visibility and control.

## Quick Start

### Prerequisites

- **Node.js 20+**
- **MongoDB** (local or Atlas)
- **GitHub CLI** (`gh`) authenticated (`gh auth login`)
- **Claude Code CLI** (`claude`) installed and configured
- A **Slack App** with Socket Mode (see below)

### 1. Install Dependencies

```bash
cd ~/son-of-steve
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values (see below)
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

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.
2. Under **Socket Mode**, enable it. Generate an **App-Level Token** with `connections:write` scope → this is your `SLACK_APP_TOKEN` (`xapp-...`).
3. Under **Event Subscriptions**:
   - **Toggle "Enable Events" to ON** (this is off by default and easy to miss!)
   - Under "Subscribe to bot events", click "Add Bot User Event" and add `app_mention`
   - Save changes
   - **Security note**: Only subscribe to `app_mention`. Do **not** add `message.channels` or `message.groups` — the bot should only receive messages where it is explicitly @-mentioned. Thread context is fetched via API call when needed, not via event subscriptions.
4. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `app_mentions:read` — receive @-mentions
   - `chat:write` — post replies
   - `channels:history` — fetch thread messages in public channels (used when @-mentioned in a thread to read prior context)
   - `groups:history` — fetch thread messages in private channels
   - `files:read` — **(required for attachments)** download files attached to Slack messages (screenshots, logs, etc.)
   - `users:read` — **(recommended)** resolve Slack user IDs to display names in the UI
5. Install the app to your workspace. Copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN` (`xoxb-...`).
6. Find the bot's user ID (choose one method):
   - **Via API** (easiest): `curl -s -H "Authorization: Bearer xoxb-YOUR-TOKEN" https://slack.com/api/auth.test | jq .user_id`
   - **Via Slack UI**: Click on your bot in a channel → "View app details" → copy the member ID
   - This is your `SLACK_BOT_USER_ID` (`U...`).
7. **Invite the bot** to any channels where you want to @-mention it.

### Finding Your Slack User ID

Click your name in Slack → "Profile" → "⋯" → "Copy member ID". This is the `SOS_REQUESTED_BY_SLACK_USER` for the worker.

### LLM-Powered Message Routing (Optional)

By default, every @-mention of the bot creates a new coding job. If you configure an LLM provider, the bot instead routes messages through an LLM ("Steve" — a snarky staff engineer persona) that classifies intent before acting:

| Intent | Example | What happens |
|--------|---------|--------------|
| Coding task | "fix the login bug in auth module" | Creates a job |
| Status check | "what's the status of abc123?" | Looks up the job and replies |
| Cancel | "cancel that last job" | Cancels the job |
| Retry | "retry abc123" | Re-queues a failed job |
| List | "show me recent jobs" | Lists recent jobs |
| Chat | "hey what can you do?" | Responds conversationally |

Son of Steve supports **two LLM provider backends** for message routing. Choose whichever fits your setup:

#### Option A: Anthropic API (default)

Best for open-source / individual users. Calls the Anthropic API directly.

```bash
# .env
SOS_LLM_PROVIDER=anthropic                     # optional, this is the default
SOS_LLM_MODEL=claude-sonnet-4-20250514       # optional, this is the default
SOS_LLM_API_KEY=sk-ant-...                      # or set ANTHROPIC_API_KEY
```

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. Add the key to your `.env` as shown above
3. Restart the server

#### Option B: OpenAI-Compatible / LiteLLM

Best for teams that run a shared LLM proxy (e.g., [LiteLLM](https://docs.litellm.ai/)). Works with any service that exposes the OpenAI Chat Completions API with tool calling support.

```bash
# .env
SOS_LLM_PROVIDER=openai_compatible
SOS_LLM_MODEL=anthropic/claude-sonnet-4-20250514   # model string your proxy expects
SOS_LLM_BASE_URL=https://litellm.example.com       # your LiteLLM / OpenAI-compatible endpoint
SOS_LLM_API_KEY=your-bearer-token                   # sent as Authorization: Bearer <token>
```

The API key is sent via the standard `Authorization: Bearer <token>` header. Check with your proxy admin for the correct model string and endpoint URL.

#### No LLM Key

Without any key, the bot still works — it just treats every @-mention as a job creation request (the original behavior).

### Thread Context & File Attachments

When someone @-mentions the bot in a Slack thread, the bot automatically:

1. **Fetches thread history** — reads up to `SOS_MAX_THREAD_MESSAGES` (default 20) prior messages for context
2. **Downloads file attachments** — images, logs, configs, etc. attached to thread messages, newest-first up to `SOS_MAX_ATTACHMENT_SIZE_MB` (default 10MB)
3. **Sends images to the routing LLM** — the LLM can "see" screenshots via vision, helping it understand UI bugs and generate better task descriptions
4. **Passes all files to the worker** — every attachment (regardless of type) is stored in the job document and written to `.sonofsteve/attachments/` in the worktree so Claude Code can inspect them

```bash
# .env (optional — these are the defaults)
SOS_MAX_THREAD_MESSAGES=20        # max thread messages to fetch for context
SOS_MAX_ATTACHMENT_SIZE_MB=10     # max total file size per job (newest files preferred)
```

> **Note:** File downloads require the `files:read` OAuth scope on your Slack bot. See step 4 in the Slack App Setup above.

---

## Environment Variables

### Server (.env)

| Variable | Required | Description |
|---|---|---|
| `SOS_SERVER_PORT` | No (default: 3000) | HTTP port |
| `SOS_INTERNAL_API_TOKEN` | **Yes** | Shared secret for worker ↔ server auth |
| `MONGO_URI` | **Yes** | MongoDB connection string |
| `MONGO_DB` | No (default: `son_of_steve`) | Database name |
| `SLACK_APP_TOKEN` | **Yes** | Socket Mode app token (`xapp-...`) |
| `SLACK_BOT_TOKEN` | **Yes** | Bot OAuth token (`xoxb-...`) |
| `SLACK_BOT_USER_ID` | **Yes** | Bot's Slack user ID (`U...`) |
| `SOS_LLM_PROVIDER` | No (default: `anthropic`) | LLM provider: `anthropic` or `openai_compatible` ([setup](#llm-powered-message-routing-optional)) |
| `SOS_LLM_MODEL` | No (default: `claude-sonnet-4-20250514`) | Model name/string for the LLM provider |
| `SOS_LLM_API_KEY` | No | API key for the LLM provider. Falls back to `ANTHROPIC_API_KEY` if not set. |
| `SOS_LLM_BASE_URL` | Only for `openai_compatible` | Base URL for OpenAI-compatible endpoint (e.g., LiteLLM proxy) |
| `SOS_SLACK_JOB_OWNER` | No | The `requested_by` value to assign to Slack-created jobs (defaults to `SOS_REQUESTED_BY_SLACK_USER`). Must match the worker's `SOS_REQUESTED_BY_SLACK_USER` so workers claim Slack jobs. The original Slack user is stored separately for attribution. |
| `SOS_MAX_THREAD_MESSAGES` | No (default: 20) | Max Slack thread messages to fetch for context when @-mentioned in a thread |
| `SOS_MAX_ATTACHMENT_SIZE_MB` | No (default: 10) | Max total file attachment size (MB) per job. Files collected newest-first; oldest dropped when limit reached. |
| `JOB_DEFAULT_LEASE_SECONDS` | No (120) | Default lease duration |
| `JOB_MAX_RUNTIME_MINUTES` | No (60) | Max job runtime |
| `JOB_MAX_CI_FIX_ATTEMPTS` | No (2) | Max CI fix iterations |
| `WEB_BASIC_AUTH_USER` | No | Optional basic auth for web UI |
| `WEB_BASIC_AUTH_PASS` | No | Optional basic auth for web UI |

### Worker (.env, same file)

| Variable | Required | Description |
|---|---|---|
| `SOS_API_BASE_URL` | **Yes** | Server URL (e.g., `http://localhost:3000`) |
| `SOS_INTERNAL_API_TOKEN` | **Yes** | Same token as server |
| `SOS_REQUESTED_BY_SLACK_USER` | **Yes** | Your Slack user ID |
| `SOS_NODE_ID` | No (default: `local`) | Identifier for this machine |
| `SOS_WORKERS` | No (default: 4) | Number of concurrent worker loops |
| `SOS_POLL_INTERVAL_SECONDS` | No (10) | Poll interval |
| `SOS_LEASE_SECONDS` | No (120) | Lease duration per claim |
| `SOS_WORKSPACE_ROOT` | **Yes** | Directory for clones/worktrees |
| `SOS_REPO_REGISTRY` | **Yes** | Path to `repo-registry.yaml` |
| `SOS_MAX_CI_FIX_ATTEMPTS` | No (2) | Max CI fix attempts |
| `SOS_MAX_RUNTIME_MINUTES` | No (60) | Max job runtime |
| `SOS_REQUIRE_LOCAL_TESTS_BEFORE_PR` | No (true) | Require local tests pass before PR |
| `SOS_TEST_LEVEL_DEFAULT` | No (`fast`) | Default test level: `fast`/`full`/`none` |

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
```

The worker resolves which repo to use based on:
1. Explicit `repo=<id>` hint in the task
2. Keyword matching against `detect.keywords`

---

## Architecture

```
Slack ──Socket Mode──▶ sos-server ◀──HTTP──▶ sos-worker (N loops)
                           │                      │
                           ▼                      ▼
                        MongoDB             Claude Code CLI
                           ▲                  git / gh
                           │
                        Web UI
```

- **Server**: Receives Slack events, manages jobs in Mongo, posts Slack updates, serves API + web UI
- **Workers**: Poll for jobs, claim with lease, run Claude Code, commit/push/PR, monitor CI
- **Web UI**: React SPA for listing, viewing, creating, and managing jobs

### Job Lifecycle

```
QUEUED → RUNNING → (FIXING_CI →)* DONE
                                   ↘ FAILED
                                   ↘ CANCELED
```

### Lease-Based Claims

Workers claim jobs atomically with a lease. Heartbeats extend the lease. If a worker crashes, the lease expires and another worker can reclaim the job.

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
