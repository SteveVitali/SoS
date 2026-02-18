import { App } from "@slack/bolt";
import { createLogger } from "../../shared/logger.js";
import { createAppMentionHandler, createThreadReplyHandler } from "./eventHandlers.js";
import type { ServerConfig } from "../config.js";
import type { SlackPoster } from "./slackClient.js";

const log = createLogger("server:slack:socket");

// Tracks threads where the bot has responded, so it can listen for follow-ups.
// Key format: "channelId:threadTs". Lost on restart — bot re-engages when re-tagged.
const activeThreads = new Set<string>();

export async function startSlackSocketMode(
  config: ServerConfig,
  slackPoster?: SlackPoster,
): Promise<App> {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const handleMention = createAppMentionHandler(config, slackPoster);
  const handleThreadReply = createThreadReplyHandler(config, slackPoster, activeThreads);

  app.event("app_mention", async ({ event, context, say }) => {
    const eventId = context.eventId || `${event.channel}-${event.ts}`;
    const reply = await handleMention(event as any, eventId);
    if (reply) {
      const threadTs = (event as any).thread_ts ?? event.ts;
      await say({ text: reply, thread_ts: threadTs });
      // Track this thread as active so we listen for follow-up replies
      activeThreads.add(`${event.channel}:${threadTs}`);
    }
  });

  app.event("message", async ({ event, say }) => {
    const msg = event as any;
    // Only handle thread replies (has thread_ts), ignore non-threaded messages
    if (!msg.thread_ts) return;
    // Ignore bot_message subtypes (our own posts come back as messages too)
    if (msg.subtype === "bot_message" || msg.bot_id) return;
    // Ignore if this is also an app_mention (handled above)
    if (msg.subtype === "app_mention") return;

    const reply = await handleThreadReply(msg);
    if (reply) {
      await say({ text: reply, thread_ts: msg.thread_ts });
    }
  });

  await app.start();
  log.info("Slack Socket Mode connected", {
    threadTracking: "enabled",
  });

  return app;
}
