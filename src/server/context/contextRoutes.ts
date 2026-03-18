/**
 * Worker-facing routes for the unified context assembly layer.
 * Mounted at /api/worker/context.
 */

import { type Request, type Response, Router } from "express";
import type { KBScope } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import { assembleContext } from "./contextAssembler.js";

const log = createLogger("server:context:routes");

/**
 * Create worker-facing context routes.
 */
export function createContextWorkerRoutes(): Router {
  const router = Router();

  // POST /api/worker/context — unified context assembly for workers
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { query, owner, scopes, allowDeep, maxTokens } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }
      if (!owner || typeof owner !== "string") {
        res.status(400).json({ error: "owner is required" });
        return;
      }
      if (!scopes || !Array.isArray(scopes)) {
        res.status(400).json({ error: "scopes is required (array)" });
        return;
      }

      const result = await assembleContext({
        query,
        owner,
        scopes: scopes as KBScope[],
        allowDeepEscalation: allowDeep !== false,
        maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
      });

      res.json({
        context: result.context,
        profile: result.profile,
        metadata: result.metadata,
      });
    } catch (err: unknown) {
      log.error("Worker context assembly error", { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
