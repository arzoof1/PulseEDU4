import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";
// MTSS Reports — trends + charts page for the Core Team.
//
// Two modes, same component:
//   - Standalone: pass no `planId`. The user picks filters across
//     every active plan in the school.
//   - Per-plan: pass `planId`. Shows that plan's metadata up top,
//     and unlocks the "Since plan opened" date preset.
//
// Tier 2 and Tier 3 are different measurements (T2 = % completion,
// T3 = 1–5 outcome score), so the report is TABBED: each tier renders
// its own clean set of charts. There is no combined / "all tiers"
// view — mixing a completion % with a 1–5 score on one axis is
// apples-to-oranges.
//
// Per-plan mode: both tier tabs render, but a tier is greyed out
// (disabled with a "No Tier X history" hint) when the student has no
// plan of that tier. Clicking the other tier loads that student's
// most-recent plan of that tier. The default tab is the tier of the
// plan you opened.
//
// "Print" uses the browser print dialog plus a print stylesheet
// that strips away the chrome (filters, back button, etc.) so the
// resulting PDF is presentation-ready.
import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";
import { authFetch } from "../lib/authToken";

// ---------------- types ----------------

type RangePreset = "7" | "30" | "60" | "90" | "sinceOpened";

interface SummaryResponse {
  rangeStart: string;
  rangeEnd: string;
  schoolDayCount: number;
  plansIncluded: number;
  filters: {
    range: string;
    planId: number | null;
    tier: number | null;
    subType: string | null;
    grade: string | null;
    teacherStaffId: number | null;
    planType: "behavior" | "academic" | null;
    academicSubject: "ela" | "math" | null;
  };
  planMeta: {
    id: number;
    studentId: string;
    studentName: string;
    grade: string | null;
    tier: number;
    subType: string | null;
    fastSubject: string | null;
    subjectLabel: string;
    academicMinutesTarget: number | null;
    title: string;
    goals: string | null;
    openedAt: string;
    closedAt: string | null;
    autoAssignScheduleTeachers: boolean;
    effectiveTeachers: { id: number; displayName: string }[];
  } | null;
  weeklyTrend: Array<{
    weekStartDate: string;
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
    t3Scored: number;
    t3ScoreSum: number;
    t3AvgScorePct: number | null;
  }>;
  perTeacher: Array<{
    teacherStaffId: number;
    teacherName: string;
    subjects: string[];
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
    t3ScoredCount: number;
    t3AvgScore: number | null;
    acadMet: number;
    acadOwed: number;
    acadExcused: number;
    acadMinutes: number;
    acadAvgMinutes: number | null;
  }>;
  perSubject: Array<{
    courseName: string;
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
  }>;
  dayOfWeek: Array<{
    dow: number;
    label: string;
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
  }>;
  t3GoalTrend: Array<{
    weekStartDate: string;
    avgScore: number | null;
    scoredCount: number;
  }>;
  t3DayOfWeek: Array<{
    dow: number;
    label: string;
    avgScore: number | null;
    scoredCount: number;
  }>;
  t3Academic: {
    target: number | null;
    completion: {
      met: number;
      owed: number;
      excused: number;
      total: number;
    };
    trend: Array<{
      weekStartDate: string;
      minutesSum: number;
      recordCount: number;
      avgMinutes: number | null;
      met: number;
      owed: number;
      excused: number;
    }>;
    dayOfWeek: Array<{ dow: number; label: string; minutes: number }>;
  };
  studentPlans: Array<{
    id: number;
    tier: number;
    title: string;
    subType: string | null;
    fastSubject: string | null;
    subjectLabel: string;
    openedAt: string;
    closedAt: string | null;
  }> | null;
}

interface StaffOption {
  id: number;
  displayName: string;
}

interface Props {
  onBack: () => void;
  // When provided, page locks to this plan and offers per-plan presets.
  planId?: number;
  // Optional: pre-known plan title, used while the summary is loading.
  initialPlanTitle?: string;
}

// ---------------- helpers ----------------

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}

function fmtScore(v: number | null): string {
  if (v == null) return "—";
  return v.toFixed(2);
}

// Small color-coded segment chip ("Behavior" / "ELA" / "Math") shown
// on plan + per-teacher rows so readers can tell a behavior plan from
// an academic one at a glance.
function SubjectChip({ label }: { label: string }) {
  const palette: Record<string, { bg: string; fg: string; bd: string }> = {
    Behavior: { bg: "#fef2f2", fg: "#991b1b", bd: "#fecaca" },
    ELA: { bg: "#eff6ff", fg: "#1e40af", bd: "#bfdbfe" },
    Math: { bg: "#ecfdf5", fg: "#065f46", bd: "#a7f3d0" },
  };
  const c = palette[label] ?? { bg: "#f1f5f9", fg: "#334155", bd: "#cbd5e1" };
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "0.68rem",
        fontWeight: 700,
        lineHeight: 1.4,
        padding: "1px 7px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// Color the T2 dow heatmap from completion% (0=red, 100=green).
function heatColor(pct: number | null): string {
  if (pct == null) return "#e5e7eb";
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped >= 90) return "#16a34a";
  if (clamped >= 80) return "#65a30d";
  if (clamped >= 70) return "#ca8a04";
  if (clamped >= 50) return "#ea580c";
  return "#dc2626";
}

// Color the T3 dow heatmap from a 1–5 outcome score.
function scoreColor(avg: number | null): string {
  if (avg == null) return "#e5e7eb";
  if (avg >= 4) return "#16a34a";
  if (avg >= 3.5) return "#65a30d";
  if (avg >= 3) return "#ca8a04";
  if (avg >= 2.5) return "#ea580c";
  return "#dc2626";
}

type TrendDir = "improving" | "declining" | "plateau" | null;

// Compare the mean of the first third of the series to the mean of the
// last third. `threshold` is the minimum change that counts as a real
// move (in the series' own units — %-points for T2, score-points for
// T3). Fewer than 3 points → not enough signal, returns null.
function computeTrend(values: number[], threshold: number): TrendDir {
  if (values.length < 3) return null;
  const k = Math.max(1, Math.floor(values.length / 3));
  const head = values.slice(0, k);
  const tail = values.slice(-k);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const d = mean(tail) - mean(head);
  if (d > threshold) return "improving";
  if (d < -threshold) return "declining";
  return "plateau";
}

function trendBadge(t: TrendDir): {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
} {
  switch (t) {
    case "improving":
      return { label: "↑ Improving", tone: "good" };
    case "declining":
      return { label: "↓ Declining", tone: "bad" };
    case "plateau":
      return { label: "→ Plateau", tone: "warn" };
    default:
      return { label: "—", tone: "neutral" };
  }
}

// ---------------- component ----------------

export default function MtssReportsPage({
  onBack,
  planId,
  initialPlanTitle,
}: Props) {
  const isPerPlan = planId != null;

  // ---- tier tabs ----
  // In per-plan mode `viewPlanId` is the plan currently displayed;
  // clicking the other tier's tab swaps it to that student's
  // most-recent plan of that tier. In aggregate mode `activeTier`
  // drives the tier= filter.
  const [viewPlanId, setViewPlanId] = useState<number | undefined>(planId);
  useEffect(() => {
    setViewPlanId(planId);
  }, [planId]);
  const [activeTier, setActiveTier] = useState<2 | 3>(2);

  // ---- filters ----
  const [range, setRange] = useState<RangePreset>("30");
  const [subType, setSubType] = useState<string>("");
  const [grade, setGrade] = useState<string>("");
  const [teacherStaffId, setTeacherStaffId] = useState<number | "">("");
  // Academic/Behavior segment (Tier 3 aggregate tab only). "" = all.
  const [planType, setPlanType] = useState<"" | "behavior" | "academic">("");
  const [academicSubject, setAcademicSubject] = useState<"" | "ela" | "math">(
    "",
  );

  // ---- data ----
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Teacher list for the filter dropdown. Uses the core-team-aware
  // /api/teacher-roster/teachers endpoint instead of the
  // admin-only /api/admin/staff so MTSS coordinators / behavior
  // specialists / PBIS coords don't get a 403 + empty dropdown.
  const [staffOpts, setStaffOpts] = useState<StaffOption[]>([]);
  useEffect(() => {
    if (isPerPlan) return; // not needed in per-plan mode
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch("/api/teacher-roster/teachers");
        if (!r.ok) return;
        const j = (await r.json()) as {
          teachers?: Array<{ id: number; displayName: string }>;
        };
        const arr = j.teachers ?? [];
        if (cancelled) return;
        setStaffOpts(
          arr
            .map((s) => ({ id: s.id, displayName: s.displayName }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName)),
        );
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPerPlan]);

  // ---- fetch summary on filter change ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams();
        params.set("range", range);
        if (isPerPlan) {
          if (viewPlanId) params.set("planId", String(viewPlanId));
        } else {
          params.set("tier", String(activeTier));
          if (subType) params.set("subType", subType);
          if (grade) params.set("grade", grade);
          if (teacherStaffId !== "")
            params.set("teacherStaffId", String(teacherStaffId));
          // Behavior/Academic split is a Tier 3 concern (Tier 2
          // academic is "light" with no records), so only send it on
          // the Tier 3 tab.
          if (activeTier === 3 && planType) {
            params.set("planType", planType);
            if (planType === "academic" && academicSubject)
              params.set("academicSubject", academicSubject);
          }
        }
        const r = await authFetch(
          `/api/mtss-reports/summary?${params.toString()}`,
        );
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(t || `${r.status} ${r.statusText}`);
        }
        const j = (await r.json()) as SummaryResponse;
        if (cancelled) return;
        setData(j);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Failed to load report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    range,
    isPerPlan,
    viewPlanId,
    activeTier,
    subType,
    grade,
    teacherStaffId,
    planType,
    academicSubject,
  ]);

  // Keep the academic subject sub-choice clean: clear it whenever the
  // segment isn't "academic" so a stale ELA/Math param can't ride along.
  useEffect(() => {
    if (planType !== "academic" && academicSubject !== "")
      setAcademicSubject("");
  }, [planType, academicSubject]);

  // In per-plan mode the active tab follows the viewed plan's tier so
  // the tab highlight stays in sync after the data loads (or after a
  // tier switch resolves to a different plan).
  useEffect(() => {
    if (isPerPlan && data?.planMeta) {
      setActiveTier(data.planMeta.tier === 3 ? 3 : 2);
    }
  }, [isPerPlan, data?.planMeta?.id, data?.planMeta?.tier]);

  // ---- tab state (per-plan gating) ----
  const studentPlans = data?.studentPlans ?? null;
  const hasTier2 = isPerPlan ? !!studentPlans?.some((p) => p.tier === 2) : true;
  const hasTier3 = isPerPlan ? !!studentPlans?.some((p) => p.tier === 3) : true;

  function selectTier(t: 2 | 3) {
    if (t === activeTier) return;
    if (isPerPlan) {
      // studentPlans is sorted most-recent-first, so .find lands on the
      // newest plan of that tier.
      const target = studentPlans?.find((p) => p.tier === t);
      if (!target) return; // tab is disabled — nothing to switch to
      setActiveTier(t);
      setViewPlanId(target.id);
    } else {
      setActiveTier(t);
    }
  }

  // ---- derived ----
  const overallT2 = useMemo(() => {
    if (!data) return null;
    let c = 0;
    let e = 0;
    for (const w of data.weeklyTrend) {
      c += w.t2Completed;
      e += w.t2Expected;
    }
    return e > 0 ? Math.round((c / e) * 1000) / 10 : null;
  }, [data]);
  const overallT3 = useMemo(() => {
    if (!data) return null;
    let s = 0;
    let n = 0;
    for (const w of data.weeklyTrend) {
      s += w.t3ScoreSum;
      n += w.t3Scored;
    }
    return n > 0 ? Math.round((s / n) * 100) / 100 : null;
  }, [data]);

  // Tier-2 average score:
  //   T2 has no numeric outcome score — the closest equivalent is the
  //   per-week completion %, averaged across the weeks in range.
  // Tier-3 completion:
  //   % of weeks in range where at least one teacher logged scores.
  const t2AvgWeeklyScore = useMemo(() => {
    if (!data || data.weeklyTrend.length === 0) return null;
    const weeks = data.weeklyTrend.filter((w) => w.t2CompletionPct !== null);
    if (weeks.length === 0) return null;
    const sum = weeks.reduce((a, w) => a + (w.t2CompletionPct ?? 0), 0);
    return Math.round((sum / weeks.length) * 10) / 10;
  }, [data]);
  const t3Completion = useMemo(() => {
    if (!data || data.weeklyTrend.length === 0) return null;
    const weeksWithScores = data.weeklyTrend.filter(
      (w) => w.t3Scored > 0,
    ).length;
    return Math.round((weeksWithScores / data.weeklyTrend.length) * 1000) / 10;
  }, [data]);

  // Academic (minutes) Tier 3 view: per-plan when the loaded plan has a
  // fastSubject; aggregate when the user picked the Academic segment.
  const isAcademicView = isPerPlan
    ? !!data?.planMeta?.fastSubject
    : data?.filters.planType === "academic";
  const acadMetPct = useMemo(() => {
    const c = data?.t3Academic?.completion;
    if (!c) return null;
    const denom = c.met + c.owed;
    return denom > 0 ? Math.round((c.met / denom) * 1000) / 10 : null;
  }, [data]);
  const acadAvgMinutes = useMemo(() => {
    const t = data?.t3Academic?.trend;
    if (!t || t.length === 0) return null;
    let sum = 0;
    let n = 0;
    for (const w of t) {
      sum += w.minutesSum;
      n += w.recordCount;
    }
    return n > 0 ? Math.round((sum / n) * 10) / 10 : null;
  }, [data]);
  const acadTarget =
    data?.t3Academic?.target ?? data?.planMeta?.academicMinutesTarget ?? 30;

  // Trend direction for the active tier.
  const trend = useMemo<TrendDir>(() => {
    if (!data) return null;
    if (activeTier === 2) {
      const vals = data.weeklyTrend
        .map((w) => w.t2CompletionPct)
        .filter((x): x is number => x != null);
      return computeTrend(vals, 3);
    }
    if (isAcademicView) {
      const vals = (data.t3Academic?.trend ?? [])
        .map((w) => w.avgMinutes)
        .filter((x): x is number => x != null);
      return computeTrend(vals, 2);
    }
    const vals = data.t3GoalTrend
      .map((w) => w.avgScore)
      .filter((x): x is number => x != null);
    return computeTrend(vals, 0.2);
  }, [data, activeTier, isAcademicView]);

  // In per-plan mode a tier switch sets `activeTier` immediately but the
  // loaded `data` still belongs to the previous plan until the re-fetch
  // resolves. Gate the tier content on the loaded plan actually matching
  // the active tab so we never flash the old tier's (now empty) charts.
  const tierMatch =
    !isPerPlan ||
    !data?.planMeta ||
    data.planMeta.tier === activeTier;

  // Best / worst weekday for Tier 3 (by avg outcome score).
  const t3BestWorst = useMemo(() => {
    if (!data) return null;
    // Defensive: tolerate an older API response (deployment skew) that
    // predates the t3DayOfWeek field rather than crashing the page.
    const days = (data.t3DayOfWeek ?? []).filter((d) => d.avgScore != null);
    if (days.length === 0) return null;
    let best = days[0]!;
    let worst = days[0]!;
    for (const d of days) {
      if ((d.avgScore ?? 0) > (best.avgScore ?? 0)) best = d;
      if ((d.avgScore ?? 0) < (worst.avgScore ?? 0)) worst = d;
    }
    return { best, worst };
  }, [data]);

  // ---- styles ----
  const cardStyle: React.CSSProperties = {
    background: "white",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: "0.78rem",
    color: "#64748b",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
    display: "block",
  };
  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    background: "white",
    fontSize: "0.9rem",
    minWidth: 120,
  };

  function segBtnStyle(active: boolean): React.CSSProperties {
    return {
      padding: "5px 12px",
      border: "1px solid",
      borderColor: active ? "#2563eb" : "#cbd5e1",
      background: active ? "#2563eb" : "white",
      color: active ? "white" : "#334155",
      borderRadius: 999,
      fontSize: "0.82rem",
      fontWeight: 600,
      cursor: "pointer",
    };
  }

  function tabStyle(active: boolean, enabled: boolean): React.CSSProperties {
    return {
      padding: "8px 18px",
      border: "1px solid",
      borderColor: active ? "#2563eb" : "#cbd5e1",
      borderRadius: 8,
      background: active ? "#2563eb" : enabled ? "white" : "#f1f5f9",
      color: active ? "white" : enabled ? "#0f172a" : "#94a3b8",
      cursor: enabled ? "pointer" : "not-allowed",
      fontWeight: 700,
      fontSize: "0.95rem",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 2,
      minWidth: 130,
    };
  }

  // ---- render ----
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "12px" }}>
      <style>{`
        @media print {
          .mtss-reports-no-print { display: none !important; }
          .mtss-reports-card { break-inside: avoid; page-break-inside: avoid; }
          body { background: white !important; }
        }
      `}</style>

      {/* ---- header ---- */}
      <div
        className="mtss-reports-no-print"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              padding: "6px 12px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              background: "white",
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
          <h1 style={{ margin: 0, fontSize: "1.4rem" }}>
            {isPerPlan
              ? `Plan Report${
                  data?.planMeta
                    ? ` — ${data.planMeta.studentName}`
                    : initialPlanTitle
                      ? ` — ${initialPlanTitle}`
                      : ""
                }`
              : "MTSS Reports"}
          </h1>
        </div>
        <HowToUseHelp title="How to use MTSS Reports">
          <HowToSection title="What this page is">
            Trend lines and charts for your Tier 2 and Tier 3 plans. The
            two tiers measure different things, so they live on separate
            tabs — switch tiers with the tabs above the filters.
          </HowToSection>
          <HowToSection title="Tier 2 vs Tier 3">
            <ul style={howtoListStyle}>
              <li><strong>Tier 2</strong> — measured by % completion (check-ins logged ÷ check-ins due). It answers "are we doing the plan?"</li>
              <li><strong>Tier 3</strong> — measured by a 1–5 daily outcome score. It answers "is the plan working?"</li>
            </ul>
          </HowToSection>
          <HowToSection title="What the charts mean">
            <ul style={howtoListStyle}>
              <li><strong>Weekly trend</strong> — the tier's headline metric over time, with a trend-direction badge.</li>
              <li><strong>By teacher</strong> — who keeps up with check-ins (T2) and where the student scores best (T3).</li>
              <li><strong>By weekday</strong> — which day teachers log on (T2) and the student's best/worst day (T3).</li>
            </ul>
          </HowToSection>
          <RoleSection for={["mtssCoordinator", "coreTeam"]} title="MTSS Coordinator workflow">
            Review weekly. If Tier 2 completion drops below 60%, open the
            per-plan view to see which kids are missing entries and reach
            out before the cycle ends.
          </RoleSection>
          <RoleSection for="admin" title="What admins see here">
            School-wide MTSS health, one tier at a time. Use the print
            button to export for board / district reporting; the layout
            is already tuned for letter paper.
          </RoleSection>
        </HowToUseHelp>
        <button
          type="button"
          onClick={() => window.print()}
          style={{
            padding: "6px 14px",
            border: "1px solid #2563eb",
            borderRadius: 6,
            background: "#2563eb",
            color: "white",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Print to PDF
        </button>
      </div>

      {/* ---- plan meta (per-plan only) ---- */}
      {isPerPlan && data?.planMeta && (
        <div className="mtss-reports-card" style={cardStyle}>
          <div
            style={{
              display: "flex",
              gap: 24,
              flexWrap: "wrap",
              fontSize: "0.9rem",
            }}
          >
            <div>
              <div style={labelStyle}>Student</div>
              <div style={{ fontWeight: 600 }}>
                {data.planMeta.studentName}{" "}
                {data.planMeta.grade ? `(Grade ${data.planMeta.grade})` : ""}
              </div>
            </div>
            <div>
              <div style={labelStyle}>Tier / Subtype</div>
              <div
                style={{ display: "flex", gap: 8, alignItems: "center" }}
              >
                <span>
                  T{data.planMeta.tier}
                  {data.planMeta.subType ? ` — ${data.planMeta.subType}` : ""}
                </span>
                <SubjectChip label={data.planMeta.subjectLabel} />
              </div>
            </div>
            <div>
              <div style={labelStyle}>Plan title</div>
              <div>{data.planMeta.title}</div>
            </div>
            <div>
              <div style={labelStyle}>Opened</div>
              <div>{data.planMeta.openedAt.slice(0, 10)}</div>
            </div>
            {data.planMeta.closedAt && (
              <div>
                <div style={labelStyle}>Closed</div>
                <div>{data.planMeta.closedAt.slice(0, 10)}</div>
              </div>
            )}
            <div style={{ flex: "1 1 100%" }}>
              <div style={labelStyle}>Effective interventionists</div>
              <div>
                {data.planMeta.effectiveTeachers.length === 0
                  ? "(none — check teacher assignments)"
                  : data.planMeta.effectiveTeachers
                      .map((t) => t.displayName)
                      .join(", ")}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- tier tabs ---- */}
      <div
        className="mtss-reports-no-print"
        style={{ display: "flex", gap: 10, marginBottom: 12 }}
      >
        {([2, 3] as const).map((t) => {
          const enabled = t === 2 ? hasTier2 : hasTier3;
          const active = activeTier === t;
          return (
            <button
              key={t}
              type="button"
              disabled={!enabled}
              onClick={() => selectTier(t)}
              title={
                !enabled
                  ? `No Tier ${t} history for this student`
                  : undefined
              }
              style={tabStyle(active, enabled)}
            >
              <span>Tier {t}</span>
              <span style={{ fontSize: "0.7rem", fontWeight: 600, opacity: 0.85 }}>
                {!enabled
                  ? `No Tier ${t} history`
                  : t === 2
                    ? "% completion"
                    : "1–5 outcome score"}
              </span>
            </button>
          );
        })}
      </div>

      {/* ---- filters ---- */}
      <div
        className="mtss-reports-card mtss-reports-no-print"
        style={cardStyle}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <div>
            <label style={labelStyle} htmlFor="rep-range">
              Date range
            </label>
            <select
              id="rep-range"
              value={range}
              onChange={(e) => setRange(e.target.value as RangePreset)}
              style={inputStyle}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="60">Last 60 days</option>
              <option value="90">Last 90 days</option>
              {isPerPlan && (
                <option value="sinceOpened">Since plan opened</option>
              )}
            </select>
          </div>

          {!isPerPlan && (
            <>
              <div>
                <label style={labelStyle} htmlFor="rep-subtype">
                  Subtype
                </label>
                <input
                  id="rep-subtype"
                  type="text"
                  placeholder="e.g. CICO"
                  value={subType}
                  onChange={(e) => setSubType(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle} htmlFor="rep-grade">
                  Grade
                </label>
                <input
                  id="rep-grade"
                  type="text"
                  placeholder="e.g. 06"
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  style={{ ...inputStyle, minWidth: 80 }}
                />
              </div>
              <div>
                <label style={labelStyle} htmlFor="rep-teacher">
                  Teacher
                </label>
                <select
                  id="rep-teacher"
                  value={teacherStaffId}
                  onChange={(e) =>
                    setTeacherStaffId(
                      e.target.value === ""
                        ? ""
                        : Number(e.target.value),
                    )
                  }
                  style={{ ...inputStyle, minWidth: 200 }}
                >
                  <option value="">All teachers</option>
                  {staffOpts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        {/* Behavior/Academic segment — Tier 3 aggregate tab only. */}
        {!isPerPlan && activeTier === 3 && (
          <div style={{ marginTop: 12 }}>
            <span style={labelStyle}>Plan type</span>
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              {(
                [
                  ["", "All"],
                  ["behavior", "Behavior"],
                  ["academic", "Academic"],
                ] as const
              ).map(([val, lbl]) => {
                const active = planType === val;
                return (
                  <button
                    key={val || "all"}
                    type="button"
                    onClick={() => setPlanType(val)}
                    style={segBtnStyle(active)}
                  >
                    {lbl}
                  </button>
                );
              })}
              {planType === "academic" && (
                <>
                  <span
                    style={{ color: "#cbd5e1", margin: "0 2px" }}
                    aria-hidden="true"
                  >
                    |
                  </span>
                  {(
                    [
                      ["", "All subjects"],
                      ["ela", "ELA"],
                      ["math", "Math"],
                    ] as const
                  ).map(([val, lbl]) => {
                    const active = academicSubject === val;
                    return (
                      <button
                        key={val || "allsub"}
                        type="button"
                        onClick={() => setAcademicSubject(val)}
                        style={segBtnStyle(active)}
                      >
                        {lbl}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ---- error / loading ---- */}
      {err && (
        <div
          className="mtss-reports-card"
          style={{
            ...cardStyle,
            background: "#fef2f2",
            color: "#991b1b",
          }}
        >
          {err}
        </div>
      )}
      {loading && (!data || !tierMatch) && (
        <div className="mtss-reports-card" style={cardStyle}>
          Loading…
        </div>
      )}

      {/* ---- summary tiles (active tier only) ---- */}
      {data && tierMatch && (
        <div
          className="mtss-reports-card"
          style={{
            ...cardStyle,
            display: "grid",
            gap: 12,
          }}
        >
          {isPerPlan && data.planMeta && (
            <div
              style={{
                fontSize: "0.85rem",
                color: "#475569",
                paddingBottom: 4,
                borderBottom: "1px solid #f1f5f9",
              }}
            >
              Showing data for{" "}
              <strong style={{ color: "#0f172a" }}>
                {data.planMeta.studentName}
              </strong>
              {data.planMeta.grade ? ` (Grade ${data.planMeta.grade})` : ""}
              {" · "}
              <span style={{ color: "#64748b" }}>
                T{data.planMeta.tier}
                {data.planMeta.subType ? ` — ${data.planMeta.subType}` : ""}
              </span>
            </div>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            <SummaryTile
              label="Date range"
              value={`${data.rangeStart} → ${data.rangeEnd}`}
              sub={`${data.schoolDayCount} school days`}
            />
            <SummaryTile
              label="Plans included"
              value={String(data.plansIncluded)}
            />
            <SummaryTile
              label={`Tier ${activeTier} trend`}
              value={trendBadge(trend).label}
              sub="First third vs last third of range"
              tone={trendBadge(trend).tone}
            />
          </div>

          {activeTier === 2 ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <SummaryTile
                label="Tier 2 completion"
                value={fmtPct(overallT2)}
                sub="Entries logged ÷ entries expected"
                tone={
                  overallT2 == null
                    ? "neutral"
                    : overallT2 >= 80
                      ? "good"
                      : overallT2 >= 60
                        ? "warn"
                        : "bad"
                }
              />
              <SummaryTile
                label="Tier 2 avg weekly completion"
                value={fmtPct(t2AvgWeeklyScore)}
                sub="Mean of weekly completion %"
                tone={
                  t2AvgWeeklyScore == null
                    ? "neutral"
                    : t2AvgWeeklyScore >= 80
                      ? "good"
                      : t2AvgWeeklyScore >= 60
                        ? "warn"
                        : "bad"
                }
              />
            </div>
          ) : activeTier === 3 && isAcademicView ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <SummaryTile
                label="Minutes target met"
                value={fmtPct(acadMetPct)}
                sub="Weeks met ÷ weeks with a group"
                tone={
                  acadMetPct == null
                    ? "neutral"
                    : acadMetPct >= 80
                      ? "good"
                      : acadMetPct >= 60
                        ? "warn"
                        : "bad"
                }
              />
              <SummaryTile
                label="Avg minutes / week"
                value={acadAvgMinutes == null ? "—" : `${acadAvgMinutes} min`}
                sub={`Target ${acadTarget} min/wk`}
                tone={
                  acadAvgMinutes == null
                    ? "neutral"
                    : acadAvgMinutes >= acadTarget
                      ? "good"
                      : acadAvgMinutes >= acadTarget * 0.6
                        ? "warn"
                        : "bad"
                }
              />
              <SummaryTile
                label="Weeks met"
                value={String(data.t3Academic?.completion.met ?? 0)}
                sub={`${data.t3Academic?.completion.owed ?? 0} owed · ${
                  data.t3Academic?.completion.excused ?? 0
                } excused`}
              />
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <SummaryTile
                label="Tier 3 avg score"
                value={fmtScore(overallT3)}
                sub={overallT3 != null ? "Mean score · out of 5" : "Out of 5"}
                tone={
                  overallT3 == null
                    ? "neutral"
                    : overallT3 >= 4
                      ? "good"
                      : overallT3 >= 3
                        ? "warn"
                        : "bad"
                }
              />
              <SummaryTile
                label="Tier 3 completion"
                value={fmtPct(t3Completion)}
                sub="Weeks with scores ÷ weeks in range"
                tone={
                  t3Completion == null
                    ? "neutral"
                    : t3Completion >= 80
                      ? "good"
                      : t3Completion >= 60
                        ? "warn"
                        : "bad"
                }
              />
              {t3BestWorst && (
                <>
                  <SummaryTile
                    label="Best day"
                    value={t3BestWorst.best.label}
                    sub={`Avg ${fmtScore(t3BestWorst.best.avgScore)} / 5`}
                    tone="good"
                  />
                  <SummaryTile
                    label="Toughest day"
                    value={t3BestWorst.worst.label}
                    sub={`Avg ${fmtScore(t3BestWorst.worst.avgScore)} / 5`}
                    tone="bad"
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- weekly trend (active tier) ---- */}
      {data && tierMatch && activeTier === 2 && data.weeklyTrend.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Tier 2 weekly completion</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.weeklyTrend}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="weekStartDate" />
              <YAxis
                domain={[0, 100]}
                label={{ value: "%", angle: -90, position: "insideLeft" }}
              />
              <Tooltip />
              <Legend />
              <ReferenceLine y={90} stroke="#16a34a" strokeDasharray="4 4" />
              <Line
                type="monotone"
                dataKey="t2CompletionPct"
                stroke="#2563eb"
                name="T2 % completion"
                connectNulls
                dot
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {data && tierMatch && activeTier === 3 && isAcademicView && (data.t3Academic?.trend.length ?? 0) > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Tier 3 weekly minutes</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.t3Academic?.trend ?? []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="weekStartDate" />
              <YAxis />
              <Tooltip />
              <Legend />
              <ReferenceLine
                y={acadTarget}
                stroke="#16a34a"
                strokeDasharray="4 4"
              />
              <Line
                type="monotone"
                dataKey="avgMinutes"
                stroke="#0ea5e9"
                name="Avg minutes / week"
                connectNulls
                dot
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {data && tierMatch && activeTier === 3 && !isAcademicView && data.t3GoalTrend.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Tier 3 weekly average score</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.t3GoalTrend}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="weekStartDate" />
              <YAxis domain={[0, 5]} />
              <Tooltip />
              <Legend />
              <ReferenceLine y={4.5} stroke="#16a34a" strokeDasharray="4 4" />
              <Line
                type="monotone"
                dataKey="avgScore"
                stroke="#a855f7"
                name="Avg score (out of 5)"
                connectNulls
                dot
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ---- per-teacher chart + table ---- */}
      {data && tierMatch && data.perTeacher.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>
            {activeTier === 2
              ? "By teacher — check-in completion"
              : isAcademicView
                ? "By teacher — group minutes"
                : "By teacher — outcome score"}
          </h3>
          <ResponsiveContainer
            width="100%"
            height={Math.max(220, data.perTeacher.length * 28)}
          >
            <BarChart
              data={data.perTeacher}
              layout="vertical"
              margin={{ left: 80, right: 16, top: 8, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                domain={
                  activeTier === 2
                    ? [0, 100]
                    : isAcademicView
                      ? [0, "dataMax"]
                      : [0, 5]
                }
              />
              <YAxis
                type="category"
                dataKey="teacherName"
                width={160}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              {activeTier === 2 ? (
                <Bar
                  dataKey="t2CompletionPct"
                  fill="#2563eb"
                  name="T2 % completion"
                />
              ) : isAcademicView ? (
                <Bar
                  dataKey="acadMinutes"
                  fill="#0ea5e9"
                  name="Total group minutes"
                />
              ) : (
                <Bar
                  dataKey="t3AvgScore"
                  fill="#a855f7"
                  name="T3 avg score"
                />
              )}
            </BarChart>
          </ResponsiveContainer>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table
              className="pulse-table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {activeTier === 2 ? (
                <>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      <th style={thFirst}>Teacher</th>
                      <th style={thR}>T2 done</th>
                      <th style={thR}>T2 expected</th>
                      <th style={thRLast}>T2 %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perTeacher.map((r) => (
                      <tr key={r.teacherStaffId}>
                        <td style={tdFirst}>{r.teacherName}</td>
                        <td style={tdRMid}>{r.t2Completed}</td>
                        <td style={tdRMid}>{r.t2Expected}</td>
                        <td style={tdRLast}>{fmtPct(r.t2CompletionPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : isAcademicView ? (
                <>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      <th style={thFirst}>Teacher</th>
                      <th style={thR}>Met</th>
                      <th style={thR}>Owed</th>
                      <th style={thR}>Excused</th>
                      <th style={thRLast}>Avg min/wk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perTeacher.map((r) => (
                      <tr key={r.teacherStaffId}>
                        <td style={tdFirst}>
                          <span
                            style={{
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            {r.teacherName}
                            {r.subjects.map((s) => (
                              <SubjectChip key={s} label={s} />
                            ))}
                          </span>
                        </td>
                        <td style={tdRMid}>{r.acadMet}</td>
                        <td style={tdRMid}>{r.acadOwed}</td>
                        <td style={tdRMid}>{r.acadExcused}</td>
                        <td style={tdRLast}>
                          {r.acadAvgMinutes == null ? "—" : r.acadAvgMinutes}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      <th style={thFirst}>Teacher</th>
                      <th style={thR}>Days scored</th>
                      <th style={thRLast}>Avg score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perTeacher.map((r) => (
                      <tr key={r.teacherStaffId}>
                        <td style={tdFirst}>
                          <span
                            style={{
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            {r.teacherName}
                            {r.subjects.map((s) => (
                              <SubjectChip key={s} label={s} />
                            ))}
                          </span>
                        </td>
                        <td style={tdRMid}>{r.t3ScoredCount}</td>
                        <td style={tdRLast}>{fmtScore(r.t3AvgScore)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </div>
        </div>
      )}

      {/* ---- per-subject chart (Tier 2 only) ---- */}
      {data && tierMatch && activeTier === 2 && data.perSubject.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>By subject (Tier 2)</h3>
          <ResponsiveContainer
            width="100%"
            height={Math.max(200, data.perSubject.length * 28)}
          >
            <BarChart
              data={data.perSubject}
              layout="vertical"
              margin={{ left: 80, right: 16, top: 8, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" domain={[0, 100]} />
              <YAxis
                type="category"
                dataKey="courseName"
                width={180}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              <Bar
                dataKey="t2CompletionPct"
                fill="#0ea5e9"
                name="T2 % completion"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ---- day-of-week (Tier 2: log day) ---- */}
      {data && tierMatch && activeTier === 2 && data.dayOfWeek.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>
            Weekly check-in: which day teachers log on (Tier 2)
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 8,
            }}
          >
            {data.dayOfWeek.map((d) => (
              <div
                key={d.dow}
                style={{
                  background: heatColor(d.t2CompletionPct),
                  color: "white",
                  borderRadius: 8,
                  padding: 12,
                  textAlign: "center",
                }}
              >
                <div style={{ fontWeight: 700 }}>{d.label}</div>
                <div
                  style={{ fontSize: "1.6rem", fontWeight: 700, marginTop: 4 }}
                >
                  {fmtPct(d.t2CompletionPct)}
                </div>
                <div style={{ fontSize: "0.78rem", opacity: 0.9 }}>
                  {d.t2Completed} / {d.t2Expected}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- day-of-week (Tier 3 academic: minutes by weekday) ---- */}
      {data && tierMatch && activeTier === 3 && isAcademicView && (data.t3Academic?.dayOfWeek.length ?? 0) > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Group minutes by weekday (Tier 3)</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 8,
            }}
          >
            {data.t3Academic?.dayOfWeek.map((d) => (
              <div
                key={d.dow}
                style={{
                  background: "#0ea5e9",
                  color: "white",
                  borderRadius: 8,
                  padding: 12,
                  textAlign: "center",
                }}
              >
                <div style={{ fontWeight: 700 }}>{d.label}</div>
                <div
                  style={{ fontSize: "1.6rem", fontWeight: 700, marginTop: 4 }}
                >
                  {d.minutes}
                </div>
                <div style={{ fontSize: "0.78rem", opacity: 0.9 }}>minutes</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- day-of-week (Tier 3: best/worst day by score) ---- */}
      {data && tierMatch && activeTier === 3 && !isAcademicView && (data.t3DayOfWeek?.length ?? 0) > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>
            Best &amp; worst day: average outcome score (Tier 3)
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 8,
            }}
          >
            {data.t3DayOfWeek.map((d) => (
              <div
                key={d.dow}
                style={{
                  background: scoreColor(d.avgScore),
                  color: "white",
                  borderRadius: 8,
                  padding: 12,
                  textAlign: "center",
                }}
              >
                <div style={{ fontWeight: 700 }}>{d.label}</div>
                <div
                  style={{ fontSize: "1.6rem", fontWeight: 700, marginTop: 4 }}
                >
                  {fmtScore(d.avgScore)}
                </div>
                <div style={{ fontSize: "0.78rem", opacity: 0.9 }}>
                  {d.scoredCount} scored
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- empty-state nudge ---- */}
      {data &&
        tierMatch &&
        data.weeklyTrend.length === 0 &&
        data.perTeacher.length === 0 &&
        (data.t3Academic?.trend.length ?? 0) === 0 && (
          <div
            className="mtss-reports-card"
            style={{ ...cardStyle, color: "#64748b" }}
          >
            No Tier {activeTier} intervention activity in this date range
            for the chosen filters. Try a wider preset or a different
            filter.
          </div>
        )}
    </div>
  );
}

// ---------------- mini bits ----------------

// ---- Columned-table style kit -------------------------------
// Right-aligned numeric headers sit directly above their numbers; a
// thin slate divider between columns helps the eye track across wide
// rows. `*First` / `*Last` variants drop the outer dividers so the
// table doesn't look "boxed in" against its card.
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "1px solid #e5e7eb",
  borderRight: "1px solid #e5e7eb",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  fontWeight: 800,
  backgroundImage: "linear-gradient(90deg, #7c3aed 0%, #2563eb 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};
const thFirst: React.CSSProperties = { ...th };
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const thRLast: React.CSSProperties = { ...thR, borderRight: "none" };

const td: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid #f1f5f9",
  borderRight: "1px solid #f1f5f9",
};
const tdR: React.CSSProperties = { ...td, textAlign: "right" };
const tdFirst: React.CSSProperties = { ...td };
const tdRMid: React.CSSProperties = { ...tdR };
const tdRLast: React.CSSProperties = { ...tdR, borderRight: "none" };

function SummaryTile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  const colors: Record<string, string> = {
    good: "#16a34a",
    warn: "#ca8a04",
    bad: "#dc2626",
    neutral: "#0f172a",
  };
  return (
    <div
      style={{
        background: "#f8fafc",
        borderRadius: 8,
        padding: 12,
        border: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          color: "#64748b",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          color: colors[tone],
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
