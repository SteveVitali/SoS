import "dotenv/config";
import { setMaxListeners } from "events";
import { createLogger } from "../shared/logger.js";
import { loadWorkerConfig } from "./config.js";
import { WorkerApiClient } from "./apiClient.js";
import { startWorkerLoop } from "./poller.js";

const log = createLogger("worker");

async function main() {
  const config = loadWorkerConfig();
  const api = new WorkerApiClient(config.apiBaseUrl, config.apiToken);

  log.info("Starting worker pool", {
    nodeId: config.nodeId,
    workers: config.workers,
    requestedBy: config.requestedBy,
  });

  const controllers: AbortController[] = [];
  const promises: Promise<void>[] = [];

  for (let i = 0; i < config.workers; i++) {
    const workerId = `${config.nodeId}:worker-${i}`;
    const controller = new AbortController();
    setMaxListeners(0, controller.signal);
    controllers.push(controller);
    promises.push(startWorkerLoop(workerId, config, api, controller.signal));
  }

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down worker pool...");
    for (const c of controllers) c.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await Promise.allSettled(promises);
  log.info("All workers stopped");
}

main().catch((err) => {
  log.error("Fatal worker error", { error: err.message, stack: err.stack });
  process.exit(1);
});
