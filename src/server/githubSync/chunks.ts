/**
 * Deterministic epoch-anchored chunk system for GitHub historical backfill.
 *
 * All time is divided into fixed N-day chunks anchored to a configurable epoch.
 * Chunk boundaries are stable regardless of when the code runs, ensuring
 * cache keys never change and historical chunks are fetched exactly once.
 */

import type { ChunkInfo } from "../../shared/githubTypes.js";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Given any date, compute the chunk it belongs to.
 * Chunks are [start, end) — start-inclusive, end-exclusive.
 */
export function getChunkForDate(date: Date, epochDate: Date, chunkDays: number): ChunkInfo {
  const epochMs = epochDate.getTime();
  const dateMs = date.getTime();
  const msSinceEpoch = dateMs - epochMs;
  const chunkMs = chunkDays * MS_PER_DAY;
  const chunkIndex = Math.floor(msSinceEpoch / chunkMs);
  const startMs = epochMs + chunkIndex * chunkMs;
  const endMs = startMs + chunkMs;
  const start = new Date(startMs);
  const end = new Date(endMs);
  return {
    start: toDateStr(start),
    end: toDateStr(end),
    id: `${toDateStr(start)}..${toDateStr(end)}`,
  };
}

/**
 * Generate all chunk boundaries between `since` and `now`.
 * Returns chunks in chronological order (oldest first).
 */
export function getAllChunks(
  since: Date,
  now: Date,
  epochDate: Date,
  chunkDays: number,
): ChunkInfo[] {
  const chunks: ChunkInfo[] = [];
  let current = getChunkForDate(since, epochDate, chunkDays);
  const nowMs = now.getTime();

  while (new Date(current.start).getTime() < nowMs) {
    chunks.push(current);
    const nextStart = new Date(new Date(current.end).getTime());
    current = getChunkForDate(nextStart, epochDate, chunkDays);
  }

  return chunks;
}

/**
 * Determine whether a chunk is "current" (contains today) or "historical".
 * Historical chunks are immutable once synced.
 */
export function isCurrentChunk(chunk: ChunkInfo, now: Date): boolean {
  const endMs = new Date(chunk.end).getTime();
  const startMs = new Date(chunk.start).getTime();
  const nowMs = now.getTime();
  return nowMs >= startMs && nowMs < endMs;
}

/**
 * Build the sync chunk document ID for MongoDB.
 * Format: "prs:{org}:{chunkId}"
 */
export function buildChunkDocId(dataType: string, org: string, chunkId: string): string {
  return `${dataType}:${org}:${chunkId}`;
}

/** Format a Date as YYYY-MM-DD string. */
export function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** Parse chunk config from env/settings with defaults. */
export function parseChunkConfig(opts?: {
  epochDate?: string;
  chunkDays?: number;
  historyDays?: number;
}): {
  epochDate: Date;
  chunkDays: number;
  historyDays: number;
} {
  return {
    epochDate: new Date(opts?.epochDate || "2024-01-01T00:00:00Z"),
    chunkDays: opts?.chunkDays || 28,
    historyDays: opts?.historyDays || 365,
  };
}
