// FAST Phase 2 — Benchmarks tab on Teacher Roster.
//
// Renders a (students × benchmarks) heatmap of FAST per-item mastery
// percentages for the selected (subject, school year, window), plus a
// "Bottom 3 benchmarks" tile and a drill-down modal listing the
// students under the mastery threshold for a clicked benchmark.
//
// Empty-state handling is explicit: a school that hasn't imported any
// Florida per-student xlsx yet sees a friendly "no item-level data"
// banner pointing them to Data Importer, not an empty grid.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Cell {
  pct: number;
  earned: number;
  possible: number;
}

interface StudentRow {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string;
  cells: Record<string, Cell | null>;
}

interface Benchmark {
  code: string;
  category: string | null;
}

interface BottomEntry {
  code: string;
  category: string | null;
  avgPct: number;
  studentsBelowThreshold: number;
  totalStudents: number;
}

interface WindowOpt {
  schoolYear: string;
  window: string;
  label: string;
}

interface MatrixResponse {
  teacher: { id: number; displayName: string | null };
  subject: string;
  window: string;
  schoolYear: string;
  availableWindows: WindowOpt[];
  thresholdPct: number;
  benchmarks: Benchmark[];
  students: StudentRow[];
  bottom3: BottomEntry[];
}

interface GrowthCell {
  pctA: number | null;
  pctB: number | null;
  delta: number | null;
}

interface GrowthStudentRow {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  grade: number | string;
  cells: Record<string, GrowthCell>;
}

interface GrowthMover {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  delta: number;
  pairs: number;
}

interface GrowthResponse {
  teacher: { id: number; displayName: string | null };
  subject: string;
  windowA: string;
  schoolYearA: string;
  windowB: string;
  schoolYearB: string;
  availableWindows: WindowOpt[];
  thresholdPct: number;
  benchmarks: Benchmark[];
  students: GrowthStudentRow[];
  topMovers: GrowthMover[];
  topRegressions: GrowthMover[];
}

interface DrillItem {
  itemSeq: number;
  pointsEarned: number | null;
  pointsPossible: number | null;
}

interface DrillStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string;
  pct: number | null;
  earned: number | null;
  possible: number | null;
  items: DrillItem[];
}

interface DrillResponse {
  benchmark: { code: string; category: string | null };
  thresholdPct: number;
  students: DrillStudent[];
}

const SUBJECT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "algebra1", label: "Algebra 1" },
  { value: "geometry", label: "Geometry" },
];

function cellColor(pct: number, threshold: number): {
  bg: string;
  fg: string;
} {
  if (pct >= threshold) return { bg: "#bbf7d0", fg: "#065f46" };
  if (pct >= Math.max(0, threshold - 10)) return { bg: "#fef08a", fg: "#854d0e" };
  if (pct >= Math.max(0, threshold - 30)) return { bg: "#fed7aa", fg: "#9a3412" };
  return { bg: "#fecaca", fg: "#991b1b" };
}

// Growth mode — diverging palette. Green for gains, neutral gray for
// flat (|delta| < 3), red for regressions. Intensity ramps in 3 steps
// so the eye can scan the magnitude of the move without reading the
// number.
function deltaColor(delta: number): { bg: string; fg: string } {
  if (delta >= 15) return { bg: "#86efac", fg: "#064e3b" };
  if (delta >= 7) return { bg: "#bbf7d0", fg: "#065f46" };
  if (delta >= 3) return { bg: "#dcfce7", fg: "#166534" };
  if (delta > -3) return { bg: "#e5e7eb", fg: "#374151" };
  if (delta > -7) return { bg: "#fecaca", fg: "#991b1b" };
  if (delta > -15) return { bg: "#fca5a5", fg: "#7f1d1d" };
  return { bg: "#f87171", fg: "#7f1d1d" };
}

export default function TeacherBenchmarksTab({
  teacherId,
  isOwnRoster,
}: {
  teacherId: number | null;
  // Reserved for future role-aware UI; currently the server enforces
  // every gate, but kept on the prop for parity with the parent.
  isOwnRoster: boolean;
}) {
  void isOwnRoster;

  const [subject, setSubject] = useState<string>("ela");
  // Window selection is "{schoolYear}|{window}" so a single <select>
  // can drive both fields without juggling two pieces of state.
  const [windowKey, setWindowKey] = useState<string>("");
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Phase 4 — Growth mode. When on, the heatmap shows the delta
  // between two selected windows on the same roster. Second window
  // key uses the same "sy|win" packing as windowKey.
  const [mode, setMode] = useState<"absolute" | "growth">("absolute");
  // Bottom-3 tile is opt-in — full benchmark heatmap shows by default
  // and the bottom-3 callout only appears when the teacher checks this
  // toggle (absolute mode only; growth mode uses movers tiles).
  const [showBottom3, setShowBottom3] = useState(false);
  const [windowKeyB, setWindowKeyB] = useState<string>("");
  const [growth, setGrowth] = useState<GrowthResponse | null>(null);
  const [growthLoading, setGrowthLoading] = useState(false);

  const [drillCode, setDrillCode] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillResponse | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  // Category collapse — default ALL collapsed so the heatmap is
  // scannable. Click a category header to expand the per-benchmark
  // columns underneath it (in place, no modal). Shared between
  // absolute + growth modes since the category set is the same.
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const toggleCat = (cat: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };
  const isExpanded = (cat: string) => expandedCats.has(cat);

  useEffect(() => {
    if (teacherId == null) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    params.set("teacherId", String(teacherId));
    params.set("subject", subject);
    if (windowKey.includes("|")) {
      const [sy, w] = windowKey.split("|");
      params.set("schoolYear", sy);
      params.set("window", w);
    }
    authFetch(`/api/teacher-roster/benchmarks?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as MatrixResponse;
      })
      .then((j) => {
        if (cancelled) return;
        setData(j);
        // Keep the picker in sync when the server picked the default
        // window for us (initial load + after subject change).
        const serverKey = `${j.schoolYear}|${j.window}`;
        if (serverKey !== windowKey) setWindowKey(serverKey);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, subject, windowKey]);

  // Phase 4 — Growth fetch. Only fires when the toggle is on AND both
  // windows are picked. When the user toggles ON for the first time
  // we auto-pick a sensible default for windowKeyB: the SECOND option
  // in the available-windows list (i.e. one window older than the
  // current absolute selection, since the server returns newest-first).
  useEffect(() => {
    if (mode !== "growth") {
      setGrowth(null);
      return;
    }
    if (
      teacherId == null ||
      !data ||
      data.availableWindows.length < 2 ||
      !windowKey.includes("|")
    ) {
      return;
    }
    // Default windowKeyB on first activation OR when the user changes
    // windowKey to the value currently in windowKeyB.
    let effectiveB = windowKeyB;
    if (!effectiveB.includes("|") || effectiveB === windowKey) {
      const fallback = data.availableWindows.find(
        (w) => `${w.schoolYear}|${w.window}` !== windowKey,
      );
      if (!fallback) return;
      effectiveB = `${fallback.schoolYear}|${fallback.window}`;
      setWindowKeyB(effectiveB);
      return; // wait for the state update + re-run.
    }
    let cancelled = false;
    setGrowthLoading(true);
    setError("");
    // Convention: "A" is the older window, "B" is the newer one, so
    // delta = B - A reads as "growth from A to B". We sort by the
    // server-supplied ordering — availableWindows is newest-first, so
    // whichever of the two has a higher index in that list is older.
    const idx = (k: string) =>
      data.availableWindows.findIndex(
        (w) => `${w.schoolYear}|${w.window}` === k,
      );
    const iA = idx(windowKey);
    const iB = idx(effectiveB);
    const older = iA > iB ? windowKey : effectiveB;
    const newer = iA > iB ? effectiveB : windowKey;
    const [syA, wA] = older.split("|");
    const [syB, wB] = newer.split("|");
    const params = new URLSearchParams();
    params.set("teacherId", String(teacherId));
    params.set("subject", subject);
    params.set("schoolYearA", syA);
    params.set("windowA", wA);
    params.set("schoolYearB", syB);
    params.set("windowB", wB);
    authFetch(`/api/teacher-roster/benchmarks/growth?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as GrowthResponse;
      })
      .then((j) => {
        if (cancelled) return;
        setGrowth(j);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setGrowthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, teacherId, subject, windowKey, windowKeyB, data]);

  // Drill modal data load.
  useEffect(() => {
    if (drillCode == null || teacherId == null || data == null) {
      setDrill(null);
      return;
    }
    let cancelled = false;
    setDrillLoading(true);
    const params = new URLSearchParams();
    params.set("teacherId", String(teacherId));
    params.set("subject", subject);
    params.set("schoolYear", data.schoolYear);
    params.set("window", data.window);
    params.set("benchmarkCode", drillCode);
    authFetch(`/api/teacher-roster/benchmarks/drill?${params.toString()}`)
      .then(async (r) => (r.ok ? ((await r.json()) as DrillResponse) : null))
      .then((j) => {
        if (cancelled) return;
        setDrill(j);
      })
      .finally(() => {
        if (!cancelled) setDrillLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drillCode, teacherId, subject, data]);

  // Group benchmarks by category so we can render colSpan'd category
  // header bands on the heatmap. Categories preserve the server's sort.
  const grouped = useMemo(() => {
    if (!data) return [] as Array<{ category: string; codes: Benchmark[] }>;
    const out: Array<{ category: string; codes: Benchmark[] }> = [];
    for (const b of data.benchmarks) {
      const cat = b.category ?? "(Uncategorized)";
      const last = out[out.length - 1];
      if (last && last.category === cat) {
        last.codes.push(b);
      } else {
        out.push({ category: cat, codes: [b] });
      }
    }
    return out;
  }, [data]);

  // Same shape for growth mode — needed so we can render the
  // category-collapse UX in both modes from the same shape.
  const growthGrouped = useMemo(() => {
    if (!growth) return [] as Array<{ category: string; codes: Benchmark[] }>;
    const out: Array<{ category: string; codes: Benchmark[] }> = [];
    for (const b of growth.benchmarks) {
      const cat = b.category ?? "(Uncategorized)";
      const last = out[out.length - 1];
      if (last && last.category === cat) {
        last.codes.push(b);
      } else {
        out.push({ category: cat, codes: [b] });
      }
    }
    return out;
  }, [growth]);

  if (teacherId == null) {
    return (
      <div style={{ color: "#6b7280", padding: 12 }}>
        Pick a teacher to view their benchmark heatmap.
      </div>
    );
  }

  const pdfHref = data
    ? `/api/teacher-roster/benchmarks/pdf?teacherId=${teacherId}` +
      `&subject=${subject}` +
      `&schoolYear=${encodeURIComponent(data.schoolYear)}` +
      `&window=${data.window}`
    : null;

  const openPdf = () => {
    if (!pdfHref) return;
    // authFetch → blob → object URL so the auth header rides along.
    authFetch(pdfHref)
      .then(async (r) => {
        if (!r.ok) throw new Error(`PDF ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(() => {
        setError("Could not generate PDF.");
      });
  };

  return (
    <div>
      {/* Toolbar: subject + window picker + threshold readout + PDF */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
          padding: "8px 10px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Subject:
          <select
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              // Let the server pick the most recent window for the new
              // subject — clearing windowKey forces that path.
              setWindowKey("");
            }}
          >
            {SUBJECT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {mode === "growth" ? "Window A:" : "Window:"}
          <select
            value={windowKey}
            onChange={(e) => setWindowKey(e.target.value)}
            disabled={!data || data.availableWindows.length === 0}
          >
            {data && data.availableWindows.length === 0 && (
              <option value="">— no data —</option>
            )}
            {data?.availableWindows.map((w) => (
              <option
                key={`${w.schoolYear}|${w.window}`}
                value={`${w.schoolYear}|${w.window}`}
              >
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {mode === "growth" && (
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Window B:
            <select
              value={windowKeyB}
              onChange={(e) => setWindowKeyB(e.target.value)}
              disabled={!data || data.availableWindows.length < 2}
            >
              {data?.availableWindows
                .filter(
                  (w) => `${w.schoolYear}|${w.window}` !== windowKey,
                )
                .map((w) => (
                  <option
                    key={`${w.schoolYear}|${w.window}`}
                    value={`${w.schoolYear}|${w.window}`}
                  >
                    {w.label}
                  </option>
                ))}
            </select>
          </label>
        )}
        {/* Growth toggle — disabled until at least 2 windows exist. */}
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          title={
            data && data.availableWindows.length < 2
              ? "Need two windows of data on this roster to compute growth"
              : "Toggle delta view between two windows"
          }
        >
          <input
            type="checkbox"
            checked={mode === "growth"}
            disabled={!data || data.availableWindows.length < 2}
            onChange={(e) => setMode(e.target.checked ? "growth" : "absolute")}
          />
          Growth
        </label>
        {/* Bottom-3 toggle — absolute mode only; growth mode hides this. */}
        {mode === "absolute" && (
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            title="Show the 3 weakest benchmarks on this roster for the selected window"
          >
            <input
              type="checkbox"
              checked={showBottom3}
              onChange={(e) => setShowBottom3(e.target.checked)}
            />
            Bottom 3
          </label>
        )}
        {data && (
          <span style={{ color: "#6b7280" }}>
            Mastery threshold: <strong>{data.thresholdPct}%</strong>
          </span>
        )}
        {/* Expand/Collapse all categories — escape valve so users
            don't have to click every category header individually. */}
        {((mode === "absolute" && grouped.length > 0) ||
          (mode === "growth" && growthGrouped.length > 0)) && (
          <span
            style={{
              display: "inline-flex",
              gap: 4,
              alignItems: "center",
              marginLeft: 4,
            }}
          >
            <span style={{ color: "#6b7280", fontSize: 11 }}>Categories:</span>
            <button
              type="button"
              onClick={() => {
                const cats = (mode === "growth" ? growthGrouped : grouped).map(
                  (g) => g.category,
                );
                setExpandedCats(new Set(cats));
              }}
              style={{
                padding: "2px 8px",
                fontSize: 11,
                background: "white",
                border: "1px solid #d1d5db",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={() => setExpandedCats(new Set())}
              style={{
                padding: "2px 8px",
                fontSize: 11,
                background: "white",
                border: "1px solid #d1d5db",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Collapse all
            </button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={openPdf}
          disabled={!data || data.benchmarks.length === 0}
          style={{ padding: "4px 10px" }}
          title="Open printable PDF of this heatmap"
        >
          Print PDF
        </button>
      </div>

      {/* Color legend — only relevant in absolute mode. */}
      {data && mode === "absolute" && (
        <div
          style={{
            display: "flex",
            gap: 14,
            alignItems: "center",
            flexWrap: "wrap",
            fontSize: 12,
            color: "#374151",
            marginBottom: 10,
          }}
        >
          {[
            { label: `≥ ${data.thresholdPct}% (mastery)`, pct: data.thresholdPct },
            {
              label: `${Math.max(0, data.thresholdPct - 10)}–${data.thresholdPct - 1}%`,
              pct: data.thresholdPct - 5,
            },
            {
              label: `${Math.max(0, data.thresholdPct - 30)}–${Math.max(0, data.thresholdPct - 11)}%`,
              pct: data.thresholdPct - 20,
            },
            {
              label: `< ${Math.max(0, data.thresholdPct - 30)}%`,
              pct: 0,
            },
          ].map((swatch) => {
            const c = cellColor(swatch.pct, data.thresholdPct);
            return (
              <span
                key={swatch.label}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 16,
                    height: 16,
                    background: c.bg,
                    border: "1px solid #d4d4d4",
                    borderRadius: 3,
                  }}
                />
                {swatch.label}
              </span>
            );
          })}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 8,
            background: "#fee2e2",
            color: "#7f1d1d",
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* Growth legend */}
      {mode === "growth" && (
        <div
          style={{
            display: "flex",
            gap: 14,
            alignItems: "center",
            flexWrap: "wrap",
            fontSize: 12,
            color: "#374151",
            marginBottom: 10,
          }}
          title="Cell = (Window B − Window A) percentage-point change in mastery"
        >
          {[
            { label: "+15 or more", delta: 15 },
            { label: "+7 to +14", delta: 8 },
            { label: "+3 to +6", delta: 3 },
            { label: "flat (±2)", delta: 0 },
            { label: "−3 to −6", delta: -3 },
            { label: "−7 to −14", delta: -8 },
            { label: "−15 or worse", delta: -20 },
          ].map((sw) => {
            const c = deltaColor(sw.delta);
            return (
              <span
                key={sw.label}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 16,
                    height: 16,
                    background: c.bg,
                    border: "1px solid #d4d4d4",
                    borderRadius: 3,
                  }}
                />
                {sw.label}
              </span>
            );
          })}
        </div>
      )}

      {loading && <div>Loading benchmarks…</div>}
      {growthLoading && mode === "growth" && (
        <div>Loading growth view…</div>
      )}

      {/* Empty states */}
      {!loading && data && data.availableWindows.length === 0 && (
        <div
          style={{
            padding: 16,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#78350f",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          <strong>No item-level FAST data yet for this subject.</strong>
          <div style={{ marginTop: 4 }}>
            Import a Florida <em>per-student</em> xlsx for this teacher's
            roster from <strong>Data Importer → FAST</strong>. Once the
            commit succeeds, this heatmap populates automatically.
          </div>
        </div>
      )}

      {!loading &&
        data &&
        data.availableWindows.length > 0 &&
        data.students.length === 0 && (
          <div style={{ color: "#6b7280", marginBottom: 12 }}>
            No students on this teacher's roster.
          </div>
        )}

      {!loading &&
        data &&
        data.students.length > 0 &&
        data.benchmarks.length === 0 && (
          <div style={{ color: "#6b7280", marginBottom: 12 }}>
            No benchmark responses in this window for the current roster.
          </div>
        )}

      {/* Bottom-3 tile (absolute mode only — growth mode uses movers
          tiles instead). */}
      {!loading && mode === "absolute" && showBottom3 && data && data.bottom3.length > 0 && (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "#991b1b",
              marginBottom: 6,
            }}
          >
            Bottom 3 benchmarks — {data.schoolYear}{" "}
            {data.window.toUpperCase()}
          </div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {data.bottom3.map((b) => (
              <li key={b.code} style={{ marginBottom: 4 }}>
                <button
                  onClick={() => setDrillCode(b.code)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#0369a1",
                    textDecoration: "underline",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                  }}
                  title="Click to see which students are below the threshold"
                >
                  {b.code}
                </button>
                {b.category && (
                  <span style={{ color: "#6b7280" }}> · {b.category}</span>
                )}{" "}
                — class avg <strong>{b.avgPct}%</strong> ·{" "}
                <strong>{b.studentsBelowThreshold}</strong> of{" "}
                {b.totalStudents} below {data.thresholdPct}%
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Top movers / Top regressions (growth mode). */}
      {mode === "growth" && !growthLoading && growth && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginBottom: 14,
          }}
        >
          {[
            {
              title: "Top movers",
              entries: growth.topMovers,
              border: "#bbf7d0",
              bg: "#f0fdf4",
              fg: "#065f46",
              sign: "+",
            },
            {
              title: "Top regressions",
              entries: growth.topRegressions,
              border: "#fecaca",
              bg: "#fef2f2",
              fg: "#991b1b",
              sign: "",
            },
          ].map((tile) => (
            <div
              key={tile.title}
              style={{
                border: `1px solid ${tile.border}`,
                background: tile.bg,
                borderRadius: 8,
                padding: "10px 12px",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  color: tile.fg,
                  marginBottom: 6,
                }}
              >
                {tile.title}
              </div>
              {tile.entries.length === 0 ? (
                <div style={{ color: "#6b7280", fontSize: 12 }}>
                  None to flag.
                </div>
              ) : (
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {tile.entries.map((m) => (
                    <li key={m.studentId} style={{ marginBottom: 4 }}>
                      {m.lastName}, {m.firstName} —{" "}
                      <strong>
                        {tile.sign}
                        {m.delta} pts
                      </strong>{" "}
                      <span style={{ color: "#6b7280" }}>
                        across {m.pairs} benchmark{m.pairs === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Growth heatmap */}
      {mode === "growth" &&
        !growthLoading &&
        growth &&
        growth.students.length > 0 &&
        growth.benchmarks.length > 0 && (
          <div
            style={{
              overflowX: "auto",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
            }}
          >
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: 11,
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "6px 8px",
                      textAlign: "left",
                      position: "sticky",
                      left: 0,
                      background: "#f3f4f6",
                      minWidth: 180,
                      width: 180,
                      borderRight: "1px solid #d4d4d4",
                      zIndex: 2,
                    }}
                  >
                    Student
                  </th>
                  {growthGrouped.map((g) => {
                    const expanded = isExpanded(g.category);
                    return (
                      <th
                        key={g.category}
                        colSpan={expanded ? g.codes.length : 1}
                        rowSpan={expanded ? 1 : 2}
                        style={{
                          padding: "6px 8px",
                          fontSize: 11,
                          textAlign: "center",
                          borderLeft: "3px solid #6b7280",
                          borderBottom: expanded
                            ? "2px solid #1d4ed8"
                            : undefined,
                          background: expanded ? "#dbeafe" : "#e5e7eb",
                          color: expanded ? "#1e3a8a" : undefined,
                          fontWeight: expanded ? 700 : undefined,
                          cursor: "pointer",
                          userSelect: "none",
                          minWidth: expanded ? undefined : 130,
                          maxWidth: expanded ? undefined : 160,
                          whiteSpace: expanded ? "nowrap" : "normal",
                          wordBreak: "normal",
                          overflowWrap: "break-word",
                          lineHeight: 1.2,
                        }}
                        title={`${g.category} — click to ${expanded ? "collapse" : "expand"} (${g.codes.length} benchmark${g.codes.length === 1 ? "" : "s"})`}
                        onClick={() => toggleCat(g.category)}
                      >
                        <span
                          style={{
                            marginRight: 4,
                            color: expanded ? "#1d4ed8" : "#6b7280",
                            fontWeight: 700,
                          }}
                        >
                          {expanded ? "▾" : "▸"}
                        </span>
                        {g.category}
                        {!expanded && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              color: "#6b7280",
                              fontWeight: 400,
                            }}
                          >
                            ({g.codes.length})
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
                <tr style={{ background: "#f3f4f6" }}>
                  {growthGrouped.flatMap((g) => {
                    if (!isExpanded(g.category)) return [];
                    return g.codes.map((b, i) => (
                      <th
                        key={b.code}
                        style={{
                          padding: "4px 2px",
                          fontSize: 9,
                          fontFamily: "monospace",
                          fontWeight: 600,
                          width: 44,
                          minWidth: 44,
                          textAlign: "center",
                          borderLeft:
                            i === 0
                              ? "3px solid #6b7280"
                              : "1px solid #e5e7eb",
                          whiteSpace: "nowrap",
                          color: "#374151",
                        }}
                        title={`${b.code}${b.category ? ` · ${b.category}` : ""}`}
                      >
                        {b.code.split(".").slice(-2).join(".")}
                      </th>
                    ));
                  })}
                </tr>
              </thead>
              <tbody>
                {growth.students.map((s) => (
                  <tr
                    key={s.studentId}
                    style={{ borderTop: "1px solid #f3f4f6" }}
                  >
                    <td
                      style={{
                        padding: "4px 8px",
                        position: "sticky",
                        left: 0,
                        background: "white",
                        borderRight: "1px solid #d4d4d4",
                        whiteSpace: "nowrap",
                        zIndex: 1,
                      }}
                    >
                      {s.lastName}, {s.firstName}
                    </td>
                    {growthGrouped.flatMap((g) => {
                      if (!isExpanded(g.category)) {
                        // Collapsed → avg delta + up/down subscript.
                        // Exclude benchmarks missing a window from the
                        // mean; matches the absolute-mode rule.
                        const deltas: number[] = [];
                        for (const b of g.codes) {
                          const c = s.cells[b.code];
                          if (c && c.delta != null) deltas.push(c.delta);
                        }
                        if (deltas.length === 0) {
                          return [
                            <td
                              key={g.category}
                              style={{
                                padding: 0,
                                textAlign: "center",
                                background: "#f3f4f6",
                                color: "#9ca3af",
                                borderLeft: "3px solid #6b7280",
                              }}
                              title={`${g.category}: missing a window`}
                            >
                              —
                            </td>,
                          ];
                        }
                        const avg = Math.round(
                          deltas.reduce((a, d) => a + d, 0) / deltas.length,
                        );
                        // |delta| ≥ 3 matches the deltaColor "moved"
                        // threshold; below that we treat as flat.
                        const up = deltas.filter((d) => d >= 3).length;
                        const down = deltas.filter((d) => d <= -3).length;
                        const c = deltaColor(avg);
                        const sign = avg > 0 ? "+" : "";
                        return [
                          <td
                            key={g.category}
                            style={{
                              padding: "4px 6px",
                              textAlign: "center",
                              background: c.bg,
                              color: c.fg,
                              fontWeight: 600,
                              borderLeft: "3px solid #6b7280",
                              cursor: "pointer",
                              lineHeight: 1.1,
                            }}
                            title={`${s.lastName}, ${s.firstName} · ${g.category}: avg ${sign}${avg} across ${deltas.length}/${g.codes.length} benchmarks — click to expand`}
                            onClick={() => toggleCat(g.category)}
                          >
                            {sign}
                            {avg}
                            <div
                              style={{
                                fontSize: 9,
                                fontWeight: 500,
                                opacity: 0.8,
                                marginTop: 1,
                              }}
                            >
                              {up}↑ / {down}↓
                            </div>
                          </td>,
                        ];
                      }
                      // Expanded → per-benchmark cells (unchanged).
                      return g.codes.map((b, i) => {
                        const cell = s.cells[b.code];
                        if (!cell || cell.delta == null) {
                          return (
                            <td
                              key={b.code}
                              style={{
                                padding: 0,
                                textAlign: "center",
                                background: "#f3f4f6",
                                color: "#9ca3af",
                                borderLeft:
                                  i === 0
                                    ? "3px solid #6b7280"
                                    : "1px solid #e5e7eb",
                              }}
                              title={`${b.code}: missing a window`}
                            >
                              —
                            </td>
                          );
                        }
                        const c = deltaColor(cell.delta);
                        const sign = cell.delta > 0 ? "+" : "";
                        return (
                          <td
                            key={b.code}
                            style={{
                              padding: "4px 2px",
                              textAlign: "center",
                              background: c.bg,
                              color: c.fg,
                              fontWeight: 600,
                              borderLeft:
                                i === 0
                                  ? "3px solid #6b7280"
                                  : "1px solid #e5e7eb",
                              cursor: "help",
                            }}
                            title={`${b.code}: ${cell.pctA}% → ${cell.pctB}% (${sign}${cell.delta})`}
                          >
                            {sign}
                            {cell.delta}
                          </td>
                        );
                      });
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {mode === "growth" &&
        !growthLoading &&
        growth &&
        growth.benchmarks.length === 0 && (
          <div style={{ color: "#6b7280", marginBottom: 12 }}>
            No benchmarks have data in both windows for this roster.
          </div>
        )}

      {/* Absolute heatmap */}
      {mode === "absolute" &&
        !loading &&
        data &&
        data.students.length > 0 &&
        data.benchmarks.length > 0 && (
          <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}>
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: 11,
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "6px 8px",
                      textAlign: "left",
                      position: "sticky",
                      left: 0,
                      background: "#f3f4f6",
                      minWidth: 180,
                      width: 180,
                      borderRight: "1px solid #d4d4d4",
                      zIndex: 2,
                    }}
                  >
                    Student
                  </th>
                  {grouped.map((g) => {
                    const expanded = isExpanded(g.category);
                    return (
                      <th
                        key={g.category}
                        colSpan={expanded ? g.codes.length : 1}
                        rowSpan={expanded ? 1 : 2}
                        style={{
                          padding: "6px 8px",
                          fontSize: 11,
                          textAlign: "center",
                          borderLeft: "3px solid #6b7280",
                          borderBottom: expanded
                            ? "2px solid #1d4ed8"
                            : undefined,
                          background: expanded ? "#dbeafe" : "#e5e7eb",
                          color: expanded ? "#1e3a8a" : undefined,
                          fontWeight: expanded ? 700 : undefined,
                          cursor: "pointer",
                          userSelect: "none",
                          minWidth: expanded ? undefined : 130,
                          maxWidth: expanded ? undefined : 160,
                          whiteSpace: expanded ? "nowrap" : "normal",
                          wordBreak: "normal",
                          overflowWrap: "break-word",
                          lineHeight: 1.2,
                        }}
                        title={`${g.category} — click to ${expanded ? "collapse" : "expand"} (${g.codes.length} benchmark${g.codes.length === 1 ? "" : "s"})`}
                        onClick={() => toggleCat(g.category)}
                      >
                        <span
                          style={{
                            marginRight: 4,
                            color: expanded ? "#1d4ed8" : "#6b7280",
                            fontWeight: 700,
                          }}
                        >
                          {expanded ? "▾" : "▸"}
                        </span>
                        {g.category}
                        {!expanded && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              color: "#6b7280",
                              fontWeight: 400,
                            }}
                          >
                            ({g.codes.length})
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
                <tr style={{ background: "#f3f4f6" }}>
                  {grouped.flatMap((g) => {
                    if (!isExpanded(g.category)) return [];
                    return g.codes.map((b, i) => (
                      <th
                        key={b.code}
                        style={{
                          padding: "4px 2px",
                          fontSize: 9,
                          fontFamily: "monospace",
                          fontWeight: 600,
                          width: 44,
                          minWidth: 44,
                          textAlign: "center",
                          borderLeft:
                            i === 0
                              ? "3px solid #6b7280"
                              : "1px solid #e5e7eb",
                          whiteSpace: "nowrap",
                          color: "#374151",
                        }}
                        title={b.code}
                      >
                        <button
                          onClick={() => setDrillCode(b.code)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            color: "inherit",
                            fontFamily: "inherit",
                            fontSize: "inherit",
                            fontWeight: "inherit",
                            textDecoration: "underline",
                            textDecorationStyle: "dotted",
                          }}
                          title="Click to see students below threshold"
                        >
                          {b.code.split(".").slice(-2).join(".")}
                        </button>
                      </th>
                    ));
                  })}
                </tr>
              </thead>
              <tbody>
                {data.students.map((s) => (
                  <tr key={s.studentId} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td
                      style={{
                        padding: "4px 8px",
                        position: "sticky",
                        left: 0,
                        background: "white",
                        borderRight: "1px solid #d4d4d4",
                        whiteSpace: "nowrap",
                        zIndex: 1,
                      }}
                      title={`${s.firstName} ${s.lastName} (G${s.grade})`}
                    >
                      {s.lastName}, {s.firstName}
                    </td>
                    {grouped.flatMap((g) => {
                      if (!isExpanded(g.category)) {
                        // Collapsed → one summary cell per category.
                        // Average is over benchmarks WITH data only
                        // (missing benchmarks are excluded from the
                        // mean rather than counted as 0).
                        const scored = g.codes
                          .map((b) => s.cells[b.code])
                          .filter((c): c is Cell => c != null);
                        if (scored.length === 0) {
                          return [
                            <td
                              key={g.category}
                              style={{
                                padding: 0,
                                textAlign: "center",
                                background: "#f3f4f6",
                                color: "#9ca3af",
                                borderLeft: "3px solid #6b7280",
                              }}
                              title={`${g.category}: no data`}
                            >
                              —
                            </td>,
                          ];
                        }
                        const avg = Math.round(
                          scored.reduce((a, c) => a + c.pct, 0) / scored.length,
                        );
                        const mastered = scored.filter(
                          (c) => c.pct >= data.thresholdPct,
                        ).length;
                        const c = cellColor(avg, data.thresholdPct);
                        return [
                          <td
                            key={g.category}
                            style={{
                              padding: "4px 6px",
                              textAlign: "center",
                              background: c.bg,
                              color: c.fg,
                              fontWeight: 600,
                              borderLeft: "3px solid #6b7280",
                              cursor: "pointer",
                              lineHeight: 1.1,
                            }}
                            title={`${s.lastName}, ${s.firstName} · ${g.category}: avg ${avg}% across ${scored.length}/${g.codes.length} scored benchmarks — click to expand`}
                            onClick={() => toggleCat(g.category)}
                          >
                            {avg}
                            <div
                              style={{
                                fontSize: 9,
                                fontWeight: 500,
                                opacity: 0.75,
                                marginTop: 1,
                              }}
                            >
                              {mastered}/{scored.length}
                              {scored.length < g.codes.length
                                ? ` · ${g.codes.length - scored.length}—`
                                : ""}
                            </div>
                          </td>,
                        ];
                      }
                      // Expanded → per-benchmark cells (unchanged).
                      return g.codes.map((b, i) => {
                        const cell = s.cells[b.code];
                        if (cell == null) {
                          return (
                            <td
                              key={b.code}
                              style={{
                                padding: 0,
                                textAlign: "center",
                                background: "#f3f4f6",
                                color: "#9ca3af",
                                borderLeft:
                                  i === 0
                                    ? "3px solid #6b7280"
                                    : "1px solid #e5e7eb",
                              }}
                              title={`${b.code}: no data`}
                            >
                              —
                            </td>
                          );
                        }
                        const c = cellColor(cell.pct, data.thresholdPct);
                        return (
                          <td
                            key={b.code}
                            style={{
                              padding: "4px 2px",
                              textAlign: "center",
                              background: c.bg,
                              color: c.fg,
                              fontWeight: 600,
                              borderLeft:
                                i === 0
                                  ? "3px solid #6b7280"
                                  : "1px solid #e5e7eb",
                              cursor: "help",
                            }}
                            title={`${s.lastName}, ${s.firstName} · ${b.code}: ${cell.earned}/${cell.possible} (${cell.pct}%)`}
                          >
                            {cell.pct}
                          </td>
                        );
                      });
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {/* Drill modal */}
      {drillCode && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setDrillCode(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: 8,
              padding: 18,
              maxWidth: 560,
              width: "94%",
              maxHeight: "84vh",
              overflowY: "auto",
              boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {drillCode}
                {drill?.benchmark.category && (
                  <span
                    style={{
                      color: "#6b7280",
                      fontSize: 12,
                      fontWeight: 400,
                      marginLeft: 8,
                    }}
                  >
                    {drill.benchmark.category}
                  </span>
                )}
              </h3>
              <button onClick={() => setDrillCode(null)}>Close</button>
            </div>
            <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>
              Students below the {data?.thresholdPct ?? 80}% mastery threshold for
              {" "}{data?.schoolYear} {data?.window.toUpperCase()}.
            </div>
            {drillLoading && <div>Loading…</div>}
            {!drillLoading && drill && drill.students.length === 0 && (
              <div style={{ color: "#065f46", padding: 8 }}>
                Every student met the threshold — nothing to drill into.
              </div>
            )}
            {!drillLoading && drill && drill.students.length > 0 && (
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>Student</th>
                    <th style={{ padding: "6px 8px" }}>Grade</th>
                    <th style={{ padding: "6px 8px" }}>Items</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>Total</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.students.map((s) => (
                    <tr
                      key={s.studentId}
                      style={{ borderTop: "1px solid #f3f4f6", verticalAlign: "top" }}
                    >
                      <td style={{ padding: "6px 8px" }}>
                        {s.lastName}, {s.firstName}
                      </td>
                      <td style={{ padding: "6px 8px" }}>{s.grade}</td>
                      <td
                        style={{
                          padding: "6px 8px",
                          fontFamily: "monospace",
                          fontSize: 12,
                          color: "#374151",
                        }}
                      >
                        {s.items.length === 0 ? (
                          <span style={{ color: "#9ca3af" }}>no items</span>
                        ) : (
                          // Per-item performance: each chip shows
                          // "item#: earned/possible" so the teacher
                          // can see exactly which item(s) tripped
                          // the student up (multi-item benchmarks
                          // are common in Florida xlsx).
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {s.items.map((it) => {
                              const correct =
                                it.pointsPossible != null &&
                                it.pointsEarned != null &&
                                it.pointsEarned >= it.pointsPossible;
                              const missing = it.pointsPossible == null;
                              return (
                                <span
                                  key={it.itemSeq}
                                  title={`Item ${it.itemSeq + 1}: ${it.pointsEarned ?? "—"}/${it.pointsPossible ?? "—"}`}
                                  style={{
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    background: missing
                                      ? "#f3f4f6"
                                      : correct
                                        ? "#dcfce7"
                                        : "#fee2e2",
                                    color: missing
                                      ? "#6b7280"
                                      : correct
                                        ? "#166534"
                                        : "#991b1b",
                                    fontSize: 11,
                                  }}
                                >
                                  #{it.itemSeq + 1}:{" "}
                                  {it.pointsEarned ?? "—"}/
                                  {it.pointsPossible ?? "—"}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>
                        {s.earned != null && s.possible != null
                          ? `${s.earned}/${s.possible}`
                          : "—"}
                      </td>
                      <td
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          fontWeight: 600,
                          color:
                            s.pct == null
                              ? "#9ca3af"
                              : s.pct < (data?.thresholdPct ?? 80) - 30
                                ? "#991b1b"
                                : "#9a3412",
                        }}
                      >
                        {s.pct == null ? "no data" : `${s.pct}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
