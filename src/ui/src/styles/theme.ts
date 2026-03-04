import type React from "react";

export const STATUS_COLORS: Record<string, string> = {
  QUEUED: "#3b82f6",
  BLOCKED: "#6366f1",
  PLANNING: "#818cf8",
  PENDING_CONFIRMATION: "#a855f7",
  RUNNING: "#eab308",
  FIXING_CI: "#f97316",
  WAITING_FOR_APPROVAL: "#a855f7",
  DONE: "#22c55e",
  FAILED: "#ef4444",
  CANCELED: "#6b7280",
  DELETED: "#4b5563",
};

export const EVENT_LABELS: Record<string, string> = {
  COMMENTS_FETCHED: "Comments Fetched",
  COMMENT_ADDRESSED: "Comment Addressed",
  COMMENTS_PUSHED: "Comments Pushed",
  REVIEW_GENERATED: "Review Generated",
  COMMENTS_PARSED: "Comments Parsed",
  REVIEW_POSTED: "Review Posted",
  BLOCKED: "Blocked",
  SELF_REVIEW_FINISHED: "Self-Review Finished",
  PLAN_STARTED: "Plan Started",
  PLAN_GENERATED: "Plan Generated",
  PLAN_CONFIRMED: "Plan Confirmed",
};

export const TERMINAL_EVENT_TYPES = new Set(["DONE", "FAILED", "CANCELED", "QUEUED", "REAPED"]);

export function lastSubstantiveEvent(
  events?: Array<{ at: string; type: string }>,
): { at: string; type: string } | undefined {
  if (!events?.length) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (!TERMINAL_EVENT_TYPES.has(events[i].type)) return events[i];
  }
  return events[events.length - 1];
}

export function eventColor(type: string): string {
  if (type.includes("FAIL") || type === "CANCELED") return "var(--red)";
  if (
    type === "DONE" ||
    type.includes("GREEN") ||
    type === "COMMENTS_PUSHED" ||
    type === "COMMENT_ADDRESSED"
  )
    return "var(--green)";
  return "var(--accent)";
}

// --- Shared inline style tokens ---
export const css = {
  container: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "20px 24px",
    overflowX: "hidden",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 0",
    borderBottom: "1px solid var(--border)",
    marginBottom: 24,
  } as React.CSSProperties,
  title: { fontSize: 22, fontWeight: 700, color: "var(--fg)" } as React.CSSProperties,
  nav: { display: "flex", gap: 8 } as React.CSSProperties,
  btn: {
    padding: "8px 16px",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    background: "var(--bg2)",
    color: "var(--fg)",
    fontSize: 14,
    fontWeight: 500,
  } as React.CSSProperties,
  btnPrimary: {
    padding: "8px 16px",
    borderRadius: "var(--radius)",
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 500,
  } as React.CSSProperties,
  btnDanger: {
    padding: "6px 12px",
    borderRadius: "var(--radius)",
    border: "none",
    background: "#dc2626",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
  } as React.CSSProperties,
  btnSmall: {
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg3)",
    color: "var(--fg2)",
    fontSize: 12,
  } as React.CSSProperties,
  card: {
    background: "var(--bg2)",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    padding: 20,
    marginBottom: 16,
  } as React.CSSProperties,
  table: {
    width: "100%",
    minWidth: 900,
    borderCollapse: "collapse" as const,
    tableLayout: "fixed" as const,
    fontSize: 14,
  },
  th: {
    textAlign: "left" as const,
    padding: "10px 8px",
    borderBottom: "1px solid var(--border)",
    color: "var(--fg2)",
    fontWeight: 600,
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  td: {
    padding: "10px 8px",
    borderBottom: "1px solid var(--border)",
    verticalAlign: "top" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  badge: (color: string) => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 600,
    background: `${color}22`,
    color,
    border: `1px solid ${color}44`,
  }),
  input: {
    padding: "8px 12px",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    background: "var(--bg3)",
    color: "var(--fg)",
    fontSize: 14,
    width: "100%",
  } as React.CSSProperties,
  select: {
    padding: "8px 12px",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    background: "var(--bg3)",
    color: "var(--fg)",
    fontSize: 14,
  } as React.CSSProperties,
  textarea: {
    padding: "8px 12px",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    background: "var(--bg3)",
    color: "var(--fg)",
    fontSize: 14,
    width: "100%",
    minHeight: 100,
    resize: "vertical" as const,
  } as React.CSSProperties,
  label: {
    display: "block",
    marginBottom: 4,
    fontSize: 13,
    color: "var(--fg2)",
    fontWeight: 500,
  },
  field: { marginBottom: 16 } as React.CSSProperties,
  row: { display: "flex", gap: 12, flexWrap: "wrap" as const } as React.CSSProperties,
  filters: {
    display: "flex",
    gap: 10,
    marginBottom: 16,
    alignItems: "center",
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  section: { marginBottom: 20 } as React.CSSProperties,
  sectionTitle: { fontSize: 15, fontWeight: 600, marginBottom: 8, color: "var(--fg)" },
  mono: { fontFamily: "'SF Mono', Monaco, Consolas, monospace", fontSize: 13 },
  pre: {
    background: "var(--bg)",
    padding: 12,
    borderRadius: "var(--radius)",
    fontSize: 12,
    fontFamily: "'SF Mono', Monaco, Consolas, monospace",
    overflowX: "auto" as const,
    border: "1px solid var(--border)",
    whiteSpace: "pre-wrap" as const,
    maxHeight: 300,
    overflow: "auto",
  } as React.CSSProperties,
  timeline: {
    borderLeft: "2px solid var(--border)",
    paddingLeft: 16,
    marginLeft: 8,
  } as React.CSSProperties,
  timelineItem: { marginBottom: 12, position: "relative" as const } as React.CSSProperties,
  dot: (color: string) => ({
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: color,
    position: "absolute" as const,
    left: -22,
    top: 6,
  }),
  tokenSetup: {
    background: "var(--bg2)",
    padding: 24,
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    maxWidth: 400,
    margin: "80px auto",
  } as React.CSSProperties,
  error: { color: "var(--red)", fontSize: 13, marginTop: 4 },
  link: { color: "var(--accent2)", cursor: "pointer" },
};
