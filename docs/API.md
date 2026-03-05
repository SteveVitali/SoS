# API Reference

All endpoints require authentication. Worker endpoints use `Authorization: Bearer <SOS_INTERNAL_API_TOKEN>`. Web endpoints use the same Bearer token or optional HTTP Basic Auth.

## Worker Endpoints (`/api/worker`)

### Register Worker

```
POST /api/worker/register
```

Registers a worker process with the server's in-memory registry.

**Body:**
```json
{
  "worker_id": "steve-mbp-pid12345",
  "hostname": "steve-mbp",
  "pid": 12345,
  "version": "0.2.0"
}
```

**Response (200):** `{ "worker": { "worker_id": "...", "hostname": "...", "pid": 12345, ... } }`

### Report Worker Status

```
POST /api/worker/status
```

Reports per-loop status (idle/busy, current task, worktree slot).

**Body:**
```json
{
  "worker_id": "steve-mbp-pid12345",
  "loops": [
    { "index": 0, "status": "idle" },
    { "index": 1, "status": "busy", "task_id": "abc123", "worktree_slot": "my-app-n-0", "busy_since": "2025-..." }
  ]
}
```

**Response (200):** `{ "ok": true }`

### Deregister Worker

```
POST /api/worker/deregister
```

Removes the worker from the in-memory registry (called on graceful shutdown).

**Body:** `{ "worker_id": "steve-mbp-pid12345" }`

**Response (200):** `{ "ok": true }`

### WebSocket: Log Streaming & Commands

```
ws://host/api/worker/ws?worker_id=...&token=...
```

Bidirectional WebSocket connection. Workers send JSON log lines; server can send commands.

**Worker → Server (log line):**
```json
{ "worker_id": "...", "loop_index": 0, "task_id": "abc123", "line": "...", "ts": "2025-..." }
```

**Server → Worker (command):**
```json
{ "command": "shutdown" }
```

### Poll for Jobs

```
GET /api/worker/jobs/poll?requested_by=U...&limit=10
```

Returns jobs eligible for claiming: `QUEUED` jobs or `RUNNING`/`FIXING_CI` jobs with expired leases.

**Query params:**
- `requested_by` (required) — Slack user ID; only returns jobs for this user
- `limit` (optional, default 10, max 50)

**Response:**
```json
{
  "jobs": [{ "task_id": "...", "status": "QUEUED", ... }]
}
```

### Claim a Job

```
POST /api/worker/jobs/:task_id/claim
```

Atomically claims a job with a lease. Returns 409 if already claimed or not eligible.

**Body:**
```json
{
  "requested_by": "U...",
  "node_id": "steve-mbp:worker-0",
  "lease_seconds": 120
}
```

**Response (200):** `{ "job": { ... } }`
**Response (409):** `{ "error": "Claim failed: job not eligible or already claimed" }`

### Heartbeat

```
POST /api/worker/jobs/:task_id/heartbeat
```

Extends the lease. Must be called by the current owner while status is `RUNNING` or `FIXING_CI`.

**Body:**
```json
{
  "node_id": "steve-mbp:worker-0",
  "extend_seconds": 120
}
```

**Response (200):** `{ "ok": true, "lease_expires_at": "2024-..." }`
**Response (409):** `{ "error": "Heartbeat rejected: not owner or not active" }`

### Report Event

```
POST /api/worker/jobs/:task_id/events
```

Appends a structured event to the job's event log. Some events trigger Slack updates and/or job field updates.

**Body:**
```json
{
  "node_id": "steve-mbp:worker-0",
  "type": "PR_CREATED",
  "payload": { "url": "https://github.com/org/repo/pull/42" }
}
```

**Event types that update job fields:**
- `PR_CREATED { url }` → appends to `pr_urls`
- `CI_STATUS { status, conclusion, url }` → sets `ci`
- `REPO_RESOLVED { repoId }` → appends to `repos_resolved`
- `WORKTREE_READY { branch }` → sets `branch_name`
- `CI_FIX_STARTED` → sets status to `FIXING_CI`

**Event types that trigger Slack messages:**
`PR_CREATED`, `CI_FAILED`, `CI_STATUS`, `DONE`, `FAILED`, `CANCELED`

### Complete a Job

```
POST /api/worker/jobs/:task_id/complete
```

Sets status to `DONE`, clears lease fields, posts Slack summary.

**Body:**
```json
{
  "node_id": "steve-mbp:worker-0",
  "result_summary": "Fixed auth bug. PR: https://...",
  "pr_urls": ["https://github.com/org/repo/pull/42"],
  "ci": { "provider": "github_actions" }
}
```

### Fail a Job

```
POST /api/worker/jobs/:task_id/fail
```

Sets status to `FAILED`, clears lease fields, posts Slack failure message.

**Body:**
```json
{
  "node_id": "steve-mbp:worker-0",
  "error": {
    "code": "EXECUTION_ERROR",
    "message": "Claude Code produced no changes",
    "details": "..."
  },
  "pr_urls": [],
  "ci": null
}
```

### Check Job Status

```
GET /api/worker/jobs/:task_id/status
```

Returns the current status of a job (used by workers to check for cancellation mid-execution).

**Response (200):** `{ "status": "RUNNING" }`

### Requeue a Job

```
POST /api/worker/jobs/:task_id/requeue
```

Requeues a running job back to `QUEUED` with a backoff delay. Used when no worktree slot is available.

**Body:**
```json
{
  "node_id": "steve-mbp:worker-0",
  "reason": "no_worktree_slot"
}
```

**Response (200):** `{ "job": { ... } }`
**Response (409):** `{ "error": "Requeue failed: not owner or not active" }`

### Await Approval

```
POST /api/worker/jobs/:task_id/await-approval
```

Sets job status to `WAITING_FOR_APPROVAL` after creating a draft PR. The job pauses until manually promoted.

**Body:**
```json
{
  "node_id": "steve-mbp:worker-0",
  "result_summary": "Draft PR created. Awaiting approval.",
  "pr_urls": ["https://github.com/org/repo/pull/42"]
}
```

**Response (200):** `{ "job": { ... } }`

### Submit Plan

```
POST /api/worker/jobs/:task_id/submit-plan
```

Submits the generated plan after a planning phase. Transitions job from `PLANNING` to `PENDING_CONFIRMATION`. Posts the plan to Slack for user review.

**Body:**
```json
{
  "node_id": "steve-mbp:worker-0",
  "plan_summary": "## Implementation Plan\n1. Update auth module...\n2. Add tests...",
  "metrics": { "durations": { "plan_ms": 12000 }, "claude": { "sessions": [...] } }
}
```

**Response (200):** `{ "job": { ... } }`
**Response (409):** `{ "error": "Submit plan failed: not owner or not in PLANNING status" }`

### Fetch Slack Thread (Proxy)

```
GET /api/worker/slack/thread?channel_id=C...&thread_ts=1234567890.123456
```

Server fetches the Slack thread on behalf of the worker (workers don't hold Slack tokens). Returns up to 20 messages, each truncated to 2000 chars.

**Response:**
```json
{
  "messages": [
    { "user": "U...", "text": "fix the auth bug", "ts": "1234567890.123456" }
  ]
}
```

### Search Knowledge Bases

```
POST /api/worker/kb/search
```

Searches enabled knowledge bases by scope. Used by workers to fetch KB context before Claude sessions.

**Body:**
```json
{
  "query": "how does the auth module work",
  "scopes": ["create_job", "all"],
  "max_chunks": 10,
  "min_score": 0.3
}
```

**Response:**
```json
{
  "results": [
    {
      "content": "The auth module uses JWT tokens...",
      "source_file": "design-docs/auth.md",
      "kb_name": "Design Docs",
      "kb_id": "uuid",
      "score": 0.87,
      "metadata": { "section": "Authentication Flow", "file_path": "design-docs/auth.md", "parent_dir": "design-docs" }
    }
  ]
}
```

---

## Web Endpoints (`/api/web`)

### List Jobs

```
GET /api/web/jobs?status=RUNNING&requested_by=U...&q=auth&limit=50&offset=0&sort_by=created_at&sort_order=desc
```

All query params are optional. `DELETED` jobs are excluded by default unless `status=DELETED` is explicitly requested.

**Response:**
```json
{
  "jobs": [{ ... }],
  "total": 42
}
```

### Get Job Detail

```
GET /api/web/jobs/:task_id
```

Returns the full job document including events.

**Response:** `{ "job": { ... } }`

### Create Job

```
POST /api/web/jobs
```

Creates a job with `source.type = "web_create"`.

**Body:**
```json
{
  "requested_by": "U...",
  "task_text": "Fix the login endpoint",
  "repo_hint": "my-api",
  "test_level": "fast",
  "ci_fix_enabled": true,
  "reviewers": ["alice"]
}
```

**Response (201):** `{ "job": { ... } }`

### Cancel Job

```
POST /api/web/jobs/:task_id/cancel
```

Sets status to `CANCELED` if not already terminal. Posts Slack update.

**Response (200):** `{ "job": { ... } }`
**Response (409):** `{ "error": "Cannot cancel: job is terminal or not found" }`

### Confirm Plan

```
POST /api/web/jobs/:task_id/confirm-plan
```

Confirms a plan for a job in `PENDING_CONFIRMATION` status. Creates a new execution job based on the confirmed plan.

**Response (200):** `{ "job": { ... } }` (the new execution job)
**Response (409):** `{ "error": "Job not in PENDING_CONFIRMATION status" }`

### Retry Job

```
POST /api/web/jobs/:task_id/retry
```

Creates a **new** job (new `task_id`) with `parent_task_id` linking to the original. Only allowed if original status is `FAILED` or `CANCELED`.

**Response (201):** `{ "job": { ... } }` (the new job)

### Delete Job (Soft)

```
DELETE /api/web/jobs/:task_id
```

Sets status to `DELETED`. Cannot delete `RUNNING` or `FIXING_CI` jobs (cancel first).

**Response (200):** `{ "job": { ... } }`
**Response (409):** `{ "error": "Cannot delete: job is RUNNING or not found" }`

### Self-Review PR

```
POST /api/web/jobs/self-review-pr
```

Creates a `self_review_pr` job that checks out an existing PR branch, runs a self-review pass (Claude as Staff Engineer reviewer), fixes issues, and pushes.

**Body:**
```json
{
  "requested_by": "U...",
  "pr_url": "https://github.com/org/repo/pull/42"
}
```

**Response (201):** `{ "job": { ... } }`

### Add PR Review Comments

```
POST /api/web/jobs/add-review-comments
```

Creates an `add_pr_review_comments` job that reviews a PR and posts inline review comments on GitHub.

**Body:**
```json
{
  "requested_by": "U...",
  "pr_url": "https://github.com/org/repo/pull/42"
}
```

**Response (201):** `{ "job": { ... } }`

### Respond to PR Comments (Direct)

```
POST /api/web/jobs/respond-to-comments
```

Creates a `respond_to_pr_comments` job for an arbitrary PR URL.

**Body:**
```json
{
  "requested_by": "U...",
  "pr_url": "https://github.com/org/repo/pull/42"
}
```

**Response (201):** `{ "job": { ... } }`

### Respond to PR Comments (From Existing Job)

```
POST /api/web/jobs/:task_id/respond-to-comments
```

Creates a `respond_to_pr_comments` job using the PR URL from an existing job.

**Response (201):** `{ "job": { ... } }`

### Promote Draft PR

```
POST /api/web/jobs/:task_id/promote-pr
```

Promotes a draft PR to ready-for-review and optionally adds reviewers. Only valid when job status is `WAITING_FOR_APPROVAL`.

**Body (optional):**
```json
{ "reviewers": ["alice", "bob"] }
```

**Response (200):** `{ "job": { ... } }`

### List Users

```
GET /api/web/users
```

Returns distinct `requested_by` values from non-deleted jobs (for filter dropdowns).

**Response:** `{ "users": ["U1234", "U5678"] }`

### Get Identity

```
GET /api/web/identity
```

Returns the canonical job owner ID from server config (used by the UI to pre-fill the `requested_by` field).

**Response:** `{ "jobOwner": "svitali" }`

### Resolve Slack User

```
GET /api/web/slack/user/:user_id
POST /api/web/slack/users   (batch: body { "user_ids": ["U1", "U2"] })
```

Resolves Slack user IDs to display names.

---

## PR Endpoints (`/api/web`)

> **Note:** The legacy `GET /api/web/prs` endpoint has been replaced by the GitHub Hub `GET /api/web/github/prs` endpoint which uses the MongoDB sync cache. See [GitHub Hub Endpoints](#github-hub-endpoints-apiwebgithub).

### Batch PR Stats

```
POST /api/web/prs/stats
```

Fetches comment stats for a list of PR URLs (with TTL caching to avoid GitHub API rate limits).

**Body:** `{ "urls": ["https://github.com/org/repo/pull/42"] }`

**Response:** `{ "stats": { "https://...": { ... } } }`

---

## Registry Endpoints (`/api/web`)

### Get Registry

```
GET /api/web/registry
```

Returns `repo-registry.yaml` contents as JSON.

**Response:** `{ "registry": { "repos": { ... } } }`

### Update Registry

```
PUT /api/web/registry
```

Writes JSON back to `repo-registry.yaml`.

**Body:** `{ "repos": { ... } }`

**Response (200):** `{ "ok": true }`

---

## Worktree Endpoints (`/api/web`)

### Get Worktree Status

```
GET /api/web/worktrees
```

Returns the status of all worktree slots across all repos, including lock status.

**Response:**
```json
{
  "worktrees": {
    "my-app": [
      { "slotName": "my-app-n-0", "inUse": true, "taskId": "abc123", "acquiredAt": "2025-..." },
      { "slotName": "my-app-n-1", "inUse": false }
    ]
  }
}
```

---

## Worker Management Endpoints (`/api/web`)

### List Workers

```
GET /api/web/workers
```

Returns all registered workers with their current loop statuses.

**Response:** `{ "workers": [{ "worker_id": "...", "status": "online", "loops": [...] }] }`

### Get Worker

```
GET /api/web/workers/:id
```

Returns a single worker's details.

**Response:** `{ "worker": { ... } }`

### Spawn Worker

```
POST /api/web/workers/spawn
```

Spawns a new detached worker process on the local machine via `child_process.spawn`. No request body is needed.

**Response (200):** `{ "ok": true, "pid": 12345 }`

### Shutdown Worker

```
POST /api/web/workers/:id/shutdown
```

Sends a shutdown command via WebSocket. Falls back to `SIGTERM` if the worker doesn't have a WebSocket connection.

**Response (200):** `{ "ok": true }`

### Remove Worker Entry

```
DELETE /api/web/workers/:id
```

Removes a stale/offline worker from the in-memory registry.

**Response (200):** `{ "ok": true }`

### Subscribe to Worker Logs (SSE)

```
GET /api/web/workers/:id/logs?loop_index=0
```

Server-Sent Events stream. First replays buffered log history (last 1000 lines), then streams live output.

**Query params:**
- `loop_index` (optional) — filter to a specific worker loop

**Events:** `data: { "loop_index": 0, "task_id": "...", "line": "...", "ts": "..." }`

---

## Chat Endpoints (`/api/web/chats`)

### Create Conversation

```
POST /api/web/chats
```

Creates a new chat conversation.

**Response:** `{ "conversation": { "id": "...", "messages": [] } }`

### List Conversations

```
GET /api/web/chats?limit=50&offset=0
```

**Response:** `{ "conversations": [...], "total": 10 }`

### Get Conversation

```
GET /api/web/chats/:id
```

**Response:** `{ "conversation": { "id": "...", "messages": [...] } }`

### Send Message

```
POST /api/web/chats/:id/messages
```

Sends a user message and returns Steve's LLM-routed reply. May trigger job creation, status checks, etc.

**Body:** `{ "text": "fix the auth bug in my-api" }`

**Response:**
```json
{
  "userMessage": { "id": "...", "role": "user", "text": "...", "at": "..." },
  "assistantMessage": { "id": "...", "role": "assistant", "text": "...", "at": "...", "action": { "command": "create_job", "task_id": "..." } },
  "action": { "command": "create_job", "taskId": "..." }
}
```

### Poll for Updates

```
GET /api/web/chats/:id/updates?since=2025-...
```

Returns messages added since the given ISO timestamp (used for receiving async job status notifications pushed into the conversation).

**Response:** `{ "messages": [...] }`

### Delete Conversation

```
DELETE /api/web/chats/:id
```

**Response (200):** `{ "ok": true }`

---

## Model Registry Endpoints (`/api/web`)

### Get Model Registry

```
GET /api/web/models
```

Returns the active model assignments for all roles (routing, titleGeneration, research, raptorSummarization, embedding).

**Response:**
```json
{
  "models": {
    "routing": { "model": "claude-opus-4.5", "envVar": "SOS_LLM_MODEL" },
    "titleGeneration": { "model": "claude-opus-4.5", "envVar": "SOS_TITLE_MODEL" },
    "research": { "model": "claude-opus-4.5", "envVar": "SOS_RESEARCH_LLM_MODEL" },
    "raptorSummarization": { "model": "claude-opus-4.5", "envVar": "SOS_RAPTOR_MODEL" },
    "embedding": { "model": "text-embedding-3-small", "envVar": "SOS_EMBEDDING_MODEL" }
  }
}
```

### Get Available Models

```
GET /api/web/available-models
```

Proxies the LiteLLM `/model/info` endpoint to return available chat models. Results are cached for 60 seconds. Uses resolved provider settings (YAML > env > default) for the base URL.

**Response:**
```json
{
  "models": ["claude-opus-4.5", "claude-sonnet-4-20250514", "gpt-4o", ...]
}
```

### Get Model Config (YAML Overrides)

```
GET /api/web/model-config
```

Returns the current `model-config.yaml` overrides, the resolved model registry, and provider settings.

**Response:**
```json
{
  "path": "/path/to/model-config.yaml",
  "overrides": { "routing": "claude-opus-4.5" },
  "registry": { "routing": { "model": "...", ... }, ... },
  "provider": { "type": "openai_compatible", "baseUrl": "...", "hasKey": true }
}
```

### Update Model Config

```
PUT /api/web/model-config
```

Writes model overrides to `model-config.yaml`. Provider settings are also saved.

**Body:**
```json
{
  "overrides": { "routing": "claude-opus-4.5", "research": "gpt-4o" },
  "provider": { "type": "openai_compatible", "baseUrl": "http://localhost:4000" }
}
```

**Response (200):** `{ "ok": true, "registry": { ... } }`

### Reload Model Config

```
POST /api/web/model-config/reload
```

Force-reloads model config from disk.

**Response (200):** `{ "ok": true, "registry": { ... } }`

---

## Routing Config Endpoints (`/api/web`)

### Get Routing Config

```
GET /api/web/routing-config
```

Returns the current `routing-config.yaml` contents as JSON, along with the file path.

**Response:** `{ "config": { ... }, "path": "/path/to/routing-config.yaml" }`

### Update Routing Config

```
PUT /api/web/routing-config
```

Writes JSON back to `routing-config.yaml`.

**Body:** `{ "system_prompt": "...", "model": "...", "actions": { ... } }`

**Response (200):** `{ "ok": true }`

### Reload Routing Config

```
POST /api/web/routing-config/reload
```

Force-reloads the routing config from disk (useful after manual edits).

**Response (200):** `{ "ok": true }`

---

## Knowledge Base Endpoints (`/api/web/kb`)

### Create Knowledge Base

```
POST /api/web/kb
```

**Body:**
```json
{
  "name": "Design Docs",
  "description": "Company design documents and architecture guides",
  "scopes": ["chat", "create_job"],
  "chunk_size": 512,
  "chunk_overlap": 50,
  "max_chunks_per_query": 5,
  "min_similarity_score": 0.3
}
```

**Response (201):** `{ "kb": { ... } }`

### List Knowledge Bases

```
GET /api/web/kb?owner=default
```

**Response:** `{ "kbs": [{ "kb_id": "...", "name": "...", ... }] }`

### Get Knowledge Base

```
GET /api/web/kb/:id
```

Returns the KB metadata and its list of ingested documents.

**Response:** `{ "kb": { ... }, "documents": [{ "name": "auth.md", "size_bytes": 1024, "chunk_count": 5, "ingested_at": "..." }] }`

### Update Knowledge Base

```
PUT /api/web/kb/:id
```

**Body:** Partial update — any of: `name`, `description`, `enabled`, `scopes`, `chunk_size`, `chunk_overlap`, `max_chunks_per_query`, `min_similarity_score`.

**Response:** `{ "kb": { ... } }`

### Delete Knowledge Base

```
DELETE /api/web/kb/:id
```

Drops the vector table and removes all metadata.

**Response:** `{ "ok": true }`

### Ingest Files

```
POST /api/web/kb/:id/ingest
Content-Type: multipart/form-data
```

Upload files for ingestion. Supports text files (`.md`, `.txt`, `.py`, `.ts`, etc.), PDFs, archives (`.zip`, `.tar`, `.tar.gz`), and entire folders (via the web UI's folder picker). Archives and folders are auto-expanded and the directory hierarchy is preserved in vector metadata (`file_path`, `parent_dir`). Chunk content is enriched with breadcrumb paths before embedding for better retrieval. Max 500 files, 100MB each.

#### Streaming mode (NDJSON)

When the request includes `Accept: text/x-ndjson`, the endpoint streams real-time per-file progress events as newline-delimited JSON instead of returning a single JSON response. Each line is a JSON object with a `type` field:

| Event type | Fields | Meaning |
|---|---|---|
| `start` | `total_uploads` | Ingestion beginning |
| `file_start` | `file` | A file is being processed |
| `file_done` | `file`, `chunks` | File successfully ingested |
| `file_skip` | `file`, `reason` | File skipped (unsupported/empty) |
| `file_error` | `file`, `error` | File failed |
| `complete` | `documents_added`, `chunks_added`, `skipped`, `errors` | All files processed |

**Example stream:**
```
{"type":"start","total_uploads":3}
{"type":"file_start","file":"docs/auth.md"}
{"type":"file_done","file":"docs/auth.md","chunks":12}
{"type":"file_start","file":"image.png"}
{"type":"file_skip","file":"image.png","reason":"unsupported or empty"}
{"type":"complete","documents_added":1,"chunks_added":12,"skipped":["image.png"],"errors":[]}
```

#### Legacy mode (JSON)

Without the `Accept: text/x-ndjson` header, the endpoint returns a single JSON response after all files are processed:

**Response:**
```json
{
  "documents_added": 3,
  "chunks_added": 47,
  "skipped": ["image.png"],
  "errors": []
}
```

### List All Active Uploads

```
GET /api/web/kb/uploads/active
```

Returns all in-progress upload jobs across all knowledge bases.

**Response:** `{ "uploads": [{ "job_id": "...", "kb_id": "...", "status": "processing", "total_files": 5, "files_done": 3, ... }] }`

### List KB Uploads

```
GET /api/web/kb/:id/uploads?active=true
```

Returns upload jobs for a specific KB. When `active=true`, only returns in-progress jobs; otherwise returns recent jobs.

**Response:** `{ "uploads": [{ "job_id": "...", "kb_id": "...", "status": "complete", ... }] }`

### Get Upload Job

```
GET /api/web/kb/:id/uploads/:jobId
```

Returns a specific upload job's details and per-file status.

**Response:** `{ "job": { "job_id": "...", "kb_id": "...", "status": "complete", "total_files": 3, "files_done": 3, "files": [...] } }`

### Cross-KB Search (with routing metadata)

```
POST /api/web/kb/search
```

Search across all enabled knowledge bases using two-stage routing. Returns results plus routing metadata showing which KBs were probed and which passed the similarity threshold.

**Body:**
```json
{
  "query": "auth flow",
  "scopes": ["chat", "create_job"],
  "max_chunks": 10,
  "min_score": 0.3
}
```

**Response:**
```json
{
  "results": [{ "content": "...", "source_file": "...", "kb_name": "...", "kb_id": "...", "score": 0.87, "metadata": { "file_path": "docs/api/auth.md", "parent_dir": "docs/api" } }],
  "routing": {
    "total_kbs": 3,
    "relevant_kbs": 2,
    "probes": [
      { "kb_id": "...", "kb_name": "Design Docs", "probe_score": 0.91, "passed": true },
      { "kb_id": "...", "kb_name": "Slack History", "probe_score": 0.12, "passed": false }
    ]
  }
}
```

### Search Single KB

```
POST /api/web/kb/:id/search
```

Search within a specific KB (for testing/debugging).

**Body:** `{ "query": "auth flow", "limit": 5 }`

**Response:** `{ "results": [{ "content": "...", "source_file": "...", "score": 0.87, ... }] }`

### List Document Chunks

```
GET /api/web/kb/:id/documents/:name/chunks?offset=0&limit=20
```

Paginated list of chunks for a specific document. Limit is capped at 100.

**Response:** `{ "chunks": [{ "id": "...", "content": "...", "section": "...", "page": 0, "file_path": "docs/api/auth.md", "parent_dir": "docs/api", "created_at": "..." }], "total": 47 }`

### List Documents

```
GET /api/web/kb/:id/documents
```

**Response:** `{ "documents": [{ "name": "...", "size_bytes": ..., "chunk_count": ..., "ingested_at": "..." }] }`

### Delete Document

```
DELETE /api/web/kb/:id/documents/:name
```

Removes a document and its chunks from both the vector store and MongoDB.

**Response:** `{ "ok": true }`

---

## Research Pipeline Endpoints (`/api/web/kb`)

### Run Research Pipeline

```
POST /api/web/kb/research
```

Runs the advanced RAG research pipeline on a query against selected knowledge base scopes.

**Body:**
```json
{
  "query": "how does the auth module handle rate limiting?",
  "scopes": ["chat", "all"],
  "strategy": "deep",
  "config_overrides": { "max_iterations": 2, "model": "gpt-4o" },
  "owner": "default"
}
```

- `strategy` — `"simple"`, `"deep"`, or `"agent"` (default: `"simple"`)
- `config_overrides` — optional partial `ResearchConfig` to override strategy defaults (budget caps, stage toggles, model)

#### Streaming mode (NDJSON)

When the request includes `Accept: text/x-ndjson`, the endpoint streams real-time pipeline events as newline-delimited JSON, followed by the final result as the last line.

**Event types:**

| Event type | Fields | Meaning |
|---|---|---|
| `session_start` | `session_id`, `strategy` | Pipeline started |
| `step_start` | `stage`, `iteration` | A pipeline stage is beginning |
| `llm_call` | `purpose`, `duration_ms`, `model` | An LLM call completed |
| `retrieval` | `kb`, `results`, `top_score` | A vector search completed |
| `step_complete` | `stage`, `duration_ms`, `details` | A pipeline stage finished |
| `session_complete` | `session_id`, `total_ms`, `llm_calls`, `cost_usd` | Pipeline finished |
| `session_error` | `session_id`, `error` | Pipeline failed |
| `result` | Full `ResearchResult` fields | Final result (last line) |

#### Standard mode (JSON)

Without the `Accept: text/x-ndjson` header, the endpoint returns a single JSON `ResearchResult`:

```json
{
  "session_id": "uuid",
  "strategy": "deep",
  "original_query": "...",
  "context": "formatted context string for LLM injection",
  "chunks": [{ "content": "...", "source_file": "...", "kb_name": "...", "score": 0.87, ... }],
  "reasoning_trace": "Step-by-step reasoning...",
  "metrics": {
    "total_duration_ms": 5420,
    "iterations": 1,
    "llm_calls": 4,
    "retrieval_calls": 6,
    "chunks_retrieved": 12,
    "chunks_used": 5,
    "prompt_tokens": 3200,
    "completion_tokens": 1800,
    "estimated_cost_usd": 0.012
  },
  "audit": { "session_id": "...", "steps": [...] }
}
```

### List Research Sessions

```
GET /api/web/kb/research/sessions?limit=20&offset=0&strategy=deep&consumer_type=playground&consumer_id=...
```

Returns past research sessions. All query params are optional.

**Response:**
```json
{
  "sessions": [{ "session_id": "...", "original_query": "...", "config": { "strategy": "deep", ... }, "status": "completed", "created_at": "..." }],
  "total": 42
}
```

### Get Research Session

```
GET /api/web/kb/research/sessions/:id
```

Returns the full research session with all steps, LLM call records, and retrieval records.

**Response:** `{ "session": { ... } }`

### Run Research Pipeline (Worker)

```
POST /api/worker/kb/research
```

Worker-facing research endpoint. Same as the web endpoint but with `consumer` instead of `owner`.

**Body:**
```json
{
  "query": "how does the auth module work",
  "scopes": ["create_job", "all"],
  "strategy": "deep",
  "consumer": { "type": "worker_job", "id": "task-uuid" }
}
```

Supports both `Accept: text/x-ndjson` (streaming) and standard JSON responses. JSON response returns a flat object:

```json
{
  "context": "...",
  "chunks": [...],
  "metrics": { ... },
  "session_id": "..."
}
```

---

## RAPTOR Endpoints (`/api/web/kb`)

### Build RAPTOR Tree

```
POST /api/web/kb/:id/raptor/build
```

Triggers an asynchronous RAPTOR tree build for the specified knowledge base. Returns immediately; build runs in the background.

**Body (optional):**
```json
{
  "config": {
    "target_cluster_size": 8,
    "min_cluster_size": 5,
    "max_levels": 4,
    "summary_model": "claude-opus-4.5",
    "max_summary_input_tokens": 4000
  }
}
```

**Response (200):** `{ "ok": true, "message": "RAPTOR build started" }`

### Get RAPTOR Status

```
GET /api/web/kb/:id/raptor/status
```

Returns the current RAPTOR build status for a knowledge base.

**Response:**
```json
{
  "status": {
    "built": true,
    "levels": 3,
    "nodes_per_level": { "1": 24, "2": 5, "3": 1 },
    "total_nodes": 30,
    "last_built": "2026-03-04T...",
    "build_duration_ms": 45000
  }
}
```

### Get RAPTOR Tree Nodes

```
GET /api/web/kb/:id/raptor/tree
```

Returns all RAPTOR tree nodes (level > 0) for visualization. Leaf-level (level 0) chunks are not included.

**Response:**
```json
{
  "nodes": [
    {
      "id": "uuid",
      "level": 1,
      "children_ids": ["child-uuid-1", "child-uuid-2"],
      "content": "Summary of clustered chunks...",
      "source_file": "docs/auth.md",
      "section": "Authentication"
    }
  ]
}
```

---

## GitHub Hub Endpoints (`/api/web/github`)

### List PRs (Cached)

```
GET /api/web/github/prs?scope=team&repo=my-app&author=alice&status=open&sort=updated&order=desc&limit=50&offset=0
```

Returns PRs from the MongoDB cache (populated by the GitHub sync engine). Supports filtering by scope (`me`, `team`, `org`), repo, author, and status.

**Response:**
```json
{
  "prs": [{ "number": 42, "title": "Fix auth", "repo": "my-app", "author": "alice", "state": "open", "linked_job_task_id": "abc123", ... }],
  "total": 150,
  "data_source": "cache",
  "backfill_progress": { "completed": 10, "total": 14, "percentage": 71 }
}
```

### Get Contributions

```
GET /api/web/github/contributions?scope=team&range=30d&login=alice
```

Returns pre-aggregated contribution data (PRs merged, reviews, comments) from the cache. Supports time ranges (`7d`, `30d`, `90d`, `365d`), scope filtering, and grouping.

**Query params:**
- `scope` — `me`, `team`, `org` (default from settings)
- `range` — `7d`, `30d`, `90d`, `365d` (default: `30d`)
- `login` — filter to a specific GitHub user
- `start` / `end` — explicit date range (overrides `range`)
- `group_by` — `day`, `week`, `month` (default: `week`)

**Response:**
```json
{
  "summary": { "prs_opened": 15, "prs_merged": 12, "prs_closed": 1, "reviews_submitted": 24, "review_comments": 47, "commits": 30, "additions": 5000, "deletions": 2000, "repos_touched": ["my-app", "my-lib"] },
  "data_points": [{ "period": "2025-09", "prs_merged": 2, "reviews_submitted": 3, "commits": 5, "additions": 800, "deletions": 200 }],
  "leaderboard": [{ "login": "alice", "avatar_url": "...", "name": "Alice", "prs_merged": 5, "reviews_submitted": 10, "additions": 2000, "deletions": 500, "repos_touched": ["my-app"] }],
  "data_source": "cache"
}
```

### List Teams

```
GET /api/web/github/teams
```

Returns cached org teams.

**Response:** `{ "teams": [{ "slug": "platform-eng", "name": "Platform Engineering", "member_count": 12 }] }`

### List Team Members

```
GET /api/web/github/teams/:slug/members
```

Returns cached members of a specific team.

**Response:** `{ "members": [{ "login": "alice", "avatar_url": "...", "name": "Alice" }] }`

### List Org Members

```
GET /api/web/github/members
```

Returns cached org members.

**Response:** `{ "members": [{ "login": "alice", "avatar_url": "..." }] }`

### Get Sync Status

```
GET /api/web/github/sync-status
```

Returns current sync engine status: whether sync is enabled/running, task queue state, backfill progress, and rate limit status.

**Response:**
```json
{
  "service": { "enabled": true, "running": true, "tasks": [{ "id": "hot-prs", "type": "hot-prs", "priority": 1, "nextRunAt": "...", "lastRunAt": "..." }] },
  "backfill": { "total": 14, "complete": 10, "pending": 3, "failed": 1, "percent_complete": 71.4 },
  "rate_limits": { "rest": { "remaining": 4500, "limit": 5000, "resets_at": "..." }, "search": { "tokens_available": 28, "limit": 30 }, "backfill_budget_available": 3500 }
}
```

### Get Sync Log

```
GET /api/web/github/sync-log?limit=50
```

Returns recent sync activity log entries.

**Response:** `{ "entries": [{ "level": "info", "category": "hot_sync", "message": "Synced 5 open PRs", "created_at": "..." }] }`

### Subscribe to Sync Log (SSE)

```
GET /api/web/github/sync-log/stream
```

Server-Sent Events stream of real-time sync activity. First replays recent history, then streams new entries as they occur.

**Events:** `data: { "level": "info", "category": "backfill", "message": "...", "created_at": "..." }`

### Get Sync Chunks

```
GET /api/web/github/sync-chunks
```

Returns all backfill chunk documents for timeline visualization.

**Response:**
```json
{
  "chunks": [{ "_id": "prs:foursquare:2024-01-01..2024-01-29", "status": "complete", "chunk_start": "...", "chunk_end": "...", "total_items": 42, "pages_fetched": 3 }]
}
```

### Trigger Sync Task

```
POST /api/web/github/sync/trigger
```

Manually triggers a specific sync task to run immediately.

**Body:** `{ "scope": "prs" }` (one of: `prs`, `backfill`, `teams`, `contributions`)

**Response (200):** `{ "ok": true }`

### Get GitHub Settings

```
GET /api/web/github/settings
```

Returns the current GitHub Hub settings (merged from DB + env + defaults), including token validation.

**Response:**
```json
{
  "resolved": {
    "org": "Foursquare",
    "team_slug": "places-engineering",
    "username": "svitali",
    "history_days": 365,
    "default_scope": "team",
    "pinned_repos": ["my-app"],
    "contribution_range": "30d",
    "sync_enabled": true,
    "hot_interval_seconds": 600,
    "warm_interval_seconds": 3600
  },
  "db_overrides": { ... },
  "token": {
    "configured": true,
    "valid": true,
    "scopes": ["repo", "read:org"]
  }
}
```

### Update GitHub Settings

```
POST /api/web/github/settings
```

Saves GitHub Hub settings to MongoDB. Invalidates the config cache so changes take effect immediately.

**Body:**
```json
{
  "org": "Foursquare",
  "team_slug": "places-engineering",
  "sync_enabled": true,
  "history_days": 365,
  "default_scope": "team",
  "pinned_repos": ["my-app"],
  "contribution_range": "30d"
}
```

**Response (200):** `{ "ok": true }`

> **Note:** Token validation is included in the `GET /api/web/github/settings` response (see `token` field above). There is no separate token-status endpoint.

---

## Job Document Schema

```typescript
interface JobDoc {
  _id?: ObjectId;
  task_id: string;                    // UUID, unique
  job_type?: "create" | "respond_to_pr_comments" | "self_review_pr" | "add_pr_review_comments" | "github_summary";  // default: "create"
  source: {
    type: "slack_app_mention" | "web_create";
    event_id?: string;                // Slack event ID (unique when present)
  };
  requested_by: string;               // Slack user ID or username
  slack_requester?: string;           // Original Slack user (when job owner differs)
  status: "QUEUED" | "BLOCKED" | "PLANNING" | "PENDING_CONFIRMATION" | "RUNNING"
         | "FIXING_CI" | "WAITING_FOR_APPROVAL"
         | "DONE" | "FAILED" | "CANCELED" | "DELETED";
  created_at: Date;
  updated_at: Date;

  slack?: {
    channel_id?: string;
    thread_ts?: string;
    message_ts?: string;
    permalink?: string;
  };

  title?: string;                     // LLM-generated job title
  task_text: string;
  repo_hint?: string;
  pr_url?: string;                    // For respond_to_pr_comments / self_review_pr / add_pr_review_comments jobs
  test_level?: "fast" | "full" | "none";
  ci_fix_enabled?: boolean;
  reviewers?: string[];
  needs_plan?: boolean;               // If true, run planning phase before execution
  plan?: {                            // Generated plan from planning phase
    summary: string;
    generated_at: Date;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
  custom_instructions?: string;       // Custom instructions injected into Claude prompt

  // GitHub query params (for github_summary jobs)
  github_query?: {
    query_type: GithubQueryType;      // "my_recap" | "team_recap" | ...
    time_range?: string;
    org?: string;
    team_slug?: string;
    github_username?: string;
  };

  // Lease
  claimed_by?: string;                // worker node ID
  lease_expires_at?: Date;
  heartbeat_at?: Date;
  attempt?: number;
  not_before?: Date;                  // Requeue backoff — don't claim before this time
  run_started_at?: Date;
  run_ended_at?: Date;

  // Outputs
  repos_resolved?: string[];
  branch_name?: string;
  worktree_slot?: string;             // Which worktree slot was used
  pr_urls?: string[];
  ci?: { provider?: string; runs?: CIRun[] };
  result_summary?: string;
  error?: { code?: string; message: string; details?: any };

  // Attachments (files from Slack thread)
  attachments?: Array<{
    file_id: string;
    filename: string;
    mimetype: string;
    size_bytes: number;
    base64: string;
  }>;

  // Events (append-only log)
  events?: Array<{
    at: Date;
    node_id?: string;
    type: string;
    payload?: any;  // truncated to 10KB
  }>;

  // Metrics
  metrics?: {
    durations?: { total_ms?, claude_code_ms?, ci_wait_ms?, ... };
    claude?: {
      sessions?: Array<{
        phase: "plan" | "code" | "review" | "fix" | "respond_comments" | "summary";
        model?: string;
        input_tokens?: number;
        output_tokens?: number;
        duration_ms?: number;
        cost_usd?: number;
      }>;
      total_input_tokens?: number;
      total_output_tokens?: number;
      total_cost_usd?: number;
    };
  };

  // Linking
  parent_task_id?: string;            // set on retry

  // Per-PR queue: this job is blocked until the referenced job finishes
  blocked_by?: string;
}
```
