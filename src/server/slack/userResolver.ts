import { WebClient } from "@slack/web-api";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:slack:users");

export interface SlackUser {
  id: string;
  displayName: string;
  realName: string;
  avatar?: string;
}

const cache = new Map<string, SlackUser>();
let webClient: WebClient | null = null;

export function initUserResolver(botToken: string) {
  webClient = new WebClient(botToken);
}

export async function resolveSlackUser(userId: string): Promise<SlackUser> {
  const cached = cache.get(userId);
  if (cached) return cached;

  if (!webClient) {
    return { id: userId, displayName: userId, realName: userId };
  }

  try {
    const result = await webClient.users.info({ user: userId });
    // biome-ignore lint/suspicious/noExplicitAny: Slack API type
    const u = result.user as any;
    // display_name can be "" for users who haven't set one — fall through
    const displayName =
      u?.profile?.display_name?.trim() ||
      u?.real_name ||
      u?.profile?.real_name ||
      u?.name ||
      userId;
    const resolved: SlackUser = {
      id: userId,
      displayName,
      realName: u?.real_name || u?.profile?.real_name || userId,
      avatar: u?.profile?.image_48,
    };
    cache.set(userId, resolved);
    log.info("Resolved Slack user", { userId, displayName: resolved.displayName });
    return resolved;
  } catch (err: unknown) {
    log.warn("Failed to resolve Slack user (not caching)", {
      userId,
      error: (err as Error).message,
      code: (err as { code?: string }).code,
      data: (err as { data?: unknown }).data,
    });
    // Don't cache failures — allow retries on next request
    return { id: userId, displayName: userId, realName: userId };
  }
}

export async function resolveDisplayName(userId: string): Promise<string> {
  const user = await resolveSlackUser(userId);
  return user.displayName;
}
