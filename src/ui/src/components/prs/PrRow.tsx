import { Link } from "react-router-dom";
import type { GitHubPr } from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";
import { Dot } from "../shared/Dot.js";
import { HoverRow } from "../shared/HoverRow.js";

interface PrRowProps {
  pr: GitHubPr;
  responding: boolean;
  onRespond: () => void;
}

function prStateColor(pr: GitHubPr): string {
  if (pr.state === "OPEN") return pr.isDraft ? "#6b7280" : "#22c55e";
  if (pr.state === "MERGED") return "#a855f7";
  return "#ef4444";
}

export function PrRow({ pr, responding, onRespond }: PrRowProps) {
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
          {/* Respond button */}
          {hasUnaddressed && (
            <button
              type="button"
              style={css.btnSmall}
              disabled={responding}
              onClick={(e) => {
                e.stopPropagation();
                onRespond();
              }}
            >
              {responding ? "..." : "Respond"}
            </button>
          )}
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
