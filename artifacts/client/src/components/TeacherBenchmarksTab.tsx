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
import React, { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import BenchmarkStar from "./BenchmarkStar";

// Per-teacher instruction delivery counts (keyed by benchmark code) for
// the current school year. Drives the gradient star badge on heatmap
// column headers + every row of the Benchmark Progress Report.
type DeliveryCounts = Record<string, { count: number; lastTaughtOn: string }>;

interface Cell {
  pct: number;
  earned: number;
  possible: number;
  reteachCount?: number;
}

interface ReteachLog {
  id: number;
  studentId: string;
  benchmarkCode: string;
  teacherStaffId: number;
  teacherName: string | null;
  format: "one_on_one" | "small_group";
  groupSessionId: string | null;
  strategy: string | null;
  minutes: number | null;
  note: string | null;
  schoolYear: string;
  pmWindowAtLog: string | null;
  createdAt: string;
  canEdit: boolean;
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
  label?: string | null;
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

interface ReportItem {
  itemSeq: number;
  pointsEarned: number | null;
  pointsPossible: number | null;
}

interface ReportCell {
  items: ReportItem[];
  earned: number;
  possible: number;
  pct: number;
}

interface ReportScale {
  score: number;
  level: 1 | 2 | 3 | 4 | 5;
  subLevel: string;
  subLevelLabel: string;
  nextStopScore: number | null;
  nextStopLabel: string | null;
  gap: number | null;
}

interface ReportStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string;
  periods: number[];
  windows: {
    pm1: Record<string, ReportCell | null>;
    pm2: Record<string, ReportCell | null>;
    pm3: Record<string, ReportCell | null>;
  };
  scales: {
    pm1: ReportScale | null;
    pm2: ReportScale | null;
    pm3: ReportScale | null;
  };
}

interface ClassMedian {
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
}

interface ProgressReportResponse {
  teacher: { id: number; displayName: string | null };
  subject: string;
  schoolYear: string;
  thresholdPct: number;
  benchmarks: Benchmark[];
  classMedians?: Record<string, ClassMedian>;
  students: ReportStudent[];
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
  rosterSelectedPeriod = null,
  rosterAvailablePeriods = [],
  onOpenClassComposer,
}: {
  teacherId: number | null;
  // Reserved for future role-aware UI; currently the server enforces
  // every gate, but kept on the prop for parity with the parent.
  isOwnRoster: boolean;
  // Period filter inherited from the Teacher Roster page's chip row.
  // Used as the initial value for the tab-local "Period" picker so the
  // heatmap + Print PDF respect whatever the teacher selected on the
  // previous tab. `null` = all periods.
  rosterSelectedPeriod?: number | null;
  rosterAvailablePeriods?: number[];
  // When provided, the "Send to Class Composer" button on the Focus
  // Benchmark panel becomes active and navigates to the composer
  // (admin / Core Team only — gated by the parent).
  onOpenClassComposer?: () => void;
}) {
  void isOwnRoster;

  // Tab-local period filter — seeded from the roster page's selection
  // so opening Benchmarks immediately scopes to the same group of
  // students. Users can override here to "All" or any other period.
  // Default the period filter to the roster's selected period when one
  // exists; otherwise fall back to the first available period so the
  // Print PDF is always scoped to a single concrete period (avoids the
  // "I picked a period but the PDF still shows everyone" footgun when
  // the user lands on Benchmarks without first clicking a P-chip on
  // the Roster tab). If the teacher has no periods at all, stays null.
  const defaultPeriod =
    rosterSelectedPeriod ??
    (rosterAvailablePeriods.length > 0 ? rosterAvailablePeriods[0] : null);
  const [periodFilter, setPeriodFilter] = useState<number | null>(
    defaultPeriod,
  );
  useEffect(() => {
    setPeriodFilter(defaultPeriod);
    // Re-sync only when the upstream defaults change, not when the
    // local user toggles to "All periods" or another period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterSelectedPeriod, rosterAvailablePeriods.join(",")]);

  const [subject, setSubject] = useState<string>("ela");
  const [deliveryCounts, setDeliveryCounts] = useState<DeliveryCounts>({});
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

  // Focus-benchmark mode — when set, render the 3-bucket small-group
  // panel above the heatmap (Mastery / Near / Far). null = panel hidden.
  const [focusCode, setFocusCode] = useState<string | null>(null);
  // Student-profile drill — opened by clicking a student's name in the
  // heatmap. Shows every benchmark + % for that student in one list.
  const [studentDrillId, setStudentDrillId] = useState<string | null>(null);
  // "Suggest small group" modal — lists the ~8 lowest scorers on the
  // focus benchmark with a "Send to Class Composer" handoff.
  const [suggestOpen, setSuggestOpen] = useState(false);
  // Reteach log mini-modal — opens when a teacher clicks the 🔁 badge
  // on a cell, or "Log 1:1" / "Log small group" from the drill /
  // suggest modals. Keyed by { studentId, benchmarkCode } so the
  // modal can list existing logs for that cell and append new ones.
  // studentIds (plural) is set when bulk-logging a small group.
  const [reteachModal, setReteachModal] = useState<{
    studentId: string | null;
    studentIds: string[] | null;
    benchmarkCode: string;
    defaultFormat: "one_on_one" | "small_group";
  } | null>(null);
  const [reteachLogs, setReteachLogs] = useState<ReteachLog[]>([]);
  const [reteachLoading, setReteachLoading] = useState(false);
  const [reteachBump, setReteachBump] = useState(0);

  // Reconcile focus/drill/suggest state when the underlying data changes
  // (subject/window/teacher switch reloads `data`). If the previously
  // selected benchmark or student no longer exists in the new payload,
  // clear the state and force-close any open modal so a stale focusCode
  // can't keep an invisible-but-active modal mounted.
  useEffect(() => {
    if (!data) {
      if (focusCode !== null) setFocusCode(null);
      if (studentDrillId !== null) setStudentDrillId(null);
      if (suggestOpen) setSuggestOpen(false);
      return;
    }
    if (focusCode && !data.benchmarks.some((b) => b.code === focusCode)) {
      setFocusCode(null);
      setSuggestOpen(false);
    }
    if (
      studentDrillId &&
      !data.students.some((s) => s.studentId === studentDrillId)
    ) {
      setStudentDrillId(null);
    }
  }, [data, focusCode, studentDrillId, suggestOpen]);

  // Benchmark Progress Report modal — printable per-student item
  // analysis across PM1/PM2/PM3. Either one student or all (alpha).
  const [reportOpen, setReportOpen] = useState(false);
  const [reportData, setReportData] = useState<ProgressReportResponse | null>(
    null,
  );
  const [reportLoading, setReportLoading] = useState(false);
  const [reportFilter, setReportFilter] = useState<string>("all");

  const openReport = () => {
    if (teacherId == null || !data) return;
    setReportOpen(true);
    setReportFilter("all");
    setReportLoading(true);
    setReportData(null);
    const url =
      `/api/teacher-roster/benchmarks/progress-report` +
      `?teacherId=${teacherId}` +
      `&subject=${subject}` +
      `&schoolYear=${encodeURIComponent(data.schoolYear)}`;
    authFetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Report ${r.status}`);
        return (await r.json()) as ProgressReportResponse;
      })
      .then((j) => setReportData(j))
      .catch(() => setError("Could not load Benchmark Progress Report."))
      .finally(() => setReportLoading(false));
  };

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
    if (periodFilter != null) params.set("period", String(periodFilter));
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
  }, [teacherId, subject, windowKey, periodFilter, reteachBump]);

  // Per-teacher instruction delivery counts for the current school year.
  // Drives the BenchmarkStar badge on column headers + Progress Report
  // rows. Refetches on (teacher, subject) change AND when the tab/window
  // regains focus — so a delivery logged on the sibling Instruction Log
  // tab (or anywhere else) is reflected the moment the user comes back
  // to this view. The heatmap window picker doesn't affect it (counts
  // are always SY-to-date).
  // Bumps every 10s, plus on window focus / tab-visible, so a delivery
  // logged elsewhere in the app shows up here within ~10s without the
  // user having to refresh. In-app tab switches don't fire focus events,
  // hence the poll.
  const [countsRefreshKey, setCountsRefreshKey] = useState(0);
  useEffect(() => {
    const bump = () => setCountsRefreshKey((k) => k + 1);
    const onVis = () => {
      if (document.visibilityState === "visible") bump();
    };
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onVis);
    const interval = window.setInterval(bump, 10_000);
    return () => {
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    if (teacherId == null) {
      setDeliveryCounts({});
      return;
    }
    let cancelled = false;
    // cache: "no-store" — counts must reflect deliveries logged on the
    // sibling Instruction Log tab the moment the user switches back here.
    // Without it the browser HTTP cache + Express weak-ETag can replay a
    // stale 304 body and the header star stays at 0 even though the
    // Instruction Log circle shows the new count. See bug 5/23/26.
    authFetch(
      `/api/teacher-roster/benchmark-deliveries/counts?subject=${subject}&teacherId=${teacherId}`,
      { cache: "no-store" },
    )
      .then(async (r) => (r.ok ? r.json() : { counts: {} }))
      .then((j) => {
        if (!cancelled)
          setDeliveryCounts((j as { counts?: DeliveryCounts }).counts ?? {});
      })
      .catch(() => {
        if (!cancelled) setDeliveryCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [teacherId, subject, countsRefreshKey]);

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
      `&window=${data.window}` +
      (periodFilter != null ? `&period=${periodFilter}` : "")
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
        {/* Print-PDF scope picker. Lives right next to the button so
            there's zero ambiguity about which period the PDF will
            cover. Defaults to whatever was selected on the Teacher
            Roster page; teacher can override here. The button label
            mirrors the scope so it's visible without hovering. */}
        {rosterAvailablePeriods.length > 0 && (
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "#374151",
            }}
            title="Scope for the Print PDF — All periods or a single period."
          >
            Print scope:
            <select
              value={periodFilter == null ? "" : String(periodFilter)}
              onChange={(e) =>
                setPeriodFilter(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              style={{ fontSize: 12 }}
            >
              <option value="">All periods</option>
              {rosterAvailablePeriods.map((p) => (
                <option key={p} value={p}>
                  Period {p}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* Focus benchmark picker — when set, renders a 3-bucket
            small-group panel above the heatmap (Mastery / Near / Far).
            Only shown in absolute mode where per-benchmark % cells
            exist; growth mode is delta-based so buckets don't apply. */}
        {mode === "absolute" && data && data.benchmarks.length > 0 && (
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "#374151",
            }}
            title="Pick a benchmark to sort students into Mastery / Near mastery / Far from mastery groups"
          >
            Focus benchmark:
            <select
              value={focusCode ?? ""}
              onChange={(e) => setFocusCode(e.target.value || null)}
              style={{ fontSize: 12, maxWidth: 220 }}
            >
              <option value="">— none —</option>
              {grouped.map((g) => (
                <optgroup key={g.category} label={g.category}>
                  {g.codes.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.code.split(".").slice(-2).join(".")} — {b.code}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        <button
          onClick={openPdf}
          disabled={!data || data.benchmarks.length === 0}
          style={{ padding: "4px 10px", fontWeight: 600 }}
          title="Open printable PDF of this heatmap"
        >
          Print PDF{" "}
          {periodFilter == null ? "(All periods)" : `(Period ${periodFilter})`}
        </button>
        <button
          onClick={openReport}
          disabled={!data}
          style={{ padding: "4px 10px" }}
          title="Per-student item-analysis sheet across PM1 / PM2 / PM3 — printable so students can see growth"
        >
          Benchmark Progress Report
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
              overflow: "auto",
              maxHeight: "calc(100vh - 240px)",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
            }}
          >
            <table
              style={{
                borderCollapse: "separate",
                borderSpacing: 0,
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
                      top: 0,
                      background: "#f3f4f6",
                      minWidth: 180,
                      width: 180,
                      borderRight: "1px solid #d4d4d4",
                      zIndex: 5,
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
                          padding: "6px 8px 6px 36px",
                          fontSize: 13,
                          textAlign: "center",
                          borderLeft: expanded
                            ? "4px solid #1e3a8a"
                            : "3px solid #6b7280",
                          borderRight: expanded
                            ? "4px solid #1e3a8a"
                            : undefined,
                          borderTop: expanded
                            ? "4px solid #1e3a8a"
                            : undefined,
                          background: expanded ? "#dbeafe" : "#e5e7eb",
                          color: expanded ? "#1e3a8a" : undefined,
                          fontWeight: 700,
                          cursor: "pointer",
                          userSelect: "none",
                          minWidth: expanded ? undefined : 140,
                          maxWidth: expanded ? undefined : 170,
                          whiteSpace: expanded ? "nowrap" : "normal",
                          wordBreak: "normal",
                          overflowWrap: "break-word",
                          lineHeight: 1.2,
                          position: "sticky",
                          top: 0,
                          zIndex: 4,
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
                        {(() => {
                          // Aggregate the per-benchmark stars into one
                          // category-level star: sum of deliveries, latest
                          // taught-on across any benchmark in the group.
                          // Shown in both collapsed and expanded states so
                          // teachers see at-a-glance coverage without
                          // having to expand every category.
                          let total = 0;
                          let latest: string | null = null;
                          for (const b of g.codes) {
                            const dc = deliveryCounts[b.code];
                            if (!dc) continue;
                            total += dc.count;
                            if (
                              dc.lastTaughtOn &&
                              (!latest || dc.lastTaughtOn > latest)
                            ) {
                              latest = dc.lastTaughtOn;
                            }
                          }
                          if (total === 0) return null;
                          return (
                            <span
                              style={{
                                position: "absolute",
                                top: 4,
                                left: 4,
                                lineHeight: 0,
                                opacity: expanded ? 0.25 : 1,
                                transition: "opacity 120ms ease",
                              }}
                              onClick={(e) => e.stopPropagation()}
                              title={`${total} instructional delivery${total === 1 ? "" : "s"} this year across ${g.codes.length} benchmark${g.codes.length === 1 ? "" : "s"}`}
                            >
                              <BenchmarkStar
                                count={total}
                                lastTaughtOn={latest}
                                size={28}
                              />
                            </span>
                          );
                        })()}
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
                          position: "sticky",
                          top: 32,
                          background: "#f3f4f6",
                          zIndex: 3,
                          borderLeft:
                            i === 0
                              ? "4px solid #1e3a8a"
                              : "2px solid #2563eb",
                          borderRight:
                            i === g.codes.length - 1
                              ? "4px solid #1e3a8a"
                              : undefined,
                          whiteSpace: "nowrap",
                          color: "#374151",
                        }}
                        title={`${b.code}${b.category ? ` · ${b.category}` : ""}`}
                      >
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 2,
                            minHeight: 28,
                            justifyContent: "flex-end",
                          }}
                        >
                          <span
                            style={{
                              position: "absolute",
                              top: 2,
                              left: 2,
                              lineHeight: 0,
                            }}
                          >
                            <BenchmarkStar
                              count={deliveryCounts[b.code]?.count ?? 0}
                              lastTaughtOn={
                                deliveryCounts[b.code]?.lastTaughtOn ?? null
                              }
                              size={22}
                            />
                          </span>
                          <span>{b.code.split(".").slice(-2).join(".")}</span>
                        </div>
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
                                borderLeft: "4px solid #1e3a8a",
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
                              borderLeft: "4px solid #1e3a8a",
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
                                    ? "4px solid #1e3a8a"
                                    : "2px solid #2563eb",
                                borderRight:
                                  i === g.codes.length - 1
                                    ? "4px solid #1e3a8a"
                                    : undefined,
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
                                  ? "4px solid #1e3a8a"
                                  : "2px solid #2563eb",
                              borderRight:
                                i === g.codes.length - 1
                                  ? "4px solid #1e3a8a"
                                  : undefined,
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

      {/* Focus-benchmark small-group panel — renders above the heatmap
          when the teacher picks a benchmark from the toolbar dropdown.
          Buckets students into Mastery (≥ threshold) / Near (50% – just
          below threshold) / Far (< 50%). "Suggest small group" pulls
          the ~8 lowest scorers + hands off to Class Composer. */}
      {mode === "absolute" &&
        !loading &&
        data &&
        focusCode &&
        data.students.length > 0 &&
        (() => {
          const benchmark = data.benchmarks.find((b) => b.code === focusCode);
          if (!benchmark) return null;
          const threshold = data.thresholdPct;
          type Scored = {
            studentId: string;
            firstName: string | null;
            lastName: string | null;
            grade: number | string;
            pct: number;
          };
          const mastery: Scored[] = [];
          const near: Scored[] = [];
          const far: Scored[] = [];
          const noData: Array<Omit<Scored, "pct">> = [];
          for (const s of data.students) {
            const c = s.cells[focusCode];
            if (c == null) {
              noData.push({
                studentId: s.studentId,
                firstName: s.firstName,
                lastName: s.lastName,
                grade: s.grade,
              });
              continue;
            }
            const row: Scored = {
              studentId: s.studentId,
              firstName: s.firstName,
              lastName: s.lastName,
              grade: s.grade,
              pct: c.pct,
            };
            if (c.pct >= threshold) mastery.push(row);
            else if (c.pct >= 50) near.push(row);
            else far.push(row);
          }
          mastery.sort((a, b) => b.pct - a.pct);
          near.sort((a, b) => b.pct - a.pct);
          far.sort((a, b) => a.pct - b.pct); // lowest first
          const buckets: Array<{
            key: "mastery" | "near" | "far";
            label: string;
            range: string;
            students: Scored[];
            bg: string;
            border: string;
            color: string;
          }> = [
            {
              key: "mastery",
              label: "Mastery",
              range: `≥ ${threshold}%`,
              students: mastery,
              bg: "#f0fdf4",
              border: "#bbf7d0",
              color: "#065f46",
            },
            {
              key: "near",
              label: "Near mastery",
              range: `50% – ${threshold - 1}%`,
              students: near,
              bg: "#fffbeb",
              border: "#fde68a",
              color: "#854d0e",
            },
            {
              key: "far",
              label: "Far from mastery",
              range: `< 50%`,
              students: far,
              bg: "#fef2f2",
              border: "#fecaca",
              color: "#991b1b",
            },
          ];
          const friendly = focusCode.split(".").slice(-2).join(".");
          return (
            <div
              style={{
                border: "1px solid #c7d2fe",
                background: "#eef2ff",
                borderRadius: 8,
                padding: "12px 14px",
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14, color: "#1e3a8a" }}>
                  Focus benchmark: {friendly}
                </div>
                <div style={{ color: "#475569", fontSize: 12 }}>
                  {focusCode}
                  {benchmark.category ? ` · ${benchmark.category}` : ""}
                </div>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => setSuggestOpen(true)}
                  disabled={far.length + near.length === 0}
                  style={{
                    padding: "4px 10px",
                    fontWeight: 600,
                    fontSize: 12,
                    background: "#1e3a8a",
                    color: "white",
                    border: "none",
                    borderRadius: 4,
                    cursor:
                      far.length + near.length === 0 ? "not-allowed" : "pointer",
                    opacity: far.length + near.length === 0 ? 0.5 : 1,
                  }}
                  title="Pull the lowest scorers on this benchmark into a small group"
                >
                  Suggest small group
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    background: "white",
                    border: "1px solid #d1d5db",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                  title="Print this page"
                >
                  Print groups
                </button>
                <button
                  type="button"
                  onClick={() => setFocusCode(null)}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    background: "white",
                    border: "1px solid #d1d5db",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                  title="Hide focus panel"
                >
                  Close
                </button>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: 10,
                }}
              >
                {buckets.map((bucket) => (
                  <div
                    key={bucket.key}
                    style={{
                      background: bucket.bg,
                      border: `1px solid ${bucket.border}`,
                      borderRadius: 6,
                      padding: "8px 10px",
                      minHeight: 80,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 6,
                        marginBottom: 2,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                          color: bucket.color,
                        }}
                      >
                        {bucket.label}
                        <span
                          style={{
                            marginLeft: 6,
                            fontWeight: 600,
                            color: "#374151",
                          }}
                        >
                          ({bucket.students.length})
                        </span>
                      </div>
                      {/* Quick log-reteach for the whole band (Near/Far only —
                          Mastery is, by definition, not a reteach target).
                          Opens the bulk modal with this band's students
                          pre-checked; teacher can uncheck absentees there. */}
                      {(bucket.key === "near" || bucket.key === "far") &&
                        bucket.students.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setReteachModal({
                                studentId: null,
                                studentIds: bucket.students.map(
                                  (s) => s.studentId,
                                ),
                                benchmarkCode: focusCode,
                                defaultFormat: "small_group",
                              })
                            }
                            style={{
                              padding: "2px 6px",
                              fontSize: 10,
                              fontWeight: 600,
                              background: "white",
                              border: `1px solid ${bucket.border}`,
                              color: bucket.color,
                              borderRadius: 3,
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 3,
                              lineHeight: 1.2,
                            }}
                            title={`Log a small-group reteach for all ${bucket.students.length} ${bucket.label.toLowerCase()} students`}
                          >
                            <span aria-hidden="true">🔁</span>
                            <span>Log group</span>
                          </button>
                        )}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#6b7280",
                        marginBottom: 6,
                      }}
                    >
                      {bucket.range}
                    </div>
                    {bucket.students.length === 0 ? (
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>
                        — none —
                      </div>
                    ) : (
                      <ul
                        style={{
                          listStyle: "none",
                          padding: 0,
                          margin: 0,
                          fontSize: 13,
                        }}
                      >
                        {bucket.students.map((s) => (
                          <li
                            key={s.studentId}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              padding: "2px 0",
                              borderBottom: "1px dotted rgba(0,0,0,0.05)",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => setStudentDrillId(s.studentId)}
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                color: "#0369a1",
                                textDecoration: "underline",
                                textDecorationStyle: "dotted",
                                cursor: "pointer",
                                fontSize: 13,
                                textAlign: "left",
                              }}
                              title="View this student's full benchmark profile"
                            >
                              {s.lastName}, {s.firstName}
                            </button>
                            <span
                              style={{
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: 600,
                                color: bucket.color,
                              }}
                            >
                              {s.pct}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
              {noData.length > 0 && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    color: "#6b7280",
                  }}
                >
                  No response on this benchmark: {noData.length} student
                  {noData.length === 1 ? "" : "s"}
                </div>
              )}
            </div>
          );
        })()}

      {/* Absolute heatmap */}
      {mode === "absolute" &&
        !loading &&
        data &&
        data.students.length > 0 &&
        data.benchmarks.length > 0 && (
          <div
            style={{
              overflow: "auto",
              maxHeight: "calc(100vh - 240px)",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
            }}
          >
            <table
              style={{
                borderCollapse: "separate",
                borderSpacing: 0,
                fontSize: 14,
                fontWeight: 600,
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "8px 10px",
                      textAlign: "left",
                      position: "sticky",
                      left: 0,
                      top: 0,
                      background: "#f3f4f6",
                      minWidth: 200,
                      width: 200,
                      borderRight: "1px solid #d4d4d4",
                      zIndex: 5,
                      fontSize: 13,
                      fontWeight: 700,
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
                          padding: "6px 8px 6px 36px",
                          fontSize: 13,
                          textAlign: "center",
                          borderLeft: expanded
                            ? "4px solid #1e3a8a"
                            : "3px solid #6b7280",
                          borderRight: expanded
                            ? "4px solid #1e3a8a"
                            : undefined,
                          borderTop: expanded
                            ? "4px solid #1e3a8a"
                            : undefined,
                          background: expanded ? "#dbeafe" : "#e5e7eb",
                          color: expanded ? "#1e3a8a" : undefined,
                          fontWeight: 700,
                          cursor: "pointer",
                          userSelect: "none",
                          minWidth: expanded ? undefined : 140,
                          maxWidth: expanded ? undefined : 170,
                          whiteSpace: expanded ? "nowrap" : "normal",
                          wordBreak: "normal",
                          overflowWrap: "break-word",
                          lineHeight: 1.2,
                          position: "sticky",
                          top: 0,
                          zIndex: 4,
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
                        {(() => {
                          // Aggregate the per-benchmark stars into one
                          // category-level star: sum of deliveries, latest
                          // taught-on across any benchmark in the group.
                          // Shown in both collapsed and expanded states so
                          // teachers see at-a-glance coverage without
                          // having to expand every category.
                          let total = 0;
                          let latest: string | null = null;
                          for (const b of g.codes) {
                            const dc = deliveryCounts[b.code];
                            if (!dc) continue;
                            total += dc.count;
                            if (
                              dc.lastTaughtOn &&
                              (!latest || dc.lastTaughtOn > latest)
                            ) {
                              latest = dc.lastTaughtOn;
                            }
                          }
                          if (total === 0) return null;
                          return (
                            <span
                              style={{
                                position: "absolute",
                                top: 4,
                                left: 4,
                                lineHeight: 0,
                                opacity: expanded ? 0.25 : 1,
                                transition: "opacity 120ms ease",
                              }}
                              onClick={(e) => e.stopPropagation()}
                              title={`${total} instructional delivery${total === 1 ? "" : "s"} this year across ${g.codes.length} benchmark${g.codes.length === 1 ? "" : "s"}`}
                            >
                              <BenchmarkStar
                                count={total}
                                lastTaughtOn={latest}
                                size={28}
                              />
                            </span>
                          );
                        })()}
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
                          width: 84,
                          minWidth: 84,
                          textAlign: "center",
                          position: "sticky",
                          top: 32,
                          background: "#f3f4f6",
                          zIndex: 3,
                          borderLeft:
                            i === 0
                              ? "4px solid #1e3a8a"
                              : "2px solid #2563eb",
                          borderRight:
                            i === g.codes.length - 1
                              ? "4px solid #1e3a8a"
                              : undefined,
                          whiteSpace: "nowrap",
                          color: "#374151",
                        }}
                        title={b.code}
                      >
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 2,
                            minHeight: 32,
                            justifyContent: "flex-end",
                          }}
                        >
                          <span
                            style={{
                              position: "absolute",
                              top: 3,
                              left: 3,
                              lineHeight: 0,
                            }}
                          >
                            <BenchmarkStar
                              count={deliveryCounts[b.code]?.count ?? 0}
                              lastTaughtOn={
                                deliveryCounts[b.code]?.lastTaughtOn ?? null
                              }
                              size={26}
                            />
                          </span>
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
                        </div>
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
                        padding: "6px 10px",
                        position: "sticky",
                        left: 0,
                        background: "white",
                        borderRight: "1px solid #d4d4d4",
                        whiteSpace: "nowrap",
                        zIndex: 1,
                        fontWeight: 700,
                        fontSize: 14,
                        cursor: "pointer",
                        color: "#0369a1",
                        textDecoration: "underline",
                        textDecorationStyle: "dotted",
                      }}
                      title={`${s.firstName} ${s.lastName} (G${s.grade}) — click for full benchmark profile`}
                      onClick={() => setStudentDrillId(s.studentId)}
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
                                borderLeft: "4px solid #1e3a8a",
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
                              padding: "6px 8px",
                              textAlign: "center",
                              background: c.bg,
                              color: c.fg,
                              fontWeight: 700,
                              fontSize: 15,
                              borderLeft: "4px solid #1e3a8a",
                              cursor: "pointer",
                              lineHeight: 1.1,
                            }}
                            title={`${s.lastName}, ${s.firstName} · ${g.category}: avg ${avg}% across ${scored.length}/${g.codes.length} scored benchmarks — click to expand`}
                            onClick={() => toggleCat(g.category)}
                          >
                            {avg}
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                opacity: 0.8,
                                marginTop: 2,
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
                                    ? "4px solid #1e3a8a"
                                    : "2px solid #2563eb",
                                borderRight:
                                  i === g.codes.length - 1
                                    ? "4px solid #1e3a8a"
                                    : undefined,
                              }}
                              title={`${b.code}: no data`}
                            >
                              —
                            </td>
                          );
                        }
                        const c = cellColor(cell.pct, data.thresholdPct);
                        const rc = cell.reteachCount ?? 0;
                        return (
                          <td
                            key={b.code}
                            onClick={() =>
                              setReteachModal({
                                studentId: s.studentId,
                                studentIds: null,
                                benchmarkCode: b.code,
                                defaultFormat: "one_on_one",
                              })
                            }
                            style={{
                              position: "relative",
                              padding: "6px 2px",
                              textAlign: "center",
                              background: c.bg,
                              color: c.fg,
                              fontWeight: 700,
                              fontSize: 14,
                              borderLeft:
                                i === 0
                                  ? "4px solid #1e3a8a"
                                  : "2px solid #2563eb",
                              borderRight:
                                i === g.codes.length - 1
                                  ? "4px solid #1e3a8a"
                                  : undefined,
                              cursor: "pointer",
                            }}
                            title={`${s.lastName}, ${s.firstName} · ${b.code}: ${cell.earned}/${cell.possible} (${cell.pct}%)${rc > 0 ? ` · ${rc} reteach${rc === 1 ? "" : "es"} logged` : " · click to log a reteach"}`}
                          >
                            {cell.pct}
                            {rc > 0 && (
                              <span
                                style={{
                                  position: "absolute",
                                  top: 2,
                                  right: 2,
                                  fontSize: 11,
                                  fontWeight: 800,
                                  background: "#1e3a8a",
                                  color: "#fff",
                                  borderRadius: 10,
                                  padding: "2px 6px",
                                  lineHeight: 1.1,
                                  boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                                }}
                              >
                                🔁{rc}
                              </span>
                            )}
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

      {reportOpen && (
        <ProgressReportModal
          loading={reportLoading}
          report={reportData}
          filter={reportFilter}
          onFilterChange={setReportFilter}
          onClose={() => setReportOpen(false)}
          deliveryCounts={deliveryCounts}
        />
      )}

      {/* Student-profile drill modal — opens when a teacher clicks a
          student name in the heatmap (or in the focus panel). Lists
          every benchmark + this student's %, grouped by category and
          sorted weakest → strongest so the teacher can spot priorities
          for one student at a glance. */}
      {studentDrillId && data && (() => {
        const s = data.students.find((x) => x.studentId === studentDrillId);
        if (!s) return null;
        const rows: Array<{
          code: string;
          category: string | null;
          pct: number | null;
        }> = data.benchmarks.map((b) => ({
          code: b.code,
          category: b.category,
          pct: s.cells[b.code]?.pct ?? null,
        }));
        const scored = rows.filter((r) => r.pct != null) as Array<{
          code: string;
          category: string | null;
          pct: number;
        }>;
        scored.sort((a, b) => a.pct - b.pct);
        const missing = rows.filter((r) => r.pct == null);
        return (
          <div
            role="dialog"
            aria-modal="true"
            onClick={() => setStudentDrillId(null)}
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
                maxWidth: 620,
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
                  {s.lastName}, {s.firstName}
                  <span
                    style={{
                      color: "#6b7280",
                      fontSize: 12,
                      fontWeight: 400,
                      marginLeft: 8,
                    }}
                  >
                    G{s.grade} · {data.schoolYear}{" "}
                    {data.window.toUpperCase()}
                  </span>
                </h3>
                <button onClick={() => setStudentDrillId(null)}>Close</button>
              </div>
              <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>
                Full benchmark profile — sorted weakest → strongest. Mastery
                threshold: <strong>{data.thresholdPct}%</strong>.
              </div>
              {scored.length === 0 ? (
                <div style={{ color: "#9ca3af", padding: 8 }}>
                  No benchmark responses for this student in this window.
                </div>
              ) : (
                <table
                  style={{
                    width: "100%",
                    fontSize: 13,
                    borderCollapse: "collapse",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                      <th style={{ padding: "6px 8px" }}>Benchmark</th>
                      <th style={{ padding: "6px 8px" }}>Category</th>
                      <th style={{ padding: "6px 8px", textAlign: "right" }}>%</th>
                      <th style={{ padding: "6px 8px", textAlign: "right" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {scored.map((r) => {
                      const c = cellColor(r.pct, data.thresholdPct);
                      const rc =
                        s.cells[r.code]?.reteachCount ?? 0;
                      return (
                        <tr
                          key={r.code}
                          style={{ borderTop: "1px solid #f3f4f6" }}
                        >
                          <td
                            style={{
                              padding: "6px 8px",
                              fontFamily: "monospace",
                              fontSize: 12,
                            }}
                          >
                            {r.code}
                          </td>
                          <td
                            style={{
                              padding: "6px 8px",
                              color: "#6b7280",
                              fontSize: 12,
                            }}
                          >
                            {r.category ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "6px 8px",
                              textAlign: "right",
                              background: c.bg,
                              color: c.fg,
                              fontWeight: 700,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {r.pct}%
                          </td>
                          <td
                            style={{
                              padding: "4px 6px",
                              textAlign: "right",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setStudentDrillId(null);
                                setReteachModal({
                                  studentId: s.studentId,
                                  studentIds: null,
                                  benchmarkCode: r.code,
                                  defaultFormat: "one_on_one",
                                });
                              }}
                              style={{
                                padding: "2px 6px",
                                fontSize: 11,
                                background: "white",
                                border: "1px solid #d1d5db",
                                borderRadius: 4,
                                cursor: "pointer",
                              }}
                              title="Log a 1:1 reteach for this benchmark"
                            >
                              Log 1:1{rc > 0 ? ` · 🔁${rc}` : ""}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {missing.length > 0 && (
                <div
                  style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}
                >
                  No response on {missing.length} other benchmark
                  {missing.length === 1 ? "" : "s"} in this window.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Suggest small group modal — pulls the 8 lowest scorers on the
          focus benchmark and offers a handoff to Class Composer. The
          composer button is gated by the onOpenClassComposer prop
          (admin / Core Team only); other staff still see the list. */}
      {suggestOpen && focusCode && data && (() => {
        const benchmark = data.benchmarks.find((b) => b.code === focusCode);
        if (!benchmark) return null;
        type SuggestRow = {
          studentId: string;
          firstName: string | null;
          lastName: string | null;
          grade: number | string;
          pct: number;
        };
        const scored: SuggestRow[] = data.students
          .flatMap<SuggestRow>((s) => {
            const pct = s.cells[focusCode]?.pct ?? null;
            if (pct == null) return [];
            return [{
              studentId: s.studentId,
              firstName: s.firstName,
              lastName: s.lastName,
              grade: s.grade,
              pct,
            }];
          })
          .sort((a, b) => a.pct - b.pct)
          .slice(0, 8);
        const friendly = focusCode.split(".").slice(-2).join(".");
        const copyList = () => {
          const lines = scored.map(
            (s) =>
              `${s.lastName}, ${s.firstName} (G${s.grade}) — ${s.pct}%`,
          );
          const text = `Suggested small group · ${friendly} (${focusCode})\n${lines.join("\n")}`;
          void navigator.clipboard?.writeText(text);
        };
        return (
          <div
            role="dialog"
            aria-modal="true"
            onClick={() => setSuggestOpen(false)}
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
                maxWidth: 520,
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
                  Suggested small group — {friendly}
                </h3>
                <button onClick={() => setSuggestOpen(false)}>Close</button>
              </div>
              <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>
                The {scored.length} lowest scorers on{" "}
                <span style={{ fontFamily: "monospace" }}>{focusCode}</span>{" "}
                in {data.schoolYear} {data.window.toUpperCase()}.
              </div>
              {scored.length === 0 ? (
                <div style={{ color: "#9ca3af", padding: 8 }}>
                  No students have a recorded score on this benchmark.
                </div>
              ) : (
                <ol style={{ paddingLeft: 18, margin: "0 0 12px 0" }}>
                  {scored.map((s) => (
                    <li key={s.studentId} style={{ marginBottom: 3 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setSuggestOpen(false);
                          setStudentDrillId(s.studentId);
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "#0369a1",
                          textDecoration: "underline",
                          textDecorationStyle: "dotted",
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                      >
                        {s.lastName}, {s.firstName}
                      </button>{" "}
                      <span style={{ color: "#6b7280", fontSize: 12 }}>
                        G{s.grade}
                      </span>{" "}
                      <span
                        style={{
                          float: "right",
                          fontWeight: 700,
                          color: "#991b1b",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {s.pct}%
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (scored.length === 0) return;
                    setSuggestOpen(false);
                    setReteachModal({
                      studentId: null,
                      studentIds: scored.map((s) => s.studentId),
                      benchmarkCode: focusCode,
                      defaultFormat: "small_group",
                    });
                  }}
                  disabled={scored.length === 0}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    background: "white",
                    border: "1px solid #1e3a8a",
                    color: "#1e3a8a",
                    borderRadius: 4,
                    cursor: scored.length === 0 ? "not-allowed" : "pointer",
                  }}
                  title="Log a small-group reteach for these students on this benchmark"
                >
                  Log small group
                </button>
                <button
                  type="button"
                  onClick={copyList}
                  disabled={scored.length === 0}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    background: "white",
                    border: "1px solid #d1d5db",
                    borderRadius: 4,
                    cursor: scored.length === 0 ? "not-allowed" : "pointer",
                  }}
                  title="Copy this list to clipboard"
                >
                  Copy list
                </button>
                {onOpenClassComposer ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSuggestOpen(false);
                      onOpenClassComposer();
                    }}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      background: "#1e3a8a",
                      color: "white",
                      border: "none",
                      borderRadius: 4,
                      cursor: "pointer",
                    }}
                    title="Open Class Composer to build formal groups"
                  >
                    Open in Class Composer
                  </button>
                ) : (
                  <span
                    style={{
                      fontSize: 11,
                      color: "#6b7280",
                      alignSelf: "center",
                    }}
                    title="Class Composer is admin / Core Team only"
                  >
                    Class Composer is admin / Core Team only
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Reteach log mini-modal — list of existing logs + add form.
          Opens from a cell click (1:1 default), the per-benchmark
          "Log 1:1" button in the student-drill modal, or the
          "Log small group" button in the suggest modal (bulk). */}
      {reteachModal && (
        <ReteachLogModal
          modal={reteachModal}
          logs={reteachLogs}
          loading={reteachLoading}
          students={data?.students ?? []}
          schoolYear={data?.schoolYear ?? null}
          pmWindow={data?.window ?? null}
          onClose={() => {
            setReteachModal(null);
            setReteachLogs([]);
          }}
          onChanged={() => {
            // Force the heatmap matrix to re-fetch so the 🔁 badge
            // counts pick up the new / edited / deleted log.
            setReteachBump((n) => n + 1);
          }}
          reloadCellLogs={async () => {
            if (!reteachModal?.studentId) return;
            setReteachLoading(true);
            try {
              const r = await authFetch(
                `/api/reteach-log/cell?studentId=${encodeURIComponent(reteachModal.studentId)}&benchmarkCode=${encodeURIComponent(reteachModal.benchmarkCode)}`,
              );
              if (r.ok) {
                const j = (await r.json()) as { logs: ReteachLog[] };
                setReteachLogs(j.logs);
              }
            } finally {
              setReteachLoading(false);
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reteach log modal — list + add form. Single-student modes show
// existing logs and allow inline edit/delete (24h teacher window or
// admin/Core Team). Bulk small-group mode skips the list (it's a
// brand-new session for N students) and only shows the add form.
function ReteachLogModal(props: {
  modal: {
    studentId: string | null;
    studentIds: string[] | null;
    benchmarkCode: string;
    defaultFormat: "one_on_one" | "small_group";
  };
  logs: ReteachLog[];
  loading: boolean;
  students: StudentRow[];
  schoolYear: string | null;
  pmWindow: string | null;
  onClose: () => void;
  onChanged: () => void;
  reloadCellLogs: () => Promise<void>;
}) {
  const { modal, logs, loading, students, schoolYear, pmWindow } = props;
  const isBulk = modal.studentIds != null && modal.studentIds.length > 0;
  const single = !isBulk && modal.studentId
    ? students.find((s) => s.studentId === modal.studentId) ?? null
    : null;
  const bulkRoster = isBulk
    ? students.filter((s) => modal.studentIds!.includes(s.studentId))
    : [];
  const [format, setFormat] = useState<"one_on_one" | "small_group">(
    modal.defaultFormat,
  );
  // Per-student checklist for bulk (small-group) mode. Pre-checked
  // with everyone so the common path is one click; teacher can
  // uncheck absentees or split a band across two sessions. Each
  // submit creates its own groupSessionId, so partial logs stay
  // accurate (a 12-kid band done over two days = two clean sessions).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(modal.studentIds ?? []),
  );
  const [strategy, setStrategy] = useState("");
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editMinutes, setEditMinutes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!isBulk) void props.reloadCellLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.studentId, modal.benchmarkCode]);

  const friendly = modal.benchmarkCode.split(".").slice(-2).join(".");

  const submit = async () => {
    setErr("");
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        benchmarkCode: modal.benchmarkCode,
        format,
        strategy: strategy.trim() || null,
        minutes: minutes === "" ? null : Number(minutes),
        note: note.trim() || null,
        schoolYear,
        pmWindowAtLog: pmWindow,
      };
      let url = "/api/reteach-log";
      if (isBulk) {
        url = "/api/reteach-log/bulk";
        // Use only the checked subset — lets a teacher drop absentees
        // or split a band across multiple days while keeping each
        // session's documentation accurate.
        body.studentIds = (modal.studentIds ?? []).filter((id) =>
          selectedIds.has(id),
        );
      } else {
        body.studentId = modal.studentId;
      }
      const r = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setStrategy("");
      setMinutes("");
      setNote("");
      props.onChanged();
      if (isBulk) {
        props.onClose();
      } else {
        await props.reloadCellLogs();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (id: number) => {
    setErr("");
    try {
      const r = await authFetch(`/api/reteach-log/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: editNote.trim() || null,
          minutes: editMinutes === "" ? null : Number(editMinutes),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setEditingId(null);
      props.onChanged();
      await props.reloadCellLogs();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this reteach log?")) return;
    setErr("");
    try {
      const r = await authFetch(`/api/reteach-log/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      props.onChanged();
      await props.reloadCellLogs();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 60,
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
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>
            🔁 Reteach log — {friendly}
          </h3>
          <button onClick={props.onClose}>Close</button>
        </div>
        <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>
          <span style={{ fontFamily: "monospace" }}>{modal.benchmarkCode}</span>
          {single && (
            <>
              {" · "}
              {single.lastName}, {single.firstName} (G{single.grade})
            </>
          )}
          {isBulk && (
            <>
              {" · small group · "}
              <strong>{bulkRoster.length || modal.studentIds!.length}</strong>{" "}
              student{(modal.studentIds!.length) === 1 ? "" : "s"}
            </>
          )}
        </div>

        {isBulk && (bulkRoster.length > 0 || modal.studentIds!.length > 0) && (
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 11,
                color: "#6b7280",
                marginBottom: 4,
              }}
            >
              <span>
                Uncheck anyone absent or being saved for a later session.
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(new Set(modal.studentIds ?? []))
                  }
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    background: "white",
                    border: "1px solid #d1d5db",
                    borderRadius: 3,
                    cursor: "pointer",
                  }}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    background: "white",
                    border: "1px solid #d1d5db",
                    borderRadius: 3,
                    cursor: "pointer",
                  }}
                >
                  None
                </button>
              </span>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#374151",
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
                borderRadius: 4,
                padding: "4px 8px",
                // ~6 rows visible; scroll the rest. Larger bands
                // (e.g. Far From Mastery with 15 kids) stay manageable.
                maxHeight: 180,
                overflowY: "auto",
              }}
            >
              {(bulkRoster.length > 0
                ? bulkRoster
                : modal.studentIds!.map((id) => ({
                    studentId: id,
                    firstName: id,
                    lastName: "",
                    grade: "",
                    cells: {},
                  }))
              ).map((s) => {
                const checked = selectedIds.has(s.studentId);
                return (
                  <label
                    key={s.studentId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 0",
                      cursor: "pointer",
                      borderBottom: "1px solid #f3f4f6",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.studentId);
                          else next.delete(s.studentId);
                          return next;
                        })
                      }
                    />
                    <span
                      style={{
                        color: checked ? "#111827" : "#9ca3af",
                        textDecoration: checked ? "none" : "line-through",
                      }}
                    >
                      {s.lastName ? `${s.lastName}, ${s.firstName}` : s.firstName}
                      {s.grade !== "" && (
                        <span
                          style={{
                            color: "#6b7280",
                            fontSize: 11,
                            marginLeft: 4,
                          }}
                        >
                          G{s.grade}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {!isBulk && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "#374151",
                marginBottom: 4,
              }}
            >
              Previous logs ({logs.length})
            </div>
            {loading ? (
              <div style={{ color: "#9ca3af", fontSize: 12 }}>Loading…</div>
            ) : logs.length === 0 ? (
              <div style={{ color: "#9ca3af", fontSize: 12 }}>
                None yet.
              </div>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  maxHeight: 200,
                  overflowY: "auto",
                  border: "1px solid #e5e7eb",
                  borderRadius: 4,
                }}
              >
                {logs.map((l) => {
                  const isEdit = editingId === l.id;
                  return (
                    <li
                      key={l.id}
                      style={{
                        padding: "6px 8px",
                        borderBottom: "1px solid #f3f4f6",
                        fontSize: 12,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 6,
                        }}
                      >
                        <div>
                          <strong>
                            {l.format === "one_on_one"
                              ? "1:1"
                              : "Small group"}
                          </strong>
                          {" · "}
                          {new Date(l.createdAt).toLocaleDateString()}
                          {" · "}
                          <span style={{ color: "#6b7280" }}>
                            {l.teacherName ?? `Staff #${l.teacherStaffId}`}
                          </span>
                          {l.minutes != null && (
                            <span style={{ color: "#6b7280" }}>
                              {" · "}
                              {l.minutes} min
                            </span>
                          )}
                        </div>
                        {l.canEdit && !isEdit && (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(l.id);
                                setEditNote(l.note ?? "");
                                setEditMinutes(
                                  l.minutes != null ? String(l.minutes) : "",
                                );
                              }}
                              style={{
                                fontSize: 10,
                                padding: "1px 6px",
                                background: "white",
                                border: "1px solid #d1d5db",
                                borderRadius: 3,
                                cursor: "pointer",
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(l.id)}
                              style={{
                                fontSize: 10,
                                padding: "1px 6px",
                                background: "white",
                                border: "1px solid #fca5a5",
                                color: "#991b1b",
                                borderRadius: 3,
                                cursor: "pointer",
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                      {isEdit ? (
                        <div style={{ marginTop: 4, display: "grid", gap: 4 }}>
                          <input
                            type="number"
                            placeholder="minutes"
                            value={editMinutes}
                            onChange={(e) => setEditMinutes(e.target.value)}
                            style={{
                              fontSize: 12,
                              padding: "2px 4px",
                              border: "1px solid #d1d5db",
                              borderRadius: 3,
                              width: 90,
                            }}
                          />
                          <textarea
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                            rows={2}
                            style={{
                              fontSize: 12,
                              padding: "2px 4px",
                              border: "1px solid #d1d5db",
                              borderRadius: 3,
                              fontFamily: "inherit",
                            }}
                          />
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => void saveEdit(l.id)}
                              style={{
                                fontSize: 11,
                                padding: "2px 8px",
                                background: "#1e3a8a",
                                color: "white",
                                border: "none",
                                borderRadius: 3,
                                cursor: "pointer",
                              }}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              style={{
                                fontSize: 11,
                                padding: "2px 8px",
                                background: "white",
                                border: "1px solid #d1d5db",
                                borderRadius: 3,
                                cursor: "pointer",
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        l.note && (
                          <div style={{ color: "#374151", marginTop: 2 }}>
                            {l.note}
                          </div>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid #e5e7eb",
            paddingTop: 10,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#374151",
              marginBottom: 6,
            }}
          >
            Add reteach log
          </div>
          {!isBulk && (
            <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
              <label style={{ fontSize: 12 }}>
                <input
                  type="radio"
                  checked={format === "one_on_one"}
                  onChange={() => setFormat("one_on_one")}
                />{" "}
                1:1
              </label>
              <label style={{ fontSize: 12 }}>
                <input
                  type="radio"
                  checked={format === "small_group"}
                  onChange={() => setFormat("small_group")}
                />{" "}
                Small group
              </label>
            </div>
          )}
          <div style={{ display: "grid", gap: 6 }}>
            <input
              type="text"
              placeholder="Strategy (optional, e.g. number talk, modeling)"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              maxLength={120}
              style={{
                fontSize: 12,
                padding: "4px 6px",
                border: "1px solid #d1d5db",
                borderRadius: 4,
              }}
            />
            <input
              type="number"
              min={0}
              max={600}
              placeholder="Minutes (optional)"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              style={{
                fontSize: 12,
                padding: "4px 6px",
                border: "1px solid #d1d5db",
                borderRadius: 4,
                width: 140,
              }}
            />
            <textarea
              placeholder="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              style={{
                fontSize: 12,
                padding: "4px 6px",
                border: "1px solid #d1d5db",
                borderRadius: 4,
                fontFamily: "inherit",
              }}
            />
          </div>
          {err && (
            <div
              style={{
                color: "#991b1b",
                fontSize: 12,
                marginTop: 6,
              }}
            >
              {err}
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 8,
            }}
          >
            <button
              type="button"
              onClick={() => void submit()}
              disabled={saving || (isBulk && selectedIds.size === 0)}
              title={
                isBulk && selectedIds.size === 0
                  ? "Pick at least one student"
                  : undefined
              }
              style={{
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 600,
                background:
                  saving || (isBulk && selectedIds.size === 0)
                    ? "#9ca3af"
                    : "#1e3a8a",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor:
                  saving || (isBulk && selectedIds.size === 0)
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {saving
                ? "Saving…"
                : isBulk
                  ? `Log for ${selectedIds.size} student${selectedIds.size === 1 ? "" : "s"}`
                  : "Add log"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — tiny inline SVG (3 points across PM1·PM2·PM3) used both
// in the per-row "Trend" column and the per-category header. Missing
// windows are skipped; if fewer than 2 real points exist we draw a
// dotted baseline placeholder so the cell isn't blank.
function Sparkline(props: {
  values: Array<number | null>;
  width?: number;
  height?: number;
  stroke?: string;
  threshold?: number;
}) {
  const w = props.width ?? 56;
  const h = props.height ?? 18;
  const stroke = props.stroke ?? "#1e3a8a";
  const pad = 2;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const pts: Array<{ x: number; y: number; v: number }> = [];
  const n = props.values.length;
  for (let i = 0; i < n; i++) {
    const v = props.values[i];
    if (v == null) continue;
    const x = pad + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
    const y = pad + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH;
    pts.push({ x, y, v });
  }
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const thrY =
    props.threshold != null
      ? pad + innerH - (props.threshold / 100) * innerH
      : null;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      {thrY != null && (
        <line
          x1={pad}
          y1={thrY}
          x2={w - pad}
          y2={thrY}
          stroke="#9ca3af"
          strokeWidth={0.5}
          strokeDasharray="2,2"
        />
      )}
      {pts.length >= 2 ? (
        <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" />
      ) : (
        <line
          x1={pad}
          y1={h / 2}
          x2={w - pad}
          y2={h / 2}
          stroke="#d1d5db"
          strokeWidth={0.75}
          strokeDasharray="2,2"
        />
      )}
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={1.6}
          fill={
            p.v >= (props.threshold ?? 80)
              ? "#14532d"
              : p.v >= 50
              ? "#78350f"
              : "#7f1d1d"
          }
        />
      ))}
    </svg>
  );
}

// Benchmark Progress Report — printable per-student item-analysis sheet.
// One page per student (landscape). Rows = benchmarks (grouped by category),
// columns = PM1 · PM2 · PM3, cells = per-item chips (red ✗ / green ✓) plus a
// summary like "2/4 · 50%". Empty PM columns show an encouragement line so
// students can see they're working toward filling those positives in.
// ---------------------------------------------------------------------------
function ProgressReportModal(props: {
  loading: boolean;
  report: ProgressReportResponse | null;
  filter: string; // "all" or studentId
  onFilterChange: (v: string) => void;
  onClose: () => void;
  deliveryCounts: DeliveryCounts;
}) {
  const { loading, report, filter, onFilterChange, onClose, deliveryCounts } =
    props;
  // Default ON — the standard description is the single biggest aid
  // for parents and students reading the printed sheet. Teachers who
  // prefer a denser printout can toggle it off before printing.
  const [showDescriptions, setShowDescriptions] = useState(true);

  const subjectLabel = (s: string | undefined) => {
    if (!s) return "";
    if (s === "ela") return "ELA";
    if (s === "math") return "Math";
    if (s === "algebra1") return "Algebra 1";
    if (s === "geometry") return "Geometry";
    if (s === "writing") return "Writing";
    return s.toUpperCase();
  };

  // Group benchmarks by category for the leftmost label column.
  const grouped = useMemo(() => {
    if (!report) return [] as Array<{ category: string; codes: Benchmark[] }>;
    const out: Array<{ category: string; codes: Benchmark[] }> = [];
    for (const b of report.benchmarks) {
      const cat = b.category ?? "Other";
      const last = out[out.length - 1];
      if (last && last.category === cat) {
        last.codes.push(b);
      } else {
        out.push({ category: cat, codes: [b] });
      }
    }
    return out;
  }, [report]);

  const visibleStudents = useMemo(() => {
    if (!report) return [] as ReportStudent[];
    if (filter === "all") return report.students;
    return report.students.filter((s) => s.studentId === filter);
  }, [report, filter]);

  const WINDOWS: Array<"pm1" | "pm2" | "pm3"> = ["pm1", "pm2", "pm3"];
  const winLabel: Record<string, string> = {
    pm1: "PM1",
    pm2: "PM2",
    pm3: "PM3",
  };

  return (
    <>
      <style>{`
        @media print {
          @page { size: letter portrait; margin: 0.35in; }
          body * { visibility: hidden !important; }
          .progress-report-print, .progress-report-print * {
            visibility: visible !important;
          }
          .progress-report-print {
            position: absolute !important;
            left: 0; top: 0; width: 100%;
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
            box-shadow: none !important;
            overflow: visible !important;
          }
          .progress-report-toolbar { display: none !important; }
          .progress-report-backdrop {
            position: static !important;
            background: white !important;
            inset: auto !important;
            overflow: visible !important;
          }
          .progress-report-page {
            page-break-after: always;
            break-after: page;
            box-shadow: none !important;
            border: none !important;
            margin: 0 !important;
            width: auto !important;
            max-width: 100% !important;
            padding: 0 !important;
            min-height: 0 !important;
          }
          .progress-report-page:last-child {
            page-break-after: auto;
            break-after: auto;
          }
          .progress-report-page table { font-size: 8.5px !important; }
          .progress-report-page th,
          .progress-report-page td {
            padding: 2px 4px !important;
          }
          .item-chip { font-size: 7.5px !important; padding: 0 3px !important; }
        }
        .progress-report-print.no-descriptions .benchmark-description {
          display: none !important;
        }
        .progress-report-page .pill {
          display: inline-block;
          padding: 1px 6px;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 700;
          white-space: nowrap;
        }
        .progress-report-page .pill-mastered { background: #bbf7d0; color: #14532d; }
        .progress-report-page .pill-approach { background: #fef3c7; color: #78350f; }
        .progress-report-page .pill-needs { background: #fecaca; color: #7f1d1d; }
        .progress-report-page .pill-na { background: #e5e7eb; color: #6b7280; }
        .benchmark-description {
          font-size: 8.5px;
          color: #4b5563;
          line-height: 1.25;
          margin-top: 3px;
          font-style: italic;
        }
        .cls-median {
          font-size: 7.5px;
          color: #6b7280;
          font-weight: 500;
          margin-top: 1px;
        }
        .progress-report-page {
          background: white;
          width: 7.7in;
          min-height: 10in;
          margin: 0 auto 16px auto;
          padding: 0.3in;
          box-shadow: 0 1px 4px rgba(0,0,0,0.15);
          box-sizing: border-box;
        }
        .progress-report-page table { border-collapse: collapse; width: 100%; }
        .progress-report-page th, .progress-report-page td {
          border: 1px solid #d1d5db;
          padding: 3px 5px;
          font-size: 9px;
          vertical-align: top;
        }
        .progress-report-page th {
          background: #f3f4f6;
          font-weight: 700;
          text-align: left;
        }
        .item-chip {
          display: inline-block;
          padding: 1px 4px;
          margin: 1px 2px 1px 0;
          border-radius: 3px;
          font-size: 8px;
          font-family: monospace;
          font-weight: 600;
        }
        .item-chip.correct { background: #bbf7d0; color: #14532d; }
        .item-chip.wrong { background: #fecaca; color: #7f1d1d; }
        .item-chip.partial { background: #fef3c7; color: #78350f; }
      `}</style>

      <div
        className="progress-report-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15,23,42,0.55)",
          zIndex: 1000,
          overflow: "auto",
          padding: "20px 0",
        }}
      >
        <div
          className="progress-report-toolbar"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "flex",
            gap: 12,
            alignItems: "center",
            background: "white",
            padding: "10px 16px",
            margin: "0 auto 14px auto",
            width: "10.5in",
            maxWidth: "calc(100% - 32px)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            borderRadius: 6,
            boxSizing: "border-box",
          }}
        >
          <strong style={{ fontSize: 14 }}>
            Benchmark Progress Report
            {report && (
              <span style={{ color: "#6b7280", fontWeight: 400, marginLeft: 8 }}>
                · {subjectLabel(report.subject)} · {report.schoolYear}
              </span>
            )}
          </strong>
          <span style={{ flex: 1 }} />
          <label style={{ fontSize: 12, color: "#374151" }}>
            Show:&nbsp;
            <select
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
              style={{ fontSize: 12 }}
              disabled={!report}
            >
              <option value="all">All students (alpha)</option>
              {report?.students.map((s) => (
                <option key={s.studentId} value={s.studentId}>
                  {s.lastName}, {s.firstName}
                </option>
              ))}
            </select>
          </label>
          <label
            style={{
              fontSize: 12,
              color: "#374151",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            title="Show one-line standard descriptions under each benchmark code"
          >
            <input
              type="checkbox"
              checked={showDescriptions}
              onChange={(e) => setShowDescriptions(e.target.checked)}
            />
            Descriptions
          </label>
          <button
            onClick={() => window.print()}
            disabled={!report || report.students.length === 0}
            style={{ padding: "4px 12px" }}
          >
            Print
          </button>
          <button onClick={onClose} style={{ padding: "4px 12px" }}>
            Close
          </button>
        </div>

        <div
          className={`progress-report-print${
            showDescriptions ? "" : " no-descriptions"
          }`}
        >
          {loading && (
            <div
              style={{
                background: "white",
                padding: 20,
                margin: "0 auto",
                width: "10.5in",
                maxWidth: "calc(100% - 32px)",
                borderRadius: 6,
                boxSizing: "border-box",
              }}
            >
              Loading report…
            </div>
          )}
          {!loading && report && visibleStudents.length === 0 && (
            <div
              style={{
                background: "white",
                padding: 20,
                margin: "0 auto",
                width: "10.5in",
                maxWidth: "calc(100% - 32px)",
                borderRadius: 6,
                boxSizing: "border-box",
              }}
            >
              No students to show.
            </div>
          )}
          {!loading &&
            report &&
            visibleStudents.map((s) => {
              const winTotals = WINDOWS.map((w) => {
                let earned = 0;
                let possible = 0;
                for (const code of Object.keys(s.windows[w])) {
                  const c = s.windows[w][code];
                  if (c) {
                    earned += c.earned;
                    possible += c.possible;
                  }
                }
                return {
                  w,
                  earned,
                  possible,
                  pct:
                    possible > 0
                      ? Math.round((earned / possible) * 100)
                      : null,
                };
              });
              const pcts = winTotals
                .map((t) => t.pct)
                .filter((p): p is number => p != null);
              const overallDelta =
                pcts.length >= 2 ? pcts[pcts.length - 1]! - pcts[0]! : null;
              const trend: {
                label: string;
                bg: string;
                fg: string;
              } =
                overallDelta == null
                  ? { label: "Just getting started", bg: "#e0e7ff", fg: "#3730a3" }
                  : overallDelta >= 10
                  ? { label: "Trending up ▲", bg: "#bbf7d0", fg: "#14532d" }
                  : overallDelta >= 0
                  ? { label: "Holding steady", bg: "#fef3c7", fg: "#78350f" }
                  : { label: "Needs focus", bg: "#fecaca", fg: "#7f1d1d" };
              type Jump = {
                code: string;
                from: number;
                to: number;
                delta: number;
                fromW: "pm1" | "pm2" | "pm3";
                toW: "pm1" | "pm2" | "pm3";
              };
              const jumps: Jump[] = [];
              for (const b of report.benchmarks) {
                const cells = WINDOWS.map((w) => ({
                  w,
                  c: s.windows[w][b.code],
                }));
                for (let i = 0; i < cells.length; i++) {
                  for (let j = i + 1; j < cells.length; j++) {
                    const a = cells[i].c;
                    const z = cells[j].c;
                    if (a && z && z.pct - a.pct > 0) {
                      jumps.push({
                        code: b.code,
                        from: a.pct,
                        to: z.pct,
                        delta: z.pct - a.pct,
                        fromW: cells[i].w,
                        toW: cells[j].w,
                      });
                    }
                  }
                }
              }
              const seen = new Set<string>();
              const topJumps = jumps
                .sort((a, b) => b.delta - a.delta)
                .filter((j) => {
                  if (seen.has(j.code)) return false;
                  seen.add(j.code);
                  return true;
                })
                .slice(0, 3);
              return (
              <div key={s.studentId} className="progress-report-page">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                    borderBottom: "2px solid #1e3a8a",
                    paddingBottom: 6,
                    marginBottom: 10,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>
                      {s.lastName}, {s.firstName}
                    </div>
                    <div style={{ fontSize: 11, color: "#374151", marginTop: 2 }}>
                      Grade {s.grade}
                      {" · Teacher: "}
                      {report.teacher.displayName ?? "—"}
                      {" · Period: "}
                      {s.periods.length > 0 ? s.periods.join(", ") : "—"}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 11, color: "#374151" }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      {subjectLabel(report.subject)} · {report.schoolYear}
                    </div>
                    <div>FAST Benchmark Progress</div>
                    <div style={{ color: "#6b7280" }}>
                      Mastery ≥ {report.thresholdPct}%
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 12,
                    alignItems: "center",
                    background:
                      "linear-gradient(135deg, #eff6ff 0%, #ede9fe 100%)",
                    border: "1px solid #c7d2fe",
                    borderRadius: 8,
                    padding: "10px 14px",
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    {winTotals.map((t, i) => {
                      const pct = t.pct;
                      const scale = s.scales[t.w];
                      // Level color comes from FAST level when available
                      // (the canonical mastery signal), otherwise falls
                      // back to the item % bucketing.
                      const LEVEL_PALETTE: Record<
                        1 | 2 | 3 | 4 | 5,
                        { bg: string; fg: string; ring: string }
                      > = {
                        1: { bg: "#fecaca", fg: "#7f1d1d", ring: "#dc2626" },
                        2: { bg: "#fed7aa", fg: "#7c2d12", ring: "#ea580c" },
                        3: { bg: "#bbf7d0", fg: "#14532d", ring: "#16a34a" },
                        4: { bg: "#bfdbfe", fg: "#1e3a8a", ring: "#2563eb" },
                        5: { bg: "#e9d5ff", fg: "#581c87", ring: "#9333ea" },
                      };
                      let gaugeBg = "#e5e7eb";
                      let gaugeFg = "#6b7280";
                      let ring = "#cbd5e1";
                      if (scale) {
                        const p = LEVEL_PALETTE[scale.level];
                        gaugeBg = p.bg;
                        gaugeFg = p.fg;
                        ring = p.ring;
                      } else if (pct != null) {
                        if (pct >= report.thresholdPct) {
                          gaugeBg = "#bbf7d0";
                          gaugeFg = "#14532d";
                          ring = "#16a34a";
                        } else if (pct >= 50) {
                          gaugeBg = "#fef3c7";
                          gaugeFg = "#78350f";
                          ring = "#d97706";
                        } else {
                          gaugeBg = "#fecaca";
                          gaugeFg = "#7f1d1d";
                          ring = "#dc2626";
                        }
                      }
                      const prevPct = i > 0 ? winTotals[i - 1].pct : null;
                      const delta =
                        pct != null && prevPct != null ? pct - prevPct : null;
                      const prevScale =
                        i > 0 ? s.scales[winTotals[i - 1].w] : null;
                      const levelDelta =
                        scale && prevScale ? scale.level - prevScale.level : 0;
                      return (
                        <React.Fragment key={t.w}>
                          {i > 0 && (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                fontSize: 10,
                                color: "#374151",
                                minWidth: 44,
                              }}
                            >
                              <div style={{ fontSize: 18, lineHeight: 1 }}>
                                →
                              </div>
                              {delta != null && (
                                <div
                                  style={{
                                    fontWeight: 700,
                                    color:
                                      delta > 0
                                        ? "#14532d"
                                        : delta < 0
                                        ? "#7f1d1d"
                                        : "#374151",
                                    marginTop: 2,
                                  }}
                                >
                                  {delta > 0 ? "+" : ""}
                                  {delta}%
                                </div>
                              )}
                              {scale && prevScale && (
                                <div
                                  style={{
                                    fontWeight: 700,
                                    fontSize: 9,
                                    marginTop: 1,
                                    color:
                                      scale.subLevel !== prevScale.subLevel
                                        ? levelDelta > 0 ||
                                          (levelDelta === 0 &&
                                            scale.subLevel > prevScale.subLevel)
                                          ? "#14532d"
                                          : "#7f1d1d"
                                        : "#374151",
                                  }}
                                >
                                  L{prevScale.subLevel}→L{scale.subLevel}
                                  {scale.subLevel > prevScale.subLevel
                                    ? " ▲"
                                    : scale.subLevel < prevScale.subLevel
                                    ? " ▼"
                                    : ""}
                                </div>
                              )}
                            </div>
                          )}
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                            }}
                          >
                            <div
                              style={{
                                position: "relative",
                                width: 64,
                                height: 64,
                              }}
                            >
                              <div
                                style={{
                                  width: 64,
                                  height: 64,
                                  borderRadius: "50%",
                                  background: gaugeBg,
                                  border: `3px solid ${ring}`,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontWeight: 800,
                                  fontSize: 16,
                                  color: gaugeFg,
                                }}
                              >
                                {pct == null ? "—" : `${pct}%`}
                              </div>
                              {scale && (
                                <div
                                  style={{
                                    position: "absolute",
                                    top: -4,
                                    right: -4,
                                    background: ring,
                                    color: "white",
                                    borderRadius: 999,
                                    minWidth: 22,
                                    height: 22,
                                    padding: "0 5px",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: 800,
                                    fontSize: 11,
                                    border: "2px solid white",
                                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                                  }}
                                  title={`Sub-level ${scale.subLevel} (${scale.subLevelLabel})`}
                                >
                                  L{scale.subLevel}
                                </div>
                              )}
                            </div>
                            <div
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color: "#374151",
                                marginTop: 3,
                              }}
                            >
                              {winLabel[t.w]}
                            </div>
                            {scale ? (
                              <div
                                style={{
                                  fontSize: 9,
                                  color: "#374151",
                                  fontWeight: 600,
                                }}
                              >
                                {scale.score} · {scale.subLevelLabel}
                              </div>
                            ) : pct != null ? (
                              <div style={{ fontSize: 9, color: "#6b7280" }}>
                                {t.earned}/{t.possible}
                              </div>
                            ) : null}
                            {scale &&
                              scale.gap != null &&
                              scale.nextStopLabel != null && (
                                <div
                                  style={{
                                    fontSize: 8,
                                    color:
                                      scale.gap <= 0 ? "#14532d" : "#3730a3",
                                    fontWeight: 600,
                                    marginTop: 1,
                                    textAlign: "center",
                                    lineHeight: 1.2,
                                  }}
                                >
                                  {scale.gap <= 0
                                    ? `At ${scale.nextStopLabel}`
                                    : `+${scale.gap} → ${scale.nextStopLabel}`}
                                </div>
                              )}
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        color: "#3730a3",
                      }}
                    >
                      Growth at a Glance
                    </div>
                    <div
                      style={{
                        background: trend.bg,
                        color: trend.fg,
                        padding: "4px 10px",
                        borderRadius: 999,
                        fontWeight: 700,
                        fontSize: 11,
                      }}
                    >
                      {trend.label}
                    </div>
                    {overallDelta != null && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "#374151",
                        }}
                      >
                        Overall change:{" "}
                        <span
                          style={{
                            fontWeight: 700,
                            color:
                              overallDelta > 0
                                ? "#14532d"
                                : overallDelta < 0
                                ? "#7f1d1d"
                                : "#374151",
                          }}
                        >
                          {overallDelta > 0 ? "+" : ""}
                          {overallDelta}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {report.benchmarks.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#6b7280" }}>
                    No FAST item-level data for {report.schoolYear} yet — the
                    first administration will populate this report.
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: "24%" }}>Benchmark</th>
                        {WINDOWS.map((w) => (
                          <th key={w} style={{ width: "16%" }}>
                            {winLabel[w]}
                          </th>
                        ))}
                        <th style={{ width: "14%" }}>Trend</th>
                        <th style={{ width: "14%" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped.map((g) => {
                        // Per-category sparkline for THIS student: average
                        // of available benchmark pcts in the category per
                        // window, so the header bar tells the same growth
                        // story as the rows beneath it.
                        const catSeries = WINDOWS.map((w) => {
                          const vals: number[] = [];
                          for (const b of g.codes) {
                            const cc = s.windows[w][b.code];
                            if (cc) vals.push(cc.pct);
                          }
                          if (vals.length === 0) return null;
                          return Math.round(
                            vals.reduce((a, v) => a + v, 0) / vals.length,
                          );
                        });
                        return (
                        <React.Fragment key={g.category}>
                          <tr>
                            <td
                              colSpan={6}
                              style={{
                                background: "#dbeafe",
                                fontWeight: 700,
                                fontSize: 10,
                                color: "#1e3a8a",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  gap: 8,
                                }}
                              >
                                <span>{g.category}</span>
                                <span
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 6,
                                    color: "#1e3a8a",
                                    fontWeight: 600,
                                    fontSize: 9,
                                  }}
                                  title="Average across this category, PM1 → PM3"
                                >
                                  <span style={{ opacity: 0.7 }}>
                                    cat avg
                                  </span>
                                  <Sparkline
                                    values={catSeries}
                                    threshold={report.thresholdPct}
                                    width={72}
                                    height={20}
                                    stroke="#1e3a8a"
                                  />
                                </span>
                              </div>
                            </td>
                          </tr>
                          {g.codes.map((b) => {
                            const rowSeries = WINDOWS.map((w) => {
                              const cc = s.windows[w][b.code];
                              return cc ? cc.pct : null;
                            });
                            const lastIdx = (() => {
                              for (let i = rowSeries.length - 1; i >= 0; i--) {
                                if (rowSeries[i] != null) return i;
                              }
                              return -1;
                            })();
                            const latestPct =
                              lastIdx >= 0 ? rowSeries[lastIdx] : null;
                            let pillCls = "pill-na";
                            let pillTxt = "—";
                            if (latestPct != null) {
                              if (latestPct >= report.thresholdPct) {
                                pillCls = "pill-mastered";
                                pillTxt = "Mastered";
                              } else if (latestPct >= 50) {
                                pillCls = "pill-approach";
                                pillTxt = "Approaching";
                              } else {
                                pillCls = "pill-needs";
                                pillTxt = "Needs support";
                              }
                            }
                            return (
                            <tr key={b.code}>
                              <td style={{ fontSize: 10, verticalAlign: "top" }}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    marginBottom: 4,
                                  }}
                                >
                                  <BenchmarkStar
                                    count={
                                      deliveryCounts[b.code]?.count ?? 0
                                    }
                                    lastTaughtOn={
                                      deliveryCounts[b.code]?.lastTaughtOn ??
                                      null
                                    }
                                    size={26}
                                  />
                                  <span
                                    style={{
                                      fontFamily: "monospace",
                                      fontWeight: 600,
                                    }}
                                  >
                                    {b.code}
                                  </span>
                                </div>
                                {b.label && (
                                  <div className="benchmark-description">
                                    {b.label}
                                  </div>
                                )}
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "1fr 1fr 1fr",
                                    border: "1px solid #cbd5e1",
                                    borderRadius: 3,
                                    overflow: "hidden",
                                    fontSize: 9,
                                    marginTop: 4,
                                  }}
                                >
                                  {WINDOWS.map((w, wi) => {
                                    const cc = s.windows[w][b.code];
                                    const pct = cc ? cc.pct : null;
                                    const cmed =
                                      report.classMedians?.[b.code]?.[w] ??
                                      null;
                                    let bg = "#f3f4f6";
                                    let fg = "#6b7280";
                                    if (pct != null) {
                                      if (pct >= report.thresholdPct) {
                                        bg = "#bbf7d0";
                                        fg = "#14532d";
                                      } else if (pct >= 50) {
                                        bg = "#fef3c7";
                                        fg = "#78350f";
                                      } else {
                                        bg = "#fecaca";
                                        fg = "#7f1d1d";
                                      }
                                    }
                                    return (
                                      <div
                                        key={w}
                                        style={{
                                          background: bg,
                                          color: fg,
                                          padding: "2px 3px",
                                          textAlign: "center",
                                          borderLeft:
                                            wi === 0
                                              ? undefined
                                              : "1px solid #cbd5e1",
                                          fontWeight: 600,
                                        }}
                                      >
                                        <div
                                          style={{
                                            fontSize: 8,
                                            opacity: 0.75,
                                            fontWeight: 500,
                                          }}
                                        >
                                          {winLabel[w]}
                                        </div>
                                        <div>{pct == null ? "—" : `${pct}%`}</div>
                                        {cmed != null && (
                                          <div className="cls-median">
                                            cls {cmed}%
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </td>
                              {WINDOWS.map((w) => {
                                const cell = s.windows[w][b.code];
                                if (!cell) {
                                  return (
                                    <td
                                      key={w}
                                      style={{
                                        color: "#9ca3af",
                                        fontStyle: "italic",
                                        fontSize: 9,
                                      }}
                                    >
                                      {winLabel[w]} — coming up. Keep working!
                                    </td>
                                  );
                                }
                                return (
                                  <td key={w}>
                                    <div>
                                      {cell.items.map((it, idx) => {
                                        const earned = it.pointsEarned ?? 0;
                                        const possible = it.pointsPossible ?? 0;
                                        let cls = "wrong";
                                        if (possible > 0 && earned === possible) {
                                          cls = "correct";
                                        } else if (possible > 0 && earned > 0) {
                                          cls = "partial";
                                        }
                                        return (
                                          <span
                                            key={it.itemSeq}
                                            className={`item-chip ${cls}`}
                                          >
                                            #{it.itemSeq + 1}: {earned}/
                                            {possible}
                                          </span>
                                        );
                                      })}
                                    </div>
                                    <div
                                      style={{
                                        marginTop: 3,
                                        fontSize: 10,
                                        fontWeight: 700,
                                        color:
                                          cell.pct >= report.thresholdPct
                                            ? "#14532d"
                                            : "#7f1d1d",
                                      }}
                                    >
                                      {cell.earned}/{cell.possible} · {cell.pct}%
                                    </div>
                                  </td>
                                );
                              })}
                              <td
                                style={{
                                  textAlign: "center",
                                  verticalAlign: "middle",
                                }}
                              >
                                <Sparkline
                                  values={rowSeries}
                                  threshold={report.thresholdPct}
                                  width={64}
                                  height={22}
                                />
                              </td>
                              <td
                                style={{
                                  textAlign: "center",
                                  verticalAlign: "middle",
                                }}
                              >
                                <span className={`pill ${pillCls}`}>
                                  {pillTxt}
                                </span>
                              </td>
                            </tr>
                            );
                          })}
                        </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {topJumps.length > 0 && (
                  <div
                    style={{
                      marginTop: 10,
                      background:
                        "linear-gradient(135deg, #f0fdf4 0%, #ecfeff 100%)",
                      border: "1px solid #bbf7d0",
                      borderRadius: 8,
                      padding: "8px 12px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        color: "#14532d",
                        marginBottom: 6,
                      }}
                    >
                      🎉 Growth Highlights — biggest jumps this year
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${topJumps.length}, 1fr)`,
                        gap: 8,
                      }}
                    >
                      {topJumps.map((j) => (
                        <div
                          key={j.code}
                          style={{
                            background: "white",
                            border: "1px solid #86efac",
                            borderRadius: 6,
                            padding: "6px 8px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 3,
                          }}
                        >
                          <div
                            style={{
                              fontFamily: "monospace",
                              fontSize: 10,
                              fontWeight: 700,
                              color: "#1e3a8a",
                            }}
                          >
                            {j.code}
                          </div>
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 800,
                              color: "#14532d",
                            }}
                          >
                            +{j.delta}%
                          </div>
                          <div
                            style={{
                              fontSize: 9,
                              color: "#374151",
                            }}
                          >
                            {winLabel[j.fromW]} {j.from}% → {winLabel[j.toW]}{" "}
                            {j.to}%
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div
                  style={{
                    marginTop: 10,
                    fontSize: 9,
                    color: "#6b7280",
                    fontStyle: "italic",
                  }}
                >
                  Each PM column shows individual items: green = full credit,
                  yellow = partial, pink = missed. Compare PM1 → PM2 → PM3 to
                  see growth.
                </div>
              </div>
              );
            })}
        </div>
      </div>
    </>
  );
}
