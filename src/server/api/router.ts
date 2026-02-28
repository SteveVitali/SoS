import { Router } from "express";
import { internalAuth, optionalBasicAuth } from "../auth/internalAuth.js";
import { createChatRoutes } from "../chat/chatRoutes.js";
import type { ServerConfig } from "../config.js";
import { createKBWebRoutes, createKBWorkerRoutes } from "../kb/index.js";
import type { SlackPoster } from "../slack/slackClient.js";
import { createWebRoutes } from "./webRoutes.js";
import { createWorkerRoutes } from "./workerRoutes.js";

export function createRouter(config: ServerConfig, slackPoster?: SlackPoster): Router {
  const router = Router();

  // Worker routes — require Bearer token
  router.use("/api/worker", internalAuth(config.internalApiToken), createWorkerRoutes(slackPoster));
  router.use("/api/worker/kb", internalAuth(config.internalApiToken), createKBWorkerRoutes());

  // Web routes — optional basic auth or Bearer token
  const webAuth = config.webBasicAuthUser
    ? optionalBasicAuth(config.webBasicAuthUser, config.webBasicAuthPass)
    : internalAuth(config.internalApiToken);

  router.use("/api/web", webAuth, createWebRoutes(config));
  router.use("/api/web/chats", webAuth, createChatRoutes(config));
  router.use("/api/web/kb", webAuth, createKBWebRoutes());

  return router;
}
