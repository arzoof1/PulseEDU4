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
  useRef,
  useState,
  type ReactElement,
} from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mathPdfUrl from "../assets/standards/mathbeststandards.pdf?url";
import elaPdfUrl from "../assets/standards/elabeststandardsfinal.pdf?url";
import { authFetch } from "../lib/authToken";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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

type Subject = "ela" | "math";

interface Props {
  open: boolean;
  onClose: () => void;
  subject?: Subject;
}

const STRAND_LABELS: Record<Subject, Record<string, string>> = {
  ela: {
    F: "Foundational Skills",
    R: "Reading",
    C: "Communication",
    V: "Vocabulary",
  },
  math: {
    NSO: "Number Sense & Operations",
    FR: "Fractions",
    AR: "Algebraic Reasoning",
    M: "Measurement",
    GR: "Geometric Reasoning",
    DP: "Data Analysis & Probability",
    F: "Functions",
    C: "Calculus",
    T: "Trigonometry",
    LT: "Logic & Discrete Theory",
    FL: "Financial Literacy",
    MTR: "Mathematical Thinking & Reasoning",
  },
};

const SUBJECT_META: Record<Subject, { heading: string; sub: string }> = {
  ela: {
    heading: "ELA B.E.S.T. Standards",
    sub: "Florida ELA standards reference",
  },
  math: {
    heading: "Math B.E.S.T. Standards",
    sub: "Florida math standards reference",
  },
};

// The original-page (PDF) image is available for both subjects so the
// exact printed standard (math notation, ELA exemplars/charts) renders
// faithfully alongside the extracted text.
const SUBJECT_PDF_URL: Partial<Record<Subject, string>> = {
  math: mathPdfUrl,
  ela: elaPdfUrl,
};

function gradeRank(g: string): number {
  const s = g.toUpperCase();
  if (s === "K") return -1;
  if (s === "K12") return 1000;
  if (s === "912") return 1001;
  const n = Number(s);
  return Number.isFinite(n) ? n : 2000 + (Number(s.replace(/\D/g, "")) || 0);
}

function gradeLabel(g: string): string {
  const s = g.toUpperCase();
  if (s === "K") return "K";
  if (s === "K12") return "K–12";
  if (s === "912") return "Grades 9–12";
  if (/^\d+$/.test(s)) return `Grade ${s}`;
  return `Grades ${s}`;
}

// Module-level caches (per subject) so reopening the modal doesn't refetch the
// large book body or re-parse the PDF.
const bookCache: Partial<Record<Subject, StandardsBook>> = {};
const pdfDocCache: Partial<Record<Subject, Promise<pdfjsLib.PDFDocumentProxy>>> =
  {};

function getPdfDoc(subject: Subject, url: string) {
  let doc = pdfDocCache[subject];
  if (!doc) {
    doc = pdfjsLib.getDocument({ url }).promise;
    pdfDocCache[subject] = doc;
  }
  return doc;
}

export default function StandardsBookModal({
  open,
  onClose,
  subject = "ela",
}: Props) {
  const strandLabels = STRAND_LABELS[subject];
  const meta = SUBJECT_META[subject];
  const pdfUrl = SUBJECT_PDF_URL[subject];
  const [book, setBook] = useState<StandardsBook | null>(
    bookCache[subject] ?? null,
  );
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
  // Hybrid view: show the exact original PDF page image (math equations) vs text.
  const [showOriginal, setShowOriginal] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfRendering, setPdfRendering] = useState(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const cached = bookCache[subject];
    if (cached) {
      setBook(cached);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await authFetch(
        `/api/standards-book?subject=${encodeURIComponent(subject)}`,
      );
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const json = (await res.json()) as StandardsBook;
      bookCache[subject] = json;
      setBook(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [subject]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Keep the in-state book in sync if the subject changes while mounted.
  useEffect(() => {
    setBook(bookCache[subject] ?? null);
  }, [subject]);

  // Render the original PDF page to a canvas when the reader switches to the
  // "original page" view. Errors are surfaced (never swallowed) per the e-sign
  // pdfjs precedent; the render is started only after the canvas has mounted.
  useEffect(() => {
    if (!showOriginal || openPage == null || !pdfUrl) return;
    let cancelled = false;
    let task: ReturnType<pdfjsLib.PDFPageProxy["render"]> | null = null;
    (async () => {
      setPdfErr(null);
      setPdfRendering(true);
      try {
        const doc = await getPdfDoc(subject, pdfUrl);
        if (cancelled) return;
        const page = await doc.getPage(openPage);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const containerWidth = canvas.parentElement?.clientWidth ?? 800;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.max(0.6, containerWidth / base.width));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch (e) {
        if (!cancelled && (e as { name?: string })?.name !== "RenderingCancelledException") {
          setPdfErr(e instanceof Error ? e.message : "Could not render page");
        }
      } finally {
        if (!cancelled) setPdfRendering(false);
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [showOriginal, openPage, pdfUrl, subject]);

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
    setShowOriginal(false);
    setPdfErr(null);
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
            <div style={{ fontSize: 15, fontWeight: 700 }}>{meta.heading}</div>
            <div style={{ fontSize: 11, opacity: 0.8 }}>
              {book ? `${book.title} · ${book.pageCount} pages` : meta.sub}
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
                  : `Search all ${book?.pageCount ?? ""} pages…`.replace(
                      "  ",
                      " ",
                    )
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
                      {strandLabels[s] ?? s}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px" }}>
          {loading && (
            <div style={{ color: "#6b7280", fontSize: 13, paddingTop: 16 }}>Loading the book…</div>
          )}
          {err && (
            <div style={{ color: "#b91c1c", fontSize: 13, paddingTop: 16 }}>
              {err}{" "}
              <button onClick={() => void load()} style={{ marginLeft: 8 }}>
                Retry
              </button>
            </div>
          )}

          {/* Reader pane */}
          {!loading && !err && openPage != null && (
            <div>
              <div
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 5,
                  background: "white",
                  borderBottom: "1px solid #e5e7eb",
                  margin: "0 -16px 12px",
                  padding: "16px 16px 8px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => setOpenPage(null)}
                  style={{
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
                {pdfUrl && (
                  <button
                    onClick={() => setShowOriginal((v) => !v)}
                    title="Math equations and notation render exactly as printed"
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      border: "1px solid #1e3a8a",
                      borderRadius: 6,
                      background: showOriginal ? "#1e3a8a" : "white",
                      color: showOriginal ? "white" : "#1e3a8a",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {showOriginal ? "View as text" : "View original page"}
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
                Page {openPage} of {book?.pageCount}
              </div>
              {showOriginal && pdfUrl ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  {pdfRendering && (
                    <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 8 }}>
                      Rendering page…
                    </div>
                  )}
                  {pdfErr && (
                    <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>
                      Could not render the original page ({pdfErr}). Use “View as
                      text” instead.
                    </div>
                  )}
                  <canvas
                    ref={canvasRef}
                    style={{
                      maxWidth: "100%",
                      border: "1px solid #e5e7eb",
                      borderRadius: 6,
                      boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                    }}
                  />
                </div>
              ) : (
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
              )}
            </div>
          )}

          {/* Browse list */}
          {!loading && !err && openPage == null && mode === "browse" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 16 }}>
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
                        {strandLabels[b.strand.toUpperCase()] ?? b.strand}
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
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 16 }}>
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
