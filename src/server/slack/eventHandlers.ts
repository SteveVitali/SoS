import { createLogger } from "../../shared/logger.js";
import { createJobFromSlack } from "../jobs/jobService.js";
import type { ServerConfig } from "../config.js";

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
  return async (event: SlackMentionEvent, eventId: string) => {
    log.info("app_mention received", {
      user: event.user,
      channel: event.channel,
      event_id: eventId,
    });

    // Strip bot mention from text
    const botMentionRegex = new RegExp(`<@${config.slackBotUserId}>\\s*`, "g");
    let taskText = event.text.replace(botMentionRegex, "").trim();

    // Parse modifiers
    const modifiers = parseModifiers(taskText);

    // Remove modifier tokens from task text for cleanliness
    taskText = taskText
      .replace(/\brepo=\S+/gi, "")
      .replace(/\btests=(fast|full|none)\b/gi, "")
      .replace(/\bci_fix=(on|off)\b/gi, "")
      .replace(/\breview=\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!taskText) {
      log.warn("Empty task text after stripping mentions/modifiers", { event_id: eventId });
      taskText = "(no task description provided)";
    }

    try {
      const { job, created } = await createJobFromSlack({
        event_id: eventId,
        requested_by: event.user,
        task_text: taskText,
        channel_id: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        message_ts: event.ts,
        ...modifiers,
      });

      if (created) {
        log.info("Job created from Slack mention", { task_id: job.task_id });
      } else {
        log.info("Duplicate event, job already exists", { task_id: job.task_id, event_id: eventId });
      }
    } catch (err: any) {
      log.error("Failed to create job from Slack mention", { error: err.message, event_id: eventId });
    }
  };
}
