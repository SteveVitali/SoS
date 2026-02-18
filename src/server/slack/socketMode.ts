import { App } from "@slack/bolt";
import { createLogger } from "../../shared/logger.js";
import { createAppMentionHandler } from "./eventHandlers.js";
import type { ServerConfig } from "../config.js";

const log = createLogger("server:slack:socket");

export async function startSlackSocketMode(config: ServerConfig): Promise<App> {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const handleMention = createAppMentionHandler(config);

  app.event("app_mention", async ({ event, context, say }) => {
    const eventId = context.eventId || `${event.channel}-${event.ts}`;
    const reply = await handleMention(event as any, eventId);
    if (reply) {
      await say({ text: reply, thread_ts: (event as any).thread_ts ?? event.ts });
    }
  });

  await app.start();
  log.info("Slack Socket Mode connected");

  return app;
}
