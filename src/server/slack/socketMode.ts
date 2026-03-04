import { App } from "@slack/bolt";
import { createLogger } from "../../shared/logger.js";
import { markdownToSlack } from "../../shared/slackMarkdown.js";
import type { ServerConfig } from "../config.js";
import { createAppMentionHandler } from "./eventHandlers.js";
import type { SlackPoster } from "./slackClient.js";
import { splitForSlack } from "./slackClient.js";

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
    // biome-ignore lint/suspicious/noExplicitAny: Slack API type
    const reply = await handleMention(event as any, eventId);
    if (reply) {
      // biome-ignore lint/suspicious/noExplicitAny: Slack API type
      const threadTs = (event as any).thread_ts ?? event.ts;
      const chunks = splitForSlack(markdownToSlack(reply));
      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadTs });
      }
    }
  });

  await app.start();
  log.info("Slack Socket Mode connected");

  return app;
}
