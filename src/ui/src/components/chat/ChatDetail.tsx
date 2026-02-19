import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type Conversation,
  type ConversationMessage,
  deleteConversation,
  getConversation,
  pollConversationUpdates,
  sendMessage,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime, shortId } from "../../utils/format.js";
import { Spinner } from "../shared/Spinner.js";

function MessageBubble({ msg }: { msg: ConversationMessage }) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  if (isSystem) {
    const isPlanMessage = msg.action?.command === "pending_confirmation";

    if (isPlanMessage) {
      return (
        <div style={{ margin: "10px 0" }}>
          <div
            style={{
              background: "var(--bg2)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 16px",
              fontSize: 13,
              color: "var(--fg2)",
              lineHeight: 1.6,
            }}
          >
            {msg.action?.task_id && (
              <Link
                to={`/jobs/${msg.action.task_id}`}
                style={{ color: "var(--accent2)", textDecoration: "none", marginRight: 6 }}
              >
                {shortId(msg.action.task_id)}…
              </Link>
            )}
            <div className="plan-markdown" style={{ marginTop: 6 }}>
              <Markdown>{msg.text}</Markdown>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 3, paddingLeft: 4 }}>
            Steve ·{" "}
            {new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      );
    }

    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          margin: "8px 0",
        }}
      >
        <div
          style={{
            background: "var(--bg3)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 12,
            color: "var(--fg3)",
            maxWidth: "80%",
            textAlign: "center",
          }}
        >
          {msg.action?.task_id && (
            <Link
              to={`/jobs/${msg.action.task_id}`}
              style={{ color: "var(--accent2)", textDecoration: "none", marginRight: 6 }}
            >
              {shortId(msg.action.task_id)}…
            </Link>
          )}
          {msg.text}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "6px 0",
      }}
    >
      <div
        style={{
          maxWidth: "75%",
          minWidth: 60,
        }}
      >
        <div
          style={{
            background: isUser ? "var(--accent)" : "var(--bg2)",
            color: isUser ? "#fff" : "var(--fg)",
            borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
            padding: "10px 14px",
            fontSize: 14,
            lineHeight: 1.5,
            border: isUser ? "none" : "1px solid var(--border)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {msg.text}
          {msg.action?.task_id && (
            <div style={{ marginTop: 8 }}>
              <Link
                to={`/jobs/${msg.action.task_id}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: isUser ? "rgba(255,255,255,0.15)" : "var(--bg3)",
                  border: `1px solid ${isUser ? "rgba(255,255,255,0.2)" : "var(--border)"}`,
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 12,
                  color: isUser ? "#fff" : "var(--accent2)",
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                View job {shortId(msg.action.task_id)}… →
              </Link>
            </div>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--fg3)",
            marginTop: 3,
            textAlign: isUser ? "right" : "left",
            paddingLeft: isUser ? 0 : 4,
            paddingRight: isUser ? 4 : 0,
          }}
        >
          {isUser ? "" : "Steve · "}
          {new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    </div>
  );
}

export function ChatDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastPollRef = useRef<string>("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Load conversation
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getConversation(id)
      .then((res) => {
        setConversation(res.conversation);
        setError("");
        // Set poll watermark to latest message
        const msgs = res.conversation.messages;
        if (msgs.length > 0) {
          lastPollRef.current = msgs[msgs.length - 1].at;
        } else {
          lastPollRef.current = res.conversation.created_at;
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  // Poll for updates (job status messages)
  useEffect(() => {
    if (!id || !conversation) return;
    const hasActiveJobs = conversation.linked_task_ids.length > 0;
    const interval = hasActiveJobs ? 3_000 : 30_000;

    const timer = setInterval(async () => {
      try {
        const since = lastPollRef.current || conversation.created_at;
        const res = await pollConversationUpdates(id, since);
        if (res.messages.length > 0) {
          // Only add messages we don't already have
          setConversation((prev) => {
            if (!prev) return prev;
            const existingIds = new Set(prev.messages.map((m) => m.id));
            const newMsgs = res.messages.filter((m) => !existingIds.has(m.id));
            if (newMsgs.length === 0) return prev;
            const updated = {
              ...prev,
              messages: [...prev.messages, ...newMsgs],
              linked_task_ids: res.linked_task_ids,
            };
            lastPollRef.current = newMsgs[newMsgs.length - 1].at;
            return updated;
          });
        }
      } catch {
        // Ignore polling errors
      }
    }, interval);
    return () => clearInterval(timer);
  }, [id, conversation?.linked_task_ids.length, conversation?.created_at, conversation]);

  const handleSend = async () => {
    if (!id || !inputText.trim() || sending) return;
    const text = inputText.trim();
    setInputText("");
    setSending(true);

    // Optimistic: add user message immediately
    const optimisticUserMsg: ConversationMessage = {
      id: `pending-${Date.now()}`,
      role: "user",
      text,
      at: new Date().toISOString(),
    };
    setConversation((prev) =>
      prev ? { ...prev, messages: [...prev.messages, optimisticUserMsg] } : prev,
    );

    try {
      const res = await sendMessage(id, text);
      // Replace optimistic message with real ones
      setConversation((prev) => {
        if (!prev) return prev;
        const withoutOptimistic = prev.messages.filter((m) => m.id !== optimisticUserMsg.id);
        const updated = {
          ...prev,
          messages: [...withoutOptimistic, res.userMessage, res.assistantMessage],
          title: prev.title || undefined,
        };
        if (res.action.taskId) {
          updated.linked_task_ids = [...prev.linked_task_ids, res.action.taskId];
        }
        lastPollRef.current = res.assistantMessage.at;
        return updated;
      });
      // Refresh to get title
      if (!conversation?.title) {
        setTimeout(async () => {
          try {
            const fresh = await getConversation(id);
            setConversation((prev) => (prev ? { ...prev, title: fresh.conversation.title } : prev));
          } catch {
            // ignore
          }
        }, 2000);
      }
    } catch (err: unknown) {
      // Remove optimistic message on error
      setConversation((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticUserMsg.id) }
          : prev,
      );
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDeleteChat = async () => {
    if (!id) return;
    if (!confirm("Delete this conversation?")) return;
    try {
      await deleteConversation(id);
      navigate("/chats");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <Spinner label="Loading conversation…" />;

  if (!conversation) {
    return (
      <div style={{ textAlign: "center", padding: 40, color: "var(--fg3)" }}>
        Conversation not found.{" "}
        <Link to="/chats" style={css.link}>
          Back to chats
        </Link>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 120px)",
        minHeight: 400,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 0 12px",
          borderBottom: "1px solid var(--border)",
          marginBottom: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link
            to="/chats"
            style={{
              color: "var(--fg3)",
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            ← Back
          </Link>
          <span style={{ fontWeight: 600, fontSize: 15, color: "var(--fg)" }}>
            {conversation.title || "New conversation"}
          </span>
          <span style={{ fontSize: 12, color: "var(--fg3)" }}>
            {relativeTime(conversation.updated_at)}
          </span>
        </div>
        <button
          type="button"
          style={{ ...css.btnSmall, color: "var(--red)" }}
          onClick={handleDeleteChat}
        >
          Delete
        </button>
      </div>

      {/* Messages area */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 0",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {conversation.messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--fg3)",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 32 }}>💬</div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Chat with Son of Steve</div>
            <div style={{ fontSize: 13 }}>Ask me to write code, check on jobs, or just say hi</div>
          </div>
        )}
        {conversation.messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
        {sending && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-start",
              margin: "6px 0",
            }}
          >
            <div
              style={{
                background: "var(--bg2)",
                border: "1px solid var(--border)",
                borderRadius: "16px 16px 16px 4px",
                padding: "10px 14px",
                fontSize: 13,
                color: "var(--fg3)",
              }}
            >
              Steve is thinking…
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {error && <div style={{ ...css.error, marginBottom: 8 }}>{error}</div>}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 0",
          borderTop: "1px solid var(--border)",
          alignItems: "flex-end",
        }}
      >
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          disabled={sending}
          rows={1}
          style={{
            ...css.input,
            flex: 1,
            resize: "none",
            minHeight: 40,
            maxHeight: 120,
            padding: "10px 14px",
            fontSize: 14,
            lineHeight: 1.4,
          }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = "auto";
            target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
          }}
        />
        <button
          type="button"
          style={{
            ...css.btnPrimary,
            padding: "10px 20px",
            opacity: !inputText.trim() || sending ? 0.5 : 1,
          }}
          onClick={handleSend}
          disabled={!inputText.trim() || sending}
        >
          Send
        </button>
      </div>
    </div>
  );
}
