/**
 * GitHubPage — main container for the GitHub Hub tab.
 * Sub-tabs: PRs | Contributions | Sync | Settings
 */

import { useCallback, useEffect, useState } from "react";
import { GitHubContributionsView } from "./GitHubContributionsView.js";
import { GitHubPrsView } from "./GitHubPrsView.js";
import { GitHubSettingsView } from "./GitHubSettingsView.js";
import { GitHubSyncDashboard } from "./GitHubSyncDashboard.js";

type SubTab = "prs" | "contributions" | "sync" | "settings";

const TAB_HASH_MAP: Record<SubTab, string> = {
  prs: "pull-requests",
  contributions: "contributions",
  sync: "sync",
  settings: "settings",
};

const HASH_TAB_MAP: Record<string, SubTab> = Object.fromEntries(
  Object.entries(TAB_HASH_MAP).map(([k, v]) => [v, k as SubTab]),
) as Record<string, SubTab>;

function tabFromHash(): SubTab {
  const hash = window.location.hash.replace(/^#/, "");
  return HASH_TAB_MAP[hash] || "prs";
}

export function GitHubPage() {
  const [activeTab, setActiveTab] = useState<SubTab>(tabFromHash);

  const changeTab = useCallback((tab: SubTab) => {
    setActiveTab(tab);
    window.location.hash = TAB_HASH_MAP[tab];
  }, []);

  // Sync tab when user navigates back/forward
  useEffect(() => {
    const onHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>GitHub</h2>
        <div style={{ display: "flex", gap: 0 }}>
          {(["prs", "contributions", "sync", "settings"] as SubTab[]).map((tab) => (
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
                textTransform: "capitalize",
              }}
            >
              {tab === "prs" ? "Pull Requests" : tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "prs" && <GitHubPrsView />}
      {activeTab === "contributions" && <GitHubContributionsView />}
      {activeTab === "sync" && <GitHubSyncDashboard />}
      {activeTab === "settings" && <GitHubSettingsView />}
    </div>
  );
}
