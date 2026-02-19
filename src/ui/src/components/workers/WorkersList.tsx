import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { removeWorkerEntry, shutdownWorker, type WorkerInfo } from "../../api.js";
import { useAppData } from "../../stores/AppDataContext.js";
import { css } from "../../styles/theme.js";
import { LastUpdated } from "../shared/LastUpdated.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";
import { SpawnWorkerModal } from "./SpawnWorkerModal.js";
import { WorkerCard } from "./WorkerCard.js";

export function WorkersList() {
  const { workerNodes, refreshWorkerNodes } = useAppData();
  const { workers, loading, lastRefreshedAt } = workerNodes;
  const navigate = useNavigate();
  const [showSpawnModal, setShowSpawnModal] = useState(false);
  const [actionError, setActionError] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onlineIds = workers.filter((w) => w.status !== "offline").map((w) => w.worker_id);
  const allExpanded = onlineIds.length > 0 && onlineIds.every((id) => expandedIds.has(id));

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(onlineIds));
    }
  };

  const onlineWorkers = workers.filter((w) => w.status !== "offline");
  const busyWorkers = onlineWorkers.filter((w) => w.loops[0]?.status === "busy");

  const handleShutdown = async (w: WorkerInfo) => {
    setActionError("");
    try {
      await shutdownWorker(w.worker_id);
      refreshWorkerNodes();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (w: WorkerInfo) => {
    setActionError("");
    try {
      await removeWorkerEntry(w.worker_id);
      refreshWorkerNodes();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <PageHeader
        title="Workers"
        count={workers.length}
        actions={
          <>
            {onlineIds.length > 0 && (
              <button type="button" style={css.btn} onClick={toggleAll}>
                {allExpanded ? "Collapse All" : "Expand All"}
              </button>
            )}
            <button type="button" style={css.btn} onClick={() => refreshWorkerNodes()}>
              ↻ Refresh
            </button>
            <button type="button" style={css.btnPrimary} onClick={() => setShowSpawnModal(true)}>
              + Spawn Worker
            </button>
          </>
        }
        subtitle={<LastUpdated at={lastRefreshedAt} />}
      />

      {/* Summary bar */}
      <div style={{ ...css.filters, fontSize: 13, color: "var(--fg2)" }}>
        <span>
          {onlineWorkers.length} online · {busyWorkers.length} busy ·{" "}
          {onlineWorkers.length - busyWorkers.length} idle
        </span>
      </div>

      {actionError && <div style={css.error}>{actionError}</div>}

      {loading && workers.length === 0 && <Spinner />}

      {!loading && workers.length === 0 && (
        <div style={{ color: "var(--fg3)", padding: 20, textAlign: "center" }}>
          No workers registered. Spawn one to get started.
        </div>
      )}

      {workers.map((w) => (
        <WorkerCard
          key={w.worker_id}
          worker={w}
          expanded={expandedIds.has(w.worker_id)}
          onToggleExpand={() => toggleExpand(w.worker_id)}
          onViewLogs={() => navigate(`/workers/${encodeURIComponent(w.worker_id)}`)}
          onShutdown={() => handleShutdown(w)}
          onRemove={() => handleRemove(w)}
        />
      ))}

      {showSpawnModal && (
        <SpawnWorkerModal
          onClose={() => setShowSpawnModal(false)}
          onSpawned={() => {
            setShowSpawnModal(false);
            setTimeout(() => refreshWorkerNodes(), 2000);
          }}
        />
      )}
    </div>
  );
}
