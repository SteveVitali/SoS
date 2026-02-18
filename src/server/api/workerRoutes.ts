import { type Request, type Response, Router } from "express";
import { createLogger } from "../../shared/logger.js";
import {
  ClaimJobSchema,
  CompleteJobSchema,
  FailJobSchema,
  HeartbeatSchema,
  WorkerEventSchema,
} from "../jobs/jobModel.js";
import * as jobService from "../jobs/jobService.js";
import type { SlackPoster } from "../slack/slackClient.js";

const log = createLogger("server:api:worker");

function qstr(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : String(v ?? "");
}
function pstr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export function createWorkerRoutes(slackPoster?: SlackPoster): Router {
  const router = Router();

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
    } catch (err: any) {
      log.error("Poll error", { error: err.message });
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
    } catch (err: any) {
      log.error("Claim error", { error: err.message, task_id: pstr(req.params.task_id) });
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
    } catch (err: any) {
      log.error("Heartbeat error", { error: err.message, task_id: pstr(req.params.task_id) });
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
    } catch (err: any) {
      log.error("Event error", { error: err.message, task_id: pstr(req.params.task_id) });
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
      const { node_id, result_summary, pr_urls, ci } = parsed.data;
      const job = await jobService.complete(pstr(req.params.task_id), node_id, {
        result_summary,
        pr_urls,
        ci,
      });
      if (!job) {
        res.status(409).json({ error: "Complete failed: not owner or not active" });
        return;
      }
      res.json({ job });
    } catch (err: any) {
      log.error("Complete error", { error: err.message, task_id: pstr(req.params.task_id) });
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
    } catch (err: any) {
      log.error("Requeue error", { error: err.message, task_id: pstr(req.params.task_id) });
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
      const { node_id, error, pr_urls, ci } = parsed.data;
      const job = await jobService.fail(pstr(req.params.task_id), node_id, { error, pr_urls, ci });
      if (!job) {
        res.status(409).json({ error: "Fail update failed: not owner or not active" });
        return;
      }
      res.json({ job });
    } catch (err: any) {
      log.error("Fail error", { error: err.message, task_id: pstr(req.params.task_id) });
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
      } catch (err: any) {
        log.error("Thread fetch error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    });
  }

  return router;
}
