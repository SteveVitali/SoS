import { createLogger } from "../shared/logger.js";
import type { WorkerApiClient } from "./apiClient.js";

const log = createLogger("worker:heartbeat");

/**
 * Maximum consecutive transient heartbeat failures before we consider the
 * lease irrecoverably lost and abort the running job.
 * At 15s intervals, 20 failures ≈ 5 minutes of server downtime.
 */
const MAX_CONSECUTIVE_FAILURES = 20;

interface HeartbeatSlot {
  handle: ReturnType<typeof setInterval>;
  failures: number;
  abortController: AbortController;
}

export class HeartbeatManager {
  private slots = new Map<string, HeartbeatSlot>();

  constructor(
    private api: WorkerApiClient,
    private nodeId: string,
    private extendSeconds: number,
    private intervalMs: number,
  ) {}

  /**
   * Start heartbeating for a task. Returns an AbortSignal that will be
   * aborted if the lease is definitively lost (409) or if the server is
   * unreachable for too long (MAX_CONSECUTIVE_FAILURES).
   */
  start(taskId: string): AbortSignal {
    // biome-ignore lint/style/noNonNullAssertion: value verified above
    if (this.slots.has(taskId)) return this.slots.get(taskId)!.abortController.signal;

    const abortController = new AbortController();

    const handle = setInterval(async () => {
      const slot = this.slots.get(taskId);
      if (!slot) return;

      try {
        const ok = await this.api.heartbeat(taskId, this.nodeId, this.extendSeconds);
        if (ok) {
          // Reset failure counter on success
          if (slot.failures > 0) {
            log.info("Heartbeat recovered after transient failures", {
              task_id: taskId,
              previous_failures: slot.failures,
            });
          }
          slot.failures = 0;
        } else {
          // 409 — lease genuinely lost by the server
          log.warn("Heartbeat rejected — lease lost (409)", { task_id: taskId });
          this.abortAndStop(taskId, "Lease lost (server rejected heartbeat)");
        }
      } catch (err: unknown) {
        // Transient error (server down, network issue)
        slot.failures++;
        if (slot.failures <= 3 || slot.failures % 10 === 0) {
          log.warn("Heartbeat failed (server unreachable)", {
            task_id: taskId,
            consecutive_failures: slot.failures,
            error: (err as Error).message,
          });
        }
        if (slot.failures >= MAX_CONSECUTIVE_FAILURES) {
          log.error("Heartbeat: server unreachable too long, aborting job", {
            task_id: taskId,
            consecutive_failures: slot.failures,
            threshold: MAX_CONSECUTIVE_FAILURES,
          });
          this.abortAndStop(
            taskId,
            `Server unreachable for ${slot.failures} consecutive heartbeats`,
          );
        }
      }
    }, this.intervalMs);

    this.slots.set(taskId, { handle, failures: 0, abortController });
    log.info("Heartbeat started", { task_id: taskId, interval_ms: this.intervalMs });
    return abortController.signal;
  }

  private abortAndStop(taskId: string, reason: string): void {
    const slot = this.slots.get(taskId);
    if (!slot) return;
    clearInterval(slot.handle);
    slot.abortController.abort(reason);
    this.slots.delete(taskId);
    log.info("Heartbeat aborted", { task_id: taskId, reason });
  }

  stop(taskId: string): void {
    const slot = this.slots.get(taskId);
    if (slot) {
      clearInterval(slot.handle);
      this.slots.delete(taskId);
      log.info("Heartbeat stopped", { task_id: taskId });
    }
  }

  stopAll(): void {
    for (const [taskId, slot] of this.slots) {
      clearInterval(slot.handle);
      log.info("Heartbeat stopped", { task_id: taskId });
    }
    this.slots.clear();
  }
}
