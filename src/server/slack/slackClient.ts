import { WebClient } from "@slack/web-api";
import { createLogger } from "../../shared/logger.js";
import { markdownToSlack } from "../../shared/slackMarkdown.js";
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
  // biome-ignore lint/suspicious/noExplicitAny: Slack API type
  postEvent(job: JobDoc, type: string, payload?: any): Promise<void>;
  fetchThread(channelId: string, threadTs: string, limit?: number): Promise<SlackThreadMessage[]>;
  downloadFile(urlPrivate: string): Promise<Buffer>;
  setPresenceActive(): Promise<void>;
  setPresenceAway(): Promise<void>;
}

const SLACK_MAX_CHARS = 3900;

/**
 * Split a message into chunks that fit within Slack's display limit.
 * Splits at paragraph boundaries (double newlines) when possible,
 * falling back to single newlines, then hard-cutting as a last resort.
 */
export function splitForSlack(text: string): string[] {
  if (text.length <= SLACK_MAX_CHARS) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > SLACK_MAX_CHARS) {
    let splitIdx = -1;

    // Prefer splitting at a paragraph boundary (double newline)
    const paraBreak = remaining.lastIndexOf("\n\n", SLACK_MAX_CHARS);
    if (paraBreak > SLACK_MAX_CHARS * 0.3) {
      splitIdx = paraBreak;
    } else {
      // Fall back to single newline
      const lineBreak = remaining.lastIndexOf("\n", SLACK_MAX_CHARS);
      if (lineBreak > SLACK_MAX_CHARS * 0.3) {
        splitIdx = lineBreak;
      } else {
        // Hard cut at limit
        splitIdx = SLACK_MAX_CHARS;
      }
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export function createSlackPoster(botToken: string, notifyUserId?: string): SlackPoster {
  const client = new WebClient(botToken);

  async function postToThread(channelId: string, threadTs: string, text: string) {
    const converted = markdownToSlack(text);
    const chunks = splitForSlack(converted);

    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i];
      // Append notify mention to the last chunk only
      if (notifyUserId && i === chunks.length - 1) {
        chunk += `\n<@${notifyUserId}>`;
      }
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: chunk,
        });
      } catch (err: unknown) {
        log.error("Failed to post Slack message", {
          error: (err as Error).message,
          channel: channelId,
          chunk: `${i + 1}/${chunks.length}`,
        });
      }
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

    // biome-ignore lint/suspicious/noExplicitAny: Slack API type
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
        // biome-ignore lint/suspicious/noExplicitAny: Slack API type
        return (result.messages || []).map((m: any) => ({
          user: m.user,
          text: m.text?.slice(0, 2000) || "",
          ts: m.ts,
          files: (m.files || [])
            // biome-ignore lint/suspicious/noExplicitAny: Slack API type
            .map((f: any) => ({
              id: f.id,
              name: f.name || "unknown",
              mimetype: f.mimetype || "application/octet-stream",
              size: f.size || 0,
              url_private: f.url_private || "",
            }))
            .filter((f: SlackFileInfo) => f.url_private),
        }));
      } catch (err: unknown) {
        log.error("Failed to fetch Slack thread", { error: (err as Error).message });
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
      } catch (err: unknown) {
        log.error("Failed to set Slack presence to active", { error: (err as Error).message });
      }
    },

    async setPresenceAway() {
      try {
        await client.users.setPresence({ presence: "away" });
        log.info("Slack presence set to away");
      } catch (err: unknown) {
        log.error("Failed to set Slack presence to away", { error: (err as Error).message });
      }
    },
  };
}
