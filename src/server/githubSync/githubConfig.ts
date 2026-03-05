/**
 * GitHub Hub configuration resolution.
 * Precedence: MongoDB settings (UI) > env var > hardcoded default.
 */

import type { GitHubSettings } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getGitHubSettings } from "./githubRepo.js";

const log = createLogger("github:config");

let cachedSettings: GitHubSettings | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000;

/** Build config from DB settings (nullable) merged over env vars over defaults. */
function buildConfig(dbSettings: GitHubSettings | null): ResolvedGitHubConfig {
  return {
    org: dbSettings?.org || process.env.SOS_GITHUB_ORG || "MyOrganization",
    teamSlug: dbSettings?.team_slug || process.env.SOS_GITHUB_TEAM_SLUG || "my-team",
    username: dbSettings?.username || process.env.SOS_GITHUB_USERNAME || "",
    token: process.env.SOS_GITHUB_TOKEN || "",
    historyDays:
      dbSettings?.history_days || parseInt(process.env.SOS_GITHUB_HISTORY_DAYS || "365", 10),
    chunkDays: parseInt(process.env.SOS_GITHUB_CHUNK_DAYS || "28", 10),
    chunkEpoch: process.env.SOS_GITHUB_CHUNK_EPOCH || "2024-01-01",
    syncEnabled: dbSettings?.sync_enabled ?? process.env.SOS_GITHUB_SYNC_ENABLED !== "false",
    hotIntervalSeconds: parseInt(process.env.SOS_GITHUB_SYNC_HOT_INTERVAL || "120", 10),
    warmIntervalSeconds: parseInt(process.env.SOS_GITHUB_SYNC_WARM_INTERVAL || "900", 10),
    defaultScope: dbSettings?.default_scope || "me",
    pinnedRepos: dbSettings?.pinned_repos || [],
    contributionRange: dbSettings?.contribution_range || "30d",
  };
}

/** Resolve the full GitHub config, merging DB settings over env vars over defaults. */
export async function resolveGitHubConfig(): Promise<ResolvedGitHubConfig> {
  const dbSettings = await getCachedSettings();
  return buildConfig(dbSettings);
}

/** Get config synchronously from cache (for hot paths). Falls back to env vars only. */
export function getGitHubConfigSync(): ResolvedGitHubConfig {
  return buildConfig(cachedSettings);
}

export interface ResolvedGitHubConfig {
  org: string;
  teamSlug: string;
  username: string;
  token: string;
  historyDays: number;
  chunkDays: number;
  chunkEpoch: string;
  syncEnabled: boolean;
  hotIntervalSeconds: number;
  warmIntervalSeconds: number;
  defaultScope: "me" | "team" | "org";
  pinnedRepos: string[];
  contributionRange: string;
}

/** Invalidate the cached settings (call after saving new settings). */
export function invalidateSettingsCache(): void {
  cachedSettings = null;
  cacheTime = 0;
}

async function getCachedSettings(): Promise<GitHubSettings | null> {
  if (cacheTime > 0 && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSettings;
  }
  try {
    cachedSettings = await getGitHubSettings();
    cacheTime = Date.now();
  } catch (err: unknown) {
    log.warn("Failed to load GitHub settings from DB", {
      error: (err as Error).message,
    });
  }
  return cachedSettings;
}
