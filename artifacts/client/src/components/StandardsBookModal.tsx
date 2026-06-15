// ELA BEST Standards — in-app searchable / browsable reference of the full
// FLDOE B.E.S.T. ELA standards book. Opened from the Teacher Instruction Log.
//
// Two views:
//  - Browse: filter the benchmark index by grade + strand, click a standard to
//    read its full page text (statement, sub-skills, and clarification notes).
//  - Search: full-text search across every page of the book; results show a
//    snippet with the match highlighted; click to read the full page.
//
// The whole book (~1.2MB) is fetched once on first open and cached for the
// lifetime of the page; all searching/filtering happens in-memory.
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { authFetch } from "../lib/authToken";

interface BenchmarkEntry {
  code: string;
  grade: string;
  strand: string | null;
  statement: string;
  page: number | null;
}

interface PageEntry {
  page: number;
  text: string;
}

interface StandardsBook {
  subject: string;
  title: string;
  fileName: string;
  pageCount: number;
  pages: PageEntry[];
  benchmarks: BenchmarkEntry[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const STRAND_LABELS: Record<string, string> = {
  F: "Foundational Skills",
  R: "Reading",
  C: "Communication",
  V: "Vocabulary",
};

function gradeRank(g: string): number {
  const s = g.toUpperCase();
  if (s === "K") return -1;
  const n = Number(s);
  return Number.isFinite(n) ? n : 1000 + (Number(s.replace(/\D/g, "")) || 0);
}

function gradeLabel(g: string): string {
  const s = g.toUpperCase();
  if (s === "K") return "K";
  if (/^\d+$/.test(s)) return `Grade ${s}`;
  return `Grades ${s}`;
}

// Module-level cache so reopening the modal doesn't refetch the 1.2MB body.
let bookCache: StandardsBook | null = null;

export default function StandardsBookModal({ open, onClose }: Props) {
  const [book, setBook] = useState<StandardsBook | null>(bookCache);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [mode, setMode] = useState<"browse" | "search">("browse");
  const [query, setQuery] = useState("");
  const [gradeFilter, setGradeFilter] = useState<string>("");
  const [strandFilter, setStrandFilter] = useState<string>("");
  // Page currently open in the reader pane (null = list view).
  const [openPage, setOpenPage] = useState<number | null>(null);
  // Term to highlight in the reader pane (a code or the search query).
  const [highlight, setHighlight] = useState<string>("");

  const load = useCallback(async () => {
    if (bookCache) {
      setBook(bookCache);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await authFetch("/api/standards-book?subject=ela");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const json = (await res.json()) as StandardsBook;
      bookCache = json;
      setBook(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (openPage != null) setOpenPage(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openPage, onClose]);

  const grades = useMemo(() => {
    if (!book) return [];
    const set = new Set<string>();
    for (const b of book.benchmarks) set.add(b.grade.toUpperCase());
    return Array.from(set).sort((a, b) => gradeRank(a) - gradeRank(b));
  }, [book]);

  const strands = useMemo(() => {
    if (!book) return [];
    const set = new Set<string>();
    for (const b of book.benchmarks) if (b.strand) set.add(b.strand.toUpperCase());
    return Array.from(set).sort();
  }, [book]);

  const browseResults = useMemo(() => {
    if (!book) return [];
    const q = query.trim().toLowerCase();
    return book.benchmarks
      .filter((b) => {
        if (gradeFilter && b.grade.toUpperCase() !== gradeFilter) return false;
        if (strandFilter && (b.strand ?? "").toUpperCase() !== strandFilter)
          return false;
        if (q) {
          return (
            b.code.toLowerCase().includes(q) ||
            b.statement.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [book, query, gradeFilter, strandFilter]);

  const searchResults = useMemo(() => {
    if (!book) return [];
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: Array<{ page: number; snippet: string }> = [];
    for (const p of book.pages) {
      const lower = p.text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 80);
      const end = Math.min(p.text.length, idx + q.length + 160);
      let snippet = p.text.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snippet = "… " + snippet;
      if (end < p.text.length) snippet = snippet + " …";
      out.push({ page: p.page, snippet });
      if (out.length >= 200) break;
    }
    return out;
  }, [book, query]);

  const pageText = useMemo(() => {
    if (!book || openPage == null) return "";
    return book.pages.find((p) => p.page === openPage)?.text ?? "";
  }, [book, openPage]);

  if (!open) return null;

  const openReader = (page: number | null, term: string) => {
    if (page == null) return;
    setHighlight(term);
    setOpenPage(page);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 10,
          width: "min(960px, 100%)",
          height: "min(86vh, 900px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid #e5e7eb",
            background: "#1e3a8a",
            color: "white",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              ELA B.E.S.T. Standards
            </div>
            <div style={{ fontSize: 11, opacity: 0.8 }}>
              {book
                ? `${book.title} · ${book.pageCount} pages`
                : "Florida ELA standards reference"}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "rgba(255,255,255,0.15)",
              color: "white",
              border: "none",
              borderRadius: 6,
              width: 30,
              height: 30,
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Toolbar */}
        {openPage == null && (
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              padding: "10px 16px",
              borderBottom: "1px solid #f1f5f9",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden", border: "1px solid #cbd5e1" }}>
              {(["browse", "search"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    padding: "5px 14px",
                    fontSize: 13,
                    border: "none",
                    cursor: "pointer",
                    background: mode === m ? "#1e3a8a" : "white",
                    color: mode === m ? "white" : "#334155",
                    fontWeight: mode === m ? 600 : 400,
                  }}
                >
                  {m === "browse" ? "Browse standards" : "Search the book"}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                mode === "browse"
                  ? "Filter by code or keyword…"
                  : "Search all 220 pages…"
              }
              style={{
                flex: 1,
                minWidth: 200,
                padding: "6px 10px",
                fontSize: 13,
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
            />
            {mode === "browse" && (
              <>
                <select
                  value={gradeFilter}
                  onChange={(e) => setGradeFilter(e.target.value)}
                  style={{ padding: "6px", fontSize: 13, borderRadius: 6, border: "1px solid #cbd5e1" }}
                >
                  <option value="">All grades</option>
                  {grades.map((g) => (
                    <option key={g} value={g}>
                      {gradeLabel(g)}
                    </option>
                  ))}
                </select>
                <select
                  value={strandFilter}
                  onChange={(e) => setStrandFilter(e.target.value)}
                  style={{ padding: "6px", fontSize: 13, borderRadius: 6, border: "1px solid #cbd5e1" }}
                >
                  <option value="">All strands</option>
                  {strands.map((s) => (
                    <option key={s} value={s}>
                      {STRAND_LABELS[s] ?? s}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {loading && (
            <div style={{ color: "#6b7280", fontSize: 13 }}>Loading the book…</div>
          )}
          {err && (
            <div style={{ color: "#b91c1c", fontSize: 13 }}>
              {err}{" "}
              <button onClick={() => void load()} style={{ marginLeft: 8 }}>
                Retry
              </button>
            </div>
          )}

          {/* Reader pane */}
          {!loading && !err && openPage != null && (
            <div>
              <button
                onClick={() => setOpenPage(null)}
                style={{
                  marginBottom: 12,
                  padding: "4px 10px",
                  fontSize: 12,
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  background: "white",
                  cursor: "pointer",
                }}
              >
                ← Back to {mode === "browse" ? "standards" : "results"}
              </button>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
                Page {openPage} of {book?.pageCount}
              </div>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 13.5,
                  lineHeight: 1.55,
                  color: "#1f2937",
                  fontFamily:
                    "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
                }}
              >
                <Highlighted text={pageText} term={highlight} />
              </div>
            </div>
          )}

          {/* Browse list */}
          {!loading && !err && openPage == null && mode === "browse" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
                {browseResults.length} standard
                {browseResults.length === 1 ? "" : "s"}
              </div>
              {browseResults.map((b) => (
                <button
                  key={b.code}
                  onClick={() => openReader(b.page, b.code)}
                  style={{
                    textAlign: "left",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    padding: "8px 12px",
                    background: "white",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      marginBottom: 2,
                    }}
                  >
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "#1e3a8a", fontWeight: 700 }}>
                      {b.code}
                    </span>
                    {b.strand && (
                      <span style={{ fontSize: 10, color: "#475569", background: "#f1f5f9", borderRadius: 4, padding: "1px 6px" }}>
                        {STRAND_LABELS[b.strand.toUpperCase()] ?? b.strand}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "#374151" }}>
                    {b.statement}
                  </div>
                </button>
              ))}
              {browseResults.length === 0 && (
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  No standards match those filters.
                </div>
              )}
            </div>
          )}

          {/* Search list */}
          {!loading && !err && openPage == null && mode === "search" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {query.trim().length < 2 ? (
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  Type at least 2 characters to search the full book.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
                    {searchResults.length} page
                    {searchResults.length === 1 ? "" : "s"} match “{query.trim()}”
                  </div>
                  {searchResults.map((r) => (
                    <button
                      key={r.page}
                      onClick={() => openReader(r.page, query.trim())}
                      style={{
                        textAlign: "left",
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        padding: "8px 12px",
                        background: "white",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontSize: 11, color: "#1e3a8a", fontWeight: 700, marginBottom: 2 }}>
                        Page {r.page}
                      </div>
                      <div style={{ fontSize: 12.5, color: "#374151" }}>
                        <Highlighted text={r.snippet} term={query.trim()} />
                      </div>
                    </button>
                  ))}
                  {searchResults.length === 0 && (
                    <div style={{ fontSize: 13, color: "#6b7280" }}>
                      No pages contain “{query.trim()}”.
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Case-insensitive highlight of every occurrence of `term` in `text`.
function Highlighted({ text, term }: { text: string; term: string }) {
  const t = term.trim();
  if (!t) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = t.toLowerCase();
  const out: Array<string | ReactElement> = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={k++} style={{ background: "#fde68a", padding: "0 1px", borderRadius: 2 }}>
        {text.slice(idx, idx + t.length)}
      </mark>,
    );
    i = idx + t.length;
  }
  return <>{out}</>;
}
