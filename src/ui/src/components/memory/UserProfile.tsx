import { useCallback, useEffect, useState } from "react";
import type { MemoryNote } from "../../api.js";
import { editMemoryNote, getMemoryProfile, triggerReflection } from "../../api.js";
import { css } from "../../styles/theme.js";
import { Spinner } from "../shared/Spinner.js";

export function UserProfile() {
  const [profile, setProfile] = useState<MemoryNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [reflecting, setReflecting] = useState(false);
  const [reflectResult, setReflectResult] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMemoryProfile();
      setProfile(res.profile);
      if (res.profile) setEditContent(res.profile.content);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  async function handleReflect() {
    setReflecting(true);
    setReflectResult(null);
    try {
      const res = await triggerReflection();
      const r = res.result;
      setReflectResult(
        `Created ${r.reflections_created} reflection${r.reflections_created !== 1 ? "s" : ""} ` +
          `from ${r.clusters_found} cluster${r.clusters_found !== 1 ? "s" : ""} ` +
          `(${r.episodes_reviewed} episodes reviewed). ` +
          `Profile ${r.profile_updated ? "updated" : "unchanged"}.`,
      );
      await fetch();
    } catch (err) {
      setReflectResult(`Reflection failed: ${(err as Error).message}`);
    } finally {
      setReflecting(false);
    }
  }

  async function handleSave() {
    if (!profile) return;
    setSaving(true);
    try {
      await editMemoryNote(profile.memory_id, { content: editContent });
      setEditing(false);
      await fetch();
    } catch {
      // keep editing
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading profile…" />;

  if (!profile) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>👤</div>
        <div style={{ fontSize: 15, color: "var(--fg2)", marginBottom: 8 }}>
          No user profile has been synthesized yet.
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--fg3)",
            marginBottom: 20,
            maxWidth: 400,
            margin: "0 auto 20px",
          }}
        >
          Profiles are generated during reflection after enough interactions (default: 10 episodes).
          You can trigger reflection manually.
        </div>
        <button type="button" style={css.btnPrimary} onClick={handleReflect} disabled={reflecting}>
          {reflecting ? "Running Reflection…" : "▶ Run Reflection Now"}
        </button>
        {reflectResult && (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--fg2)" }}>{reflectResult}</div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={css.card}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 24 }}>👤</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}>User Profile</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg3)", textAlign: "right" }}>
            <div>Last updated: {new Date(profile.updated_at).toLocaleString()}</div>
            <div>
              Synthesized from {profile.source_episodes.length} episode
              {profile.source_episodes.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>

        {/* Profile content */}
        {editing ? (
          <div>
            <textarea
              style={{ ...css.textarea, minHeight: 200 }}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" style={css.btnPrimary} onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                style={css.btnSmall}
                onClick={() => {
                  setEditing(false);
                  setEditContent(profile.content);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}
          >
            {profile.content}
          </div>
        )}

        {/* Keywords/tags */}
        {profile.keywords.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 12 }}>
            {profile.keywords
              .filter((k) => !k.startsWith("__"))
              .map((kw) => (
                <span key={kw} style={css.badge("#6b7280")}>
                  {kw}
                </span>
              ))}
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}
        >
          {!editing && (
            <button type="button" style={css.btnSmall} onClick={() => setEditing(true)}>
              ✏️ Edit
            </button>
          )}
          <button type="button" style={css.btnSmall} onClick={handleReflect} disabled={reflecting}>
            {reflecting ? "Reflecting…" : "🔄 Regenerate Profile"}
          </button>
        </div>

        {reflectResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              color: "var(--fg2)",
              padding: "6px 10px",
              background: "var(--bg)",
              borderRadius: 6,
            }}
          >
            {reflectResult}
          </div>
        )}
      </div>
    </div>
  );
}
