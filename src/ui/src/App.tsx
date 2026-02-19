import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  cancelJob,
  createJob,
  createRespondToCommentsJob,
  deleteJob,
  fetchPrStats,
  type GitHubPr,
  getJob,
  getRegistry,
  getUsers,
  type Job,
  listJobs,
  listPrs,
  type PrCommentStats,
  promotePr,
  type RegistryData,
  type RepoConfig,
  resolveSlackUsers,
  respondToComments,
  retryJob,
  type SlackUser,
  saveRegistry,
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

const TERMINAL_EVENT_TYPES = new Set(["DONE", "FAILED", "CANCELED", "QUEUED", "REAPED"]);

function lastSubstantiveEvent(
  events?: Array<{ at: string; type: string }>,
): { at: string; type: string } | undefined {
  if (!events?.length) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (!TERMINAL_EVENT_TYPES.has(events[i].type)) return events[i];
  }
  return events[events.length - 1];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatPrUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return `${m[1]}/${m[2]}#${m[3]}`;
  return url;
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

// --- Sorting ---
type SortKey =
  | "task_id"
  | "status"
  | "requested_by"
  | "created_at"
  | "updated"
  | "repo"
  | "worktree_slot"
  | "pr";
type SortDir = "asc" | "desc";

function getJobSortValue(job: Job, key: SortKey): string {
  switch (key) {
    case "task_id":
      return job.task_id;
    case "status":
      return job.status;
    case "requested_by": {
      const cached = slackNameCache.get(job.requested_by);
      return (cached?.displayName || job.requested_by).toLowerCase();
    }
    case "created_at":
      return job.created_at;
    case "updated": {
      const ev = lastSubstantiveEvent(job.events);
      return ev ? ev.at : job.updated_at || job.created_at;
    }
    case "repo":
      return (job.repos_resolved?.join(", ") || job.repo_hint || "").toLowerCase();
    case "worktree_slot":
      return (job.worktree_slot || "").toLowerCase();
    case "pr":
      return (job.pr_urls?.join(", ") || "").toLowerCase();
    default:
      return "";
  }
}

function sortJobs(jobs: Job[], key: SortKey, dir: SortDir): Job[] {
  const sorted = [...jobs].sort((a, b) => {
    const va = getJobSortValue(a, key);
    const vb = getJobSortValue(b, key);
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  });
  return dir === "desc" ? sorted.reverse() : sorted;
}

// --- Jobs List ---
function JobsList() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [requestedBy, setRequestedBy] = useState("");
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const limit = 25;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedJobs = sortKey ? sortJobs(jobs, sortKey, sortDir) : jobs;

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

  // Auto-poll every 15s and fire browser notifications for WAITING_FOR_APPROVAL
  const [prevStatuses] = useState(() => new Map<string, string>());
  useEffect(() => {
    // Request notification permission on first render
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);
  useEffect(() => {
    for (const job of jobs) {
      const prev = prevStatuses.get(job.task_id);
      if (prev && prev !== "WAITING_FOR_APPROVAL" && job.status === "WAITING_FOR_APPROVAL") {
        if ("Notification" in window && Notification.permission === "granted") {
          const n = new Notification("Son of Steve — PR Ready for Review", {
            body: `${job.title || job.task_text.slice(0, 60)}\nClick to review and promote.`,
            tag: `sos-approval-${job.task_id}`,
          });
          n.onclick = () => {
            window.focus();
            navigate(`/jobs/${job.task_id}`);
          };
        }
      }
      prevStatuses.set(job.task_id, job.status);
    }
  }, [jobs, prevStatuses, navigate]);
  useEffect(() => {
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // Fetch PR comment stats for jobs with PR URLs
  const [prStats, setPrStats] = useState<Record<string, PrCommentStats>>({});
  useEffect(() => {
    const urls = [...new Set(jobs.flatMap((j) => j.pr_urls || []))];
    if (urls.length === 0) return;
    fetchPrStats(urls)
      .then(setPrStats)
      .catch(() => {});
  }, [jobs]);

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
          <button style={css.btnPrimary} onClick={() => navigate("/jobs/new")}>
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
          {/* Sort pills */}
          <div
            style={{
              display: "flex",
              gap: 6,
              marginBottom: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--fg3)", marginRight: 4 }}>Sort by:</span>
            {(
              [
                ["updated", "Updated"],
                ["created_at", "Created"],
                ["status", "Status"],
                ["requested_by", "User"],
                ["repo", "Repo"],
                ["task_id", "Task"],
                ["pr", "PR"],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                style={{
                  ...css.btnSmall,
                  background: sortKey === key ? "var(--accent)" : "var(--bg3)",
                  color: sortKey === key ? "#fff" : "var(--fg2)",
                  border: sortKey === key ? "1px solid var(--accent)" : "1px solid var(--border)",
                }}
                onClick={() => handleSort(key)}
              >
                {label} {sortKey === key ? (sortDir === "asc" ? "\u25B2" : "\u25BC") : ""}
              </button>
            ))}
          </div>

          {/* Job rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sortedJobs.map((job) => {
              const ev = lastSubstantiveEvent(job.events);
              return (
                <div
                  key={job.task_id}
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer",
                    borderRadius: 6,
                    transition: "background 0.1s",
                  }}
                  onClick={() => navigate(`/jobs/${job.task_id}`)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = "var(--bg2)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = "transparent";
                  }}
                >
                  {/* Line 1: status + title + stats + actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <StatusBadge status={job.status} />
                    {job.job_type === "respond_to_pr_comments" && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "var(--bg2)",
                          color: "var(--fg2)",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        PR Comments
                      </span>
                    )}
                    <span style={{ ...css.link, fontWeight: 500, flex: 1, minWidth: 0 }}>
                      {job.title || job.task_text.slice(0, 120)}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, color: "var(--fg2)", whiteSpace: "nowrap" }}>
                        {job.metrics?.durations?.total_ms
                          ? formatDuration(job.metrics.durations.total_ms)
                          : ""}
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
                            title={
                              job.metrics.claude.cost_source === "computed"
                                ? "Estimated"
                                : "Provider"
                            }
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
                        {["QUEUED", "RUNNING", "FIXING_CI", "WAITING_FOR_APPROVAL"].includes(
                          job.status,
                        ) && (
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
                    <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                    <span title={formatUser(job.requested_by)}>
                      {formatUserShort(job.requested_by)}
                    </span>
                    <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                    <span>{job.repos_resolved?.join(", ") || job.repo_hint || "\u2014"}</span>
                    {job.worktree_slot && (
                      <>
                        <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                        <span style={css.mono}>{job.worktree_slot}</span>
                      </>
                    )}
                    <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                    <span title={new Date(job.created_at).toLocaleString()}>
                      {relativeTime(job.created_at)}
                    </span>
                    {ev && (
                      <>
                        <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                        <span title={`${ev.type} at ${new Date(ev.at).toLocaleString()}`}>
                          <span style={{ fontWeight: 600, color: "var(--fg2)" }}>{ev.type}</span>{" "}
                          {relativeTime(ev.at)}
                        </span>
                      </>
                    )}
                    {job.pr_urls?.length ? (
                      <>
                        <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
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
                </div>
              );
            })}
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
function JobDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
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
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAction = async (
    action: "cancel" | "retry" | "delete" | "promote" | "respond_comments",
  ) => {
    if (!taskId) return;
    setActionError("");
    try {
      if (action === "cancel") {
        await cancelJob(taskId);
        load();
      } else if (action === "retry") {
        const res = await retryJob(taskId);
        navigate(`/jobs/${res.job.task_id}`);
      } else if (action === "delete") {
        await deleteJob(taskId);
        navigate("/");
      } else if (action === "promote") {
        await promotePr(taskId);
        load();
      } else if (action === "respond_comments") {
        const res = await respondToComments(taskId);
        navigate(`/jobs/${res.job.task_id}`);
      }
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  if (!taskId) return <div style={css.error}>No task ID provided</div>;
  if (loading) return <div style={{ color: "var(--fg2)", padding: 20 }}>Loading...</div>;
  if (error) return <div style={css.error}>{error}</div>;
  if (!job) return <div style={css.error}>Job not found</div>;

  return (
    <div>
      <Link to="/" style={{ textDecoration: "none" }}>
        <button style={{ ...css.btn, marginBottom: 16 }}>← Back to Jobs</button>
      </Link>
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
                by {formatUser(job.requested_by)} · {relativeTime(job.created_at)}
              </span>
              {job.job_type === "respond_to_pr_comments" && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: "var(--bg2)",
                    color: "var(--fg2)",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  PR Comments
                </span>
              )}
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
            <button style={css.btn} onClick={load}>
              ↻
            </button>
            {["QUEUED", "RUNNING", "FIXING_CI", "WAITING_FOR_APPROVAL"].includes(job.status) && (
              <button style={css.btnDanger} onClick={() => handleAction("cancel")}>
                Cancel
              </button>
            )}
            {job.status === "WAITING_FOR_APPROVAL" && (
              <button style={css.btnPrimary} onClick={() => handleAction("promote")}>
                Promote PR
              </button>
            )}
            {["FAILED", "CANCELED"].includes(job.status) && (
              <button style={css.btnPrimary} onClick={() => handleAction("retry")}>
                Retry
              </button>
            )}
            {job.pr_urls?.length && ["DONE", "WAITING_FOR_APPROVAL"].includes(job.status) && (
              <button style={css.btnPrimary} onClick={() => handleAction("respond_comments")}>
                Respond to Comments
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

      {/* Performance */}
      {job.metrics && (
        <div style={css.card}>
          <div style={css.sectionTitle}>Performance</div>
          {job.metrics.durations?.total_ms != null && (
            <div style={{ marginBottom: 12, fontSize: 14 }}>
              <b>Total duration:</b> {formatDuration(job.metrics.durations.total_ms)}
            </div>
          )}
          {job.metrics.durations &&
            (() => {
              const d = job.metrics?.durations as Record<string, number>;
              const total = d.total_ms || 1;
              const phases: Array<{ label: string; ms: number; color: string }> = [
                { label: "Claude Code", ms: d.claude_code_ms || 0, color: "#8b5cf6" },
                { label: "Self-review", ms: d.self_review_ms || 0, color: "#6366f1" },
                { label: "Local checks", ms: d.local_checks_ms || 0, color: "#06b6d4" },
                { label: "CI wait", ms: d.ci_wait_ms || 0, color: "#f59e0b" },
                { label: "CI fix", ms: d.ci_fix_ms || 0, color: "#ef4444" },
                { label: "Git ops", ms: d.commit_push_ms || 0, color: "#10b981" },
                { label: "Workspace", ms: d.prepare_workspace_ms || 0, color: "#64748b" },
              ].filter((p) => p.ms > 0);
              return (
                <div style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      height: 20,
                      borderRadius: 6,
                      overflow: "hidden",
                      marginBottom: 8,
                    }}
                  >
                    {phases.map((p, i) => (
                      <div
                        key={i}
                        title={`${p.label}: ${formatDuration(p.ms)}`}
                        style={{
                          width: `${(p.ms / total) * 100}%`,
                          background: p.color,
                          minWidth: p.ms > 0 ? 2 : 0,
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", fontSize: 12 }}>
                    {phases.map((p, i) => (
                      <span key={i}>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: p.color,
                            marginRight: 4,
                          }}
                        />
                        {p.label}: {formatDuration(p.ms)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
          {job.metrics.claude?.sessions && job.metrics.claude.sessions.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "var(--fg2)" }}>
                Claude Usage
              </div>
              <table style={{ ...css.table, fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={css.th}>Phase</th>
                    <th style={css.th}>Model</th>
                    <th style={{ ...css.th, textAlign: "right" }}>Input</th>
                    <th style={{ ...css.th, textAlign: "right" }}>Output</th>
                    <th style={{ ...css.th, textAlign: "right" }}>Duration</th>
                    <th style={{ ...css.th, textAlign: "right" }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {job.metrics.claude.sessions.map((s, i) => (
                    <tr key={i}>
                      <td style={css.td}>{s.phase}</td>
                      <td style={{ ...css.td, ...css.mono }}>
                        {s.model?.replace("claude-", "") || "—"}
                      </td>
                      <td style={{ ...css.td, textAlign: "right" }}>
                        {s.input_tokens ? `${(s.input_tokens / 1000).toFixed(1)}K` : "—"}
                      </td>
                      <td style={{ ...css.td, textAlign: "right" }}>
                        {s.output_tokens ? `${(s.output_tokens / 1000).toFixed(1)}K` : "—"}
                      </td>
                      <td style={{ ...css.td, textAlign: "right" }}>
                        {s.duration_ms ? formatDuration(s.duration_ms) : "—"}
                      </td>
                      <td style={{ ...css.td, textAlign: "right" }}>
                        {s.cost_usd != null ? (
                          <span
                            title={
                              s.cost_source === "computed"
                                ? "Estimated from token counts"
                                : "Direct from provider"
                            }
                          >
                            {s.cost_source === "computed" ? "~" : ""}${s.cost_usd.toFixed(4)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                  {job.metrics.claude.sessions.length > 1 && (
                    <tr style={{ fontWeight: 600 }}>
                      <td style={css.td}>Total</td>
                      <td style={css.td} />
                      <td style={{ ...css.td, textAlign: "right" }}>
                        {job.metrics.claude.total_input_tokens
                          ? `${(job.metrics.claude.total_input_tokens / 1000).toFixed(1)}K`
                          : ""}
                      </td>
                      <td style={{ ...css.td, textAlign: "right" }}>
                        {job.metrics.claude.total_output_tokens
                          ? `${(job.metrics.claude.total_output_tokens / 1000).toFixed(1)}K`
                          : ""}
                      </td>
                      <td style={css.td} />
                      <td style={{ ...css.td, textAlign: "right" }}>
                        {job.metrics.claude.total_cost_usd != null ? (
                          <span
                            title={
                              job.metrics.claude.cost_source === "computed"
                                ? "Estimated from token counts"
                                : "Direct from provider"
                            }
                          >
                            {job.metrics.claude.cost_source === "computed" ? "~" : ""}$
                            {job.metrics.claude.total_cost_usd.toFixed(4)}
                          </span>
                        ) : (
                          ""
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Events Timeline */}
      {job.events && job.events.length > 0 && (
        <div style={css.card}>
          <div style={css.sectionTitle}>Events ({job.events.length})</div>
          <div style={css.timeline}>
            {[...job.events].reverse().map((ev, i) => {
              const color =
                ev.type.includes("FAIL") || ev.type === "CANCELED"
                  ? "var(--red)"
                  : ev.type === "DONE" ||
                      ev.type.includes("GREEN") ||
                      ev.type === "COMMENTS_PUSHED" ||
                      ev.type === "COMMENT_ADDRESSED"
                    ? "var(--green)"
                    : "var(--accent)";
              const eventLabel: Record<string, string> = {
                COMMENTS_FETCHED: "Comments Fetched",
                COMMENT_ADDRESSED: "Comment Addressed",
                COMMENTS_PUSHED: "Comments Pushed",
              };
              return (
                <div key={i} style={css.timelineItem}>
                  <div style={css.dot(color)} />
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ ...css.badge(color), fontSize: 11 }}>
                      {eventLabel[ev.type] || ev.type}
                    </span>
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

// --- PRs List ---
function PrsList() {
  const navigate = useNavigate();
  const [prs, setPrs] = useState<GitHubPr[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [state, setState] = useState<"open" | "closed" | "merged" | "all">("open");
  const [limit, setLimit] = useState(20);
  const [responding, setResponding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await listPrs({ state, limit });
      setPrs(res.prs);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [state, limit]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const handleRespondToComments = async (pr: GitHubPr) => {
    setResponding(pr.url);
    try {
      const requestedBy = localStorage.getItem("sos_last_user") || "";
      if (!requestedBy) {
        setError("Set your user ID first (create a job to save it)");
        return;
      }
      const res = await createRespondToCommentsJob({
        requested_by: requestedBy,
        pr_url: pr.url,
      });
      navigate(`/jobs/${res.job.task_id}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setResponding(null);
    }
  };

  const fetchMore = () => {
    setLimit((l) => l + 20);
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
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>Pull Requests ({prs.length})</h2>
        <button style={css.btn} onClick={load}>
          ↻ Refresh
        </button>
      </div>
      <div style={css.filters}>
        <select
          style={css.select}
          value={state}
          onChange={(e) => {
            setState(e.target.value as any);
            setLimit(20);
          }}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="merged">Merged</option>
          <option value="all">All</option>
        </select>
      </div>
      {error && <div style={css.error}>{error}</div>}
      {loading && prs.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>Loading PRs...</div>
      ) : prs.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>No pull requests found.</div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {prs.map((pr) => {
              const hasUnaddressed = pr.comments && pr.comments.unaddressed_threads > 0;
              const hasUnresolved = pr.comments && pr.comments.unresolved_threads > 0;
              return (
                <div
                  key={pr.url}
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--border)",
                    borderRadius: 6,
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = "var(--bg2)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = "transparent";
                  }}
                >
                  {/* Line 1: state badge + title + actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                      style={css.badge(
                        pr.state === "OPEN"
                          ? pr.isDraft
                            ? "#6b7280"
                            : "#22c55e"
                          : pr.state === "MERGED"
                            ? "#a855f7"
                            : "#ef4444",
                      )}
                    >
                      {pr.isDraft ? "DRAFT" : pr.state}
                    </span>
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
                              style={{
                                ...css.badge("#6b7280"),
                                fontSize: 11,
                              }}
                              title={`${pr.comments.total_threads} review threads, ${pr.comments.total_comments} comments total`}
                            >
                              {pr.comments.total_threads} threads
                            </span>
                          )}
                          {hasUnresolved && (
                            <span
                              style={{
                                ...css.badge("#f59e0b"),
                                fontSize: 11,
                              }}
                              title={`${pr.comments.unresolved_threads} unresolved review threads`}
                            >
                              {pr.comments.unresolved_threads} unresolved
                            </span>
                          )}
                          {hasUnaddressed && (
                            <span
                              style={{
                                ...css.badge("#ef4444"),
                                fontSize: 11,
                              }}
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
                          style={css.btnSmall}
                          disabled={responding === pr.url}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRespondToComments(pr);
                          }}
                        >
                          {responding === pr.url ? "..." : "Respond"}
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
                    <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                    <span>{pr.author}</span>
                    <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                    <span style={css.mono}>{pr.headRefName}</span>
                    <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                    <span
                      style={{ color: "var(--fg3)" }}
                      title={new Date(pr.updatedAt).toLocaleString()}
                    >
                      {relativeTime(pr.updatedAt)}
                    </span>
                    <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
                    <span style={{ color: "#22c55e" }}>+{pr.additions}</span>
                    <span style={{ margin: "0 4px" }}>/</span>
                    <span style={{ color: "#ef4444" }}>-{pr.deletions}</span>
                    {pr.linkedJobTaskId && (
                      <>
                        <span style={{ margin: "0 8px", opacity: 0.4 }}>{"\u00B7"}</span>
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
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
            <button style={css.btn} onClick={fetchMore} disabled={loading}>
              {loading ? "Loading..." : "Fetch more"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- Create Job Form ---
function CreateJobForm() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"create" | "respond">("create");
  const [requestedBy, setRequestedBy] = useState(localStorage.getItem("sos_last_user") || "");
  const [taskText, setTaskText] = useState("");
  const [repoHint, setRepoHint] = useState("");
  const [testLevel, setTestLevel] = useState("fast");
  const [ciFixEnabled, setCiFixEnabled] = useState(true);
  const [reviewers, setReviewers] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      localStorage.setItem("sos_last_user", requestedBy);

      if (mode === "respond") {
        if (!requestedBy || !prUrl) {
          setError("requested_by and PR URL are required");
          setSubmitting(false);
          return;
        }
        const res = await createRespondToCommentsJob({
          requested_by: requestedBy,
          pr_url: prUrl,
        });
        navigate(`/jobs/${res.job.task_id}`);
      } else {
        if (!requestedBy || !taskText) {
          setError("requested_by and task_text are required");
          setSubmitting(false);
          return;
        }
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
        navigate(`/jobs/${res.job.task_id}`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: "8px 16px",
    border: "none",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    background: "none",
    color: active ? "var(--fg1)" : "var(--fg3)",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    fontSize: 14,
  });

  return (
    <div>
      <Link to="/" style={{ textDecoration: "none" }}>
        <button style={{ ...css.btn, marginBottom: 16 }}>← Back</button>
      </Link>
      <div style={css.card}>
        <div
          style={{
            display: "flex",
            gap: 0,
            borderBottom: "1px solid var(--border)",
            marginBottom: 16,
          }}
        >
          <button style={tabStyle(mode === "create")} onClick={() => setMode("create")}>
            Create Job
          </button>
          <button style={tabStyle(mode === "respond")} onClick={() => setMode("respond")}>
            Respond to PR
          </button>
        </div>
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

          {mode === "respond" ? (
            <div style={css.field}>
              <label style={css.label}>GitHub PR URL *</label>
              <input
                style={css.input}
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
                placeholder="https://github.com/org/repo/pull/123"
              />
            </div>
          ) : (
            <>
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
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={ciFixEnabled}
                      onChange={(e) => setCiFixEnabled(e.target.checked)}
                    />
                    <span style={{ fontSize: 14, color: "var(--fg2)" }}>
                      Enable CI fix attempts
                    </span>
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
            </>
          )}

          {error && <div style={css.error}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="submit" style={css.btnPrimary} disabled={submitting}>
              {submitting
                ? "Creating..."
                : mode === "respond"
                  ? "Respond to Comments"
                  : "Create Job"}
            </button>
            <button type="button" style={css.btn} onClick={() => navigate("/")}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Repo Registry Editor ---

function emptyRepo(): RepoConfig {
  return {
    clone: "",
    default_branch: "main",
    max_worktrees: 1,
    clean_mode: "light",
    detect: { keywords: [] },
    commands: {},
    pr: { reviewers_default: [], draft_by_default: true },
    ci: { provider: "" },
  };
}

function CommandEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
}) {
  const text = (value || []).join(" ");
  return (
    <div style={css.field}>
      <label style={css.label}>{label}</label>
      <input
        style={css.input}
        value={text}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v ? v.split(/\s+/) : undefined);
        }}
        placeholder="e.g. npm run lint"
      />
    </div>
  );
}

function RepoCard({
  id,
  repo,
  expanded,
  onToggle,
  onChange,
  onChangeId,
  onDelete,
}: {
  id: string;
  repo: RepoConfig;
  expanded: boolean;
  onToggle: () => void;
  onChange: (r: RepoConfig) => void;
  onChangeId: (oldId: string, newId: string) => void;
  onDelete: () => void;
}) {
  const [editingId, setEditingId] = useState(false);
  const [newId, setNewId] = useState(id);

  const update = (partial: Partial<RepoConfig>) => onChange({ ...repo, ...partial });

  const cloneDisplay = repo.clone
    ? repo.clone.replace(/^git@github\.com:/, "").replace(/\.git$/, "")
    : "not configured";

  return (
    <div
      style={{
        ...css.card,
        marginBottom: 12,
        border: expanded ? "1px solid var(--accent)" : "1px solid var(--border)",
      }}
    >
      {/* Header row */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
        onClick={onToggle}
      >
        <span style={{ fontSize: 12, color: "var(--fg3)", userSelect: "none", width: 16 }}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>{id}</span>
        <span style={{ ...css.mono, fontSize: 12, color: "var(--fg3)" }}>{cloneDisplay}</span>
        <span
          style={{
            ...css.badge(repo.max_worktrees && repo.max_worktrees > 1 ? "#3b82f6" : "#6b7280"),
            fontSize: 10,
          }}
        >
          {repo.max_worktrees || 1} worktree{(repo.max_worktrees || 1) > 1 ? "s" : ""}
        </span>
        <span style={{ ...css.badge("#6b7280"), fontSize: 10 }}>{repo.clean_mode || "light"}</span>
        {repo.ci?.provider && (
          <span style={{ ...css.badge("#8b5cf6"), fontSize: 10 }}>{repo.ci.provider}</span>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 16 }}>
          {/* Identity */}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--fg2)" }}>
            Identity
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={css.field}>
              <label style={css.label}>Repo ID</label>
              {editingId ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    style={{ ...css.input, flex: 1 }}
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newId && newId !== id) {
                        onChangeId(id, newId);
                        setEditingId(false);
                      } else if (e.key === "Escape") {
                        setNewId(id);
                        setEditingId(false);
                      }
                    }}
                  />
                  <button
                    style={css.btnSmall}
                    onClick={() => {
                      if (newId && newId !== id) onChangeId(id, newId);
                      setEditingId(false);
                    }}
                  >
                    OK
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    ...css.input,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(true);
                  }}
                >
                  <span style={css.mono}>{id}</span>
                  <span style={{ fontSize: 11, color: "var(--fg3)" }}>click to edit</span>
                </div>
              )}
            </div>
            <div style={css.field}>
              <label style={css.label}>Clone URL</label>
              <input
                style={css.input}
                value={repo.clone || ""}
                onChange={(e) => update({ clone: e.target.value })}
                placeholder="git@github.com:org/repo.git"
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div style={css.field}>
              <label style={css.label}>Default Branch</label>
              <input
                style={css.input}
                value={repo.default_branch || "main"}
                onChange={(e) => update({ default_branch: e.target.value })}
              />
            </div>
            <div style={css.field}>
              <label style={css.label}>Max Worktrees</label>
              <input
                style={css.input}
                type="number"
                min={1}
                max={10}
                value={repo.max_worktrees ?? 1}
                onChange={(e) => update({ max_worktrees: parseInt(e.target.value, 10) || 1 })}
              />
            </div>
            <div style={css.field}>
              <label style={css.label}>Clean Mode</label>
              <select
                style={{ ...css.select, width: "100%" }}
                value={repo.clean_mode || "light"}
                onChange={(e) => update({ clean_mode: e.target.value as "light" | "full" })}
              >
                <option value="light">light (preserve build caches)</option>
                <option value="full">full (clean everything)</option>
              </select>
            </div>
          </div>

          {/* Detection */}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              marginTop: 12,
              color: "var(--fg2)",
            }}
          >
            Detection
          </div>
          <div style={css.field}>
            <label style={css.label}>Keywords (comma-separated)</label>
            <input
              style={css.input}
              value={(repo.detect?.keywords || []).join(", ")}
              onChange={(e) =>
                update({
                  detect: {
                    keywords: e.target.value
                      .split(",")
                      .map((k) => k.trim())
                      .filter(Boolean),
                  },
                })
              }
              placeholder="e.g. my-app, frontend, react"
            />
          </div>

          {/* Commands */}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              marginTop: 12,
              color: "var(--fg2)",
            }}
          >
            Commands
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <CommandEditor
              label="Lint"
              value={repo.commands?.lint}
              onChange={(v) => update({ commands: { ...repo.commands, lint: v } })}
            />
            <CommandEditor
              label="Test (fast)"
              value={repo.commands?.test_fast}
              onChange={(v) => update({ commands: { ...repo.commands, test_fast: v } })}
            />
            <CommandEditor
              label="Test (full)"
              value={repo.commands?.test_full}
              onChange={(v) => update({ commands: { ...repo.commands, test_full: v } })}
            />
          </div>

          {/* PR & CI */}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              marginTop: 12,
              color: "var(--fg2)",
            }}
          >
            Pull Requests & CI
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div style={css.field}>
              <label style={css.label}>Default Reviewers (comma-separated)</label>
              <input
                style={css.input}
                value={(repo.pr?.reviewers_default || []).join(", ")}
                onChange={(e) =>
                  update({
                    pr: {
                      ...repo.pr,
                      reviewers_default: e.target.value
                        .split(",")
                        .map((r) => r.trim())
                        .filter(Boolean),
                    },
                  })
                }
                placeholder="alice, bob"
              />
            </div>
            <div style={css.field}>
              <label style={css.label}>Draft by Default</label>
              <select
                style={{ ...css.select, width: "100%" }}
                value={repo.pr?.draft_by_default !== false ? "true" : "false"}
                onChange={(e) =>
                  update({ pr: { ...repo.pr, draft_by_default: e.target.value === "true" } })
                }
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div style={css.field}>
              <label style={css.label}>CI Provider</label>
              <select
                style={{ ...css.select, width: "100%" }}
                value={repo.ci?.provider || ""}
                onChange={(e) => update({ ci: { provider: e.target.value || undefined } })}
              >
                <option value="">None</option>
                <option value="github_actions">GitHub Actions</option>
                <option value="jenkins">Jenkins</option>
              </select>
            </div>
          </div>

          {/* Delete */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button
              style={css.btnDanger}
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete repo "${id}"?`)) onDelete();
              }}
            >
              Delete Repo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RepoRegistryEditor() {
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [registryPath, setRegistryPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await getRegistry();
      setRegistry(res.registry);
      setRegistryPath(res.path);
      setDirty(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!registry) return;
    setSaving(true);
    setError("");
    setSaveMsg("");
    try {
      await saveRegistry(registry);
      setSaveMsg("Saved");
      setDirty(false);
      setTimeout(() => setSaveMsg(""), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateRepo = (id: string, repo: RepoConfig) => {
    if (!registry) return;
    setRegistry({ repos: { ...registry.repos, [id]: repo } });
    setDirty(true);
  };

  const renameRepo = (oldId: string, newId: string) => {
    if (!registry || !newId || newId === oldId) return;
    if (registry.repos[newId]) {
      setError(`Repo ID "${newId}" already exists`);
      return;
    }
    const entries = Object.entries(registry.repos);
    const newRepos: Record<string, RepoConfig> = {};
    for (const [k, v] of entries) {
      newRepos[k === oldId ? newId : k] = v;
    }
    setRegistry({ repos: newRepos });
    setDirty(true);
    if (expandedId === oldId) setExpandedId(newId);
  };

  const deleteRepo = (id: string) => {
    if (!registry) return;
    const { [id]: _, ...rest } = registry.repos;
    setRegistry({ repos: rest });
    setDirty(true);
    if (expandedId === id) setExpandedId(null);
  };

  const addRepo = () => {
    if (!registry) return;
    let newId = "new-repo";
    let i = 1;
    while (registry.repos[newId]) {
      newId = `new-repo-${i++}`;
    }
    setRegistry({ repos: { ...registry.repos, [newId]: emptyRepo() } });
    setDirty(true);
    setExpandedId(newId);
  };

  if (loading) return <div style={{ color: "var(--fg2)", padding: 20 }}>Loading registry...</div>;

  const repoIds = registry ? Object.keys(registry.repos) : [];

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
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Repo Registry ({repoIds.length})</h2>
          {registryPath && (
            <div style={{ ...css.mono, fontSize: 11, color: "var(--fg3)", marginTop: 2 }}>
              {registryPath}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {saveMsg && (
            <span style={{ fontSize: 13, color: "var(--green)", fontWeight: 500 }}>{saveMsg}</span>
          )}
          <button style={css.btn} onClick={load}>
            ↻ Reload
          </button>
          <button style={css.btnPrimary} onClick={addRepo}>
            + Add Repo
          </button>
          <button
            style={{
              ...css.btnPrimary,
              opacity: dirty ? 1 : 0.5,
              background: dirty ? "var(--accent)" : "var(--bg3)",
              color: dirty ? "#fff" : "var(--fg3)",
            }}
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      {error && <div style={{ ...css.error, marginBottom: 12 }}>{error}</div>}
      {dirty && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            borderRadius: "var(--radius)",
            background: "#f59e0b22",
            border: "1px solid #f59e0b44",
            color: "#f59e0b",
            fontSize: 13,
          }}
        >
          Unsaved changes — click Save to write to disk.
        </div>
      )}
      {repoIds.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>
          No repos configured. Click "+ Add Repo" to get started.
        </div>
      ) : (
        repoIds.map((id) => (
          <RepoCard
            key={id}
            id={id}
            repo={registry?.repos[id] as RepoConfig}
            expanded={expandedId === id}
            onToggle={() => setExpandedId(expandedId === id ? null : id)}
            onChange={(r) => updateRepo(id, r)}
            onChangeId={renameRepo}
            onDelete={() => deleteRepo(id)}
          />
        ))
      )}
    </div>
  );
}

// --- Nav Tab ---
function NavTab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      style={{
        padding: "8px 16px",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: active ? "var(--fg)" : "var(--fg3)",
        fontWeight: active ? 600 : 400,
        fontSize: 14,
        textDecoration: "none",
        transition: "color 0.1s, border-color 0.1s",
      }}
    >
      {label}
    </Link>
  );
}

// --- App Shell ---
export function App() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("sos_token"));
  const location = useLocation();

  if (!authed) {
    return <TokenSetup onSet={() => setAuthed(true)} />;
  }

  const path = location.pathname;
  const showJobsList = path === "/";
  const showPrsList = path === "/prs";
  const isJobsTab = path === "/" || path.startsWith("/jobs");
  const isPrsTab = path === "/prs";
  const isReposTab = path === "/repos";

  return (
    <div style={css.container}>
      <div style={css.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link to="/" style={{ textDecoration: "none" }}>
            <span style={css.title}>Son of Steve</span>
          </Link>
          <div style={{ display: "flex", gap: 0, marginLeft: 16 }}>
            <NavTab to="/" label="Jobs" active={isJobsTab} />
            <NavTab to="/prs" label="PRs" active={isPrsTab} />
            <NavTab to="/repos" label="Repos" active={isReposTab} />
          </div>
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

      {/* Always-mounted list views — hidden when not active to preserve state */}
      <div style={{ display: showJobsList ? "block" : "none" }}>
        <JobsList />
      </div>
      <div style={{ display: showPrsList ? "block" : "none" }}>
        <PrsList />
      </div>

      {/* Sub-pages rendered via Routes */}
      <Routes>
        <Route path="/repos" element={<RepoRegistryEditor />} />
        <Route path="/jobs/new" element={<CreateJobForm />} />
        <Route path="/jobs/:taskId" element={<JobDetail />} />
        <Route path="*" element={null} />
      </Routes>
    </div>
  );
}
