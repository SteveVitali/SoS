import { useCallback, useEffect, useState } from "react";
import type { InteractionEpisode } from "../../api.js";
import { listMemoryEpisodes } from "../../api.js";
import { css } from "../../styles/theme.js";
import { Pagination } from "../shared/Pagination.js";
import { Spinner } from "../shared/Spinner.js";
import { EpisodeCard } from "./EpisodeCard.js";

const PAGE_SIZE = 20;

interface EpisodesListProps {
  onNavigateMemory?: (id: string) => void;
}

export function EpisodesList({ onNavigateMemory }: EpisodesListProps) {
  const [episodes, setEpisodes] = useState<InteractionEpisode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [actionFilter, setActionFilter] = useState("");

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listMemoryEpisodes({
        action: actionFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setEpisodes(res.episodes);
      setTotal(res.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [actionFilter, offset]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return (
    <div>
      {/* Filters */}
      <div style={css.filters}>
        <input
          style={{ ...css.input, width: 200 }}
          placeholder="Filter by action…"
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            setOffset(0);
          }}
        />
        <span style={{ fontSize: 12, color: "var(--fg3)" }}>
          {total} episode{total !== 1 ? "s" : ""}
        </span>
      </div>

      {loading ? (
        <Spinner label="Loading episodes…" />
      ) : episodes.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--fg3)" }}>
          No interaction episodes recorded yet. Episodes are created automatically from every Slack,
          Discord, and web chat interaction.
        </div>
      ) : (
        <>
          {episodes.map((ep) => (
            <EpisodeCard key={ep.episode_id} episode={ep} onNavigateMemory={onNavigateMemory} />
          ))}
          {total > PAGE_SIZE && (
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
