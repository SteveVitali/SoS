import { createLogger } from "../../shared/logger.js";
import { createJobFromSlack } from "../jobs/jobService.js";
import type { ServerConfig } from "../config.js";
import { routeMessage } from "./messageRouter.js";
import type { ThreadMessage } from "./messageRouter.js";
import { executeCommand } from "./commandExecutor.js";
import type { SlackPoster } from "./slackClient.js";

const log = createLogger("server:slack:events");

interface SlackMentionEvent {
  type: string;
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  event_ts: string;
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

async function fetchThreadContext(
  slackPoster: SlackPoster | undefined,
  channelId: string,
  threadTs: string,
  botUserId: string,
): Promise<ThreadMessage[]> {
  if (!slackPoster) return [];

  try {
    const rawMessages = await slackPoster.fetchThread(channelId, threadTs, 20);
    return rawMessages.map((m: any) => ({
      user: m.user || "unknown",
      text: m.text || "",
      ts: m.ts || "",
      isBot: m.user === botUserId,
    }));
  } catch (err: any) {
    log.warn("Failed to fetch thread context", { error: err.message });
    return [];
  }
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
      channelId: event.channel,
      threadTs,
      messageTs: event.ts,
      eventId,
    };

    // Fetch thread context if this is a reply in an existing thread
    const threadMessages = event.thread_ts
      ? await fetchThreadContext(slackPoster, event.channel, threadTs, config.slackBotUserId)
      : undefined;

    try {
      // Route through LLM to classify intent and generate response
      const action = await routeMessage(cleanText, event.user, threadMessages);
      log.info("Routed action", { command: action.command, event_id: eventId });

      if (action.command === "no_op") {
        log.info("LLM chose no_op", { reason: action.args.reason, event_id: eventId });
        return "";
      }

      // Execute the command
      const result = await executeCommand(action, ctx);
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

export function createThreadReplyHandler(
  config: ServerConfig,
  slackPoster: SlackPoster | undefined,
  activeThreads: Set<string>,
) {
  return async (event: SlackMentionEvent): Promise<string> => {
    const threadTs = event.thread_ts;
    if (!threadTs) return ""; // Not a thread reply

    const threadKey = `${event.channel}:${threadTs}`;

    // Ignore if the bot itself sent this message
    if (event.user === config.slackBotUserId) return "";

    // Only process threads the bot is active in
    if (!activeThreads.has(threadKey)) return "";

    log.info("Thread reply in active thread", {
      user: event.user,
      channel: event.channel,
      thread_ts: threadTs,
    });

    // Fetch full thread context
    const threadMessages = await fetchThreadContext(
      slackPoster,
      event.channel,
      threadTs,
      config.slackBotUserId,
    );

    if (threadMessages.length === 0) return "";

    // Strip bot mention from text
    const botMentionRegex = new RegExp(`<@${config.slackBotUserId}>\\s*`, "g");
    const cleanText = event.text.replace(botMentionRegex, "").trim();

    const ctx = {
      userId: event.user,
      ownerId: config.slackJobOwner,
      channelId: event.channel,
      threadTs,
      messageTs: event.ts,
      eventId: `${event.channel}-${event.ts}`,
    };

    try {
      const action = await routeMessage(cleanText, event.user, threadMessages);
      log.info("Thread reply routed", { command: action.command, thread_ts: threadTs });

      if (action.command === "no_op") {
        log.info("LLM chose no_op for thread reply", { reason: action.args.reason });
        return "";
      }

      const result = await executeCommand(action, ctx);
      return result.reply;
    } catch (err: any) {
      log.error("Thread reply routing failed", { error: err.message });
      return "";
    }
  };
}
