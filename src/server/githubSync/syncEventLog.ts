/**
 * Sync event log — writes to MongoDB github_sync_log and emits events
 * via an in-memory EventEmitter for real-time SSE streaming to the UI.
 */

import { EventEmitter } from "node:events";
import type {
  GitHubSyncLogEntry,
  SyncLogCategory,
  SyncLogLevel,
} from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getSyncLogCollection } from "./githubRepo.js";

const log = createLogger("github:syncEventLog");

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const SYNC_LOG_EVENT = "sync-log-entry";

/** Write a sync log entry to MongoDB and emit it for SSE subscribers. */
export async function writeSyncLog(
  level: SyncLogLevel,
  category: SyncLogCategory,
  message: string,
  details?: GitHubSyncLogEntry["details"],
): Promise<void> {
  const entry: GitHubSyncLogEntry = {
    ts: new Date(),
    level,
    category,
    message,
    details,
  };

  // Emit for SSE subscribers (fire-and-forget)
  emitter.emit(SYNC_LOG_EVENT, entry);

  // Persist to MongoDB (fire-and-forget, don't block sync)
  try {
    await getSyncLogCollection().insertOne(entry as any);
  } catch (err: unknown) {
    log.warn("Failed to persist sync log entry", {
      error: (err as Error).message,
    });
  }
}

/** Subscribe to real-time sync log events. Returns unsubscribe function. */
export function subscribeSyncLog(callback: (entry: GitHubSyncLogEntry) => void): () => void {
  emitter.on(SYNC_LOG_EVENT, callback);
  return () => {
    emitter.off(SYNC_LOG_EVENT, callback);
  };
}

/** Fetch recent sync log entries from MongoDB. */
export async function getRecentSyncLogs(opts?: {
  limit?: number;
  since?: Date;
  category?: SyncLogCategory;
}): Promise<GitHubSyncLogEntry[]> {
  const filter: Record<string, unknown> = {};
  if (opts?.since) {
    filter.ts = { $gte: opts.since };
  }
  if (opts?.category) {
    filter.category = opts.category;
  }

  return getSyncLogCollection()
    .find(filter as any)
    .sort({ ts: -1 })
    .limit(opts?.limit || 100)
    .toArray();
}
