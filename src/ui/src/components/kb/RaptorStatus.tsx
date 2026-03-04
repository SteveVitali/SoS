import { useCallback, useEffect, useState } from "react";
import {
  buildRaptorTree,
  getRaptorStatus,
  type RaptorStatus as RaptorStatusType,
} from "../../api.js";
import { css } from "../../styles/theme.js";

function elapsed(startIso: string | undefined): string {
  if (!startIso) return "";
  const ms = Date.now() - new Date(startIso).getTime();
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--fg2)",
          marginBottom: 3,
        }}
      >
        <span>{label}</span>
        <span>
          {value}/{max} ({pct}%)
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--bg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "var(--accent)",
            borderRadius: 3,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}

export function RaptorStatus({ kbId }: { kbId: string }) {
  const [status, setStatus] = useState<RaptorStatusType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const isBuilding = submitting || !!status?.building;

  const load = useCallback(async () => {
    try {
      const data = await getRaptorStatus(kbId);
      setStatus(data.status);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 2s while a build is in progress
  useEffect(() => {
    if (!isBuilding) return;
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [isBuilding, load]);

  const handleBuild = async () => {
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const res = await buildRaptorTree(kbId);
      setMessage(res.message || "Build started");
      // Trigger an immediate poll to pick up building=true status
      await load();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
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
        <button type="button" style={css.btnSmall} disabled={isBuilding} onClick={handleBuild}>
          {isBuilding ? "Building..." : status?.built ? "Rebuild" : "Build Index"}
        </button>
      </div>

      {error && <div style={{ ...css.error, marginBottom: 8 }}>{error}</div>}
      {message && !isBuilding && (
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

      {/* Last build error */}
      {status?.error_message && !isBuilding && (
        <div
          style={{
            fontSize: 12,
            color: "var(--red)",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: "var(--radius)",
            padding: "6px 10px",
            marginBottom: 8,
          }}
        >
          Last build failed: {status.error_message}
        </div>
      )}

      {/* Build progress */}
      {isBuilding && status && (
        <div
          style={{
            fontSize: 12,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "10px 12px",
            marginBottom: 8,
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
            <span style={{ fontWeight: 600, color: "var(--accent)" }}>
              {status.phase || "Starting"}
              {status.current_level != null && ` — Level ${status.current_level}`}
            </span>
            <span style={{ color: "var(--fg2)", fontSize: 11 }}>
              {elapsed(status.build_started_at)}
            </span>
          </div>

          {/* Cluster progress within current level */}
          {status.clusters_total != null && status.clusters_total > 0 && (
            <ProgressBar
              value={status.clusters_completed ?? 0}
              max={status.clusters_total}
              label={`Clusters (Level ${(status.current_level ?? 0) + 1})`}
            />
          )}

          {/* Level progress */}
          {status.estimated_total_levels != null && status.estimated_total_levels > 0 && (
            <ProgressBar
              value={status.current_level ?? 0}
              max={status.estimated_total_levels}
              label="Levels"
            />
          )}

          {/* Running node counts */}
          {status.total_nodes > 0 && (
            <div style={{ fontSize: 11, color: "var(--fg2)", marginTop: 4 }}>
              {status.total_nodes} nodes so far
            </div>
          )}
        </div>
      )}

      {status?.built ? (
        <div style={{ fontSize: 12, color: "var(--fg2)" }}>
          <span>
            <strong style={{ color: "var(--fg)" }}>{status.levels}</strong> levels
          </span>
          {" · "}
          <span>
            <strong style={{ color: "var(--fg)" }}>{status.total_nodes}</strong> nodes
          </span>
          {Object.keys(status.nodes_per_level).length > 0 && (
            <>
              {" · "}
              <span>
                {Object.entries(status.nodes_per_level)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([level, count]) => `L${level}: ${count}`)
                  .join(", ")}
              </span>
            </>
          )}
          {status.build_duration_ms != null && (
            <>
              {" · "}
              <span>{(status.build_duration_ms / 1000).toFixed(1)}s</span>
            </>
          )}
          {status.last_built && (
            <>
              {" · "}
              <span>{new Date(status.last_built).toLocaleDateString()}</span>
            </>
          )}
        </div>
      ) : (
        !isBuilding && (
          <div style={{ fontSize: 12, color: "var(--fg2)" }}>
            No RAPTOR index built yet. Click "Build Index" to create a hierarchical summary tree
            that enables multi-level retrieval.
          </div>
        )
      )}
    </div>
  );
}
