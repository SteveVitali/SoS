# API Reference

All endpoints require authentication. Worker endpoints use `Authorization: Bearer <SOS_INTERNAL_API_TOKEN>`. Web endpoints use the same Bearer token or optional HTTP Basic Auth.

## Worker Endpoints (`/api/worker`)

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

### List Users

```
GET /api/web/users
```

Returns distinct `requested_by` values from non-deleted jobs (for filter dropdowns).

**Response:** `{ "users": ["U1234", "U5678"] }`

---

## Job Document Schema

```typescript
interface JobDoc {
  _id?: ObjectId;
  task_id: string;                    // UUID, unique
  source: {
    type: "slack_app_mention" | "web_create";
    event_id?: string;                // Slack event ID (unique when present)
  };
  requested_by: string;               // Slack user ID
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

  task_text: string;
  repo_hint?: string;
  test_level?: "fast" | "full" | "none";
  ci_fix_enabled?: boolean;
  reviewers?: string[];

  // Lease
  claimed_by?: string;                // worker node ID
  lease_expires_at?: Date;
  heartbeat_at?: Date;
  attempt?: number;
  run_started_at?: Date;
  run_ended_at?: Date;

  // Outputs
  repos_resolved?: string[];
  branch_name?: string;
  pr_urls?: string[];
  ci?: { provider?: string; runs?: CIRun[] };
  result_summary?: string;
  error?: { code?: string; message: string; details?: any };

  // Events (append-only log)
  events?: Array<{
    at: Date;
    node_id?: string;
    type: string;
    payload?: any;  // truncated to 10KB
  }>;

  // Linking
  parent_task_id?: string;            // set on retry
}
```
