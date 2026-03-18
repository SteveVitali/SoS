interface ScoreBreakdownProps {
  similarity: number;
  recency: number;
  importance: number;
  access: number;
  weightSimilarity?: number;
  weightRecency?: number;
  weightImportance?: number;
  weightAccess?: number;
  composite: number;
}

function Bar({ value, color }: { value: number; color: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div
      style={{
        width: 80,
        height: 6,
        background: "var(--bg)",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
    </div>
  );
}

export function ScoreBreakdown({
  similarity,
  recency,
  importance,
  access,
  weightSimilarity = 0.45,
  weightRecency = 0.2,
  weightImportance = 0.2,
  weightAccess = 0.15,
  composite,
}: ScoreBreakdownProps) {
  const factors = [
    { label: "Similarity", value: similarity, weight: weightSimilarity, color: "#3b82f6" },
    { label: "Recency", value: recency, weight: weightRecency, color: "#22c55e" },
    { label: "Importance", value: importance, weight: weightImportance, color: "#eab308" },
    { label: "Access", value: access, weight: weightAccess, color: "#a855f7" },
  ];

  return (
    <div
      style={{
        background: "var(--bg)",
        borderRadius: 6,
        padding: "8px 10px",
        fontSize: 11,
        border: "1px solid var(--border)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--fg)" }}>
        Score: {composite.toFixed(3)}
      </div>
      {factors.map((f) => (
        <div
          key={f.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 3,
          }}
        >
          <span style={{ width: 65, color: "var(--fg2)" }}>{f.label}</span>
          <span style={{ width: 32, textAlign: "right", fontFamily: "monospace" }}>
            {f.value.toFixed(2)}
          </span>
          <Bar value={f.value} color={f.color} />
          <span style={{ color: "var(--fg3)", fontFamily: "monospace" }}>
            x{f.weight} = {(f.value * f.weight).toFixed(3)}
          </span>
        </div>
      ))}
    </div>
  );
}
