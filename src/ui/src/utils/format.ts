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
