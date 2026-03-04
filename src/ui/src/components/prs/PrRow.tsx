import { useState } from "react";
import { Link } from "react-router-dom";
import type { GitHubPr } from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";
import { Dot } from "../shared/Dot.js";
import { HoverRow } from "../shared/HoverRow.js";

export type PrAction = "self_review" | "add_review_comments" | "respond_to_comments";

interface PrRowProps {
  pr: GitHubPr;
  busy: boolean;
  onTrigger: (action: PrAction) => void;
}

function prStateColor(pr: GitHubPr): string {
  if (pr.state === "OPEN") return pr.isDraft ? "#6b7280" : "#22c55e";
  if (pr.state === "MERGED") return "#a855f7";
  return "#ef4444";
}

const ACTION_LABELS: Record<PrAction, string> = {
  self_review: "Self Review",
  add_review_comments: "Add Review Comments",
  respond_to_comments: "Respond to Comments",
};

export function PrRow({ pr, busy, onTrigger }: PrRowProps) {
  const [open, setOpen] = useState(false);
  const hasUnaddressed = pr.comments && pr.comments.unaddressed_threads > 0;
  const hasUnresolved = pr.comments && pr.comments.unresolved_threads > 0;

  return (
    <HoverRow>
      {/* Line 1: state badge + title + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={css.badge(prStateColor(pr))}>{pr.isDraft ? "DRAFT" : pr.state}</span>
        <a
          href={pr.url}
          target="_blank"
          rel="noopener"
          style={{
            ...css.link,
            fontWeight: 500,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {pr.title}
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {/* Comment stats badges */}
          {pr.comments && (
            <div style={{ display: "flex", gap: 6, fontSize: 11 }}>
              {pr.comments.total_threads > 0 && (
                <span
                  style={{ ...css.badge("#6b7280"), fontSize: 11 }}
                  title={`${pr.comments.total_threads} review threads, ${pr.comments.total_comments} comments total`}
                >
                  {pr.comments.total_threads} threads
                </span>
              )}
              {hasUnresolved && (
                <span
                  style={{ ...css.badge("#f59e0b"), fontSize: 11 }}
                  title={`${pr.comments.unresolved_threads} unresolved review threads`}
                >
                  {pr.comments.unresolved_threads} unresolved
                </span>
              )}
              {hasUnaddressed && (
                <span
                  style={{ ...css.badge("#ef4444"), fontSize: 11 }}
                  title={`${pr.comments.unaddressed_threads} threads awaiting response (last comment not from bot)`}
                >
                  {pr.comments.unaddressed_threads} needs reply
                </span>
              )}
            </div>
          )}
          {/* Trigger dropdown */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              style={css.btnSmall}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => !o);
              }}
            >
              {busy ? "..." : "Trigger ▾"}
            </button>
            {open && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "100%",
                  marginTop: 4,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                  zIndex: 10,
                  minWidth: 200,
                  overflow: "hidden",
                }}
              >
                {(["self_review", "add_review_comments", "respond_to_comments"] as PrAction[]).map(
                  (action) => (
                    <button
                      key={action}
                      type="button"
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "8px 14px",
                        background: "transparent",
                        border: "none",
                        color: "var(--fg)",
                        fontSize: 13,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => {
                        (e.target as HTMLElement).style.background = "var(--bg2)";
                      }}
                      onMouseLeave={(e) => {
                        (e.target as HTMLElement).style.background = "transparent";
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        onTrigger(action);
                      }}
                    >
                      {ACTION_LABELS[action]}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Line 2: metadata chips */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 0",
          marginTop: 6,
          fontSize: 12,
          color: "var(--fg3)",
          alignItems: "center",
        }}
      >
        <span style={css.mono}>
          {pr.repoFullName}#{pr.number}
        </span>
        <Dot />
        <span>{pr.author}</span>
        <Dot />
        <span style={css.mono}>{pr.headRefName}</span>
        <Dot />
        <span style={{ color: "var(--fg3)" }} title={new Date(pr.updatedAt).toLocaleString()}>
          {relativeTime(pr.updatedAt)}
        </span>
        <Dot />
        <span style={{ color: "#22c55e" }}>+{pr.additions}</span>
        <span style={{ margin: "0 4px" }}>/</span>
        <span style={{ color: "#ef4444" }}>-{pr.deletions}</span>
        {pr.linkedJobTaskId && (
          <>
            <Dot />
            <Link
              to={`/jobs/${pr.linkedJobTaskId}`}
              style={{ ...css.link, ...css.mono, fontSize: 11 }}
              onClick={(e) => e.stopPropagation()}
            >
              job {pr.linkedJobTaskId.slice(0, 8)}
            </Link>
          </>
        )}
      </div>
    </HoverRow>
  );
}
