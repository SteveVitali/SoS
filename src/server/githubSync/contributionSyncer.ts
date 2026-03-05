/**
 * ContributionSyncer — aggregates daily contribution stats from github_prs.
 * Runs as a cold-tier task, rebuilding contribution records from PR data.
 */

import type { GitHubContribution } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getContributionsCollection, getPrsCollection } from "./githubRepo.js";
import { writeSyncLog } from "./syncEventLog.js";

const log = createLogger("github:contributionSyncer");

/**
 * Rebuild contribution stats for an org by aggregating from github_prs.
 * Groups by (author, date) and sums PR metrics.
 *
 * This runs on the PR data already in MongoDB — no GitHub API calls needed.
 */
export async function rebuildContributions(org: string): Promise<number> {
  const startTime = Date.now();
  log.info("Rebuilding contribution stats", { org });

  const prsCol = getPrsCollection();
  const contribCol = getContributionsCollection();

  // Aggregate PRs opened per author per day
  const openedAgg = await prsCol
    .aggregate<{
      _id: { login: string; date: string };
      count: number;
      additions: number;
      deletions: number;
      repos: string[];
    }>([
      { $match: { org: org.toLowerCase() } },
      {
        $group: {
          _id: {
            login: "$author",
            date: {
              $dateToString: { format: "%Y-%m-%d", date: "$created_at" },
            },
          },
          count: { $sum: 1 },
          additions: { $sum: "$additions" },
          deletions: { $sum: "$deletions" },
          repos: { $addToSet: "$repo" },
        },
      },
    ])
    .toArray();

  // Aggregate PRs merged per author per day
  const mergedAgg = await prsCol
    .aggregate<{
      _id: { login: string; date: string };
      count: number;
    }>([
      {
        $match: {
          org: org.toLowerCase(),
          state: "merged",
          merged_at: { $ne: null },
        },
      },
      {
        $group: {
          _id: {
            login: "$author",
            date: {
              $dateToString: { format: "%Y-%m-%d", date: "$merged_at" },
            },
          },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  // Aggregate PRs closed (unmerged) per author per day
  const closedAgg = await prsCol
    .aggregate<{
      _id: { login: string; date: string };
      count: number;
    }>([
      {
        $match: {
          org: org.toLowerCase(),
          state: "closed",
          closed_at: { $ne: null },
        },
      },
      {
        $group: {
          _id: {
            login: "$author",
            date: {
              $dateToString: { format: "%Y-%m-%d", date: "$closed_at" },
            },
          },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  // Aggregate reviews submitted per reviewer per day
  const reviewAgg = await prsCol
    .aggregate<{
      _id: { login: string; date: string };
      count: number;
    }>([
      { $match: { org: org.toLowerCase() } },
      { $unwind: "$reviews" },
      {
        $group: {
          _id: {
            login: "$reviews.author",
            date: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$reviews.submitted_at",
              },
            },
          },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  // Merge into a single map keyed by "login:date"
  const contribMap = new Map<string, GitHubContribution>();

  function getOrCreate(login: string, dateStr: string): GitHubContribution {
    const key = `${login}:${dateStr}`;
    if (!contribMap.has(key)) {
      contribMap.set(key, {
        _id: key,
        login,
        org: org.toLowerCase(),
        date: new Date(`${dateStr}T00:00:00Z`),
        prs_opened: 0,
        prs_merged: 0,
        prs_closed: 0,
        reviews_submitted: 0,
        review_comments: 0,
        commits: 0,
        additions: 0,
        deletions: 0,
        repos_touched: [],
        synced_at: new Date(),
      });
    }
    return contribMap.get(key)!;
  }

  for (const row of openedAgg) {
    const c = getOrCreate(row._id.login, row._id.date);
    c.prs_opened += row.count;
    c.additions += row.additions;
    c.deletions += row.deletions;
    for (const repo of row.repos) {
      if (!c.repos_touched.includes(repo)) {
        c.repos_touched.push(repo);
      }
    }
  }

  for (const row of mergedAgg) {
    const c = getOrCreate(row._id.login, row._id.date);
    c.prs_merged += row.count;
  }

  for (const row of closedAgg) {
    const c = getOrCreate(row._id.login, row._id.date);
    c.prs_closed += row.count;
  }

  for (const row of reviewAgg) {
    const c = getOrCreate(row._id.login, row._id.date);
    c.reviews_submitted += row.count;
  }

  // Bulk upsert
  const docs = Array.from(contribMap.values());
  if (docs.length > 0) {
    const ops = docs.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id as any },
        update: { $set: doc },
        upsert: true,
      },
    }));

    // Batch in chunks of 500 to avoid huge bulk ops
    for (let i = 0; i < ops.length; i += 500) {
      const batch = ops.slice(i, i + 500);
      await contribCol.bulkWrite(batch, { ordered: false });
    }
  }

  const duration = Date.now() - startTime;
  log.info("Contribution stats rebuilt", {
    org,
    records: docs.length,
    duration_ms: duration,
  });

  await writeSyncLog(
    "info",
    "contribution_sync",
    `Rebuilt ${docs.length} contribution records for ${org}`,
    {
      items_fetched: docs.length,
      duration_ms: duration,
    },
  );

  return docs.length;
}
