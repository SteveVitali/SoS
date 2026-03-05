/**
 * GitHubSyncService — the main orchestrator.
 *
 * Runs a priority-queue loop that:
 * 1. Hot-syncs open PRs on a fast cadence (Tier 1)
 * 2. Backfills historical chunks continuously until 100% (Tier 3)
 * 3. Warm-syncs org/team membership (Tier 2)
 * 4. Rebuilds contribution aggregations periodically
 *
 * Respects rate limits and gracefully shuts down.
 */

import type { ChunkInfo } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { buildChunkDocId, getAllChunks, parseChunkConfig } from "./chunks.js";
import { rebuildContributions } from "./contributionSyncer.js";
import type { ResolvedGitHubConfig } from "./githubConfig.js";
import { resolveGitHubConfig } from "./githubConfig.js";
import {
  getChunkStats,
  getIncompleteChunks,
  getSyncChunk,
  getSyncChunksCollection,
  upsertSyncChunk,
} from "./githubRepo.js";
import { getRateLimitBudget } from "./octokitClient.js";
import { syncOrg } from "./orgSyncer.js";
import { syncChunk, syncOpenPrs } from "./prSyncer.js";
import { writeSyncLog } from "./syncEventLog.js";

const log = createLogger("github:syncService");

interface SyncTask {
  id: string;
  type: "hot-prs" | "backfill-chunk" | "org-sync" | "contributions";
  priority: 1 | 2 | 3;
  nextRunAt: Date;
  intervalMs: number;
  lastRunAt?: Date;
}

export class GitHubSyncService {
  private running = false;
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private tasks: SyncTask[] = [];

  async start(): Promise<void> {
    const config = await resolveGitHubConfig();

    if (!config.token) {
      log.warn("SOS_GITHUB_TOKEN not set — GitHub sync disabled");
      await writeSyncLog(
        "warn",
        "hot_sync",
        "GitHub sync disabled: SOS_GITHUB_TOKEN not configured",
      );
      return;
    }

    if (!config.syncEnabled) {
      log.info("GitHub sync disabled via config");
      await writeSyncLog("info", "hot_sync", "GitHub sync disabled via config");
      return;
    }

    log.info("Starting GitHub sync service", {
      org: config.org,
      historyDays: config.historyDays,
      hotInterval: config.hotIntervalSeconds,
      warmInterval: config.warmIntervalSeconds,
    });

    await writeSyncLog("info", "hot_sync", `Sync service starting for org ${config.org}`);

    this.running = true;

    // Initialize tasks
    this.tasks = [
      {
        id: "hot-prs",
        type: "hot-prs",
        priority: 1,
        nextRunAt: new Date(), // run immediately
        intervalMs: config.hotIntervalSeconds * 1000,
      },
      {
        id: "org-sync",
        type: "org-sync",
        priority: 2,
        nextRunAt: new Date(Date.now() + 5000), // slight delay
        intervalMs: config.warmIntervalSeconds * 1000,
      },
      {
        id: "contributions",
        type: "contributions",
        priority: 3,
        nextRunAt: new Date(Date.now() + 60_000), // delay 1 min
        intervalMs: 3600_000, // every hour
      },
    ];

    // Initialize backfill chunks
    await this.initializeBackfillChunks(config);

    // Start the loop
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.loopHandle) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
    log.info("GitHub sync service stopped");
  }

  /** Force a specific task to run now (from UI trigger button). */
  async triggerTask(
    type: "hot-prs" | "backfill-chunk" | "org-sync" | "contributions",
  ): Promise<void> {
    const task = this.tasks.find((t) => t.type === type);
    if (task) {
      task.nextRunAt = new Date();
    }
    // If it's a backfill trigger, also reset failed chunks
    if (type === "backfill-chunk") {
      await this.resetFailedChunks();
    }
  }

  /** Get the current sync status for the API. */
  async getStatus(): Promise<{
    enabled: boolean;
    running: boolean;
    tasks: Array<{
      id: string;
      type: string;
      priority: number;
      nextRunAt: string;
      lastRunAt?: string;
    }>;
  }> {
    const config = await resolveGitHubConfig();
    return {
      enabled: config.syncEnabled && !!config.token,
      running: this.running,
      tasks: this.tasks.map((t) => ({
        id: t.id,
        type: t.type,
        priority: t.priority,
        nextRunAt: t.nextRunAt.toISOString(),
        lastRunAt: t.lastRunAt?.toISOString(),
      })),
    };
  }

  // --- Private ---

  private scheduleNext(): void {
    if (!this.running) return;

    // Find the next task to run
    const now = Date.now();
    let nextTask: SyncTask | null = null;
    let soonestMs = Infinity;

    for (const task of this.tasks) {
      const msUntil = task.nextRunAt.getTime() - now;
      if (msUntil <= 0) {
        // Ready to run — pick highest priority
        if (!nextTask || task.priority < nextTask.priority) {
          nextTask = task;
        }
      } else if (msUntil < soonestMs) {
        soonestMs = msUntil;
      }
    }

    if (nextTask) {
      // Run it now
      this.loopHandle = setTimeout(() => this.runTask(nextTask!), 0);
    } else {
      // Wait for the soonest task
      const waitMs = Math.min(soonestMs, 10_000); // cap at 10s for responsiveness
      this.loopHandle = setTimeout(() => this.scheduleNext(), waitMs);
    }
  }

  private async runTask(task: SyncTask): Promise<void> {
    if (!this.running) return;

    try {
      const config = await resolveGitHubConfig();

      switch (task.type) {
        case "hot-prs":
          await syncOpenPrs(config.token, config.org);
          break;

        case "org-sync":
          await syncOrg(config.token, config.org);
          break;

        case "backfill-chunk":
          await this.runBackfill(config);
          break;

        case "contributions":
          await rebuildContributions(config.org);
          break;
      }

      task.lastRunAt = new Date();
    } catch (err: unknown) {
      log.error("Sync task failed", {
        task: task.id,
        error: (err as Error).message,
      });
      // Don't crash the loop — just log and continue
    }

    // Reschedule this task
    task.nextRunAt = new Date(Date.now() + task.intervalMs);

    // Continue the loop
    this.scheduleNext();
  }

  private async runBackfill(config: ResolvedGitHubConfig): Promise<void> {
    const budget = getRateLimitBudget();

    // Check if we have budget for backfill
    if (!budget.canSpendRest(10)) {
      log.debug("Not enough REST budget for backfill, skipping");
      return;
    }

    // Find the next incomplete chunk
    const incomplete = await getIncompleteChunks(config.org.toLowerCase(), "prs");
    if (incomplete.length === 0) {
      // All chunks complete — remove backfill task from queue
      this.tasks = this.tasks.filter((t) => t.type !== "backfill-chunk");
      await writeSyncLog("info", "backfill", "Historical backfill 100% complete!");
      return;
    }

    // Find first chunk that hasn't permanently failed (3+ attempts)
    const next = incomplete.find((c) => !(c.attempt >= 3 && c.status === "failed"));
    if (!next) {
      // All remaining chunks are permanently failed — remove backfill task
      this.tasks = this.tasks.filter((t) => t.type !== "backfill-chunk");
      log.warn("All remaining backfill chunks have permanently failed (3+ attempts)");
      await writeSyncLog(
        "warn",
        "backfill",
        "All remaining chunks permanently failed. Trigger manually to reset.",
      );
      return;
    }

    const chunkStart = next.chunk_start.toISOString().split("T")[0];
    const chunkEnd = next.chunk_end.toISOString().split("T")[0];

    await syncChunk(config.token, config.org, chunkStart, chunkEnd);
  }

  private async initializeBackfillChunks(config: ResolvedGitHubConfig): Promise<void> {
    const chunkConfig = parseChunkConfig({
      epochDate: config.chunkEpoch,
      chunkDays: config.chunkDays,
      historyDays: config.historyDays,
    });

    const org = config.org.toLowerCase();
    const since = new Date(Date.now() - chunkConfig.historyDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const allChunks = getAllChunks(since, now, chunkConfig.epochDate, chunkConfig.chunkDays);

    // Detect chunk-size drift: if existing chunks have a different span than
    // the configured chunkDays, drop them all and re-initialize.
    const existingSample = await getSyncChunksCollection().findOne({
      org,
      data_type: "prs",
    } as any);
    if (existingSample) {
      const existingSpanMs =
        existingSample.chunk_end.getTime() - existingSample.chunk_start.getTime();
      const configuredSpanMs = chunkConfig.chunkDays * 24 * 60 * 60 * 1000;
      if (Math.abs(existingSpanMs - configuredSpanMs) > 60_000) {
        const oldDays = Math.round(existingSpanMs / (24 * 60 * 60 * 1000));
        log.warn("Chunk size changed, dropping stale chunks and re-initializing", {
          oldChunkDays: oldDays,
          newChunkDays: chunkConfig.chunkDays,
        });
        await getSyncChunksCollection().deleteMany({ org, data_type: "prs" } as any);
        await writeSyncLog(
          "warn",
          "backfill",
          `Chunk size changed from ${oldDays}d → ${chunkConfig.chunkDays}d. Dropped all chunks and re-initializing.`,
        );
      }
    }

    log.info("Initializing backfill chunks", {
      total: allChunks.length,
      chunkDays: chunkConfig.chunkDays,
      since: since.toISOString(),
    });

    // Ensure each chunk has a document in github_sync_chunks
    let pendingCount = 0;
    for (const chunk of allChunks) {
      const docId = buildChunkDocId("prs", org, chunk.id);
      const existing = await getSyncChunk(docId);

      if (!existing) {
        await upsertSyncChunk({
          _id: docId,
          org,
          data_type: "prs",
          chunk_start: new Date(chunk.start),
          chunk_end: new Date(chunk.end),
          status: "pending",
          pages_fetched: 0,
          total_items: 0,
          attempt: 0,
        });
        pendingCount++;
      }
    }

    if (pendingCount > 0) {
      // Add backfill task to the queue
      this.tasks.push({
        id: "backfill-chunk",
        type: "backfill-chunk",
        priority: 2, // between hot and cold
        nextRunAt: new Date(Date.now() + 10_000), // start in 10s
        intervalMs: 5_000, // process chunks every 5s (limited by budget)
      });

      await writeSyncLog(
        "info",
        "backfill",
        `Initialized ${pendingCount} pending backfill chunks (${allChunks.length} total)`,
      );
    } else {
      // Check if there are any incomplete
      const stats = await getChunkStats(org, "prs");
      if (stats.pending > 0 || stats.failed > 0) {
        this.tasks.push({
          id: "backfill-chunk",
          type: "backfill-chunk",
          priority: 2,
          nextRunAt: new Date(Date.now() + 10_000),
          intervalMs: 5_000,
        });
      }
    }
  }

  private async resetFailedChunks(): Promise<void> {
    const config = await resolveGitHubConfig();
    await getSyncChunksCollection().updateMany(
      { org: config.org.toLowerCase(), status: "failed" },
      { $set: { status: "pending", attempt: 0 }, $unset: { error: 1 } } as any,
    );
    await writeSyncLog("info", "backfill", "Reset all failed chunks for retry");
  }
}

// Singleton instance
let instance: GitHubSyncService | null = null;

export function getGitHubSyncService(): GitHubSyncService {
  if (!instance) {
    instance = new GitHubSyncService();
  }
  return instance;
}
