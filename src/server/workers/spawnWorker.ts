import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../shared/logger.js";
import { listWorkers, sendWorkerCommand } from "./workerRegistry.js";

const log = createLogger("server:spawnWorker");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../..");

/** PIDs of worker processes spawned by this server instance. */
const spawnedPids = new Set<number>();

/**
 * Spawn a new worker process. Returns the child PID.
 * Workers are kept in the same process group (no detach) so they're
 * cleaned up if the server is killed ungracefully.
 */
export function spawnWorkerProcess(): number {
  const workerEntry = path.resolve(projectRoot, "src/worker/index.ts");
  const tsxBin = path.resolve(projectRoot, "node_modules/.bin/tsx");

  const child = spawn(tsxBin, [workerEntry], {
    stdio: "ignore",
    env: process.env,
  });
  // unref so the server can exit without waiting for the child to finish,
  // but do NOT detach — we want the child in our process group.
  child.unref();

  const pid = child.pid;
  if (pid) {
    spawnedPids.add(pid);
    child.on("exit", () => spawnedPids.delete(pid));
    log.info("Spawned worker process", { pid });
  }

  return pid ?? 0;
}

/**
 * Gracefully shut down all registered workers.
 * 1. Send "shutdown" command via WebSocket to every registered worker.
 * 2. Wait briefly for graceful exit.
 * 3. SIGTERM any spawned PIDs that are still alive.
 */
export async function shutdownAllWorkers(): Promise<void> {
  const workers = listWorkers();
  if (workers.length === 0 && spawnedPids.size === 0) return;

  log.info("Shutting down all workers", {
    registered: workers.length,
    spawnedPids: spawnedPids.size,
  });

  // Step 1: send WebSocket shutdown command to all registered workers
  for (const w of workers) {
    try {
      sendWorkerCommand(w.worker_id, { command: "shutdown" });
    } catch {
      // best effort
    }
  }

  // Step 2: give workers a moment to deregister gracefully
  await new Promise((r) => setTimeout(r, 2000));

  // Step 3: SIGTERM any spawned PIDs still alive
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGTERM");
      log.info("Sent SIGTERM to lingering worker", { pid });
    } catch {
      // Process already exited — ignore
    }
  }
  spawnedPids.clear();
}
