/**
 * Pipeline C: Signal Collection
 *
 * Timer-based pipeline that batch-processes episodes past the signal delay
 * threshold, detecting implicit and explicit feedback signals from user behavior.
 *
 * Zero LLM cost — uses pattern matching, embedding similarity, and MongoDB lookups.
 * See §6.3 of the memory design spec.
 */

import { createLogger } from "../../../shared/logger.js";
import type {
  InteractionEpisode,
  MemoryConfig,
  OutcomeSignal,
} from "../../../shared/memoryTypes.js";
import { findConversation } from "../../chat/conversationRepo.js";
import { findJobByTaskId } from "../../jobs/jobRepo.js";
import { getEmbeddingProvider } from "../../kb/embeddings.js";
import { appendSignals, listEpisodes } from "../episodeRepo.js";

const log = createLogger("server:memory:signalCollector");

// ─── Signal Detection Patterns ──────────────────────────────────

export const GRATITUDE_REGEX = /\b(thanks|thank you|perfect|exactly|great|awesome)\b/i;

export const CORRECTION_REGEX =
  /(?:\bno[,.]|\bnope\b|\bwrong\b|\bincorrect\b|\bthat's not\b|\bactually[,.]|\bnot what I meant\b|\bnot right\b)/i;

// ─── Cosine Similarity ──────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Follow-up Message Retrieval ────────────────────────────────

/**
 * Find the next user message after a given episode in the same conversation/thread.
 *
 * For web_chat: query the conversations collection for messages after the episode timestamp.
 * For Slack/Discord: query interaction_episodes for the same source_ref thread/channel
 * with a later timestamp.
 */
export async function findNextUserMessage(
  episode: InteractionEpisode,
): Promise<{ text: string; timestamp: Date } | null> {
  if (episode.source === "web_chat" && episode.source_ref.conversation_id) {
    const conversation = await findConversation(episode.source_ref.conversation_id);
    if (!conversation) return null;

    // Find the first user message after the episode timestamp
    for (const msg of conversation.messages) {
      if (msg.role === "user" && msg.at > episode.timestamp) {
        return { text: msg.text, timestamp: msg.at };
      }
    }
    return null;
  }

  // Slack/Discord: query episodes for same thread/channel with later timestamp
  const { episodes } = await listEpisodes({
    owner: episode.owner,
    limit: 50,
  });

  const matchesThread = (ep: InteractionEpisode): boolean => {
    if (ep.episode_id === episode.episode_id) return false;
    if (ep.timestamp <= episode.timestamp) return false;

    if (episode.source_ref.thread_ts && ep.source_ref.thread_ts) {
      return ep.source_ref.thread_ts === episode.source_ref.thread_ts;
    }
    if (episode.source_ref.channel_id && ep.source_ref.channel_id) {
      return ep.source_ref.channel_id === episode.source_ref.channel_id;
    }
    if (episode.source_ref.thread_id && ep.source_ref.thread_id) {
      return ep.source_ref.thread_id === episode.source_ref.thread_id;
    }
    return false;
  };

  // Sort by timestamp ascending and take the first match
  const followUps = episodes
    .filter(matchesThread)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (followUps.length === 0) return null;
  return { text: followUps[0].user_message, timestamp: followUps[0].timestamp };
}

// ─── Signal Detection ───────────────────────────────────────────

/**
 * Detect all signals for a single episode.
 * Returns an array of detected OutcomeSignals.
 */
export async function detectSignals(
  episode: InteractionEpisode,
  config: MemoryConfig,
): Promise<OutcomeSignal[]> {
  const signals: OutcomeSignal[] = [];
  const now = new Date();

  // Check job-related signals first (independent of follow-up messages)
  if (episode.task_id) {
    const jobSignals = await detectJobSignals(episode.task_id);
    signals.push(...jobSignals);
  }

  // Find next user message in the conversation
  const nextMsg = await findNextUserMessage(episode);

  if (!nextMsg) {
    // No follow-up: check for no_response timeout
    const elapsed = now.getTime() - episode.timestamp.getTime();
    if (elapsed >= config.signal_no_response_timeout_ms) {
      signals.push({
        signal_type: "no_response",
        detected_at: now,
        strength: -0.1,
      });
    }
    return signals;
  }

  // Continuation signal: next message exists from same user
  signals.push({
    signal_type: "continuation",
    detected_at: now,
    strength: 0.2,
  });

  // Gratitude signal
  if (GRATITUDE_REGEX.test(nextMsg.text)) {
    signals.push({
      signal_type: "gratitude",
      detected_at: now,
      strength: 0.8,
    });
  }

  // Correction signal
  const correctionMatch = CORRECTION_REGEX.exec(nextMsg.text);
  if (correctionMatch) {
    signals.push({
      signal_type: "correction",
      detected_at: now,
      details: nextMsg.text.slice(0, 200),
      strength: -0.6,
    });
  }

  // Embedding-based signals: rephrase, follow_up_deeper, topic_change
  try {
    const embeddingSignals = await detectEmbeddingSignals(episode.user_message, nextMsg.text);
    signals.push(...embeddingSignals);
  } catch (err) {
    log.debug("Embedding signal detection failed", {
      episodeId: episode.episode_id,
      error: (err as Error).message,
    });
  }

  return signals;
}

/**
 * Detect signals based on embedding similarity between the original
 * and follow-up user messages.
 */
export async function detectEmbeddingSignals(
  originalMessage: string,
  followUpMessage: string,
): Promise<OutcomeSignal[]> {
  const signals: OutcomeSignal[] = [];
  const now = new Date();

  const embeddingProvider = getEmbeddingProvider();
  const embeddings = await embeddingProvider.embed([originalMessage, followUpMessage]);

  const similarity = cosineSimilarity(embeddings[0], embeddings[1]);

  if (similarity > 0.8) {
    // Rephrase: very similar message → user is rephrasing (unhappy with response)
    signals.push({
      signal_type: "rephrase",
      detected_at: now,
      details: `Similarity: ${similarity.toFixed(3)}`,
      strength: -0.4,
    });
  } else if (
    similarity >= 0.5 &&
    similarity <= 0.8 &&
    followUpMessage.length > originalMessage.length
  ) {
    // Follow-up deeper: moderately similar but longer → user is digging deeper
    signals.push({
      signal_type: "follow_up_deeper",
      detected_at: now,
      details: `Similarity: ${similarity.toFixed(3)}`,
      strength: 0.4,
    });
  } else if (similarity < 0.3) {
    // Topic change: very dissimilar → user moved on
    signals.push({
      signal_type: "topic_change",
      detected_at: now,
      details: `Similarity: ${similarity.toFixed(3)}`,
      strength: 0.0,
    });
  }

  return signals;
}

/**
 * Detect job-related signals by querying the jobs collection.
 */
export async function detectJobSignals(taskId: string): Promise<OutcomeSignal[]> {
  const signals: OutcomeSignal[] = [];
  const now = new Date();

  try {
    const job = await findJobByTaskId(taskId);
    if (!job) return signals;

    if (job.status === "DONE") {
      signals.push({
        signal_type: "job_completed",
        detected_at: now,
        details: `Task ${taskId} completed`,
        strength: 1.0,
      });
    } else if (job.status === "FAILED") {
      signals.push({
        signal_type: "job_failed",
        detected_at: now,
        details: `Task ${taskId} failed${job.error?.message ? `: ${job.error.message.slice(0, 100)}` : ""}`,
        strength: -0.5,
      });
    }
  } catch (err) {
    log.debug("Job signal detection failed", {
      taskId,
      error: (err as Error).message,
    });
  }

  return signals;
}

// ─── Batch Processing ───────────────────────────────────────────

/**
 * Collect signals for all pending episodes past the signal delay threshold.
 * Called periodically by memoryService.ts (default: every 2 minutes).
 */
export async function collectSignals(
  config: MemoryConfig,
): Promise<{ episodes_processed: number; signals_detected: number }> {
  const result = { episodes_processed: 0, signals_detected: 0 };

  // Fetch recent episodes (generous window to find pending ones)
  const { episodes } = await listEpisodes({ limit: 100 });

  const now = new Date();
  const delayThreshold = now.getTime() - config.signal_delay_ms;

  for (const episode of episodes) {
    // Skip if already collected and not stale
    if (episode.signal_collected_at) continue;

    // Skip if not past the signal delay threshold
    if (episode.timestamp.getTime() > delayThreshold) continue;

    try {
      const signals = await detectSignals(episode, config);

      if (signals.length > 0) {
        await appendSignals(episode.episode_id, signals);
        result.signals_detected += signals.length;
      } else {
        // Mark as collected even if no signals detected
        await appendSignals(episode.episode_id, []);
      }

      result.episodes_processed++;
    } catch (err) {
      log.warn("Signal collection failed for episode", {
        episodeId: episode.episode_id,
        error: (err as Error).message,
      });
    }
  }

  if (result.episodes_processed > 0) {
    log.info("Signal collection batch complete", result);
  }

  return result;
}
