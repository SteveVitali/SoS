import { createLogger } from "../../shared/logger.js";
import type { JobAttachment } from "../../shared/types.js";
import { onInteractionComplete } from "../memory/index.js";
import { executeCommand } from "../slack/commandExecutor.js";
import type { ThreadMessage } from "../slack/messageRouter.js";
import { formatRoutingError, routeMessage } from "../slack/messageRouter.js";
import type { DiscordFileInfo, DiscordPoster, DiscordThreadMessage } from "./discordClient.js";

export interface MentionHandlerResult {
  reply: string;
  images?: Array<{ url: string; alt?: string }>;
}

const log = createLogger("server:discord:events");

interface DiscordMentionEvent {
  userId: string;
  text: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  guildId?: string;
  files?: Array<{ id: string; name: string; mimetype: string; size: number; url: string }>;
}

export interface DiscordConfig {
  discordBotUserId: string;
  discordJobOwner: string;
  maxThreadMessages: number;
  maxAttachmentSizeMb: number;
  githubUsername?: string;
  githubOrg?: string;
  githubTeamSlug?: string;
}

async function fetchThreadContext(
  discordPoster: DiscordPoster | undefined,
  channelId: string,
  threadId: string,
  botUserId: string,
  maxMessages: number,
): Promise<{ messages: ThreadMessage[]; rawMessages: DiscordThreadMessage[] }> {
  if (!discordPoster) return { messages: [], rawMessages: [] };

  try {
    const rawMessages = await discordPoster.fetchThread(channelId, threadId, maxMessages);
    const messages = rawMessages.map((m) => ({
      user: m.user || "unknown",
      text: m.text || "",
      ts: m.id || "",
      isBot: m.user === botUserId,
    }));
    return { messages, rawMessages };
  } catch (err: unknown) {
    log.warn("Failed to fetch thread context", { error: (err as Error).message });
    return { messages: [], rawMessages: [] };
  }
}

async function downloadThreadAttachments(
  discordPoster: DiscordPoster,
  rawMessages: DiscordThreadMessage[],
  maxSizeMb: number,
): Promise<JobAttachment[]> {
  const maxSizeBytes = maxSizeMb * 1024 * 1024;
  const attachments: JobAttachment[] = [];
  let totalSize = 0;

  // Collect all files from messages, newest-first
  const allFiles: DiscordFileInfo[] = [];
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    for (const file of rawMessages[i].files) {
      allFiles.push(file);
    }
  }

  if (allFiles.length === 0) return [];

  log.info("Downloading thread attachments", {
    fileCount: allFiles.length,
    maxSizeMb,
  });

  for (const file of allFiles) {
    // Stop if adding this file would exceed the budget
    if (totalSize + file.size > maxSizeBytes) {
      log.info("Attachment budget reached, skipping remaining files", {
        totalSize,
        skippedFile: file.name,
        skippedFileSize: file.size,
      });
      break;
    }

    try {
      const buffer = await discordPoster.downloadFile(file.url);
      attachments.push({
        file_id: file.id,
        filename: file.name,
        mimetype: file.mimetype,
        size_bytes: buffer.length,
        base64: buffer.toString("base64"),
      });
      totalSize += buffer.length;
      log.info("Downloaded attachment", {
        file_id: file.id,
        filename: file.name,
        size: buffer.length,
        totalSize,
      });
    } catch (err: unknown) {
      log.warn("Failed to download attachment, skipping", {
        file_id: file.id,
        filename: file.name,
        error: (err as Error).message,
      });
    }
  }

  return attachments;
}

export function createDiscordMentionHandler(config: DiscordConfig, discordPoster?: DiscordPoster) {
  return async (event: DiscordMentionEvent, eventId: string): Promise<MentionHandlerResult> => {
    log.info("Discord mention received", {
      user: event.userId,
      channel: event.channelId,
      event_id: eventId,
    });

    // Strip bot mention from text
    const botMentionRegex = new RegExp(`<@!?${config.discordBotUserId}>\\s*`, "g");
    const cleanText = event.text.replace(botMentionRegex, "").trim();

    if (!cleanText) {
      return { reply: "You rang? Try telling me what you need — or ask what I can do." };
    }

    // In Discord, threadId is the thread channel; if not in a thread, use the message's channel
    const threadId = event.threadId ?? event.channelId;

    const ctx = {
      userId: event.userId,
      ownerId: config.discordJobOwner,
      source: "discord" as const,
      eventId,
      discord: {
        channelId: event.channelId,
        threadId,
        messageId: event.messageId,
        guildId: event.guildId,
      },
    };

    // Fetch thread context if this is a reply in an existing thread
    let threadMessages: ThreadMessage[] | undefined;
    let attachments: JobAttachment[] | undefined;

    if (event.threadId && discordPoster) {
      const { messages, rawMessages } = await fetchThreadContext(
        discordPoster,
        event.channelId,
        event.threadId,
        config.discordBotUserId,
        config.maxThreadMessages,
      );
      if (messages.length > 0) threadMessages = messages;

      // Download files from thread, newest-first, up to budget
      const downloaded = await downloadThreadAttachments(
        discordPoster,
        rawMessages,
        config.maxAttachmentSizeMb,
      );
      if (downloaded.length > 0) attachments = downloaded;
    } else if (event.files && event.files.length > 0 && discordPoster) {
      // Top-level message with files — build a synthetic message list
      const eventFiles: DiscordFileInfo[] = event.files
        .filter((f) => f.url)
        .map((f) => ({
          id: f.id,
          name: f.name || "unknown",
          mimetype: f.mimetype || "application/octet-stream",
          size: f.size || 0,
          url: f.url,
        }));
      if (eventFiles.length > 0) {
        const syntheticMessages: DiscordThreadMessage[] = [
          { user: event.userId, text: cleanText, id: event.messageId, files: eventFiles },
        ];
        const downloaded = await downloadThreadAttachments(
          discordPoster,
          syntheticMessages,
          config.maxAttachmentSizeMb,
        );
        if (downloaded.length > 0) attachments = downloaded;
      }
    }

    try {
      // Route through LLM to classify intent and generate response
      const action = await routeMessage(cleanText, event.userId, threadMessages, attachments);
      log.info("Routed action", { command: action.command, event_id: eventId });

      if (action.command === "no_op") {
        log.info("LLM chose no_op", { reason: action.args.reason, event_id: eventId });
        onInteractionComplete({
          owner: config.discordJobOwner,
          source: "discord",
          sourceRef: {
            channel_id: event.channelId,
            thread_id: event.threadId,
            message_id: event.messageId,
          },
          userMessage: cleanText,
          routedAction: "no_op",
          actionArgs: action.args,
          responseSummary: "",
        }).catch((err) =>
          log.warn("Memory episode recording failed", { error: (err as Error).message }),
        );
        return { reply: "" };
      }

      // Execute the command (pass attachments + github config for job creation)
      const result = await executeCommand(action, {
        ...ctx,
        attachments,
        githubUsername: config.githubUsername || undefined,
        githubOrg: config.githubOrg || undefined,
        githubTeamSlug: config.githubTeamSlug || undefined,
      });
      log.info("Command executed", { action: result.actionTaken, event_id: eventId });

      onInteractionComplete({
        owner: config.discordJobOwner,
        source: "discord",
        sourceRef: {
          channel_id: event.channelId,
          thread_id: event.threadId,
          message_id: event.messageId,
        },
        userMessage: cleanText,
        routedAction: action.command,
        actionArgs: action.args,
        responseSummary: result.reply.slice(0, 500),
        taskId: result.taskId,
      }).catch((err) =>
        log.warn("Memory episode recording failed", { error: (err as Error).message }),
      );

      return { reply: result.reply, images: result.images };
    } catch (err: unknown) {
      const errMsg = (err as Error).message || "unknown error";
      log.error("Message routing failed", {
        error: errMsg,
        event_id: eventId,
      });

      return {
        reply: formatRoutingError(errMsg),
      };
    }
  };
}
