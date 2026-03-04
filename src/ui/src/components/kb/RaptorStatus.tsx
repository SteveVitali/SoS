import { useCallback, useEffect, useState } from "react";
import {
  buildRaptorTree,
  getRaptorStatus,
  type RaptorStatus as RaptorStatusType,
} from "../../api.js";
import { css } from "../../styles/theme.js";

export function RaptorStatus({ kbId }: { kbId: string }) {
  const [status, setStatus] = useState<RaptorStatusType | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getRaptorStatus(kbId);
      setStatus(data.status);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleBuild = async () => {
    setBuilding(true);
    setError("");
    setMessage("");
    try {
      const res = await buildRaptorTree(kbId);
      setMessage(res.message || "Build started");
      // Poll for completion after a delay
      setTimeout(load, 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBuilding(false);
    }
  };

  if (loading) {
    return (
      <div style={{ ...css.card, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "var(--fg2)" }}>Loading RAPTOR status...</div>
      </div>
    );
  }

  return (
    <div style={{ ...css.card, marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <h4 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🌲 RAPTOR Index</h4>
        <button type="button" style={css.btnSmall} disabled={building} onClick={handleBuild}>
          {building ? "Building..." : status?.built ? "Rebuild" : "Build Index"}
        </button>
      </div>

      {error && <div style={{ ...css.error, marginBottom: 8 }}>{error}</div>}
      {message && (
        <div
          style={{
            fontSize: 12,
            color: "#22c55e",
            background: "rgba(34,197,94,0.1)",
            border: "1px solid rgba(34,197,94,0.3)",
            borderRadius: "var(--radius)",
            padding: "6px 10px",
            marginBottom: 8,
          }}
        >
          {message}
        </div>
      )}

      {status?.built ? (
        <div style={{ fontSize: 12 }}>
          <div style={{ display: "flex", gap: 16, marginBottom: 6, color: "var(--fg2)" }}>
            <span>
              <strong style={{ color: "var(--fg)" }}>{status.levels}</strong> levels
            </span>
            <span>
              <strong style={{ color: "var(--fg)" }}>{status.total_nodes}</strong> total nodes
            </span>
            {status.build_duration_ms && (
              <span>
                Built in{" "}
                <strong style={{ color: "var(--fg)" }}>
                  {(status.build_duration_ms / 1000).toFixed(1)}s
                </strong>
              </span>
            )}
            {status.last_built && (
              <span>Last built: {new Date(status.last_built).toLocaleString()}</span>
            )}
          </div>

          {/* Nodes per level visualization */}
          <div style={{ display: "flex", gap: 4, alignItems: "flex-end", marginTop: 8 }}>
            {Object.entries(status.nodes_per_level)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([level, count]) => {
                const maxCount = Math.max(...Object.values(status.nodes_per_level));
                const height = Math.max(8, (count / maxCount) * 40);
                return (
                  <div
                    key={level}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    <span style={{ fontSize: 10, color: "var(--fg2)" }}>{count}</span>
                    <div
                      style={{
                        width: 30,
                        height,
                        background:
                          Number(level) === 0
                            ? "var(--accent)"
                            : `var(--accent)${Math.max(30, 80 - Number(level) * 15)}`,
                        borderRadius: 3,
                      }}
                    />
                    <span style={{ fontSize: 9, color: "var(--fg2)" }}>L{level}</span>
                  </div>
                );
              })}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--fg2)" }}>
          No RAPTOR index built yet. Click "Build Index" to create a hierarchical summary tree that
          enables multi-level retrieval.
        </div>
      )}
    </div>
  );
}
