import { App } from "@slack/bolt";
import { createLogger } from "../../shared/logger.js";
import { createAppMentionHandler } from "./eventHandlers.js";
import type { ServerConfig } from "../config.js";
import type { SlackPoster } from "./slackClient.js";

const log = createLogger("server:slack:socket");

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

  app.event("app_mention", async ({ event, context, say }) => {
    const eventId = context.eventId || `${event.channel}-${event.ts}`;
    const reply = await handleMention(event as any, eventId);
    if (reply) {
      const threadTs = (event as any).thread_ts ?? event.ts;
      await say({ text: reply, thread_ts: threadTs });
    }
  });

  await app.start();
  log.info("Slack Socket Mode connected");

  return app;
}
