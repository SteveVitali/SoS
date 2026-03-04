# Configuration Reference

All configuration is via environment variables in a single `.env` file (see `.env.example`).

## Server

| Variable | Required | Description |
|---|---|---|
| `SOS_SERVER_PORT` | No (default: 3000) | HTTP port |
| `SOS_INTERNAL_API_TOKEN` | **Yes** | Shared secret for worker ↔ server auth |
| `MONGO_URI` | **Yes** | MongoDB connection string |
| `MONGO_DB` | No (default: `son_of_steve`) | Database name |
| `SLACK_APP_TOKEN` | No | Socket Mode app token (`xapp-...`). Slack is optional — leave blank to disable. |
| `SLACK_BOT_TOKEN` | No | Bot OAuth token (`xoxb-...`). Required if Slack is enabled. |
| `SLACK_BOT_USER_ID` | No | Bot's Slack user ID (`U...`). Required if Slack is enabled. |
| `SOS_LLM_PROVIDER` | No (default: `anthropic`) | LLM provider: `anthropic` or `openai_compatible` ([setup](SLACK_SETUP.md#llm-powered-message-routing-optional)) |
| `SOS_LLM_MODEL` | No (default: `claude-sonnet-4-20250514`) | Model name/string for the LLM provider |
| `SOS_LLM_API_KEY` | No | API key for the LLM provider. Falls back to `ANTHROPIC_API_KEY` if not set. |
| `SOS_LLM_BASE_URL` | Only for `openai_compatible` | Base URL for OpenAI-compatible endpoint (e.g., LiteLLM proxy) |
| `SOS_SLACK_JOB_OWNER` | No | The `requested_by` value to assign to Slack-created jobs (defaults to `SOS_REQUESTED_BY_SLACK_USER`). Must match the worker's `SOS_REQUESTED_BY_SLACK_USER` so workers claim Slack jobs. The original Slack user is stored separately for attribution. |
| `SOS_MAX_THREAD_MESSAGES` | No (default: 20) | Max Slack thread messages to fetch for context when @-mentioned in a thread |
| `SOS_MAX_ATTACHMENT_SIZE_MB` | No (default: 10) | Max total file attachment size (MB) per job. Files collected newest-first; oldest dropped when limit reached. |
| `JOB_DEFAULT_LEASE_SECONDS` | No (120) | Default lease duration |
| `JOB_MAX_RUNTIME_MINUTES` | No (60) | Max job runtime |
| `JOB_MAX_CI_FIX_ATTEMPTS` | No (2) | Max CI fix iterations |
| `SOS_SLACK_NOTIFY_USER` | No | Always @-mention this Slack user ID in bot messages (for personal notifications) |
| `SOS_GH_BOT_LOGINS` | No (default: `son-of-steve,son-of-steve[bot]`) | Comma-separated GitHub logins to treat as "bot" when computing PR comment stats |
| `SOS_GITHUB_ORG` | No | Default GitHub organization slug for team queries (e.g., `my-company`) |
| `SOS_GITHUB_TEAM_SLUG` | No | Default GitHub team slug for team queries (e.g., `platform-eng`) |
| `SOS_GITHUB_USERNAME` | No | GitHub username for personal queries. Auto-detected via `gh api user` if not set. |
| `SOS_ROUTING_CONFIG` | No | Path to `routing-config.yaml`. Auto-generated with defaults if missing. Falls back to same directory as `SOS_REPO_REGISTRY`. |
| `SOS_WORKSPACE_ROOT` | No | Directory for clones/worktrees (also used by server for worktree status endpoint) |
| `SOS_REPO_REGISTRY` | No | Path to `repo-registry.yaml` (also used by server for PR listing and registry editor) |
| `WEB_BASIC_AUTH_USER` | No | Optional basic auth for web UI |
| `WEB_BASIC_AUTH_PASS` | No | Optional basic auth for web UI |

## Knowledge Base (Embeddings)

| Variable | Required | Description |
|---|---|---|
| `SOS_EMBEDDING_PROVIDER` | No (default: `openai`) | Embedding provider. Currently supports `openai` (works with any OpenAI-compatible API). |
| `SOS_EMBEDDING_MODEL` | No (default: `text-embedding-3-small`) | Embedding model name |
| `SOS_EMBEDDING_API_KEY` | Only if KB is used | API key for the embedding provider. Falls back to `OPENAI_API_KEY` if not set. |
| `SOS_EMBEDDING_BASE_URL` | No | Custom base URL for the embedding API (e.g., a LiteLLM proxy). Defaults to `https://api.openai.com/v1`. |
| `SOS_KB_STORAGE_DIR` | No | Directory for LanceDB vector data. Defaults to `$SOS_WORKSPACE_ROOT/kb` or `.sos-kb` in the project root. |

## Research Pipeline (LLM)

The research pipeline uses a separate, typically cheaper LLM for its internal reasoning calls (query analysis, evaluation, reasoning, agent loop). This is independent of the main LLM provider used for Slack/chat routing.

| Variable | Required | Description |
|---|---|---|
| `SOS_RESEARCH_LLM_MODEL` | No (default: `gpt-4o-mini`) | Model for research reasoning calls. Supports any OpenAI-compatible model. |
| `SOS_RESEARCH_LLM_API_KEY` | Only if research pipeline is used | API key for the research LLM. Falls back to `OPENAI_API_KEY` if not set. |
| `SOS_RESEARCH_LLM_BASE_URL` | No (default: `https://api.openai.com/v1`) | Base URL for the research LLM API (e.g., a LiteLLM proxy). |
| `SOS_RESEARCH_LLM_TEMPERATURE` | No (default: `0.0`) | Temperature for research LLM calls. `0.0` for deterministic reasoning. |
| `SOS_RESEARCH_LLM_MAX_TOKENS` | No (default: `2048`) | Max output tokens per research LLM call. |

The model can also be overridden per-session via the Research Playground's model selector or `config_overrides.model` in API calls.

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
| `SOS_WORKERS` | No (default: 4) | Number of concurrent worker loops |
| `SOS_POLL_INTERVAL_SECONDS` | No (10) | Poll interval |
| `SOS_LEASE_SECONDS` | No (120) | Lease duration per claim |
| `SOS_WORKSPACE_ROOT` | **Yes** | Directory for clones/worktrees |
| `SOS_REPO_REGISTRY` | **Yes** | Path to `repo-registry.yaml` |
| `SOS_MAX_CI_FIX_ATTEMPTS` | No (2) | Max CI fix attempts |
| `SOS_MAX_RUNTIME_MINUTES` | No (60) | Max job runtime |
| `SOS_REQUIRE_LOCAL_TESTS_BEFORE_PR` | No (true) | Require local tests pass before PR |
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
