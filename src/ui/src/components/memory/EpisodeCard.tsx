import { useState } from "react";
import type { InteractionEpisode, MemoryNote } from "../../api.js";
import { getMemoryEpisode } from "../../api.js";
import { css } from "../../styles/theme.js";
import { MemoryCard } from "./MemoryCard.js";
import { SignalBadge } from "./SignalBadge.js";

const SOURCE_ICONS: Record<string, string> = {
  slack: "💬",
  discord: "🎮",
  web_chat: "🌐",
  system: "⚙️",
};

const EXTRACTION_BADGES: Record<string, { label: string; color: string }> = {
  pending: { label: "⏳ Pending", color: "#6b7280" },
  extracted: { label: "✅ Extracted", color: "#22c55e" },
  skipped: { label: "⏭ Skipped", color: "#6b7280" },
};

function relTime(dateStr: string): string {
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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface EpisodeCardProps {
  episode: InteractionEpisode;
  onNavigateMemory?: (id: string) => void;
}

export function EpisodeCard({ episode, onNavigateMemory }: EpisodeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [extractedMemories, setExtractedMemories] = useState<MemoryNote[] | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const sourceIcon = SOURCE_ICONS[episode.source] || "❓";
  const extractionBadge = EXTRACTION_BADGES[episode.extraction_status] || EXTRACTION_BADGES.pending;

  async function handleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && !extractedMemories) {
      setLoadingDetail(true);
      try {
        const res = await getMemoryEpisode(episode.episode_id);
        setExtractedMemories(res.memories);
      } catch {
        setExtractedMemories([]);
      } finally {
        setLoadingDetail(false);
      }
    }
  }

  return (
    <div
      style={{ ...css.card, cursor: "pointer" }}
      onClick={handleExpand}
      onKeyDown={(e) => e.key === "Enter" && handleExpand()}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13 }}>{sourceIcon}</span>
          <span style={{ fontSize: 12, color: "var(--fg2)", fontWeight: 500 }}>
            {episode.source}
          </span>
          <span style={{ ...css.badge("#6b7280") }}>{episode.routed_action}</span>
        </div>
        <span style={{ fontSize: 11, color: "var(--fg3)" }}>
          {new Date(episode.timestamp).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
          {" · "}
          {relTime(episode.timestamp)}
        </span>
      </div>

      {/* User message */}
      <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5, marginBottom: 6 }}>
        "{expanded ? episode.user_message : episode.user_message.slice(0, 200)}
        {!expanded && episode.user_message.length > 200 ? "…" : ""}"
      </div>

      {/* Response summary */}
      <div style={{ fontSize: 12, color: "var(--fg3)", marginBottom: 8 }}>
        {expanded ? episode.response_summary : episode.response_summary.slice(0, 200)}
        {!expanded && episode.response_summary.length > 200 ? "…" : ""}
      </div>

      {/* Extraction + Signals row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={css.badge(extractionBadge.color)}>{extractionBadge.label}</span>
        {episode.extraction_status === "extracted" && episode.extracted_memory_ids.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--fg3)" }}>
            ({episode.extracted_memory_ids.length} memor
            {episode.extracted_memory_ids.length !== 1 ? "ies" : "y"})
          </span>
        )}
        {episode.signals.map((s, i) => (
          <SignalBadge
            key={`${s.signal_type}-${i}`}
            signalType={s.signal_type}
            strength={s.strength}
            details={s.details}
            compact
          />
        ))}
        {episode.task_id && (
          <a
            href={`/jobs/${episode.task_id}`}
            style={{ fontSize: 11, color: "var(--accent2)", textDecoration: "none" }}
            onClick={(e) => e.stopPropagation()}
          >
            Task: {episode.task_id.slice(0, 8)}…
          </a>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {/* Action args */}
          {episode.action_args_summary && episode.action_args_summary !== "{}" && (
            <div style={{ ...css.section }}>
              <div style={css.sectionTitle}>Action Args</div>
              <pre style={{ ...css.pre, fontSize: 11 }}>{episode.action_args_summary}</pre>
            </div>
          )}

          {/* Source ref */}
          <div style={{ ...css.section }}>
            <div style={css.sectionTitle}>Source Reference</div>
            <div
              style={{
                fontSize: 11,
                color: "var(--fg2)",
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {episode.source_ref.channel_id && (
                <span>Channel: {episode.source_ref.channel_id}</span>
              )}
              {episode.source_ref.thread_ts && <span>Thread: {episode.source_ref.thread_ts}</span>}
              {episode.source_ref.conversation_id && (
                <span>Conversation: {episode.source_ref.conversation_id.slice(0, 8)}…</span>
              )}
              {episode.source_ref.thread_id && <span>Thread: {episode.source_ref.thread_id}</span>}
              {episode.source_ref.message_id && (
                <span>Message: {episode.source_ref.message_id}</span>
              )}
            </div>
          </div>

          {/* Signals detail */}
          {episode.signals.length > 0 && (
            <div style={{ ...css.section }}>
              <div style={css.sectionTitle}>Signals ({episode.signals.length})</div>
              {episode.signals.map((s, i) => (
                <div
                  key={`${s.signal_type}-${i}`}
                  style={{
                    fontSize: 12,
                    color: "var(--fg2)",
                    marginBottom: 4,
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <SignalBadge
                    signalType={s.signal_type}
                    strength={s.strength}
                    details={s.details}
                  />
                  <span style={{ color: "var(--fg3)" }}>
                    {new Date(s.detected_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {s.details && (
                    <span style={{ color: "var(--fg3)", fontSize: 11 }}>
                      — {s.details.slice(0, 100)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Timestamps */}
          <div style={{ ...css.section }}>
            <div style={css.sectionTitle}>Timestamps</div>
            <div
              style={{
                fontSize: 11,
                color: "var(--fg3)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>Recorded: {new Date(episode.timestamp).toLocaleString()}</span>
              {episode.signal_collected_at && (
                <span>
                  Signals collected: {new Date(episode.signal_collected_at).toLocaleString()}
                </span>
              )}
            </div>
          </div>

          {/* Extracted memories */}
          {loadingDetail && (
            <div style={{ fontSize: 12, color: "var(--fg3)", padding: 8 }}>
              Loading extracted memories…
            </div>
          )}
          {extractedMemories && extractedMemories.length > 0 && (
            <div style={{ ...css.section }}>
              <div style={css.sectionTitle}>Extracted Memories ({extractedMemories.length})</div>
              {extractedMemories.map((m) => (
                <MemoryCard key={m.memory_id} memory={m} onNavigateMemory={onNavigateMemory} />
              ))}
            </div>
          )}
          {extractedMemories &&
            extractedMemories.length === 0 &&
            episode.extraction_status === "extracted" && (
              <div style={{ fontSize: 12, color: "var(--fg3)", padding: 8 }}>
                No memories extracted from this episode.
              </div>
            )}
        </div>
      )}
    </div>
  );
}
