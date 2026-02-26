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
  "concurrency": 4,
  "version": "0.2.0"
}
```

**Response (200):** `{ "ok": true }`

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
  "reason": "no_worktree_slot",
  "backoff_seconds": 30
}
```

**Response (200):** `{ "ok": true, "not_before": "2025-..." }`

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

### List PRs

```
GET /api/web/prs
```

Lists open PRs across all registered repos (from `repo-registry.yaml`). Includes per-PR comment stats (total threads, unresolved, awaiting-author).

**Response:**
```json
{
  "prs": [
    {
      "repo": "my-app",
      "number": 42,
      "title": "Fix auth bug",
      "url": "https://github.com/org/my-app/pull/42",
      "author": "alice",
      "stats": { "total_threads": 5, "unresolved": 2, "awaiting_author": 1 }
    }
  ]
}
```

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
  "my-app": [
    { "slot": "my-app-n-0", "locked": true, "branch": "sos/fix-auth" },
    { "slot": "my-app-n-1", "locked": false }
  ]
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

Spawns a new detached worker process on the local machine via `child_process.spawn`.

**Body:**
```json
{ "concurrency": 4 }
```

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

**Response:** `{ "reply": { "role": "assistant", "text": "..." }, "action": { ... } }`

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

## Job Document Schema

```typescript
interface JobDoc {
  _id?: ObjectId;
  task_id: string;                    // UUID, unique
  job_type?: "create" | "respond_to_pr_comments" | "github_summary" | "plan";  // default: "create"
  source: {
    type: "slack_app_mention" | "web_create";
    event_id?: string;                // Slack event ID (unique when present)
  };
  requested_by: string;               // Slack user ID or username
  slack_requester?: string;           // Original Slack user (when job owner differs)
  status: "QUEUED" | "RUNNING" | "FIXING_CI" | "WAITING_FOR_APPROVAL"
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
  pr_url?: string;                    // For respond_to_pr_comments jobs
  test_level?: "fast" | "full" | "none";
  ci_fix_enabled?: boolean;
  reviewers?: string[];

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
        phase: "code" | "review" | "fix" | "respond_comments";
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
}
```
