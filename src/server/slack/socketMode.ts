import { App } from "@slack/bolt";
import { createLogger } from "../../shared/logger.js";
import { markdownToSlack } from "../../shared/slackMarkdown.js";
import { findImage } from "../chat/imageStore.js";
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
    const result = await handleMention(event as any, eventId);
    if (result.reply) {
      // biome-ignore lint/suspicious/noExplicitAny: Slack API type
      const threadTs = (event as any).thread_ts ?? event.ts;
      const chunks = splitForSlack(markdownToSlack(result.reply));
      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadTs });
      }

      // Upload generated images to the Slack thread
      if (result.images?.length && slackPoster) {
        for (const imgRef of result.images) {
          try {
            const imageId = imgRef.url.split("/").pop();
            if (!imageId) continue;
            const doc = await findImage(imageId);
            if (!doc) {
              log.warn("Image not found for Slack upload", { imageId });
              continue;
            }
            const buf = Buffer.from(doc.base64, "base64");
            await slackPoster.uploadFile(
              event.channel,
              threadTs,
              buf,
              "generated-image.png",
              imgRef.alt || "Generated image",
            );
          } catch (err: unknown) {
            log.error("Failed to upload image to Slack", {
              error: (err as Error).message,
            });
          }
        }
      }
    }
  });

  await app.start();
  log.info("Slack Socket Mode connected");

  return app;
}
