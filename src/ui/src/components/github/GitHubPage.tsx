/**
 * GitHubPage — main container for the GitHub Hub tab.
 * Sub-tabs: PRs | Contributions | Sync | Settings
 */

import { useState } from "react";
import { GitHubContributionsView } from "./GitHubContributionsView.js";
import { GitHubPrsView } from "./GitHubPrsView.js";
import { GitHubSettingsView } from "./GitHubSettingsView.js";
import { GitHubSyncDashboard } from "./GitHubSyncDashboard.js";

type SubTab = "prs" | "contributions" | "sync" | "settings";

export function GitHubPage() {
  const [activeTab, setActiveTab] = useState<SubTab>("prs");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>GitHub</h2>
        <div style={{ display: "flex", gap: 0 }}>
          {(["prs", "contributions", "sync", "settings"] as SubTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
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
