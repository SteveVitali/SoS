import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createLogger } from "../shared/logger.js";
import { createRouter } from "./api/router.js";
import { initChatTitleGenerator } from "./chat/titleGen.js";
import { loadServerConfig } from "./config.js";
import { setSlackPoster } from "./jobs/jobService.js";
import { startLeaseReaper, stopLeaseReaper } from "./jobs/leaseReaper.js";
import { initTitleGenerator } from "./jobs/titleGenerator.js";
import { createLLMProvider } from "./llm/index.js";
import { closeMongo, connectMongo } from "./mongo.js";
import { initRoutingConfig } from "./routing/index.js";
import { initMessageRouter } from "./slack/messageRouter.js";
import { createSlackPoster } from "./slack/slackClient.js";
import { startSlackSocketMode } from "./slack/socketMode.js";
import { initUserResolver } from "./slack/userResolver.js";

const log = createLogger("server");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const config = loadServerConfig();

  // Connect to MongoDB
  await connectMongo(config.mongoUri, config.mongoDb);

  // Create Slack poster (only if real tokens are configured, not placeholders)
  const slackEnabled = config.slackBotToken.length > 20 && config.slackAppToken.length > 20;
  let slackPoster: ReturnType<typeof createSlackPoster> | undefined;
  if (slackEnabled) {
    slackPoster = createSlackPoster(config.slackBotToken, config.slackNotifyUser || undefined);
    setSlackPoster(slackPoster);
    initUserResolver(config.slackBotToken);
  } else {
    log.warn("Slack tokens not configured — running without Slack integration");
  }

  // Initialize YAML-driven routing config
  if (config.routingConfigPath) {
    try {
      initRoutingConfig(config.routingConfigPath);
    } catch (err: any) {
      log.error("Failed to initialize routing config", { error: err.message });
    }
  } else {
    // Default to routing-config.yaml next to repo-registry if available
    const fallbackPath = config.repoRegistryPath
      ? path.join(path.dirname(config.repoRegistryPath), "routing-config.yaml")
      : path.join(process.cwd(), "routing-config.yaml");
    try {
      initRoutingConfig(fallbackPath);
    } catch (err: any) {
      log.warn("No routing config found, using hardcoded defaults", { path: fallbackPath });
    }
  }

  // Initialize LLM provider for Slack message routing
  if (config.llmApiKey) {
    try {
      const llmProvider = createLLMProvider({
        provider: config.llmProvider,
        model: config.llmModel,
        apiKey: config.llmApiKey,
        baseUrl: config.llmBaseUrl || undefined,
      });
      initMessageRouter(llmProvider, config.llmModel);
      initTitleGenerator(llmProvider, config.llmModel);
      initChatTitleGenerator(llmProvider, config.llmModel);
    } catch (err: any) {
      log.warn(
        "Failed to initialize LLM provider — message routing will treat all mentions as jobs",
        { error: err.message },
      );
    }
  } else {
    log.warn(
      "No LLM API key configured (SOS_LLM_API_KEY / ANTHROPIC_API_KEY) — message routing disabled",
    );
  }

  // Start Express server
  const app = express();
  app.use(express.json());

  // API routes
  const router = createRouter(config, slackPoster);
  app.use(router);

  // Serve static UI files (production build)
  const uiDistPath = path.resolve(__dirname, "../../dist-ui");
  app.use(express.static(uiDistPath));
  // SPA fallback: serve index.html for any non-API route
  app.get("*path", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(uiDistPath, "index.html"), (err) => {
      if (err) {
        res.status(404).send("UI not built. Run: npm run build:ui");
      }
    });
  });

  const httpServer = app.listen(config.port, () => {
    log.info(`Server listening on port ${config.port}`);
  });

  // Attach WebSocket server for worker log streaming
  const { attachWorkerWs } = await import("./workers/workerWs.js");
  attachWorkerWs(httpServer, config.internalApiToken);

  // Auto-spawn one worker so the system is ready out of the box
  const { spawnWorkerProcess } = await import("./workers/spawnWorker.js");
  try {
    const pid = spawnWorkerProcess();
    log.info("Auto-spawned default worker", { pid });
  } catch (err: unknown) {
    log.warn("Failed to auto-spawn worker (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start lease reaper (transitions stale RUNNING jobs to FAILED)
  startLeaseReaper(slackPoster);

  // Start Slack Socket Mode (only if tokens are configured)
  if (slackEnabled) {
    try {
      await startSlackSocketMode(config, slackPoster);
      await slackPoster!.setPresenceActive();
    } catch (err: any) {
      log.error("Failed to start Slack Socket Mode", { error: err.message });
      log.warn("Server will continue without Slack integration");
    }
  }

  // Graceful shutdown
  const { shutdownAllWorkers } = await import("./workers/spawnWorker.js");
  const shutdown = async () => {
    log.info("Shutting down...");
    await shutdownAllWorkers();
    if (slackPoster) {
      await slackPoster.setPresenceAway();
    }
    stopLeaseReaper();
    await closeMongo();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (err) => {
  log.error("Fatal error", { error: err.message, stack: err.stack });
  try {
    const { shutdownAllWorkers } = await import("./workers/spawnWorker.js");
    await shutdownAllWorkers();
  } catch {
    // best effort
  }
  process.exit(1);
});
