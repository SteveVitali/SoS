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
    const u = result.user as any;
    const resolved: SlackUser = {
      id: userId,
      displayName: u?.profile?.display_name || u?.name || userId,
      realName: u?.real_name || u?.profile?.real_name || userId,
      avatar: u?.profile?.image_48,
    };
    cache.set(userId, resolved);
    log.info("Resolved Slack user", { userId, displayName: resolved.displayName });
    return resolved;
  } catch (err: any) {
    log.warn("Failed to resolve Slack user", { userId, error: err.message });
    const fallback: SlackUser = { id: userId, displayName: userId, realName: userId };
    cache.set(userId, fallback);
    return fallback;
  }
}

export async function resolveDisplayName(userId: string): Promise<string> {
  const user = await resolveSlackUser(userId);
  return user.displayName;
}
