import { useState } from "react";
import { type ResearchResult, type ResearchStrategy, runResearch } from "../../api.js";
import { css } from "../../styles/theme.js";
import { ScopeToggleButtons, useToggleScopes } from "./kbShared.js";
import { MetricsSummary } from "./ResearchTimeline.js";

interface ComparisonEntry {
  strategy: ResearchStrategy;
  status: "idle" | "running" | "done" | "error";
  result?: ResearchResult;
  error?: string;
}

export function StrategyComparison() {
  const [query, setQuery] = useState("");
  const { scopes, toggle: toggleScope } = useToggleScopes();
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<ComparisonEntry[]>([]);

  const strategies: ResearchStrategy[] = ["simple", "deep", "agent"];

  const handleCompare = async () => {
    if (!query.trim()) return;
    setRunning(true);

    const initial: ComparisonEntry[] = strategies.map((s) => ({
      strategy: s,
      status: "running",
    }));
    setEntries(initial);

    // Run all three in parallel
    const promises = strategies.map(async (strategy, idx) => {
      try {
        const result = await runResearch({
          query: query.trim(),
          scopes,
          strategy,
        });
        setEntries((prev) =>
          prev.map((e, i) => (i === idx ? { ...e, status: "done" as const, result } : e)),
        );
      } catch (err: unknown) {
        setEntries((prev) =>
          prev.map((e, i) =>
            i === idx ? { ...e, status: "error" as const, error: (err as Error).message } : e,
          ),
        );
      }
    });

    await Promise.allSettled(promises);
    setRunning(false);
  };

  return (
    <div style={{ ...css.card, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>📊 Strategy Comparison</h3>
      <p style={{ fontSize: 12, color: "var(--fg2)", margin: "0 0 12px" }}>
        Run the same query across all three strategies and compare results side-by-side.
      </p>

      {/* Scope selector */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ ...css.label, marginBottom: 6 }}>Scopes</label>
        <ScopeToggleButtons scopes={scopes} onToggle={toggleScope} />
      </div>

      {/* Query input */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          style={{ ...css.input, flex: 1 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter a query to compare across strategies..."
          onKeyDown={(e) => e.key === "Enter" && handleCompare()}
        />
        <button
          type="button"
          style={css.btnPrimary}
          disabled={running || !query.trim()}
          onClick={handleCompare}
        >
          {running ? "Comparing..." : "Compare All"}
        </button>
      </div>

      {/* Comparison results */}
      {entries.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {entries.map((entry) => (
            <div
              key={entry.strategy}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--accent)",
                    textTransform: "uppercase",
                  }}
                >
                  {entry.strategy}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background:
                      entry.status === "done"
                        ? "rgba(34,197,94,0.15)"
                        : entry.status === "error"
                          ? "rgba(239,68,68,0.15)"
                          : "rgba(59,130,246,0.15)",
                    color:
                      entry.status === "done"
                        ? "#22c55e"
                        : entry.status === "error"
                          ? "#ef4444"
                          : "#3b82f6",
                    fontWeight: 600,
                  }}
                >
                  {entry.status}
                </span>
              </div>

              {entry.status === "running" && (
                <div style={{ fontSize: 12, color: "var(--fg2)" }}>Running...</div>
              )}

              {entry.status === "error" && (
                <div style={{ fontSize: 12, color: "#ef4444" }}>{entry.error}</div>
              )}

              {entry.status === "done" && entry.result && (
                <div style={{ fontSize: 12 }}>
                  <MetricsSummary metrics={entry.result.metrics} />
                  <div style={{ marginTop: 8 }}>
                    <strong style={{ color: "var(--fg)" }}>{entry.result.chunks.length}</strong>
                    <span style={{ color: "var(--fg2)" }}> chunks returned</span>
                  </div>
                  {entry.result.context && (
                    <pre
                      style={{
                        marginTop: 8,
                        background: "var(--bg2)",
                        padding: 8,
                        borderRadius: 4,
                        fontSize: 10,
                        maxHeight: 200,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        color: "var(--fg)",
                      }}
                    >
                      {entry.result.context.slice(0, 1000)}
                      {entry.result.context.length > 1000 ? "\n..." : ""}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
