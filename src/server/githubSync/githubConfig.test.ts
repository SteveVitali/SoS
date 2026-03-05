import { afterEach, describe, expect, it, vi } from "vitest";

// Mock githubRepo before importing the module under test
vi.mock("./githubRepo.js", () => ({
  getGitHubSettings: vi.fn().mockResolvedValue(null),
}));

import {
  getGitHubConfigSync,
  invalidateSettingsCache,
  resolveGitHubConfig,
} from "./githubConfig.js";
import { getGitHubSettings } from "./githubRepo.js";

const mockedGetSettings = vi.mocked(getGitHubSettings);

describe("githubConfig", () => {
  afterEach(() => {
    // Reset env vars and cache between tests
    delete process.env.SOS_GITHUB_ORG;
    delete process.env.SOS_GITHUB_TEAM_SLUG;
    delete process.env.SOS_GITHUB_USERNAME;
    delete process.env.SOS_GITHUB_TOKEN;
    delete process.env.SOS_GITHUB_HISTORY_DAYS;
    delete process.env.SOS_GITHUB_CHUNK_DAYS;
    delete process.env.SOS_GITHUB_CHUNK_EPOCH;
    delete process.env.SOS_GITHUB_SYNC_ENABLED;
    delete process.env.SOS_GITHUB_SYNC_HOT_INTERVAL;
    delete process.env.SOS_GITHUB_SYNC_WARM_INTERVAL;
    invalidateSettingsCache();
    mockedGetSettings.mockResolvedValue(null);
  });

  describe("resolveGitHubConfig", () => {
    it("returns hardcoded defaults when no env vars or DB settings", async () => {
      const config = await resolveGitHubConfig();
      expect(config.org).toBe("Foursquare");
      expect(config.teamSlug).toBe("places-engineering");
      expect(config.username).toBe("");
      expect(config.token).toBe("");
      expect(config.historyDays).toBe(365);
      expect(config.chunkDays).toBe(28);
      expect(config.chunkEpoch).toBe("2024-01-01");
      expect(config.syncEnabled).toBe(true);
      expect(config.hotIntervalSeconds).toBe(600);
      expect(config.warmIntervalSeconds).toBe(3600);
      expect(config.defaultScope).toBe("me");
      expect(config.pinnedRepos).toEqual([]);
      expect(config.contributionRange).toBe("30d");
    });

    it("env vars override hardcoded defaults", async () => {
      process.env.SOS_GITHUB_ORG = "TestOrg";
      process.env.SOS_GITHUB_TEAM_SLUG = "test-team";
      process.env.SOS_GITHUB_USERNAME = "testuser";
      process.env.SOS_GITHUB_TOKEN = "ghp_test123";
      process.env.SOS_GITHUB_HISTORY_DAYS = "180";
      process.env.SOS_GITHUB_SYNC_ENABLED = "false";
      process.env.SOS_GITHUB_SYNC_HOT_INTERVAL = "60";

      const config = await resolveGitHubConfig();
      expect(config.org).toBe("TestOrg");
      expect(config.teamSlug).toBe("test-team");
      expect(config.username).toBe("testuser");
      expect(config.token).toBe("ghp_test123");
      expect(config.historyDays).toBe(180);
      expect(config.syncEnabled).toBe(false);
      expect(config.hotIntervalSeconds).toBe(60);
    });

    it("DB settings override env vars", async () => {
      process.env.SOS_GITHUB_ORG = "EnvOrg";
      process.env.SOS_GITHUB_TEAM_SLUG = "env-team";

      mockedGetSettings.mockResolvedValue({
        _id: "global",
        org: "DbOrg",
        team_slug: "db-team",
        username: "dbuser",
        history_days: 90,
        default_scope: "team",
        pinned_repos: ["repo1", "repo2"],
        contribution_range: "7d",
        sync_enabled: false,
      });

      const config = await resolveGitHubConfig();
      expect(config.org).toBe("DbOrg");
      expect(config.teamSlug).toBe("db-team");
      expect(config.username).toBe("dbuser");
      expect(config.historyDays).toBe(90);
      expect(config.defaultScope).toBe("team");
      expect(config.pinnedRepos).toEqual(["repo1", "repo2"]);
      expect(config.contributionRange).toBe("7d");
      expect(config.syncEnabled).toBe(false);
    });

    it("DB settings only override fields that are set (partial override)", async () => {
      process.env.SOS_GITHUB_ORG = "EnvOrg";

      mockedGetSettings.mockResolvedValue({
        _id: "global",
        org: "",
        team_slug: "db-team",
        username: "",
        history_days: 0,
        default_scope: "me",
        pinned_repos: [],
        contribution_range: "",
        sync_enabled: true,
      });

      const config = await resolveGitHubConfig();
      // Empty string is falsy → falls through to env var
      expect(config.org).toBe("EnvOrg");
      // Non-empty DB value wins
      expect(config.teamSlug).toBe("db-team");
    });
  });

  describe("getGitHubConfigSync", () => {
    it("uses env vars when cache is empty", () => {
      process.env.SOS_GITHUB_ORG = "SyncOrg";
      const config = getGitHubConfigSync();
      expect(config.org).toBe("SyncOrg");
    });

    it("returns defaults when no env vars and no cache", () => {
      const config = getGitHubConfigSync();
      expect(config.org).toBe("Foursquare");
      expect(config.teamSlug).toBe("places-engineering");
    });
  });

  describe("invalidateSettingsCache", () => {
    it("forces re-fetch on next resolveGitHubConfig call", async () => {
      // Clear any prior calls from other tests
      mockedGetSettings.mockClear();
      invalidateSettingsCache();

      // First call populates cache
      await resolveGitHubConfig();
      expect(mockedGetSettings).toHaveBeenCalledTimes(1);

      // Second call uses cache (TTL not expired)
      await resolveGitHubConfig();
      expect(mockedGetSettings).toHaveBeenCalledTimes(1);

      // Invalidate forces re-fetch
      invalidateSettingsCache();
      await resolveGitHubConfig();
      expect(mockedGetSettings).toHaveBeenCalledTimes(2);
    });
  });
});
