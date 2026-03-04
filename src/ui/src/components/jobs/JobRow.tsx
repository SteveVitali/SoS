import { Link, useNavigate } from "react-router-dom";
import type { Job, PrCommentStats } from "../../api.js";
import { getSlackNameCache } from "../../hooks/useSlackNames.js";
import { css, lastSubstantiveEvent } from "../../styles/theme.js";
import {
  formatDuration,
  formatPrUrl,
  formatUser,
  formatUserShort,
  relativeTime,
  shortId,
} from "../../utils/format.js";
import { JobTypeBadge, StatusBadge } from "../shared/Badge.js";
import { Dot } from "../shared/Dot.js";
import { HoverRow } from "../shared/HoverRow.js";

interface JobRowProps {
  job: Job;
  prStats: Record<string, PrCommentStats>;
  onAction: (action: "cancel" | "retry" | "delete", taskId: string) => void;
}

export function JobRow({ job, prStats, onAction }: JobRowProps) {
  const navigate = useNavigate();
  const ev = lastSubstantiveEvent(job.events);
  const cache = getSlackNameCache();

  return (
    <HoverRow onClick={() => navigate(`/jobs/${job.task_id}`)}>
      {/* Line 1: status + title + stats + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StatusBadge status={job.status} />
        <JobTypeBadge jobType={job.job_type} />
        <span style={{ ...css.link, fontWeight: 500, flex: 1, minWidth: 0 }}>
          {job.title || job.task_text.slice(0, 120)}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "var(--fg2)", whiteSpace: "nowrap" }}>
            {job.metrics?.durations?.total_ms ? formatDuration(job.metrics.durations.total_ms) : ""}
          </span>
          <span
            style={{
              fontSize: 12,
              color: "var(--fg2)",
              whiteSpace: "nowrap",
              minWidth: 48,
              textAlign: "right",
            }}
          >
            {job.metrics?.claude?.total_cost_usd != null ? (
              <span
                title={job.metrics.claude.cost_source === "computed" ? "Estimated" : "Provider"}
              >
                {job.metrics.claude.cost_source === "computed" ? "~" : ""}$
                {job.metrics.claude.total_cost_usd.toFixed(3)}
              </span>
            ) : (
              ""
            )}
          </span>
          <div
            style={{ display: "flex", gap: 2, flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {["QUEUED", "BLOCKED", "RUNNING", "FIXING_CI", "WAITING_FOR_APPROVAL"].includes(
              job.status,
            ) && (
              <button
                type="button"
                style={css.btnSmall}
                onClick={() => onAction("cancel", job.task_id)}
              >
                Cancel
              </button>
            )}
            {["FAILED", "CANCELED"].includes(job.status) && (
              <button
                type="button"
                style={css.btnSmall}
                onClick={() => onAction("retry", job.task_id)}
              >
                Retry
              </button>
            )}
            {!["RUNNING", "FIXING_CI"].includes(job.status) && (
              <button
                style={{ ...css.btnSmall, color: "var(--red)" }}
                onClick={() => onAction("delete", job.task_id)}
              >
                Del
              </button>
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
        <span style={{ ...css.mono, fontSize: 11 }}>{shortId(job.task_id)}</span>
        <Dot />
        <span title={formatUser(job.requested_by, cache)}>
          {formatUserShort(job.requested_by, cache)}
        </span>
        <Dot />
        <span>{job.repos_resolved?.join(", ") || job.repo_hint || "\u2014"}</span>
        {job.worktree_slot && (
          <>
            <Dot />
            <span style={css.mono}>{job.worktree_slot}</span>
          </>
        )}
        {job.claimed_by && ["RUNNING", "FIXING_CI"].includes(job.status) && (
          <>
            <Dot />
            <Link
              to={`/workers/${encodeURIComponent(job.claimed_by)}`}
              style={{ ...css.mono, ...css.link, textDecoration: "none", fontSize: 11 }}
              title="View worker logs"
              onClick={(e) => e.stopPropagation()}
            >
              ⚙ {job.claimed_by}
            </Link>
          </>
        )}
        <Dot />
        <span title={new Date(job.created_at).toLocaleString()}>
          {relativeTime(job.created_at)}
        </span>
        {ev && (
          <>
            <Dot />
            <span title={`${ev.type} at ${new Date(ev.at).toLocaleString()}`}>
              <span style={{ fontWeight: 600, color: "var(--fg2)" }}>{ev.type}</span>{" "}
              {relativeTime(ev.at)}
            </span>
          </>
        )}
        {job.pr_urls?.length ? (
          <>
            <Dot />
            {job.pr_urls.map((url, i) => {
              const stats = prStats[url];
              return (
                <span
                  key={i}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    marginRight: 8,
                  }}
                >
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener"
                    style={css.mono}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {formatPrUrl(url)}
                  </a>
                  {stats && stats.unresolved_threads > 0 && (
                    <span
                      style={{
                        ...css.badge("#f59e0b"),
                        fontSize: 10,
                        padding: "1px 5px",
                      }}
                      title={`${stats.unresolved_threads} unresolved review threads`}
                    >
                      {stats.unresolved_threads}
                    </span>
                  )}
                  {stats && stats.unaddressed_threads > 0 && (
                    <span
                      style={{
                        ...css.badge("#ef4444"),
                        fontSize: 10,
                        padding: "1px 5px",
                      }}
                      title={`${stats.unaddressed_threads} threads need reply`}
                    >
                      {stats.unaddressed_threads}!
                    </span>
                  )}
                </span>
              );
            })}
          </>
        ) : null}
      </div>
    </HoverRow>
  );
}
