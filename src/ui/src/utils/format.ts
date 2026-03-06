export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatPrUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return `${m[1]}/${m[2]}#${m[3]}`;
  return url;
}

export function isSlackId(s: string): boolean {
  return /^U[A-Z0-9]{6,}$/.test(s);
}

export function formatUser(userId: string, cache: Map<string, { displayName: string }>): string {
  if (!isSlackId(userId)) return userId;
  const cached = cache.get(userId);
  if (cached && cached.displayName !== userId) {
    return `${cached.displayName} (${userId})`;
  }
  return userId;
}

export function formatUserShort(
  userId: string,
  cache: Map<string, { displayName: string }>,
): string {
  if (!isSlackId(userId)) return userId;
  const cached = cache.get(userId);
  if (cached && cached.displayName !== userId) {
    return cached.displayName;
  }
  return userId;
}

/**
 * Compact number formatting: 1234 → "1.2K", 1234567 → "1.2M".
 */
export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Countdown string from milliseconds: "2:05" or "45s".
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
  return `${s}s`;
}

/**
 * Safely extract an error message from an unknown catch value.
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}
