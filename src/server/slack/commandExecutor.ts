import { createLogger } from "../../shared/logger.js";
import type { JobAttachment } from "../../shared/types.js";
import { executeAction } from "../routing/executors.js";
import { getRoutingConfig } from "../routing/index.js";
import type { RoutedAction } from "./messageRouter.js";

const log = createLogger("server:slack:commands");

export interface CommandResult {
  reply: string;
  actionTaken: string;
  taskId?: string;
  images?: Array<{ url: string; alt?: string }>;
}

export interface CommandContext {
  userId: string;
  ownerId: string;
  source: "slack" | "discord" | "web";
  eventId: string;
  attachments?: JobAttachment[];
  slack?: { channelId: string; threadTs: string; messageTs: string };
  discord?: { channelId: string; threadId: string; messageId: string; guildId?: string };
  web?: { conversationId: string };
  githubUsername?: string;
  githubOrg?: string;
  githubTeamSlug?: string;
}

/**
 * Execute a routed action by looking up its execution definition from the
 * YAML routing config and delegating to the appropriate generic executor.
 */
export async function executeCommand(
  action: RoutedAction,
  ctx: CommandContext,
): Promise<CommandResult> {
  const { command } = action;

  try {
    const config = getRoutingConfig();
    const actionDef = config.actions[command] ?? config.custom_actions[command];

    if (!actionDef) {
      // Unknown action — treat as chat (passthrough)
      log.warn("No action definition found in routing config", { command });
      return { reply: action.reply, actionTaken: "chat" };
    }

    return await executeAction(action, ctx, actionDef.execution);
  } catch (err: unknown) {
    // If routing config is not initialized, fall back to chat
    log.error("Command execution failed", { command, error: (err as Error).message });
    return { reply: action.reply, actionTaken: `${command}: error` };
  }
}
