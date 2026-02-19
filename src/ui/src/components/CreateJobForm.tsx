import type React from "react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createJob, createRespondToCommentsJob } from "../api.js";
import { css } from "../styles/theme.js";

export function CreateJobForm() {
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
          test_level: testLevel as "fast" | "full" | "none",
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
