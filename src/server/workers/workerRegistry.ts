import { createLogger } from "../../shared/logger.js";
import type {
  WorkerCommand,
  WorkerInfo,
  WorkerLogLine,
  WorkerLoopInfo,
  WorkerRegisterRequest,
} from "../../shared/types.js";

const log = createLogger("server:workerRegistry");

const STALE_TIMEOUT_MS = 60_000; // 60s without status → offline
const LOG_RING_SIZE = 1000; // lines per worker

interface WorkerEntry {
  info: WorkerInfo;
  /** Ring buffer of recent log lines per loop index (-1 = all) */
  logRing: WorkerLogLine[];
  /** SSE subscribers for live logs */
  logSubscribers: Set<(line: WorkerLogLine) => void>;
  /** WebSocket send function (if connected) */
  wsSend?: (msg: WorkerCommand) => void;
}

const workers = new Map<string, WorkerEntry>();

// --- Registration ---

export function registerWorker(req: WorkerRegisterRequest): WorkerInfo {
  const now = new Date().toISOString();
  const info: WorkerInfo = {
    worker_id: req.worker_id,
    hostname: req.hostname,
    pid: req.pid,
    concurrency: req.concurrency,
    started_at: now,
    last_seen: now,
    status: "online",
    loops: Array.from({ length: req.concurrency }, (_, i) => ({
      index: i,
      status: "idle" as const,
    })),
    version: req.version,
  };

  workers.set(req.worker_id, {
    info,
    logRing: [],
    logSubscribers: new Set(),
  });

  log.info("Worker registered", { worker_id: req.worker_id, pid: req.pid });
  return info;
}

export function deregisterWorker(workerId: string): boolean {
  const entry = workers.get(workerId);
  if (!entry) return false;
  // Notify any log subscribers that the stream is ending
  for (const sub of entry.logSubscribers) {
    sub({ worker_id: workerId, loop_index: -1, line: "", ts: "" }); // sentinel
  }
  entry.logSubscribers.clear();
  workers.delete(workerId);
  log.info("Worker deregistered", { worker_id: workerId });
  return true;
}

export function removeWorker(workerId: string): boolean {
  return deregisterWorker(workerId);
}

// --- Status ---

export function updateWorkerStatus(workerId: string, loops: WorkerLoopInfo[]): boolean {
  const entry = workers.get(workerId);
  if (!entry) return false;
  entry.info.last_seen = new Date().toISOString();
  entry.info.loops = loops;
  entry.info.status = "online";
  entry.info.concurrency = loops.length;
  return true;
}

// --- List ---

export function listWorkers(): WorkerInfo[] {
  const now = Date.now();
  const result: WorkerInfo[] = [];

  for (const entry of workers.values()) {
    const lastSeen = new Date(entry.info.last_seen).getTime();
    const age = now - lastSeen;
    if (age > STALE_TIMEOUT_MS) {
      entry.info.status = "offline";
    }
    result.push({ ...entry.info });
  }

  // Sort: online first, then by started_at
  result.sort((a, b) => {
    if (a.status === "offline" && b.status !== "offline") return 1;
    if (a.status !== "offline" && b.status === "offline") return -1;
    return a.started_at.localeCompare(b.started_at);
  });

  return result;
}

export function getWorker(workerId: string): WorkerInfo | null {
  const entry = workers.get(workerId);
  if (!entry) return null;
  const age = Date.now() - new Date(entry.info.last_seen).getTime();
  if (age > STALE_TIMEOUT_MS) entry.info.status = "offline";
  return { ...entry.info };
}

// --- WebSocket management ---

export function setWorkerWs(workerId: string, send: (msg: WorkerCommand) => void): void {
  const entry = workers.get(workerId);
  if (entry) entry.wsSend = send;
}

export function clearWorkerWs(workerId: string): void {
  const entry = workers.get(workerId);
  if (entry) entry.wsSend = undefined;
}

export function sendWorkerCommand(workerId: string, cmd: WorkerCommand): boolean {
  const entry = workers.get(workerId);
  if (!entry?.wsSend) return false;
  try {
    entry.wsSend(cmd);
    return true;
  } catch {
    return false;
  }
}

// --- Log streaming ---

export function pushLogLine(line: WorkerLogLine): void {
  const entry = workers.get(line.worker_id);
  if (!entry) return;

  // Ring buffer
  entry.logRing.push(line);
  if (entry.logRing.length > LOG_RING_SIZE) {
    entry.logRing.shift();
  }

  // Fan out to SSE subscribers
  for (const sub of entry.logSubscribers) {
    sub(line);
  }
}

export function getLogHistory(workerId: string, loopIndex?: number): WorkerLogLine[] {
  const entry = workers.get(workerId);
  if (!entry) return [];
  if (loopIndex == null) return [...entry.logRing];
  return entry.logRing.filter((l) => l.loop_index === loopIndex);
}

export function subscribeToLogs(
  workerId: string,
  callback: (line: WorkerLogLine) => void,
): () => void {
  const entry = workers.get(workerId);
  if (!entry) return () => {};
  entry.logSubscribers.add(callback);
  return () => {
    entry.logSubscribers.delete(callback);
  };
}
