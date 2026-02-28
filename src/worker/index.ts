import "dotenv/config";
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

  log.info("Starting worker", {
    nodeId: config.nodeId,
    processWorkerId,
    requestedBy: config.requestedBy,
  });

  // Register with the server
  try {
    await api.registerWorker({
      worker_id: processWorkerId,
      hostname: os.hostname(),
      pid: process.pid,
    });
  } catch (err: unknown) {
    log.warn("Failed to register with server (non-fatal)", { error: (err as Error).message });
  }

  // Connect WebSocket for log streaming
  connectWorkerWs(config.apiBaseUrl, config.apiToken, processWorkerId);

  const controller = new AbortController();

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down worker...");
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Allow server to trigger shutdown via WebSocket command
  setShutdownHandler(shutdown);

  await startWorkerLoop(processWorkerId, 0, config, api, controller.signal, processWorkerId);

  // Deregister from server
  try {
    await api.deregisterWorker(processWorkerId);
  } catch {
    // Best effort
  }
  closeWorkerWs();

  log.info("Worker stopped");
}

main().catch((err) => {
  log.error("Fatal worker error", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
