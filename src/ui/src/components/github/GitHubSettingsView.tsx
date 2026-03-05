/**
 * GitHubSettingsView — UI-editable settings for the GitHub Hub.
 * Shows resolved config, token status, team selector with member roster.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type GitHubScope,
  type GitHubSettingsResponse,
  type GitHubTeamInfo,
  getGitHubSettings,
  listGitHubTeams,
  saveGitHubSettings,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { toErrorMessage } from "../../utils/format.js";
import { TeamCombobox } from "./TeamCombobox.js";
import { TeamMemberRoster } from "./TeamMemberRoster.js";

export function GitHubSettingsView() {
  const [settings, setSettings] = useState<GitHubSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  // Editable fields
  const [org, setOrg] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [username, setUsername] = useState("");
  const [historyDays, setHistoryDays] = useState(365);
  const [defaultScope, setDefaultScope] = useState<GitHubScope>("me");
  const [syncEnabled, setSyncEnabled] = useState(true);

  // Teams list (for combobox)
  const [teams, setTeams] = useState<GitHubTeamInfo[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await getGitHubSettings();
      setSettings(res);
      // Populate form
      setOrg(res.resolved.org);
      setTeamSlug(res.resolved.team_slug);
      setUsername(res.resolved.username);
      setHistoryDays(res.resolved.history_days);
      setDefaultScope(res.resolved.default_scope);
      setSyncEnabled(res.resolved.sync_enabled);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Fetch teams for the combobox
  useEffect(() => {
    setTeamsLoading(true);
    listGitHubTeams()
      .then((res) => setTeams(res.teams))
      .catch(() => {}) // non-fatal
      .finally(() => setTeamsLoading(false));
  }, []);

  // Auto-save team selection on change
  const handleTeamChange = async (slug: string) => {
    setTeamSlug(slug);
    setSaveMsg("");
    try {
      await saveGitHubSettings({
        org,
        team_slug: slug,
        username,
        history_days: historyDays,
        default_scope: defaultScope,
        sync_enabled: syncEnabled,
      });
      setSaveMsg("Team saved!");
      setTimeout(() => setSaveMsg(""), 3000);
      refresh();
    } catch (err: unknown) {
      setError(toErrorMessage(err));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg("");
    try {
      await saveGitHubSettings({
        org,
        team_slug: teamSlug,
        username,
        history_days: historyDays,
        default_scope: defaultScope,
        sync_enabled: syncEnabled,
      });
      setSaveMsg("Settings saved!");
      setTimeout(() => setSaveMsg(""), 3000);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !settings) {
    return <div style={{ padding: 20, color: "var(--fg3)" }}>Loading settings…</div>;
  }

  return (
    <div>
      {error && <div style={{ ...css.error, marginBottom: 16 }}>{error}</div>}

      {/* Token Status — full width */}
      <div style={{ ...css.card, marginBottom: 20 }}>
        <div style={{ ...css.sectionTitle, marginBottom: 12 }}>GitHub Token</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: settings?.token.valid
                ? "#22c55e"
                : settings?.token.configured
                  ? "#eab308"
                  : "#ef4444",
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {settings?.token.valid
              ? "Token valid"
              : settings?.token.configured
                ? "Token configured but invalid"
                : "No token configured"}
          </span>
        </div>
        {settings?.token.scopes && settings.token.scopes.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--fg3)" }}>
            Scopes: {settings.token.scopes.join(", ")}
          </div>
        )}
        {!settings?.token.configured && (
          <div style={{ fontSize: 12, color: "var(--fg3)", marginTop: 8 }}>
            Set <code style={css.mono}>SOS_GITHUB_TOKEN</code> env var with a Classic PAT (scopes:{" "}
            <code style={css.mono}>repo</code>, <code style={css.mono}>read:org</code>). If your org
            uses SAML SSO, authorize the PAT after creation.
          </div>
        )}
      </div>

      {/* Two-column layout: Settings Form | Team Roster */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        {/* Left: Settings Form */}
        <div style={css.card}>
          <div style={{ ...css.sectionTitle, marginBottom: 16 }}>Configuration</div>

          <div style={css.field}>
            <label style={css.label}>Organization</label>
            <input
              style={css.input}
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="e.g. Foursquare"
            />
          </div>

          <div style={css.field}>
            <label style={css.label}>GitHub Username</label>
            <input
              style={css.input}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Auto-detected from token if empty"
            />
          </div>

          <div style={css.field}>
            <label style={css.label}>History (days)</label>
            <input
              style={{ ...css.input, width: 120 }}
              type="number"
              value={historyDays}
              onChange={(e) => setHistoryDays(parseInt(e.target.value, 10) || 365)}
              min={7}
              max={1825}
            />
            <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 4 }}>
              How far back to backfill PR history
            </div>
          </div>

          <div style={css.field}>
            <label style={css.label}>Default Scope</label>
            <select
              style={css.select}
              value={defaultScope}
              onChange={(e) => setDefaultScope(e.target.value as GitHubScope)}
            >
              <option value="me">Me</option>
              <option value="team">My Team</option>
              <option value="org">My Org</option>
            </select>
          </div>

          <div style={{ ...css.field, display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(e) => setSyncEnabled(e.target.checked)}
              id="sync-enabled"
            />
            <label htmlFor="sync-enabled" style={{ fontSize: 13, cursor: "pointer" }}>
              Enable background sync
            </label>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" style={css.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Settings"}
            </button>
            {saveMsg && <span style={{ fontSize: 13, color: "#22c55e" }}>{saveMsg}</span>}
          </div>
        </div>

        {/* Right: Team Member Roster */}
        <div style={{ ...css.card, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div
            style={{
              ...css.sectionTitle,
              marginBottom: 12,
            }}
          >
            Team
          </div>
          <div style={{ marginBottom: 12 }}>
            <TeamCombobox
              value={teamSlug}
              onChange={handleTeamChange}
              teams={teams}
              loading={teamsLoading}
            />
            <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 4 }}>
              Defines the "My Team" filter across PRs and Contributions
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            <TeamMemberRoster teamSlug={teamSlug} />
          </div>
        </div>
      </div>

      {/* Environment Variables Reference — full width */}
      <div style={{ ...css.card, marginTop: 16 }}>
        <div style={{ ...css.sectionTitle, marginBottom: 12 }}>Environment Variables</div>
        <div style={{ fontSize: 12, color: "var(--fg3)", lineHeight: 1.8 }}>
          Settings above are stored in MongoDB and override env vars. Env vars serve as defaults:
        </div>
        <table style={{ width: "100%", fontSize: 12, marginTop: 8 }}>
          <tbody>
            {[
              ["SOS_GITHUB_TOKEN", "GitHub PAT (Classic, repo + read:org)"],
              ["SOS_GITHUB_ORG", `Default: ${settings?.resolved.org || "Foursquare"}`],
              [
                "SOS_GITHUB_TEAM_SLUG",
                `Default: ${settings?.resolved.team_slug || "places-engineering"}`,
              ],
              ["SOS_GITHUB_USERNAME", "Auto-detected from token"],
              ["SOS_GITHUB_HISTORY_DAYS", `Default: ${settings?.resolved.history_days || 365}`],
              ["SOS_GITHUB_SYNC_ENABLED", "true / false"],
              ["SOS_GITHUB_CHUNK_DAYS", "Default: 28"],
              ["SOS_GITHUB_CHUNK_EPOCH", "Default: 2024-01-01"],
            ].map(([name, desc]) => (
              <tr key={name}>
                <td
                  style={{
                    padding: "3px 8px 3px 0",
                    fontFamily: "'SF Mono', monospace",
                    color: "var(--fg2)",
                  }}
                >
                  {name}
                </td>
                <td style={{ padding: "3px 0", color: "var(--fg3)" }}>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
