import type { SignalType } from "../../api.js";

const SIGNAL_CONFIG: Record<SignalType, { emoji: string; color: string; label: string }> = {
  continuation: { emoji: "➡️", color: "var(--fg3)", label: "Continuation" },
  gratitude: { emoji: "😊", color: "var(--green)", label: "Gratitude" },
  correction: { emoji: "❌", color: "var(--red)", label: "Correction" },
  rephrase: { emoji: "🔄", color: "#f97316", label: "Rephrase" },
  follow_up_deeper: { emoji: "📈", color: "var(--accent)", label: "Follow-up" },
  topic_change: { emoji: "🔀", color: "var(--fg3)", label: "Topic change" },
  no_response: { emoji: "🔇", color: "var(--fg3)", label: "No response" },
  job_completed: { emoji: "✅", color: "var(--green)", label: "Job completed" },
  job_failed: { emoji: "💥", color: "var(--red)", label: "Job failed" },
  explicit_positive: { emoji: "⭐", color: "var(--green)", label: "Positive" },
  explicit_negative: { emoji: "👎", color: "var(--red)", label: "Negative" },
};

interface SignalBadgeProps {
  signalType: SignalType;
  strength: number;
  details?: string;
  compact?: boolean;
}

export function SignalBadge({ signalType, strength, details, compact }: SignalBadgeProps) {
  const config = SIGNAL_CONFIG[signalType] || {
    emoji: "❓",
    color: "var(--fg3)",
    label: signalType,
  };
  const strengthStr = strength >= 0 ? `+${strength}` : String(strength);

  return (
    <span
      title={
        details
          ? `${config.label} (${strengthStr}): ${details}`
          : `${config.label} (${strengthStr})`
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: compact ? "1px 5px" : "2px 8px",
        borderRadius: 10,
        fontSize: compact ? 10 : 11,
        fontWeight: 500,
        background: `${config.color}18`,
        color: config.color,
        border: `1px solid ${config.color}33`,
        cursor: details ? "help" : "default",
        whiteSpace: "nowrap",
      }}
    >
      <span>{config.emoji}</span>
      {!compact && <span>{config.label}</span>}
      <span style={{ opacity: 0.7 }}>{strengthStr}</span>
    </span>
  );
}
