import { WebClient } from "@slack/web-api";
import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";
import { fmtQueued, fmtClaimed, fmtDone, fmtFailed, fmtCanceled, fmtEvent } from "./formatting.js";

const log = createLogger("server:slack");

export interface SlackPoster {
  postQueued(job: JobDoc): Promise<void>;
  postClaimed(job: JobDoc): Promise<void>;
  postDone(job: JobDoc): Promise<void>;
  postFailed(job: JobDoc): Promise<void>;
  postCanceled(job: JobDoc): Promise<void>;
  postEvent(job: JobDoc, type: string, payload?: any): Promise<void>;
  fetchThread(channelId: string, threadTs: string, limit?: number): Promise<any[]>;
}

export function createSlackPoster(botToken: string): SlackPoster {
  const client = new WebClient(botToken);

  async function postToThread(channelId: string, threadTs: string, text: string) {
    try {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
      });
    } catch (err: any) {
      log.error("Failed to post Slack message", { error: err.message, channel: channelId });
    }
  }

  return {
    async postQueued(job: JobDoc) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      await postToThread(job.slack.channel_id, job.slack.thread_ts, fmtQueued(job));
    },

    async postClaimed(job: JobDoc) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      await postToThread(job.slack.channel_id, job.slack.thread_ts, fmtClaimed(job));
    },

    async postDone(job: JobDoc) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      await postToThread(job.slack.channel_id, job.slack.thread_ts, fmtDone(job));
    },

    async postFailed(job: JobDoc) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      await postToThread(job.slack.channel_id, job.slack.thread_ts, fmtFailed(job));
    },

    async postCanceled(job: JobDoc) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      await postToThread(job.slack.channel_id, job.slack.thread_ts, fmtCanceled(job));
    },

    async postEvent(job: JobDoc, type: string, payload?: any) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      const text = fmtEvent(job, type, payload);
      await postToThread(job.slack.channel_id, job.slack.thread_ts, text);
    },

    async fetchThread(channelId: string, threadTs: string, limit = 20): Promise<any[]> {
      try {
        const result = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit,
        });
        return (result.messages || []).map((m: any) => ({
          user: m.user,
          text: m.text?.slice(0, 2000),
          ts: m.ts,
        }));
      } catch (err: any) {
        log.error("Failed to fetch Slack thread", { error: err.message });
        return [];
      }
    },
  };
}
