import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getWorkerNode, shutdownWorker, type WorkerInfo } from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";
import { LogTerminal } from "./LogTerminal.js";

export function WorkerDetail() {
  const { id } = useParams<{ id: string }>();
  const [worker, setWorker] = useState<WorkerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Load worker info
  const loadWorker = useCallback(async () => {
    if (!id) return;
    try {
      const res = await getWorkerNode(id);
      setWorker(res.worker);
    } catch (err: unknown) {
      setError(err instanceof Error ? (err as Error).message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadWorker();
    const timer = setInterval(loadWorker, 5000);
    return () => clearInterval(timer);
  }, [loadWorker]);

  const handleShutdown = async () => {
    if (!id) return;
    try {
      await shutdownWorker(id);
      loadWorker();
    } catch (err: unknown) {
      setError(err instanceof Error ? (err as Error).message : String(err));
    }
  };

  if (!id) return <div style={css.error}>No worker ID</div>;
  if (loading) return <div style={{ padding: 20, color: "var(--fg3)" }}>Loading…</div>;
  if (error && !worker) return <div style={css.error}>{error}</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <Link to="/workers" style={{ ...css.link, fontSize: 14 }}>
          ← Workers
        </Link>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background:
              worker?.status === "online"
                ? "#22c55e"
                : worker?.status === "degraded"
                  ? "#eab308"
                  : "#6b7280",
          }}
        />
        <span style={{ fontWeight: 600, fontSize: 16 }}>{worker?.worker_id || id}</span>
        {worker && (
          <span style={{ fontSize: 12, color: "var(--fg3)" }}>
            PID {worker.pid} · ▲ {relativeTime(worker.started_at).replace(" ago", "")}
          </span>
        )}
      </div>

      <LogTerminal workerId={id} height="calc(100vh - 260px)" />

      {worker?.status !== "offline" && (
        <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            style={{ ...css.btnSmall, color: "var(--red)" }}
            onClick={handleShutdown}
          >
            Shutdown Worker
          </button>
        </div>
      )}

      {error && <div style={{ ...css.error, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
