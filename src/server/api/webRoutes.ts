import { readFileSync, writeFileSync } from "node:fs";
import { type Request, type Response, Router } from "express";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "../../shared/logger.js";
import type { ServerConfig } from "../config.js";
import { CreateJobFromWebSchema, CreateRespondToCommentsFromWebSchema } from "../jobs/jobModel.js";
import * as jobService from "../jobs/jobService.js";
import { resolveSlackUser } from "../slack/userResolver.js";
import { fetchBatchPrStats, listPrs } from "./ghPrs.js";

const log = createLogger("server:api:web");

function qstr(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : String(v ?? "");
}
function pstr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export function createWebRoutes(config: ServerConfig): Router {
  const router = Router();

  // GET /api/web/jobs
  router.get("/jobs", async (req: Request, res: Response) => {
    try {
      const { jobs, total } = await jobService.queryJobs({
        status: qstr(req.query.status) || undefined,
        requested_by: qstr(req.query.requested_by) || undefined,
        q: qstr(req.query.q) || undefined,
        limit: parseInt(qstr(req.query.limit), 10) || 50,
        offset: parseInt(qstr(req.query.offset), 10) || 0,
        sort_by: qstr(req.query.sort_by) || undefined,
        sort_order: qstr(req.query.sort_order) as "asc" | "desc" | undefined,
      });
      res.json({ jobs, total });
    } catch (err: any) {
      log.error("List jobs error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/jobs/:task_id
  router.get("/jobs/:task_id", async (req: Request, res: Response) => {
    try {
      const job = await jobService.findJobByTaskId(pstr(req.params.task_id));
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json({ job });
    } catch (err: any) {
      log.error("Get job error", { error: err.message, task_id: pstr(req.params.task_id) });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/jobs
  router.post("/jobs", async (req: Request, res: Response) => {
    try {
      const parsed = CreateJobFromWebSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const job = await jobService.createJobFromWeb(parsed.data);
      res.status(201).json({ job });
    } catch (err: any) {
      log.error("Create job error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/jobs/respond-to-comments
  router.post("/jobs/respond-to-comments", async (req: Request, res: Response) => {
    try {
      const parsed = CreateRespondToCommentsFromWebSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const job = await jobService.createRespondToCommentsJob(parsed.data);
      res.status(201).json({ job });
    } catch (err: any) {
      log.error("Create respond-to-comments job error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/jobs/:task_id/respond-to-comments (from existing job)
  router.post("/jobs/:task_id/respond-to-comments", async (req: Request, res: Response) => {
    try {
      const taskId = pstr(req.params.task_id);
      const existing = await jobService.findJobByTaskId(taskId);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (!existing.pr_urls?.length) {
        res.status(400).json({ error: "No PR URL found on job" });
        return;
      }
      const job = await jobService.createRespondToCommentsJob({
        requested_by: existing.requested_by,
        pr_url: existing.pr_urls[0],
        parent_task_id: taskId,
      });
      res.status(201).json({ job });
    } catch (err: any) {
      log.error("Create respond-to-comments from job error", {
        error: err.message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/jobs/:task_id/cancel
  router.post("/jobs/:task_id/cancel", async (req: Request, res: Response) => {
    try {
      const job = await jobService.cancel(pstr(req.params.task_id));
      if (!job) {
        res.status(409).json({ error: "Cannot cancel: job is terminal or not found" });
        return;
      }
      res.json({ job });
    } catch (err: any) {
      log.error("Cancel job error", { error: err.message, task_id: pstr(req.params.task_id) });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/jobs/:task_id/promote-pr
  router.post("/jobs/:task_id/promote-pr", async (req: Request, res: Response) => {
    try {
      const taskId = pstr(req.params.task_id);
      const reviewers: string[] | undefined = req.body?.reviewers;

      // Look up job to get PR URL
      const existing = await jobService.findJobByTaskId(taskId);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (existing.status !== "WAITING_FOR_APPROVAL") {
        res.status(409).json({ error: "Job is not waiting for approval" });
        return;
      }
      if (!existing.pr_urls?.length) {
        res.status(400).json({ error: "No PR URL found on job" });
        return;
      }

      // Run gh pr ready + add reviewers
      const { promotePr: ghPromotePr } = await import("../../worker/executor/pr.js");
      ghPromotePr(existing.pr_urls[0], reviewers);

      // Transition job WAITING_FOR_APPROVAL → DONE
      const job = await jobService.promotePr(taskId, reviewers);
      if (!job) {
        res.status(409).json({ error: "Promote failed" });
        return;
      }
      res.json({ job });
    } catch (err: any) {
      log.error("Promote PR error", { error: err.message, task_id: pstr(req.params.task_id) });
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  // POST /api/web/jobs/:task_id/retry
  router.post("/jobs/:task_id/retry", async (req: Request, res: Response) => {
    try {
      const job = await jobService.retry(pstr(req.params.task_id));
      if (!job) {
        res.status(409).json({ error: "Cannot retry: job not FAILED/CANCELED or not found" });
        return;
      }
      res.status(201).json({ job });
    } catch (err: any) {
      log.error("Retry job error", { error: err.message, task_id: pstr(req.params.task_id) });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // DELETE /api/web/jobs/:task_id
  router.delete("/jobs/:task_id", async (req: Request, res: Response) => {
    try {
      const job = await jobService.softDelete(pstr(req.params.task_id));
      if (!job) {
        res.status(409).json({ error: "Cannot delete: job is RUNNING or not found" });
        return;
      }
      res.json({ job });
    } catch (err: any) {
      log.error("Delete job error", { error: err.message, task_id: pstr(req.params.task_id) });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/prs — list PRs across registered repos with comment stats
  router.get("/prs", async (req: Request, res: Response) => {
    try {
      if (!config.repoRegistryPath) {
        res.status(501).json({ error: "SOS_REPO_REGISTRY not configured on server" });
        return;
      }
      const state = (qstr(req.query.state) || "open") as "open" | "closed" | "merged" | "all";
      const limit = parseInt(qstr(req.query.limit), 10) || 20;
      const includeComments = qstr(req.query.include_comments) !== "false";
      const repoFilter = qstr(req.query.repo) || undefined;

      const prs = listPrs({
        registryPath: config.repoRegistryPath,
        state,
        limit,
        includeComments,
        repoFilter,
      });

      // Cross-link with jobs: find jobs whose pr_urls match any of these PRs
      const prUrls = prs.map((p) => p.url);
      if (prUrls.length > 0) {
        try {
          const { jobs } = await jobService.queryJobs({ limit: 200, offset: 0 });
          const urlToTaskId = new Map<string, string>();
          for (const job of jobs) {
            for (const url of job.pr_urls || []) {
              if (!urlToTaskId.has(url)) {
                urlToTaskId.set(url, job.task_id);
              }
            }
          }
          for (const pr of prs) {
            pr.linkedJobTaskId = urlToTaskId.get(pr.url);
          }
        } catch (linkErr: any) {
          log.warn("Failed to cross-link PRs with jobs", { error: linkErr.message });
        }
      }

      res.json({ prs });
    } catch (err: any) {
      log.error("List PRs error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/prs/stats — batch fetch comment stats for specific PR URLs
  router.post("/prs/stats", async (req: Request, res: Response) => {
    try {
      const urls: string[] = req.body?.urls || [];
      if (urls.length === 0) {
        res.json({ stats: {} });
        return;
      }
      // Cap at 20 to avoid abuse
      const capped = urls.slice(0, 20);
      const stats = fetchBatchPrStats(capped);
      res.json({ stats });
    } catch (err: any) {
      log.error("Batch PR stats error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/users
  router.get("/users", async (_req: Request, res: Response) => {
    try {
      const users = await jobService.getDistinctRequestedBy();
      res.json({ users });
    } catch (err: any) {
      log.error("Get users error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/slack/user/:user_id — resolve a Slack user ID to display name
  router.get("/slack/user/:user_id", async (req: Request, res: Response) => {
    try {
      const user = await resolveSlackUser(pstr(req.params.user_id));
      res.json({ user });
    } catch (err: any) {
      log.error("Resolve Slack user error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/slack/users — batch resolve Slack user IDs
  router.post("/slack/users", async (req: Request, res: Response) => {
    try {
      const ids: string[] = req.body?.user_ids || [];
      const results: Record<string, any> = {};
      await Promise.all(
        ids.map(async (id) => {
          results[id] = await resolveSlackUser(id);
        }),
      );
      res.json({ users: results });
    } catch (err: any) {
      log.error("Batch resolve Slack users error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/registry — read repo-registry.yaml as JSON
  router.get("/registry", async (_req: Request, res: Response) => {
    try {
      if (!config.repoRegistryPath) {
        res.status(501).json({ error: "SOS_REPO_REGISTRY not configured on server" });
        return;
      }
      const raw = readFileSync(config.repoRegistryPath, "utf-8");
      const data = parseYaml(raw);
      res.json({ registry: data, path: config.repoRegistryPath });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.json({ registry: { repos: {} }, path: config.repoRegistryPath });
        return;
      }
      log.error("Read registry error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/web/registry — write JSON back as repo-registry.yaml
  router.put("/registry", async (req: Request, res: Response) => {
    try {
      if (!config.repoRegistryPath) {
        res.status(501).json({ error: "SOS_REPO_REGISTRY not configured on server" });
        return;
      }
      const data = req.body?.registry;
      if (!data || typeof data !== "object") {
        res.status(400).json({ error: "Missing or invalid registry object in body" });
        return;
      }
      const yaml = stringifyYaml(data, { lineWidth: 120 });
      writeFileSync(config.repoRegistryPath, yaml, "utf-8");
      log.info("Registry saved", { path: config.repoRegistryPath });
      res.json({ ok: true });
    } catch (err: any) {
      log.error("Write registry error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
