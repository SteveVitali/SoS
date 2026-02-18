import { WorkerApiClient } from "./apiClient.js";
import type { WorkerEventType } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("worker:events");

export class EventEmitter {
  constructor(
    private api: WorkerApiClient,
    private nodeId: string,
    private taskId: string
  ) {}

  async emit(type: WorkerEventType, payload?: any): Promise<void> {
    try {
      await this.api.sendEvent(this.taskId, this.nodeId, type, payload);
    } catch (err: any) {
      log.error("Failed to emit event", { task_id: this.taskId, type, error: err.message });
    }
  }
}
