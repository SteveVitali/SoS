export const MEMORY_TYPE_COLORS: Record<string, string> = {
  fact: "#3b82f6",
  reflection: "#a855f7",
  user_profile: "#22c55e",
};

export const MEMORY_TYPE_LABELS: Record<string, string> = {
  fact: "FACT",
  reflection: "REFLECTION",
  user_profile: "PROFILE",
};

export const SOURCE_ICONS: Record<string, string> = {
  slack: "💬",
  discord: "🎮",
  web_chat: "🌐",
  system: "⚙️",
};

export function relTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
