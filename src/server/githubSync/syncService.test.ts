import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all heavy dependencies before importing the module under test
vi.mock("./githubRepo.js", () => ({
  getChunkStats: vi.fn().mockResolvedValue({ pending: 0, failed: 0, in_progress: 0 }),
  getIncompleteChunks: vi.fn().mockResolvedValue([]),
  getSyncChunk: vi.fn().mockResolvedValue(null),
  getSyncChunksCollection: vi.fn().mockReturnValue({
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    findOne: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  }),
  getSyncCursor: vi.fn().mockResolvedValue({}),
  getTaskLastRunTimestamps: vi.fn().mockResolvedValue({}),
  resetStaleInProgressChunks: vi.fn().mockResolvedValue(0),
  setSyncCursor: vi.fn().mockResolvedValue(undefined),
  setTaskLastRun: vi.fn().mockResolvedValue(undefined),
  upsertSyncChunk: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./githubConfig.js", () => ({
  resolveGitHubConfig: vi.fn().mockResolvedValue({
    token: "ghp_test",
    org: "TestOrg",
    syncEnabled: true,
    historyDays: 365,
    chunkDays: 28,
    chunkEpoch: "2024-01-01",
    hotIntervalSeconds: 900,
    warmIntervalSeconds: 3600,
  }),
}));

vi.mock("./contributionSyncer.js", () => ({
  rebuildContributions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./octokitClient.js", () => ({
  getRateLimitBudget: vi.fn().mockReturnValue({ canSpendRest: () => true }),
}));

vi.mock("./orgSyncer.js", () => ({
  syncOrg: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./prSyncer.js", () => ({
  syncChunk: vi.fn().mockResolvedValue(undefined),
  syncOpenPrs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./syncEventLog.js", () => ({
  writeSyncLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./chunks.js", () => ({
  buildChunkDocId: vi.fn().mockReturnValue("chunk-id"),
  getAllChunks: vi.fn().mockReturnValue([]),
  MS_PER_DAY: 86400000,
  parseChunkConfig: vi.fn().mockReturnValue({
    epochDate: new Date("2024-01-01"),
    chunkDays: 28,
    historyDays: 365,
  }),
}));

import {
  getChunkStats,
  getTaskLastRunTimestamps,
  resetStaleInProgressChunks,
  setTaskLastRun,
} from "./githubRepo.js";
import { writeSyncLog } from "./syncEventLog.js";
import { computeNextRunAt, GitHubSyncService } from "./syncService.js";

const mockedGetTaskTimestamps = vi.mocked(getTaskLastRunTimestamps);
const mockedSetTaskLastRun = vi.mocked(setTaskLastRun);
const mockedResetStaleInProgress = vi.mocked(resetStaleInProgressChunks);
const mockedGetChunkStats = vi.mocked(getChunkStats);
const mockedWriteSyncLog = vi.mocked(writeSyncLog);

describe("computeNextRunAt", () => {
  it("returns now when no lastRun exists (first boot)", () => {
    const before = Date.now();
    const result = computeNextRunAt(undefined, 900_000);
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  it("returns now when interval has already elapsed", () => {
    const lastRun = new Date(Date.now() - 1_000_000); // 1000s ago
    const intervalMs = 900_000; // 900s interval
    const before = Date.now();
    const result = computeNextRunAt(lastRun, intervalMs);
    // interval elapsed 100s ago, so should return ~now
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(before + 50);
  });

  it("returns future time when interval has not elapsed", () => {
    const lastRun = new Date(Date.now() - 300_000); // 5 min ago
    const intervalMs = 900_000; // 15 min interval
    const result = computeNextRunAt(lastRun, intervalMs);
    // Should be ~10 min from now (lastRun + 15min)
    const expectedAt = lastRun.getTime() + intervalMs;
    expect(result.getTime()).toBe(expectedAt);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns exact interval boundary when lastRun is exactly interval ago", () => {
    const intervalMs = 900_000;
    const lastRun = new Date(Date.now() - intervalMs);
    const result = computeNextRunAt(lastRun, intervalMs);
    // nextAt === now, so Math.max(nextAt, Date.now()) ~= now
    expect(Math.abs(result.getTime() - Date.now())).toBeLessThan(50);
  });
});

describe("GitHubSyncService", () => {
  let service: GitHubSyncService;

  beforeEach(() => {
    service = new GitHubSyncService();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("start — timer restoration", () => {
    it("loads persisted task timestamps on start", async () => {
      const fiveMinAgo = new Date(Date.now() - 300_000);
      mockedGetTaskTimestamps.mockResolvedValue({
        "hot-prs": fiveMinAgo,
        "org-sync": fiveMinAgo,
        contributions: fiveMinAgo,
      });

      await service.start();
      service.stop();

      expect(mockedGetTaskTimestamps).toHaveBeenCalledWith("testorg");
    });

    it("schedules tasks in the future when interval has not elapsed", async () => {
      const fiveMinAgo = new Date(Date.now() - 300_000);
      mockedGetTaskTimestamps.mockResolvedValue({
        "hot-prs": fiveMinAgo, // 5 min ago, 15 min interval → 10 min remaining
        "org-sync": fiveMinAgo, // 5 min ago, 60 min interval → 55 min remaining
      });

      await service.start();
      const status = await service.getStatus();
      service.stop();

      const hotTask = status.tasks.find((t) => t.type === "hot-prs");
      const orgTask = status.tasks.find((t) => t.type === "org-sync");

      // hot-prs: lastRun 5min ago + 15min interval = 10min from now
      expect(hotTask).toBeDefined();
      const hotNextAt = new Date(hotTask?.nextRunAt ?? 0).getTime();
      expect(hotNextAt).toBeGreaterThan(Date.now() + 500_000); // at least ~8 min out

      // org-sync: lastRun 5min ago + 60min interval = 55min from now
      expect(orgTask).toBeDefined();
      const orgNextAt = new Date(orgTask?.nextRunAt ?? 0).getTime();
      expect(orgNextAt).toBeGreaterThan(Date.now() + 3_000_000); // at least ~50 min out
    });

    it("schedules tasks immediately when no persisted timestamps", async () => {
      mockedGetTaskTimestamps.mockResolvedValue({});

      await service.start();
      const status = await service.getStatus();
      service.stop();

      const hotTask = status.tasks.find((t) => t.type === "hot-prs");
      expect(hotTask).toBeDefined();
      const hotNextAt = new Date(hotTask?.nextRunAt ?? 0).getTime();
      // Should be approximately now (within 1 second)
      expect(Math.abs(hotNextAt - Date.now())).toBeLessThan(1000);
    });

    it("schedules tasks immediately when interval has fully elapsed", async () => {
      const twoHoursAgo = new Date(Date.now() - 7_200_000);
      mockedGetTaskTimestamps.mockResolvedValue({
        "hot-prs": twoHoursAgo, // 2h ago, 15min interval → long overdue
        "org-sync": twoHoursAgo, // 2h ago, 1h interval → overdue
      });

      await service.start();
      const status = await service.getStatus();
      service.stop();

      const hotTask = status.tasks.find((t) => t.type === "hot-prs");
      const orgTask = status.tasks.find((t) => t.type === "org-sync");

      // Both should be ready to run now (nextRunAt <= now or very close)
      expect(new Date(hotTask?.nextRunAt ?? 0).getTime()).toBeLessThanOrEqual(Date.now() + 100);
      expect(new Date(orgTask?.nextRunAt ?? 0).getTime()).toBeLessThanOrEqual(Date.now() + 100);
    });
  });

  describe("stale in_progress chunk recovery on startup", () => {
    it("calls resetStaleInProgressChunks on start", async () => {
      mockedGetTaskTimestamps.mockResolvedValue({});
      mockedResetStaleInProgress.mockResolvedValue(0);

      await service.start();
      service.stop();

      expect(mockedResetStaleInProgress).toHaveBeenCalledWith("testorg", "prs");
    });

    it("logs recovery when stale chunks are found", async () => {
      mockedGetTaskTimestamps.mockResolvedValue({});
      mockedResetStaleInProgress.mockResolvedValue(3);

      await service.start();
      service.stop();

      expect(mockedResetStaleInProgress).toHaveBeenCalledWith("testorg", "prs");
      expect(mockedWriteSyncLog).toHaveBeenCalledWith(
        "info",
        "backfill",
        expect.stringContaining("3 stale in_progress"),
      );
    });

    it("adds backfill task when in_progress chunks exist", async () => {
      mockedGetTaskTimestamps.mockResolvedValue({});
      mockedResetStaleInProgress.mockResolvedValue(2);
      mockedGetChunkStats.mockResolvedValue({
        total: 10,
        completed: 8,
        in_progress: 2,
        failed: 0,
        pending: 0,
        total_items: 100,
      });

      await service.start();
      const status = await service.getStatus();
      service.stop();

      const backfillTask = status.tasks.find((t) => t.type === "backfill-chunk");
      expect(backfillTask).toBeDefined();
    });
  });

  describe("task persistence after run", () => {
    it("persists task timestamp to MongoDB after successful task execution", async () => {
      mockedGetTaskTimestamps.mockResolvedValue({});

      await service.start();

      // Advance timers to trigger the hot-prs task (scheduled immediately)
      await vi.advanceTimersByTimeAsync(100);

      service.stop();

      // setTaskLastRun should have been called for the hot-prs task
      expect(mockedSetTaskLastRun).toHaveBeenCalledWith("testorg", "hot-prs", expect.any(Date));
    });
  });
});
