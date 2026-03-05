/**
 * Per-repo async mutex for serializing git operations on shared clone directories.
 *
 * Multiple workers may resolve to the same repo and attempt concurrent `git fetch`
 * operations on the same bare clone directory. Git uses index.lock internally,
 * so concurrent fetches cause contention → ETIMEDOUT from execSync.
 *
 * This module provides a simple async mutex keyed by repo ID. Callers wrap
 * their git-fetch calls in `withRepoLock(repoId, fn)` to ensure only one
 * fetch runs at a time per clone directory.
 */

import { createLogger } from "../../shared/logger.js";

const log = createLogger("worker:repoLock");

interface LockEntry {
  /** Resolves when the current holder releases the lock. */
  queue: Array<() => void>;
  held: boolean;
}

const locks = new Map<string, LockEntry>();

function getOrCreateLock(repoId: string): LockEntry {
  let entry = locks.get(repoId);
  if (!entry) {
    entry = { queue: [], held: false };
    locks.set(repoId, entry);
  }
  return entry;
}

async function acquire(repoId: string): Promise<void> {
  const entry = getOrCreateLock(repoId);
  if (!entry.held) {
    entry.held = true;
    return;
  }
  // Wait in line
  return new Promise<void>((resolve) => {
    entry.queue.push(resolve);
    log.debug("Waiting for repo lock", { repoId, queueDepth: entry.queue.length });
  });
}

function release(repoId: string): void {
  const entry = locks.get(repoId);
  if (!entry) return;

  const next = entry.queue.shift();
  if (next) {
    // Hand the lock to the next waiter
    next();
  } else {
    entry.held = false;
  }
}

/**
 * Execute `fn` while holding the per-repo lock.
 * Only one `fn` runs at a time for a given `repoId`.
 */
export async function withRepoLock<T>(repoId: string, fn: () => T | Promise<T>): Promise<T> {
  await acquire(repoId);
  try {
    return await fn();
  } finally {
    release(repoId);
  }
}

/** Visible for testing: number of waiters for a given repo. */
export function _getQueueDepth(repoId: string): number {
  return locks.get(repoId)?.queue.length ?? 0;
}

/** Visible for testing: whether the lock is currently held. */
export function _isHeld(repoId: string): boolean {
  return locks.get(repoId)?.held ?? false;
}

/** Visible for testing: reset all locks. */
export function _resetAll(): void {
  locks.clear();
}
