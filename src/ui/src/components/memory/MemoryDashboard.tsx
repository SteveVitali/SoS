import { useCallback, useEffect, useState } from "react";
import type { InteractionEpisode, MemoryNote, MemoryStats } from "../../api.js";
import {
  getMemoryConfig,
  getMemoryStats,
  listMemoryEpisodes,
  listMemoryNotes,
  triggerReflection,
  updateMemoryConfig,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { Spinner } from "../shared/Spinner.js";
import { MEMORY_TYPE_COLORS, relTime } from "./memoryShared.js";

interface StatCardProps {
  label: string;
  children: React.ReactNode;
}

function StatCard({ label, children }: StatCardProps) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 180,
        background: "var(--bg2)",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border)",
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--fg3)",
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, color: "var(--fg)" }}>{children}</div>
    </div>
  );
}

interface ActivityItem {
  type: "memory" | "episode";
  timestamp: string;
  icon: string;
  text: string;
  subtext?: string;
}

function buildActivityFeed(memories: MemoryNote[], episodes: InteractionEpisode[]): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const m of memories) {
    if (m.tags.includes("__internal__")) continue;
    const typeLabel =
      m.memory_type === "reflection"
        ? "Reflection generated"
        : m.memory_type === "user_profile"
          ? "Profile updated"
          : "Fact extracted";
    const icon =
      m.memory_type === "reflection" ? "🪞" : m.memory_type === "user_profile" ? "👤" : "📝";
    items.push({
      type: "memory",
      timestamp: m.created_at,
      icon,
      text: `${typeLabel}: "${m.content.slice(0, 80)}${m.content.length > 80 ? "…" : ""}"`,
      subtext: `${m.source_type} · ${relTime(m.created_at)}`,
    });
  }

  for (const ep of episodes) {
    items.push({
      type: "episode",
      timestamp: ep.timestamp,
      icon: "🎯",
      text: `Episode: "${ep.user_message.slice(0, 80)}${ep.user_message.length > 80 ? "…" : ""}"`,
      subtext: `${ep.source} · ${ep.routed_action} · ${relTime(ep.timestamp)}`,
    });
  }

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return items.slice(0, 15);
}

interface MemoryDashboardProps {
  onNavigateTab: (tab: string) => void;
}

export function MemoryDashboard({ onNavigateTab }: MemoryDashboardProps) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [reflectResult, setReflectResult] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, configRes, memoriesRes, episodesRes] = await Promise.all([
        getMemoryStats(),
        getMemoryConfig(),
        listMemoryNotes({ limit: 15 }),
        listMemoryEpisodes({ limit: 15 }),
      ]);
      setStats(statsRes);
      setDisabled(!configRes.config.enabled);
      setActivityItems(buildActivityFeed(memoriesRes.memories, episodesRes.episodes));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 30000);
    return () => clearInterval(interval);
  }, [fetch]);

  async function handleEnable() {
    setEnabling(true);
    try {
      await updateMemoryConfig({ enabled: true });
      setDisabled(false);
      await fetch();
    } catch {
      // ignore
    } finally {
      setEnabling(false);
    }
  }

  async function handleReflect() {
    setReflecting(true);
    setReflectResult(null);
    try {
      const res = await triggerReflection();
      const r = res.result;
      setReflectResult(
        `Created ${r.reflections_created} reflection${r.reflections_created !== 1 ? "s" : ""} from ${r.clusters_found} cluster${r.clusters_found !== 1 ? "s" : ""} (${r.episodes_reviewed} episodes). Profile ${r.profile_updated ? "updated" : "unchanged"}.`,
      );
      await fetch();
    } catch (err) {
      setReflectResult(`Failed: ${(err as Error).message}`);
    } finally {
      setReflecting(false);
    }
  }

  if (loading) return <Spinner label="Loading memory dashboard…" />;

  return (
    <div>
      {/* Disabled banner */}
      {disabled && (
        <div
          style={{
            background: "#eab30822",
            border: "1px solid #eab30855",
            borderRadius: "var(--radius)",
            padding: "10px 16px",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 13, color: "#eab308" }}>
            ⚠ Memory system is disabled. Interactions are not being recorded.
          </span>
          <button type="button" style={css.btnSmall} onClick={handleEnable} disabled={enabling}>
            {enabling ? "Enabling…" : "Enable →"}
          </button>
        </div>
      )}

      {/* Stat cards */}
      {stats && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          <StatCard label="Memories">
            <span style={{ fontSize: 22, fontWeight: 700 }}>{stats.active_memories}</span>
            <span style={{ fontSize: 12, color: "var(--fg3)", marginLeft: 4 }}>
              active · {stats.invalidated_memories} invalidated
            </span>
          </StatCard>
          <StatCard label="By Type">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(["fact", "reflection", "user_profile"] as const).map((t) => (
                <span key={t} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: MEMORY_TYPE_COLORS[t],
                      display: "inline-block",
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{stats.memories_by_type[t]}</span>
                  <span style={{ fontSize: 11, color: "var(--fg3)" }}>
                    {t === "user_profile" ? "profiles" : `${t}s`}
                  </span>
                </span>
              ))}
            </div>
          </StatCard>
          <StatCard label="Episodes">
            <span style={{ fontSize: 22, fontWeight: 700 }}>{stats.total_episodes}</span>
            <span style={{ fontSize: 12, color: "var(--fg3)", marginLeft: 4 }}>recorded</span>
          </StatCard>
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button type="button" style={css.btn} onClick={() => onNavigateTab("memories")}>
          🔍 Search Memories
        </button>
        <button type="button" style={css.btn} onClick={handleReflect} disabled={reflecting}>
          {reflecting ? "Running…" : "▶ Run Reflection"}
        </button>
        <button type="button" style={css.btn} onClick={() => onNavigateTab("profile")}>
          👤 View Profile
        </button>
      </div>

      {reflectResult && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 16,
            borderRadius: 6,
            background: reflectResult.includes("Failed") ? "var(--red)11" : "var(--green)11",
            border: `1px solid ${reflectResult.includes("Failed") ? "var(--red)33" : "var(--green)33"}`,
            fontSize: 12,
            color: "var(--fg2)",
          }}
        >
          {reflectResult}
        </div>
      )}

      {/* Activity feed */}
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: "var(--fg)" }}>
          Recent Activity
        </h3>
        {activityItems.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--fg3)", fontSize: 13 }}>
            {disabled
              ? "Enable the memory system to start recording interactions."
              : "No activity yet. Start chatting to see memory events appear here."}
          </div>
        ) : (
          <div style={css.timeline}>
            {activityItems.map((item, i) => (
              <div key={`${item.timestamp}-${i}`} style={css.timelineItem}>
                <div style={css.dot(item.type === "memory" ? "var(--accent)" : "var(--fg3)")} />
                <div style={{ fontSize: 13, color: "var(--fg)" }}>
                  <span style={{ marginRight: 4 }}>{item.icon}</span>
                  {item.text}
                </div>
                {item.subtext && (
                  <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 1 }}>
                    {item.subtext}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
