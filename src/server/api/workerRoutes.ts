import { type Request, type Response, Router } from "express";
import { createLogger } from "../../shared/logger.js";
import {
  ClaimJobSchema,
  CompleteJobSchema,
  FailJobSchema,
  HeartbeatSchema,
  SubmitPlanSchema,
  WorkerEventSchema,
} from "../jobs/jobModel.js";
import * as jobService from "../jobs/jobService.js";
import type { SlackPoster } from "../slack/slackClient.js";
import { deregisterWorker, registerWorker, updateWorkerStatus } from "../workers/workerRegistry.js";

const log = createLogger("server:api:worker");

function qstr(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : String(v ?? "");
}
function pstr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export function createWorkerRoutes(slackPoster?: SlackPoster): Router {
  const router = Router();

  // POST /api/worker/register
  router.post("/register", (req: Request, res: Response) => {
    try {
      const { worker_id, hostname, pid, version } = req.body;
      if (!worker_id || !hostname || !pid) {
        res.status(400).json({ error: "worker_id, hostname, pid required" });
        return;
      }
      const info = registerWorker({
        worker_id,
        hostname,
        pid,
        version,
      });
      res.json({ worker: info });
    } catch (err: unknown) {
      log.error("Register error", {
        error: err instanceof Error ? (err as Error).message : String(err),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/status
  router.post("/status", (req: Request, res: Response) => {
    try {
      const { worker_id, loops } = req.body;
      if (!worker_id || !loops) {
        res.status(400).json({ error: "worker_id and loops required" });
        return;
      }
      const ok = updateWorkerStatus(worker_id, loops);
      if (!ok) {
        res.status(404).json({ error: "Worker not registered" });
        return;
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      log.error("Status update error", {
        error: err instanceof Error ? (err as Error).message : String(err),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/deregister
  router.post("/deregister", (req: Request, res: Response) => {
    try {
      const { worker_id } = req.body;
      if (!worker_id) {
        res.status(400).json({ error: "worker_id required" });
        return;
      }
      deregisterWorker(worker_id);
      res.json({ ok: true });
    } catch (err: unknown) {
      log.error("Deregister error", {
        error: err instanceof Error ? (err as Error).message : String(err),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/worker/jobs/poll?requested_by=...&limit=10
  router.get("/jobs/poll", async (req: Request, res: Response) => {
    try {
      const requestedBy = qstr(req.query.requested_by);
      if (!requestedBy) {
        res.status(400).json({ error: "requested_by query param required" });
        return;
      }
      const limit = Math.min(parseInt(qstr(req.query.limit), 10) || 10, 50);
      const jobs = await jobService.pollJobs(requestedBy, limit);
      res.json({ jobs });
    } catch (err: unknown) {
      log.error("Poll error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/worker/jobs/:task_id/status
  router.get("/jobs/:task_id/status", async (req: Request, res: Response) => {
    try {
      const job = await jobService.findJobByTaskId(pstr(req.params.task_id));
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json({ status: job.status });
    } catch (err: unknown) {
      log.error("Status check error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/claim
  router.post("/jobs/:task_id/claim", async (req: Request, res: Response) => {
    try {
      const parsed = ClaimJobSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const { requested_by, node_id, lease_seconds } = parsed.data;
      const job = await jobService.claim(
        pstr(req.params.task_id),
        requested_by,
        node_id,
        lease_seconds,
      );
      if (!job) {
        res.status(409).json({ error: "Claim failed: job not eligible or already claimed" });
        return;
      }
      res.json({ job });
    } catch (err: unknown) {
      log.error("Claim error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/heartbeat
  router.post("/jobs/:task_id/heartbeat", async (req: Request, res: Response) => {
    try {
      const parsed = HeartbeatSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const { node_id, extend_seconds } = parsed.data;
      const job = await jobService.heartbeat(pstr(req.params.task_id), node_id, extend_seconds);
      if (!job) {
        res.status(409).json({ error: "Heartbeat rejected: not owner or not active" });
        return;
      }
      res.json({ ok: true, lease_expires_at: job.lease_expires_at });
    } catch (err: unknown) {
      log.error("Heartbeat error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/events
  router.post("/jobs/:task_id/events", async (req: Request, res: Response) => {
    try {
      const parsed = WorkerEventSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const { node_id, type, payload } = parsed.data;
      await jobService.handleWorkerEvent(pstr(req.params.task_id), node_id, type, payload);
      res.json({ ok: true });
    } catch (err: unknown) {
      log.error("Event error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/await-approval
  router.post("/jobs/:task_id/await-approval", async (req: Request, res: Response) => {
    try {
      const parsed = CompleteJobSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const { node_id, result_summary, pr_urls, ci, metrics } = parsed.data;
      const job = await jobService.awaitApproval(pstr(req.params.task_id), node_id, {
        result_summary,
        pr_urls,
        ci,
        metrics,
      });
      if (!job) {
        res.status(409).json({ error: "Await approval failed: not owner or not active" });
        return;
      }
      res.json({ job });
    } catch (err: unknown) {
      log.error("Await approval error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/submit-plan
  router.post("/jobs/:task_id/submit-plan", async (req: Request, res: Response) => {
    try {
      const parsed = SubmitPlanSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const { node_id, plan_summary, metrics } = parsed.data;
      const job = await jobService.submitPlan(
        pstr(req.params.task_id),
        node_id,
        plan_summary,
        metrics,
      );
      if (!job) {
        res.status(409).json({ error: "Submit plan failed: not owner or not in PLANNING status" });
        return;
      }
      res.json({ job });
    } catch (err: unknown) {
      log.error("Submit plan error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/complete
  router.post("/jobs/:task_id/complete", async (req: Request, res: Response) => {
    try {
      const parsed = CompleteJobSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const { node_id, result_summary, pr_urls, ci, metrics } = parsed.data;
      const job = await jobService.complete(pstr(req.params.task_id), node_id, {
        result_summary,
        pr_urls,
        ci,
        metrics,
      });
      if (!job) {
        res.status(409).json({ error: "Complete failed: not owner or not active" });
        return;
      }
      res.json({ job });
    } catch (err: unknown) {
      log.error("Complete error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/requeue
  router.post("/jobs/:task_id/requeue", async (req: Request, res: Response) => {
    try {
      const nodeId = req.body?.node_id;
      const reason = req.body?.reason || "no_worktree_slot";
      if (!nodeId) {
        res.status(400).json({ error: "node_id required" });
        return;
      }
      const job = await jobService.requeue(pstr(req.params.task_id), nodeId, reason);
      if (!job) {
        res.status(409).json({ error: "Requeue failed: not owner or not active" });
        return;
      }
      res.json({ job });
    } catch (err: unknown) {
      log.error("Requeue error", {
        error: (err as Error).message,
        task_id: pstr(req.params.task_id),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/worker/jobs/:task_id/fail
  router.post("/jobs/:task_id/fail", async (req: Request, res: Response) => {
    try {
      const parsed = FailJobSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
        return;
      }
      const { node_id, error, pr_urls, ci, metrics } = parsed.data;
      const job = await jobService.fail(pstr(req.params.task_id), node_id, {
        error,
        pr_urls,
        ci,
        metrics,
      });
      if (!job) {
        res.status(409).json({ error: "Fail update failed: not owner or not active" });
        return;
      }
      res.json({ job });
    } catch (err: unknown) {
      log.error("Fail error", { error: (err as Error).message, task_id: pstr(req.params.task_id) });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/worker/slack/thread?channel_id=...&thread_ts=...
  if (slackPoster) {
    router.get("/slack/thread", async (req: Request, res: Response) => {
      try {
        const channelId = qstr(req.query.channel_id);
        const threadTs = qstr(req.query.thread_ts);
        if (!channelId || !threadTs) {
          res.status(400).json({ error: "channel_id and thread_ts required" });
          return;
        }
        const messages = await slackPoster.fetchThread(channelId, threadTs);
        res.json({ messages });
      } catch (err: unknown) {
        log.error("Thread fetch error", { error: (err as Error).message });
        res.status(500).json({ error: "Internal error" });
      }
    });
  }

  return router;
}
