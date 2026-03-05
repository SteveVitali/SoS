/**
 * MongoDB repository for GitHub Hub collections.
 * Handles all CRUD operations and index management.
 */

import type { Collection } from "mongodb";
import type {
  GitHubContribution,
  GitHubOrgMember,
  GitHubPrDoc,
  GitHubSettings,
  GitHubSyncChunk,
  GitHubSyncLogEntry,
  GitHubTeam,
} from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getDb } from "../mongo.js";

const log = createLogger("github:repo");

// --- Collection accessors ---

export function getOrgMembersCollection(): Collection<GitHubOrgMember> {
  return getDb().collection<GitHubOrgMember>("github_org_members");
}

export function getTeamsCollection(): Collection<GitHubTeam> {
  return getDb().collection<GitHubTeam>("github_teams");
}

export function getPrsCollection(): Collection<GitHubPrDoc> {
  return getDb().collection<GitHubPrDoc>("github_prs");
}

export function getContributionsCollection(): Collection<GitHubContribution> {
  return getDb().collection<GitHubContribution>("github_contributions");
}

export function getSyncChunksCollection(): Collection<GitHubSyncChunk> {
  return getDb().collection<GitHubSyncChunk>("github_sync_chunks");
}

export function getSyncLogCollection(): Collection<GitHubSyncLogEntry> {
  return getDb().collection<GitHubSyncLogEntry>("github_sync_log");
}

export function getSettingsCollection(): Collection<GitHubSettings> {
  return getDb().collection<GitHubSettings>("github_settings");
}

// --- Index management ---

export async function ensureGitHubIndexes(): Promise<void> {
  log.info("Ensuring GitHub Hub indexes...");

  const members = getOrgMembersCollection();
  await members.createIndex({ org: 1, login: 1 }, { unique: true, name: "idx_org_login" });
  await members.createIndex({ teams: 1 }, { name: "idx_teams" });

  const teams = getTeamsCollection();
  await teams.createIndex({ org: 1, slug: 1 }, { unique: true, name: "idx_org_slug" });

  const prs = getPrsCollection();
  await prs.createIndex({ org: 1, state: 1, updated_at: -1 }, { name: "idx_org_state_updated" });
  await prs.createIndex(
    { author: 1, state: 1, updated_at: -1 },
    { name: "idx_author_state_updated" },
  );
  await prs.createIndex({ requested_reviewers: 1, state: 1 }, { name: "idx_reviewers_state" });
  await prs.createIndex({ repo: 1, number: 1 }, { unique: true, name: "idx_repo_number" });
  await prs.createIndex({ org: 1, created_at: -1 }, { name: "idx_org_created" });
  await prs.createIndex({ org: 1, merged_at: -1 }, { name: "idx_org_merged", sparse: true });

  const contributions = getContributionsCollection();
  await contributions.createIndex({ login: 1, date: -1 }, { name: "idx_login_date" });
  await contributions.createIndex({ org: 1, date: -1 }, { name: "idx_org_date" });

  const syncChunks = getSyncChunksCollection();
  await syncChunks.createIndex(
    { org: 1, data_type: 1, chunk_start: 1 },
    { unique: true, name: "idx_org_type_start" },
  );
  await syncChunks.createIndex({ status: 1, chunk_start: -1 }, { name: "idx_status_start" });

  const syncLog = getSyncLogCollection();
  await syncLog.createIndex({ ts: -1 }, { name: "idx_ts" });
  await syncLog.createIndex({ category: 1, ts: -1 }, { name: "idx_category_ts" });
  // TTL: auto-delete log entries older than 7 days
  await syncLog.createIndex({ ts: 1 }, { expireAfterSeconds: 7 * 24 * 3600, name: "idx_ts_ttl" });

  log.info("GitHub Hub indexes ensured");
}

// --- Settings CRUD ---

export async function getGitHubSettings(): Promise<GitHubSettings | null> {
  return getSettingsCollection().findOne({ _id: "global" as any });
}

export async function saveGitHubSettings(settings: Partial<GitHubSettings>): Promise<void> {
  await getSettingsCollection().updateOne(
    { _id: "global" as any },
    { $set: settings },
    { upsert: true },
  );
}

// --- PR CRUD helpers ---

/** Fields only available from the PR detail endpoint, not the search API. */
const DETAIL_ONLY_FIELDS = new Set([
  "additions",
  "deletions",
  "changed_files",
  "head_ref",
  "base_ref",
  "reviews",
  "requested_reviewers",
  "review_decision",
  "body",
  "body_truncated",
  "comment_stats",
  "detail_synced_at",
]);

export async function upsertPrsBatch(
  prs: GitHubPrDoc[],
  options?: { preserveDetailFields?: boolean },
): Promise<number> {
  if (prs.length === 0) return 0;

  const ops = prs.map((pr) => {
    if (options?.preserveDetailFields) {
      // Split fields: search-sourced fields → $set, detail fields → $setOnInsert
      // so enriched data is never overwritten by search defaults (0 / empty)
      const searchFields: Record<string, unknown> = {};
      const detailDefaults: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(pr)) {
        if (key === "_id") continue;
        if (DETAIL_ONLY_FIELDS.has(key)) {
          detailDefaults[key] = value;
        } else {
          searchFields[key] = value;
        }
      }
      return {
        updateOne: {
          filter: { _id: pr._id },
          update: { $set: searchFields, $setOnInsert: detailDefaults },
          upsert: true,
        },
      };
    }
    return {
      updateOne: {
        filter: { _id: pr._id },
        update: { $set: pr },
        upsert: true,
      },
    };
  });

  const result = await getPrsCollection().bulkWrite(ops, { ordered: false });
  return result.upsertedCount + result.modifiedCount;
}

// --- Org member CRUD ---

export async function upsertTeam(team: GitHubTeam): Promise<void> {
  await getTeamsCollection().updateOne({ _id: team._id }, { $set: team }, { upsert: true });
}

// --- Sync chunk CRUD ---

export async function upsertSyncChunk(chunk: GitHubSyncChunk): Promise<void> {
  await getSyncChunksCollection().updateOne({ _id: chunk._id }, { $set: chunk }, { upsert: true });
}

export async function getSyncChunk(id: string): Promise<GitHubSyncChunk | null> {
  return getSyncChunksCollection().findOne({ _id: id as any });
}

export async function getIncompleteChunks(
  org: string,
  dataType: string,
): Promise<GitHubSyncChunk[]> {
  return getSyncChunksCollection()
    .find({
      org,
      data_type: dataType as any,
      status: { $in: ["pending", "failed"] } as any,
    })
    .sort({ chunk_start: 1 })
    .toArray();
}

// --- Sync cursor (persists across reboots) ---

interface SyncCursorDoc {
  _id: string;
  last_hot_sync_at?: Date;
}

function getSyncStateCollection(): Collection<SyncCursorDoc> {
  return getDb().collection<SyncCursorDoc>("github_sync_state");
}

export async function getSyncCursor(org: string): Promise<{ last_hot_sync_at?: Date }> {
  const doc = await getSyncStateCollection().findOne({ _id: org });
  return { last_hot_sync_at: doc?.last_hot_sync_at };
}

export async function setSyncCursor(org: string, lastHotSyncAt: Date): Promise<void> {
  await getSyncStateCollection().updateOne(
    { _id: org },
    { $set: { last_hot_sync_at: lastHotSyncAt } },
    { upsert: true },
  );
}

export async function getChunkStats(
  org: string,
  dataType: string,
): Promise<{
  total: number;
  completed: number;
  in_progress: number;
  failed: number;
  pending: number;
  total_items: number;
}> {
  const pipeline = [
    { $match: { org, data_type: dataType } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        items: { $sum: "$total_items" },
      },
    },
  ];

  const buckets = await getSyncChunksCollection()
    .aggregate<{ _id: string; count: number; items: number }>(pipeline)
    .toArray();

  let total = 0;
  let completed = 0;
  let in_progress = 0;
  let failed = 0;
  let pending = 0;
  let total_items = 0;

  for (const b of buckets) {
    total += b.count;
    total_items += b.items;
    switch (b._id) {
      case "complete":
        completed = b.count;
        break;
      case "in_progress":
        in_progress = b.count;
        break;
      case "failed":
        failed = b.count;
        break;
      default:
        pending += b.count;
    }
  }

  return { total, completed, in_progress, failed, pending, total_items };
}
