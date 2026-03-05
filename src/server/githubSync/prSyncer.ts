/**
 * PrSyncer — syncs GitHub PRs via REST Search API + per-PR detail enrichment.
 *
 * Two modes:
 * 1. Hot sync: refresh all currently-open PRs for the org (Tier 1, every 2-5 min)
 * 2. Chunk backfill: process a deterministic 4-week date-range chunk (Tier 3)
 */

import type { GitHubPrCommentStats, GitHubPrDoc } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { buildChunkDocId, MS_PER_DAY, toDateStr } from "./chunks.js";
import { resolveGitHubConfig } from "./githubConfig.js";
import { getPrsCollection, getSyncChunk, upsertPrsBatch, upsertSyncChunk } from "./githubRepo.js";
import { getOctokit, getRateLimitBudget, updateBudgetFromResponse } from "./octokitClient.js";
import { writeSyncLog } from "./syncEventLog.js";

interface SearchResult {
  prs: GitHubPrDoc[];
  hitCap: boolean;
}

const log = createLogger("github:prSyncer");

// --- Types for REST search results ---

interface SearchIssueItem {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  labels?: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: {
    merged_at?: string | null;
    html_url?: string;
  };
  repository_url?: string;
  html_url?: string;
  draft?: boolean;
}

// --- Hot Sync: Open PRs ---

/**
 * Incrementally sync PRs for the org.
 *
 * - **Incremental** (has lastRunAt cursor): fetches only PRs updated
 *   since `lastRunAt` (`type:pr updated:>=<since>`, no state filter).
 *   Catches new PRs, state transitions (open→merged/closed), and updates.
 *   If the result exceeds the 1000-result cap, falls back to full sweep.
 *
 * - **Full sweep** (first-ever run, no cursor): fetches all currently-open
 *   PRs with adaptive bisection to work around the 1000-result cap.
 */
export async function syncOpenPrs(token: string, org: string, lastRunAt?: Date): Promise<number> {
  const startTime = Date.now();
  const budget = getRateLimitBudget();

  const incremental = !!lastRunAt;

  try {
    let prs: GitHubPrDoc[];

    if (incremental) {
      // Incremental: only PRs updated since last run (no state filter)
      const sinceStr = lastRunAt.toISOString().replace(/\.\d{3}Z$/, "Z");
      const query = `org:${org} type:pr updated:>=${sinceStr}`;
      const result = await searchPrs(token, query, budget, "hot_sync");

      if (result.hitCap) {
        // Large gap or very active org — fall back to full sweep this cycle
        log.warn("Incremental hot sync hit 1000-result cap, falling back to full sweep");
        prs = await fullOpenPrSweep(token, org, budget);
      } else {
        prs = result.prs;
      }
    } else {
      // Full sweep: first-ever run (no cursor)
      await writeSyncLog("info", "hot_sync", "Full open-PR sweep (first run)");
      prs = await fullOpenPrSweep(token, org, budget);
    }

    if (prs.length > 0) {
      await upsertPrsBatch(prs, { preserveDetailFields: true });
    }

    // Enrich PRs that haven't been enriched yet (detail_synced_at missing)
    const orgLower = org.toLowerCase();
    const unenriched = await getPrsCollection()
      .find({ org: orgLower, state: "open", detail_synced_at: { $exists: false } } as any)
      .sort({ updated_at: -1 })
      .limit(200)
      .toArray();
    let enrichedCount = 0;
    if (unenriched.length > 0) {
      enrichedCount = await enrichPrDetails(token, unenriched, budget);
    }

    const duration = Date.now() - startTime;
    const mode = incremental ? "incremental" : "full sweep";
    await writeSyncLog(
      "info",
      "hot_sync",
      `Hot sync (${mode}): ${prs.length} PRs, ${enrichedCount} enriched in ${duration}ms`,
      {
        items_fetched: prs.length,
        duration_ms: duration,
      },
    );

    return prs.length;
  } catch (err: unknown) {
    const msg = (err as Error).message;
    log.error("Failed to sync open PRs", { org, error: msg });
    await writeSyncLog("error", "hot_sync", `Failed to sync open PRs: ${msg}`, {
      error: msg,
    });
    throw err;
  }
}

/** Full sweep of all open PRs with adaptive bisection for 1000-result cap. */
async function fullOpenPrSweep(
  token: string,
  org: string,
  budget: ReturnType<typeof getRateLimitBudget>,
): Promise<GitHubPrDoc[]> {
  const query = `org:${org} type:pr is:open`;
  const result = await searchPrs(token, query, budget, "hot_sync");

  if (result.hitCap) {
    return searchOpenPrsSubdivided(token, org, budget, result.prs);
  }
  return result.prs;
}

// --- Chunk Backfill ---

/**
 * Process a single backfill chunk. Each chunk involves 3 searches:
 * 1. PRs created in [start, end)
 * 2. PRs merged in [start, end)
 * 3. PRs closed (unmerged) in [start, end)
 *
 * Then enriches each new/updated PR with detail (additions, deletions, reviews).
 */
export async function syncChunk(
  token: string,
  org: string,
  chunkStart: string,
  chunkEnd: string,
): Promise<number> {
  const chunkId = `${chunkStart}..${chunkEnd}`;
  const docId = buildChunkDocId("prs", org, chunkId);
  const budget = getRateLimitBudget();
  const startTime = Date.now();

  // Mark chunk as in_progress
  const existing = await getSyncChunk(docId);
  await upsertSyncChunk({
    _id: docId,
    org,
    data_type: "prs",
    chunk_start: new Date(chunkStart),
    chunk_end: new Date(chunkEnd),
    status: "in_progress",
    pages_fetched: existing?.pages_fetched || 0,
    total_items: existing?.total_items || 0,
    started_at: existing?.started_at || new Date(),
    attempt: (existing?.attempt || 0) + 1,
  });

  await writeSyncLog("info", "backfill", `Starting chunk ${chunkId}`, {
    chunk_id: chunkId,
  });

  try {
    // GitHub search date range is inclusive on both ends, so use day before chunkEnd
    const endDateExclusive = new Date(chunkEnd);
    endDateExclusive.setDate(endDateExclusive.getDate() - 1);
    const endStr = toDateStr(endDateExclusive);

    const allPrs = new Map<string, GitHubPrDoc>();

    // Step 1: PRs created in this range
    const createdQuery = `org:${org} type:pr created:${chunkStart}..${endStr}`;
    const created = await searchPrs(token, createdQuery, budget, "backfill");
    for (const pr of created.prs) {
      allPrs.set(pr._id, pr);
    }

    // Step 2: PRs merged in this range
    const mergedQuery = `org:${org} type:pr is:merged merged:${chunkStart}..${endStr}`;
    const merged = await searchPrs(token, mergedQuery, budget, "backfill");
    for (const pr of merged.prs) {
      allPrs.set(pr._id, pr);
    }

    // Step 3: PRs closed (unmerged) in this range
    const closedQuery = `org:${org} type:pr is:unmerged is:closed closed:${chunkStart}..${endStr}`;
    const closed = await searchPrs(token, closedQuery, budget, "backfill");
    for (const pr of closed.prs) {
      allPrs.set(pr._id, pr);
    }

    // Tag PRs with chunk_id
    const prsArray = Array.from(allPrs.values()).map((pr) => ({
      ...pr,
      chunk_id: chunkId,
    }));

    // Batch upsert (preserve any existing enriched detail fields)
    if (prsArray.length > 0) {
      await upsertPrsBatch(prsArray, { preserveDetailFields: true });
    }

    // Enrich with detail (additions, deletions, reviews) — limited by budget
    const enriched = await enrichPrDetails(token, prsArray, budget);

    const duration = Date.now() - startTime;

    // Mark chunk complete
    await upsertSyncChunk({
      _id: docId,
      org,
      data_type: "prs",
      chunk_start: new Date(chunkStart),
      chunk_end: new Date(chunkEnd),
      status: "complete",
      pages_fetched: 0,
      total_items: prsArray.length,
      started_at: existing?.started_at || new Date(),
      completed_at: new Date(),
      attempt: (existing?.attempt || 0) + 1,
    });

    await writeSyncLog(
      "info",
      "backfill",
      `Chunk ${chunkId} complete: ${prsArray.length} PRs, ${enriched} enriched`,
      {
        chunk_id: chunkId,
        items_fetched: prsArray.length,
        duration_ms: duration,
      },
    );

    return prsArray.length;
  } catch (err: unknown) {
    const msg = (err as Error).message;
    log.error("Chunk sync failed", { chunkId, org, error: msg });

    await upsertSyncChunk({
      _id: docId,
      org,
      data_type: "prs",
      chunk_start: new Date(chunkStart),
      chunk_end: new Date(chunkEnd),
      status: "failed",
      pages_fetched: existing?.pages_fetched || 0,
      total_items: existing?.total_items || 0,
      started_at: existing?.started_at || new Date(),
      error: msg,
      attempt: (existing?.attempt || 0) + 1,
    });

    await writeSyncLog("error", "backfill", `Chunk ${chunkId} failed: ${msg}`, {
      chunk_id: chunkId,
      error: msg,
    });

    throw err;
  }
}

// --- Search API helper ---

/**
 * Execute a GitHub search query and return parsed PR docs.
 * Handles pagination (up to 1000 results per query).
 * Respects search rate limit via token bucket.
 */
async function searchPrs(
  token: string,
  query: string,
  budget: ReturnType<typeof getRateLimitBudget>,
  logCategory: "hot_sync" | "backfill" = "backfill",
): Promise<SearchResult> {
  const octokit = getOctokit(token);
  const allPrs: GitHubPrDoc[] = [];
  let page = 1;
  const perPage = 100;
  let hitCap = false;

  while (true) {
    // Acquire search rate limit token
    await budget.acquireSearch();

    const response = await octokit.rest.search.issuesAndPullRequests({
      q: query,
      sort: "created",
      order: "asc",
      per_page: perPage,
      page,
    });

    updateBudgetFromResponse(response as any, budget);

    const items = response.data.items as SearchIssueItem[];
    for (const item of items) {
      const pr = parseSearchItem(item);
      if (pr) {
        allPrs.push(pr);
      }
    }

    log.debug("Search page fetched", {
      query: query.slice(0, 100),
      page,
      items: items.length,
      total_count: response.data.total_count,
      cumulative: allPrs.length,
    });
    await writeSyncLog(
      "debug",
      logCategory,
      `GET search/issues p${page}: ${items.length} items (${allPrs.length}/${response.data.total_count} total) q=${query.slice(0, 80)}`,
      {
        api_endpoint: "GET /search/issues",
        items_fetched: items.length,
      },
    );

    // Early cap detection: if page 1 already shows total > 1000, bail
    // immediately instead of wasting 9 more API calls
    if (response.data.total_count > 1000) {
      hitCap = true;
      log.warn("Search will exceed 1000-result cap", {
        query,
        total: response.data.total_count,
        fetched: allPrs.length,
      });
      await writeSyncLog(
        "warn",
        logCategory,
        `Search exceeds 1000-result cap (${allPrs.length} fetched, ${response.data.total_count} total) for: ${query.slice(0, 80)}`,
        { items_fetched: allPrs.length },
      );
      break;
    }

    // Check if there are more pages
    if (items.length < perPage || allPrs.length >= response.data.total_count) {
      break;
    }

    page++;
  }

  log.info("Search complete", {
    query: query.slice(0, 100),
    pages: page,
    prs: allPrs.length,
    hitCap,
  });

  return { prs: allPrs, hitCap };
}

/**
 * Subdivide open-PR search by `updated` date windows to work around
 * the 1000-result Search API cap.
 */
async function searchOpenPrsSubdivided(
  token: string,
  org: string,
  budget: ReturnType<typeof getRateLimitBudget>,
  initialPrs: GitHubPrDoc[] = [],
): Promise<GitHubPrDoc[]> {
  const dedupMap = new Map<string, GitHubPrDoc>();

  // Seed with any PRs already fetched from the initial broad query
  for (const pr of initialPrs) {
    dedupMap.set(pr._id, pr);
  }

  // Adaptive subdivision: search a window, and if it hits the 1000-result
  // cap, bisect it into two halves and recurse.  Never silently drops PRs
  // — keeps bisecting until the window resolves or reaches a single day.
  const MAX_DEPTH = 10; // safety valve: 2^10 = 1024 max leaf windows
  let windowCount = 0;

  async function searchWindow(
    startDate: Date | null,
    endDate: Date | null,
    depth: number,
  ): Promise<void> {
    const startStr = startDate ? toDateStr(startDate) : null;
    const endStr = endDate ? toDateStr(endDate) : null;

    // Build query with appropriate date qualifier
    let dateQualifier: string;
    if (startStr && endStr) {
      dateQualifier = `updated:${startStr}..${endStr}`;
    } else if (startStr) {
      dateQualifier = `updated:>=${startStr}`;
    } else if (endStr) {
      dateQualifier = `updated:<=${endStr}`;
    } else {
      dateQualifier = "";
    }

    const query = `org:${org} type:pr is:open${dateQualifier ? ` ${dateQualifier}` : ""}`;
    const result = await searchPrs(token, query, budget, "hot_sync");
    const newPrs = result.prs.filter((pr) => !dedupMap.has(pr._id)).length;
    for (const pr of result.prs) {
      dedupMap.set(pr._id, pr);
    }
    windowCount++;

    const windowLabel = dateQualifier || "(all)";
    await writeSyncLog(
      "info",
      "hot_sync",
      `Window ${windowLabel}: ${result.prs.length} PRs (${newPrs} new, ${dedupMap.size} cumulative)`,
      { items_fetched: result.prs.length },
    );

    if (!result.hitCap) return; // window fully captured

    // Hit the cap — check if we can bisect further
    const spanMs =
      startDate && endDate ? endDate.getTime() - startDate.getTime() : Number.MAX_SAFE_INTEGER;
    const spanDays = spanMs / MS_PER_DAY;

    if (spanDays <= 1 || depth >= MAX_DEPTH) {
      log.error("Window hit cap and cannot subdivide further — some PRs will be missing", {
        window: windowLabel,
        fetched: result.prs.length,
        spanDays: Math.round(spanDays),
        depth,
      });
      await writeSyncLog(
        "error",
        "hot_sync",
        `CANNOT SUBDIVIDE: ${windowLabel} has >1000 PRs in ${Math.round(spanDays)}d window (depth ${depth}). ${result.prs.length} fetched, remainder lost.`,
      );
      return;
    }

    // Bisect: split into two halves
    const midMs =
      startDate && endDate
        ? startDate.getTime() + spanMs / 2
        : endDate
          ? endDate.getTime() - 365 * MS_PER_DAY
          : startDate
            ? startDate.getTime() + 365 * MS_PER_DAY
            : Date.now();
    const midDate = new Date(midMs);

    log.info("Bisecting window", { window: windowLabel, midpoint: toDateStr(midDate) });
    await writeSyncLog(
      "info",
      "hot_sync",
      `Bisecting ${windowLabel} at ${toDateStr(midDate)} (depth ${depth + 1})`,
    );

    // Search older half first, then newer half
    await searchWindow(startDate, midDate, depth + 1);
    await searchWindow(midDate, endDate, depth + 1);
  }

  // Kick off with initial broad windows to minimize API calls when
  // most windows are under the cap.  Boundaries: 30d, 90d, 365d, 730d, open-ended.
  const now = new Date();
  const boundaries = [30, 90, 365, 730].map((d) => new Date(now.getTime() - d * MS_PER_DAY));

  // Window 0: now..30d ago (most recent, use >= for freshness)
  await searchWindow(boundaries[0], null, 0);

  // Windows 1..N: between consecutive boundaries
  for (let i = 1; i < boundaries.length; i++) {
    await searchWindow(boundaries[i], boundaries[i - 1], 0);
  }

  // Final window: older than the last boundary (open-ended start)
  await searchWindow(null, boundaries[boundaries.length - 1], 0);

  log.info("Open PR subdivision complete", {
    windows: windowCount,
    totalPrs: dedupMap.size,
  });

  await writeSyncLog(
    "info",
    "hot_sync",
    `Open PR subdivision complete: ${windowCount} windows, ${dedupMap.size} unique PRs (seeded with ${initialPrs.length})`,
    { items_fetched: dedupMap.size },
  );

  return Array.from(dedupMap.values());
}

/** Parse a search result item into a GitHubPrDoc. */
function parseSearchItem(item: SearchIssueItem): GitHubPrDoc | null {
  const repoUrl = item.repository_url || "";
  const repo = repoUrl.replace("https://api.github.com/repos/", "");
  if (!repo) return null;

  const org = repo.split("/")[0] || "";
  const merged = !!item.pull_request?.merged_at;
  const state: GitHubPrDoc["state"] = merged
    ? "merged"
    : item.state === "closed"
      ? "closed"
      : "open";

  return {
    _id: `${repo}#${item.number}`,
    org: org.toLowerCase(),
    repo,
    number: item.number,
    title: item.title,
    author: item.user?.login?.toLowerCase() || "unknown",
    state,
    is_draft: item.draft || false,
    head_ref: "",
    base_ref: "",
    additions: 0,
    deletions: 0,
    changed_files: 0,
    labels: (item.labels || []).map((l) => l.name),
    created_at: new Date(item.created_at),
    updated_at: new Date(item.updated_at),
    merged_at: item.pull_request?.merged_at ? new Date(item.pull_request.merged_at) : undefined,
    closed_at: item.closed_at ? new Date(item.closed_at) : undefined,
    requested_reviewers: [],
    reviews: [],
    synced_at: new Date(),
  };
}

// --- Detail Enrichment ---

/**
 * Enrich PRs with detail fields not available from search:
 * additions, deletions, head_ref, base_ref, changed_files, reviews, review requests.
 *
 * Uses per-PR REST calls (3+ per PR: pulls.get + pulls.listReviews + pulls.listReviewComments).
 * Comment fetching may paginate, consuming additional budget.
 * Limited by budget — stops if budget is exhausted.
 */
async function enrichPrDetails(
  token: string,
  prs: GitHubPrDoc[],
  budget: ReturnType<typeof getRateLimitBudget>,
): Promise<number> {
  const octokit = getOctokit(token);
  let enriched = 0;

  // Resolve username for unaddressed_threads computation
  let currentUser = "";
  try {
    const cfg = await resolveGitHubConfig();
    currentUser = cfg.username?.toLowerCase() || "";
  } catch {
    // non-critical
  }

  for (const pr of prs) {
    // Skip PRs that have already been enriched
    if (pr.detail_synced_at) {
      continue;
    }

    // Check budget — need at least 3 requests per PR (detail + reviews + comments)
    if (!budget.canSpendRest(3)) {
      log.debug("Budget exhausted, stopping PR enrichment", {
        enriched,
        total: prs.length,
      });
      break;
    }

    try {
      const [owner, repo] = pr.repo.split("/");
      if (!owner || !repo) continue;

      // Fetch PR detail
      const detail = await octokit.pulls.get({
        owner,
        repo,
        pull_number: pr.number,
      });
      updateBudgetFromResponse(detail as any, budget);
      budget.consumeRest(1);

      pr.additions = detail.data.additions;
      pr.deletions = detail.data.deletions;
      pr.changed_files = detail.data.changed_files;
      pr.head_ref = detail.data.head?.ref || "";
      pr.base_ref = detail.data.base?.ref || "";
      pr.is_draft = detail.data.draft || false;
      pr.requested_reviewers = (detail.data.requested_reviewers || [])
        .map((r: any) => r.login?.toLowerCase())
        .filter(Boolean);

      // Store PR description (body) with 10KB cap
      const MAX_BODY_BYTES = 10_000;
      const rawBody = detail.data.body || "";
      pr.body = rawBody.length > MAX_BODY_BYTES ? rawBody.slice(0, MAX_BODY_BYTES) : rawBody;
      pr.body_truncated = rawBody.length > MAX_BODY_BYTES;

      pr.detail_synced_at = new Date();

      // Fetch reviews
      const reviewsResp = await octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });
      updateBudgetFromResponse(reviewsResp as any, budget);
      budget.consumeRest(1);

      pr.reviews = reviewsResp.data.map((r: any) => ({
        author: r.user?.login?.toLowerCase() || "unknown",
        state: r.state || "COMMENTED",
        submitted_at: new Date(r.submitted_at || r.created_at),
      }));

      // Derive review_decision from reviews
      const approvals = pr.reviews.filter((r) => r.state === "APPROVED");
      const changesRequested = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED");
      if (changesRequested.length > 0) {
        pr.review_decision = "CHANGES_REQUESTED";
      } else if (approvals.length > 0) {
        pr.review_decision = "APPROVED";
      }

      // Fetch review comments for thread stats (total, unresolved, unaddressed)
      pr.comment_stats = await fetchCommentStats(
        octokit,
        owner,
        repo,
        pr.number,
        currentUser,
        budget,
      );

      await upsertPrsBatch([pr]);
      enriched++;
    } catch (err: unknown) {
      log.debug("Failed to enrich PR", {
        pr: pr._id,
        error: (err as Error).message,
      });
    }
  }

  return enriched;
}

/**
 * Fetch review comments via REST and compute thread-level stats.
 *
 * Review comments have an `in_reply_to_id` field that links replies to a
 * root comment, forming threads.  We group by root, count totals, and
 * determine "unresolved" (threads with no associated APPROVED/DISMISSED
 * review on the same path) and "unaddressed" (unresolved threads where
 * the last commenter is NOT the current user — i.e. awaiting your reply).
 */
async function fetchCommentStats(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  currentUser: string,
  budget: ReturnType<typeof getRateLimitBudget>,
): Promise<GitHubPrCommentStats> {
  const empty: GitHubPrCommentStats = {
    total_threads: 0,
    total_comments: 0,
    unresolved_threads: 0,
    unaddressed_threads: 0,
  };

  try {
    // Paginate all review comments (capped at 10 pages = 1000 comments)
    const MAX_COMMENT_PAGES = 10;
    const allComments: any[] = [];
    let page = 1;
    while (page <= MAX_COMMENT_PAGES) {
      if (!budget.canSpendRest(1)) break;
      const resp = await octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page,
      });
      updateBudgetFromResponse(resp as any, budget);
      budget.consumeRest(1);

      allComments.push(...resp.data);
      if (resp.data.length < 100) break;
      page++;
    }

    if (allComments.length === 0) return empty;

    // Group into threads: root comment id → list of comments
    // A root comment has no in_reply_to_id; replies point to their root.
    const threads = new Map<number, any[]>();
    for (const c of allComments) {
      const rootId = c.in_reply_to_id || c.id;
      if (!threads.has(rootId)) threads.set(rootId, []);
      threads.get(rootId)!.push(c);
    }

    // Determine resolved status: GitHub REST doesn't expose isResolved
    // for review threads.  We approximate: a thread's root comment has a
    // `path` field.  If the root comment's `position` is null, the thread
    // is outdated (resolved by code change).  Otherwise we treat it as
    // unresolved.  This isn't perfect but is the best REST can do.
    let unresolvedThreads = 0;
    let unaddressedThreads = 0;

    for (const [, comments] of threads) {
      // Sort by created_at to find last commenter
      comments.sort(
        (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );

      // The root comment (first in thread, or the one without in_reply_to_id)
      const root = comments.find((c: any) => !c.in_reply_to_id) || comments[0];

      // If position is null AND original_position exists, thread is on outdated diff
      // We consider these "resolved" (no longer relevant to current code)
      const isOutdated = root.position === null && root.original_position !== null;

      if (!isOutdated) {
        unresolvedThreads++;
        // Unaddressed = last comment not from the current user
        const lastComment = comments[comments.length - 1];
        const lastAuthor = lastComment?.user?.login?.toLowerCase() || "";
        if (currentUser && lastAuthor !== currentUser) {
          unaddressedThreads++;
        }
      }
    }

    return {
      total_threads: threads.size,
      total_comments: allComments.length,
      unresolved_threads: unresolvedThreads,
      unaddressed_threads: unaddressedThreads,
    };
  } catch (err: unknown) {
    log.debug("Failed to fetch comment stats", {
      pr: `${owner}/${repo}#${pullNumber}`,
      error: (err as Error).message,
    });
    return empty;
  }
}
