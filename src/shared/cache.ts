import { createLogger } from "./logger.js";

const log = createLogger("shared:cache");

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Generic in-memory TTL cache. Designed for caching any network call results
 * (GitHub API, Slack API, etc.) with automatic expiration.
 *
 * Usage:
 *   const cache = new TtlCache<PrResult[]>({ ttlMs: 120_000, label: "github-team-prs" });
 *   const prs = cache.getOrSet("team-open-prs", () => fetchFromApi());
 */
export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly label: string;

  constructor(opts: { ttlMs: number; label?: string }) {
    this.ttlMs = opts.ttlMs;
    this.label = opts.label ?? "cache";
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Return cached value if fresh, otherwise call `fn()` to compute,
   * cache the result, and return it.
   */
  getOrSet(key: string, fn: () => T): T {
    const cached = this.get(key);
    if (cached !== undefined) {
      log.debug("Cache hit", { label: this.label, key });
      return cached;
    }
    const value = fn();
    this.set(key, value);
    return value;
  }

  /**
   * Async variant of getOrSet.
   */
  async getOrSetAsync(key: string, fn: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      log.debug("Cache hit", { label: this.label, key });
      return cached;
    }
    const value = await fn();
    this.set(key, value);
    return value;
  }

  /** Remove a specific key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Remove expired entries (call periodically for long-lived caches). */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}
