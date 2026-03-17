import {
  AttachmentBuilder,
  type Client,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";
import type { NotificationPoster } from "../notifications/poster.js";
import {
  fmtCanceled,
  fmtClaimed,
  fmtDone,
  fmtEvent,
  fmtFailed,
  fmtPlan,
  fmtQueued,
} from "../slack/formatting.js";

const log = createLogger("server:discord");

const DISCORD_MAX_CHARS = 2000;

export interface DiscordFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url: string;
}

export interface DiscordThreadMessage {
  user: string;
  text: string;
  id: string;
  files: DiscordFileInfo[];
}

export interface DiscordPoster extends NotificationPoster {
  fetchThread(channelId: string, threadId: string, limit?: number): Promise<DiscordThreadMessage[]>;
  downloadFile(url: string): Promise<Buffer>;
  uploadFile(
    channelId: string,
    threadId: string,
    file: Buffer,
    filename: string,
    title?: string,
  ): Promise<void>;
  getClient(): Client;
}

/**
 * Split a message into chunks that fit within Discord's 2000-char limit.
 * Splits at paragraph boundaries when possible, then single newlines, then hard-cuts.
 */
export function splitForDiscord(text: string): string[] {
  if (text.length <= DISCORD_MAX_CHARS) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > DISCORD_MAX_CHARS) {
    let splitIdx = -1;

    // Prefer splitting at a paragraph boundary (double newline)
    const paraBreak = remaining.lastIndexOf("\n\n", DISCORD_MAX_CHARS);
    if (paraBreak > DISCORD_MAX_CHARS * 0.3) {
      splitIdx = paraBreak;
    } else {
      // Fall back to single newline
      const lineBreak = remaining.lastIndexOf("\n", DISCORD_MAX_CHARS);
      if (lineBreak > DISCORD_MAX_CHARS * 0.3) {
        splitIdx = lineBreak;
      } else {
        // Hard cut at limit
        splitIdx = DISCORD_MAX_CHARS;
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

export function createDiscordPoster(client: Client, notifyUserId?: string): DiscordPoster {
  async function getChannel(channelId: string): Promise<TextChannel | ThreadChannel | null> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) return null;
      if (channel.isTextBased() && "send" in channel) {
        return channel as TextChannel | ThreadChannel;
      }
      return null;
    } catch (err: unknown) {
      log.error("Failed to fetch Discord channel", {
        error: (err as Error).message,
        channelId,
      });
      return null;
    }
  }

  async function postToThread(channelId: string, threadId: string | undefined, text: string) {
    // If we have a threadId, post to the thread; otherwise post to the channel
    const targetId = threadId || channelId;
    const channel = await getChannel(targetId);
    if (!channel) {
      log.warn("Discord channel not found, skipping notification", { channelId: targetId });
      return;
    }

    const chunks = splitForDiscord(text);
    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i];
      // Append notify mention to the last chunk only
      if (notifyUserId && i === chunks.length - 1) {
        chunk += `\n<@${notifyUserId}>`;
      }
      try {
        await channel.send(chunk);
      } catch (err: unknown) {
        log.error("Failed to post Discord message", {
          error: (err as Error).message,
          channel: targetId,
          chunk: `${i + 1}/${chunks.length}`,
        });
      }
    }
  }

  return {
    async postQueued(job: JobDoc) {
      if (!job.discord?.channel_id) return;
      await postToThread(job.discord.channel_id, job.discord.thread_id, fmtQueued(job));
    },

    async postClaimed(job: JobDoc) {
      if (!job.discord?.channel_id) return;
      await postToThread(job.discord.channel_id, job.discord.thread_id, fmtClaimed(job));
    },

    async postDone(job: JobDoc) {
      if (!job.discord?.channel_id) return;
      await postToThread(job.discord.channel_id, job.discord.thread_id, fmtDone(job));
    },

    async postFailed(job: JobDoc) {
      if (!job.discord?.channel_id) return;
      await postToThread(job.discord.channel_id, job.discord.thread_id, fmtFailed(job));
    },

    async postCanceled(job: JobDoc) {
      if (!job.discord?.channel_id) return;
      await postToThread(job.discord.channel_id, job.discord.thread_id, fmtCanceled(job));
    },

    async postPlan(job: JobDoc) {
      if (!job.discord?.channel_id) return;
      await postToThread(job.discord.channel_id, job.discord.thread_id, fmtPlan(job));
    },

    // biome-ignore lint/suspicious/noExplicitAny: dynamic payload type
    async postEvent(job: JobDoc, type: string, payload?: any) {
      if (!job.discord?.channel_id) return;
      const text = fmtEvent(job, type, payload);
      await postToThread(job.discord.channel_id, job.discord.thread_id, text);
    },

    async fetchThread(
      channelId: string,
      threadId: string,
      limit = 20,
    ): Promise<DiscordThreadMessage[]> {
      try {
        const channel = await getChannel(threadId || channelId);
        if (!channel) return [];

        const messages = await channel.messages.fetch({ limit });
        // Discord returns newest-first; reverse to chronological order
        const sorted = [...messages.values()].reverse();

        return sorted.map((m: Message) => ({
          user: m.author.id,
          text: m.content?.slice(0, 2000) || "",
          id: m.id,
          files: [...m.attachments.values()].map((a) => ({
            id: a.id,
            name: a.name || "unknown",
            mimetype: a.contentType || "application/octet-stream",
            size: a.size || 0,
            url: a.url,
          })),
        }));
      } catch (err: unknown) {
        log.error("Failed to fetch Discord thread", { error: (err as Error).message });
        return [];
      }
    },

    async downloadFile(url: string): Promise<Buffer> {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },

    async uploadFile(
      channelId: string,
      threadId: string,
      file: Buffer,
      filename: string,
      title?: string,
    ): Promise<void> {
      try {
        const targetId = threadId || channelId;
        const channel = await getChannel(targetId);
        if (!channel) return;

        const attachment = new AttachmentBuilder(file, {
          name: filename,
          description: title || filename,
        });
        await channel.send({ files: [attachment] });
      } catch (err: unknown) {
        log.error("Failed to upload file to Discord", {
          error: (err as Error).message,
          channel: channelId,
          filename,
        });
      }
    },

    async setPresenceActive() {
      try {
        client.user?.setPresence({ status: "online" });
        log.info("Discord presence set to online");
      } catch (err: unknown) {
        log.error("Failed to set Discord presence to online", { error: (err as Error).message });
      }
    },

    async setPresenceAway() {
      try {
        client.user?.setPresence({ status: "idle" });
        log.info("Discord presence set to idle");
      } catch (err: unknown) {
        log.error("Failed to set Discord presence to idle", { error: (err as Error).message });
      }
    },

    getClient() {
      return client;
    },
  };
}
