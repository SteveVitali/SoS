# Configuration Reference

All configuration is via environment variables in a single `.env` file (see `.env.example`).

## Server

| Variable | Required | Description |
|---|---|---|
| `SOS_SERVER_PORT` | No (default: 3000) | HTTP port |
| `SOS_INTERNAL_API_TOKEN` | **Yes** | Shared secret for worker ↔ server auth |
| `MONGO_URI` | No | MongoDB connection string. If not set, built from `MONGO_USERNAME`, `MONGO_PASSWORD`, and `MONGO_HOST` (Atlas defaults). |
| `MONGO_DB` | No (default: `son_of_steve`) | Database name |
| `SLACK_APP_TOKEN` | No | Socket Mode app token (`xapp-...`). Slack is optional — leave blank to disable. |
| `SLACK_BOT_TOKEN` | No | Bot OAuth token (`xoxb-...`). Required if Slack is enabled. |
| `SLACK_BOT_USER_ID` | No | Bot's Slack user ID (`U...`). Required if Slack is enabled. |
| `SOS_LLM_PROVIDER` | No (default: `openai_compatible`) | LLM provider: `anthropic` or `openai_compatible` ([setup](SLACK_SETUP.md#llm-powered-message-routing-optional)) |
| `SOS_LLM_MODEL` | No (default: `claude-opus-4.5`) | Model name/string for the LLM provider |
| `SOS_LLM_API_KEY` | No | API key for the LLM provider. Falls back to `ANTHROPIC_API_KEY` if not set. |
| `SOS_LLM_BASE_URL` | Only for `openai_compatible` | Base URL for OpenAI-compatible endpoint (e.g., LiteLLM proxy) |
| `SOS_SLACK_JOB_OWNER` | No | The `requested_by` value to assign to Slack-created jobs (defaults to `SOS_REQUESTED_BY_SLACK_USER`). Must match the worker's `SOS_REQUESTED_BY_SLACK_USER` so workers claim Slack jobs. The original Slack user is stored separately for attribution. |
| `SOS_MAX_THREAD_MESSAGES` | No (default: 20) | Max Slack thread messages to fetch for context when @-mentioned in a thread |
| `SOS_MAX_ATTACHMENT_SIZE_MB` | No (default: 10) | Max total file attachment size (MB) per job. Files collected newest-first; oldest dropped when limit reached. |
| `JOB_DEFAULT_LEASE_SECONDS` | No (120) | Default lease duration |
| `JOB_HEARTBEAT_SECONDS` | No (15) | Heartbeat interval for lease extension |
| `JOB_MAX_RUNTIME_MINUTES` | No (60) | Max job runtime |
| `JOB_MAX_CI_FIX_ATTEMPTS` | No (2) | Max CI fix iterations |
| `SOS_SLACK_NOTIFY_USER` | No | Always @-mention this Slack user ID in bot messages (for personal notifications) |
| `DISCORD_BOT_TOKEN` | No | Discord bot token. Discord is optional — leave blank to disable. See [DISCORD_SETUP.md](DISCORD_SETUP.md). |
| `DISCORD_BOT_USER_ID` | No | Bot's Discord user ID (same as Application ID). Required if Discord is enabled. |
| `SOS_DISCORD_JOB_OWNER` | No | The `requested_by` value to assign to Discord-created jobs. Must match a worker's `SOS_REQUESTED_BY_SLACK_USER` so workers claim Discord jobs. |
| `SOS_DISCORD_NOTIFY_USER` | No | Always @-mention this Discord user ID in bot messages (for personal notifications) |
| `SOS_GH_BOT_LOGINS` | No (default: `son-of-steve,son-of-steve[bot]`) | Comma-separated GitHub logins to treat as "bot" when computing PR comment stats |
| `SOS_GITHUB_ORG` | No | Default GitHub organization slug for team queries (e.g., `my-company`) |
| `SOS_GITHUB_TEAM_SLUG` | No | Default GitHub team slug for team queries (e.g., `platform-eng`) |
| `SOS_GITHUB_USERNAME` | No | GitHub username for personal queries. Auto-detected via `gh api user` if not set. |
| `SOS_ROUTING_CONFIG` | No | Path to `routing-config.yaml`. Auto-generated with defaults if missing. Falls back to same directory as `SOS_REPO_REGISTRY`. |
| `SOS_MODEL_CONFIG` | No | Path to `model-config.yaml`. Auto-generated with defaults if missing. |
| `SOS_WORKSPACE_ROOT` | No | Directory for clones/worktrees (also used by server for worktree status endpoint) |
| `SOS_REPO_REGISTRY` | No | Path to `repo-registry.yaml` (also used by server for PR listing and registry editor) |
| `WEB_BASIC_AUTH_USER` | No | Optional basic auth for web UI |
| `WEB_BASIC_AUTH_PASS` | No | Optional basic auth for web UI |
| `SOS_WORKER_PROCESSES` | No (default: 4) | Number of worker processes to auto-spawn on server startup |

## GitHub Hub (Sync Engine)

The GitHub Hub feature provides a MongoDB-cached view of your org's GitHub activity with background sync. Configuration uses a three-tier precedence: MongoDB settings (from the UI Settings tab) > environment variables > hardcoded defaults.

| Variable | Required | Description |
|---|---|---|
| `SOS_GITHUB_TOKEN` | Only if GitHub Hub sync is used | GitHub Personal Access Token (classic PAT with `repo` + `read:org` scopes, SSO-authorized). Required for the sync engine. |
| `SOS_GITHUB_ORG` | No (default: `Foursquare`) | GitHub organization slug |
| `SOS_GITHUB_TEAM_SLUG` | No (default: `places-engineering`) | GitHub team slug within the org |
| `SOS_GITHUB_USERNAME` | No | GitHub username for personal queries |
| `SOS_GITHUB_HISTORY_DAYS` | No (default: `365`) | How many days of history to backfill |
| `SOS_GITHUB_CHUNK_DAYS` | No (default: `28`) | Size of each backfill chunk in days |
| `SOS_GITHUB_CHUNK_EPOCH` | No (default: `2024-01-01`) | Epoch anchor date for deterministic chunk boundaries |
| `SOS_GITHUB_SYNC_ENABLED` | No (default: `true`) | Set to `false` to disable background sync |
| `SOS_GITHUB_SYNC_HOT_INTERVAL` | No (default: `600`) | Seconds between hot syncs (open PRs) |
| `SOS_GITHUB_SYNC_WARM_INTERVAL` | No (default: `3600`) | Seconds between warm syncs (org/team membership) |

## Knowledge Base (Embeddings)

| Variable | Required | Description |
|---|---|---|
| `SOS_EMBEDDING_PROVIDER` | No (default: `openai`) | Embedding provider. Currently supports `openai` (works with any OpenAI-compatible API). |
| `SOS_EMBEDDING_MODEL` | No (default: `text-embedding-3-small`) | Embedding model name |
| `SOS_EMBEDDING_API_KEY` | Only if KB is used | API key for the embedding provider. Falls back to `OPENAI_API_KEY` if not set. |
| `SOS_EMBEDDING_BASE_URL` | No | Custom base URL for the embedding API (e.g., a LiteLLM proxy). Defaults to `https://api.openai.com/v1`. |
| `SOS_KB_STORAGE_DIR` | No | Directory for LanceDB vector data and SQLite FTS5 keyword indexes. Defaults to `$SOS_WORKSPACE_ROOT/kb` or `.sos-kb` in the project root. Each KB gets a LanceDB table and a `fts_{kb_id}.sqlite` file in this directory. |

## Research Pipeline (LLM)

The research pipeline uses a separate, typically cheaper LLM for its internal reasoning calls (query analysis, evaluation, reasoning, agent loop). This is independent of the main LLM provider used for Slack/chat routing.

| Variable | Required | Description |
|---|---|---|
| `SOS_RESEARCH_LLM_MODEL` | No (default: `claude-opus-4.5`) | Model for research reasoning calls. Supports any OpenAI-compatible model. |
| `SOS_RESEARCH_LLM_API_KEY` | Only if research pipeline is used | API key for the research LLM. Falls back to `OPENAI_API_KEY` if not set. |
| `SOS_RESEARCH_LLM_BASE_URL` | No (default: `https://api.openai.com/v1`) | Base URL for the research LLM API (e.g., a LiteLLM proxy). |
| `SOS_RESEARCH_LLM_TEMPERATURE` | No (default: `0.0`) | Temperature for research LLM calls. `0.0` for deterministic reasoning. |
| `SOS_RESEARCH_LLM_MAX_TOKENS` | No (default: `2048`) | Max output tokens per research LLM call. |

The model can also be overridden per-session via the Research Playground's model selector or `config_overrides.model` in API calls.

## Model Configuration

Model assignments are centralized in `src/shared/modelConfig.ts`. Each role can be overridden via its dedicated environment variable:

| Variable | Default | Description |
|---|---|---|
| `SOS_LLM_MODEL` | `claude-opus-4.5` | Slack/chat message routing, intent classification, and tool-calling |
| `SOS_TITLE_MODEL` | (inherits `SOS_LLM_MODEL`) | Job and chat conversation title generation |
| `SOS_RESEARCH_LLM_MODEL` | `claude-opus-4.5` | Research pipeline reasoning calls |
| `SOS_RAPTOR_MODEL` | (inherits `SOS_RESEARCH_LLM_MODEL`) | RAPTOR tree cluster summarization |
| `SOS_IMAGE_MODEL` | `gpt-image-1` | Image generation model |
| `SOS_EMBEDDING_MODEL` | `text-embedding-3-small` | Vector embeddings for KB indexing and search |

You can also override model assignments via `model-config.yaml` in the project root. **File overrides take highest precedence** (YAML file > env var > hardcoded default):

```yaml
routing: claude-opus-4.5
titleGeneration: claude-opus-4.5
research: claude-opus-4.5
raptorSummarization: claude-opus-4.5
imageGeneration: gpt-image-1
embedding: text-embedding-3-small
memory: gpt-4.1-mini
```

The active model registry is exposed via `GET /api/web/models` and logged at server startup.

## Memory System

The persistent memory system learns from every interaction (chat, research, jobs, GitHub queries) and injects relevant context into future conversations. Configuration uses environment variables with sensible defaults.

| Variable | Default | Description |
|---|---|---|
| `SOS_MEMORY_ENABLED` | `true` | Enable/disable the entire memory system |
| `SOS_MEMORY_MODEL` | `gpt-4.1-mini` | LLM model for fact extraction, curation, reflection, and evolution |
| `SOS_MEMORY_RETRIEVAL_MAX_MEMORIES` | `8` | Max memories injected into `{MEMORY_CONTEXT}` |
| `SOS_MEMORY_RETRIEVAL_MAX_TOKENS` | `1500` | Token budget for `{MEMORY_CONTEXT}` |
| `SOS_MEMORY_RETRIEVAL_MIN_SCORE` | `0.3` | Minimum composite score for a memory to be included in context |
| `SOS_MEMORY_RECENCY_HALFLIFE_DAYS` | `30` | Half-life (in days) for the recency decay function in composite scoring |
| `SOS_MEMORY_EXTRACTION_MIN_TURNS` | `1` | Minimum conversation turns before extraction triggers |
| `SOS_MEMORY_EXTRACTION_SKIP_ACTIONS` | `no_op` | Comma-separated routed actions to skip extraction for |
| `SOS_MEMORY_EXTRACTION_MAX_FACTS` | `5` | Max facts extracted per LLM call |
| `SOS_MEMORY_WEIGHT_SIMILARITY` | `0.45` | Weight for vector similarity in composite scoring (sum of all weights should be 1.0) |
| `SOS_MEMORY_WEIGHT_RECENCY` | `0.20` | Weight for recency in composite scoring |
| `SOS_MEMORY_WEIGHT_IMPORTANCE` | `0.20` | Weight for importance in composite scoring |
| `SOS_MEMORY_WEIGHT_ACCESS` | `0.15` | Weight for access frequency in composite scoring |
| `SOS_MEMORY_EVOLUTION_ENABLED` | `true` | Enable A-MEM-style memory linking and evolution |
| `SOS_MEMORY_EVOLUTION_MAX_NEIGHBORS` | `5` | Max neighbors to consider for linking when a memory is created/updated |
| `SOS_MEMORY_EVOLUTION_LINK_THRESHOLD` | `0.6` | Minimum similarity for creating a memory link |
| `SOS_MEMORY_REFLECTION_ENABLED` | `true` | Enable periodic reflection and user profile synthesis |
| `SOS_MEMORY_REFLECTION_INTERVAL_HOURS` | `24` | Minimum hours between reflection runs per owner |
| `SOS_MEMORY_REFLECTION_MIN_EPISODES` | `10` | Minimum new episodes required to trigger reflection |
| `SOS_MEMORY_SIGNAL_DELAY_MS` | `300000` | Delay (ms) before collecting feedback signals (default: 5 min) |
| `SOS_MEMORY_SIGNAL_NO_RESPONSE_TIMEOUT_MS` | `1800000` | Timeout (ms) for detecting "no response" signal (default: 30 min) |
| `SOS_MEMORY_STORAGE_DIR` | `$SOS_WORKSPACE_ROOT/memory` | Directory for memory LanceDB vector data and SQLite FTS5 keyword indexes |

The memory model can also be overridden via `model-config.yaml`:

```yaml
memory: gpt-4.1-mini
```

Memory configuration can also be edited at runtime via `PUT /api/web/memory/config`, which persists overrides to MongoDB (merged with env var defaults).

## Routing Config: Research Strategy

The `routing-config.yaml` supports an optional `kb_research_strategy` field at the top level to enable the research pipeline for chat/Slack KB context injection:

```yaml
kb_research_strategy: "simple"  # "simple", "deep", or "agent" — omit to use basic vector search
kb_context_max_tokens: 4000     # max token budget for KB context (optional)
```

When set, the message router uses the research pipeline (instead of basic vector search) to build KB context for LLM calls. This applies to both Slack and web chat conversations.

## Worker

The worker reads from the same `.env` file.

| Variable | Required | Description |
|---|---|---|
| `SOS_API_BASE_URL` | **Yes** | Server URL (e.g., `http://localhost:3000`) |
| `SOS_INTERNAL_API_TOKEN` | **Yes** | Same token as server |
| `SOS_REQUESTED_BY_SLACK_USER` | **Yes** | Your Slack user ID |
| `SOS_NODE_ID` | No (default: `local`) | Identifier for this machine |
| `SOS_POLL_INTERVAL_SECONDS` | No (10) | Poll interval |
| `SOS_LEASE_SECONDS` | No (120) | Lease duration per claim |
| `SOS_WORKSPACE_ROOT` | **Yes** | Directory for clones/worktrees |
| `SOS_REPO_REGISTRY` | **Yes** | Path to `repo-registry.yaml` |
| `SOS_MAX_CI_FIX_ATTEMPTS` | No (2) | Max CI fix attempts |
| `SOS_MAX_RUNTIME_MINUTES` | No (60) | Max job runtime |
| `SOS_REQUIRE_LOCAL_TESTS_BEFORE_PR` | No (false) | Require local tests pass before PR |
| `SOS_TEST_LEVEL_DEFAULT` | No (`fast`) | Default test level: `fast`/`full`/`none` |

## MCP Servers

You can give Claude CLI access to [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers during job execution. This lets Claude interact with external tools like Linear, Sentry, databases, etc.

MCP servers are configured in `repo-registry.yaml` at two levels:

- **Global** — top-level `mcp_servers:` block, available to all repos
- **Per-repo** — under each repo's `mcp_servers:` block, merged with global (repo overrides by name)

### Supported transports

| Transport | Fields | Description |
|---|---|---|
| `stdio` | `command`, `args`, `env` | Spawns a local process (most common) |
| `http` | `url`, `headers` | Connects to a remote HTTP MCP server |
| `sse` | `url`, `headers` | Connects to a remote SSE MCP server |

### Environment variable interpolation

String values in `env`, `url`, and `headers` support `${VAR}` placeholders that are resolved from `process.env` at registry load time. Store secrets in your `.env` file and reference them in the YAML:

```yaml
mcp_servers:
  linear:
    transport: stdio
    command: npx
    args: ["-y", "@anthropic/linear-mcp-server"]
    env:
      LINEAR_API_KEY: "${LINEAR_API_KEY}"
```

### Tool filtering

Use `allowed_tools` to expose only a subset of an MCP server's tools to Claude. This reduces prompt bloat and limits blast radius. Omit to expose all tools.

```yaml
mcp_servers:
  linear:
    transport: stdio
    command: npx
    args: ["-y", "@anthropic/linear-mcp-server"]
    allowed_tools:
      - search_issues
      - get_issue
```

### Example: global + per-repo

```yaml
# Global — all repos get this
mcp_servers:
  github-notifications:
    transport: stdio
    command: npx
    args: ["-y", "@anthropic/github-mcp-server"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"

repos:
  my-api:
    clone: "git@github.com:yourorg/my-api.git"
    default_branch: "main"
    mcp_servers:
      sentry:
        transport: http
        url: "https://mcp.sentry.dev/mcp"
        headers:
          Authorization: "Bearer ${SENTRY_AUTH_TOKEN}"
```

In this example, `my-api` jobs get both `github-notifications` (global) and `sentry` (repo-level).

### Security note

MCP tools run with the same permissions as the Claude CLI session (which uses `--dangerously-skip-permissions`). The `allowed_tools` whitelist is the primary guardrail for limiting what MCP tools can do.
