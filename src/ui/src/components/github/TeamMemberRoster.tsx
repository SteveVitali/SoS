/**
 * TeamMemberRoster — displays members of a GitHub team with avatars.
 */

import { useEffect, useState } from "react";
import { type GitHubMemberInfo, listGitHubTeamMembers } from "../../api.js";
import { css } from "../../styles/theme.js";
import { toErrorMessage } from "../../utils/format.js";

export function TeamMemberRoster({ teamSlug }: { teamSlug: string }) {
  const [members, setMembers] = useState<GitHubMemberInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!teamSlug) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    listGitHubTeamMembers(teamSlug)
      .then((res) => {
        if (!cancelled) setMembers(res.members);
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamSlug]);

  if (!teamSlug) {
    return (
      <div style={{ color: "var(--fg3)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
        Select a team to see members
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ color: "var(--fg3)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
        Loading members…
      </div>
    );
  }

  if (error) {
    return <div style={{ ...css.error, padding: "12px 0" }}>{error}</div>;
  }

  if (members.length === 0) {
    return (
      <div style={{ color: "var(--fg3)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
        No members found — try triggering an org sync
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {members.map((m) => (
        <a
          key={m._id}
          href={`https://github.com/${m.login}`}
          target="_blank"
          rel="noopener"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "6px 8px",
            borderRadius: 6,
            textDecoration: "none",
            color: "var(--fg)",
            transition: "background 0.1s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--bg3)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
        >
          <img
            src={m.avatar_url || `https://github.com/${m.login}.png?size=64`}
            alt=""
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              flexShrink: 0,
              background: "var(--bg3)",
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {m.name || m.login}
            </div>
            {m.name && <div style={{ fontSize: 11, color: "var(--fg3)" }}>@{m.login}</div>}
          </div>
        </a>
      ))}
    </div>
  );
}
