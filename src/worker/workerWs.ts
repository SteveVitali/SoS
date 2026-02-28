import WebSocket from "ws";
import { createLogger } from "../shared/logger.js";
import type { WorkerCommand } from "../shared/types.js";

const log = createLogger("worker:ws");

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownRequested = false;

// Callback for shutdown command from server
let onShutdownCommand: (() => void) | null = null;

export function setShutdownHandler(handler: () => void): void {
  onShutdownCommand = handler;
}

export function connectWorkerWs(baseUrl: string, token: string, workerId: string): void {
  if (shutdownRequested) return;

  const wsUrl =
    baseUrl.replace(/^http/, "ws") +
    `/api/worker/ws?worker_id=${encodeURIComponent(workerId)}&token=${encodeURIComponent(token)}`;

  try {
    ws = new WebSocket(wsUrl);
  } catch (err: unknown) {
    log.warn("Failed to create WebSocket", { error: (err as Error).message });
    scheduleReconnect(baseUrl, token, workerId);
    return;
  }

  ws.on("open", () => {
    log.info("WebSocket connected to server");
  });

  ws.on("message", (data) => {
    try {
      const cmd: WorkerCommand = JSON.parse(data.toString());
      if (cmd.command === "shutdown") {
        log.info("Received shutdown command from server");
        if (onShutdownCommand) onShutdownCommand();
      }
    } catch {
      // Ignore malformed
    }
  });

  ws.on("close", () => {
    ws = null;
    if (!shutdownRequested) {
      log.info("WebSocket disconnected, will reconnect");
      scheduleReconnect(baseUrl, token, workerId);
    }
  });

  ws.on("error", (err) => {
    log.warn("WebSocket error", { error: (err as Error).message });
    // 'close' event will fire after this
  });
}

function scheduleReconnect(baseUrl: string, token: string, workerId: string): void {
  if (reconnectTimer || shutdownRequested) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWorkerWs(baseUrl, token, workerId);
  }, 5000);
}

export function sendLogLine(loopIndex: number, line: string, taskId?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(
      JSON.stringify({
        type: "log",
        loop_index: loopIndex,
        task_id: taskId,
        line,
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    // Best effort
  }
}

export function closeWorkerWs(): void {
  shutdownRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
