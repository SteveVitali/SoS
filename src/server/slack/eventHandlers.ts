import { createLogger } from "../../shared/logger.js";
import { createJobFromSlack } from "../jobs/jobService.js";
import type { ServerConfig } from "../config.js";
import { routeMessage } from "./messageRouter.js";
import { executeCommand } from "./commandExecutor.js";

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

export function createAppMentionHandler(config: ServerConfig) {
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

    const ctx = {
      userId: event.user,
      ownerId: config.slackJobOwner,
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      messageTs: event.ts,
      eventId,
    };

    try {
      // Route through LLM to classify intent and generate response
      const action = await routeMessage(cleanText, event.user);
      log.info("Routed action", { command: action.command, event_id: eventId });

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
          requested_by: config.slackJobOwner || event.user,
          slack_requester: event.user,
          task_text: taskText,
          channel_id: event.channel,
          thread_ts: event.thread_ts ?? event.ts,
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
