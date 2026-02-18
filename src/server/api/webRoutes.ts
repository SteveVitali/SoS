import { Router, Request, Response } from "express";
import { createLogger } from "../../shared/logger.js";
import { CreateJobFromWebSchema } from "../jobs/jobModel.js";
import * as jobService from "../jobs/jobService.js";

const log = createLogger("server:api:web");

function qstr(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : String(v ?? "");
}
function pstr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export function createWebRoutes(): Router {
  const router = Router();

  // GET /api/web/jobs
  router.get("/jobs", async (req: Request, res: Response) => {
    try {
      const { jobs, total } = await jobService.queryJobs({
        status: qstr(req.query.status) || undefined,
        requested_by: qstr(req.query.requested_by) || undefined,
        q: qstr(req.query.q) || undefined,
        limit: parseInt(qstr(req.query.limit)) || 50,
        offset: parseInt(qstr(req.query.offset)) || 0,
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

  return router;
}
