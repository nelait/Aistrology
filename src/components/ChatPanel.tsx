import { useEffect, useRef, useState } from "react";
import { useLlm } from "../llm/LlmProvider";
import { useAuth } from "../auth/AuthProvider";
import { useAstroChat } from "../chat/AstroChat";
import { buildChatContext } from "../chat/context";
import { api, ChatMessage, ChatConversation } from "../api/client";
import type { Chart } from "../astro/types";

interface Props {
  chart: Chart | null;
  /** Id of the active saved chart, persisted with new conversations. */
  chartId?: string | null;
  /** Human label of the section the user is currently in (e.g. "Doshas"). */
  moduleLabel?: string;
}

const STARTERS = [
  "What are the strongest features of my chart?",
  "Explain my ascendant and what it says about me.",
  "Which planets are well or poorly placed?",
];

export default function ChatPanel({ chart, chartId, moduleLabel }: Props) {
  const { enabled } = useLlm();
  const { user, features } = useAuth();
  const { open, setOpen, seed, moduleContext } = useAstroChat();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaHit, setQuotaHit] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = () => api.listChatConversations().then(setConversations).catch(() => {});

  // Refresh the conversation list whenever the panel opens.
  useEffect(() => { if (open) loadConversations(); }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  // Switching profiles must start a clean slate — otherwise the old profile's
  // thread lingers and the next turn would append to the wrong conversation.
  useEffect(() => {
    setConversationId(null);
    setMessages([]);
    setInput("");
    setError(null);
    setQuotaHit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId]);

  // A module asked a seeded question → start a fresh thread and send it.
  useEffect(() => {
    if (!seed || !user || features?.chat === false || !enabled) return;
    setView("chat");
    setConversationId(null);
    void send(seed.prompt, [], null);
    // Only react to a new ask (nonce), not to unrelated state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  // Hidden unless the user is signed in, the feature is on, and an engine is active.
  if (!user) return null;
  if (features?.chat === false) return null;
  if (!enabled) return null;

  function newChat() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setQuotaHit(false);
    setView("chat");
  }

  async function openConversation(id: string) {
    try {
      const { conversation, messages: msgs } = await api.getChatConversation(id);
      setConversationId(conversation.id);
      setMessages(msgs);
      setError(null);
      setQuotaHit(false);
      setView("chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open conversation");
    }
  }

  async function removeConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.deleteChatConversation(id);
      setConversations((cs) => cs.filter((c) => c.id !== id));
      if (id === conversationId) newChat();
    } catch { /* ignore */ }
  }

  async function send(text: string, base: ChatMessage[] = messages, convId: string | null = conversationId) {
    const content = text.trim();
    if (!content || streaming) return;
    setError(null);
    setQuotaHit(false);
    const history: ChatMessage[] = [...base, { role: "user", content }];
    setMessages(history);
    setInput("");
    setStreaming(true);
    setMessages((m) => [...m, { role: "assistant", content: "" }]);

    const context = buildChatContext({ chart, moduleLabel, moduleFindings: moduleContext });

    let acc = "";
    let newId: string | undefined;
    try {
      await api.chatStream(
        { messages: history, context, conversationId: convId ?? undefined, chartId: chartId ?? undefined },
        {
          onMeta: (m) => { if (m.conversationId) { newId = m.conversationId; setConversationId(m.conversationId); } },
          onDelta: (t) => {
            acc += t;
            setMessages((m) => {
              const next = m.slice();
              next[next.length - 1] = { role: "assistant", content: acc };
              return next;
            });
          },
          onError: (msg) => {
            setError(msg);
            if (/limit reached/i.test(msg)) setQuotaHit(true);
            setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
          },
          onDone: (info) => { if (info.conversationId) newId = info.conversationId; },
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chat failed");
      setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
    } finally {
      setStreaming(false);
      if (newId) loadConversations(); // surface the (possibly new) conversation in history
    }
  }

  const paras = (s: string) => s.split(/\n\n+/).filter(Boolean);

  return (
    <div className="chat-widget">
      {open && (
        <div className="chat-window" role="dialog" aria-label="Astro Chat">
          <header className="chat-head">
            <div className="chat-head-title">
              <strong>✦ Astro Chat</strong>
              {view === "chat" && chart && <span className="muted small"> · {chart.birth.name}</span>}
            </div>
            <div className="chat-head-actions">
              <button className="chat-icon" title="New chat" onClick={newChat} aria-label="New chat">＋</button>
              <button
                className={`chat-icon ${view === "history" ? "on" : ""}`}
                title="History"
                onClick={() => setView((v) => (v === "history" ? "chat" : "history"))}
                aria-label="History"
              >🕘</button>
              <button className="chat-icon" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
          </header>

          {view === "history" ? (
            <div className="chat-body">
              {conversations.length === 0 ? (
                <p className="muted small">No saved conversations yet.</p>
              ) : (
                <div className="chat-conv-list">
                  {conversations.map((c) => (
                    <button key={c.id} className={`chat-conv ${c.id === conversationId ? "on" : ""}`} onClick={() => openConversation(c.id)}>
                      <span className="chat-conv-title">{c.title}</span>
                      <span className="chat-conv-meta">
                        <span className="muted small">{new Date(c.updatedAt).toLocaleDateString()}</span>
                        <span className="chat-conv-del" title="Delete" onClick={(e) => removeConversation(c.id, e)}>🗑</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="chat-body" ref={scrollRef}>
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <p className="muted small">
                    Ask about {chart ? "this chart" : "your chart"}
                    {moduleLabel ? ` or the ${moduleLabel} section` : ""}. AI-assisted — verify with a
                    qualified astrologer.
                  </p>
                  <div className="chat-starters">
                    {STARTERS.map((s) => (
                      <button key={s} className="chat-starter" onClick={() => send(s)} disabled={streaming}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m, i) => {
                  const ps = paras(m.content);
                  const isLast = i === messages.length - 1;
                  return (
                    <div key={i} className={`chat-msg chat-${m.role}`}>
                      {ps.map((p, j) => (
                        <p key={j}>
                          {p}
                          {streaming && m.role === "assistant" && isLast && j === ps.length - 1 && (
                            <span className="stream-cursor">▊</span>
                          )}
                        </p>
                      ))}
                      {streaming && m.role === "assistant" && isLast && m.content === "" && (
                        <p className="muted">Thinking…</p>
                      )}
                    </div>
                  );
                })
              )}
              {error && (
                <p className="error small">
                  {error}
                  {quotaHit && (user?.plan ?? "free") === "free" && " — see Plans & Billing to upgrade."}
                </p>
              )}
            </div>
          )}

          {view === "chat" && (
            <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={chart ? "Ask about this chart…" : "Ask about your chart…"}
                disabled={streaming}
              />
              <button className="primary" type="submit" disabled={streaming || !input.trim()}>
                {streaming ? "…" : "Send"}
              </button>
            </form>
          )}
        </div>
      )}

      <button
        className="chat-fab"
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close Astro Chat" : "Open Astro Chat"}
      >
        {open ? "✕" : "✦ Astro Chat"}
      </button>
    </div>
  );
}
