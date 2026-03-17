import { useCallback, useEffect, useState } from "react";
import { EpisodesList } from "./EpisodesList.js";
import { MemoryBrowser } from "./MemoryBrowser.js";
import { MemoryConfigEditor } from "./MemoryConfigEditor.js";
import { MemoryDashboard } from "./MemoryDashboard.js";
import { UserProfile } from "./UserProfile.js";

type SubTab = "dashboard" | "memories" | "episodes" | "profile" | "config";

const TAB_HASH_MAP: Record<SubTab, string> = {
  dashboard: "dashboard",
  memories: "memories",
  episodes: "episodes",
  profile: "profile",
  config: "config",
};

const HASH_TAB_MAP: Record<string, SubTab> = Object.fromEntries(
  Object.entries(TAB_HASH_MAP).map(([k, v]) => [v, k as SubTab]),
) as Record<string, SubTab>;

const TAB_LABELS: Record<SubTab, string> = {
  dashboard: "Dashboard",
  memories: "Memories",
  episodes: "Episodes",
  profile: "Profile",
  config: "Config",
};

function tabFromHash(): SubTab {
  const hash = window.location.hash.replace(/^#/, "");
  return HASH_TAB_MAP[hash] || "dashboard";
}

export function MemoryPage() {
  const [activeTab, setActiveTab] = useState<SubTab>(tabFromHash);

  const changeTab = useCallback((tab: SubTab) => {
    setActiveTab(tab);
    window.location.hash = TAB_HASH_MAP[tab];
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div>
      {/* Header with sub-tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Memory</h2>
        <div style={{ display: "flex", gap: 0 }}>
          {(Object.keys(TAB_HASH_MAP) as SubTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => changeTab(tab)}
              style={{
                padding: "6px 14px",
                border: "none",
                borderBottom:
                  activeTab === tab ? "2px solid var(--accent)" : "2px solid transparent",
                background: "transparent",
                color: activeTab === tab ? "var(--fg)" : "var(--fg3)",
                fontWeight: activeTab === tab ? 600 : 400,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
      </div>

      {/* Sub-view content */}
      {activeTab === "dashboard" && (
        <MemoryDashboard onNavigateTab={(tab) => changeTab(tab as SubTab)} />
      )}
      {activeTab === "memories" && (
        <MemoryBrowser onNavigateEpisode={() => changeTab("episodes")} />
      )}
      {activeTab === "episodes" && <EpisodesList onNavigateMemory={() => changeTab("memories")} />}
      {activeTab === "profile" && <UserProfile />}
      {activeTab === "config" && <MemoryConfigEditor />}
    </div>
  );
}
