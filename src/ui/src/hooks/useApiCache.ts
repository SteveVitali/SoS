/**
 * Client-side API response cache with TTL.
 *
 * Stores fetched responses in a module-level Map keyed by a serialized
 * cache key (derived from the request parameters). Entries expire after
 * a configurable TTL (default 1 hour). The Refresh button bypasses the
 * cache by passing `skipCache: true`.
 *
 * This is intentionally a simple in-memory cache — no persistence across
 * page reloads. It lives at the module level so it survives React
 * component re-mounts (e.g. switching between sub-tabs).
 */

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Module-level cache shared across all hook instances. */
const cache = new Map<string, CacheEntry<unknown>>();

/** Build a deterministic cache key from an arbitrary params object. */
export function buildCacheKey(namespace: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k] ?? "")}`)
    .join("&");
  return `${namespace}?${sorted}`;
}

/**
 * Look up a cached response. Returns the data if the entry exists and
 * hasn't expired, otherwise `undefined`.
 */
export function getCached<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

/** Store a response in the cache. */
export function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}

/** Invalidate a single cache entry. */
export function invalidateCache(key: string): void {
  cache.delete(key);
}

/** Invalidate all entries whose key starts with the given namespace. */
export function invalidateNamespace(namespace: string): void {
  const prefix = `${namespace}?`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}
