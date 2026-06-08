import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { fetchStudentsPage } from "../../lib/students";
import VoiceTextarea from "./VoiceTextarea";

// MentionTextarea — wraps VoiceTextarea (so dictation still works) and
// adds two ways to tag a student inline:
//
//   1. Type `@` anywhere in the body → a small picker pops up under the
//      caret. Type to search, click to insert.
//   2. Click the "+ Tag student" button next to the mic — same picker,
//      pinned to the button. This is the path a dictating admin uses,
//      since they don't want to stop and type `@`.
//
// Inserted token format (parsed identically on the server):
//   @[Display Name|STUDENTID]
//
// The textarea shows the raw token so dictation/cursor behaviour stays
// boringly predictable. Below the textarea, a "Tagged" pill row gives
// the admin a clean, tappable summary with one-click remove.

interface StudentHit {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  grade?: number | null;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  brandColor?: string;
  disabled?: boolean;
}

const MENTION_RE = /@\[([^|\]]+)\|([A-Za-z0-9_-]+)\]/g;

export interface ParsedMention {
  studentId: string;
  displayName: string;
  start: number;
  end: number;
  raw: string;
}

export function parseMentions(body: string): ParsedMention[] {
  if (!body) return [];
  const out: ParsedMention[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const display = (m[1] ?? "").trim();
    const sid = (m[2] ?? "").trim();
    if (!display || !sid) continue;
    out.push({
      displayName: display,
      studentId: sid,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      raw: m[0],
    });
  }
  return out;
}

function buildToken(displayName: string, studentId: string): string {
  // Sanitise — `|` and `]` would break the parse contract.
  const safeName = displayName.replace(/[|\]]/g, " ").trim();
  const safeId = studentId.replace(/[^A-Za-z0-9_-]/g, "");
  return `@[${safeName}|${safeId}]`;
}

export default function MentionTextarea({
  value,
  onChange,
  rows = 3,
  placeholder,
  className,
  style,
  brandColor = "#7A1F2B",
  disabled,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // When the picker is open via `@` trigger, we remember the @ position
  // so we can replace `@<typed-query>` with the chip on select. When it's
  // open via the "+ Tag student" button, atTriggerStart is null and we
  // insert at the current caret instead.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [atTriggerStart, setAtTriggerStart] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searching, setSearching] = useState(false);
  const queryInputRef = useRef<HTMLInputElement | null>(null);

  // Bind the textarea ref out of VoiceTextarea by querying our wrapper —
  // VoiceTextarea doesn't forward refs, so we grab the rendered <textarea>
  // ourselves. Stable across re-renders.
  useEffect(() => {
    const t = wrapperRef.current?.querySelector("textarea");
    textareaRef.current = (t as HTMLTextAreaElement | null) ?? null;
  });

  const mentions = useMemo(() => parseMentions(value), [value]);

  // Search /api/students with the typeahead. Debounced lightly to avoid
  // hammering the endpoint as the admin types fast.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const page = await fetchStudentsPage<StudentHit>({
          q: query.trim() || undefined,
          limit: 12,
        });
        if (!cancelled) setHits(page.items);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [pickerOpen, query]);

  function openButtonPicker() {
    if (disabled) return;
    setAtTriggerStart(null);
    setQuery("");
    setHits([]);
    setPickerOpen(true);
    setTimeout(() => queryInputRef.current?.focus(), 0);
  }

  function closePicker() {
    setPickerOpen(false);
    setAtTriggerStart(null);
    setQuery("");
  }

  // Watch the value for a freshly-typed `@` and pop the picker. We use
  // the textarea's current selectionStart to figure out where the `@`
  // landed, then track whatever the admin types after it as the query
  // until they hit space, escape, or select something.
  function onChangeBody(next: string) {
    onChange(next);
    if (disabled) return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? next.length;
    if (pickerOpen && atTriggerStart != null) {
      // Track the post-@ query until the user clears it.
      if (caret < atTriggerStart || next[atTriggerStart] !== "@") {
        closePicker();
        return;
      }
      setQuery(next.slice(atTriggerStart + 1, caret));
      return;
    }
    // Detect a brand new `@` typed at the caret.
    if (caret > 0 && next[caret - 1] === "@") {
      const prev = caret >= 2 ? next[caret - 2] : "";
      // Only treat as a trigger if `@` is at the start, or after
      // whitespace/punctuation — avoids firing inside email-style text.
      if (!prev || /\s|[.,;:!?(\[]/.test(prev)) {
        setAtTriggerStart(caret - 1);
        setQuery("");
        setHits([]);
        setPickerOpen(true);
      }
    }
  }

  function insertMention(hit: StudentHit) {
    const display =
      `${hit.firstName ?? ""} ${hit.lastName ?? ""}`.trim() || hit.studentId;
    const token = buildToken(display, hit.studentId);
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? value.length;
    let next: string;
    let insertAt: number;
    if (atTriggerStart != null) {
      // Replace `@<query>` (from atTriggerStart to caret) with the token
      // followed by a space — keeps the next dictated word from glueing
      // onto the chip.
      next = value.slice(0, atTriggerStart) + token + " " + value.slice(caret);
      insertAt = atTriggerStart + token.length + 1;
    } else {
      // Button-driven insert at current caret. Pad with surrounding
      // spaces if the neighbours aren't whitespace already, so the chip
      // reads cleanly mid-sentence.
      const before = value.slice(0, caret);
      const after = value.slice(caret);
      const padBefore = before && !/\s$/.test(before) ? " " : "";
      const padAfter = after && !/^\s/.test(after) ? " " : "";
      next = before + padBefore + token + padAfter + after;
      insertAt = (before + padBefore + token + padAfter).length;
    }
    onChange(next);
    closePicker();
    // Re-focus the textarea and place the caret right after the chip.
    setTimeout(() => {
      const t = textareaRef.current;
      if (t) {
        t.focus();
        try {
          t.setSelectionRange(insertAt, insertAt);
        } catch {
          /* noop */
        }
      }
    }, 0);
  }

  function removeMention(m: ParsedMention) {
    // Trim a single trailing space if present so the body doesn't grow
    // double spaces over time.
    const after = value.slice(m.end);
    const drop = after.startsWith(" ") ? 1 : 0;
    const next = value.slice(0, m.start) + value.slice(m.end + drop);
    onChange(next);
  }

  // Click-outside to close picker.
  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) closePicker();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <VoiceTextarea
        value={value}
        onChange={onChangeBody}
        rows={rows}
        placeholder={placeholder}
        className={className}
        style={style}
        brandColor={brandColor}
        disabled={disabled}
      />
      <div
        style={{
          marginTop: 4,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <button
          type="button"
          onClick={openButtonPicker}
          disabled={disabled}
          title="Insert a tagged student name (or type @ inline)"
          style={{
            background: "#FFFFFF",
            color: brandColor,
            border: `1px solid ${brandColor}`,
            borderRadius: 999,
            padding: "2px 8px",
            fontSize: 11,
            fontWeight: 600,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          + Tag student
        </button>
        {mentions.length > 0 && (
          <span style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>
            Tagged:
          </span>
        )}
        {mentions.map((m, i) => (
          <span
            key={`${m.studentId}-${i}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "#EEF2FF",
              color: "#3730A3",
              border: "1px solid #C7D2FE",
              borderRadius: 999,
              padding: "1px 8px",
              fontSize: 11,
              fontWeight: 600,
            }}
            title={`Student ID ${m.studentId}`}
          >
            @{m.displayName}
            <button
              type="button"
              onClick={() => removeMention(m)}
              aria-label={`Remove ${m.displayName} tag`}
              style={{
                background: "transparent",
                border: "none",
                color: "#3730A3",
                cursor: "pointer",
                padding: 0,
                fontSize: 13,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {pickerOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            zIndex: 50,
            background: "#FFFFFF",
            border: "1px solid #CBD5E1",
            borderRadius: 8,
            boxShadow: "0 6px 18px rgba(0,0,0,0.15)",
            padding: 8,
            maxWidth: 360,
          }}
        >
          <input
            ref={queryInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closePicker();
                textareaRef.current?.focus();
              } else if (e.key === "Enter" && hits[0]) {
                e.preventDefault();
                insertMention(hits[0]);
              }
            }}
            placeholder="Type a student's first or last name…"
            style={{
              width: "100%",
              padding: "4px 8px",
              fontSize: 12,
              border: "1px solid #CBD5E1",
              borderRadius: 6,
              marginBottom: 6,
            }}
          />
          <div
            style={{
              maxHeight: 200,
              overflowY: "auto",
              fontSize: 12,
            }}
          >
            {searching && hits.length === 0 ? (
              <div style={{ padding: "6px 8px", color: "#64748b" }}>
                Searching…
              </div>
            ) : hits.length === 0 ? (
              <div style={{ padding: "6px 8px", color: "#64748b" }}>
                {query.trim()
                  ? "No matches."
                  : "Start typing a name."}
              </div>
            ) : (
              hits.map((h) => {
                const display =
                  `${h.firstName ?? ""} ${h.lastName ?? ""}`.trim() ||
                  h.studentId;
                return (
                  <button
                    key={h.studentId}
                    type="button"
                    onClick={() => insertMention(h)}
                    style={{
                      display: "flex",
                      width: "100%",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "4px 8px",
                      background: "transparent",
                      border: "none",
                      borderRadius: 4,
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#F1F5F9";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span>{display}</span>
                    <span style={{ color: "#64748b", fontSize: 10 }}>
                      #{h.studentId}
                      {h.grade != null ? ` · Gr ${h.grade}` : ""}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
