/** Sentinel error when a job is canceled mid-execution. */
export class CanceledError extends Error {
  constructor() {
    super("Job was canceled during execution");
    this.name = "CanceledError";
  }
}

/** Sentinel error to signal the job should be requeued, not failed. */
export class RequeueError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "RequeueError";
  }
}

/** Sentinel error when the heartbeat signals lease loss / server unreachable. */
export class LeaseAbortedError extends Error {
  constructor(reason?: string) {
    super(reason || "Job aborted: lease lost or server unreachable");
    this.name = "LeaseAbortedError";
  }
}
