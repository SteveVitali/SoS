import { useEffect, useRef, useState } from "react";
import { subscribeWorkerLogs } from "../../api.js";
import { css } from "../../styles/theme.js";

interface LogLine {
  loop_index: number;
  task_id?: string;
  line: string;
  ts: string;
}

interface LogTerminalProps {
  workerId: string;
  /** Fixed height. Use "calc(...)" for full-page, or a px value for inline. */
  height?: string | number;
}

const FONT_SIZE_KEY = "sos_log_font_size";
const DEFAULT_FONT_SIZE = 10;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 14;

function loadFontSize(): number {
  try {
    const v = localStorage.getItem(FONT_SIZE_KEY);
    if (v) {
      const n = Number(v);
      if (n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
    }
  } catch {
    // ignore
  }
  return DEFAULT_FONT_SIZE;
}

export function LogTerminal({ workerId, height = 400 }: LogTerminalProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const termRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  // Subscribe to live logs
  useEffect(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }

    setLines([]);

    const unsub = subscribeWorkerLogs(workerId, (logLine) => {
      setLines((prev) => {
        const next = [...prev, logLine];
        if (next.length > 2000) return next.slice(-1500);
        return next;
      });
    });

    unsubRef.current = unsub;
    return () => unsub();
  }, [workerId]);

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

  const changeFontSize = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, prev + delta));
      try {
        localStorage.setItem(FONT_SIZE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div>
      <div
        ref={termRef}
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 8,
          fontFamily: "'SF Mono', Monaco, Consolas, monospace",
          fontSize,
          lineHeight: 1.4,
          height,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--fg)",
        }}
      >
        {lines.length === 0 && <span style={{ color: "var(--fg3)" }}>Waiting for log output…</span>}
        {lines.map((l, idx) => (
          <div key={`${l.ts}-${idx}`} style={{ display: "flex", gap: 6 }}>
            <span style={{ color: "var(--fg3)", flexShrink: 0, minWidth: 62 }}>
              {new Date(l.ts).toLocaleTimeString()}
            </span>
            <span style={{ flex: 1 }}>{formatLogLine(l.line)}</span>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 4,
          gap: 8,
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" style={css.btnSmall} onClick={() => setLines([])}>
            Clear
          </button>
          <label
            style={{
              fontSize: 11,
              color: "var(--fg2)",
              display: "flex",
              alignItems: "center",
              gap: 3,
            }}
          >
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Scroll
          </label>
          <span style={{ fontSize: 10, color: "var(--fg3)" }}>{lines.length} lines</span>
        </div>
        <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
          <button
            type="button"
            style={{ ...css.btnSmall, padding: "2px 6px", fontSize: 11 }}
            onClick={() => changeFontSize(-1)}
            disabled={fontSize <= MIN_FONT_SIZE}
            title="Decrease font size"
          >
            A−
          </button>
          <span style={{ fontSize: 10, color: "var(--fg3)", minWidth: 22, textAlign: "center" }}>
            {fontSize}
          </span>
          <button
            type="button"
            style={{ ...css.btnSmall, padding: "2px 6px", fontSize: 11 }}
            onClick={() => changeFontSize(1)}
            disabled={fontSize >= MAX_FONT_SIZE}
            title="Increase font size"
          >
            A+
          </button>
        </div>
      </div>
    </div>
  );
}

function formatLogLine(raw: string): string {
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
