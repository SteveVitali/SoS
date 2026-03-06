import { useCallback, useEffect, useState } from "react";
import {
  buildRaptorTree,
  getRaptorStatus,
  type RaptorStatus as RaptorStatusType,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import {
  BuildProgressBox,
  ErrorBanner,
  IndexStatusCard,
  ProgressBar,
} from "../shared/IndexCard.js";

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

  const phaseLabel = status
    ? `${status.phase || "Starting"}${status.current_level != null ? ` — Level ${status.current_level}` : ""}`
    : "Starting";

  return (
    <IndexStatusCard
      icon="🌲"
      title="RAPTOR Index"
      buttonLabel={isBuilding ? "Building..." : status?.built ? "Rebuild" : "Build Index"}
      buttonDisabled={isBuilding}
      onButtonClick={handleBuild}
      error={error}
      successMessage={message}
      showSuccess={!isBuilding && !!message}
      isActive={isBuilding}
      progressContent={
        status && (
          <>
            {/* Last build error (shown above progress) */}
            {status.error_message && (
              <ErrorBanner>Last build failed: {status.error_message}</ErrorBanner>
            )}
            <BuildProgressBox phase={phaseLabel} elapsedStart={status.build_started_at}>
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
            </BuildProgressBox>
          </>
        )
      }
      summaryContent={
        status?.built ? (
          <>
            {/* Last build error (when not building) */}
            {status.error_message && (
              <ErrorBanner>Last build failed: {status.error_message}</ErrorBanner>
            )}
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
          </>
        ) : (
          <>
            {/* Last build error (when not built) */}
            {status?.error_message && (
              <ErrorBanner>Last build failed: {status.error_message}</ErrorBanner>
            )}
          </>
        )
      }
      isEmpty={!status?.built}
      emptyMessage='No RAPTOR index built yet. Click "Build Index" to create a hierarchical summary tree that enables multi-level retrieval.'
    />
  );
}
