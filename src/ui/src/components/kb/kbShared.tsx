import { type DragEvent, type RefObject, useCallback, useRef, useState } from "react";
import type { KBScope, KBSearchResult, UploadJob } from "../../api.js";
import { css } from "../../styles/theme.js";

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

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
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
      {total > 0 && (
        <div
          style={{
            width: 60,
            height: 4,
            borderRadius: 2,
            background: "var(--border)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "var(--accent)",
              borderRadius: 2,
              transition: "width 0.3s ease",
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag-and-drop support
// ---------------------------------------------------------------------------

/**
 * Recursively read all files from a dropped FileSystemEntry tree.
 * Handles both individual files and directories.
 */
async function readEntriesRecursively(entry: FileSystemEntry, path = ""): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file((file) => {
        // Preserve the relative path so the server sees folder structure
        const fullPath = path ? `${path}/${file.name}` : file.name;
        const withPath = new File([file], fullPath, {
          type: file.type,
          lastModified: file.lastModified,
        });
        resolve([withPath]);
      }, reject);
    });
  }
  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      const all: FileSystemEntry[] = [];
      const readBatch = () => {
        dirReader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(all);
          } else {
            all.push(...batch);
            readBatch(); // readEntries may return partial results
          }
        }, reject);
      };
      readBatch();
    });
    const nested = await Promise.all(
      entries.map((e) => readEntriesRecursively(e, path ? `${path}/${entry.name}` : entry.name)),
    );
    return nested.flat();
  }
  return [];
}

/**
 * Extract File objects from a drop event, recursively reading directories.
 */
async function filesFromDrop(e: DragEvent): Promise<File[]> {
  const items = e.dataTransfer?.items;
  if (!items) return Array.from(e.dataTransfer?.files ?? []);

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    // Fallback: browser doesn't support webkitGetAsEntry
    return Array.from(e.dataTransfer?.files ?? []);
  }

  const nested = await Promise.all(entries.map((e) => readEntriesRecursively(e)));
  return nested.flat();
}

/**
 * Hook for drag-and-drop file handling. Returns drag state and event handlers
 * to spread onto a container element.
 *
 * Usage:
 * ```tsx
 * const { isDragging, dropZoneProps } = useDropZone({ onDrop, disabled });
 * return <div {...dropZoneProps}>...</div>;
 * ```
 */
export function useDropZone({
  onDrop,
  disabled = false,
}: {
  onDrop: (files: File[]) => void;
  disabled?: boolean;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      dragCounter.current++;
      if (e.dataTransfer?.types?.includes("Files")) {
        setIsDragging(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled && e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    },
    [disabled],
  );

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragging(false);
      if (disabled) return;
      const files = await filesFromDrop(e);
      if (files.length > 0) onDrop(files);
    },
    [disabled, onDrop],
  );

  const dropZoneProps = {
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
  };

  return { isDragging, dropZoneProps } as const;
}

/**
 * Semi-transparent overlay shown when files are being dragged over a drop zone.
 */
export function DropOverlay({ message = "Drop files here" }: { message?: string }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(59, 130, 246, 0.08)",
        border: "2px dashed var(--accent)",
        borderRadius: "var(--radius)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 20,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--accent)",
          background: "var(--bg2)",
          padding: "8px 16px",
          borderRadius: "var(--radius)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        }}
      >
        {message}
      </span>
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
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
          {(result.score * 100).toFixed(1)}%
        </span>
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
