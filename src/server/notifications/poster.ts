import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";

const log = createLogger("server:notifications");

export interface NotificationPoster {
  postQueued(job: JobDoc): Promise<void>;
  postClaimed(job: JobDoc): Promise<void>;
  postDone(job: JobDoc): Promise<void>;
  postFailed(job: JobDoc): Promise<void>;
  postCanceled(job: JobDoc): Promise<void>;
  postPlan(job: JobDoc): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic payload type
  postEvent(job: JobDoc, type: string, payload?: any): Promise<void>;
  setPresenceActive(): Promise<void>;
  setPresenceAway(): Promise<void>;
}

/**
 * Composite poster that fans out notifications to multiple platform-specific posters.
 * Each poster is responsible for checking whether the job has its platform's pointers
 * (e.g. Slack checks job.slack, Discord checks job.discord).
 */
export class CompositePoster implements NotificationPoster {
  private posters: NotificationPoster[] = [];

  add(poster: NotificationPoster) {
    this.posters.push(poster);
  }

  async postQueued(job: JobDoc) {
    await this.fanOut("postQueued", (p) => p.postQueued(job));
  }

  async postClaimed(job: JobDoc) {
    await this.fanOut("postClaimed", (p) => p.postClaimed(job));
  }

  async postDone(job: JobDoc) {
    await this.fanOut("postDone", (p) => p.postDone(job));
  }

  async postFailed(job: JobDoc) {
    await this.fanOut("postFailed", (p) => p.postFailed(job));
  }

  async postCanceled(job: JobDoc) {
    await this.fanOut("postCanceled", (p) => p.postCanceled(job));
  }

  async postPlan(job: JobDoc) {
    await this.fanOut("postPlan", (p) => p.postPlan(job));
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic payload type
  async postEvent(job: JobDoc, type: string, payload?: any) {
    await this.fanOut("postEvent", (p) => p.postEvent(job, type, payload));
  }

  async setPresenceActive() {
    await this.fanOut("setPresenceActive", (p) => p.setPresenceActive());
  }

  async setPresenceAway() {
    await this.fanOut("setPresenceAway", (p) => p.setPresenceAway());
  }

  private async fanOut(method: string, fn: (p: NotificationPoster) => Promise<void>) {
    await Promise.all(
      this.posters.map((p) =>
        fn(p).catch((err: unknown) => {
          log.error("Notification poster failed", {
            method,
            error: (err as Error).message,
          });
        }),
      ),
    );
  }
}
