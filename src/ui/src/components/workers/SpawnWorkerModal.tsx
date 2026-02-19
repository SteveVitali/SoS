import { useState } from "react";
import { spawnWorker } from "../../api.js";
import { css } from "../../styles/theme.js";

interface SpawnWorkerModalProps {
  onClose: () => void;
  onSpawned: () => void;
}

export function SpawnWorkerModal({ onClose, onSpawned }: SpawnWorkerModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSpawn = async () => {
    setLoading(true);
    setError("");
    try {
      await spawnWorker();
      onSpawned();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <dialog
      open
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        maxWidth: "100vw",
        maxHeight: "100vh",
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        border: "none",
        borderRadius: 0,
        padding: 0,
        margin: 0,
      }}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        style={{
          ...css.card,
          maxWidth: 360,
          width: "100%",
          marginBottom: 0,
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600 }}>Spawn New Worker</h3>

        <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--fg2)" }}>
          Start a new worker process (1 job at a time).
        </p>

        {error && <div style={css.error}>{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" style={css.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" style={css.btnPrimary} onClick={handleSpawn} disabled={loading}>
            {loading ? "Spawning…" : "Spawn"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
