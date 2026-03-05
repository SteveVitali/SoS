/**
 * PrSyncer — syncs GitHub PRs via REST Search API + per-PR detail enrichment.
 *
 * Two modes:
 * 1. Hot sync: refresh all currently-open PRs for the org (Tier 1, every 2-5 min)
 * 2. Chunk backfill: process a deterministic 4-week date-range chunk (Tier 3)
 */

import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { buildChunkDocId, MS_PER_DAY, toDateStr } from "./chunks.js";
import { getSyncChunk, upsertPrsBatch, upsertSyncChunk } from "./githubRepo.js";
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
 * Refresh all currently-open PRs for the org.
 * Uses the Search API: `org:{org} type:pr is:open`
 */
export async function syncOpenPrs(token: string, org: string): Promise<number> {
  const startTime = Date.now();
  const budget = getRateLimitBudget();

  try {
    const query = `org:${org} type:pr is:open`;
    const result = await searchPrs(token, query, budget, "hot_sync");

    let prs: GitHubPrDoc[];
    if (result.hitCap) {
      // Subdivide by updated-date windows to get complete results;
      // seed with the PRs we already fetched so they aren't wasted.
      prs = await searchOpenPrsSubdivided(token, org, budget, result.prs);
    } else {
      prs = result.prs;
    }

    if (prs.length > 0) {
      await upsertPrsBatch(prs);
    }

    const duration = Date.now() - startTime;
    await writeSyncLog("info", "hot_sync", `Refreshed ${prs.length} open PRs`, {
      items_fetched: prs.length,
      duration_ms: duration,
    });

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

    // Batch upsert
    if (prsArray.length > 0) {
      await upsertPrsBatch(prsArray);
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

    // Check if there are more pages
    if (items.length < perPage || allPrs.length >= response.data.total_count) {
      break;
    }

    // GitHub search caps at 1000 results
    if (page * perPage >= 1000) {
      hitCap = true;
      log.warn("Search hit 1000-result cap", { query, total: response.data.total_count });
      await writeSyncLog(
        "warn",
        logCategory,
        `Search hit 1000-result cap (${allPrs.length}/${response.data.total_count}) for: ${query.slice(0, 80)}`,
        { items_fetched: allPrs.length },
      );
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
  const now = new Date();

  // Time windows: 0-30d, 30-90d, 90-180d, 180-365d, 365d+
  const windowDays = [30, 90, 180, 365];

  for (let i = 0; i < windowDays.length; i++) {
    const recentDate = i === 0 ? now : new Date(now.getTime() - windowDays[i - 1] * MS_PER_DAY);
    const olderDate = new Date(now.getTime() - windowDays[i] * MS_PER_DAY);
    const recentStr = toDateStr(recentDate);
    const olderStr = toDateStr(olderDate);

    const query =
      i === 0
        ? `org:${org} type:pr is:open updated:>=${olderStr}`
        : `org:${org} type:pr is:open updated:${olderStr}..${recentStr}`;

    const windowLabel = i === 0 ? `updated:>=${olderStr}` : `updated:${olderStr}..${recentStr}`;
    const result = await searchPrs(token, query, budget, "hot_sync");
    const newPrs = result.prs.filter((pr) => !dedupMap.has(pr._id)).length;
    for (const pr of result.prs) {
      dedupMap.set(pr._id, pr);
    }

    await writeSyncLog(
      "info",
      "hot_sync",
      `Subdivision window ${windowLabel}: ${result.prs.length} PRs (${newPrs} new, ${dedupMap.size} cumulative)`,
      { items_fetched: result.prs.length },
    );

    if (result.hitCap) {
      log.warn("Subdivision window still hit 1000-result cap", {
        window: windowLabel,
        fetched: result.prs.length,
      });
    }
  }

  // Final window: very old open PRs (updated >365d ago)
  const oldestStr = toDateStr(
    new Date(now.getTime() - windowDays[windowDays.length - 1] * MS_PER_DAY),
  );
  const oldResult = await searchPrs(
    token,
    `org:${org} type:pr is:open updated:<${oldestStr}`,
    budget,
    "hot_sync",
  );
  const oldNew = oldResult.prs.filter((pr) => !dedupMap.has(pr._id)).length;
  for (const pr of oldResult.prs) {
    dedupMap.set(pr._id, pr);
  }

  await writeSyncLog(
    "info",
    "hot_sync",
    `Subdivision window updated:<${oldestStr}: ${oldResult.prs.length} PRs (${oldNew} new, ${dedupMap.size} cumulative)`,
    { items_fetched: oldResult.prs.length },
  );

  log.info("Open PR subdivision complete", {
    windows: windowDays.length + 1,
    totalPrs: dedupMap.size,
  });

  await writeSyncLog(
    "info",
    "hot_sync",
    `Open PR subdivision complete: ${windowDays.length + 1} windows, ${dedupMap.size} unique PRs (seeded with ${initialPrs.length})`,
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
 * Uses per-PR REST calls (2 per PR: pulls.get + pulls.listReviews).
 * Limited by budget — stops if budget is exhausted.
 */
async function enrichPrDetails(
  token: string,
  prs: GitHubPrDoc[],
  budget: ReturnType<typeof getRateLimitBudget>,
): Promise<number> {
  const octokit = getOctokit(token);
  let enriched = 0;

  for (const pr of prs) {
    // Check budget — need at least 2 requests per PR
    if (!budget.canSpendRest(2)) {
      log.debug("Budget exhausted, stopping PR enrichment", {
        remaining: enriched,
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
