import "dotenv/config";
import { setMaxListeners } from "node:events";
import os from "node:os";
import { createLogger } from "../shared/logger.js";
import { WorkerApiClient } from "./apiClient.js";
import { loadWorkerConfig } from "./config.js";
import { worktreePool } from "./executor/worktreePool.js";
import { startWorkerLoop } from "./poller.js";
import { closeWorkerWs, connectWorkerWs, setShutdownHandler } from "./workerWs.js";

const log = createLogger("worker");

async function main() {
  const config = loadWorkerConfig();
  const api = new WorkerApiClient(config.apiBaseUrl, config.apiToken);

  // Initialize the shared worktree pool
  worktreePool.init(config.workspaceRoot);

  // Generate a unique process-level worker ID
  const processWorkerId = `${config.nodeId}-pid${process.pid}`;

  log.info("Starting worker pool", {
    nodeId: config.nodeId,
    processWorkerId,
    workers: config.workers,
    requestedBy: config.requestedBy,
  });

  // Register with the server
  try {
    await api.registerWorker({
      worker_id: processWorkerId,
      hostname: os.hostname(),
      pid: process.pid,
      concurrency: config.workers,
    });
  } catch (err: unknown) {
    log.warn("Failed to register with server (non-fatal)", { error: (err as Error).message });
  }

  // Connect WebSocket for log streaming
  connectWorkerWs(config.apiBaseUrl, config.apiToken, processWorkerId);

  const controllers: AbortController[] = [];
  const promises: Promise<void>[] = [];

  for (let i = 0; i < config.workers; i++) {
    const workerId = `${config.nodeId}:worker-${i}`;
    const controller = new AbortController();
    setMaxListeners(0, controller.signal);
    controllers.push(controller);
    promises.push(startWorkerLoop(workerId, i, config, api, controller.signal, processWorkerId));
  }

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down worker pool...");
    for (const c of controllers) c.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Allow server to trigger shutdown via WebSocket command
  setShutdownHandler(shutdown);

  await Promise.allSettled(promises);

  // Deregister from server
  try {
    await api.deregisterWorker(processWorkerId);
  } catch {
    // Best effort
  }
  closeWorkerWs();

  log.info("All workers stopped");
}

main().catch((err) => {
  log.error("Fatal worker error", { error: err.message, stack: err.stack });
  process.exit(1);
});
