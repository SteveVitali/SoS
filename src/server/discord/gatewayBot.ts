import { Client, GatewayIntentBits, type Message } from "discord.js";
import { createLogger } from "../../shared/logger.js";
import { findImage } from "../chat/imageStore.js";
import type { DiscordPoster } from "./discordClient.js";
import { splitForDiscord } from "./discordClient.js";
import type { DiscordConfig } from "./eventHandlers.js";
import { createDiscordMentionHandler } from "./eventHandlers.js";

const log = createLogger("server:discord:gateway");

export async function createDiscordClient(botToken: string): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(botToken);
  return client;
}

export async function startDiscordBot(
  config: DiscordConfig,
  discordPoster: DiscordPoster,
): Promise<Client> {
  const client = discordPoster.getClient();
  const handleMention = createDiscordMentionHandler(config, discordPoster);

  // Dedup guard: Discord.js can deliver messageCreate more than once during
  // reconnections or shard resumption. Track recently-processed message IDs
  // to prevent duplicate responses.
  const processedMessages = new Set<string>();
  const DEDUP_TTL_MS = 60_000; // forget after 60s

  client.on("messageCreate", async (message: Message) => {
    // Ignore messages from bots (including self)
    if (message.author.bot) return;

    // Only respond when mentioned
    if (!message.mentions.has(config.discordBotUserId)) return;

    // Dedup: skip if we've already processed this message
    if (processedMessages.has(message.id)) {
      log.warn("Duplicate messageCreate event, skipping", {
        messageId: message.id,
        channel: message.channelId,
      });
      return;
    }
    processedMessages.add(message.id);
    setTimeout(() => processedMessages.delete(message.id), DEDUP_TTL_MS);

    const eventId = `${message.channelId}-${message.id}`;

    const isThread = message.channel.isThread();
    const event = {
      userId: message.author.id,
      text: message.content,
      channelId: isThread ? (message.channel.parentId ?? message.channelId) : message.channelId,
      messageId: message.id,
      threadId: isThread ? message.channelId : undefined,
      guildId: message.guildId ?? undefined,
      files: [...message.attachments.values()].map((a) => ({
        id: a.id,
        name: a.name || "unknown",
        mimetype: a.contentType || "application/octet-stream",
        size: a.size || 0,
        url: a.url,
      })),
    };

    const result = await handleMention(event, eventId);

    if (result.reply) {
      const chunks = splitForDiscord(result.reply);
      for (const chunk of chunks) {
        try {
          // Reply in the thread if in one, otherwise reply to the message
          if (message.channel.isThread()) {
            await message.channel.send(chunk);
          } else {
            await message.reply(chunk);
          }
        } catch (err: unknown) {
          log.error("Failed to send Discord reply", {
            error: (err as Error).message,
            channel: message.channelId,
          });
        }
      }

      // Upload generated images to the channel/thread
      if (result.images?.length && discordPoster) {
        for (const imgRef of result.images) {
          try {
            const imageId = imgRef.url.split("/").pop();
            if (!imageId) continue;
            const doc = await findImage(imageId);
            if (!doc) {
              log.warn("Image not found for Discord upload", { imageId });
              continue;
            }
            const buf = Buffer.from(doc.base64, "base64");
            await discordPoster.uploadFile(
              message.channelId,
              message.channel.isThread() ? message.channelId : "",
              buf,
              "generated-image.png",
              imgRef.alt || "Generated image",
            );
          } catch (err: unknown) {
            log.error("Failed to upload image to Discord", {
              error: (err as Error).message,
            });
          }
        }
      }
    }
  });

  log.info("Discord bot gateway connected");
  return client;
}
