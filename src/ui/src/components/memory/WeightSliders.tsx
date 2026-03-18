interface WeightSlidersProps {
  similarity: number;
  recency: number;
  importance: number;
  access: number;
  onChange: (weights: {
    similarity: number;
    recency: number;
    importance: number;
    access: number;
  }) => void;
}

const COLORS = {
  similarity: "#3b82f6",
  recency: "#22c55e",
  importance: "#eab308",
  access: "#a855f7",
};

export function WeightSliders({
  similarity,
  recency,
  importance,
  access,
  onChange,
}: WeightSlidersProps) {
  const sum = similarity + recency + importance + access;
  const sumOk = Math.abs(sum - 1.0) < 0.01;

  function handleChange(key: string, value: number) {
    const next = { similarity, recency, importance, access, [key]: value };
    onChange(next);
  }

  const sliders = [
    { key: "similarity", label: "Similarity", value: similarity, color: COLORS.similarity },
    { key: "recency", label: "Recency", value: recency, color: COLORS.recency },
    { key: "importance", label: "Importance", value: importance, color: COLORS.importance },
    { key: "access", label: "Access", value: access, color: COLORS.access },
  ];

  return (
    <div>
      {/* Stacked bar preview */}
      <div
        style={{
          display: "flex",
          height: 12,
          borderRadius: 6,
          overflow: "hidden",
          marginBottom: 10,
          border: "1px solid var(--border)",
        }}
      >
        {sliders.map((s) => (
          <div
            key={s.key}
            style={{
              width: `${(s.value / (sum || 1)) * 100}%`,
              background: s.color,
              transition: "width 0.2s",
            }}
            title={`${s.label}: ${s.value.toFixed(2)}`}
          />
        ))}
      </div>

      {/* Individual sliders */}
      {sliders.map((s) => (
        <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ width: 80, fontSize: 12, color: "var(--fg2)" }}>{s.label}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={s.value}
            onChange={(e) => handleChange(s.key, Number.parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: s.color }}
          />
          <span
            style={{
              width: 40,
              fontSize: 12,
              fontFamily: "monospace",
              color: "var(--fg)",
              textAlign: "right",
            }}
          >
            {s.value.toFixed(2)}
          </span>
        </div>
      ))}

      {/* Sum indicator */}
      <div
        style={{
          fontSize: 11,
          marginTop: 4,
          color: sumOk ? "var(--fg3)" : "var(--red)",
          fontWeight: sumOk ? 400 : 600,
        }}
      >
        Sum: {sum.toFixed(2)} {sumOk ? "✓" : "⚠ should be 1.0"}
      </div>
    </div>
  );
}
