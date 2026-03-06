import { useCallback, useEffect, useState } from "react";
import {
  type FtsRebuildEvent,
  type FtsStatus as FtsStatusType,
  getFtsStatus,
  rebuildFtsIndex,
} from "../../api.js";
import { css } from "../../styles/theme.js";

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
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

export function FtsStatus({ kbId }: { kbId: string }) {
  const [status, setStatus] = useState<FtsStatusType | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // Streaming progress state
  const [phase, setPhase] = useState("");
  const [indexed, setIndexed] = useState(0);
  const [total, setTotal] = useState(0);
  const [startedAt, setStartedAt] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await getFtsStatus(kbId);
      setStatus(data);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRebuild = async () => {
    setRebuilding(true);
    setError("");
    setMessage("");
    setPhase("reading");
    setIndexed(0);
    setTotal(0);
    setStartedAt(Date.now());

    try {
      const result = await rebuildFtsIndex(kbId, (event: FtsRebuildEvent) => {
        switch (event.type) {
          case "reading":
            setPhase("Reading vector store...");
            break;
          case "read_complete":
            setTotal(event.total);
            setPhase("Indexing...");
            break;
          case "batch":
            setIndexed(event.indexed);
            setTotal(event.total);
            break;
          case "complete":
            setIndexed(event.chunks_indexed);
            setMessage(`Done — ${event.chunks_indexed} chunks indexed`);
            break;
          case "error":
            setError(event.error);
            break;
        }
      });
      if (!result.chunks_indexed && !error) {
        setMessage("Done — 0 chunks (no vector data found)");
      }
      await load();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setRebuilding(false);
      setPhase("");
    }
  };

  if (loading) {
    return (
      <div style={{ ...css.card, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "var(--fg2)" }}>Loading keyword index status...</div>
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
        <h4 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🔍 Keyword Index</h4>
        <button type="button" style={css.btnSmall} disabled={rebuilding} onClick={handleRebuild}>
          {rebuilding ? "Rebuilding..." : status?.indexed ? "Rebuild" : "Build Index"}
        </button>
      </div>

      {error && <div style={{ ...css.error, marginBottom: 8 }}>{error}</div>}
      {message && !rebuilding && (
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

      {/* Build progress */}
      {rebuilding && (
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
            <span style={{ fontWeight: 600, color: "var(--accent)" }}>{phase}</span>
            <span style={{ color: "var(--fg2)", fontSize: 11 }}>{elapsed(startedAt)}</span>
          </div>

          {total > 0 && <ProgressBar value={indexed} max={total} label="Chunks indexed" />}
        </div>
      )}

      {status?.indexed ? (
        <div style={{ fontSize: 12, color: "var(--fg2)" }}>
          <span>
            <strong style={{ color: "var(--fg)" }}>{status.fts_chunk_count}</strong> chunks indexed
          </span>
          {" · "}
          <span>
            <strong style={{ color: "var(--fg)" }}>{status.vector_chunk_count}</strong> in vector
            store
          </span>
          {status.needs_rebuild && (
            <>
              {" · "}
              <span style={{ color: "var(--yellow, #eab308)" }}>
                out of sync — rebuild recommended
              </span>
            </>
          )}
        </div>
      ) : (
        !rebuilding && (
          <div style={{ fontSize: 12, color: "var(--fg2)" }}>
            No keyword index built yet. Click "Build Index" to enable hybrid search (vector +
            keyword) for this knowledge base.
          </div>
        )
      )}
    </div>
  );
}
