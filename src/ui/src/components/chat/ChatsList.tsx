import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type Conversation,
  createConversation,
  deleteConversation,
  listConversations,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";
import { HoverRow } from "../shared/HoverRow.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";

export function ChatsList() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listConversations({ limit: 50 });
      setConversations(res.conversations);
      setTotal(res.total);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    refresh();
  }, [refresh]);

  // Poll every 5s
  useEffect(() => {
    const timer = setInterval(() => refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleNewChat = async () => {
    try {
      const res = await createConversation();
      navigate(`/chats/${res.conversation.conversation_id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.conversation_id !== id));
      setTotal((prev) => prev - 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <Spinner label="Loading chats…" />;

  return (
    <div>
      <PageHeader
        title="Chats"
        count={total}
        actions={
          <button type="button" style={css.btnPrimary} onClick={handleNewChat}>
            + New Chat
          </button>
        }
      />

      {error && <div style={css.error}>{error}</div>}

      {conversations.length === 0 && !loading && (
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            color: "var(--fg3)",
          }}
        >
          <div style={{ fontSize: 18, marginBottom: 8 }}>No conversations yet</div>
          <div style={{ fontSize: 14, marginBottom: 20 }}>Start a new chat with Son of Steve</div>
          <button type="button" style={css.btnPrimary} onClick={handleNewChat}>
            + New Chat
          </button>
        </div>
      )}

      {conversations.map((c) => {
        const lastMsg = c.messages.length > 0 ? c.messages[c.messages.length - 1] : null;
        const lastAssistant = [...c.messages].reverse().find((m) => m.role === "assistant");
        const preview = lastAssistant
          ? lastAssistant.text.slice(0, 100) + (lastAssistant.text.length > 100 ? "…" : "")
          : lastMsg
            ? lastMsg.text.slice(0, 100)
            : "Empty conversation";
        const hasActiveJob = c.linked_task_ids.length > 0;

        return (
          <HoverRow key={c.conversation_id} onClick={() => navigate(`/chats/${c.conversation_id}`)}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 14,
                    color: "var(--fg)",
                    marginBottom: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.title || "New conversation"}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--fg3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {preview}
                </div>
                {hasActiveJob && (
                  <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {c.linked_task_ids.slice(0, 3).map((tid) => (
                      <span
                        key={tid}
                        style={{
                          ...css.badge("#3b82f6"),
                          fontSize: 10,
                        }}
                      >
                        {tid.slice(0, 8)}…
                      </span>
                    ))}
                    {c.linked_task_ids.length > 3 && (
                      <span style={{ fontSize: 11, color: "var(--fg3)" }}>
                        +{c.linked_task_ids.length - 3} more
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginLeft: 12,
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 12, color: "var(--fg3)", whiteSpace: "nowrap" }}>
                  {relativeTime(c.updated_at)}
                </span>
                <button
                  type="button"
                  style={{
                    ...css.btnSmall,
                    color: "var(--red)",
                    border: "1px solid transparent",
                    background: "transparent",
                    padding: "2px 6px",
                    fontSize: 11,
                    opacity: 0.5,
                  }}
                  title="Delete conversation"
                  onClick={(e) => handleDelete(e, c.conversation_id)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.opacity = "1";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.opacity = "0.5";
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          </HoverRow>
        );
      })}
    </div>
  );
}
