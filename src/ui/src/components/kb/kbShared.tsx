import { type ReactNode, type RefObject, useCallback, useState } from "react";
import type {
  HybridSearchStats,
  KBScope,
  KBSearchResult,
  RetrievalSource,
  UploadJob,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { MiniProgressBar } from "../shared/IndexCard.js";

export const SCOPE_COLORS: Record<string, string> = {
  all: "#a855f7",
  chat: "#3b82f6",
  create_job: "#22c55e",
  plan_job: "#eab308",
  agent_task: "#f97316",
};

export const ALL_SCOPES: KBScope[] = ["chat", "create_job", "plan_job", "agent_task", "all"];

export function useToggleScopes(initial: KBScope[] = [...ALL_SCOPES]) {
  const [scopes, setScopes] = useState<KBScope[]>(initial);
  const toggle = useCallback(
    (scope: KBScope) =>
      setScopes((prev) =>
        prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
      ),
    [],
  );
  return { scopes, toggle } as const;
}

export function sessionStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    case "budget_exhausted":
      return "#eab308";
    case "running":
      return "#3b82f6";
    default:
      return "var(--fg2)";
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function strategyColor(strategy: string): string {
  switch (strategy) {
    case "agent":
      return "#8b5cf6";
    case "deep":
      return "#3b82f6";
    case "simple":
      return "#22c55e";
    default:
      return "var(--fg2)";
  }
}

export function ScopeBadge({ scope }: { scope: string }) {
  const color = SCOPE_COLORS[scope] || "#6b7280";
  return <span style={css.badge(color)}>{scope}</span>;
}

export function ScopeToggleButtons({
  scopes,
  onToggle,
}: {
  scopes: KBScope[];
  onToggle: (scope: KBScope) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
      {ALL_SCOPES.map((scope) => (
        <button
          key={scope}
          type="button"
          onClick={() => onToggle(scope)}
          style={{
            ...css.btnSmall,
            background: scopes.includes(scope) ? "var(--accent)" : "var(--bg3)",
            color: scopes.includes(scope) ? "#fff" : "var(--fg2)",
            border: scopes.includes(scope) ? "1px solid var(--accent)" : "1px solid var(--border)",
          }}
        >
          {scope}
        </button>
      ))}
    </div>
  );
}

export function UploadDropdown({
  menuRef,
  open,
  onToggle,
  disabled,
  onSelectFiles,
  onSelectFolder,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  onSelectFiles: () => void;
  onSelectFolder: () => void;
}) {
  const items = [
    { label: "Select Files", action: onSelectFiles },
    { label: "Select Folder", action: onSelectFolder },
  ];
  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" style={css.btn} disabled={disabled} onClick={onToggle}>
        {disabled ? "Uploading…" : "Upload ▾"}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "var(--bg2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            zIndex: 10,
            minWidth: 160,
            overflow: "hidden",
          }}
        >
          {items.map(({ label, action }) => (
            <button
              key={label}
              type="button"
              onClick={action}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 14px",
                background: "none",
                border: "none",
                color: "var(--fg)",
                fontSize: 13,
                textAlign: "left",
                cursor: "pointer",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background = "var(--bg)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background = "none")
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact badge showing upload progress for a KB.
 * Used on both the listing page (KB cards) and the detail page.
 */
export function UploadProgressBadge({ job }: { job: UploadJob }) {
  const total = job.files.length;
  const done = job.files.filter(
    (f) => f.status === "done" || f.status === "skipped" || f.status === "error",
  ).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (job.status === "completed") {
    const s = job.summary;
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: "var(--green)",
        }}
      >
        <span>✓</span>
        <span>
          Upload complete
          {s
            ? ` — ${s.documents_added} doc${s.documents_added !== 1 ? "s" : ""}, ${s.chunks_added} chunks`
            : ""}
        </span>
      </div>
    );
  }

  if (job.status === "failed") {
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: "var(--red)",
        }}
      >
        <span>✗</span>
        <span>Upload failed</span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: "var(--accent)",
      }}
    >
      <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
      <span>
        Uploading {done}/{total} files
      </span>
      {total > 0 && <MiniProgressBar pct={pct} />}
    </div>
  );
}

export const SOURCE_STYLES: Record<
  RetrievalSource,
  { icon: string; label: string; color: string }
> = {
  vector: { icon: "🧠", label: "vector", color: "#a855f7" },
  keyword: { icon: "🔍", label: "keyword", color: "#3b82f6" },
  both: { icon: "⚡", label: "both", color: "#22c55e" },
};

function RetrievalSourceBadge({
  source,
  vectorRank,
  keywordRank,
}: {
  source: RetrievalSource;
  vectorRank?: number;
  keywordRank?: number;
}) {
  const s = SOURCE_STYLES[source];
  const rankLabel =
    source === "both"
      ? `#${vectorRank}/#${keywordRank}`
      : source === "vector"
        ? `#${vectorRank}`
        : `#${keywordRank}`;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "1px 5px",
        borderRadius: 3,
        background: `${s.color}18`,
        color: s.color,
        whiteSpace: "nowrap",
      }}
      title={`Found via ${s.label} search (rank ${rankLabel})`}
    >
      {s.icon} {s.label} {rankLabel}
    </span>
  );
}

export function SourceCountBadge({ source, count }: { source: RetrievalSource; count: number }) {
  if (count === 0) return null;
  const s = SOURCE_STYLES[source];
  return (
    <span style={{ color: s.color }}>
      {s.icon} {count} {s.label}
    </span>
  );
}

export function RetrievalSummary({ stats }: { stats: HybridSearchStats }) {
  if (stats.total === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        fontSize: 12,
        color: "var(--fg2)",
        padding: "6px 0",
      }}
    >
      <span style={{ fontWeight: 600, color: "var(--fg)" }}>{stats.total} results:</span>
      <SourceCountBadge source="vector" count={stats.vector_only} />
      <SourceCountBadge source="keyword" count={stats.keyword_only} />
      <SourceCountBadge source="both" count={stats.both} />
    </div>
  );
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 12 }}>
      <h4
        style={{
          fontSize: 13,
          fontWeight: 600,
          margin: "0 0 8px",
          color: "var(--fg)",
          cursor: "pointer",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ fontSize: 11, color: "var(--fg2)" }}>{open ? "▼" : "▶"}</span>
        {title}
      </h4>
      {open && children}
    </div>
  );
}

const DEFAULT_PREVIEW_CHARS = 400;

export function ExpandableText({
  text,
  previewChars = DEFAULT_PREVIEW_CHARS,
  fontSize = 12,
}: {
  text: string;
  previewChars?: number;
  fontSize?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > previewChars;

  return (
    <div>
      <pre
        style={{
          fontSize,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
          color: "var(--fg)",
          lineHeight: 1.5,
        }}
      >
        {expanded || !needsTruncation ? text : `${text.slice(0, previewChars)}\u2026`}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            background: "none",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: fontSize - 1,
            fontWeight: 600,
            padding: "4px 0 0",
          }}
        >
          {expanded ? "Show less" : "Show full answer"}
        </button>
      )}
    </div>
  );
}

export function SearchResultCard({
  result,
  showKBName,
}: {
  result: KBSearchResult;
  showKBName?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const truncateAt = 300;
  const needsTruncation = result.content.length > truncateAt;
  const preview =
    needsTruncation && !expanded ? result.content.slice(0, truncateAt) : result.content;

  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {showKBName && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--accent)22",
                color: "var(--accent)",
              }}
            >
              {result.kb_name}
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--fg2)", fontFamily: "monospace" }}>
            {result.source_file}
            {result.metadata.section ? ` > ${result.metadata.section}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {result.retrieval_source && (
            <RetrievalSourceBadge
              source={result.retrieval_source}
              vectorRank={result.vector_rank}
              keywordRank={result.keyword_rank}
            />
          )}
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
            {(result.score * 100).toFixed(1)}%
          </span>
        </div>
      </div>
      <pre
        style={{
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
          fontFamily: "monospace",
          color: "var(--fg)",
        }}
      >
        {preview}
        {needsTruncation && !expanded ? "..." : ""}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            background: "none",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 11,
            padding: "4px 0 0",
          }}
        >
          {expanded ? "Show less" : "Show full"}
        </button>
      )}
    </div>
  );
}
