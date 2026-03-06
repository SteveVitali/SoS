import { useState } from "react";
import {
  type HybridSearchStats,
  type KBProbeResult,
  type KBScope,
  type KBSearchResult,
  searchAllKBs,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { ALL_SCOPES, RetrievalSummary, ScopeToggleButtons, SearchResultCard } from "./kbShared.js";

export function KBPlayground() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState<KBScope[]>([...ALL_SCOPES]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  // Results
  const [results, setResults] = useState<KBSearchResult[] | null>(null);
  const [probes, setProbes] = useState<KBProbeResult[]>([]);
  const [routingSummary, setRoutingSummary] = useState<{ total: number; relevant: number } | null>(
    null,
  );
  const [retrievalStats, setRetrievalStats] = useState<HybridSearchStats | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try {
      const data = await searchAllKBs({ query: query.trim(), scopes });
      setResults(data.results);
      setProbes(data.routing.probes);
      setRoutingSummary({ total: data.routing.total_kbs, relevant: data.routing.relevant_kbs });
      setRetrievalStats(data.retrieval_stats ?? null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const toggleScope = (scope: KBScope) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  return (
    <div style={{ ...css.card, marginBottom: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
        }}
        onClick={() => setOpen(!open)}
      >
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          {open ? "▼" : "▶"} Search Playground
        </h3>
        <span style={{ fontSize: 12, color: "var(--fg2)" }}>
          Test queries across all knowledge bases
        </span>
      </div>

      {open && (
        <div style={{ marginTop: 16 }}>
          {/* Scope selector */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ ...css.label, marginBottom: 6 }}>Scopes to search</label>
            <ScopeToggleButtons scopes={scopes} onToggle={toggleScope} />
          </div>

          {/* Search input */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              style={{ ...css.input, flex: 1 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter a query to test across all knowledge bases..."
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <button
              type="button"
              style={css.btnPrimary}
              disabled={searching || !query.trim()}
              onClick={handleSearch}
            >
              {searching ? "Searching..." : "Search"}
            </button>
          </div>

          {error && <div style={css.error}>{error}</div>}

          {/* Routing summary */}
          {routingSummary && (
            <div
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: 12,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  marginBottom: 8,
                  color: "var(--fg)",
                }}
              >
                Routing: {routingSummary.total} KB{routingSummary.total !== 1 ? "s" : ""} probed →{" "}
                {routingSummary.relevant} relevant → {results?.length ?? 0} result
                {results?.length !== 1 ? "s" : ""}
              </div>

              {/* Probe details */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {probes.map((p) => (
                  <div
                    key={p.kb_id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: 12,
                      background: p.passed ? "rgba(34,197,94,0.1)" : "rgba(107,114,128,0.1)",
                      border: `1px solid ${p.passed ? "rgba(34,197,94,0.3)" : "rgba(107,114,128,0.3)"}`,
                      color: p.passed ? "#22c55e" : "var(--fg2)",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{p.kb_name}</span>
                    <span style={{ opacity: 0.7 }}>{(p.probe_score * 100).toFixed(1)}%</span>
                    <span>{p.passed ? "✓" : "✗"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Retrieval source breakdown */}
          {retrievalStats && <RetrievalSummary stats={retrievalStats} />}

          {/* Results */}
          {results && results.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {results.map((r, i) => (
                <SearchResultCard key={i} result={r} showKBName />
              ))}
            </div>
          )}

          {results && results.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--fg2)", padding: "8px 0" }}>
              No results found. Try a different query or check that your knowledge bases have
              content.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
