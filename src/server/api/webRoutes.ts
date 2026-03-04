import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Request, type Response, Router } from "express";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "../../shared/logger.js";
import {
  getModelConfigPath,
  getModelConfigRaw,
  getModelRegistry,
  reloadModelConfig,
  saveModelConfig,
} from "../../shared/modelConfig.js";
import type { ServerConfig } from "../config.js";
import {
  CreateAddReviewCommentsSchema,
  CreateJobFromWebSchema,
  CreateRespondToCommentsFromWebSchema,
  CreateSelfReviewPrSchema,
} from "../jobs/jobModel.js";
import * as jobService from "../jobs/jobService.js";
import {
  getRoutingConfigPath,
  getRoutingConfigRaw,
  reloadRoutingConfig,
  saveRoutingConfig,
} from "../routing/index.js";
import { resolveSlackUser } from "../slack/userResolver.js";
import { spawnWorkerProcess } from "../workers/spawnWorker.js";
import {
  deregisterWorker,
  getLogHistory,
  getWorker,
  listWorkers,
  sendWorkerCommand,
  subscribeToLogs,
} from "../workers/workerRegistry.js";
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
    } catch (err: unknown) {
      log.error("List jobs error", { error: (err as Error).message });
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
    } catch (err: unknown) {
      log.error("Get job error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
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
    } catch (err: unknown) {
      log.error("Create job error", { error: (err as Error).message });
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
    } catch (err: unknown) {
      log.error("Create respond-to-comments job error", { error: (err as Error).message });
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
    } catch (err: unknown) {
      log.error("Create respond-to-comments from job error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/jobs/self-review-pr
  router.post("/jobs/self-review-pr", async (req: Request, res: Response) => {
    try {
      const parsed = CreateSelfReviewPrSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const job = await jobService.createSelfReviewPrJob(parsed.data);
      res.status(201).json({ job });
    } catch (err: unknown) {
      log.error("Create self-review-pr job error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/jobs/add-review-comments
  router.post("/jobs/add-review-comments", async (req: Request, res: Response) => {
    try {
      const parsed = CreateAddReviewCommentsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const job = await jobService.createAddReviewCommentsJob(parsed.data);
      res.status(201).json({ job });
    } catch (err: unknown) {
      log.error("Create add-review-comments job error", { error: (err as Error).message });
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
    } catch (err: unknown) {
      log.error("Cancel job error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
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
    } catch (err: unknown) {
      log.error("Promote PR error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: (err as Error).message || "Internal error" });
    }
  });

  // POST /api/web/jobs/:task_id/confirm-plan
  router.post("/jobs/:task_id/confirm-plan", async (req: Request, res: Response) => {
    try {
      const taskId = pstr(req.params.task_id);
      const existing = await jobService.findJobByTaskId(taskId);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (existing.status !== "PENDING_CONFIRMATION") {
        res.status(409).json({ error: "Job is not awaiting plan confirmation" });
        return;
      }
      const revisedTaskText: string | undefined = req.body?.revised_task_text;
      const job = await jobService.confirmJob(taskId, revisedTaskText);
      if (!job) {
        res.status(409).json({ error: "Confirm failed" });
        return;
      }
      res.json({ job });
    } catch (err: unknown) {
      log.error("Confirm plan error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
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
    } catch (err: unknown) {
      log.error("Retry job error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
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
    } catch (err: unknown) {
      log.error("Delete job error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
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

      const prs = await listPrs({
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
          // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
        } catch (linkErr: any) {
          log.warn("Failed to cross-link PRs with jobs", { error: linkErr.message });
        }
      }

      res.json({ prs });
    } catch (err: unknown) {
      log.error("List PRs error", { error: (err as Error).message });
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
      const stats = await fetchBatchPrStats(capped);
      res.json({ stats });
    } catch (err: unknown) {
      log.error("Batch PR stats error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/identity — canonical job owner ID from server config
  router.get("/identity", (_req: Request, res: Response) => {
    res.json({ jobOwner: config.slackJobOwner });
  });

  // GET /api/web/users
  router.get("/users", async (_req: Request, res: Response) => {
    try {
      const users = await jobService.getDistinctRequestedBy();
      res.json({ users });
    } catch (err: unknown) {
      log.error("Get users error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/slack/user/:user_id — resolve a Slack user ID to display name
  router.get("/slack/user/:user_id", async (req: Request, res: Response) => {
    try {
      const user = await resolveSlackUser(pstr(req.params.user_id));
      res.json({ user });
    } catch (err: unknown) {
      log.error("Resolve Slack user error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/slack/users — batch resolve Slack user IDs
  router.post("/slack/users", async (req: Request, res: Response) => {
    try {
      const ids: string[] = req.body?.user_ids || [];
      // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
      const results: Record<string, any> = {};
      await Promise.all(
        ids.map(async (id) => {
          results[id] = await resolveSlackUser(id);
        }),
      );
      res.json({ users: results });
    } catch (err: unknown) {
      log.error("Batch resolve Slack users error", { error: (err as Error).message });
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
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "ENOENT") {
        res.json({ registry: { repos: {} }, path: config.repoRegistryPath });
        return;
      }
      log.error("Read registry error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
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
    } catch (err: unknown) {
      log.error("Write registry error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/web/worktrees — scan worktree directories and lockfiles for status
  router.get("/worktrees", async (_req: Request, res: Response) => {
    try {
      if (!config.workspaceRoot) {
        res.json({ worktrees: {} });
        return;
      }
      const worktreeDir = path.join(config.workspaceRoot, "worktrees");
      if (!existsSync(worktreeDir)) {
        res.json({ worktrees: {} });
        return;
      }

      const entries = readdirSync(worktreeDir, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );

      // Group by repo: { repoId -> [ { slotName, inUse, taskId, acquiredAt } ] }
      const worktrees: Record<
        string,
        Array<{ slotName: string; inUse: boolean; taskId?: string; acquiredAt?: string }>
      > = {};

      for (const entry of entries) {
        // Slot names follow pattern: {repoId}-n-{N}
        const match = entry.name.match(/^(.+)-n-(\d+)$/);
        if (!match) continue;

        const repoId = match[1];
        const slotName = entry.name;

        let inUse = false;
        let taskId: string | undefined;
        let acquiredAt: string | undefined;

        const lockPath = path.join(worktreeDir, entry.name, ".sos-lock");
        if (existsSync(lockPath)) {
          try {
            const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
            // Check if the PID is still alive
            try {
              process.kill(lock.pid, 0);
              inUse = true;
              taskId = lock.taskId;
              acquiredAt = lock.acquiredAt;
              // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
            } catch (pidErr: any) {
              if (pidErr.code === "EPERM") {
                inUse = true;
                taskId = lock.taskId;
                acquiredAt = lock.acquiredAt;
              }
              // ESRCH = process dead, stale lock
            }
          } catch {
            /* corrupt lockfile */
          }
        }

        if (!worktrees[repoId]) worktrees[repoId] = [];
        worktrees[repoId].push({ slotName, inUse, taskId, acquiredAt });
      }

      // Sort slots within each repo
      for (const slots of Object.values(worktrees)) {
        slots.sort((a, b) => a.slotName.localeCompare(b.slotName));
      }

      res.json({ worktrees });
    } catch (err: unknown) {
      log.error("Get worktrees error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- Worker Management ---

  // GET /api/web/workers
  router.get("/workers", (_req: Request, res: Response) => {
    res.json({ workers: listWorkers() });
  });

  // GET /api/web/workers/:id
  router.get("/workers/:id", (req: Request, res: Response) => {
    const worker = getWorker(pstr(req.params.id));
    if (!worker) {
      res.status(404).json({ error: "Worker not found" });
      return;
    }
    res.json({ worker });
  });

  // POST /api/web/workers/spawn
  router.post("/workers/spawn", (_req: Request, res: Response) => {
    try {
      const pid = spawnWorkerProcess();
      res.json({ ok: true, pid });
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as Error).message : String(err);
      log.error("Failed to spawn worker", { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/web/workers/:id/shutdown
  router.post("/workers/:id/shutdown", (req: Request, res: Response) => {
    const workerId = pstr(req.params.id);
    const worker = getWorker(workerId);
    if (!worker) {
      res.status(404).json({ error: "Worker not found" });
      return;
    }

    // Try graceful WS command first
    const sent = sendWorkerCommand(workerId, { command: "shutdown" });
    if (sent) {
      res.json({ ok: true, method: "ws_command" });
      return;
    }

    // Fallback: SIGTERM via PID (local machine)
    try {
      process.kill(worker.pid, "SIGTERM");
      log.info("Sent SIGTERM to worker", { worker_id: workerId, pid: worker.pid });
      res.json({ ok: true, method: "sigterm" });
    } catch (err: unknown) {
      log.warn("Failed to kill worker process", {
        worker_id: workerId,
        pid: worker.pid,
        error: (err as Error).message,
      });
      res
        .status(500)
        .json({ error: `Failed to signal PID ${worker.pid}: ${(err as Error).message}` });
    }
  });

  // DELETE /api/web/workers/:id — remove stale worker entry
  router.delete("/workers/:id", (req: Request, res: Response) => {
    deregisterWorker(pstr(req.params.id));
    res.json({ ok: true });
  });

  // GET /api/web/workers/:id/logs — SSE stream of log lines
  router.get("/workers/:id/logs", (req: Request, res: Response) => {
    const workerId = pstr(req.params.id);
    const worker = getWorker(workerId);
    if (!worker) {
      res.status(404).json({ error: "Worker not found" });
      return;
    }

    const loopParam = qstr(req.query.loop);
    const loopIndex = loopParam ? parseInt(loopParam, 10) : undefined;

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send history first
    const history = getLogHistory(workerId, loopIndex);
    for (const line of history) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    }

    // Subscribe to live updates
    const unsubscribe = subscribeToLogs(workerId, (line) => {
      if (!line.ts) {
        // Sentinel — worker deregistered
        res.write("event: close\ndata: {}\n\n");
        res.end();
        return;
      }
      if (loopIndex != null && line.loop_index !== loopIndex) return;
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    });

    req.on("close", () => {
      unsubscribe();
    });
  });

  // --- Model Registry ---

  // GET /api/web/models — active model assignments across all roles
  router.get("/models", (_req: Request, res: Response) => {
    const registry = getModelRegistry();
    res.json({ models: registry });
  });

  // --- Model Config (YAML file overrides) ---

  // GET /api/web/model-config — read model-config.yaml overrides + resolved registry
  router.get("/model-config", (_req: Request, res: Response) => {
    try {
      const configPath = getModelConfigPath();
      const registry = getModelRegistry();
      const overrides = getModelConfigRaw();
      res.json({ models: registry, overrides, path: configPath || "" });
    } catch (err: unknown) {
      log.error("Read model config error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/web/model-config — write overrides to model-config.yaml
  router.put("/model-config", (req: Request, res: Response) => {
    try {
      const configPath = getModelConfigPath();
      if (!configPath) {
        res.status(501).json({ error: "Model config not initialized" });
        return;
      }
      const overrides = req.body?.overrides;
      if (!overrides || typeof overrides !== "object") {
        res.status(400).json({ error: "Missing or invalid overrides object in body" });
        return;
      }
      saveModelConfig(overrides);
      const registry = getModelRegistry();
      res.json({ ok: true, models: registry });
    } catch (err: unknown) {
      log.error("Write model config error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/web/model-config/reload — force reload from disk
  router.post("/model-config/reload", (_req: Request, res: Response) => {
    try {
      reloadModelConfig();
      const registry = getModelRegistry();
      res.json({ ok: true, models: registry });
    } catch (err: unknown) {
      log.error("Reload model config error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Routing Config ---

  // GET /api/web/routing-config — read routing-config.yaml as JSON
  router.get("/routing-config", async (_req: Request, res: Response) => {
    try {
      const configPath = getRoutingConfigPath();
      if (!configPath) {
        res.status(501).json({ error: "Routing config not initialized" });
        return;
      }
      const data = getRoutingConfigRaw();
      res.json({ config: data, path: configPath });
    } catch (err: unknown) {
      log.error("Read routing config error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/web/routing-config — write JSON back as routing-config.yaml
  router.put("/routing-config", async (req: Request, res: Response) => {
    try {
      const configPath = getRoutingConfigPath();
      if (!configPath) {
        res.status(501).json({ error: "Routing config not initialized" });
        return;
      }
      const data = req.body?.config;
      if (!data || typeof data !== "object") {
        res.status(400).json({ error: "Missing or invalid config object in body" });
        return;
      }
      saveRoutingConfig(data);
      res.json({ ok: true });
    } catch (err: unknown) {
      log.error("Write routing config error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/web/routing-config/reload — force reload from disk
  router.post("/routing-config/reload", async (_req: Request, res: Response) => {
    try {
      reloadRoutingConfig();
      res.json({ ok: true });
    } catch (err: unknown) {
      log.error("Reload routing config error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
