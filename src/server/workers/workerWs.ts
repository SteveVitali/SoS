import type { Server as HttpServer, IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { createLogger } from "../../shared/logger.js";
import type { WorkerLogLine } from "../../shared/types.js";
import { clearWorkerWs, pushLogLine, setWorkerWs } from "./workerRegistry.js";

const log = createLogger("server:workerWs");

/**
 * Attach a WebSocket server to the HTTP server for worker log streaming.
 * Workers connect to ws://host/api/worker/ws?worker_id=xxx&token=yyy
 */
export function attachWorkerWs(httpServer: HttpServer, apiToken: string): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (url.pathname !== "/api/worker/ws") {
      socket.destroy();
      return;
    }

    // Authenticate
    const token = url.searchParams.get("token");
    if (token !== apiToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const workerId = url.searchParams.get("worker_id");
    if (!workerId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, workerId);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, workerId: string) => {
    log.info("Worker WebSocket connected", { worker_id: workerId });

    // Register the send function so the registry can push commands
    setWorkerWs(workerId, (cmd) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(cmd));
      }
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "log") {
          const logLine: WorkerLogLine = {
            worker_id: workerId,
            loop_index: msg.loop_index ?? 0,
            task_id: msg.task_id,
            line: msg.line,
            ts: msg.ts || new Date().toISOString(),
          };
          pushLogLine(logLine);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      log.info("Worker WebSocket disconnected", { worker_id: workerId });
      clearWorkerWs(workerId);
    });

    ws.on("error", (err) => {
      log.warn("Worker WebSocket error", { worker_id: workerId, error: (err as Error).message });
    });
  });
}
