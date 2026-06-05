// Floating "?" help bubble + slide-in AI sidebar.
//
// Grounded in `docs/help/*.md` on the server. The model is instructed
// to refuse to answer anything outside the knowledge base, so it
// won't fabricate features. Conversation lives in component state
// only — no persistence, fresh thread when the user closes the panel.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { authFetch } from "../lib/authToken";

type Role = "user" | "assistant";

interface Msg {
  role: Role;
  content: string;
}

interface Suggestion {
  slug: string;
  title: string;
}

interface ChatResponse {
  content: string;
  sources?: Suggestion[];
}

const GREETING =
  "Hi — I'm the PulseEDU help assistant. Ask me how to do anything, or pick a suggestion below.";

export default function HelpAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [lastSources, setLastSources] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>(
    typeof window !== "undefined" ? window.location.pathname : "/",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Track route changes (the app uses pushState-style nav in places).
  useEffect(() => {
    const onChange = () => setCurrentPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    const id = window.setInterval(onChange, 1500);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.clearInterval(id);
    };
  }, []);

  // Pull page-aware suggestions when the panel opens or the route changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    authFetch(
      `/api/help-assistant/suggestions?path=${encodeURIComponent(currentPath)}`,
    )
      .then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((d: { suggestions?: Suggestion[] }) => {
        if (!cancelled) setSuggestions(d.suggestions ?? []);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentPath]);

  // Auto-scroll on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  // Auto-focus input when opened.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 120);
    return () => window.clearTimeout(t);
  }, [open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setError(null);
      const next: Msg[] = [...messages, { role: "user", content: trimmed }];
      setMessages(next);
      setInput("");
      setSending(true);
      try {
        const r = await authFetch("/api/help-assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next, currentPath }),
        });
        if (!r.ok) {
          throw new Error(`status ${r.status}`);
        }
        const data: ChatResponse = await r.json();
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.content || "(no response)" },
        ]);
        setLastSources(data.sources ?? []);
      } catch (e) {
        setError(
          "I couldn't reach the help service. Please try again in a moment.",
        );
      } finally {
        setSending(false);
      }
    },
    [messages, sending, currentPath],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const reset = () => {
    setMessages([]);
    setInput("");
    setLastSources([]);
    setError(null);
  };

  const greeting = useMemo(() => GREETING, []);

  return (
    <>
      {/* Floating "?" bubble */}
      <button
        type="button"
        aria-label={open ? "Close help" : "Open help"}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: 1200,
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: "none",
          background: open
            ? "#0f172a"
            : "linear-gradient(135deg,#7c3aed,#0d9488)",
          color: "#fff",
          fontSize: "1.5rem",
          fontWeight: 700,
          cursor: "pointer",
          boxShadow: "0 8px 24px rgba(15,23,42,0.35)",
          transition: "transform 0.15s ease",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseDown={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.94)";
        }}
        onMouseUp={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
        }}
      >
        {open ? "×" : "?"}
      </button>

      {/* Slide-in sidebar */}
      <div
        role="dialog"
        aria-label="PulseEDU help assistant"
        aria-hidden={!open}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(420px, 100vw)",
          zIndex: 1190,
          background: "#fff",
          boxShadow: "-12px 0 32px rgba(15,23,42,0.18)",
          transform: open ? "translateX(0)" : "translateX(105%)",
          transition: "transform 0.28s cubic-bezier(0.2,0.8,0.2,1)",
          display: "flex",
          flexDirection: "column",
          fontFamily: "inherit",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1rem 1.1rem 0.9rem",
            background: "linear-gradient(135deg,#7c3aed,#0d9488)",
            color: "#fff",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: "1rem" }}>
                Help Assistant
              </div>
              <div style={{ fontSize: "0.78rem", opacity: 0.85, marginTop: 2 }}>
                Ask me anything about PulseEDU
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={reset}
                  style={{
                    background: "rgba(255,255,255,0.15)",
                    border: "none",
                    color: "#fff",
                    padding: "0.3rem 0.6rem",
                    borderRadius: 6,
                    fontSize: "0.75rem",
                    cursor: "pointer",
                  }}
                >
                  New chat
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  background: "rgba(255,255,255,0.15)",
                  border: "none",
                  color: "#fff",
                  width: 30,
                  height: 30,
                  borderRadius: 6,
                  fontSize: "1.1rem",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
          </div>
        </div>

        {/* Scroll area */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "1rem 1.1rem 0.5rem",
            background: "#f8fafc",
          }}
        >
          {messages.length === 0 && (
            <div>
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  borderRadius: 12,
                  padding: "0.85rem 0.95rem",
                  fontSize: "0.88rem",
                  color: "#0f172a",
                  lineHeight: 1.45,
                }}
              >
                {greeting}
              </div>
              {suggestions.length > 0 && (
                <div style={{ marginTop: "1rem" }}>
                  <div
                    style={{
                      fontSize: "0.72rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "#64748b",
                      marginBottom: "0.5rem",
                      fontWeight: 600,
                    }}
                  >
                    For this page
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.4rem",
                    }}
                  >
                    {suggestions.map((s) => (
                      <button
                        key={s.slug}
                        type="button"
                        onClick={() => send(`Walk me through: ${s.title}`)}
                        style={{
                          textAlign: "left",
                          background: "#fff",
                          border: "1px solid #e2e8f0",
                          borderRadius: 10,
                          padding: "0.6rem 0.75rem",
                          cursor: "pointer",
                          fontSize: "0.84rem",
                          color: "#0f172a",
                        }}
                      >
                        {s.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                marginBottom: "0.7rem",
                display: "flex",
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  maxWidth: "88%",
                  background: m.role === "user" ? "#7c3aed" : "#fff",
                  color: m.role === "user" ? "#fff" : "#0f172a",
                  border:
                    m.role === "user" ? "none" : "1px solid #e2e8f0",
                  borderRadius: 12,
                  padding: "0.7rem 0.85rem",
                  fontSize: "0.87rem",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {renderMarkdownLite(m.content)}
              </div>
            </div>
          ))}

          {sending && (
            <div
              style={{
                display: "flex",
                gap: 4,
                padding: "0.5rem 0.85rem",
                color: "#64748b",
                fontSize: "0.82rem",
              }}
            >
              <span>Thinking</span>
              <span className="hap-dots" aria-hidden>
                …
              </span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                marginTop: "0.5rem",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#991b1b",
                padding: "0.6rem 0.75rem",
                borderRadius: 8,
                fontSize: "0.82rem",
              }}
            >
              {error}
            </div>
          )}

          {!sending && lastSources.length > 0 && messages.length > 0 && (
            <div
              style={{
                marginTop: "0.4rem",
                fontSize: "0.7rem",
                color: "#94a3b8",
              }}
            >
              Based on:{" "}
              {lastSources.map((s, i) => (
                <span key={s.slug}>
                  {i > 0 && ", "}
                  {s.title}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={onSubmit}
          style={{
            borderTop: "1px solid #e2e8f0",
            padding: "0.7rem 0.75rem",
            background: "#fff",
            display: "flex",
            gap: "0.5rem",
            alignItems: "flex-end",
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask how to do something…"
            rows={1}
            style={{
              flex: 1,
              resize: "none",
              maxHeight: 120,
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              padding: "0.55rem 0.65rem",
              fontSize: "0.88rem",
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            style={{
              background:
                !input.trim() || sending
                  ? "#cbd5e1"
                  : "linear-gradient(135deg,#7c3aed,#0d9488)",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0.55rem 0.85rem",
              fontWeight: 600,
              fontSize: "0.85rem",
              cursor: !input.trim() || sending ? "not-allowed" : "pointer",
            }}
          >
            Send
          </button>
        </form>
      </div>
    </>
  );
}

/**
 * Tiny markdown renderer — bold, headings, ordered/unordered lists,
 * inline code, line breaks. Avoids pulling in a full markdown lib for
 * a help sidebar.
 */
function renderMarkdownLite(text: string): React.ReactNode {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let listBuf: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => {
    if (!listBuf) return;
    const Tag = listBuf.ordered ? "ol" : "ul";
    out.push(
      <Tag
        key={`l-${out.length}`}
        style={{
          margin: "0.4rem 0 0.4rem 1.1rem",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.25rem",
        }}
      >
        {listBuf.items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </Tag>,
    );
    listBuf = null;
  };

  for (const raw of lines) {
    const line = raw;
    const oMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
    const uMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (oMatch) {
      if (!listBuf || !listBuf.ordered) {
        flushList();
        listBuf = { ordered: true, items: [] };
      }
      listBuf.items.push(oMatch[2]);
      continue;
    }
    if (uMatch) {
      if (!listBuf || listBuf.ordered) {
        flushList();
        listBuf = { ordered: false, items: [] };
      }
      listBuf.items.push(uMatch[1]);
      continue;
    }
    flushList();
    const hMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const Tag = (`h${Math.min(level + 2, 6)}` as unknown) as
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      out.push(
        <Tag
          key={`h-${out.length}`}
          style={{
            margin: "0.6rem 0 0.3rem",
            fontSize: level === 1 ? "0.98rem" : "0.9rem",
            fontWeight: 700,
          }}
        >
          {inline(hMatch[2])}
        </Tag>,
      );
      continue;
    }
    if (line.trim() === "") {
      out.push(<div key={`s-${out.length}`} style={{ height: "0.4rem" }} />);
      continue;
    }
    out.push(
      <p
        key={`p-${out.length}`}
        style={{ margin: "0.25rem 0" }}
      >
        {inline(line)}
      </p>,
    );
  }
  flushList();
  return out;
}

function inline(s: string): React.ReactNode {
  // Bold **text** and inline `code`.
  const parts: React.ReactNode[] = [];
  let i = 0;
  let buf = "";
  const flushBuf = () => {
    if (buf) {
      parts.push(buf);
      buf = "";
    }
  };
  while (i < s.length) {
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end !== -1) {
        flushBuf();
        parts.push(<strong key={parts.length}>{s.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end !== -1) {
        flushBuf();
        parts.push(
          <code
            key={parts.length}
            style={{
              background: "rgba(124,58,237,0.1)",
              padding: "0 0.2rem",
              borderRadius: 3,
              fontSize: "0.85em",
            }}
          >
            {s.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  flushBuf();
  return parts;
}
