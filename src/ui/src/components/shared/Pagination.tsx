import { css } from "../../styles/theme.js";

interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function Pagination({ offset, limit, total, onPrev, onNext }: PaginationProps) {
  return (
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
        <button type="button" style={css.btnSmall} disabled={offset === 0} onClick={onPrev}>
          ← Prev
        </button>
        <button
          type="button"
          style={css.btnSmall}
          disabled={offset + limit >= total}
          onClick={onNext}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
