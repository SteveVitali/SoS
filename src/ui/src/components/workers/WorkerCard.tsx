import { useNavigate } from "react-router-dom";
import type { WorkerInfo } from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";
import { HoverRow } from "../shared/HoverRow.js";
import { LogTerminal } from "./LogTerminal.js";

interface WorkerCardProps {
  worker: WorkerInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onViewLogs: () => void;
  onShutdown: () => void;
  onRemove: () => void;
}

function statusDotColor(status: string): string {
  if (status === "online") return "#22c55e";
  if (status === "degraded") return "#eab308";
  return "#6b7280";
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return `${hrs}h ${remMins}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export function WorkerCard({
  worker,
  expanded,
  onToggleExpand,
  onViewLogs,
  onShutdown,
  onRemove,
}: WorkerCardProps) {
  const navigate = useNavigate();
  const isOffline = worker.status === "offline";
  const loop = worker.loops[0];

  return (
    <div style={{ opacity: isOffline ? 0.5 : 1 }}>
      <HoverRow onClick={onToggleExpand}>
        {/* Line 1: expand chevron + status dot + worker ID + uptime + PID */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 10,
              color: "var(--fg3)",
              width: 12,
              textAlign: "center",
              flexShrink: 0,
              transition: "transform 0.15s",
              transform: expanded ? "rotate(90deg)" : "none",
            }}
          >
            ▶
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusDotColor(worker.status),
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600, color: "var(--fg)" }}>{worker.worker_id}</span>
          <span style={{ fontSize: 12, color: "var(--fg3)" }}>
            {isOffline
              ? `offline (last seen ${relativeTime(worker.last_seen)})`
              : `▲ ${formatUptime(worker.started_at)}`}
          </span>
          {!isOffline && loop && (
            <span style={css.badge(loop.status === "busy" ? "#eab308" : "#22c55e")}>
              {loop.status}
            </span>
          )}
          {loop?.task_id && (
            <a
              href={`/jobs/${loop.task_id}`}
              style={{ ...css.mono, ...css.link, textDecoration: "none", fontSize: 12 }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigate(`/jobs/${loop.task_id}`);
              }}
            >
              {loop.task_id.slice(0, 8)}…
            </a>
          )}
          <span
            style={{
              ...css.mono,
              fontSize: 11,
              color: "var(--fg3)",
              background: "var(--bg3)",
              padding: "1px 6px",
              borderRadius: 4,
            }}
          >
            PID {worker.pid}
          </span>
          <div style={{ flex: 1 }} />
          <fieldset
            style={{ display: "flex", gap: 4, border: "none", padding: 0, margin: 0 }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {!isOffline && (
              <>
                <button type="button" style={css.btnSmall} onClick={onViewLogs}>
                  Full Page
                </button>
                <button
                  type="button"
                  style={{ ...css.btnSmall, color: "var(--red)" }}
                  onClick={onShutdown}
                >
                  Shutdown
                </button>
              </>
            )}
            {isOffline && (
              <button
                type="button"
                style={{ ...css.btnSmall, color: "var(--red)" }}
                onClick={onRemove}
              >
                Remove
              </button>
            )}
          </fieldset>
        </div>

        {/* Worktree slot + busy duration */}
        {loop?.worktree_slot && (
          <div style={{ marginTop: 4, marginLeft: 30, fontSize: 12, color: "var(--fg3)" }}>
            <span style={css.mono}>{loop.worktree_slot}</span>
            {loop.busy_since && <span> · {relativeTime(loop.busy_since)}</span>}
          </div>
        )}
      </HoverRow>

      {/* Expanded inline log terminal */}
      {expanded && !isOffline && (
        <div
          style={{
            padding: "0 12px 12px",
            background: "var(--bg2)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <LogTerminal workerId={worker.worker_id} height={250} />
        </div>
      )}
    </div>
  );
}
