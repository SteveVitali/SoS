import { createLogger } from "../shared/logger.js";
import type { WorkerApiClient } from "./apiClient.js";

const log = createLogger("worker:heartbeat");

export class HeartbeatManager {
  private intervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private api: WorkerApiClient,
    private nodeId: string,
    private extendSeconds: number,
    private intervalMs: number,
  ) {}

  start(taskId: string): void {
    if (this.intervals.has(taskId)) return;

    const handle = setInterval(async () => {
      try {
        const ok = await this.api.heartbeat(taskId, this.nodeId, this.extendSeconds);
        if (!ok) {
          log.warn("Heartbeat rejected, may have lost lease", { task_id: taskId });
        }
      } catch (err: any) {
        log.error("Heartbeat error", { task_id: taskId, error: err.message });
      }
    }, this.intervalMs);

    this.intervals.set(taskId, handle);
    log.info("Heartbeat started", { task_id: taskId, interval_ms: this.intervalMs });
  }

  stop(taskId: string): void {
    const handle = this.intervals.get(taskId);
    if (handle) {
      clearInterval(handle);
      this.intervals.delete(taskId);
      log.info("Heartbeat stopped", { task_id: taskId });
    }
  }

  stopAll(): void {
    for (const [taskId, handle] of this.intervals) {
      clearInterval(handle);
      log.info("Heartbeat stopped", { task_id: taskId });
    }
    this.intervals.clear();
  }
}
