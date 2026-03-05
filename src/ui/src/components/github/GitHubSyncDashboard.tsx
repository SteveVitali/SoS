/**
 * GitHubSyncDashboard — full transparency into the sync engine.
 * Shows backfill progress, chunk timeline, rate limit gauges,
 * live SSE activity feed, and manual trigger buttons.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getGitHubSyncChunks,
  getGitHubSyncLog,
  getGitHubSyncStatus,
  type SyncChunkInfo,
  type SyncLogEntry,
  type SyncStatusResponse,
  subscribeGitHubSyncLog,
  triggerGitHubSync,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";

export function GitHubSyncDashboard() {
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [chunks, setChunks] = useState<SyncChunkInfo[]>([]);
  const [logEntries, setLogEntries] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

  // 1-second tick for live countdowns
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [s, c, l] = await Promise.all([
        getGitHubSyncStatus(),
        getGitHubSyncChunks(),
        getGitHubSyncLog({ limit: 50 }),
      ]);
      setStatus(s);
      setChunks(c.chunks);
      setLogEntries(l.entries.reverse());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // SSE subscription for live log
  useEffect(() => {
    const unsub = subscribeGitHubSyncLog((entry) => {
      setLogEntries((prev) => [...prev.slice(-99), entry]);
    });
    return unsub;
  }, []);

  // Auto-scroll log
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on entry count change
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries.length]);

  const handleTrigger = async (scope: "prs" | "teams" | "contributions" | "backfill") => {
    try {
      await triggerGitHubSync(scope);
      setTimeout(refresh, 1000);
    } catch {
      // ignore
    }
  };

  if (!status && loading) {
    return <div style={{ padding: 20, color: "var(--fg3)" }}>Loading sync status…</div>;
  }

  if (error && !status) {
    return <div style={css.error}>{error}</div>;
  }

  const bf = status?.backfill;
  const rl = status?.rate_limit;
  const completedPct =
    bf && bf.total_chunks > 0 ? Math.round((bf.completed_chunks / bf.total_chunks) * 100) : 0;

  return (
    <div>
      {/* Status indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: status?.enabled ? "#22c55e" : "#ef4444",
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          {status?.enabled ? "Sync Engine Active" : "Sync Engine Disabled"}
        </span>
        <button
          type="button"
          onClick={refresh}
          style={{ ...css.btnSmall, marginLeft: "auto" }}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      {/* Backfill Progress */}
      <div style={css.card}>
        <div style={{ ...css.sectionTitle, marginBottom: 12 }}>Backfill Progress</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div
            style={{
              flex: 1,
              height: 12,
              background: "var(--bg3)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${completedPct}%`,
                background: completedPct === 100 ? "#22c55e" : "var(--accent)",
                borderRadius: 6,
                transition: "width 0.5s ease",
              }}
            />
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 48, textAlign: "right" }}>
            {completedPct}%
          </span>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--fg3)" }}>
          <span>
            {bf?.completed_chunks || 0} / {bf?.total_chunks || 0} chunks
          </span>
          {(bf?.failed_chunks || 0) > 0 && (
            <span style={{ color: "#ef4444" }}>{bf?.failed_chunks} failed</span>
          )}
          <span>{bf?.prs_total || 0} PRs cached</span>
          {bf?.oldest_data_available && <span>From {bf.oldest_data_available.split("T")[0]}</span>}
        </div>
      </div>

      {/* Rate Limits */}
      {rl && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}
        >
          <GaugeCard
            label="REST API"
            value={rl.rest.remaining}
            max={rl.rest.limit}
            subtitle={`Resets ${new Date(rl.rest.resets_at).toLocaleTimeString()}`}
          />
          <GaugeCard
            label="Search API"
            value={rl.search.tokens_available}
            max={rl.search.limit}
            subtitle="Token bucket (30/min)"
          />
          <GaugeCard
            label="Backfill Budget"
            value={rl.backfill_budget_available}
            max={rl.rest.limit}
            subtitle="Available for backfill"
          />
        </div>
      )}

      {/* Sync Timing */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <SyncTimerCard
          label="Hot Sync"
          description="Open PRs"
          lastRunAt={status?.hot_sync.last_run_at}
          intervalSeconds={status?.hot_sync.interval_seconds || 120}
          now={now}
          onTrigger={() => handleTrigger("prs")}
        />
        <SyncTimerCard
          label="Warm Sync"
          description="Teams & Members"
          lastRunAt={status?.warm_sync.last_run_at}
          intervalSeconds={status?.warm_sync.interval_seconds || 900}
          now={now}
          onTrigger={() => handleTrigger("teams")}
        />
      </div>

      {/* Chunk Timeline */}
      {chunks.length > 0 && (
        <div style={css.card}>
          <div style={{ ...css.sectionTitle, marginBottom: 12 }}>Chunk Timeline</div>
          <div
            style={{
              display: "flex",
              gap: 2,
            }}
          >
            {chunks.map((chunk) => {
              const color =
                chunk.status === "complete"
                  ? "#22c55e"
                  : chunk.status === "in_progress"
                    ? "#eab308"
                    : chunk.status === "failed"
                      ? "#ef4444"
                      : "var(--bg3)";
              return (
                <div
                  key={chunk.id}
                  title={`${chunk.start} — ${chunk.end}\nStatus: ${chunk.status}\nItems: ${chunk.total_items}${chunk.error ? `\nError: ${chunk.error}` : ""}`}
                  style={{
                    flex: 1,
                    height: 14,
                    borderRadius: 2,
                    background: color,
                    opacity: 0.85,
                    cursor: "help",
                  }}
                />
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 6,
              fontSize: 10,
              color: "var(--fg3)",
            }}
          >
            <span>{chunks[0]?.start}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <span>
                <span style={{ color: "#22c55e" }}>■</span> Complete
              </span>
              <span>
                <span style={{ color: "#eab308" }}>■</span> In Progress
              </span>
              <span>
                <span style={{ color: "#ef4444" }}>■</span> Failed
              </span>
              <span>
                <span style={{ color: "var(--fg3)" }}>■</span> Pending
              </span>
            </div>
            <span>{chunks[chunks.length - 1]?.end}</span>
          </div>
        </div>
      )}

      {/* Manual Triggers */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg2)", padding: "6px 0" }}>
          Trigger:
        </span>
        <button type="button" style={css.btnSmall} onClick={() => handleTrigger("backfill")}>
          Resume Backfill
        </button>
        <button type="button" style={css.btnSmall} onClick={() => handleTrigger("contributions")}>
          Rebuild Contributions
        </button>
      </div>

      {/* Live Activity Feed */}
      <div style={css.card}>
        <div style={{ ...css.sectionTitle, marginBottom: 8 }}>Activity Feed (Live)</div>
        <div
          style={{
            maxHeight: 300,
            overflow: "auto",
            background: "var(--bg)",
            borderRadius: "var(--radius)",
            padding: 8,
            border: "1px solid var(--border)",
            fontFamily: "'SF Mono', Monaco, Consolas, monospace",
            fontSize: 11,
          }}
        >
          {logEntries.length === 0 && (
            <div style={{ color: "var(--fg3)", padding: 8 }}>No sync activity yet</div>
          )}
          {logEntries.map((entry, idx) => {
            const levelColor =
              entry.level === "error"
                ? "#ef4444"
                : entry.level === "warn"
                  ? "#eab308"
                  : "var(--fg3)";
            const ts = new Date(entry.ts).toLocaleTimeString();
            return (
              <div key={`${entry.ts}-${idx}`} style={{ padding: "2px 0", lineHeight: 1.4 }}>
                <span style={{ color: "var(--fg3)" }}>{ts}</span>{" "}
                <span style={{ color: levelColor, fontWeight: 500 }}>[{entry.level}]</span>{" "}
                <span style={{ color: "var(--accent)", opacity: 0.7 }}>{entry.category}</span>{" "}
                <span style={{ color: "var(--fg)" }}>{entry.message}</span>
              </div>
            );
          })}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}

function SyncTimerCard({
  label,
  description,
  lastRunAt,
  intervalSeconds,
  now,
  onTrigger,
}: {
  label: string;
  description: string;
  lastRunAt?: string;
  intervalSeconds: number;
  now: number;
  onTrigger: () => void;
}) {
  const { remaining, pct } = useMemo(() => {
    if (!lastRunAt) return { remaining: -1, pct: 0 };
    const elapsed = (now - new Date(lastRunAt).getTime()) / 1000;
    const rem = Math.max(0, intervalSeconds - elapsed);
    return { remaining: Math.round(rem), pct: (rem / intervalSeconds) * 100 };
  }, [lastRunAt, intervalSeconds, now]);

  const countdown =
    remaining < 0
      ? "—"
      : remaining >= 60
        ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
        : `${remaining}s`;

  const barColor = remaining <= 10 && remaining >= 0 ? "var(--accent)" : "var(--fg3)";

  return (
    <div style={{ ...css.card, padding: 14, marginBottom: 0 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 11, color: "var(--fg3)" }}>{description}</div>
        </div>
        <button type="button" style={css.btnSmall} onClick={onTrigger}>
          Run Now
        </button>
      </div>
      {/* Progress bar (depletes as countdown approaches 0) */}
      <div
        style={{
          height: 4,
          background: "var(--bg3)",
          borderRadius: 2,
          overflow: "hidden",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: barColor,
            borderRadius: 2,
            transition: "width 1s linear",
            opacity: 0.6,
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 11, color: "var(--fg3)" }}>
          {lastRunAt ? `Last: ${relativeTime(lastRunAt)}` : "Never run"}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            color: remaining <= 10 && remaining >= 0 ? "var(--accent)" : "var(--fg2)",
          }}
        >
          {countdown}
        </div>
      </div>
    </div>
  );
}

function GaugeCard({
  label,
  value,
  max,
  subtitle,
}: {
  label: string;
  value: number;
  max: number;
  subtitle: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const color = pct > 50 ? "#22c55e" : pct > 20 ? "#eab308" : "#ef4444";

  return (
    <div style={{ ...css.card, padding: 14, marginBottom: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{label}</div>
      <div
        style={{
          height: 6,
          background: "var(--bg3)",
          borderRadius: 3,
          overflow: "hidden",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: color,
            borderRadius: 3,
            transition: "width 0.5s ease",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--fg3)",
        }}
      >
        <span>
          {value.toLocaleString()} / {max.toLocaleString()}
        </span>
        <span>{pct}%</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg3)", marginTop: 4 }}>{subtitle}</div>
    </div>
  );
}
