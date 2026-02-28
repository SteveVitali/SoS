import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  cancelJob,
  confirmPlan,
  deleteJob,
  getJob,
  type Job,
  promotePr,
  respondToComments,
  retryJob,
} from "../../api.js";
import { getSlackNameCache, useSlackNames } from "../../hooks/useSlackNames.js";
import { useAppData } from "../../stores/AppDataContext.js";
import { css } from "../../styles/theme.js";
import { formatPrUrl, formatUser, relativeTime, shortId } from "../../utils/format.js";
import { JobTypeBadge, StatusBadge } from "../shared/Badge.js";
import { LogTerminal } from "../workers/LogTerminal.js";
import { EventsTimeline } from "./EventsTimeline.js";
import { PerformanceCard } from "./PerformanceCard.js";

export function JobDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { refreshJobs } = useAppData();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");

  useSlackNames(job ? [job.requested_by] : []);

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const res = await getJob(taskId);
      setJob(res.job);
    } catch (err: unknown) {
      setError(err instanceof Error ? (err as Error).message : String(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAction = async (
    action: "cancel" | "retry" | "delete" | "promote" | "respond_comments" | "confirm_plan",
  ) => {
    if (!taskId) return;
    setActionError("");
    try {
      if (action === "cancel") {
        await cancelJob(taskId);
        load();
        refreshJobs();
      } else if (action === "retry") {
        const res = await retryJob(taskId);
        refreshJobs();
        navigate(`/jobs/${res.job.task_id}`);
      } else if (action === "delete") {
        await deleteJob(taskId);
        refreshJobs();
        navigate("/");
      } else if (action === "promote") {
        await promotePr(taskId);
        load();
        refreshJobs();
      } else if (action === "respond_comments") {
        const res = await respondToComments(taskId);
        refreshJobs();
        navigate(`/jobs/${res.job.task_id}`);
      } else if (action === "confirm_plan") {
        await confirmPlan(taskId);
        load();
        refreshJobs();
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? (err as Error).message : String(err));
    }
  };

  if (!taskId) return <div style={css.error}>No task ID provided</div>;
  if (loading) return <div style={{ color: "var(--fg2)", padding: 20 }}>Loading...</div>;
  if (error) return <div style={css.error}>{error}</div>;
  if (!job) return <div style={css.error}>Job not found</div>;

  const cache = getSlackNameCache();

  return (
    <div>
      <Link to="/" style={{ textDecoration: "none" }}>
        <button type="button" style={{ ...css.btn, marginBottom: 16 }}>
          ← Back to Jobs
        </button>
      </Link>

      {/* Header */}
      <div style={css.card}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 16,
          }}
        >
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
              {job.title || job.task_text.slice(0, 80)}
            </h2>
            <div style={{ ...css.mono, fontSize: 13, color: "var(--fg3)", marginBottom: 8 }}>
              {job.task_id}
            </div>
            <div style={css.row}>
              <StatusBadge status={job.status} />
              <span style={{ color: "var(--fg2)", fontSize: 13 }} title={job.requested_by}>
                by {formatUser(job.requested_by, cache)} · {relativeTime(job.created_at)}
              </span>
              <JobTypeBadge jobType={job.job_type} />
              {job.parent_task_id && (
                <span style={{ fontSize: 13 }}>
                  {job.job_type === "respond_to_pr_comments" ? "PR from" : "Retry of"}{" "}
                  <Link to={`/jobs/${job.parent_task_id}`} style={{ ...css.link, ...css.mono }}>
                    {shortId(job.parent_task_id)}
                  </Link>
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={css.btn} onClick={load}>
              ↻
            </button>
            {[
              "QUEUED",
              "RUNNING",
              "FIXING_CI",
              "WAITING_FOR_APPROVAL",
              "PENDING_CONFIRMATION",
            ].includes(job.status) && (
              <button type="button" style={css.btnDanger} onClick={() => handleAction("cancel")}>
                Cancel
              </button>
            )}
            {job.status === "PENDING_CONFIRMATION" && (
              <button
                type="button"
                style={css.btnPrimary}
                onClick={() => handleAction("confirm_plan")}
              >
                ✅ Confirm Plan
              </button>
            )}
            {job.status === "WAITING_FOR_APPROVAL" && (
              <button type="button" style={css.btnPrimary} onClick={() => handleAction("promote")}>
                Promote PR
              </button>
            )}
            {["FAILED", "CANCELED"].includes(job.status) && (
              <button type="button" style={css.btnPrimary} onClick={() => handleAction("retry")}>
                Retry
              </button>
            )}
            {job.pr_urls?.length && ["DONE", "WAITING_FOR_APPROVAL"].includes(job.status) && (
              <button
                type="button"
                style={css.btnPrimary}
                onClick={() => handleAction("respond_comments")}
              >
                Respond to Comments
              </button>
            )}
            {!["RUNNING", "FIXING_CI"].includes(job.status) && (
              <button type="button" style={css.btnDanger} onClick={() => handleAction("delete")}>
                Delete
              </button>
            )}
          </div>
        </div>
        {actionError && <div style={css.error}>{actionError}</div>}
      </div>

      {/* Task */}
      <div style={css.card}>
        <div style={css.sectionTitle}>Task</div>
        <div style={css.pre}>{job.task_text}</div>
        {job.pr_url && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            <span style={{ color: "var(--fg2)" }}>Target PR: </span>
            <a href={job.pr_url} target="_blank" rel="noopener" style={css.link}>
              {formatPrUrl(job.pr_url)}
            </a>
          </div>
        )}
        <div style={{ ...css.row, marginTop: 12, fontSize: 13, color: "var(--fg2)" }}>
          {job.repo_hint && (
            <span>
              repo_hint: <b>{job.repo_hint}</b>
            </span>
          )}
          {job.test_level && (
            <span>
              test_level: <b>{job.test_level}</b>
            </span>
          )}
          {job.ci_fix_enabled !== undefined && (
            <span>
              ci_fix: <b>{job.ci_fix_enabled ? "on" : "off"}</b>
            </span>
          )}
          {job.reviewers?.length ? (
            <span>
              reviewers: <b>{job.reviewers.join(", ")}</b>
            </span>
          ) : null}
        </div>
      </div>

      {/* Slack */}
      {job.slack?.channel_id && (
        <div style={css.card}>
          <div style={css.sectionTitle}>Slack</div>
          <div style={{ fontSize: 13, color: "var(--fg2)" }}>
            Channel: <span style={css.mono}>{job.slack.channel_id}</span> · Thread:{" "}
            <span style={css.mono}>{job.slack.thread_ts}</span>
            {job.slack.permalink && (
              <>
                {" "}
                ·{" "}
                <a href={job.slack.permalink} target="_blank" rel="noopener">
                  Open in Slack
                </a>
              </>
            )}
          </div>
        </div>
      )}

      {/* Plan */}
      {job.plan?.summary && (
        <div style={css.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={css.sectionTitle}>📋 Plan</div>
            {job.plan.generated_at && (
              <span style={{ fontSize: 12, color: "var(--fg3)" }}>
                Generated {relativeTime(job.plan.generated_at)}
              </span>
            )}
          </div>
          <div
            className="plan-markdown"
            style={{
              background: "var(--bg)",
              padding: 16,
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--fg)",
              overflow: "auto",
              maxHeight: 600,
            }}
          >
            <Markdown>{job.plan.summary}</Markdown>
          </div>
          {job.status === "PENDING_CONFIRMATION" && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 14px",
                background: "#3b82f611",
                border: "1px solid #3b82f633",
                borderRadius: "var(--radius)",
                fontSize: 13,
                color: "var(--fg2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Review the plan above, then confirm to start execution.</span>
              <button
                style={{ ...css.btnPrimary, padding: "6px 14px", fontSize: 13 }}
                onClick={() => handleAction("confirm_plan")}
              >
                ✅ Confirm & Execute
              </button>
            </div>
          )}
        </div>
      )}

      {/* Execution */}
      <div style={css.card}>
        <div style={css.sectionTitle}>Execution</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 12,
            fontSize: 13,
          }}
        >
          <div>
            <span style={{ color: "var(--fg2)" }}>Claimed by:</span>{" "}
            {job.claimed_by && ["RUNNING", "FIXING_CI"].includes(job.status) ? (
              <Link
                to={`/workers/${encodeURIComponent(job.claimed_by)}`}
                style={{ ...css.mono, ...css.link, textDecoration: "none", fontSize: 13 }}
                title="View worker logs"
              >
                {job.claimed_by} →
              </Link>
            ) : (
              <span style={css.mono}>{job.claimed_by || "\u2014"}</span>
            )}
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Attempt:</span> {job.attempt || 0}
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Worktree:</span>{" "}
            <span style={css.mono}>{job.worktree_slot || "\u2014"}</span>
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Branch:</span>{" "}
            <span style={css.mono}>{job.branch_name || "\u2014"}</span>
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Repos:</span>{" "}
            {job.repos_resolved?.join(", ") || "\u2014"}
          </div>
          {job.lease_expires_at && (
            <div>
              <span style={{ color: "var(--fg2)" }}>Lease expires:</span>{" "}
              {relativeTime(job.lease_expires_at)}
            </div>
          )}
          {job.heartbeat_at && (
            <div>
              <span style={{ color: "var(--fg2)" }}>Last heartbeat:</span>{" "}
              {relativeTime(job.heartbeat_at)}
            </div>
          )}
          {job.run_started_at && (
            <div>
              <span style={{ color: "var(--fg2)" }}>Started:</span>{" "}
              {new Date(job.run_started_at).toLocaleString()}
            </div>
          )}
          {job.run_ended_at && (
            <div>
              <span style={{ color: "var(--fg2)" }}>Ended:</span>{" "}
              {new Date(job.run_ended_at).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Outputs */}
      <div style={css.card}>
        <div style={css.sectionTitle}>Outputs</div>
        {job.pr_urls?.length ? (
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: "var(--fg2)", fontSize: 13 }}>PRs: </span>
            {job.pr_urls.map((url, i) => (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener"
                style={{ marginRight: 12, ...css.mono, fontSize: 13 }}
              >
                {formatPrUrl(url)}
              </a>
            ))}
          </div>
        ) : null}
        {job.ci?.runs?.length ? (
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: "var(--fg2)", fontSize: 13 }}>CI ({job.ci.provider}): </span>
            {job.ci.runs.map((run, i) => (
              <span key={i} style={{ marginRight: 12, fontSize: 13 }}>
                <a href={run.url} target="_blank" rel="noopener">
                  {run.status}
                </a>
                {run.conclusion ? ` (${run.conclusion})` : ""}
              </span>
            ))}
          </div>
        ) : null}
        {job.result_summary && (
          <div>
            <span style={{ color: "var(--fg2)", fontSize: 13 }}>Summary:</span>
            <div style={css.pre}>{job.result_summary}</div>
          </div>
        )}
        {job.error && (
          <div style={{ marginTop: 8 }}>
            <span style={{ color: "var(--red)", fontSize: 13 }}>
              Error{job.error.code ? ` (${job.error.code})` : ""}:
            </span>
            <div style={{ ...css.pre, borderColor: "#ef444444" }}>
              {job.error.message}
              {job.error.details
                ? `\n\n${typeof job.error.details === "string" ? job.error.details : JSON.stringify(job.error.details, null, 2)}`
                : ""}
            </div>
          </div>
        )}
      </div>

      {/* Live worker logs for in-progress jobs */}
      {job.claimed_by && ["RUNNING", "FIXING_CI"].includes(job.status) && (
        <div style={css.card}>
          <div style={{ ...css.sectionTitle, display: "flex", alignItems: "center", gap: 8 }}>
            Worker Logs
            <Link
              to={`/workers/${encodeURIComponent(job.claimed_by)}`}
              style={{ ...css.link, fontSize: 12, fontWeight: 400, textDecoration: "none" }}
            >
              {job.claimed_by} →
            </Link>
          </div>
          <LogTerminal workerId={job.claimed_by} height={400} />
        </div>
      )}

      <PerformanceCard job={job} />
      <EventsTimeline job={job} />
    </div>
  );
}
