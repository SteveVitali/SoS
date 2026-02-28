import { createLogger } from "../shared/logger.js";
import type { WorkerEventType } from "../shared/types.js";
import type { WorkerApiClient } from "./apiClient.js";

const log = createLogger("worker:events");

export class EventEmitter {
  constructor(
    private api: WorkerApiClient,
    private nodeId: string,
    private taskId: string,
  ) {}

  // biome-ignore lint/suspicious/noExplicitAny: dynamic payload type
  async emit(type: WorkerEventType, payload?: any): Promise<void> {
    try {
      await this.api.sendEvent(this.taskId, this.nodeId, type, payload);
    } catch (err: unknown) {
      log.error("Failed to emit event", {
        task_id: this.taskId,
        type,
        error: (err as Error).message,
      });
    }
  }
}
