import { WebClient } from "@slack/web-api";
import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";
import {
  fmtCanceled,
  fmtClaimed,
  fmtDone,
  fmtEvent,
  fmtFailed,
  fmtPlan,
  fmtQueued,
} from "./formatting.js";

const log = createLogger("server:slack");

export interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

export interface SlackThreadMessage {
  user: string;
  text: string;
  ts: string;
  files: SlackFileInfo[];
}

export interface SlackPoster {
  postQueued(job: JobDoc): Promise<void>;
  postClaimed(job: JobDoc): Promise<void>;
  postDone(job: JobDoc): Promise<void>;
  postFailed(job: JobDoc): Promise<void>;
  postCanceled(job: JobDoc): Promise<void>;
  postPlan(job: JobDoc): Promise<void>;
  postEvent(job: JobDoc, type: string, payload?: any): Promise<void>;
  fetchThread(channelId: string, threadTs: string, limit?: number): Promise<SlackThreadMessage[]>;
  downloadFile(urlPrivate: string): Promise<Buffer>;
  setPresenceActive(): Promise<void>;
  setPresenceAway(): Promise<void>;
}

export function createSlackPoster(botToken: string, notifyUserId?: string): SlackPoster {
  const client = new WebClient(botToken);

  async function postToThread(channelId: string, threadTs: string, text: string) {
    if (notifyUserId) {
      text += `\n<@${notifyUserId}>`;
    }
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

    async postPlan(job: JobDoc) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      await postToThread(job.slack.channel_id, job.slack.thread_ts, fmtPlan(job));
    },

    async postEvent(job: JobDoc, type: string, payload?: any) {
      if (!job.slack?.channel_id || !job.slack?.thread_ts) return;
      const text = fmtEvent(job, type, payload);
      await postToThread(job.slack.channel_id, job.slack.thread_ts, text);
    },

    async fetchThread(
      channelId: string,
      threadTs: string,
      limit = 20,
    ): Promise<SlackThreadMessage[]> {
      try {
        const result = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit,
        });
        return (result.messages || []).map((m: any) => ({
          user: m.user,
          text: m.text?.slice(0, 2000) || "",
          ts: m.ts,
          files: (m.files || [])
            .map((f: any) => ({
              id: f.id,
              name: f.name || "unknown",
              mimetype: f.mimetype || "application/octet-stream",
              size: f.size || 0,
              url_private: f.url_private || "",
            }))
            .filter((f: SlackFileInfo) => f.url_private),
        }));
      } catch (err: any) {
        log.error("Failed to fetch Slack thread", { error: err.message });
        return [];
      }
    },

    async downloadFile(urlPrivate: string): Promise<Buffer> {
      const response = await fetch(urlPrivate, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },

    async setPresenceActive() {
      try {
        await client.users.setPresence({ presence: "auto" });
        log.info("Slack presence set to active");
      } catch (err: any) {
        log.error("Failed to set Slack presence to active", { error: err.message });
      }
    },

    async setPresenceAway() {
      try {
        await client.users.setPresence({ presence: "away" });
        log.info("Slack presence set to away");
      } catch (err: any) {
        log.error("Failed to set Slack presence to away", { error: err.message });
      }
    },
  };
}
