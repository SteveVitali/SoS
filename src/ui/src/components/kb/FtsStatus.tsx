import { useCallback, useEffect, useState } from "react";
import {
  type FtsRebuildEvent,
  type FtsStatus as FtsStatusType,
  getFtsStatus,
  rebuildFtsIndex,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { BuildProgressBox, IndexStatusCard, ProgressBar } from "../shared/IndexCard.js";

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
    <IndexStatusCard
      icon="🔍"
      title="Keyword Index"
      buttonLabel={rebuilding ? "Rebuilding..." : status?.indexed ? "Rebuild" : "Build Index"}
      buttonDisabled={rebuilding}
      onButtonClick={handleRebuild}
      error={error}
      successMessage={message}
      showSuccess={!rebuilding && !!message}
      isActive={rebuilding}
      progressContent={
        <BuildProgressBox phase={phase} elapsedStart={startedAt}>
          {total > 0 && <ProgressBar value={indexed} max={total} label="Chunks indexed" />}
        </BuildProgressBox>
      }
      summaryContent={
        status?.indexed ? (
          <div style={{ fontSize: 12, color: "var(--fg2)" }}>
            <span>
              <strong style={{ color: "var(--fg)" }}>{status.fts_chunk_count}</strong> chunks
              indexed
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
        ) : undefined
      }
      isEmpty={!status?.indexed}
      emptyMessage='No keyword index built yet. Click "Build Index" to enable hybrid search (vector + keyword) for this knowledge base.'
    />
  );
}
