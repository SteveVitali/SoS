import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  cancelJob,
  createJob,
  deleteJob,
  getJob,
  getUsers,
  type Job,
  listJobs,
  resolveSlackUsers,
  retryJob,
  type SlackUser,
} from "./api.js";

// --- Utilities ---
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// --- Slack User Name Cache ---
const slackNameCache = new Map<string, SlackUser>();
const pendingIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function isSlackId(s: string): boolean {
  return /^U[A-Z0-9]{6,}$/.test(s);
}

function formatUser(userId: string): string {
  if (!isSlackId(userId)) return userId;
  const cached = slackNameCache.get(userId);
  if (cached && cached.displayName !== userId) {
    return `${cached.displayName} (${userId})`;
  }
  return userId;
}

function formatUserShort(userId: string): string {
  if (!isSlackId(userId)) return userId;
  const cached = slackNameCache.get(userId);
  if (cached && cached.displayName !== userId) {
    return cached.displayName;
  }
  return userId;
}

function requestSlackResolve(ids: string[]) {
  for (const id of ids) {
    if (isSlackId(id) && !slackNameCache.has(id)) {
      pendingIds.add(id);
    }
  }
  if (pendingIds.size > 0 && !flushTimer) {
    flushTimer = setTimeout(async () => {
      const batch = [...pendingIds];
      pendingIds.clear();
      flushTimer = null;
      try {
        const resolved = await resolveSlackUsers(batch);
        for (const [id, user] of Object.entries(resolved)) {
          slackNameCache.set(id, user);
        }
        subscribers.forEach((cb) => cb());
      } catch (err) {
        console.error("Slack user resolution failed:", err);
      }
    }, 50);
  }
}

function useSlackNames(ids: string[]) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  useEffect(() => {
    requestSlackResolve(ids);
  }, [ids]);
}

const STATUS_COLORS: Record<string, string> = {
  QUEUED: "#3b82f6",
  RUNNING: "#eab308",
  FIXING_CI: "#f97316",
  WAITING_FOR_APPROVAL: "#a855f7",
  DONE: "#22c55e",
  FAILED: "#ef4444",
  CANCELED: "#6b7280",
  DELETED: "#4b5563",
};

// --- Styles ---
const css = {
  container: { maxWidth: 1200, margin: "0 auto", padding: "20px 24px" } as React.CSSProperties,
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
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 14 },
  th: {
    textAlign: "left" as const,
    padding: "10px 12px",
    borderBottom: "1px solid var(--border)",
    color: "var(--fg2)",
    fontWeight: 600,
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  td: {
    padding: "10px 12px",
    borderBottom: "1px solid var(--border)",
    verticalAlign: "top" as const,
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
  label: { display: "block", marginBottom: 4, fontSize: 13, color: "var(--fg2)", fontWeight: 500 },
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

// --- Token Setup ---
function TokenSetup({ onSet }: { onSet: () => void }) {
  const [token, setToken] = useState("");
  return (
    <div style={css.tokenSetup}>
      <h2 style={{ marginBottom: 16 }}>Son of Steve</h2>
      <p style={{ color: "var(--fg2)", marginBottom: 16, fontSize: 14 }}>
        Enter your API token (SOS_INTERNAL_API_TOKEN) to access the dashboard.
      </p>
      <div style={css.field}>
        <input
          style={css.input}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="API token"
          onKeyDown={(e) => {
            if (e.key === "Enter" && token) {
              localStorage.setItem("sos_token", token);
              onSet();
            }
          }}
        />
      </div>
      <button
        style={css.btnPrimary}
        onClick={() => {
          localStorage.setItem("sos_token", token);
          onSet();
        }}
      >
        Connect
      </button>
    </div>
  );
}

// --- Status Badge ---
function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || "#6b7280";
  return <span style={css.badge(color)}>{status}</span>;
}

// --- Jobs List ---
function JobsList({
  onSelect,
  onCreateClick,
}: {
  onSelect: (id: string) => void;
  onCreateClick: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [requestedBy, setRequestedBy] = useState("");
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [jobsRes, usersRes] = await Promise.all([
        listJobs({
          status: status || undefined,
          requested_by: requestedBy || undefined,
          q: search || undefined,
          limit,
          offset,
        }),
        getUsers(),
      ]);
      setJobs(jobsRes.jobs);
      setTotal(jobsRes.total);
      setUsers(usersRes.users);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status, requestedBy, search, offset]);

  useEffect(() => {
    load();
  }, [load]);

  // Resolve Slack display names for all visible user IDs
  const allUserIds = [...new Set([...users, ...jobs.map((j) => j.requested_by)])];
  useSlackNames(allUserIds);

  const handleAction = async (action: "cancel" | "retry" | "delete", taskId: string) => {
    try {
      if (action === "cancel") await cancelJob(taskId);
      else if (action === "retry") await retryJob(taskId);
      else if (action === "delete") await deleteJob(taskId);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>Jobs ({total})</h2>
        <div style={css.row}>
          <button style={css.btn} onClick={load}>
            ↻ Refresh
          </button>
          <button style={css.btnPrimary} onClick={onCreateClick}>
            + Create Job
          </button>
        </div>
      </div>
      <div style={css.filters}>
        <select
          style={css.select}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          {["QUEUED", "RUNNING", "FIXING_CI", "DONE", "FAILED", "CANCELED"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          style={css.select}
          value={requestedBy}
          onChange={(e) => {
            setRequestedBy(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u} value={u}>
              {formatUserShort(u)}
            </option>
          ))}
        </select>
        <input
          style={{ ...css.input, maxWidth: 250 }}
          placeholder="Search task text or ID..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      {error && <div style={css.error}>{error}</div>}
      {loading ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>Loading...</div>
      ) : jobs.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>No jobs found.</div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={css.table}>
              <thead>
                <tr>
                  <th style={css.th}>Task ID</th>
                  <th style={css.th}>Status</th>
                  <th style={css.th}>User</th>
                  <th style={css.th}>Created</th>
                  <th style={css.th}>Repo</th>
                  <th style={css.th}>Worktree</th>
                  <th style={css.th}>PR</th>
                  <th style={css.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.task_id}
                    style={{ cursor: "pointer" }}
                    onClick={() => onSelect(job.task_id)}
                  >
                    <td style={{ ...css.td, ...css.mono }}>
                      <span style={css.link}>{shortId(job.task_id)}</span>
                    </td>
                    <td style={css.td}>
                      <StatusBadge status={job.status} />
                    </td>
                    <td style={{ ...css.td, fontSize: 12 }} title={job.requested_by}>
                      {formatUser(job.requested_by)}
                    </td>
                    <td style={css.td} title={new Date(job.created_at).toLocaleString()}>
                      {relativeTime(job.created_at)}
                    </td>
                    <td style={{ ...css.td, fontSize: 13 }}>
                      {job.repos_resolved?.join(", ") || job.repo_hint || "—"}
                    </td>
                    <td style={{ ...css.td, ...css.mono, fontSize: 12 }}>
                      {job.worktree_slot || "—"}
                    </td>
                    <td style={css.td}>
                      {job.pr_urls?.map((url, i) => (
                        <a
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noopener"
                          onClick={(e) => e.stopPropagation()}
                        >
                          PR {i + 1}
                        </a>
                      )) || "—"}
                    </td>
                    <td style={css.td} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 4 }}>
                        {["QUEUED", "RUNNING", "FIXING_CI"].includes(job.status) && (
                          <button
                            style={css.btnSmall}
                            onClick={() => handleAction("cancel", job.task_id)}
                          >
                            Cancel
                          </button>
                        )}
                        {["FAILED", "CANCELED"].includes(job.status) && (
                          <button
                            style={css.btnSmall}
                            onClick={() => handleAction("retry", job.task_id)}
                          >
                            Retry
                          </button>
                        )}
                        {!["RUNNING", "FIXING_CI"].includes(job.status) && (
                          <button
                            style={{ ...css.btnSmall, color: "var(--red)" }}
                            onClick={() => handleAction("delete", job.task_id)}
                          >
                            Del
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
            }}
          >
            <span style={{ color: "var(--fg2)", fontSize: 13 }}>
              Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={css.btnSmall}
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                ← Prev
              </button>
              <button
                style={css.btnSmall}
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Job Detail ---
function JobDetail({
  taskId,
  onBack,
  onNavigate,
}: {
  taskId: string;
  onBack: () => void;
  onNavigate: (id: string) => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");

  useSlackNames(job ? [job.requested_by] : []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getJob(taskId);
      setJob(res.job);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAction = async (action: "cancel" | "retry" | "delete") => {
    setActionError("");
    try {
      if (action === "cancel") {
        await cancelJob(taskId);
        load();
      } else if (action === "retry") {
        const res = await retryJob(taskId);
        onNavigate(res.job.task_id);
      } else if (action === "delete") {
        await deleteJob(taskId);
        onBack();
      }
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  if (loading) return <div style={{ color: "var(--fg2)", padding: 20 }}>Loading...</div>;
  if (error) return <div style={css.error}>{error}</div>;
  if (!job) return <div style={css.error}>Job not found</div>;

  return (
    <div>
      <button style={{ ...css.btn, marginBottom: 16 }} onClick={onBack}>
        ← Back to Jobs
      </button>
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
            <h2 style={{ ...css.mono, fontSize: 18, marginBottom: 8 }}>{job.task_id}</h2>
            <div style={css.row}>
              <StatusBadge status={job.status} />
              <span style={{ color: "var(--fg2)", fontSize: 13 }} title={job.requested_by}>
                by {formatUser(job.requested_by)} · {relativeTime(job.created_at)}
              </span>
              {job.parent_task_id && (
                <span style={{ fontSize: 13 }}>
                  Retry of{" "}
                  <span
                    style={{ ...css.link, ...css.mono }}
                    onClick={() => onNavigate(job.parent_task_id!)}
                  >
                    {shortId(job.parent_task_id)}
                  </span>
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={css.btn} onClick={load}>
              ↻
            </button>
            {["QUEUED", "RUNNING", "FIXING_CI"].includes(job.status) && (
              <button style={css.btnDanger} onClick={() => handleAction("cancel")}>
                Cancel
              </button>
            )}
            {["FAILED", "CANCELED"].includes(job.status) && (
              <button style={css.btnPrimary} onClick={() => handleAction("retry")}>
                Retry
              </button>
            )}
            {!["RUNNING", "FIXING_CI"].includes(job.status) && (
              <button style={css.btnDanger} onClick={() => handleAction("delete")}>
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
            <span style={css.mono}>{job.claimed_by || "—"}</span>
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Attempt:</span> {job.attempt || 0}
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Worktree:</span>{" "}
            <span style={css.mono}>{job.worktree_slot || "—"}</span>
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Branch:</span>{" "}
            <span style={css.mono}>{job.branch_name || "—"}</span>
          </div>
          <div>
            <span style={{ color: "var(--fg2)" }}>Repos:</span>{" "}
            {job.repos_resolved?.join(", ") || "—"}
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
              <a key={i} href={url} target="_blank" rel="noopener" style={{ marginRight: 12 }}>
                {url}
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

      {/* Events Timeline */}
      {job.events && job.events.length > 0 && (
        <div style={css.card}>
          <div style={css.sectionTitle}>Events ({job.events.length})</div>
          <div style={css.timeline}>
            {[...job.events].reverse().map((ev, i) => {
              const color =
                ev.type.includes("FAIL") || ev.type === "CANCELED"
                  ? "var(--red)"
                  : ev.type === "DONE" || ev.type.includes("GREEN")
                    ? "var(--green)"
                    : "var(--accent)";
              return (
                <div key={i} style={css.timelineItem}>
                  <div style={css.dot(color)} />
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ ...css.badge(color), fontSize: 11 }}>{ev.type}</span>
                    <span style={{ color: "var(--fg3)", fontSize: 12 }}>{relativeTime(ev.at)}</span>
                    {ev.node_id && (
                      <span style={{ ...css.mono, color: "var(--fg3)", fontSize: 11 }}>
                        {ev.node_id}
                      </span>
                    )}
                  </div>
                  {ev.payload && (
                    <div style={{ ...css.pre, marginTop: 4, fontSize: 11, maxHeight: 120 }}>
                      {typeof ev.payload === "string"
                        ? ev.payload
                        : JSON.stringify(ev.payload, null, 2)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Create Job Form ---
function CreateJobForm({
  onCreated,
  onCancel,
}: {
  onCreated: (taskId: string) => void;
  onCancel: () => void;
}) {
  const [requestedBy, setRequestedBy] = useState(localStorage.getItem("sos_last_user") || "");
  const [taskText, setTaskText] = useState("");
  const [repoHint, setRepoHint] = useState("");
  const [testLevel, setTestLevel] = useState("fast");
  const [ciFixEnabled, setCiFixEnabled] = useState(true);
  const [reviewers, setReviewers] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requestedBy || !taskText) {
      setError("requested_by and task_text are required");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      localStorage.setItem("sos_last_user", requestedBy);
      const res = await createJob({
        requested_by: requestedBy,
        task_text: taskText,
        repo_hint: repoHint || undefined,
        test_level: testLevel as any,
        ci_fix_enabled: ciFixEnabled,
        reviewers: reviewers
          ? reviewers
              .split(",")
              .map((r) => r.trim())
              .filter(Boolean)
          : undefined,
      });
      onCreated(res.job.task_id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <button style={{ ...css.btn, marginBottom: 16 }} onClick={onCancel}>
        ← Back
      </button>
      <div style={css.card}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Create Job</h2>
        <form onSubmit={handleSubmit}>
          <div style={css.field}>
            <label style={css.label}>Requested By (Slack User ID) *</label>
            <input
              style={css.input}
              value={requestedBy}
              onChange={(e) => setRequestedBy(e.target.value)}
              placeholder="U..."
            />
          </div>
          <div style={css.field}>
            <label style={css.label}>Task Text *</label>
            <textarea
              style={css.textarea}
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              placeholder="Describe the coding task..."
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={css.field}>
              <label style={css.label}>Repo Hint (optional)</label>
              <input
                style={css.input}
                value={repoHint}
                onChange={(e) => setRepoHint(e.target.value)}
                placeholder="e.g. my-app"
              />
            </div>
            <div style={css.field}>
              <label style={css.label}>Test Level</label>
              <select
                style={{ ...css.select, width: "100%" }}
                value={testLevel}
                onChange={(e) => setTestLevel(e.target.value)}
              >
                <option value="fast">fast</option>
                <option value="full">full</option>
                <option value="none">none</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={css.field}>
              <label style={css.label}>CI Fix</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={ciFixEnabled}
                  onChange={(e) => setCiFixEnabled(e.target.checked)}
                />
                <span style={{ fontSize: 14, color: "var(--fg2)" }}>Enable CI fix attempts</span>
              </label>
            </div>
            <div style={css.field}>
              <label style={css.label}>Reviewers (comma-separated)</label>
              <input
                style={css.input}
                value={reviewers}
                onChange={(e) => setReviewers(e.target.value)}
                placeholder="alice, bob"
              />
            </div>
          </div>
          {error && <div style={css.error}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="submit" style={css.btnPrimary} disabled={submitting}>
              {submitting ? "Creating..." : "Create Job"}
            </button>
            <button type="button" style={css.btn} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- App Shell ---
type View = { type: "list" } | { type: "detail"; taskId: string } | { type: "create" };

export function App() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("sos_token"));
  const [view, setView] = useState<View>({ type: "list" });

  if (!authed) {
    return <TokenSetup onSet={() => setAuthed(true)} />;
  }

  return (
    <div style={css.container}>
      <div style={css.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={css.title} onClick={() => setView({ type: "list" })}>
            🤖 Son of Steve
          </span>
        </div>
        <div style={css.nav}>
          <button
            style={css.btn}
            onClick={() => {
              localStorage.removeItem("sos_token");
              setAuthed(false);
            }}
          >
            Logout
          </button>
        </div>
      </div>

      {view.type === "list" && (
        <JobsList
          onSelect={(id) => setView({ type: "detail", taskId: id })}
          onCreateClick={() => setView({ type: "create" })}
        />
      )}
      {view.type === "detail" && (
        <JobDetail
          taskId={view.taskId}
          onBack={() => setView({ type: "list" })}
          onNavigate={(id) => setView({ type: "detail", taskId: id })}
        />
      )}
      {view.type === "create" && (
        <CreateJobForm
          onCreated={(id) => setView({ type: "detail", taskId: id })}
          onCancel={() => setView({ type: "list" })}
        />
      )}
    </div>
  );
}
