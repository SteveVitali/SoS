import { useCallback, useEffect, useMemo, useState } from "react";
import { getRaptorTree, type RaptorNode } from "../../api.js";
import { css } from "../../styles/theme.js";

const LEVEL_COLORS = ["var(--accent)", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"];

function levelColor(level: number): string {
  return LEVEL_COLORS[Math.min(level, LEVEL_COLORS.length - 1)];
}

interface TreeNodeProps {
  node: RaptorNode;
  nodeMap: Map<string, RaptorNode>;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}

function TreeNode({
  node,
  nodeMap,
  expandedIds,
  onToggle,
  selectedId,
  onSelect,
  depth,
}: TreeNodeProps) {
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children_ids.length > 0;
  const childNodes = node.children_ids.map((id) => nodeMap.get(id)).filter(Boolean) as RaptorNode[];

  return (
    <div style={{ marginLeft: depth > 0 ? 16 : 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderRadius: "var(--radius)",
          cursor: "pointer",
          background: isSelected ? "rgba(99,102,241,0.15)" : "transparent",
          borderLeft: `3px solid ${levelColor(node.level)}`,
          marginBottom: 2,
        }}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren && childNodes.length > 0 ? (
          <span
            style={{ fontSize: 10, color: "var(--fg2)", userSelect: "none", width: 12 }}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            {isExpanded ? "▼" : "▶"}
          </span>
        ) : (
          <span style={{ width: 12, textAlign: "center", fontSize: 9, color: "var(--fg2)" }}>
            {node.level === 0 ? "·" : ""}
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: levelColor(node.level),
            flexShrink: 0,
          }}
        >
          L{node.level}
        </span>
        {node.level === 0 && node.source_file && !node.source_file.startsWith("__raptor") && (
          <span
            style={{
              fontSize: 10,
              color: "var(--fg2)",
              fontFamily: "monospace",
              flexShrink: 0,
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={node.source_file}
          >
            {node.source_file}
          </span>
        )}
        <span
          style={{
            fontSize: 12,
            color: "var(--fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {node.content.slice(0, 80)}
          {node.content.length > 80 ? "…" : ""}
        </span>
        {hasChildren && childNodes.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--fg2)", flexShrink: 0 }}>
            {childNodes.length} children
          </span>
        )}
      </div>
      {isExpanded &&
        childNodes.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            nodeMap={nodeMap}
            expandedIds={expandedIds}
            onToggle={onToggle}
            selectedId={selectedId}
            onSelect={onSelect}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

export function RaptorTree({ kbId }: { kbId: string }) {
  const [nodes, setNodes] = useState<RaptorNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getRaptorTree(kbId);
      setNodes(data.nodes);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    load();
  }, [load]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Root nodes = highest level nodes (not referenced as children by any other node)
  const rootNodes = useMemo(() => {
    const allChildIds = new Set(nodes.flatMap((n) => n.children_ids));
    return nodes
      .filter((n) => !allChildIds.has(n.id))
      .sort((a, b) => b.level - a.level || a.content.localeCompare(b.content));
  }, [nodes]);

  // Group by level for the legend
  const levels = useMemo(
    () => [...new Set(nodes.map((n) => n.level))].sort((a, b) => a - b),
    [nodes],
  );

  if (loading) {
    return (
      <div style={{ ...css.card, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "var(--fg2)" }}>Loading RAPTOR tree...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ ...css.card, marginBottom: 12 }}>
        <div style={css.error}>{error}</div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return null;
  }

  const selectedNode = selectedId ? nodeMap.get(selectedId) : null;

  const handleToggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExpandAll = () => {
    setExpandedIds(new Set(nodes.map((n) => n.id)));
  };

  const handleCollapseAll = () => {
    setExpandedIds(new Set());
  };

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
        <h4 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>RAPTOR Tree</h4>
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" style={css.btnSmall} onClick={handleExpandAll}>
            Expand All
          </button>
          <button type="button" style={css.btnSmall} onClick={handleCollapseAll}>
            Collapse All
          </button>
          <button type="button" style={css.btnSmall} onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      {/* Level legend */}
      <div
        style={{ display: "flex", gap: 12, marginBottom: 10, fontSize: 11, color: "var(--fg2)" }}
      >
        {levels.map((level) => {
          const count = nodes.filter((n) => n.level === level).length;
          return (
            <span key={level} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: levelColor(level),
                  display: "inline-block",
                }}
              />
              L{level}: {count} nodes
            </span>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        {/* Tree panel */}
        <div
          style={{
            flex: 1,
            maxHeight: 400,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 8,
            background: "var(--bg)",
          }}
        >
          {rootNodes.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              nodeMap={nodeMap}
              expandedIds={expandedIds}
              onToggle={handleToggle}
              selectedId={selectedId}
              onSelect={setSelectedId}
              depth={0}
            />
          ))}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div
            style={{
              width: 320,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 12,
              background: "var(--bg)",
              maxHeight: 400,
              overflowY: "auto",
            }}
          >
            <div style={{ marginBottom: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: levelColor(selectedNode.level),
                }}
              >
                Level {selectedNode.level}
              </span>
              {selectedNode.section && (
                <span style={{ fontSize: 11, color: "var(--fg2)", marginLeft: 8 }}>
                  {selectedNode.section}
                </span>
              )}
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
              {selectedNode.content}
            </pre>
            {selectedNode.children_ids.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--fg2)" }}>
                <strong>{selectedNode.children_ids.length}</strong> child node
                {selectedNode.children_ids.length !== 1 ? "s" : ""}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
