import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getWorkerNode, shutdownWorker, subscribeWorkerLogs, type WorkerInfo } from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";

interface LogLine {
  loop_index: number;
  task_id?: string;
  line: string;
  ts: string;
}

export function WorkerDetail() {
  const { id } = useParams<{ id: string }>();
  const [worker, setWorker] = useState<WorkerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const termRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  // Load worker info
  const loadWorker = useCallback(async () => {
    if (!id) return;
    try {
      const res = await getWorkerNode(id);
      setWorker(res.worker);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadWorker();
    const timer = setInterval(loadWorker, 5000);
    return () => clearInterval(timer);
  }, [loadWorker]);

  // Subscribe to live logs
  useEffect(() => {
    if (!id) return;

    // Clean up previous subscription
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }

    setLines([]);

    const unsub = subscribeWorkerLogs(id, (logLine) => {
      setLines((prev) => {
        const next = [...prev, logLine];
        // Cap at 2000 lines in the UI
        if (next.length > 2000) return next.slice(-1500);
        return next;
      });
    });

    unsubRef.current = unsub;
    return () => unsub();
  }, [id]);

  // Auto-scroll when new lines arrive
  const prevLineCount = useRef(0);
  if (lines.length !== prevLineCount.current) {
    prevLineCount.current = lines.length;
    if (autoScroll && termRef.current) {
      requestAnimationFrame(() => {
        if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
      });
    }
  }

  const handleShutdown = async () => {
    if (!id) return;
    try {
      await shutdownWorker(id);
      loadWorker();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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

      {/* Terminal */}
      <div
        ref={termRef}
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 12,
          fontFamily: "'SF Mono', Monaco, Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          maxHeight: "calc(100vh - 280px)",
          minHeight: 400,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--fg)",
        }}
      >
        {lines.length === 0 && <span style={{ color: "var(--fg3)" }}>Waiting for log output…</span>}
        {lines.map((l, idx) => (
          <div key={`${l.ts}-${idx}`} style={{ display: "flex", gap: 8 }}>
            <span style={{ color: "var(--fg3)", flexShrink: 0, minWidth: 72 }}>
              {new Date(l.ts).toLocaleTimeString()}
            </span>
            <span style={{ flex: 1 }}>{formatLogLine(l.line)}</span>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 8,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" style={css.btnSmall} onClick={() => setLines([])}>
            Clear
          </button>
          <label
            style={{
              fontSize: 12,
              color: "var(--fg2)",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <span style={{ fontSize: 11, color: "var(--fg3)" }}>{lines.length} lines</span>
        </div>
        {worker?.status !== "offline" && (
          <button
            type="button"
            style={{ ...css.btnSmall, color: "var(--red)" }}
            onClick={handleShutdown}
          >
            Shutdown Worker
          </button>
        )}
      </div>

      {error && <div style={{ ...css.error, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function formatLogLine(raw: string): string {
  // Try to parse JSON stream-json and show a friendly summary
  try {
    const obj = JSON.parse(raw);
    if (obj.type === "system" && obj.subtype === "init") {
      return `🤖 Claude (${obj.model || "unknown"}) session started`;
    }
    if (obj.type === "assistant") {
      const content = obj.message?.content || [];
      const parts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && block.text) parts.push(block.text);
        if (block.type === "tool_use")
          parts.push(`🔧 [${block.name}] ${JSON.stringify(block.input || {}).slice(0, 150)}`);
      }
      return parts.join("\n") || raw;
    }
    if (obj.type === "tool_result") {
      const content = obj.content || "";
      const preview =
        typeof content === "string" ? content.slice(0, 200) : JSON.stringify(content).slice(0, 200);
      return `   → ${preview.split("\n")[0]}`;
    }
    if (obj.type === "result") {
      return `--- Result ---\n${obj.result || ""}`;
    }
  } catch {
    // Not JSON, return raw
  }
  return raw;
}
