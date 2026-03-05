/**
 * REST API routes for the GitHub Hub feature.
 * All routes are prefixed with /api/web/github by the router.
 */

import { type Request, type Response, Router } from "express";
import type {
  BackfillProgress,
  ContributionDataPoint,
  ContributionSummary,
  ContributionsResponse,
  GitHubPrDoc,
  GitHubScope,
  LeaderboardEntry,
  SyncLogCategory,
  SyncStatusResponse,
} from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import type { ServerConfig } from "../config.js";
import {
  getChunkStats,
  getContributionsCollection,
  getGitHubSettings,
  getGitHubSyncService,
  getOrgMembersCollection,
  getPrsCollection,
  getRateLimitBudget,
  getRecentSyncLogs,
  getSyncChunksCollection,
  getTeamsCollection,
  invalidateSettingsCache,
  resolveGitHubConfig,
  saveGitHubSettings,
  subscribeSyncLog,
} from "../githubSync/index.js";

const log = createLogger("server:api:github");

function qstr(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : String(v ?? "");
}

export function createGitHubRoutes(_config: ServerConfig): Router {
  const router = Router();

  // --- Pull Requests ---

  router.get("/prs", async (req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const scope = (qstr(req.query.scope) || config.defaultScope) as GitHubScope;
      const team = qstr(req.query.team) || config.teamSlug;
      const state = qstr(req.query.state) || "open";
      const author = qstr(req.query.author) || undefined;
      const repo = qstr(req.query.repo) || undefined;
      const sort = (qstr(req.query.sort) || "updated") as "updated" | "created";
      const limit = parseInt(qstr(req.query.limit), 10) || 50;
      const offset = parseInt(qstr(req.query.offset), 10) || 0;

      const org = config.org.toLowerCase();
      const filter: Record<string, unknown> = { org };

      // State filter
      if (state !== "all") {
        filter.state = state;
      }

      // Scope filter
      if (scope === "me") {
        const username = config.username?.toLowerCase();
        if (username) {
          filter.author = username;
        }
      } else if (scope === "team" && team) {
        // Get team members from org_members collection
        const members = await getOrgMembersCollection()
          .find({ org, teams: team })
          .project({ _id: 1 })
          .toArray();
        const logins = members.map((m) => m._id);
        if (logins.length > 0) {
          filter.author = { $in: logins };
        }
      }
      // scope === "org" → no author filter (show all)

      // Optional filters
      if (author) {
        filter.author = author.toLowerCase();
      }
      if (repo) {
        filter.repo = repo;
      }

      const sortField = sort === "created" ? "created_at" : "updated_at";

      const prs = await getPrsCollection()
        .find(filter as any)
        .sort({ [sortField]: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();

      const total = await getPrsCollection().countDocuments(filter as any);

      // Check chunk coverage
      const stats = await getChunkStats(org, "prs");
      const dataSource =
        stats.total > 0 && stats.completed === stats.total ? "cache" : "partial-cache";

      res.json({
        prs,
        total,
        data_source: dataSource,
        backfill_progress: {
          completed: stats.completed,
          total: stats.total,
          percentage: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0,
        },
      });
    } catch (err: unknown) {
      log.error("GitHub PRs error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Contributions ---

  router.get("/contributions", async (req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const scope = (qstr(req.query.scope) || config.defaultScope) as GitHubScope;
      const team = qstr(req.query.team) || config.teamSlug;
      const login = qstr(req.query.login) || undefined;
      const range = qstr(req.query.range) || config.contributionRange || "30d";
      const startStr = qstr(req.query.start) || undefined;
      const endStr = qstr(req.query.end) || undefined;
      const groupBy = (qstr(req.query.group_by) || "week") as "day" | "week" | "month";

      const org = config.org.toLowerCase();

      // Compute date range
      let startDate: Date;
      let endDate: Date = new Date();

      if (startStr && endStr) {
        startDate = new Date(startStr);
        endDate = new Date(endStr);
      } else {
        const days = parseDays(range);
        startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      }

      // Build match filter
      const matchFilter: Record<string, unknown> = {
        org,
        date: { $gte: startDate, $lte: endDate },
      };

      if (login) {
        matchFilter.login = login.toLowerCase();
      } else if (scope === "me") {
        const username = config.username?.toLowerCase();
        if (username) {
          matchFilter.login = username;
        }
      } else if (scope === "team" && team) {
        const members = await getOrgMembersCollection()
          .find({ org, teams: team })
          .project({ _id: 1 })
          .toArray();
        const logins = members.map((m) => m._id);
        if (logins.length > 0) {
          matchFilter.login = { $in: logins };
        }
      }

      const contribCol = getContributionsCollection();

      // Summary aggregation
      const summaryAgg = await contribCol
        .aggregate<ContributionSummary>([
          { $match: matchFilter },
          {
            $group: {
              _id: null,
              prs_opened: { $sum: "$prs_opened" },
              prs_merged: { $sum: "$prs_merged" },
              prs_closed: { $sum: "$prs_closed" },
              reviews_submitted: { $sum: "$reviews_submitted" },
              review_comments: { $sum: "$review_comments" },
              commits: { $sum: "$commits" },
              additions: { $sum: "$additions" },
              deletions: { $sum: "$deletions" },
              repos_touched: { $addToSet: "$repos_touched" },
            },
          },
        ])
        .toArray();

      const summary: ContributionSummary = summaryAgg[0] || {
        prs_opened: 0,
        prs_merged: 0,
        prs_closed: 0,
        reviews_submitted: 0,
        review_comments: 0,
        commits: 0,
        additions: 0,
        deletions: 0,
        repos_touched: [],
      };
      // Flatten nested arrays from $addToSet
      if (Array.isArray(summary.repos_touched?.[0])) {
        summary.repos_touched = [
          ...new Set((summary.repos_touched as unknown as string[][]).flat()),
        ] as string[];
      }

      // Data points aggregation (grouped by period)
      const dateFormat = groupBy === "day" ? "%Y-%m-%d" : groupBy === "month" ? "%Y-%m" : "%Y-%U"; // week = year-weeknum

      const dataPointsAgg = await contribCol
        .aggregate<ContributionDataPoint>([
          { $match: matchFilter },
          {
            $group: {
              _id: { $dateToString: { format: dateFormat, date: "$date" } },
              prs_merged: { $sum: "$prs_merged" },
              reviews_submitted: { $sum: "$reviews_submitted" },
              commits: { $sum: "$commits" },
              additions: { $sum: "$additions" },
              deletions: { $sum: "$deletions" },
            },
          },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              period: "$_id",
              prs_merged: 1,
              reviews_submitted: 1,
              commits: 1,
              additions: 1,
              deletions: 1,
            },
          },
        ])
        .toArray();

      // Leaderboard (only for team/org scope)
      const leaderboard: LeaderboardEntry[] = [];
      if (scope !== "me" && !login) {
        const leaderAgg = await contribCol
          .aggregate<LeaderboardEntry & { _id: string }>([
            { $match: matchFilter },
            {
              $group: {
                _id: "$login",
                prs_merged: { $sum: "$prs_merged" },
                reviews_submitted: { $sum: "$reviews_submitted" },
                additions: { $sum: "$additions" },
                deletions: { $sum: "$deletions" },
                repos_touched: { $addToSet: "$repos_touched" },
              },
            },
            { $sort: { prs_merged: -1 } },
            { $limit: 50 },
          ])
          .toArray();

        // Enrich with member info
        for (const entry of leaderAgg) {
          const member = await getOrgMembersCollection().findOne({
            _id: entry._id as any,
          });
          leaderboard.push({
            login: entry._id,
            avatar_url: member?.avatar_url,
            name: member?.name,
            prs_merged: entry.prs_merged,
            reviews_submitted: entry.reviews_submitted,
            additions: entry.additions,
            deletions: entry.deletions,
            repos_touched: [
              ...new Set((entry.repos_touched as unknown as string[][]).flat()),
            ] as string[],
          });
        }
      }

      const stats = await getChunkStats(org, "prs");
      const dataSource =
        stats.total > 0 && stats.completed === stats.total ? "cache" : "partial-cache";

      const response: ContributionsResponse = {
        summary,
        data_points: dataPointsAgg,
        leaderboard,
        data_source: dataSource as any,
      };

      res.json(response);
    } catch (err: unknown) {
      log.error("GitHub contributions error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Teams & Members ---

  router.get("/teams", async (_req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const teams = await getTeamsCollection()
        .find({ org: config.org.toLowerCase() })
        .sort({ name: 1 })
        .toArray();
      res.json({ teams });
    } catch (err: unknown) {
      log.error("GitHub teams error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  router.get("/teams/:slug/members", async (req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const slug = req.params.slug;
      const members = await getOrgMembersCollection()
        .find({ org: config.org.toLowerCase(), teams: slug })
        .sort({ login: 1 })
        .toArray();
      res.json({ members });
    } catch (err: unknown) {
      log.error("GitHub team members error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  router.get("/members", async (_req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const members = await getOrgMembersCollection()
        .find({ org: config.org.toLowerCase() })
        .sort({ login: 1 })
        .toArray();
      res.json({ members });
    } catch (err: unknown) {
      log.error("GitHub members error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Sync Status ---

  router.get("/sync-status", async (_req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const org = config.org.toLowerCase();
      const budget = getRateLimitBudget();
      const syncService = getGitHubSyncService();
      const serviceStatus = await syncService.getStatus();

      // Backfill progress
      const stats = await getChunkStats(org, "prs");
      const chunks = await getSyncChunksCollection()
        .find({ org, data_type: "prs" })
        .sort({ chunk_start: 1 })
        .toArray();

      const inProgressChunk = chunks.find((c) => c.status === "in_progress");
      const completedChunks = chunks.filter((c) => c.status === "complete");

      const backfill: BackfillProgress = {
        total_chunks: stats.total,
        completed_chunks: stats.completed,
        in_progress_chunk: inProgressChunk?._id,
        failed_chunks: stats.failed,
        prs_total: stats.total_items,
        oldest_data_available:
          completedChunks.length > 0 ? completedChunks[0].chunk_start.toISOString() : undefined,
        newest_data_available:
          completedChunks.length > 0
            ? completedChunks[completedChunks.length - 1].chunk_end.toISOString()
            : undefined,
      };

      // Rate limits
      const rateLimitStatus = budget.getStatus();

      // Find hot/warm task info
      const hotTask = serviceStatus.tasks.find((t) => t.type === "hot-prs");
      const warmTask = serviceStatus.tasks.find((t) => t.type === "org-sync");

      const response: SyncStatusResponse = {
        enabled: serviceStatus.enabled,
        backfill,
        rate_limit: rateLimitStatus,
        hot_sync: {
          last_run_at: hotTask?.lastRunAt,
          next_run_at: hotTask?.nextRunAt,
          interval_seconds: config.hotIntervalSeconds,
        },
        warm_sync: {
          last_run_at: warmTask?.lastRunAt,
          next_run_at: warmTask?.nextRunAt,
          interval_seconds: config.warmIntervalSeconds,
        },
      };

      res.json(response);
    } catch (err: unknown) {
      log.error("GitHub sync status error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Sync Log ---

  router.get("/sync-log", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(qstr(req.query.limit), 10) || 100;
      const since = qstr(req.query.since) ? new Date(qstr(req.query.since)) : undefined;
      const category = qstr(req.query.category) as SyncLogCategory | undefined;

      const entries = await getRecentSyncLogs({
        limit,
        since,
        category: category || undefined,
      });

      res.json({ entries });
    } catch (err: unknown) {
      log.error("GitHub sync log error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Sync Log SSE Stream ---

  router.get("/sync-log/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const unsubscribe = subscribeSyncLog((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    // Heartbeat to prevent proxy/LB idle-timeout disconnects
    const heartbeat = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- Sync Chunks (for timeline visualization) ---

  router.get("/sync-chunks", async (_req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const chunks = await getSyncChunksCollection()
        .find({ org: config.org.toLowerCase(), data_type: "prs" })
        .sort({ chunk_start: 1 })
        .toArray();

      res.json({
        chunks: chunks.map((c) => ({
          id: c._id,
          start: c.chunk_start.toISOString().split("T")[0],
          end: c.chunk_end.toISOString().split("T")[0],
          status: c.status,
          total_items: c.total_items,
          attempt: c.attempt,
          error: c.error,
          completed_at: c.completed_at?.toISOString(),
        })),
      });
    } catch (err: unknown) {
      log.error("GitHub sync chunks error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Manual Triggers ---

  router.post("/sync/trigger", async (req: Request, res: Response) => {
    try {
      const scope = req.body?.scope as string;
      const syncService = getGitHubSyncService();

      switch (scope) {
        case "prs":
          await syncService.triggerTask("hot-prs");
          break;
        case "teams":
          await syncService.triggerTask("org-sync");
          break;
        case "contributions":
          await syncService.triggerTask("contributions");
          break;
        case "backfill":
          await syncService.triggerTask("backfill-chunk");
          break;
        default:
          res.status(400).json({ error: `Unknown scope: ${scope}` });
          return;
      }

      res.json({ ok: true, triggered: scope });
    } catch (err: unknown) {
      log.error("GitHub sync trigger error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Settings ---

  router.get("/settings", async (_req: Request, res: Response) => {
    try {
      const config = await resolveGitHubConfig();
      const dbSettings = await getGitHubSettings();

      // Validate token (check if it works)
      let tokenValid = false;
      let tokenScopes: string[] = [];
      if (config.token) {
        try {
          const { getOctokit } = await import("../githubSync/octokitClient.js");
          const octokit = getOctokit(config.token);
          const resp = await octokit.users.getAuthenticated();
          tokenValid = true;
          tokenScopes = (resp.headers["x-oauth-scopes"] || "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          // Auto-detect username if not set
          if (!config.username && resp.data.login) {
            config.username = resp.data.login;
          }
        } catch {
          tokenValid = false;
        }
      }

      res.json({
        resolved: {
          org: config.org,
          team_slug: config.teamSlug,
          username: config.username,
          history_days: config.historyDays,
          default_scope: config.defaultScope,
          pinned_repos: config.pinnedRepos,
          contribution_range: config.contributionRange,
          sync_enabled: config.syncEnabled,
          hot_interval_seconds: config.hotIntervalSeconds,
          warm_interval_seconds: config.warmIntervalSeconds,
        },
        db_overrides: dbSettings,
        token: {
          configured: !!config.token,
          valid: tokenValid,
          scopes: tokenScopes,
        },
      });
    } catch (err: unknown) {
      log.error("GitHub settings error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  router.post("/settings", async (req: Request, res: Response) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") {
        res.status(400).json({ error: "Invalid settings" });
        return;
      }

      // Only allow known fields
      const allowed: Record<string, boolean> = {
        org: true,
        team_slug: true,
        username: true,
        history_days: true,
        default_scope: true,
        pinned_repos: true,
        contribution_range: true,
        sync_enabled: true,
      };

      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (allowed[key]) {
          filtered[key] = value;
        }
      }

      await saveGitHubSettings(filtered as any);
      invalidateSettingsCache();

      res.json({ ok: true });
    } catch (err: unknown) {
      log.error("Save GitHub settings error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}

function parseDays(range: string): number {
  const match = range.match(/^(\d+)(d|m|y)$/);
  if (!match) return 30;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case "d":
      return val;
    case "m":
      return val * 30;
    case "y":
      return val * 365;
    default:
      return 30;
  }
}
