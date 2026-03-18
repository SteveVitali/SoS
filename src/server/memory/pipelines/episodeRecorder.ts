/**
 * Pipeline A: Episode Recording
 *
 * Records every interaction as an InteractionEpisode document.
 * Zero LLM cost — pure data capture with truncation.
 */

import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../../shared/logger.js";
import type { InteractionEpisode, InteractionSource } from "../../../shared/memoryTypes.js";
import { insertEpisode } from "../episodeRepo.js";

const log = createLogger("server:memory:episodeRecorder");

const MAX_ACTION_ARGS_SUMMARY = 200;
const MAX_RESPONSE_SUMMARY = 500;

/**
 * Truncate a string to a maximum length, appending "…" if truncated.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Build a summary of action args, stripping sensitive data and truncating.
 */
function summarizeActionArgs(args: Record<string, unknown>): string {
  // Strip potentially sensitive keys
  const sanitized = { ...args };
  for (const key of ["api_key", "token", "password", "secret", "base64"]) {
    if (key in sanitized) sanitized[key] = "[REDACTED]";
  }
  const json = JSON.stringify(sanitized);
  return truncate(json, MAX_ACTION_ARGS_SUMMARY);
}

/**
 * Record an interaction episode.
 * Returns the episode_id of the newly created document.
 */
export async function recordEpisode(params: {
  owner: string;
  source: InteractionSource;
  sourceRef: InteractionEpisode["source_ref"];
  userMessage: string;
  routedAction: string;
  actionArgs: Record<string, unknown>;
  responseSummary: string;
  taskId?: string;
  researchSessionId?: string;
}): Promise<string> {
  const episodeId = uuidv4();

  const episode: InteractionEpisode = {
    episode_id: episodeId,
    owner: params.owner,
    source: params.source,
    source_ref: params.sourceRef,
    user_message: params.userMessage,
    routed_action: params.routedAction,
    action_args_summary: summarizeActionArgs(params.actionArgs),
    response_summary: truncate(params.responseSummary, MAX_RESPONSE_SUMMARY),
    task_id: params.taskId,
    research_session_id: params.researchSessionId,
    signals: [],
    timestamp: new Date(),
    extraction_status: "pending",
    extracted_memory_ids: [],
  };

  await insertEpisode(episode);

  log.info("Episode recorded", {
    episode_id: episodeId,
    owner: params.owner,
    source: params.source,
    action: params.routedAction,
  });

  return episodeId;
}
