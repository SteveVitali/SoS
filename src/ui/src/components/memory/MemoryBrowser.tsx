import { useCallback, useEffect, useState } from "react";
import type { MemoryNote, MemorySearchResult, MemoryType } from "../../api.js";
import { listMemoryNotes, searchMemoryNotes } from "../../api.js";
import { css } from "../../styles/theme.js";
import { Pagination } from "../shared/Pagination.js";
import { Spinner } from "../shared/Spinner.js";
import { MemoryCard } from "./MemoryCard.js";

const PAGE_SIZE = 20;

interface MemoryBrowserProps {
  onNavigateEpisode?: (id: string) => void;
  initialQuery?: string;
}

export function MemoryBrowser({ onNavigateEpisode, initialQuery }: MemoryBrowserProps) {
  const [query, setQuery] = useState(initialQuery || "");
  const [activeQuery, setActiveQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<MemoryType | "">("");
  const [tagFilter, setTagFilter] = useState("");
  const [showInvalidated, setShowInvalidated] = useState(false);
  const [offset, setOffset] = useState(0);

  // List mode state
  const [memories, setMemories] = useState<MemoryNote[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Search mode state
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const isSearchMode = activeQuery.length > 0;

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listMemoryNotes({
        type: typeFilter || undefined,
        tag: tagFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setMemories(res.memories);
      setTotal(res.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [typeFilter, tagFilter, offset]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setActiveQuery("");
        return;
      }
      setSearching(true);
      setActiveQuery(q);
      try {
        const res = await searchMemoryNotes({
          query: q,
          memory_types: typeFilter ? [typeFilter] : undefined,
          limit: 25,
        });
        setSearchResults(res.results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [typeFilter],
  );

  useEffect(() => {
    if (!isSearchMode) {
      fetchList();
    }
  }, [fetchList, isSearchMode]);

  useEffect(() => {
    if (initialQuery) {
      runSearch(initialQuery);
    }
  }, [initialQuery, runSearch]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) {
      runSearch(query);
    } else {
      setActiveQuery("");
      setSearchResults([]);
    }
  }

  function handleClearSearch() {
    setQuery("");
    setActiveQuery("");
    setSearchResults([]);
  }

  const refresh = () => {
    if (isSearchMode) {
      runSearch(activeQuery);
    } else {
      fetchList();
    }
  };

  // Filter invalidated in list mode (search mode doesn't return invalidated by default)
  const displayMemories = isSearchMode
    ? searchResults.map((r) => r.memory)
    : showInvalidated
      ? memories
      : memories.filter((m) => !m.invalidated_at);

  const searchResultMap = new Map<string, MemorySearchResult>();
  for (const r of searchResults) {
    searchResultMap.set(r.memory.memory_id, r);
  }

  return (
    <div>
      {/* Search bar */}
      <form onSubmit={handleSubmit} style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...css.input, flex: 1 }}
            placeholder="Search memories (hybrid: semantic + keyword)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" style={css.btnPrimary}>
            Search
          </button>
          {isSearchMode && (
            <button type="button" style={css.btnSmall} onClick={handleClearSearch}>
              Clear
            </button>
          )}
        </div>
      </form>

      {/* Filters */}
      <div style={css.filters}>
        <select
          style={css.select}
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value as MemoryType | "");
            setOffset(0);
          }}
        >
          <option value="">All Types</option>
          <option value="fact">Facts</option>
          <option value="reflection">Reflections</option>
          <option value="user_profile">Profiles</option>
        </select>
        <input
          style={{ ...css.input, width: 160 }}
          placeholder="Filter by tag…"
          value={tagFilter}
          onChange={(e) => {
            setTagFilter(e.target.value);
            setOffset(0);
          }}
        />
        {!isSearchMode && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "var(--fg2)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={showInvalidated}
              onChange={(e) => setShowInvalidated(e.target.checked)}
            />
            Show invalidated
          </label>
        )}
        {isSearchMode && (
          <span style={{ fontSize: 12, color: "var(--fg3)" }}>
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for "{activeQuery}"
          </span>
        )}
      </div>

      {/* Content */}
      {(loading && !isSearchMode) || searching ? (
        <Spinner label={isSearchMode ? "Searching…" : "Loading memories…"} />
      ) : displayMemories.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--fg3)" }}>
          {isSearchMode
            ? "No memories match your query. Try broader terms or adjust filters."
            : "No memories yet. Facts will be extracted automatically as you interact with Steve via chat, Slack, or Discord."}
        </div>
      ) : (
        <>
          {displayMemories.map((m) => (
            <MemoryCard
              key={m.memory_id}
              memory={m}
              searchResult={searchResultMap.get(m.memory_id)}
              onNavigateEpisode={onNavigateEpisode}
              onRefresh={refresh}
            />
          ))}
          {!isSearchMode && total > PAGE_SIZE && (
            <Pagination
              offset={offset}
              limit={PAGE_SIZE}
              total={total}
              onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              onNext={() => setOffset(offset + PAGE_SIZE)}
            />
          )}
        </>
      )}
    </div>
  );
}
