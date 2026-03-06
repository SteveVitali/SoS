# GitHub Action Unification — Design Document

> **Status:** ✅ Implemented
> **Author:** Steve + Cascade
> **Date:** 2026-03-05
> **Revised:** 2026-03-05 — Inline recaps only, no gh CLI fallback, PR body caching
> **Depends on:** [GITHUB_HUB_DESIGN.md](./GITHUB_HUB_DESIGN.md) (Phase 4, items marked incomplete)

---

## 1. Problem Statement

The Son of Steve codebase has **three disconnected GitHub data stacks** that evolved independently:

| Stack | Used By | Data Source | Transport | Blocking? |
|-------|---------|-------------|-----------|-----------|
| **A: Instant Queries** | Slack/web chat actions (`github` tool) | GitHub Search API | `gh` CLI via `execSync` | **Yes** — blocks Node event loop |
| **B: Recap/Summary Jobs** | Worker (`github_summary` job type) | Same `gh` CLI functions + `claude` CLI | `execSync` for both GH data + LLM | **Yes** |
| **C: GitHub Hub** | Web UI (PRs, Contributions, Sync tabs) | Octokit → MongoDB (7 collections) | Async, non-blocking | No |

Stack C (the GitHub Hub) already maintains a rich, continuously-synced MongoDB mirror of the entire org's GitHub data — PRs, teams, members, contributions, review stats. **Stacks A and B ignore all of it**, instead making fresh `gh` CLI calls every time.

### Specific Pain Points

1. **`execSync` blocks the server** — Every instant query spawns child processes synchronously. Team queries do N sequential `gh` CLI calls (one per member). A team of 20 members means ~20 sequential `execSync` calls, each blocking the entire Node process for 1-3 seconds.

2. **Duplicate data fetching** — The sync engine already has all this data in MongoDB. Instant queries re-fetch it from GitHub on every request.

3. **Duplicate user/team resolution** — `teamCache.ts` (sync, `gh` CLI) and `ghPrs.ts` (async, `gh` CLI) both resolve the authenticated user and team members independently.

4. **`claude` CLI for recaps** — `runGithubSummaryJob.ts` writes prompts to temp files and shells out to `claude -p` instead of using the LLM provider infrastructure already available in the codebase.

5. **No data enrichment for chat** — Instant queries return bare search results (no additions/deletions, no review stats, no comment thread counts, no PR description body). The MongoDB cache has all of this from PR detail enrichment.

6. **PR descriptions not cached** — The `GitHubPrDoc` schema doesn't store the PR `body` (description text). This is a missed opportunity — PR descriptions are invaluable context for LLM-generated recap summaries. The Octokit `pulls.get()` endpoint already returns the body; we just need to store it.

7. **Rate limit blindness** — Stack A has no awareness of the rate limit budget. It can exhaust the API quota that the sync engine depends on.

8. **Inconsistent results** — The web UI (Stack C) and chat actions (Stack A) can return different data for the same query because they use different data sources.

---

## 2. Goal

**Unify all GitHub data access onto the MongoDB-backed sync engine (Stack C) and delete the old `gh` CLI code entirely.** After this work:

- Instant queries read from MongoDB — no `gh` CLI, no fallback
- Recaps execute inline in the server executor using MongoDB data + LLM provider — no background `github_summary` jobs, no `claude` CLI
- `queries.ts`, `teamCache.ts`, `ghPrs.ts`, and `runGithubSummaryJob.ts` are **deleted**
- PR descriptions (`body`) are cached in MongoDB and included in recap prompts
- All GitHub data flows through one path: **Sync Engine → MongoDB → Consumers**
- The `gh` CLI is no longer required at runtime

---

## 3. Architecture After Unification

```
┌──────────────────────────────────────────────────────────────┐
│                    GitHub REST API v3                          │
└─────────────────────────┬────────────────────────────────────┘
                          │ background sync (Octokit, async)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                GitHubSyncService (existing)                    │
│  OrgSyncer · PrSyncer · ContributionSyncer · BackfillScheduler│
│  NEW: stores body field during PR detail enrichment           │
└─────────────────────────┬────────────────────────────────────┘
                          │ upsert
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                MongoDB (7 collections)                         │
│  github_prs (+ body field)  github_org_members  github_teams  │
│  github_contributions  github_sync_chunks  github_sync_log    │
│  github_settings                                              │
└──────┬──────────────────────────┬────────────────────────────┘
       │                          │
  ┌────▼─────┐            ┌───────▼────────┐
  │ Web UI   │            │ Chat/Slack     │
  │ (React)  │            │ instant queries│
  │ existing │            │ + inline recaps│
  └──────────┘            └────────────────┘
                                ▲
                                │ ALL queries: MongoDB reads
                                │ Recaps: MongoDB + LLM provider
                                │ No gh CLI, no worker jobs
```

---

## 4. Detailed Design

### 4.1 Add `body` to `GitHubPrDoc` (PR Description Caching)

The PR description is critical context for recap summaries. Currently dropped during both search parsing and detail enrichment.

**Schema change** in `src/shared/githubTypes.ts`:

```typescript
export interface GitHubPrDoc {
  // ... existing fields ...
  body?: string;           // PR description text (from detail enrichment)
  body_truncated?: boolean; // true if body was truncated (>10KB)
  // ...
}
```

**Why `body_truncated`?** Some PRs have enormous auto-generated descriptions (dependency bot PRs, release notes). We cap storage at 10KB per body to prevent bloating the collection, and flag when truncation occurred so consumers know.

**Sync engine change** in `src/server/githubSync/prSyncer.ts`, within `enrichPrDetails()`:

```typescript
// After fetching PR detail via octokit.pulls.get():
const rawBody = detail.data.body || "";
const MAX_BODY_BYTES = 10_000;
pr.body = rawBody.length > MAX_BODY_BYTES ? rawBody.slice(0, MAX_BODY_BYTES) : rawBody;
pr.body_truncated = rawBody.length > MAX_BODY_BYTES;
```

**Also add `body` and `body_truncated` to `DETAIL_ONLY_FIELDS`** in `githubRepo.ts` so search-sourced upserts don't overwrite enriched body data with empty strings.

**Recap prompt improvement:** The recap prompt builders will include the PR body as context:

```
PR #4521: Fix cache invalidation bug (+34/-12)
  Description: Fixes a race condition in the TTL cache where expired entries
  could be served during high-concurrency reads...
```

This gives the LLM far richer signal for generating meaningful summaries versus just PR titles.

### 4.2 New Module: `src/server/github/mongoQueries.ts`

This is the **replacement for `queries.ts`**. It reads from MongoDB exclusively — no `gh` CLI, no fallback. If the sync engine hasn't populated data yet, the query returns empty results with a staleness indicator the caller can use to add a note.

```typescript
// src/server/github/mongoQueries.ts

import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import type { GithubQueryType } from "../../shared/types.js";
import { getOrgMembersCollection, getPrsCollection, getChunkStats,
         getSyncCursor } from "../githubSync/githubRepo.js";
import { resolveGitHubConfig } from "../githubSync/githubConfig.js";

export interface InstantQueryResult {
  queryType: GithubQueryType;
  prs: GitHubPrDoc[];
  syncStatus: SyncReadiness;
}

export interface SyncReadiness {
  hasPrData: boolean;
  hasTeamData: boolean;
  backfillPercent: number;
  lastHotSync?: Date;
}

export async function executeInstantQueryFromMongo(
  queryType: GithubQueryType,
  params: {
    githubUsername?: string;
    org?: string;
    team_slug?: string;
    time_range?: string;
  },
): Promise<InstantQueryResult> {
  const config = await resolveGitHubConfig();
  const org = (params.org || config.org).toLowerCase();
  const username = (params.githubUsername || config.username || "").toLowerCase();
  const teamSlug = params.team_slug || config.teamSlug;

  const prs = await runQuery(queryType, org, username, teamSlug, params.time_range);
  const syncStatus = await getSyncReadiness(org);

  return { queryType, prs, syncStatus };
}

// --- Individual query implementations ---

async function runQuery(
  queryType: GithubQueryType, org: string, username: string,
  teamSlug: string, timeRange?: string,
): Promise<GitHubPrDoc[]> {
  switch (queryType) {
    case "my_review_requests":
      return getPrsCollection()
        .find({ org, state: "open", requested_reviewers: username })
        .sort({ updated_at: -1 }).limit(100).toArray();
    case "my_open_prs":
      return getPrsCollection()
        .find({ org, state: "open", author: username })
        .sort({ updated_at: -1 }).limit(100).toArray();
    case "my_merged_prs": {
      const since = parseTimeRange(timeRange);
      return getPrsCollection()
        .find({ org, state: "merged", author: username, merged_at: { $gte: since } })
        .sort({ merged_at: -1 }).limit(100).toArray();
    }
    case "team_open_prs": {
      const members = await getTeamMemberLogins(org, teamSlug);
      if (members.length === 0) return [];
      return getPrsCollection()
        .find({ org, state: "open", author: { $in: members } })
        .sort({ updated_at: -1 }).limit(200).toArray();
    }
    case "team_review_requests": {
      const members = await getTeamMemberLogins(org, teamSlug);
      if (members.length === 0) return [];
      return getPrsCollection()
        .find({ org, state: "open", is_draft: { $ne: true },
                requested_reviewers: { $in: members } })
        .sort({ updated_at: -1 }).limit(200).toArray();
    }
    default:
      throw new Error(`Unknown instant query type: ${queryType}`);
  }
}

// --- Helpers ---

async function getTeamMemberLogins(org: string, teamSlug: string): Promise<string[]> {
  const members = await getOrgMembersCollection()
    .find({ org, teams: teamSlug })
    .project<{ _id: string }>({ _id: 1 })
    .toArray();
  return members.map((m) => m._id);
}

export function parseTimeRange(timeRange?: string): Date {
  if (!timeRange) return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const match = timeRange.match(/^(\d+)([dwm])$/);
  if (!match) return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const days = unit === "w" ? val * 7 : unit === "m" ? val * 30 : val;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function getSyncReadiness(org: string): Promise<SyncReadiness> {
  const [prCount, memberCount, chunkStats, cursor] = await Promise.all([
    getPrsCollection().countDocuments({ org }),
    getOrgMembersCollection().countDocuments({ org }),
    getChunkStats(org, "prs"),
    getSyncCursor(org),
  ]);
  return {
    hasPrData: prCount > 0,
    hasTeamData: memberCount > 0,
    backfillPercent: chunkStats.total > 0
      ? Math.round((chunkStats.completed / chunkStats.total) * 100) : 0,
    lastHotSync: cursor.last_hot_sync_at,
  };
}
```

**Key design decisions:**

- All queries are **async** — no event loop blocking.
- **No fallback to `gh` CLI** — MongoDB is the sole data source. The sync engine starts immediately on boot (org sync within 5s, hot sync immediately), so data populates quickly.
- Team queries use a single MongoDB `$in` query instead of N per-member GitHub API searches.
- `my_review_requests` uses the `requested_reviewers` array from PR detail enrichment.
- `parseTimeRange()` is self-contained (no dependency on old `queries.ts`).
- `getSyncReadiness()` returned alongside results so callers can append "sync in progress" notes.

### 4.3 New Formatting: `src/server/github/mongoFormatting.ts`

Formats `GitHubPrDoc` objects with **richer data** — size stats, review status, comment thread counts. Replaces the old `formatting.ts` which consumed `PrResult` objects from the `gh` CLI.

```typescript
// src/server/github/mongoFormatting.ts

import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import type { InstantQueryResult } from "./mongoQueries.js";

const QUERY_TITLES: Record<string, string> = {
  my_review_requests: "📋 PRs Awaiting Your Review",
  my_open_prs: "📂 Your Open PRs",
  my_merged_prs: "✅ Your Recently Merged PRs",
  team_open_prs: "👥 Team Open PRs",
  team_review_requests: "👥 Team Outstanding Reviews",
};
const TEAM_QUERIES = new Set(["team_open_prs", "team_review_requests"]);

export function formatInstantQueryFromMongo(result: InstantQueryResult): string {
  const title = QUERY_TITLES[result.queryType] || result.queryType;
  const prs = result.prs;

  if (prs.length === 0) {
    const syncNote = !result.syncStatus.hasPrData
      ? "\n_ℹ️ GitHub sync hasn't completed yet — data will appear shortly._"
      : "";
    return `*${title}*\n\n_None found._${syncNote}`;
  }

  const showAuthor = result.queryType === "my_review_requests"
    || TEAM_QUERIES.has(result.queryType);

  let body: string;
  if (TEAM_QUERIES.has(result.queryType)) {
    body = formatGroupedByAuthor(prs);
  } else {
    body = prs.map((pr) => formatPrLine(pr, { showAuthor })).join("\n");
  }

  const count = prs.length;
  const subtitle = `_${count} PR${count === 1 ? "" : "s"}_`;
  const syncNote = result.syncStatus.backfillPercent < 100
    ? `\n_ℹ️ Backfill ${result.syncStatus.backfillPercent}% — some older data may be missing._`
    : "";

  return `*${title}* — ${subtitle}\n\n${body}${syncNote}`;
}

function formatPrLine(pr: GitHubPrDoc, opts: { showAuthor?: boolean } = {}): string {
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const draft = pr.is_draft ? " _(draft)_" : "";
  const review = pr.review_decision ? ` ${reviewEmoji(pr.review_decision)}` : "";
  const author = opts.showAuthor && pr.author ? ` by _${pr.author}_` : "";
  const size = (pr.additions > 0 || pr.deletions > 0)
    ? ` (+${pr.additions}/-${pr.deletions})` : "";
  const comments = pr.comment_stats?.unresolved_threads
    ? ` 💬${pr.comment_stats.unresolved_threads}` : "";
  return `• <${url}|${pr.repo}#${pr.number}> — ${pr.title}${draft}${review}${size}${comments}${author}`;
}

function formatGroupedByAuthor(prs: GitHubPrDoc[]): string {
  const groups = new Map<string, GitHubPrDoc[]>();
  for (const pr of prs) {
    if (!groups.has(pr.author)) groups.set(pr.author, []);
    groups.get(pr.author)!.push(pr);
  }
  const sections: string[] = [];
  for (const [author, authorPrs] of groups) {
    sections.push(`*${author}* (${authorPrs.length}):`);
    for (const pr of authorPrs) sections.push(formatPrLine(pr, { showAuthor: false }));
  }
  return sections.join("\n");
}

function reviewEmoji(decision: string): string {
  switch (decision) {
    case "APPROVED": return "✅";
    case "CHANGES_REQUESTED": return "🔴";
    default: return "";
  }
}
```

**Improvement over current:** Every PR line now includes `+/-` size stats and unresolved comment thread counts. Sync status notes are appended automatically when data is incomplete.

### 4.4 New Module: `src/server/github/recapService.ts` (Inline Recaps)

Recaps become a **synchronous server-side operation** — no background `github_summary` jobs, no worker roundtrip. The executor fetches data from MongoDB (~50-200ms), calls the LLM provider (~3-10s), and returns the formatted result directly.

```typescript
// src/server/github/recapService.ts

import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import { getOrgMembersCollection, getPrsCollection } from "../githubSync/githubRepo.js";
import { resolveGitHubConfig } from "../githubSync/githubConfig.js";
import type { LLMProvider } from "../llm/llmProvider.js";
import { getModelForRole } from "../llm/modelResolver.js";
import { parseTimeRange } from "./mongoQueries.js";

export interface RecapData {
  mergedPrs: GitHubPrDoc[];
  reviewedPrs: GitHubPrDoc[];
  totalAdditions: number;
  totalDeletions: number;
  reposTouched: string[];
}

export interface TeamRecapData {
  members: Array<{ username: string; recap: RecapData }>;
  totalPrsMerged: number;
  totalAdditions: number;
  totalDeletions: number;
  reposActive: string[];
}

// --- Data Fetchers (MongoDB only) ---

export async function fetchMyRecapData(
  org: string, username: string, since: Date,
): Promise<RecapData> {
  const prsCol = getPrsCollection();
  const userLower = username.toLowerCase();

  const mergedPrs = await prsCol
    .find({ org, author: userLower, state: "merged", merged_at: { $gte: since } })
    .sort({ merged_at: -1 }).toArray();

  const reviewedPrs = await prsCol
    .find({
      org, state: "merged", merged_at: { $gte: since },
      "reviews.author": userLower,
      author: { $ne: userLower },
    }).toArray();

  return {
    mergedPrs, reviewedPrs,
    totalAdditions: mergedPrs.reduce((s, pr) => s + (pr.additions || 0), 0),
    totalDeletions: mergedPrs.reduce((s, pr) => s + (pr.deletions || 0), 0),
    reposTouched: [...new Set(mergedPrs.map((pr) => pr.repo))],
  };
}

export async function fetchTeamRecapData(
  org: string, teamSlug: string, since: Date,
): Promise<TeamRecapData> {
  const members = await getOrgMembersCollection()
    .find({ org, teams: teamSlug })
    .project<{ _id: string }>({ _id: 1 }).toArray();

  const memberRecaps: TeamRecapData["members"] = [];
  for (const m of members.map((m) => m._id)) {
    const recap = await fetchMyRecapData(org, m, since);
    if (recap.mergedPrs.length > 0 || recap.reviewedPrs.length > 0) {
      memberRecaps.push({ username: m, recap });
    }
  }
  memberRecaps.sort((a, b) => b.recap.mergedPrs.length - a.recap.mergedPrs.length);

  return {
    members: memberRecaps,
    totalPrsMerged: memberRecaps.reduce((s, m) => s + m.recap.mergedPrs.length, 0),
    totalAdditions: memberRecaps.reduce((s, m) => s + m.recap.totalAdditions, 0),
    totalDeletions: memberRecaps.reduce((s, m) => s + m.recap.totalDeletions, 0),
    reposActive: [...new Set(memberRecaps.flatMap((m) => m.recap.reposTouched))],
  };
}

// --- Prompt Builders (now with PR body context) ---

function prToPromptLine(pr: GitHubPrDoc, bodyMaxChars: number): string {
  const desc = pr.body ? `\n  Description: ${pr.body.slice(0, bodyMaxChars)}` : "";
  return `- ${pr.repo}#${pr.number}: ${pr.title} (+${pr.additions || 0}/-${pr.deletions || 0})${desc}`;
}

export function buildMyRecapPrompt(data: RecapData, timeRange?: string): string {
  const range = timeRange || "7d";
  const prLines = data.mergedPrs.map((pr) => prToPromptLine(pr, 500)).join("\n");
  const reviewLines = data.reviewedPrs
    .map((pr) => `- ${pr.repo}#${pr.number}: ${pr.title} (by ${pr.author})`)
    .join("\n");

  return `Generate a concise recap of this developer's work over the past ${range}.

## PRs Merged (${data.mergedPrs.length})
${prLines || "(none)"}

## PRs Reviewed (${data.reviewedPrs.length})
${reviewLines || "(none)"}

## Stats
- Repos: ${data.reposTouched.join(", ") || "(none)"}
- Lines: +${data.totalAdditions} / -${data.totalDeletions}

Write a brief, narrative summary suitable for Slack. Use bullet points for key items. Be concise.`;
}

export function buildTeamRecapPrompt(data: TeamRecapData, timeRange?: string): string {
  const range = timeRange || "7d";
  const memberSections = data.members.map((m) => {
    const prLines = m.recap.mergedPrs.map((pr) => prToPromptLine(pr, 300)).join("\n");
    return `### ${m.username} (${m.recap.mergedPrs.length} merged, ${m.recap.reviewedPrs.length} reviewed)\n${prLines}`;
  }).join("\n\n");

  return `Generate a concise team recap for the past ${range}.

## Team Activity (${data.totalPrsMerged} PRs merged, ${data.reposActive.length} repos)
Lines: +${data.totalAdditions} / -${data.totalDeletions}

${memberSections}

Write a team summary suitable for Slack. Highlight key themes, notable contributions, and cross-team patterns. Be concise.`;
}

// --- Inline Execution ---

export async function executeRecapInline(
  queryType: "my_recap" | "team_recap",
  params: { org?: string; team_slug?: string; github_username?: string; time_range?: string },
  llmProvider: LLMProvider,
): Promise<string> {
  const config = await resolveGitHubConfig();
  const org = (params.org || config.org).toLowerCase();
  const since = parseTimeRange(params.time_range);

  let prompt: string;
  if (queryType === "my_recap") {
    const username = params.github_username || config.username || "";
    const data = await fetchMyRecapData(org, username, since);
    if (data.mergedPrs.length === 0 && data.reviewedPrs.length === 0) {
      return `📊 *My Recap (${params.time_range || "7d"})*\n\n_No activity found for this period._`;
    }
    prompt = buildMyRecapPrompt(data, params.time_range);
  } else {
    const teamSlug = params.team_slug || config.teamSlug;
    const data = await fetchTeamRecapData(org, teamSlug, since);
    if (data.members.length === 0) {
      return `📊 *Team Recap (${params.time_range || "7d"})*\n\n_No team activity found for this period._`;
    }
    prompt = buildTeamRecapPrompt(data, params.time_range);
  }

  const model = getModelForRole("routing");
  const result = await llmProvider.chat({
    system: "You generate concise developer activity recap summaries for Slack. Use markdown formatting suitable for Slack (bold, bullets, etc).",
    messages: [{ role: "user", content: prompt }],
    tools: [],
    maxTokens: 2048,
    model,
  });

  const label = queryType === "my_recap" ? "My" : "Team";
  return `📊 *${label} Recap (${params.time_range || "7d"})*\n\n${result.text}`;
}
```

**Key design decisions:**

- **Inline only** — no job queue path. MongoDB reads are ~50-200ms, LLM generation is ~3-10s. Fast enough for direct execution.
- **PR body in prompts** — `buildMyRecapPrompt()` and `buildTeamRecapPrompt()` include truncated PR descriptions (500 chars for personal recap, 300 chars for team recap to manage context window with many members).
- **Early return for empty data** — Returns a friendly message instead of calling the LLM with an empty prompt.
- **Self-contained** — No dependency on old `queries.ts` or `formatting.ts`.

### 4.5 Migrate `executeGithubQuery()` in `executors.ts`

The executor at `executors.ts:459-556` gets a clean rewrite. Both instant queries and recaps go through MongoDB. The `github_summary` job creation path is removed entirely.

**Before (current):**
```
Instant → executeInstantQuery() via gh CLI (sync, blocking)
Summary → createGithubSummaryJob() → worker → gh CLI + claude CLI
```

**After:**
```
Instant → executeInstantQueryFromMongo() via MongoDB (async)
Summary → executeRecapInline() via MongoDB + LLM provider (async, inline)
```

Changes to `executors.ts`:

1. Replace `import { executeInstantQuery, formatInstantQueryResult, GithubRateLimitError }` with imports from `mongoQueries.ts`, `mongoFormatting.ts`, and `recapService.ts`
2. Remove `GithubRateLimitError` catch block (MongoDB doesn't rate-limit)
3. Replace the summary job creation block with a call to `executeRecapInline()`
4. Remove `import { createGithubSummaryJob }` from `jobService.ts`

The function is already async, so `await` just works. The `GithubQueryExecution` type in `routingTypes.ts` loses `reply_summary_queued` (no longer queued) — inline execution returns the formatted recap directly as the reply.

### 4.6 Remove `github_summary` Job Type

With inline recaps, the entire `github_summary` job infrastructure becomes dead code:

| Item | Action |
|------|--------|
| `src/worker/executor/runGithubSummaryJob.ts` | **Delete** |
| Worker job type dispatch (case `"github_summary"`) | **Remove case** |
| `createGithubSummaryJob()` in `jobService.ts` | **Delete function** |
| `CreateGithubSummary` in `jobModel.ts` | **Delete interface** |
| `JobDoc.github_query` field in `types.ts` | **Remove from type** (existing MongoDB docs unaffected) |
| `GithubQueryType` / `GITHUB_SUMMARY_QUERIES` in `types.ts` | **Keep** — still used by routing config to identify recap query types; they're just handled inline now |
| `routing-config.yaml` `summary_types` | **Keep** — executor still checks this list to decide instant vs. recap path |
| `GithubQueryExecution.reply_summary_queued` in `routingTypes.ts` | **Remove** — no longer queued |

### 4.7 Sync Readiness UX

When the sync engine hasn't populated data yet (fresh install, first boot), instant queries and recaps return empty results. Rather than a silent failure, we provide clear messaging:

| Scenario | User sees |
|----------|-----------|
| No data at all (sync hasn't run) | `_ℹ️ GitHub sync hasn't completed yet — data will appear shortly._` |
| Partial backfill (<100%) | `_ℹ️ Backfill 85% — some older data may be missing._` |
| Full backfill, data present | No note (clean result) |
| Team members not synced yet | Empty team query result (org sync runs within 5s of boot) |

The `SyncReadiness` object is returned with every instant query result, and the formatter in `mongoFormatting.ts` handles the messaging automatically.

For recaps, `executeRecapInline()` returns a friendly "no activity found" message when MongoDB has no matching data — no LLM call wasted.

---

## 5. Files to Create / Modify / Delete

### New Files

| File | Purpose |
|------|---------|
| `src/server/github/mongoQueries.ts` | MongoDB-backed instant query implementations + `parseTimeRange()` + `getSyncReadiness()` |
| `src/server/github/mongoFormatting.ts` | Rich formatting using `GitHubPrDoc` fields (size, comments, review status) |
| `src/server/github/recapService.ts` | Inline recap execution: data fetching, prompt building (with PR body), LLM call |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/githubTypes.ts` | Add `body?: string` and `body_truncated?: boolean` to `GitHubPrDoc` |
| `src/server/githubSync/prSyncer.ts` | Store `body` and `body_truncated` during `enrichPrDetails()` |
| `src/server/githubSync/githubRepo.ts` | Add `body`, `body_truncated` to `DETAIL_ONLY_FIELDS` set |
| `src/server/routing/executors.ts` | Swap instant query + recap execution to new modules; remove `GithubRateLimitError` handling; remove `createGithubSummaryJob` import |
| `src/server/routing/routingTypes.ts` | Remove `reply_summary_queued` from `GithubQueryExecution` |
| `src/server/github/index.ts` | Replace old exports with new module re-exports |
| `src/shared/types.ts` | Remove `github_query` field from `JobDoc`; keep `GithubQueryType` and `GITHUB_SUMMARY_QUERIES` |
| `src/server/jobs/jobService.ts` | Delete `createGithubSummaryJob()` function and `CreateGithubSummary` import |
| Worker job dispatch | Remove `github_summary` case from job type switch |

### Files to Delete

| File | Reason |
|------|--------|
| `src/server/github/queries.ts` | All `gh` CLI code eliminated; replaced by `mongoQueries.ts` |
| `src/server/github/teamCache.ts` | Team members come from `github_org_members` collection |
| `src/server/github/formatting.ts` | Replaced by `mongoFormatting.ts` (richer formatting) |
| `src/server/api/ghPrs.ts` | PR comment stats come from `github_prs.comment_stats`; `getCurrentGitHubUser()` comes from github config |
| `src/worker/executor/runGithubSummaryJob.ts` | Recaps are inline now; no worker job needed |

---

## 6. Implementation Plan

### Phase 1: PR Body Caching

1. Add `body` and `body_truncated` fields to `GitHubPrDoc` in `githubTypes.ts`
2. Add both fields to `DETAIL_ONLY_FIELDS` in `githubRepo.ts`
3. Update `enrichPrDetails()` in `prSyncer.ts` to store `detail.data.body` with 10KB truncation
4. Verify: trigger a hot sync, confirm `body` field appears on enriched PR docs in MongoDB

### Phase 2: New Modules (non-breaking, additive)

1. Create `mongoQueries.ts` — all instant query implementations + `parseTimeRange` + `getSyncReadiness`
2. Create `mongoFormatting.ts` — formatting with rich PR data
3. Create `recapService.ts` — data fetching, prompt building (with body), LLM call, `executeRecapInline()`
4. Write tests for all three modules

### Phase 3: Swap Executors (the cutover)

1. Update `executors.ts` — swap imports, rewrite `executeGithubQuery()`:
   - Instant queries: `executeInstantQueryFromMongo()` + `formatInstantQueryFromMongo()`
   - Recaps: `executeRecapInline()` (requires passing the LLM provider to the executor)
2. Remove `GithubRateLimitError` handling
3. Remove `createGithubSummaryJob` call and import
4. Update `routingTypes.ts` — remove `reply_summary_queued`
5. Test all 7 query types via Slack and web

### Phase 4: Delete Old Code

1. Delete `queries.ts`, `teamCache.ts`, `formatting.ts`, `ghPrs.ts`
2. Delete `runGithubSummaryJob.ts`
3. Remove `createGithubSummaryJob()` from `jobService.ts`
4. Remove `github_query` from `JobDoc` type
5. Remove `github_summary` case from worker dispatch
6. Update `index.ts` barrel exports — re-export new modules only
7. Remove all `gh` CLI imports (`execSync`, `child_process`) from server code
8. Update `GITHUB_HUB_DESIGN.md` Phase 4 checklist items

---

## 7. Testing Strategy

### Unit Tests

- **`mongoQueries.test.ts`** — Test each query function with seeded MongoDB data. Verify correct filtering, sorting, team member resolution, `parseTimeRange()`.
- **`mongoFormatting.test.ts`** — Test formatting output for each query type: empty results, draft PRs, PRs with/without enrichment data, sync status notes.
- **`recapService.test.ts`** — Test data fetching, prompt building (verify PR body appears in prompts), empty-data early returns. Mock the LLM provider for inline execution tests.

### Integration Tests

- **Executor integration** — Verify `executeGithubQuery()` produces correct results for all 7 query types with seeded MongoDB data.
- **PR body enrichment** — Verify `enrichPrDetails()` stores `body` and handles truncation correctly.

### Regression Tests

- **Slack response format** — Ensure the Slack message format is equivalent or improved for all instant query types. The new format is richer (includes size stats, comment counts) so it should be strictly better.

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MongoDB has no data on first boot | Instant queries / recaps return empty | Sync engine starts immediately on boot; clear "sync in progress" messaging via `SyncReadiness` |
| PR details not yet enriched | Missing size stats, reviews, body in results | Graceful degradation — formatter omits size/comments when zero; recap prompts work without body (just less context) |
| Team members not synced yet | Team queries return empty | Org sync runs within 5s of boot; rare edge case that self-resolves quickly |
| LLM provider unavailable for inline recap | Recap fails | Return error message `"⚠️ Recap generation failed: <error>"` — no silent failure |
| `requested_reviewers` not populated for old backfilled PRs | `my_review_requests` under-reports | Only affects PRs never detail-enriched; enrichment runs continuously on open PRs |
| PR body bloats MongoDB | Storage concern | 10KB cap with `body_truncated` flag; auto-generated bot PR descriptions are the worst case |
| Inline recap takes >15s for very large teams | Slow Slack response | Acceptable given the alternative (30s+ worker queue latency); LLM provider has built-in timeout |

---

## 9. Estimated Effort

| Phase | Scope | Estimate |
|-------|-------|----------|
| Phase 1: PR body caching | 3 small edits (type + syncer + repo) | < 1 session |
| Phase 2: New modules + tests | 3 new files (~150-200 lines each) + tests | 1-2 sessions |
| Phase 3: Swap executors | Rewrite `executeGithubQuery()`, test all 7 query types | 1 session |
| Phase 4: Delete old code | Delete 5 files, update exports/types, cleanup | 1 session |
| **Total** | | **3-5 sessions** |

---

## 10. Success Criteria

- [ ] All 5 instant query types read from MongoDB (no `gh` CLI)
- [ ] All instant queries are fully async (no `execSync` anywhere in the path)
- [ ] Recaps (`my_recap`, `team_recap`) execute inline via MongoDB + LLM provider
- [ ] PR descriptions (`body`) stored in `github_prs` and included in recap prompts
- [ ] No `gh` CLI calls remain in the server or worker runtime path
- [ ] `queries.ts`, `teamCache.ts`, `formatting.ts`, `ghPrs.ts`, `runGithubSummaryJob.ts` are deleted
- [ ] `github_summary` job type is removed
- [ ] Existing test suite passes
- [ ] Slack response format for all query types is equivalent or improved (richer data)
- [ ] Instant queries include enriched data (size stats, comment counts) when available
- [ ] Clear sync-status messaging when data is incomplete
