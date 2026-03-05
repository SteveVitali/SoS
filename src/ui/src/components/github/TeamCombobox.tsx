/**
 * TeamCombobox — searchable dropdown for selecting an org team.
 */

import { useEffect, useRef, useState } from "react";
import type { GitHubTeamInfo } from "../../api.js";
import { useClickOutside } from "../../hooks/useClickOutside.js";
import { css } from "../../styles/theme.js";

export function TeamCombobox({
  value,
  onChange,
  teams,
  loading,
}: {
  value: string;
  onChange: (slug: string) => void;
  teams: GitHubTeamInfo[];
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useClickOutside(ref, () => setOpen(false), open);

  // Focus search input when opened
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const lowerSearch = search.toLowerCase();
  const filtered = teams.filter(
    (t) =>
      t.slug.toLowerCase().includes(lowerSearch) ||
      t.name.toLowerCase().includes(lowerSearch) ||
      (t.description || "").toLowerCase().includes(lowerSearch),
  );

  const selected = teams.find((t) => t.slug === value);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setSearch("");
        }}
        style={{
          ...css.input,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          textAlign: "left",
          minHeight: 38,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? (
            <>
              <strong>{selected.name}</strong>{" "}
              <span style={{ color: "var(--fg3)", fontSize: 12 }}>({selected.slug})</span>
            </>
          ) : value ? (
            <span>{value}</span>
          ) : (
            <span style={{ color: "var(--fg3)" }}>Select a team…</span>
          )}
        </span>
        <span style={{ color: "var(--fg3)", fontSize: 10, marginLeft: 8, flexShrink: 0 }}>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            zIndex: 50,
            maxHeight: 320,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Search input */}
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search teams…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                ...css.input,
                fontSize: 13,
                padding: "6px 10px",
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && filtered.length === 1) {
                  onChange(filtered[0].slug);
                  setOpen(false);
                }
              }}
            />
          </div>

          {/* Options list */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {loading ? (
              <div style={{ padding: 16, color: "var(--fg3)", fontSize: 13, textAlign: "center" }}>
                Loading teams…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 16, color: "var(--fg3)", fontSize: 13, textAlign: "center" }}>
                {teams.length === 0 ? "No teams synced yet" : "No teams match"}
              </div>
            ) : (
              filtered.map((team) => (
                <button
                  key={team._id}
                  type="button"
                  onClick={() => {
                    onChange(team.slug);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "8px 12px",
                    background: team.slug === value ? "var(--bg3)" : "transparent",
                    border: "none",
                    color: "var(--fg)",
                    fontSize: 13,
                    textAlign: "left",
                    cursor: "pointer",
                    borderBottom: "1px solid var(--border)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "var(--bg2)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      team.slug === value ? "var(--bg3)" : "transparent";
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{team.name}</div>
                    <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 2 }}>
                      {team.slug}
                      {team.description && (
                        <>
                          {" "}
                          · {team.description.slice(0, 60)}
                          {team.description.length > 60 ? "…" : ""}
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--fg3)",
                      background: "var(--bg3)",
                      padding: "2px 6px",
                      borderRadius: 8,
                      flexShrink: 0,
                      marginLeft: 8,
                    }}
                  >
                    {team.member_count}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
