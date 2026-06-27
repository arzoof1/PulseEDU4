// StudentPicker — the ONE shared student/staff search box for the staff app.
//
// Standardizes every picker to the look, feel, and keyboard behavior of the
// Family Communication search (the original inline StudentCombobox): a styled
// <input> + an absolute <ul role="listbox">, ↑/↓/Enter/Esc keyboard nav, a
// clear (×) button, and rows formatted "Name · localSisId · Grade".
//
// Two data modes:
//   - mode="local": filters an in-memory `items` array. Ranking is
//     starts-with before includes (matches the Hall-Pass CreatePassModal),
//     then last/first name. The selected item's label is shown in the input.
//   - mode="async": calls a debounced `fetcher(q)` (default 220ms) with
//     loading / empty / error states. Clears the input on select so the box
//     is ready for the next search (the caller renders the chosen record).
//
// The component is generic over the row type `T`; callers supply accessors
// (getKey / getPrimary / renderMeta) so each screen keeps its own data shape
// and result set. The component NEVER renders a raw studentId — callers wire
// `localSisId ?? "—"` through getPrimary / renderMeta per the FLEID rule.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

interface BaseProps<T> {
  /** Stable unique id for an item — React key + the value emitted on select. */
  getKey: (item: T) => string;
  /** Bold primary label, e.g. `${firstName} ${lastName}`. */
  getPrimary: (item: T) => string;
  /** Muted per-row meta (e.g. "· localSisId · Gr 7"). Omit for no meta. */
  renderMeta?: (item: T) => ReactNode;
  /** Called with the full selected item. */
  onSelect: (item: T) => void;
  /** Called when the box is cleared (× button or input emptied). */
  onClear?: () => void;
  /** Text shown in the input after a selection; defaults to getPrimary. */
  getInputLabel?: (item: T) => string;
  placeholder?: string;
  minWidth?: number | string;
  autoFocus?: boolean;
  /** Show the × clear affordance. Default true. */
  clearable?: boolean;
  /** Message when a non-empty query has zero matches. */
  emptyText?: string;
  /** Wrapper style overrides. */
  style?: CSSProperties;
  /** Input style overrides (merged after the shared base). */
  inputStyle?: CSSProperties;
  ariaLabel?: string;
}

interface LocalProps<T> extends BaseProps<T> {
  mode: "local";
  items: T[];
  /** Currently-selected key — shows that item's label in the input. */
  selectedKey?: string;
  /** Extra ranking/filter haystack; defaults to getPrimary text. */
  getSearchText?: (item: T) => string;
  /** Custom ranking. Return -1 to exclude; lower ranks sort first. */
  rank?: (query: string, item: T) => number;
  /** Cap on rendered matches. Default 50; pass Infinity for unlimited. */
  maxResults?: number;
}

interface AsyncProps<T> extends BaseProps<T> {
  mode: "async";
  fetcher: (q: string) => Promise<T[]>;
  /** Debounce before firing the fetch. Default 220ms. */
  debounceMs?: number;
  /** Minimum trimmed chars before fetching. Default 1. */
  minChars?: number;
  loadingText?: string;
}

type Props<T> = LocalProps<T> | AsyncProps<T>;

const listboxStyle: CSSProperties = {
  position: "absolute",
  zIndex: 50,
  top: "calc(100% + 2px)",
  left: 0,
  right: 0,
  margin: 0,
  padding: "0.25rem 0",
  listStyle: "none",
  background: "#fff",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  boxShadow: "0 6px 18px rgba(15,23,42,0.12)",
  maxHeight: 280,
  overflowY: "auto",
};

const noticeStyle: CSSProperties = {
  position: "absolute",
  zIndex: 50,
  top: "calc(100% + 2px)",
  left: 0,
  right: 0,
  background: "#fff",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  padding: "0.5rem 0.6rem",
  color: "#64748b",
  fontSize: "0.9rem",
};

export default function StudentPicker<T>(props: Props<T>) {
  const {
    getKey,
    getPrimary,
    renderMeta,
    onSelect,
    onClear,
    getInputLabel,
    placeholder = "Type name or ID…",
    minWidth = 280,
    autoFocus,
    clearable = true,
    emptyText = "No matches.",
    style,
    inputStyle,
    ariaLabel,
  } = props;

  const labelOf = (item: T) =>
    getInputLabel ? getInputLabel(item) : getPrimary(item);

  // In local mode with a controlled selection, seed the query to its label.
  const seededLabel =
    props.mode === "local" && props.selectedKey
      ? (() => {
          const sel = props.items.find(
            (it) => getKey(it) === props.selectedKey,
          );
          return sel ? labelOf(sel) : "";
        })()
      : "";

  const [query, setQuery] = useState(seededLabel);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Async results state (unused in local mode).
  const [asyncItems, setAsyncItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const reqSeq = useRef(0);

  // Keep the input synced to the controlled selection in local mode.
  const selectedKey = props.mode === "local" ? props.selectedKey : undefined;
  const localItems = props.mode === "local" ? props.items : undefined;
  useEffect(() => {
    if (props.mode !== "local") return;
    const sel = props.selectedKey
      ? props.items.find((it) => getKey(it) === props.selectedKey)
      : undefined;
    setQuery(sel ? labelOf(sel) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, localItems]);

  // Close the listbox on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Debounced async fetch.
  const asyncFetcher = props.mode === "async" ? props.fetcher : undefined;
  const debounceMs = props.mode === "async" ? (props.debounceMs ?? 220) : 0;
  const minChars = props.mode === "async" ? (props.minChars ?? 1) : 1;
  useEffect(() => {
    if (props.mode !== "async") return;
    const q = query.trim();
    if (q.length < minChars) {
      setAsyncItems([]);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++reqSeq.current;
    const handle = window.setTimeout(async () => {
      try {
        const rows = await asyncFetcher!(q);
        if (reqSeq.current !== seq) return; // stale
        setAsyncItems(rows);
        setError("");
      } catch (e) {
        if (reqSeq.current !== seq) return;
        setError(e instanceof Error ? e.message : "Search failed");
        setAsyncItems([]);
      } finally {
        if (reqSeq.current === seq) setLoading(false);
      }
    }, debounceMs);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, props.mode, debounceMs, minChars]);

  // Compute the visible matches.
  const matches = useMemo(() => {
    if (props.mode === "async") return asyncItems;
    const q = query.trim().toLowerCase();
    const items = props.items;
    if (!q) return items.slice(0, props.maxResults ?? 50);
    const searchText =
      props.getSearchText ?? ((it: T) => getPrimary(it));
    const rankFn =
      props.rank ??
      ((qq: string, it: T) => {
        // Default ranking mirrors CreatePassModal: starts-with the query on
        // any whitespace-delimited token wins (rank 0), otherwise a substring
        // hit (rank 1). -1 excludes.
        const hay = searchText(it).toLowerCase();
        if (!hay.includes(qq)) return -1;
        const tokens = hay.split(/\s+/);
        if (hay.startsWith(qq) || tokens.some((t) => t.startsWith(qq)))
          return 0;
        return 1;
      });
    const scored: Array<{ it: T; rank: number }> = [];
    for (const it of items) {
      const r = rankFn(q, it);
      if (r >= 0) scored.push({ it, rank: r });
    }
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return getPrimary(a.it).localeCompare(getPrimary(b.it));
    });
    return scored.map((s) => s.it).slice(0, props.maxResults ?? 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode, asyncItems, query, localItems]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  const commit = (item: T) => {
    onSelect(item);
    if (props.mode === "async") {
      // Clear so the box is ready for the next search; the caller renders
      // the chosen record in its own UI.
      reqSeq.current++;
      setQuery("");
      setAsyncItems([]);
      setError("");
    } else {
      setQuery(labelOf(item));
    }
    setOpen(false);
  };

  const clear = () => {
    reqSeq.current++;
    setQuery("");
    setAsyncItems([]);
    setError("");
    setOpen(false);
    onClear?.();
  };

  const q = query.trim();
  const showEmpty =
    open &&
    !loading &&
    !error &&
    matches.length === 0 &&
    (props.mode === "async" ? q.length >= minChars : q.length > 0);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        display: "inline-block",
        minWidth,
        ...style,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        onFocus={() => {
          setOpen(true);
          setHighlight(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
          if (e.target.value.trim() === "") onClear?.();
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            setOpen(true);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            if (open && matches[highlight]) {
              e.preventDefault();
              commit(matches[highlight]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        style={{ width: "100%", padding: "0.4rem 0.55rem", ...inputStyle }}
      />
      {clearable && query !== "" && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear"
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            background: "transparent",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            fontSize: "1.1rem",
            lineHeight: 1,
            padding: "0 0.25rem",
          }}
        >
          ×
        </button>
      )}
      {open && loading && (
        <div style={noticeStyle}>
          {props.mode === "async" ? props.loadingText ?? "Searching…" : "…"}
        </div>
      )}
      {open && !loading && error && (
        <div style={{ ...noticeStyle, color: "#b91c1c" }}>{error}</div>
      )}
      {open && !loading && !error && matches.length > 0 && (
        <ul role="listbox" style={listboxStyle}>
          {matches.map((item, i) => (
            <li
              key={getKey(item)}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(item);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: "0.4rem 0.6rem",
                cursor: "pointer",
                background: i === highlight ? "#e0f2fe" : "transparent",
                fontSize: "0.92rem",
              }}
            >
              <strong>{getPrimary(item)}</strong>
              {renderMeta ? (
                <span style={{ color: "#64748b" }}> {renderMeta(item)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {showEmpty && <div style={noticeStyle}>{emptyText}</div>}
    </div>
  );
}
