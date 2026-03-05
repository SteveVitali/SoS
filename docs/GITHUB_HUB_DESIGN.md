# GitHub Hub — Design Document

> **Status:** Implemented
> **Author:** Steve + Cascade
> **Date:** 2026-03-04
> **Revised:** 2026-03-04 — REST-only, deterministic chunking, backfill system, sync transparency UI

---

## 1. Vision

Transform the current "PRs" tab into a comprehensive **GitHub Hub** — a continuously-updated, org-wide view of pull requests, contributions, and team activity. The system should feel instant on page load because all GitHub data is pre-fetched and stored, not fetched on demand.

### North Star

- The server **continuously** maintains an up-to-date mirror of an entire GitHub Org's:
  - Teams and their membership
  - Each member's PRs (open, merged, closed) across all org repos
  - Each member's reviews, commits, and contribution activity
- When a user loads the UI, the data is **already there** — no loading spinners, no rate-limit errors
- Users can filter by **Me / My Team / My Org** and drill into any individual
- A separate **Contributions** view provides aggregated stats with time-range slicing
- Full transparency into the sync engine's real-time activity, progress, and rate-limit status

### Constraints

- **No GitHub GraphQL API** — the target org restricts GraphQL access. All data fetching must use the **GitHub REST API v3** and the **REST Search API** exclusively.
- **REST Search API limit:** 30 requests/minute, max 1,000 results per query. This necessitates deterministic date-range chunking to keep result sets small and cache-friendly.

---

## 2. Current State Analysis

### What Exists

| Layer | Current Approach | Limitation |
|-------|-----------------|------------|
| **Data fetching** | `gh` CLI (`execSync`) shelling out per request | Synchronous, blocks Node event loop, no parallelism control |
| **Caching** | In-memory `TtlCache` (2-5 min TTL) | Lost on restart, no persistence, no background refresh |
| **Scope** | Only the authenticated user's PRs + one team | No org-wide data, no historical tracking |
| **UI** | Flat PR list with open/closed/merged filter | No team/org grouping, no contribution stats |
| **Rate limiting** | Retry with exponential backoff on 429s | Reactive, not proactive; no budget management |

### Key Pain Points

1. **Cold start is slow** — first load shells out to `gh` for every repo, serially
2. **Rate limits hit easily** — team queries do N per-member searches (no batch)
3. **No persistence** — restart = refetch everything
4. **No historical data** — can only see current state, not trends

---

## 3. Architecture

### 3.1 Core Idea: MongoDB as the GitHub Data Cache

Instead of in-memory TTL caches, persist all GitHub data to MongoDB. The server runs background sync loops that continuously poll GitHub via the REST API and upsert records. The UI reads from MongoDB, never from GitHub directly. When the MongoDB cache is incomplete (e.g., backfill still in progress), the API layer falls back to live GitHub REST fetches so the user always sees *something*.

```
┌──────────────────────────────────────────────────────┐
│                GitHub REST API v3                      │
│  (REST endpoints + Search API)                        │
└─────────────────────┬────────────────────────────────┘
                      │ background sync (rate-limited)
                      ▼
┌──────────────────────────────────────────────────────┐
│              GitHubSyncService                        │
│  - OrgSyncer (teams, members)                        │
│  - PrSyncer (open PRs, historical chunks)            │
│  - ContributionSyncer (reviews, comments, commits)   │
│  - BackfillScheduler (deterministic chunk queue)     │
│  - RateLimitBudget (tracks remaining REST quota)     │
│  - SyncEventLog (real-time activity stream)          │
└─────────────────────┬────────────────────────────────┘
                      │ upsert
                      ▼
┌──────────────────────────────────────────────────────┐
│              MongoDB Collections                      │
│  github_org_members   github_teams                   │
│  github_prs           github_contributions           │
│  github_sync_chunks   github_sync_log                │
│  github_settings                                     │
└─────────────────────┬────────────────────────────────┘
                      │ read (+ live fallback if missing)
                      ▼
┌──────────────────────────────────────────────────────┐
│            SoS REST API Endpoints                     │
│  GET /api/web/github/prs?scope=me|team|org           │
│  GET /api/web/github/contributions?scope=...&range=  │
│  GET /api/web/github/teams                           │
│  GET /api/web/github/sync-status                     │
│  GET /api/web/github/sync-log (SSE stream)           │
└─────────────────────┬────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────┐
│            React UI — "GitHub" Tab                    │
│  Scope toggle: Me | My Team | My Org                 │
│  Sub-tabs: Pull Requests | Contributions | Sync      │
│  Instant render from pre-fetched data                │
└──────────────────────────────────────────────────────┘
```

### 3.2 MongoDB Collections

#### `github_org_members`

```typescript
interface GitHubOrgMember {
  _id: string;               // github login (lowercase)
  login: string;             // original case
  avatar_url: string;
  name?: string;
  teams: string[];           // team slugs this member belongs to
  org: string;
  synced_at: Date;
}
// Index: { org: 1, login: 1 } unique
// Index: { "teams": 1 }
```

#### `github_teams`

```typescript
interface GitHubTeam {
  _id: string;               // "org/team-slug"
  org: string;
  slug: string;
  name: string;
  description?: string;
  member_count: number;
  synced_at: Date;
}
```

#### `github_prs`

This is the workhorse collection — every PR we know about.

```typescript
interface GitHubPrDoc {
  _id: string;                // "owner/repo#123"
  org: string;
  repo: string;               // "owner/repo"
  number: number;
  title: string;
  author: string;             // login
  state: "open" | "closed" | "merged";
  is_draft: boolean;
  head_ref: string;
  base_ref: string;
  additions: number;
  deletions: number;
  changed_files: number;
  labels: string[];
  review_decision?: string;   // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  created_at: Date;
  updated_at: Date;
  merged_at?: Date;
  closed_at?: Date;

  // Review thread summary (denormalized for fast queries)
  comment_stats?: {
    total_threads: number;
    total_comments: number;
    unresolved_threads: number;
  };

  // Reviewers
  requested_reviewers: string[];
  reviews: Array<{
    author: string;
    state: string;             // APPROVED, CHANGES_REQUESTED, COMMENTED
    submitted_at: Date;
  }>;

  // Sync metadata
  synced_at: Date;
  detail_synced_at?: Date;    // when additions/deletions/reviews were last fetched
  chunk_id?: string;          // which backfill chunk populated this record
}
// Index: { org: 1, state: 1, updated_at: -1 }
// Index: { author: 1, state: 1, updated_at: -1 }
// Index: { "requested_reviewers": 1, state: 1 }
// Index: { repo: 1, number: 1 } unique
```

#### `github_contributions`

Daily-aggregated contribution stats per user. Built from `github_prs` data via periodic MongoDB aggregation (not live API calls per contribution).

```typescript
interface GitHubContribution {
  _id: string;                // "login:2026-03-04"
  login: string;
  org: string;
  date: Date;                 // day (truncated to midnight UTC)

  prs_opened: number;
  prs_merged: number;
  prs_closed: number;
  reviews_submitted: number;
  review_comments: number;
  commits: number;            // across all merged PRs
  additions: number;
  deletions: number;
  repos_touched: string[];    // distinct repos

  synced_at: Date;
}
// Index: { login: 1, date: -1 }
// Index: { org: 1, date: -1 }
```

#### `github_sync_chunks`

Tracks the state of every deterministic backfill chunk (see §4 for full explanation).

```typescript
interface GitHubSyncChunk {
  _id: string;                // e.g. "prs:Foursquare:2025-07-07..2025-08-04"
  org: string;
  data_type: "prs" | "reviews" | "contributions";
  chunk_start: Date;          // inclusive
  chunk_end: Date;            // exclusive
  status: "pending" | "in_progress" | "complete" | "failed";
  pages_fetched: number;      // for resumability within a chunk
  total_items: number;        // items upserted from this chunk
  started_at?: Date;
  completed_at?: Date;
  error?: string;
  attempt: number;            // retry count
}
// Index: { org: 1, data_type: 1, chunk_start: 1 } unique
// Index: { status: 1, chunk_start: -1 }
```

#### `github_sync_log`

Real-time activity log for the sync engine. Powers the Sync transparency UI.

```typescript
interface GitHubSyncLogEntry {
  _id: ObjectId;
  ts: Date;
  level: "info" | "warn" | "error" | "debug";
  category: "backfill" | "hot_sync" | "rate_limit" | "org_sync" | "live_fallback";
  message: string;
  details?: {
    chunk_id?: string;
    api_endpoint?: string;
    status_code?: number;
    rate_limit_remaining?: number;
    rate_limit_reset?: Date;
    items_fetched?: number;
    duration_ms?: number;
    error?: string;
  };
}
// Index: { ts: -1 } with TTL expiry (e.g., 7 days)
// Index: { category: 1, ts: -1 }
```

#### `github_settings`

UI-overridable settings (see §6.3).

---

## 4. Deterministic Chunk System & Historical Backfill

This is the most critical design element. The backfill system must:
1. **Fill historical data exactly once per chunk** — no redundant re-fetching
2. **Use deterministic, stable date ranges** — the same chunk boundaries regardless of when the sync runs
3. **Continuously fill gaps** — allocate a portion of the API budget to backfill until the full history window is populated
4. **Be resumable** — if the server restarts mid-chunk, pick up where it left off

### 4.1 Epoch-Anchored 4-Week Chunks

All time is divided into fixed **28-day (4-week) chunks** anchored to a configurable epoch date.

```typescript
const CHUNK_EPOCH = new Date("2024-01-01T00:00:00Z"); // Monday, Jan 1 2024
const CHUNK_DAYS = 28;

/**
 * Given any date, compute the chunk it belongs to.
 * Chunks are [start, end) — start-inclusive, end-exclusive.
 */
function getChunkForDate(date: Date): { start: Date; end: Date; id: string } {
  const epochMs = CHUNK_EPOCH.getTime();
  const dateMs = date.getTime();
  const msSinceEpoch = dateMs - epochMs;
  const chunkMs = CHUNK_DAYS * 24 * 60 * 60 * 1000;
  const chunkIndex = Math.floor(msSinceEpoch / chunkMs);
  const start = new Date(epochMs + chunkIndex * chunkMs);
  const end = new Date(start.getTime() + chunkMs);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];
  return { start, end, id: `${startStr}..${endStr}` };
}

/**
 * Generate all chunk boundaries between a start date and now.
 */
function getAllChunks(since: Date): Array<{ start: Date; end: Date; id: string }> {
  const chunks = [];
  let current = getChunkForDate(since);
  const now = new Date();
  while (current.start < now) {
    chunks.push(current);
    current = getChunkForDate(new Date(current.end.getTime()));
  }
  return chunks;
}
```

**Why this matters:**
- On March 4, 2026, the chunk `2026-02-17..2026-03-17` is "current." If you ask for the same data on March 10, you get the *same chunk boundary* — the cache key is stable.
- Historical chunks (e.g., `2025-07-07..2025-08-04`) are **immutable** — PRs merged 8 months ago don't change. Once fetched, never re-fetched.
- The "current" chunk (containing today) is the **only chunk that gets re-synced**, because it's still accumulating new data.

### 4.2 Backfill Lifecycle

```
Server starts
    │
    ▼
┌─────────────────────────────────────┐
│ 1. Compute all chunks from          │
│    (now - SOS_GITHUB_HISTORY_DAYS)  │
│    to now                           │
│ 2. Check github_sync_chunks for     │
│    each chunk's status              │
│ 3. Queue missing/failed chunks      │
│    (oldest-first)                   │
└─────────────────┬───────────────────┘
                  │
    ┌─────────────▼──────────────┐
    │   Priority-Queue Loop       │
    │                             │
    │  HOT tasks (Tier 1) first: │
    │   - Open PRs refresh       │
    │   - Current chunk re-sync  │
    │                             │
    │  Then BACKFILL tasks:      │
    │   - Next incomplete chunk  │
    │   - Process one chunk at   │
    │     a time, oldest first   │
    │                             │
    │  Then WARM tasks (Tier 2): │
    │   - Team membership        │
    │   - PR detail enrichment   │
    └─────────────┬──────────────┘
                  │
                  ▼
    Chunk marked "complete" in
    github_sync_chunks — NEVER
    re-fetched (except current chunk)
```

### 4.3 How a Single Chunk Is Synced (REST API)

Because we can't use GraphQL, each chunk requires multiple REST Search API calls with date-range qualifiers.

For a chunk `2025-09-22..2025-10-20` in org `Foursquare`:

```
Step 1: Search for PRs created in this date range
  GET /search/issues?q=org:Foursquare+type:pr+created:2025-09-22..2025-10-19
    &sort=created&order=asc&per_page=100&page=1
  (paginate through all pages, up to 1000 results)

Step 2: Search for PRs merged in this date range (catches PRs created earlier but merged in this window)
  GET /search/issues?q=org:Foursquare+type:pr+merged:2025-09-22..2025-10-19
    &sort=updated&order=asc&per_page=100&page=1

Step 3: Search for PRs closed (not merged) in this date range
  GET /search/issues?q=org:Foursquare+type:pr+is:unmerged+closed:2025-09-22..2025-10-19
    &sort=updated&order=asc&per_page=100&page=1

Step 4: For each new/updated PR, fetch detail (additions, deletions, reviews)
  GET /repos/{owner}/{repo}/pulls/{number}          (1 req per PR)
  GET /repos/{owner}/{repo}/pulls/{number}/reviews   (1 req per PR)
```

**1,000-result cap handling:** If any single search returns 1,000 results (the GitHub max), the chunk is **too large**. The syncer automatically subdivides into 2-week sub-chunks and retries. For most orgs, 4 weeks of PRs will be well under 1,000.

**Pagination tracking:** The `github_sync_chunks` doc stores `pages_fetched` so that if the server restarts mid-paginate, it can resume from the last page instead of re-fetching everything.

### 4.4 REST API Budget Allocation for Backfill

The sync engine splits the hourly REST budget into three pools:

| Pool | % of Budget | Requests/Hour | Purpose |
|------|-------------|---------------|---------|
| **Hot sync** | 40% | 2,000 | Open PRs, current-chunk refresh, PR detail enrichment |
| **Backfill** | 40% | 2,000 | Historical chunk processing (until complete, then released to hot) |
| **Interactive** | 20% | 1,000 | User-triggered refreshes, live-fetch fallback |

Once backfill is 100% complete, the backfill pool is reassigned to hot sync, giving faster refresh rates.

**Search API sub-budget:** The 30 req/min Search API limit is the real bottleneck. The sync engine maintains a separate token-bucket rate limiter for search requests:

```typescript
class SearchRateLimiter {
  // Token bucket: 30 tokens, refill 1 every 2 seconds
  private tokens = 30;
  private lastRefill = Date.now();

  async acquire(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      await sleep(2000);
      this.refill();
    }
    this.tokens--;
  }

  private refill(): void {
    const elapsed = Date.now() - this.lastRefill;
    const newTokens = Math.floor(elapsed / 2000);
    this.tokens = Math.min(30, this.tokens + newTokens);
    this.lastRefill += newTokens * 2000;
  }
}
```

### 4.5 Backfill Progress Tracking

The system always knows exactly how much backfill remains:

```typescript
interface BackfillProgress {
  total_chunks: number;        // e.g., 13 chunks for 1 year
  completed_chunks: number;
  in_progress_chunk?: string;  // chunk ID currently being processed
  failed_chunks: number;
  estimated_completion?: Date;  // based on current throughput
  oldest_data_available: Date;  // earliest chunk_start that's complete
  newest_data_available: Date;  // latest chunk_end that's complete
  prs_total: number;           // total PRs ingested across all chunks
}
```

This is exposed via the API and drives the Sync transparency UI.

### 4.6 Chunk Immutability Rules

| Chunk Type | Re-sync Policy |
|------------|---------------|
| **Historical** (chunk_end < today) | **Never re-synced** once status = "complete". Immutable. |
| **Current** (chunk contains today) | **Re-synced on hot-sync cadence** (every 2-5 min) for new PRs. |
| **Failed** | Retried with exponential backoff (3 attempts), then parked until manual trigger. |

### 4.7 Backfill Estimation

For a 1-year backfill of a medium org (~100 members, ~50 repos):

| Metric | Estimate |
|--------|----------|
| Total chunks | ~13 (365 / 28) |
| PRs per chunk (created + merged + closed searches) | ~3-9 search requests + pagination |
| PR detail enrichment per chunk | ~50-200 REST calls |
| **Estimated total requests for full backfill** | ~3,000-5,000 |
| **Time to complete at 40% budget (2,000 req/hr)** | ~2-3 hours |
| **Time to complete at search rate (30 req/min)** | ~3-5 hours (search is the bottleneck) |

So a fresh install with 1 year of backfill will be fully caught up in **3-5 hours** of background syncing. The UI shows progress throughout via the Sync panel.

---

## 5. Rate Limit Budget Manager

### 5.1 Dual Rate Limiters

GitHub imposes two independent rate limits that must be tracked separately:

```typescript
class RateLimitBudget {
  // --- Core REST API (5,000/hour) ---
  private restRemaining: number = 5000;
  private restResetsAt: Date;

  // --- Search API (30/minute) ---
  private searchTokens: number = 30;
  private searchLastRefill: number = Date.now();

  /** Update from X-RateLimit-* response headers (every REST call). */
  updateFromHeaders(headers: {
    "x-ratelimit-remaining": string;
    "x-ratelimit-reset": string;
  }): void;

  /** Can we afford `cost` REST requests right now? */
  canSpendRest(cost: number): boolean {
    const reserved = 1000; // interactive reserve
    return this.restRemaining - reserved >= cost;
  }

  /** Acquire a search API token (blocks until available). */
  async acquireSearch(): Promise<void>;

  /** Snapshot for UI display. */
  getStatus(): {
    rest: { remaining: number; limit: number; resetsAt: Date };
    search: { tokensAvailable: number; limit: number };
    backfillBudgetAvailable: number;
  };
}
```

### 5.2 Conditional Requests (ETags)

For frequently-polled REST endpoints (team membership, open PRs per repo), Octokit's built-in ETag support is critical:

- First request → GitHub returns `ETag: "abc123"`, costs 1 request
- Subsequent request with `If-None-Match: "abc123"` → GitHub returns `304 Not Modified`, **costs 0 requests**

The sync engine stores ETags per endpoint in a lightweight in-memory map (no MongoDB needed — ETags are transient).

```typescript
const etagCache = new Map<string, string>(); // endpoint URL → ETag
```

This dramatically reduces effective rate limit consumption for hot-sync operations where data hasn't changed.

---

## 6. Configuration

### 6.1 GitHub Token Type

The `SOS_GITHUB_TOKEN` should be a **Classic Personal Access Token (PAT)**:

- **Generate at:** https://github.com/settings/tokens (choose "Tokens (classic)")
- **Required scopes:**
  - `repo` — full read access to private repos (PRs, reviews, commits)
  - `read:org` — read org membership, teams
- **SSO:** If your org uses SAML SSO, you must **authorize** the PAT for the org after creation (click "Configure SSO" → "Authorize" next to your org name)
- Fine-grained PATs are an alternative but require org admin opt-in and have more restrictive scoping. Classic PATs are more universally supported at enterprises.

The token is **never exposed to the UI** — it's server-side only.

### 6.2 Environment Variables

```bash
# Required
SOS_GITHUB_ORG=Foursquare                 # The org to sync
SOS_GITHUB_TOKEN=ghp_xxx                  # Classic PAT with repo + read:org scopes

# Optional — defaults can be overridden in UI
SOS_GITHUB_TEAM_SLUG=places-engineering   # Default "my team"
SOS_GITHUB_USERNAME=svitali               # Override auto-detected user

# Backfill
SOS_GITHUB_HISTORY_DAYS=365              # Max age to backfill (default: 365 = 1 year)
SOS_GITHUB_CHUNK_DAYS=28                 # Chunk size in days (default: 28 = 4 weeks)
SOS_GITHUB_CHUNK_EPOCH=2024-01-01        # Epoch anchor date for chunk boundaries

# Sync tuning
SOS_GITHUB_SYNC_ENABLED=true             # Master switch for background sync
SOS_GITHUB_SYNC_HOT_INTERVAL=120         # Seconds between hot tier syncs (default: 120)
SOS_GITHUB_SYNC_WARM_INTERVAL=900        # Seconds between warm tier syncs (default: 900)
```

### 6.3 UI-Overridable Settings

Store in `github_settings` MongoDB collection (one doc, global):

```typescript
interface GitHubSettings {
  _id: "global";
  org: string;                  // overrides SOS_GITHUB_ORG
  team_slug: string;            // overrides SOS_GITHUB_TEAM_SLUG
  username: string;             // overrides SOS_GITHUB_USERNAME
  history_days: number;         // overrides SOS_GITHUB_HISTORY_DAYS
  default_scope: "me" | "team" | "org";
  pinned_repos: string[];
  contribution_range: string;   // e.g., "30d"
  sync_enabled: boolean;        // overrides SOS_GITHUB_SYNC_ENABLED
}
```

**Resolution order:** UI setting (MongoDB) > env var > hardcoded default. Same pattern as the existing model config.

Settings are editable from a Settings panel in the GitHub tab UI (see §8.4).

---

## 7. SoS REST API Endpoints

### 7.1 Pull Requests

```
GET /api/web/github/prs
  ?scope=me|team|org
  &team=<team-slug>           (required when scope=team)
  &state=open|merged|closed|all
  &author=<login>             (optional, filter to specific user)
  &repo=<owner/repo>          (optional, filter to specific repo)
  &sort=updated|created       (default: updated)
  &limit=50&offset=0
```

Reads from `github_prs` collection. If chunk coverage for the requested date range is incomplete, transparently supplements with live REST fetch and returns `X-SoS-Data-Source: partial-cache` header.

### 7.2 Contributions

```
GET /api/web/github/contributions
  ?scope=me|team|org
  &team=<team-slug>
  &login=<specific-user>
  &range=7d|30d|90d|1y|custom
  &start=2026-01-01&end=2026-03-01
  &group_by=day|week|month
```

Returns aggregated contribution data from `github_contributions`, with MongoDB aggregation pipeline for grouping/summing.

### 7.3 Teams & Members

```
GET /api/web/github/teams
GET /api/web/github/teams/:slug/members
GET /api/web/github/members              (all org members)
```

### 7.4 Sync Status & Log

```
GET /api/web/github/sync-status
```

Returns:

```typescript
interface SyncStatusResponse {
  enabled: boolean;
  backfill: BackfillProgress;  // see §4.5
  rate_limit: {
    rest: { remaining: number; limit: number; resets_at: string };
    search: { tokens_available: number; limit: number };
  };
  hot_sync: {
    last_run_at: string;
    next_run_at: string;
    interval_seconds: number;
  };
  warm_sync: {
    last_run_at: string;
    next_run_at: string;
    interval_seconds: number;
  };
}
```

```
GET /api/web/github/sync-log?limit=100&since=<iso-date>&category=<filter>
```

Returns recent sync log entries from `github_sync_log`. Optionally:

```
GET /api/web/github/sync-log/stream   (SSE — Server-Sent Events)
```

Real-time streaming of sync log entries as they happen, for the live activity feed in the Sync UI.

### 7.5 Manual Actions

```
POST /api/web/github/sync/trigger
  { scope: "prs" | "teams" | "contributions" | "backfill", force: boolean }
```

Lets the user force an immediate sync of a specific data type (uses the interactive rate limit reserve). `force: true` on backfill retries any failed chunks.

```
POST /api/web/github/settings
  { ...GitHubSettings fields to update }
```

Update UI-overridable settings.

---

## 8. UI Design

### 8.1 Navigation Change

Rename the "PRs" tab to **"GitHub"**. Internal sub-navigation via tabs within the page (not a dropdown — matches existing SoS pattern).

The route changes from `/prs` to `/github`, with sub-routes:

```
/github              → redirects to /github/prs
/github/prs          → Pull Requests view
/github/contributions → Contributions view
/github/sync         → Sync Dashboard
/github/settings     → Settings panel
```

### 8.2 GitHub Hub — Pull Requests View

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub                                                       │
│ ┌──────────┐┌──────────────┐┌──────┐┌──────────┐            │
│ │▸ PRs     ││Contributions ││ Sync ││ Settings │            │
│ └──────────┘└──────────────┘└──────┘└──────────┘            │
│                                                             │
│ ┌──────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│ │  ● Me            │  │  My Team     │  │  My Org       │  │
│ │  (svitali)       │  │ (places-e…)  │  │ (Foursquare)  │  │
│ └──────────────────┘  └──────────────┘  └───────────────┘  │
│                                                             │
│ State: [Open ▾]   Repo: [All repos ▾]   Author: [All ▾]   │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ OPEN  Fix cache invalidation bug                        │ │
│ │       foursquare/pilgrim#4521 · svitali · feat/cache    │ │
│ │       Updated 2h ago · +34/-12 · 3 threads (1 unresol.) │ │
│ │                                [Self Review ▾] [Trigger] │ │
│ ├─────────────────────────────────────────────────────────┤ │
│ │ OPEN  Add TypeScript strict mode                        │ │
│ │       foursquare/web-app#891 · jdoe · feat/strict-ts   │ │
│ │       Updated 5h ago · +892/-340 · Awaiting review      │ │
│ │                                           [Trigger ▾]   │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ Showing 24 PRs · Synced 2 min ago · Backfill 85% complete  │
└─────────────────────────────────────────────────────────────┘
```

**Key UX decisions:**

1. **Scope toggle is prominent** — three large, segmented buttons at the top. The active one is visually distinct (filled vs outlined). This is the primary navigation axis.

2. **Scope memory** — remember the last-selected scope in `localStorage`. If you always work in "My Team" mode, it stays there.

3. **"My Team" selector** — when "My Team" is active, show a small dropdown next to it letting you pick which team (if the user belongs to multiple). Defaults to `SOS_GITHUB_TEAM_SLUG` / settings.

4. **"My Org" author drill-down** — in org mode, show an optional author filter dropdown populated from `github_org_members`. Selecting a person filters to just their PRs, essentially letting you "view as" anyone in the org.

5. **"Trigger" actions on team/org PRs** — same dropdown (Self Review, Add Review Comments, Respond to Comments) available on any PR, not just your own. This is the killer feature: a team lead can trigger SoS actions on any teammate's PR.

6. **Sync indicator** — bottom bar shows "Synced 2 min ago" + backfill progress. Clickable to jump to the Sync sub-tab.

### 8.3 GitHub Hub — Contributions View

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub                                                       │
│ ┌──────┐┌──────────────────┐┌──────┐┌──────────┐            │
│ │ PRs  ││▸ Contributions   ││ Sync ││ Settings │            │
│ └──────┘└──────────────────┘└──────┘└──────────┘            │
│                                                             │
│ ┌──────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│ │  ● Me            │  │  My Team     │  │  My Org       │  │
│ └──────────────────┘  └──────────────┘  └───────────────┘  │
│                                                             │
│ Range: [Last 30 days ▾]  Group by: [Week ▾]                │
│                                                             │
│ ┌─ Summary ─────────────────────────────────────────────┐  │
│ │  PRs Merged: 12    Reviews: 34    Commits: 89         │  │
│ │  +4,521 / -1,203   Repos: 5                           │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌─ Activity Chart ──────────────────────────────────────┐  │
│ │  ██▓▓░░██████▓▓▓▓░░░░██████████▓▓ (stacked bar/area) │  │
│ │  W1        W2        W3        W4                      │  │
│ │  ■ PRs Merged  ■ Reviews  ■ Commits                   │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌─ Leaderboard (Team/Org scope) ────────────────────────┐  │
│ │  #  Author     PRs   Reviews  +/-        Repos        │  │
│ │  1  svitali     8      12     +2.1k/-400  pilgrim,web │  │
│ │  2  jdoe        6      18     +1.8k/-900  web-app     │  │
│ │  3  asmith      4       8     +900/-200   api,infra   │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ Click a row to drill into that person's individual stats.  │
│ [Copy as Markdown]                                          │
└─────────────────────────────────────────────────────────────┘
```

**Key UX decisions:**

1. **Same scope toggle** as the PRs view — muscle memory, consistent.
2. **Time range presets** — 7d, 30d, 90d, 6m, 1y, custom. Default: 30d.
3. **Summary cards** at the top give the headline numbers at a glance.
4. **Activity chart** — stacked bar chart (recharts) showing contribution trends over time.
5. **Leaderboard** — in team/org scope, ranked table of contributors. Clickable rows drill into individual contribution detail. Visibility for engineering managers doing sprint recaps.
6. **Individual drill-down** — clicking a person shows their personal contribution chart and PR list.
7. **Export** — "Copy as Markdown" button for the summary (ties into existing github_summary job type).

### 8.4 GitHub Hub — Sync Dashboard ★ NEW

This is the transparency panel. It gives full real-time visibility into the sync engine's activity.

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub                                                       │
│ ┌──────┐┌──────────────┐┌──────────┐┌──────────┐            │
│ │ PRs  ││Contributions ││▸ Sync    ││ Settings │            │
│ └──────┘└──────────────┘└──────────┘└──────────┘            │
│                                                             │
│ ┌─ Backfill Progress ───────────────────────────────────┐  │
│ │  ████████████████████░░░░░  11/13 chunks  (85%)       │  │
│ │  Est. completion: ~45 min                              │  │
│ │                                                        │  │
│ │  Chunk Timeline:                                       │  │
│ │  ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ □ □                          │  │
│ │  Mar  Apr  May  Jun  Jul  Aug  Sep  Oct  Nov ... Feb  │  │
│ │  '25  '25  '25  '25  '25  '25  '25  '25  '25     '26 │  │
│ │                                                        │  │
│ │  ■ = complete  ▧ = in progress  □ = pending  ✕ = fail │  │
│ │  Total PRs ingested: 2,847                             │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌─ Rate Limits ─────────────────────────────────────────┐  │
│ │  REST API:   4,312 / 5,000 remaining  (resets 7:42pm) │  │
│ │  ██████████████████████████████████░░░░                │  │
│ │  Search API: 24 / 30 tokens available                  │  │
│ │  ████████████████████████░░░░░░                        │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌─ Live Activity ───────────────────────────────────────┐  │
│ │  19:28:01  [hot_sync]   Refreshed 42 open PRs (2.1s)  │  │
│ │  19:27:58  [backfill]   Chunk 2025-08-04..2025-09-01   │  │
│ │                         page 3/4 — 87 PRs found        │  │
│ │  19:27:45  [rate_limit] REST remaining: 4,312          │  │
│ │  19:27:30  [hot_sync]   PR detail enrichment: 8 PRs    │  │
│ │  19:27:15  [backfill]   Chunk 2025-08-04..2025-09-01   │  │
│ │                         page 2/4 — 62 PRs found        │  │
│ │  19:27:01  [org_sync]   Synced 5 teams, 127 members   │  │
│ │  19:26:45  [hot_sync]   Refreshed 42 open PRs (1.8s)  │  │
│ │  ...                                                    │  │
│ │  ┌─────────────────────────────────────────────────┐   │  │
│ │  │ Filter: [All ▾]  [Auto-scroll ✓]               │   │  │
│ │  └─────────────────────────────────────────────────┘   │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ [▶ Trigger Backfill]  [▶ Trigger Hot Sync]  [⟲ Retry Failed]│
└─────────────────────────────────────────────────────────────┘
```

**Key elements:**

1. **Backfill progress bar** — prominent at the top. Shows X/Y chunks complete with percentage and ETA. This is the first thing you see so you know how "caught up" the system is.

2. **Chunk timeline visualization** — a row of small squares, one per chunk, color-coded by status. Gives a visual map of which time periods are synced. Hovering a chunk shows its date range and item count.

3. **Rate limit gauges** — two horizontal bars showing REST API and Search API remaining quota. Updates in real-time. Color shifts from green → yellow → red as budget depletes.

4. **Live activity feed** — scrolling log of sync events, streamed via SSE from `/api/web/github/sync-log/stream`. Filterable by category (backfill, hot_sync, rate_limit, etc.). Auto-scroll toggle for "watching" mode.

5. **Manual trigger buttons** — force a hot sync, trigger backfill retry, or retry failed chunks.

**Implementation:** The live feed uses Server-Sent Events (SSE). The sync engine emits events to an in-memory EventEmitter; the SSE endpoint subscribes and forwards. MongoDB `github_sync_log` is the persistence layer for historical log entries.

### 8.5 GitHub Hub — Settings Panel

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub                                                       │
│ ┌──────┐┌──────────────┐┌──────┐┌──────────────┐            │
│ │ PRs  ││Contributions ││ Sync ││▸ Settings    │            │
│ └──────┘└──────────────┘└──────┘└──────────────┘            │
│                                                             │
│ ┌─ Organization ────────────────────────────────────────┐  │
│ │  Org:           [Foursquare        ]  (env: Foursquare)│  │
│ │  My Team:       [places-engineering▾]                   │  │
│ │  My Username:   [svitali           ]  (auto-detected)  │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌─ Defaults ────────────────────────────────────────────┐  │
│ │  Default scope:        (●) Me  ( ) Team  ( ) Org      │  │
│ │  Contribution range:   [30 days ▾]                     │  │
│ │  Pinned repos:         [foursquare/pilgrim      ] [x]  │  │
│ │                        [foursquare/web-app      ] [x]  │  │
│ │                        [+ Add repo]                    │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌─ Sync Configuration ─────────────────────────────────┐  │
│ │  Sync enabled:         [✓]                             │  │
│ │  History depth:        [365 ] days                     │  │
│ │  Hot sync interval:    [120 ] seconds                  │  │
│ │  Warm sync interval:   [900 ] seconds                  │  │
│ │                                                        │  │
│ │  Token status:  ✓ Valid (Foursquare SSO authorized)    │  │
│ │  Token scopes:  repo, read:org                         │  │
│ │                                                        │  │
│ │  [Save Settings]   [Reset to Defaults]                 │  │
│ └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key features:**

1. **Org/team/username** — editable, with env var defaults shown as hints.
2. **Token validation** — on page load, the server checks the PAT's validity and scopes via `GET /user` + `GET /rate_limit`. Shows a green checkmark or red warning.
3. **Team dropdown** — populated from `github_teams` collection (synced teams for this org).
4. **Pinned repos** — repos to highlight/prioritize in the PR list.
5. **Sync tuning** — adjust intervals and history depth without restarting the server.

---

## 9. Live-Fetch Fallback

When the MongoDB cache is incomplete (backfill in progress, or data never synced for a specific scope), the API layer **falls back to live GitHub REST calls** so the user always sees data.

### 9.1 Fallback Decision Logic

```typescript
async function getPrs(scope: Scope, filters: PrFilters): Promise<PrResult[]> {
  // 1. Query MongoDB
  const cached = await queryMongoPrs(scope, filters);

  // 2. Check if the requested date range is fully covered by completed chunks
  const coverage = await getChunkCoverage(scope.org, filters.dateRange);

  if (coverage.isComplete) {
    // Cache is authoritative — return directly, no GitHub call
    return cached;
  }

  // 3. Partial coverage — supplement with live fetch for uncovered ranges
  const gaps = coverage.missingRanges;
  const livePrs = await fetchLiveForRanges(scope, filters, gaps);

  // 4. Log the fallback event
  await logSyncEvent("live_fallback", `Supplemented ${gaps.length} gap(s) with live data`);

  // 5. Merge, deduplicate by PR ID, sort
  return mergeAndDeduplicate(cached, livePrs);
}
```

### 9.2 Fallback Indicators in UI

When data comes from live fallback, the UI shows:
- A subtle banner: "Some data fetched live — backfill 85% complete" with a mini progress bar
- No degradation in functionality, just transparency about data freshness

---

## 10. Relationship to Existing Features

### 10.1 `github_summary` Job Type

The existing recap/summary jobs (`my_recap`, `team_recap`) currently fetch data live from GitHub on every run. With the sync engine, they should read from MongoDB instead — faster, no rate limit risk, richer data. The live-fetch fallback (§9) ensures they still work even if backfill is incomplete.

### 10.2 Instant Queries (Chat Actions)

The `github_search` routing action currently calls `executeInstantQuery()` which shells out to `gh`. It should be migrated to query MongoDB, falling back to live fetch only if data is stale. The existing `queries.ts` functions become thin wrappers around MongoDB queries.

### 10.3 Existing `PrsList` + `PrRow` Components

These can be reused with minimal changes. `PrRow` is already well-structured. The main change is the data source (new API endpoint) and wrapping it in the new GitHub Hub layout with scope toggle + filters.

### 10.4 Existing `teamCache.ts`

Currently fetches team members via `gh` CLI with a 5-minute in-memory cache. Will be replaced by reading from `github_teams` / `github_org_members` collections. The `getTeamMembers()` function becomes a MongoDB query.

---

## 11. Transitioning from `gh` CLI to Octokit

| | `gh` CLI (current) | `@octokit/rest` (proposed) |
|-|--------------------|--------------------|
| **Auth** | Uses `gh auth` — zero config | Needs PAT in `SOS_GITHUB_TOKEN` env var |
| **Async** | `execSync` blocks event loop | Fully async, non-blocking |
| **Rate limits** | No visibility into remaining budget | Full `X-RateLimit-*` header access |
| **ETags** | Not supported | Built-in conditional requests via plugins |
| **Types** | Manual JSON parsing | Full TypeScript types for all endpoints |
| **Pagination** | Manual | Built-in `octokit.paginate()` helper |
| **Verdict** | Keep for `gh auth token` bootstrap | Use for all sync + API operations |

**Migration path:** The sync engine uses Octokit exclusively. Existing `gh` CLI code paths in `queries.ts` and `ghPrs.ts` continue working during transition and are gradually replaced with MongoDB reads. Once backfill is operational, the `gh` CLI code becomes dead code.

**Octokit with throttling plugin:**

```typescript
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const ThrottledOctokit = Octokit.plugin(throttling);
const octokit = new ThrottledOctokit({
  auth: process.env.SOS_GITHUB_TOKEN,
  throttle: {
    onRateLimit: (retryAfter, options) => {
      log.warn("Rate limit hit", { retryAfter, endpoint: options.url });
      return true; // retry
    },
    onSecondaryRateLimit: (retryAfter, options) => {
      log.warn("Secondary rate limit hit", { retryAfter });
      return true;
    },
  },
});
```

---

## 12. Implementation Plan

### Phase 1: Foundation (1-2 sprints)

- [x] Add `@octokit/rest`, `@octokit/plugin-throttling` dependencies
- [x] Create MongoDB collections + indexes (§3.2)
- [x] Implement `RateLimitBudget` with dual REST/Search tracking (§5)
- [x] Implement deterministic chunk system — `getChunkForDate()`, `getAllChunks()` (§4.1)
- [x] Build `GitHubSyncService` with priority-queue loop
- [x] Implement OrgSyncer (teams + members via REST)
- [x] Implement PrSyncer — hot sync (open PRs) + chunk-based backfill (§4.3)
- [x] Implement chunk state tracking in `github_sync_chunks` (§4.6)
- [x] Implement `SyncEventLog` writing to `github_sync_log`
- [x] Wire up sync service to start on server boot
- [x] Add `SOS_GITHUB_TOKEN` + all new env vars (§6.2)
- [x] Add `/api/web/github/sync-status` + `/sync-log` endpoints (§7.4)

### Phase 2: API + UI Migration (1-2 sprints)

- [x] Build new read-from-MongoDB API endpoints (§7.1-7.3)
- [x] Implement live-fetch fallback for incomplete cache (§9)
- [x] Rename "PRs" tab to "GitHub", add sub-tab navigation
- [x] Build scope toggle (Me / Team / Org) component
- [x] Migrate PrsList to read from new `/api/web/github/prs` endpoint
- [x] Add team/author/repo filter dropdowns
- [x] Preserve "Trigger" action functionality on all PRs
- [x] Build Sync Dashboard sub-tab (§8.4) — backfill progress, rate limits, live activity feed
- [x] Add SSE endpoint for live sync log streaming
- [x] Add sync status footer indicator on PRs/Contributions views

### Phase 3: Contributions (1 sprint)

- [x] Build ContributionSyncer — aggregates from `github_prs` data via MongoDB pipeline
- [x] Build `/api/web/github/contributions` endpoint with aggregation
- [x] Build Contributions sub-tab UI (§8.3)
- [x] Summary cards + stacked bar activity chart (recharts)
- [x] Leaderboard table with individual drill-down
- [x] "Copy as Markdown" export

### Phase 4: Polish + Migration (1 sprint)

- [x] Build Settings sub-tab (§8.5) with token validation
- [x] Settings persistence to `github_settings` collection
- [ ] Migrate existing `github_summary` jobs to read from MongoDB (§10.1)
- [ ] Migrate `executeInstantQuery()` to read from MongoDB (§10.2)
- [x] Performance tuning (MongoDB indexes, query optimization)
- [ ] Deprecate old `ghPrs.ts` + `queries.ts` + `teamCache.ts` code paths

---

## 13. Data Flow Summary

```
                    ┌─────────────┐
                    │ GitHub REST  │
                    │   API v3    │
                    └──────┬──────┘
                           │
              Background sync (Octokit)
              Deterministic 4-week chunks
                           │
                    ┌──────▼──────┐
                    │   MongoDB   │
                    │  (7 colls)  │
                    └──────┬──────┘
                           │
              SoS REST API (read from Mongo)
              + live fallback for gaps
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
   ┌─────▼────┐    ┌──────▼─────┐    ┌──────▼─────┐
   │ PRs View │    │  Contrib   │    │ Chat/LLM   │
   │   (UI)   │    │  View(UI)  │    │  Actions   │
   └──────────┘    └────────────┘    └────────────┘
         │
   ┌─────▼────────┐
   │ Sync Dashboard│
   │ (transparency)│
   └──────────────┘
```

The key insight: **MongoDB is the single source of truth for the UI**. The sync engine is the only component that talks to GitHub. Everything else reads from MongoDB (with live fallback for gaps). This completely decouples the user experience from GitHub API latency and rate limits.
