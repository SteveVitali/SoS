import { type DragEvent, useCallback, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Drag-and-drop support — generic file drop infrastructure
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

  const nested = await Promise.all(entries.map((entry) => readEntriesRecursively(entry)));
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

  const dropZoneProps = useMemo(
    () => ({
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    }),
    [handleDragEnter, handleDragLeave, handleDragOver, handleDrop],
  );

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
