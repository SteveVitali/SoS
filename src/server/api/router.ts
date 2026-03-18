import { Router } from "express";
import { internalAuth, optionalBasicAuth } from "../auth/internalAuth.js";
import { createChatRoutes } from "../chat/chatRoutes.js";
import { createImageRoutes } from "../chat/imageStore.js";
import type { ServerConfig } from "../config.js";
import { createContextWorkerRoutes } from "../context/contextRoutes.js";
import type { DiscordPoster } from "../discord/discordClient.js";
import { createKBWebRoutes, createKBWorkerRoutes } from "../kb/index.js";
import { createMemoryRoutes } from "../memory/memoryRoutes.js";
import type { SlackPoster } from "../slack/slackClient.js";
import { createGitHubRoutes } from "./githubRoutes.js";
import { createWebRoutes } from "./webRoutes.js";
import { createWorkerRoutes } from "./workerRoutes.js";

export function createRouter(
  config: ServerConfig,
  slackPoster?: SlackPoster,
  discordPoster?: DiscordPoster,
): Router {
  const router = Router();

  // Worker routes — require Bearer token
  router.use(
    "/api/worker",
    internalAuth(config.internalApiToken),
    createWorkerRoutes(slackPoster, discordPoster),
  );
  router.use("/api/worker/kb", internalAuth(config.internalApiToken), createKBWorkerRoutes());
  router.use(
    "/api/worker/context",
    internalAuth(config.internalApiToken),
    createContextWorkerRoutes(),
  );

  // Image serving — no auth required (UUIDs are unguessable, images are immutable)
  router.use("/api/web/images", createImageRoutes());

  // Web routes — optional basic auth or Bearer token
  const webAuth = config.webBasicAuthUser
    ? optionalBasicAuth(config.webBasicAuthUser, config.webBasicAuthPass)
    : internalAuth(config.internalApiToken);

  router.use("/api/web", webAuth, createWebRoutes(config));
  router.use("/api/web/chats", webAuth, createChatRoutes(config));
  router.use("/api/web/kb", webAuth, createKBWebRoutes());
  router.use("/api/web/github", webAuth, createGitHubRoutes(config));
  router.use("/api/web/memory", webAuth, createMemoryRoutes(config));

  return router;
}
