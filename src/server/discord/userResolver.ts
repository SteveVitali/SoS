import type { Client } from "discord.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:discord:users");

export interface DiscordUser {
  id: string;
  displayName: string;
  realName: string;
  avatar?: string;
}

const cache = new Map<string, DiscordUser>();
let discordClient: Client | null = null;

export function initDiscordUserResolver(client: Client) {
  discordClient = client;
}

export async function resolveDiscordUser(userId: string): Promise<DiscordUser> {
  const cached = cache.get(userId);
  if (cached) return cached;

  if (!discordClient) {
    return { id: userId, displayName: userId, realName: userId };
  }

  try {
    const user = await discordClient.users.fetch(userId);
    const displayName = user.displayName || user.username || userId;
    const resolved: DiscordUser = {
      id: userId,
      displayName,
      realName: user.globalName || user.username || userId,
      avatar: user.avatarURL({ size: 48 }) || undefined,
    };
    cache.set(userId, resolved);
    log.info("Resolved Discord user", { userId, displayName: resolved.displayName });
    return resolved;
  } catch (err: unknown) {
    log.warn("Failed to resolve Discord user (not caching)", {
      userId,
      error: (err as Error).message,
    });
    // Don't cache failures — allow retries on next request
    return { id: userId, displayName: userId, realName: userId };
  }
}

export async function resolveDiscordDisplayName(userId: string): Promise<string> {
  const user = await resolveDiscordUser(userId);
  return user.displayName;
}
