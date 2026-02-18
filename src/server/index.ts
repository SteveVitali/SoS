import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../shared/logger.js";
import { loadServerConfig } from "./config.js";
import { connectMongo, closeMongo } from "./mongo.js";
import { createSlackPoster } from "./slack/slackClient.js";
import { startSlackSocketMode } from "./slack/socketMode.js";
import { setSlackPoster } from "./jobs/jobService.js";
import { createRouter } from "./api/router.js";

const log = createLogger("server");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const config = loadServerConfig();

  // Connect to MongoDB
  await connectMongo(config.mongoUri, config.mongoDb);

  // Create Slack poster (only if real tokens are configured, not placeholders)
  const slackEnabled = config.slackBotToken.length > 20 && config.slackAppToken.length > 20;
  let slackPoster;
  if (slackEnabled) {
    slackPoster = createSlackPoster(config.slackBotToken);
    setSlackPoster(slackPoster);
  } else {
    log.warn("Slack tokens not configured — running without Slack integration");
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

  app.listen(config.port, () => {
    log.info(`Server listening on port ${config.port}`);
  });

  // Start Slack Socket Mode (only if tokens are configured)
  if (slackEnabled) {
    try {
      await startSlackSocketMode(config);
    } catch (err: any) {
      log.error("Failed to start Slack Socket Mode", { error: err.message });
      log.warn("Server will continue without Slack integration");
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    await closeMongo();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
