import type { ReactNode } from "react";
import { css } from "../../styles/theme.js";

// ---------------------------------------------------------------------------
// Shared index-status primitives — used by FtsStatus, RaptorStatus, KBList
// ---------------------------------------------------------------------------

export function elapsed(start: number | string | undefined): string {
  if (!start) return "";
  const ms = Date.now() - (typeof start === "number" ? start : new Date(start).getTime());
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--fg2)",
          marginBottom: 3,
        }}
      >
        <span>{label}</span>
        <span>
          {value}/{max} ({pct}%)
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--bg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "var(--accent)",
            borderRadius: 3,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}

export function MiniProgressBar({ pct, width = 60 }: { pct: number; width?: number }) {
  return (
    <div
      style={{
        width,
        height: 4,
        borderRadius: 2,
        background: "var(--border)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: "var(--accent)",
          borderRadius: 2,
          transition: "width 0.3s ease",
        }}
      />
    </div>
  );
}

export function SuccessBanner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "#22c55e",
        background: "rgba(34,197,94,0.1)",
        border: "1px solid rgba(34,197,94,0.3)",
        borderRadius: "var(--radius)",
        padding: "6px 10px",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--red)",
        background: "rgba(239,68,68,0.1)",
        border: "1px solid rgba(239,68,68,0.3)",
        borderRadius: "var(--radius)",
        padding: "6px 10px",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

export function BuildProgressBox({
  phase,
  elapsedStart,
  children,
}: {
  phase: string;
  elapsedStart: number | string | undefined;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        fontSize: 12,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "10px 12px",
        marginBottom: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--accent)" }}>{phase}</span>
        <span style={{ color: "var(--fg2)", fontSize: 11 }}>{elapsed(elapsedStart)}</span>
      </div>
      {children}
    </div>
  );
}

export function IndexStatusCard({
  icon,
  title,
  buttonLabel,
  buttonDisabled,
  onButtonClick,
  error,
  successMessage,
  showSuccess,
  isActive,
  progressContent,
  summaryContent,
  emptyMessage,
  isEmpty,
}: {
  icon: string;
  title: string;
  buttonLabel: string;
  buttonDisabled: boolean;
  onButtonClick: () => void;
  error?: string;
  successMessage?: string;
  showSuccess?: boolean;
  isActive: boolean;
  progressContent?: ReactNode;
  summaryContent?: ReactNode;
  emptyMessage?: string;
  isEmpty?: boolean;
}) {
  return (
    <div style={{ ...css.card, marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <h4 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
          {icon} {title}
        </h4>
        <button
          type="button"
          style={css.btnSmall}
          disabled={buttonDisabled}
          onClick={onButtonClick}
        >
          {buttonLabel}
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {successMessage && showSuccess && <SuccessBanner>{successMessage}</SuccessBanner>}
      {isActive && progressContent}
      {!isActive && summaryContent}
      {!isActive && isEmpty && emptyMessage && (
        <div style={{ fontSize: 12, color: "var(--fg2)" }}>{emptyMessage}</div>
      )}
    </div>
  );
}
