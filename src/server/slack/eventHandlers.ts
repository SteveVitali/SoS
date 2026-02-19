import { createLogger } from "../../shared/logger.js";
import type { JobAttachment } from "../../shared/types.js";
import type { ServerConfig } from "../config.js";
import { createJobFromSlack } from "../jobs/jobService.js";
import { executeCommand } from "./commandExecutor.js";
import type { ThreadMessage } from "./messageRouter.js";
import { routeMessage } from "./messageRouter.js";
import type { SlackFileInfo, SlackPoster, SlackThreadMessage } from "./slackClient.js";

const log = createLogger("server:slack:events");

interface SlackMentionEvent {
  type: string;
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  event_ts: string;
  files?: Array<{ id: string; name: string; mimetype: string; size: number; url_private: string }>;
}

export function parseModifiers(text: string): {
  repo_hint?: string;
  test_level?: "fast" | "full" | "none";
  ci_fix_enabled?: boolean;
  reviewers?: string[];
} {
  const result: any = {};

  const repoMatch = text.match(/\brepo=(\S+)/i);
  if (repoMatch) result.repo_hint = repoMatch[1];

  const testsMatch = text.match(/\btests=(fast|full|none)\b/i);
  if (testsMatch) result.test_level = testsMatch[1].toLowerCase();

  const ciFixMatch = text.match(/\bci_fix=(on|off)\b/i);
  if (ciFixMatch) result.ci_fix_enabled = ciFixMatch[1].toLowerCase() === "on";

  const reviewMatch = text.match(/\breview=(\S+)/i);
  if (reviewMatch) {
    result.reviewers = reviewMatch[1]
      .split(",")
      .map((r: string) => r.trim().replace(/^@/, ""))
      .filter(Boolean);
  }

  return result;
}

const _IMAGE_MIMETYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

async function fetchThreadContext(
  slackPoster: SlackPoster | undefined,
  channelId: string,
  threadTs: string,
  botUserId: string,
  maxMessages: number,
): Promise<{ messages: ThreadMessage[]; rawMessages: SlackThreadMessage[] }> {
  if (!slackPoster) return { messages: [], rawMessages: [] };

  try {
    const rawMessages = await slackPoster.fetchThread(channelId, threadTs, maxMessages);
    const messages = rawMessages.map((m) => ({
      user: m.user || "unknown",
      text: m.text || "",
      ts: m.ts || "",
      isBot: m.user === botUserId,
    }));
    return { messages, rawMessages };
  } catch (err: any) {
    log.warn("Failed to fetch thread context", { error: err.message });
    return { messages: [], rawMessages: [] };
  }
}

async function downloadThreadAttachments(
  slackPoster: SlackPoster,
  rawMessages: SlackThreadMessage[],
  maxSizeMb: number,
): Promise<JobAttachment[]> {
  const maxSizeBytes = maxSizeMb * 1024 * 1024;
  const attachments: JobAttachment[] = [];
  let totalSize = 0;

  // Collect all files from messages, newest-first
  const allFiles: SlackFileInfo[] = [];
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
      const buffer = await slackPoster.downloadFile(file.url_private);
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
    } catch (err: any) {
      log.warn("Failed to download attachment, skipping", {
        file_id: file.id,
        filename: file.name,
        error: err.message,
      });
    }
  }

  return attachments;
}

export function createAppMentionHandler(config: ServerConfig, slackPoster?: SlackPoster) {
  return async (event: SlackMentionEvent, eventId: string): Promise<string> => {
    log.info("app_mention received", {
      user: event.user,
      channel: event.channel,
      event_id: eventId,
    });

    // Strip bot mention from text
    const botMentionRegex = new RegExp(`<@${config.slackBotUserId}>\\s*`, "g");
    const cleanText = event.text.replace(botMentionRegex, "").trim();

    if (!cleanText) {
      return "You rang? Try telling me what you need — or ask what I can do.";
    }

    const threadTs = event.thread_ts ?? event.ts;

    const ctx = {
      userId: event.user,
      ownerId: config.slackJobOwner,
      source: "slack" as const,
      eventId,
      slack: {
        channelId: event.channel,
        threadTs,
        messageTs: event.ts,
      },
    };

    // Fetch thread context if this is a reply in an existing thread
    let threadMessages: ThreadMessage[] | undefined;
    let attachments: JobAttachment[] | undefined;

    if (event.thread_ts && slackPoster) {
      const { messages, rawMessages } = await fetchThreadContext(
        slackPoster,
        event.channel,
        threadTs,
        config.slackBotUserId,
        config.maxThreadMessages,
      );
      if (messages.length > 0) threadMessages = messages;

      // Download files from thread, newest-first, up to budget
      const downloaded = await downloadThreadAttachments(
        slackPoster,
        rawMessages,
        config.maxAttachmentSizeMb,
      );
      if (downloaded.length > 0) attachments = downloaded;
    } else if (event.files && event.files.length > 0 && slackPoster) {
      // Top-level message with files — build a synthetic message list
      const eventFiles: SlackFileInfo[] = event.files
        .filter((f) => f.url_private)
        .map((f) => ({
          id: f.id,
          name: f.name || "unknown",
          mimetype: f.mimetype || "application/octet-stream",
          size: f.size || 0,
          url_private: f.url_private,
        }));
      if (eventFiles.length > 0) {
        const syntheticMessages: SlackThreadMessage[] = [
          { user: event.user, text: cleanText, ts: event.ts, files: eventFiles },
        ];
        const downloaded = await downloadThreadAttachments(
          slackPoster,
          syntheticMessages,
          config.maxAttachmentSizeMb,
        );
        if (downloaded.length > 0) attachments = downloaded;
      }
    }

    try {
      // Route through LLM to classify intent and generate response
      const action = await routeMessage(cleanText, event.user, threadMessages, attachments);
      log.info("Routed action", { command: action.command, event_id: eventId });

      if (action.command === "no_op") {
        log.info("LLM chose no_op", { reason: action.args.reason, event_id: eventId });
        return "";
      }

      // Execute the command (pass attachments for job creation)
      const result = await executeCommand(action, { ...ctx, attachments });
      log.info("Command executed", { action: result.actionTaken, event_id: eventId });

      return result.reply;
    } catch (err: any) {
      log.error("Message routing failed, falling back to direct job creation", {
        error: err.message,
        event_id: eventId,
      });

      // Fallback: parse modifiers and create job directly
      const modifiers = parseModifiers(cleanText);
      let taskText = cleanText
        .replace(/\brepo=\S+/gi, "")
        .replace(/\btests=(fast|full|none)\b/gi, "")
        .replace(/\bci_fix=(on|off)\b/gi, "")
        .replace(/\breview=\S+/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!taskText) taskText = "(no task description provided)";

      try {
        const { job } = await createJobFromSlack({
          event_id: eventId,
          requested_by: event.user,
          slack_requester: event.user,
          task_text: taskText,
          channel_id: event.channel,
          thread_ts: threadTs,
          message_ts: event.ts,
          ...modifiers,
        });
        return `Got it — queued as \`${job.task_id.slice(0, 8)}…\`. _(LLM routing was unavailable)_`;
      } catch (fallbackErr: any) {
        log.error("Fallback job creation also failed", { error: fallbackErr.message });
        return "Something went wrong — I couldn't process that. Try again?";
      }
    }
  };
}
