// Class Composer — Phase A scheduler-facing suggestion report.
// Admin / Core Team only. Read-only on top of FAST item responses.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, howtoListStyle } from "./HowToUseHelp";

interface WindowOpt {
  schoolYear: string;
  window: string;
  label: string;
}
interface LevelMix {
  l1: number;
  l2: number;
  l3: number;
  l4: number;
  l5: number;
  unknown: number;
}
interface Profile {
  studentId: string;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  grade: number | null;
  categories: Array<{
    category: string;
    pct: number;
    responseCount: number;
    benchmarkCodes: string[];
  }>;
  topGaps: string[];
  overallPct: number | null;
  fastLevel: 1 | 2 | 3 | 4 | 5 | null;
}
interface Group {
  index: number;
  dominantCategory: string | null;
  students: Profile[];
  avgDominantPct: number | null;
  cohesionPct: number;
  levelMix: LevelMix;
}
type Mode = "intensive" | "regular" | "cusp";
type Arrangement = "homogeneous" | "balanced";
type CuspDirection = "both" | "below" | "above" | "strand";
interface CuspSummary {
  cuspPoints: number;
  cuspPointsBelow?: number;
  cuspPointsAbove?: number;
  cuspDirection: CuspDirection;
  cuspDoubleCounters: boolean;
  cuspTrajectory: boolean;
  chartGradeUsed: number | null;
  l3Min: number | null;
  l4Min: number | null;
  belowCutFloor: number | null;
  aboveCutFloor: number | null;
  sectionsNeeded: number;
}
// Master Plan workflow types. Plans + their locked groups are stored
// server-side; the page exchanges them via /api/intensive-groups/plans/*.
interface PlanRow {
  id: number;
  name: string;
  subject: string;
  grade: number;
  schoolYear: string;
  status: "draft" | "final";
  publicId: string;
  createdByStaffId: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  groupCount: number;
  studentCount: number;
}
interface PlanGroupRecipe {
  mode: Mode;
  window: string;
  arrangement?: Arrangement | null;
  eligibilityMaxPct?: number;
  cuspPoints?: number;
  cuspPointsBelow?: number;
  cuspPointsAbove?: number;
  cuspDirection?: CuspDirection;
  cuspDoubleCounters?: boolean;
  cuspTrajectory?: boolean;
  summary: string;
}
interface PlanGroupRow {
  id: number;
  planId: number;
  schoolId: number;
  groupIndex: number;
  name: string;
  recipe: PlanGroupRecipe;
  studentIds: string[];
  seatsPerSection: number;
  createdAt: string;
}

interface SuggestResponse {
  subject: string;
  grade: number;
  schoolYear: string;
  window: string;
  available: WindowOpt[];
  mode: Mode;
  arrangement: Arrangement | null;
  cusp: CuspSummary | null;
  calcOnly: boolean;
  eligibilityMaxPct: number;
  requested: { sections: number; seats: number };
  candidatePool: {
    totalAtGrade: number;
    eligible: number;
    unscored: number;
    levelMix: LevelMix;
  };
  groups: Group[];
  overflow: Array<{
    studentId: string;
    localSisId: string | null;
    firstName: string | null;
    lastName: string | null;
    grade: number | null;
    overallPct: number | null;
    fastLevel: 1 | 2 | 3 | 4 | 5 | null;
    topGaps: string[];
  }>;
  unscored: Array<{
    studentId: string;
    localSisId: string | null;
    firstName: string | null;
    lastName: string | null;
    grade: number | null;
  }>;
}

const LEVEL_PALETTE: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#fee2e2", // red — L1
  2: "#ffedd5", // orange — L2
  3: "#dcfce7", // green — L3
  4: "#dbeafe", // blue — L4
  5: "#ede9fe", // purple — L5
};
const LEVEL_TEXT: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#991b1b",
  2: "#9a3412",
  3: "#166534",
  4: "#1e40af",
  5: "#5b21b6",
};

function LevelMixChips({ mix }: { mix: LevelMix }) {
  const items: Array<[label: string, count: number, bg: string, color: string]> = [];
  ([1, 2, 3, 4, 5] as const).forEach((lvl) => {
    const key = `l${lvl}` as keyof LevelMix;
    const n = mix[key];
    if (n > 0) items.push([`L${lvl}`, n, LEVEL_PALETTE[lvl], LEVEL_TEXT[lvl]]);
  });
  if (mix.unknown > 0) items.push(["No PM", mix.unknown, "#f3f4f6", "#6b7280"]);
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
      {items.map(([label, n, bg, color]) => (
        <span
          key={label}
          style={{
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 10,
            background: bg,
            color,
            fontWeight: 600,
          }}
        >
          {label} × {n}
        </span>
      ))}
    </div>
  );
}

const SUBJECT_OPTIONS = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "algebra1", label: "Algebra 1" },
  { value: "geometry", label: "Geometry" },
];

const fullName = (
  s: { firstName: string | null; lastName: string | null },
): string =>
  [s.lastName, s.firstName].filter(Boolean).join(", ") || "—";

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function IntensiveGroupComposerPage({
  onBack,
}: {
  onBack: () => void;
}) {
  const [mode, setMode] = useState<Mode>("intensive");
  const [arrangement, setArrangement] = useState<Arrangement>("homogeneous");
  const [subject, setSubject] = useState("ela");
  const [grade, setGrade] = useState(6);
  const [sections, setSections] = useState(4);
  const [seats, setSeats] = useState(22);
  const [eligibilityMaxPct, setEligibilityMaxPct] = useState(70);

  // Cusp-mode controls. Below + above point windows are independent
  // so an admin can cast a wider net on the at-risk side (e.g. 15 pts
  // below the L3 cut) than on the proficient-but-fragile side
  // (e.g. 5 pts above). Defaults: 15/15, both directions, double-
  // counters off, trajectory off. Server enforces the same defaults
  // if absent.
  const [cuspPointsBelow, setCuspPointsBelow] = useState(15);
  const [cuspPointsAbove, setCuspPointsAbove] = useState(15);
  const [cuspDirection, setCuspDirection] = useState<CuspDirection>("both");
  const [cuspDoubleCounters, setCuspDoubleCounters] = useState(false);
  const [cuspTrajectory, setCuspTrajectory] = useState(false);
  // Phase-1 Historical FAST work: optional secondary filter on the
  // cusp candidate pool. "" = behave like before (no extra filter);
  // "first_time_l3" = only students whose CURRENT PM is the first
  // time they hit L3 (prior PM3 was L1/L2); "consistent_l3_plus" =
  // only students who were already L3+ last year and remain L3+.
  // Server enforces the same enum (intensiveGroups.ts /suggest).
  const [trajectoryFilter, setTrajectoryFilter] = useState<
    "" | "first_time_l3" | "consistent_l3_plus"
  >("");

  useEffect(() => {
    // Mode change resets the mastery-cap default so the Advanced
    // expander reflects the right number when opened.
    setEligibilityMaxPct(mode === "intensive" ? 70 : 100);
  }, [mode]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [windowOpts, setWindowOpts] = useState<WindowOpt[]>([]);
  const [selectedWindow, setSelectedWindow] = useState<string>("");
  const [result, setResult] = useState<SuggestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Master Plan workflow state. plans = saved plans for the current
  // (subject, grade); activePlan + planGroups = the open plan being
  // built. lockedIds is the union of all student_ids across the open
  // plan's groups — fed to /suggest as excludeStudentIds so the
  // candidate pool only considers students who aren't yet placed.
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [activePlan, setActivePlan] = useState<PlanRow | null>(null);
  const [planGroups, setPlanGroups] = useState<PlanGroupRow[]>([]);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const lockedIds = useMemo(() => {
    const s = new Set<string>();
    for (const g of planGroups) for (const sid of g.studentIds) s.add(sid);
    return s;
  }, [planGroups]);

  // Live cusp calculator — fires a debounced calcOnly request as
  // params change so the admin sees "X eligible → Y sections" before
  // committing to a Generate. Null when cusp mode is off, when the
  // last call hasn't returned yet, or before the first call.
  const [cuspCalc, setCuspCalc] = useState<{
    eligible: number;
    sectionsNeeded: number;
    totalAtGrade: number;
    levelMix: LevelMix;
    cusp: CuspSummary | null;
  } | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);

  // Load available windows when subject changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    authFetch(`/api/intensive-groups/windows?subject=${subject}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load windows");
        return r.json();
      })
      .then((d: { available: WindowOpt[] }) => {
        if (cancelled) return;
        setWindowOpts(d.available);
        if (d.available.length > 0) {
          setSelectedWindow(`${d.available[0].schoolYear}|${d.available[0].window}`);
        } else {
          setSelectedWindow("");
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [subject]);

  // Build the /suggest query string. Shared by Generate + the live
  // cusp calculator so both stay in sync on which params get sent.
  const buildSuggestParams = (opts: { calcOnly: boolean }): URLSearchParams => {
    const params = new URLSearchParams({
      mode,
      subject,
      grade: String(grade),
      sections: String(sections),
      seats: String(seats),
    });
    if (mode === "regular") {
      params.set("arrangement", arrangement);
    }
    if (mode === "cusp") {
      params.set("cuspPointsBelow", String(cuspPointsBelow));
      params.set("cuspPointsAbove", String(cuspPointsAbove));
      params.set("cuspDirection", cuspDirection);
      if (cuspDoubleCounters) params.set("cuspDoubleCounters", "true");
      if (cuspTrajectory) params.set("cuspTrajectory", "true");
      if (trajectoryFilter) params.set("trajectoryFilter", trajectoryFilter);
    }
    // Only send the % cap when the user has touched the advanced
    // section — otherwise let the server pick the mode default
    // (70 intensive / 100 regular/cusp).
    if (showAdvanced) {
      params.set("eligibilityMaxPct", String(eligibilityMaxPct));
    }
    if (selectedWindow) {
      const [sy, w] = selectedWindow.split("|");
      params.set("schoolYear", sy);
      params.set("window", w);
    }
    if (opts.calcOnly) params.set("calcOnly", "true");
    if (lockedIds.size > 0) {
      params.set("excludeStudentIds", Array.from(lockedIds).join(","));
    }
    return params;
  };

  const generate = async () => {
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const params = buildSuggestParams({ calcOnly: false });
      const r = await authFetch(`/api/intensive-groups/suggest?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as SuggestResponse;
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Live cusp calculator — fires /suggest?calcOnly=true with a 400ms
  // debounce on every relevant input change. Stays off when not in
  // cusp mode (avoids noise; the Generate button is the entry point
  // for intensive/regular).
  useEffect(() => {
    if (mode !== "cusp") {
      setCuspCalc(null);
      return;
    }
    if (!selectedWindow) return;
    let cancelled = false;
    setCalcLoading(true);
    const handle = setTimeout(async () => {
      try {
        const params = buildSuggestParams({ calcOnly: true });
        const r = await authFetch(
          `/api/intensive-groups/suggest?${params.toString()}`,
        );
        if (!r.ok) return;
        const data = (await r.json()) as SuggestResponse;
        if (cancelled) return;
        setCuspCalc({
          eligible: data.candidatePool.eligible,
          sectionsNeeded:
            data.cusp?.sectionsNeeded ??
            Math.max(1, Math.ceil(data.candidatePool.eligible / Math.max(1, seats))),
          totalAtGrade: data.candidatePool.totalAtGrade,
          levelMix: data.candidatePool.levelMix,
          cusp: data.cusp,
        });
      } finally {
        if (!cancelled) setCalcLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // Re-run whenever any input that affects the cusp filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    subject,
    grade,
    seats,
    selectedWindow,
    cuspPointsBelow,
    cuspPointsAbove,
    cuspDirection,
    cuspDoubleCounters,
    cuspTrajectory,
    showAdvanced,
    eligibilityMaxPct,
  ]);

  // ---------- Master Plan: load + mutate ----------
  const refreshPlans = async (
    nextSubject: string,
    nextGrade: number,
  ): Promise<PlanRow[]> => {
    const params = new URLSearchParams({
      subject: nextSubject,
      grade: String(nextGrade),
    });
    const r = await authFetch(`/api/intensive-groups/plans?${params}`);
    if (!r.ok) return [];
    const d = (await r.json()) as { plans: PlanRow[] };
    setPlans(d.plans);
    return d.plans;
  };

  const refreshActivePlan = async (planId: number): Promise<void> => {
    const r = await authFetch(`/api/intensive-groups/plans/${planId}`);
    if (!r.ok) return;
    const d = (await r.json()) as {
      plan: PlanRow;
      groups: PlanGroupRow[];
    };
    setActivePlan(d.plan);
    setPlanGroups(d.groups);
  };

  // Reload plans list whenever subject or grade changes, and clear the
  // open plan since plans are scoped to a single (subject, grade).
  useEffect(() => {
    setActivePlan(null);
    setPlanGroups([]);
    setPlanError(null);
    refreshPlans(subject, grade).catch(() => {
      // Read-only failure — surface in panel but don't block the page.
    });
  }, [subject, grade]);

  // Build a human-readable one-liner for the recipe summary stored
  // with each locked group. Used for the PDF cover + locked-groups
  // stack chips.
  const buildRecipeSummary = (r: SuggestResponse): string => {
    const winLabel = `${r.schoolYear} ${r.window.toUpperCase()}`;
    if (r.mode === "intensive") return `Intensive · Levels 1–2 · ${winLabel}`;
    if (r.mode === "regular") {
      const a = r.arrangement === "balanced" ? "Balanced" : "Homogeneous";
      return `Regular · ${a} · Levels 1–5 · ${winLabel}`;
    }
    const c = r.cusp;
    const dirLabel =
      c?.cuspDirection === "below"
        ? "Below cut"
        : c?.cuspDirection === "above"
          ? "Above cut"
          : c?.cuspDirection === "strand"
            ? "Strand cusp"
            : "Both";
    const pBelow = c?.cuspPointsBelow ?? c?.cuspPoints ?? 15;
    const pAbove = c?.cuspPointsAbove ?? c?.cuspPoints ?? 15;
    let pts: string;
    if (c?.cuspDirection === "below") pts = `±${pBelow} pts below cut`;
    else if (c?.cuspDirection === "above") pts = `±${pAbove} pts above cut`;
    else if (c?.cuspDirection === "strand") pts = "strand-based";
    else pts = pBelow === pAbove ? `±${pBelow} pts` : `−${pBelow} / +${pAbove} pts`;
    return `Cusp · ${dirLabel} · ${pts} · ${winLabel}`;
  };

  const createPlan = async () => {
    const name = window.prompt(
      "Name this plan (e.g. 'Grade 7 ELA — Spring intensive blocks')",
      `Grade ${grade} ${subject.toUpperCase()} plan`,
    );
    if (!name) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const r = await authFetch("/api/intensive-groups/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          subject,
          grade,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const { plan } = (await r.json()) as { plan: PlanRow };
      await refreshPlans(subject, grade);
      await refreshActivePlan(plan.id);
    } catch (e) {
      setPlanError((e as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  const openPlan = async (id: number) => {
    setPlanBusy(true);
    setPlanError(null);
    try {
      await refreshActivePlan(id);
    } catch (e) {
      setPlanError((e as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  const closePlan = () => {
    setActivePlan(null);
    setPlanGroups([]);
  };

  const deletePlan = async (p: PlanRow) => {
    if (
      !window.confirm(
        `Delete plan "${p.name}"? This removes ${p.groupCount} locked group(s). The paper PDF is not affected.`,
      )
    ) {
      return;
    }
    setPlanBusy(true);
    try {
      await authFetch(`/api/intensive-groups/plans/${p.id}`, {
        method: "DELETE",
      });
      if (activePlan?.id === p.id) closePlan();
      await refreshPlans(subject, grade);
    } finally {
      setPlanBusy(false);
    }
  };

  const lockCandidates = async () => {
    if (!activePlan || !result) return;
    if (result.groups.length === 0) {
      setPlanError("Nothing to lock — generate groups first.");
      return;
    }
    const overflowCount = result.overflow.length;
    const seatsTarget = result.requested.seats;
    const anyOverCap = result.groups.some((g) => g.students.length > seatsTarget);
    if (overflowCount > 0 || anyOverCap) {
      const proceed = window.confirm(
        `Capacity warning: ${overflowCount} student(s) in overflow and ${
          anyOverCap ? "one or more groups exceed seats/section" : "no group exceeds seats"
        }. Lock all candidate groups anyway? Overflow students will NOT be locked — handle them in a follow-up recipe or by manual move.`,
      );
      if (!proceed) return;
    }
    setPlanBusy(true);
    setPlanError(null);
    try {
      const summary = buildRecipeSummary(result);
      const recipe: PlanGroupRecipe = {
        mode: result.mode,
        window: result.window,
        arrangement: result.arrangement,
        eligibilityMaxPct: result.eligibilityMaxPct,
        cuspPoints: result.cusp?.cuspPoints,
        cuspPointsBelow: result.cusp?.cuspPointsBelow,
        cuspPointsAbove: result.cusp?.cuspPointsAbove,
        cuspDirection: result.cusp?.cuspDirection,
        cuspDoubleCounters: result.cusp?.cuspDoubleCounters,
        cuspTrajectory: result.cusp?.cuspTrajectory,
        summary,
      };
      const existingCount = planGroups.length;
      for (let i = 0; i < result.groups.length; i++) {
        const g = result.groups[i];
        const studentIds = g.students.map((s) => s.studentId);
        const name = `Group ${existingCount + i + 1} — ${g.dominantCategory ?? "Mixed"}`;
        const r = await authFetch(
          `/api/intensive-groups/plans/${activePlan.id}/groups`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              recipe,
              studentIds,
              seatsPerSection: seatsTarget,
            }),
          },
        );
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      }
      await refreshActivePlan(activePlan.id);
      await refreshPlans(subject, grade);
      // Clear the current candidate result — re-running /suggest will
      // now skip the just-locked students automatically.
      setResult(null);
    } catch (e) {
      setPlanError((e as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  const unlockGroup = async (g: PlanGroupRow) => {
    if (!activePlan) return;
    if (
      !window.confirm(
        `Unlock "${g.name}" (${g.studentIds.length} students)? They'll return to the candidate pool.`,
      )
    ) {
      return;
    }
    setPlanBusy(true);
    try {
      await authFetch(
        `/api/intensive-groups/plans/${activePlan.id}/groups/${g.id}`,
        { method: "DELETE" },
      );
      await refreshActivePlan(activePlan.id);
      await refreshPlans(subject, grade);
    } finally {
      setPlanBusy(false);
    }
  };

  const removeStudentFromGroup = async (g: PlanGroupRow, sid: string) => {
    if (!activePlan) return;
    const next = g.studentIds.filter((id) => id !== sid);
    setPlanBusy(true);
    try {
      await authFetch(
        `/api/intensive-groups/plans/${activePlan.id}/groups/${g.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ studentIds: next }),
        },
      );
      await refreshActivePlan(activePlan.id);
    } finally {
      setPlanBusy(false);
    }
  };

  const moveStudentToGroup = async (
    fromGroup: PlanGroupRow,
    toGroupId: number,
    sid: string,
  ) => {
    if (!activePlan) return;
    const toGroup = planGroups.find((g) => g.id === toGroupId);
    if (!toGroup) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      // Single transactional server endpoint so a failed second write
      // cannot drop the student from both groups.
      const r = await authFetch(
        `/api/intensive-groups/plans/${activePlan.id}/move-student`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            studentId: sid,
            fromGroupId: fromGroup.id,
            toGroupId: toGroup.id,
          }),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await refreshActivePlan(activePlan.id);
    } catch (e) {
      setPlanError((e as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  const finalizePlan = async () => {
    if (!activePlan) return;
    if (
      !window.confirm(
        `Finalize "${activePlan.name}"? Edits will be locked until you unfinalize. The PDF + CSV will download automatically after.`,
      )
    ) {
      return;
    }
    setPlanBusy(true);
    try {
      const r = await authFetch(
        `/api/intensive-groups/plans/${activePlan.id}/finalize`,
        { method: "POST" },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await refreshActivePlan(activePlan.id);
      await refreshPlans(subject, grade);
      downloadPlanFile("pdf");
      downloadPlanFile("csv");
    } catch (e) {
      setPlanError((e as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  const unfinalizePlan = async () => {
    if (!activePlan) return;
    if (!window.confirm("Unfinalize this plan? Edits will be re-enabled."))
      return;
    setPlanBusy(true);
    try {
      await authFetch(
        `/api/intensive-groups/plans/${activePlan.id}/unfinalize`,
        { method: "POST" },
      );
      await refreshActivePlan(activePlan.id);
      await refreshPlans(subject, grade);
    } finally {
      setPlanBusy(false);
    }
  };

  // PDF + CSV downloads — use authFetch to honor bearer auth (the
  // preview iframe blocks session cookies, so a plain <a href> won't
  // carry the token).
  const downloadPlanFile = async (kind: "pdf" | "csv") => {
    if (!activePlan) return;
    try {
      const r = await authFetch(
        `/api/intensive-groups/plans/${activePlan.id}/${kind}`,
      );
      if (!r.ok) {
        setPlanError(`Download failed (HTTP ${r.status})`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const slug = activePlan.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
      a.download = `${slug || "composer-plan"}.${kind}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setPlanError((e as Error).message);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    const rows: string[][] = [
      [
        "Group",
        "Dominant Skill",
        "Cohesion %",
        "Avg Skill %",
        "Student",
        "Student ID",
        "Grade",
        "FAST Level",
        "Overall %",
        "Top Gap 1",
        "Top Gap 2",
        "Top Gap 3",
      ],
    ];
    for (const g of result.groups) {
      for (const s of g.students) {
        rows.push([
          `Group ${g.index}`,
          g.dominantCategory ?? "Mixed",
          String(g.cohesionPct),
          g.avgDominantPct == null ? "" : String(g.avgDominantPct),
          fullName(s),
          s.localSisId ?? "",
          s.grade == null ? "" : String(s.grade),
          s.fastLevel == null ? "" : `L${s.fastLevel}`,
          s.overallPct == null ? "" : String(s.overallPct),
          s.topGaps[0] ?? "",
          s.topGaps[1] ?? "",
          s.topGaps[2] ?? "",
        ]);
      }
    }
    for (const u of result.unscored) {
      rows.push([
        "Unscored",
        "",
        "",
        "",
        fullName(u),
        u.localSisId ?? "",
        u.grade == null ? "" : String(u.grade),
        "",
        "",
        "",
        "",
        "",
      ]);
    }
    downloadCsv(
      `class-composer-${subject}-g${grade}-${result.schoolYear}-${result.window}.csv`,
      rows,
    );
  };

  const printReport = () => {
    window.print();
  };

  const headerSummary = useMemo(() => {
    if (!result) return null;
    const cuspDirLabel = (d: CuspDirection): string =>
      d === "below"
        ? "Below cut"
        : d === "above"
          ? "Above cut"
          : d === "strand"
            ? "Strand cusp"
            : "Both";
    const modeLabel =
      result.mode === "intensive"
        ? "Intensive (Levels 1–2)"
        : result.mode === "cusp"
          ? (() => {
              const c = result.cusp;
              const dir = c?.cuspDirection ?? "both";
              const pBelow = c?.cuspPointsBelow ?? c?.cuspPoints ?? 15;
              const pAbove = c?.cuspPointsAbove ?? c?.cuspPoints ?? 15;
              let pts: string;
              if (dir === "below") pts = `±${pBelow} pts`;
              else if (dir === "above") pts = `±${pAbove} pts`;
              else if (dir === "strand") pts = "strand-based";
              else pts =
                pBelow === pAbove ? `±${pBelow} pts` : `−${pBelow}/+${pAbove} pts`;
              return (
                `Cusp · ${cuspDirLabel(dir)} (${pts}` +
                (c?.cuspDoubleCounters ? ", double-counters" : "") +
                (c?.cuspTrajectory ? ", trajectory" : "") +
                ")"
              );
            })()
          : result.arrangement === "balanced"
            ? "Regular · Balanced (Levels 1–5)"
            : "Regular · Homogeneous (Levels 1–5)";
    return (
      <div style={{ color: "#374151", fontSize: 13, marginTop: 6 }}>
        <strong>{modeLabel}</strong> · Subject{" "}
        <strong>{result.subject.toUpperCase()}</strong> · Grade{" "}
        <strong>{result.grade}</strong> · Window{" "}
        <strong>
          {result.schoolYear} {result.window.toUpperCase()}
        </strong>
        {result.eligibilityMaxPct < 100 && (
          <>
            {" "}
            · Mastery cap ≤ <strong>{result.eligibilityMaxPct}%</strong>
          </>
        )}
      </div>
    );
  }, [result]);

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <style>{`
        @media print {
          .composer-no-print { display: none !important; }
          .composer-group-card { break-inside: avoid; }
        }
      `}</style>

      <div className="composer-no-print" style={{ marginBottom: 12 }}>
        <button
          onClick={onBack}
          style={{
            padding: "6px 12px",
            border: "1px solid #d1d5db",
            background: "white",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          ← Back to Insights
        </button>
      </div>

      <h1 style={{ fontSize: 24, margin: "0 0 4px 0" }}>Class Composer</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Suggest intensive-group sections from the latest FAST results. Read-only —
        Skyward / RosterOne stays the source of truth.
      </p>

      {/* ===== Master Plan workflow ===== */}
      <section
        className="composer-no-print"
        style={{
          border: "1px solid #c7d2fe",
          background: "#eef2ff",
          borderRadius: 8,
          padding: 12,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16, color: "#1e3a8a" }}>
              Master Plans · {subject.toUpperCase()} · Grade {grade}
            </h2>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
              Lock candidate groups into a saved plan. Locked students are
              excluded from the next pool. Finalize to get a printable PDF
              and CSV. Paper artifact only — nothing writes to Skyward.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {activePlan ? (
              <button
                onClick={closePlan}
                disabled={planBusy}
                style={{
                  padding: "6px 12px",
                  border: "1px solid #6366f1",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Close plan
              </button>
            ) : (
              <button
                onClick={createPlan}
                disabled={planBusy}
                style={{
                  padding: "6px 12px",
                  border: "1px solid #4338ca",
                  background: "#4338ca",
                  color: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                + Start new plan
              </button>
            )}
          </div>
        </div>

        {planError && (
          <div
            style={{
              marginTop: 8,
              padding: 6,
              background: "#fee2e2",
              color: "#7f1d1d",
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            {planError}
          </div>
        )}

        {/* Active plan panel */}
        {activePlan && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: "white",
              borderRadius: 6,
              border: "1px solid #c7d2fe",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div>
                <strong>{activePlan.name}</strong>{" "}
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 11,
                    padding: "2px 6px",
                    background:
                      activePlan.status === "final" ? "#dcfce7" : "#fef3c7",
                    color:
                      activePlan.status === "final" ? "#166534" : "#92400e",
                    borderRadius: 4,
                    fontWeight: 600,
                  }}
                >
                  {activePlan.status === "final" ? "Finalized" : "Draft"}
                </span>
                <span
                  style={{ marginLeft: 8, fontSize: 12, color: "#6b7280" }}
                >
                  Plan ID <code>{activePlan.publicId}</code> ·{" "}
                  {planGroups.length} locked group(s) · {lockedIds.size} locked
                  student(s)
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  onClick={() => downloadPlanFile("pdf")}
                  disabled={planBusy || planGroups.length === 0}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d5db",
                    background: "white",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  Download PDF
                </button>
                <button
                  onClick={() => downloadPlanFile("csv")}
                  disabled={planBusy || planGroups.length === 0}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d5db",
                    background: "white",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  Download CSV
                </button>
                {activePlan.status === "draft" ? (
                  <button
                    onClick={finalizePlan}
                    disabled={planBusy || planGroups.length === 0}
                    style={{
                      padding: "6px 12px",
                      border: "1px solid #047857",
                      background: "#047857",
                      color: "white",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    Finalize → PDF + CSV
                  </button>
                ) : (
                  <button
                    onClick={unfinalizePlan}
                    disabled={planBusy}
                    style={{
                      padding: "6px 10px",
                      border: "1px solid #d1d5db",
                      background: "white",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    Unfinalize (edit)
                  </button>
                )}
              </div>
            </div>

            {planGroups.length === 0 ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  background: "#f8fafc",
                  borderRadius: 4,
                  fontSize: 13,
                  color: "#475569",
                }}
              >
                No groups locked yet. Generate candidate groups below, then
                hit <strong>Lock into plan</strong> on the results panel.
              </div>
            ) : (
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                {planGroups.map((g) => {
                  const overCap = g.studentIds.length > g.seatsPerSection;
                  return (
                    <div
                      key={g.id}
                      style={{
                        border: overCap
                          ? "1px solid #fca5a5"
                          : "1px solid #e5e7eb",
                        background: overCap ? "#fef2f2" : "#f9fafb",
                        borderRadius: 6,
                        padding: 8,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <div>
                          <strong>{g.name}</strong>{" "}
                          <span style={{ fontSize: 12, color: "#6b7280" }}>
                            · {g.studentIds.length}/{g.seatsPerSection} seats
                            {overCap && " · OVER CAP"}
                          </span>
                          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                            {g.recipe?.summary ?? ""}
                          </div>
                        </div>
                        <button
                          onClick={() => unlockGroup(g)}
                          disabled={planBusy || activePlan.status === "final"}
                          style={{
                            padding: "4px 8px",
                            border: "1px solid #d1d5db",
                            background: "white",
                            borderRadius: 4,
                            cursor: "pointer",
                            fontSize: 12,
                          }}
                        >
                          Unlock group
                        </button>
                      </div>
                      {activePlan.status === "draft" && (
                        <div
                          style={{
                            marginTop: 6,
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 6,
                          }}
                        >
                          {g.studentIds.map((sid) => (
                            <span
                              key={sid}
                              style={{
                                fontSize: 11,
                                padding: "2px 4px",
                                background: "white",
                                border: "1px solid #e5e7eb",
                                borderRadius: 4,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                              }}
                            >
                              <code>{sid}</code>
                              <select
                                value=""
                                disabled={planBusy}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "") return;
                                  if (v === "remove") {
                                    removeStudentFromGroup(g, sid);
                                  } else {
                                    moveStudentToGroup(g, Number(v), sid);
                                  }
                                  e.target.value = "";
                                }}
                                style={{ fontSize: 11, padding: 0 }}
                                title="Move or remove"
                              >
                                <option value="">⋯</option>
                                {planGroups
                                  .filter((og) => og.id !== g.id)
                                  .map((og) => (
                                    <option key={og.id} value={og.id}>
                                      → {og.name}
                                    </option>
                                  ))}
                                <option value="remove">✕ Remove</option>
                              </select>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Saved plans list (when no plan is open) */}
        {!activePlan && plans.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: "#475569", marginBottom: 4 }}>
              Saved plans:
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              {plans.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    padding: 6,
                    background: "white",
                    borderRadius: 4,
                    border: "1px solid #e5e7eb",
                  }}
                >
                  <div style={{ fontSize: 13 }}>
                    <strong>{p.name}</strong>{" "}
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        padding: "1px 5px",
                        background:
                          p.status === "final" ? "#dcfce7" : "#fef3c7",
                        color: p.status === "final" ? "#166534" : "#92400e",
                        borderRadius: 4,
                      }}
                    >
                      {p.status === "final" ? "Final" : "Draft"}
                    </span>
                    <span style={{ marginLeft: 8, color: "#6b7280", fontSize: 12 }}>
                      {p.groupCount} group(s) · {p.studentCount} students ·{" "}
                      <code>{p.publicId}</code>
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => openPlan(p.id)}
                      disabled={planBusy}
                      style={{
                        padding: "4px 10px",
                        border: "1px solid #4338ca",
                        background: "white",
                        color: "#4338ca",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Open
                    </button>
                    <button
                      onClick={() => deletePlan(p)}
                      disabled={planBusy}
                      style={{
                        padding: "4px 10px",
                        border: "1px solid #d1d5db",
                        background: "white",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 12,
                        color: "#b91c1c",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="composer-no-print">
        <HowToUseHelp title="How to use Class Composer">
          <HowToSection title="What this page is">
            A scheduler-facing suggestion tool that groups students
            into sections using their most recent FAST scores. It is
            <strong> read-only</strong> — nothing is written to Skyward,
            RosterOne, your master schedule, or your rosters. The output
            is a printable / exportable proposal you take back to the
            scheduler.
          </HowToSection>

          <HowToSection title="Class type — Intensive vs Regular">
            <ul style={howtoListStyle}>
              <li>
                <strong>Intensive</strong> (default) — pool restricted to
                students at FAST <strong>Level 1 or 2</strong> in the chosen
                subject. Use this when you're staffing Intensive Reading
                / Intensive Math / Reading Lab / Math 180 sections.
              </li>
              <li>
                <strong>Regular</strong> — pool opens to <strong>all levels
                1–5</strong>. Use this when you're proposing a master-schedule
                split of an entire grade into N regular ELA / Math sections.
              </li>
              <li>
                FAST level comes from the PM scale score for the chosen
                window, placed on the official Florida cut-score chart.
                Students with no PM score appear in <em>Unscored</em>.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="Arrangement (Regular only)">
            <ul style={howtoListStyle}>
              <li>
                <strong>Homogeneous (skill-focused)</strong> — same
                algorithm as Intensive: each section is concentrated
                around one weak-skill area. Best when teachers want to
                attack a specific gap in each class.
              </li>
              <li>
                <strong>Balanced (mixed levels + skills)</strong> —
                round-robin distribution so each section ends up with a
                similar level mix (some L1s, some L3s, some L5s) and a
                similar skill mix. Best for typical "fair distribution"
                master scheduling.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="Cusp (bubble) — when to use it">
            <ul style={howtoListStyle}>
              <li>
                <strong>Cusp class type</strong> targets the
                "bubble" — kids close to a FAST cut score where a
                small, focused push is most likely to move a level.
                The pool is restricted to <strong>Levels 2 and 3</strong>{" "}
                within your chosen points-from-cut window.
              </li>
              <li>
                <strong>Direction</strong> — pick which edge of the
                cut you care about:
                <ul style={howtoListStyle}>
                  <li>
                    <strong>Both</strong> (default) — L2 students
                    within range of climbing into L3, plus L3
                    students within range of slipping out.
                  </li>
                  <li>
                    <strong>Below cut (L2 climbing)</strong> — only
                    the L2 students within ± points of the L3 cut.
                    Highest-ROI growth cohort.
                  </li>
                  <li>
                    <strong>Above cut (L3 → L4 proficient)</strong>{" "}
                    — only the L3 students within ± points of the L4
                    cut. The "almost proficient, give them a push"
                    cohort.
                  </li>
                  <li>
                    <strong>Strand cusp</strong> — L3 students who
                    are passing overall but have at least one
                    Below-strand (&lt; 50%). Use when the headline
                    score hides a real weakness.
                  </li>
                </ul>
              </li>
              <li>
                <strong>± Points from cut</strong> — how wide your
                bubble is. 15 points is a good starting point on the
                FAST scale; widen for more candidates, narrow for a
                tighter cohort.
              </li>
              <li>
                <strong>Double-counters only</strong> — narrows to
                kids who are <em>also</em> cusp in the OTHER FAST
                subject (ELA ↔ Math). Highest-leverage cohort for a
                shared bell or co-taught block. Skipped for EOC
                courses (no paired subject). Not available with the{" "}
                <em>Strand cusp</em> direction (the strand check
                would need item-response data for both subjects).
              </li>
              <li>
                <strong>Trajectory: was L3, slid to L2</strong> —
                narrows to current-L2 students who were L3 in a
                prior window of the same year. On PM2 we look back
                at PM1; on PM3 we look back at PM1 or PM2. Disabled
                on PM1 (no prior window).
              </li>
              <li>
                The <strong>live calculator</strong> at the bottom
                of the cusp panel updates as you tweak — it shows
                exactly how many students fit and how many sections
                you'd need at the current seats/section. Use it to
                size the cohort before clicking <em>Generate</em>.
              </li>
              <li>
                Cusp mode is single-grade by design — the cut scores
                are grade-specific. Run it once per grade you care
                about. Like all Class Composer output: suggestions
                only, nothing writes back to your roster.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="What the controls mean">
            <ul style={howtoListStyle}>
              <li>
                <strong>Subject</strong> — which FAST assessment to read
                (ELA, Math, Algebra 1, Geometry).
              </li>
              <li>
                <strong>Grade</strong> — only students currently enrolled
                in this grade at your school are considered.
              </li>
              <li>
                <strong>Window</strong> — which FAST progress-monitoring
                snapshot to use. Each window (PM1 / PM2 / PM3) is a
                two-week testing snapshot, not a date range — Florida's
                official term. The dropdown defaults to the most recent
                window your school has uploaded and lists earlier
                windows below it so you can compare. PM3 is typically
                the most actionable because it's the latest read on
                where each kid is right now.
              </li>
              <li>
                <strong># Sections</strong> — how many sections you
                intend to staff. Composer will split the eligible pool
                across that many groups.
              </li>
              <li>
                <strong>Seats / section</strong> — target class size.
                The tool will warn (via overflow list) when the
                eligible pool exceeds <em>sections × seats</em>.
              </li>
              <li>
                <strong>Advanced → Overall mastery cap</strong> — an
                optional second filter on top of FAST level. Defaults
                to 70% in Intensive (the traditional "struggling"
                floor) and 100% in Regular (no cap). Open the
                Advanced expander to change it.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="How to use it day-to-day">
            <ul style={howtoListStyle}>
              <li>
                Pick subject + grade, confirm the window shows the
                latest PM, set sections/seats to what you can actually
                staff, then click <strong>Build groups</strong>.
              </li>
              <li>
                Each group card shows its dominant skill focus, average
                mastery on that focus, a cohesion % (how alike the
                students in the group are), and the roster.
              </li>
              <li>
                <strong>Overflow</strong> lists eligible kids who
                didn't fit in <em>sections × seats</em> — use it to
                decide whether to add a section or raise seat count.
                <strong> Unscored</strong> lists eligible-by-grade
                students who don't have FAST results for the chosen
                window yet (e.g. transfers, absent for testing) —
                the scheduler still has to place them by hand.
              </li>
              <li>
                Use <strong>Print</strong> for a meeting handout or
                <strong> Export CSV</strong> to drop into Skyward
                import templates.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="Re-running after new data">
            Build groups reads live from FAST item responses every
            time you click it — nothing is cached. If a makeup score
            (or any new data) gets uploaded after you've already
            built groups, just click <strong>Build groups</strong>
            again and the suggestions will include the new score.
            Switching window / subject / grade also forces a fresh
            read.
          </HowToSection>

          <HowToSection title="Important caveats">
            <ul style={howtoListStyle}>
              <li>
                These are <strong>suggestions, not assignments</strong>.
                Nothing is written back to your rosters or master
                schedule — you'll still recreate the sections in
                Skyward / RosterOne.
              </li>
              <li>
                The tool can only group what it can see — students
                without a FAST score for the chosen window won't be
                placed (they'll appear in <em>Unscored</em>).
              </li>
              <li>
                Group cohesion drops when the eligible pool is small
                or skill-diverse. Treat low-cohesion groups as a
                signal to widen the eligibility cap or merge two
                sections into one mixed-focus section.
              </li>
            </ul>
          </HowToSection>
        </HowToUseHelp>
      </div>

      <section
        className="composer-no-print"
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 14,
          marginBottom: 14,
          background: "#f9fafb",
        }}
      >
        {/* Class type + arrangement toggles — primary decisions, shown
            above the rest so they frame everything else. */}
        <div style={{ marginBottom: 10 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 16,
              fontSize: 13,
            }}
          >
            <div>
              <span style={{ fontWeight: 600, marginRight: 8 }}>Class type</span>
              <label style={{ marginRight: 12 }}>
                <input
                  type="radio"
                  name="composer-mode"
                  checked={mode === "intensive"}
                  onChange={() => setMode("intensive")}
                />{" "}
                Intensive (Levels 1–2)
              </label>
              <label style={{ marginRight: 12 }}>
                <input
                  type="radio"
                  name="composer-mode"
                  checked={mode === "regular"}
                  onChange={() => setMode("regular")}
                />{" "}
                Regular (Levels 1–5)
              </label>
              <label>
                <input
                  type="radio"
                  name="composer-mode"
                  checked={mode === "cusp"}
                  onChange={() => setMode("cusp")}
                />{" "}
                Cusp (Levels 2–3 bubble)
              </label>
            </div>
            {mode === "regular" && (
              <div>
                <span style={{ fontWeight: 600, marginRight: 8 }}>Arrangement</span>
                <label style={{ marginRight: 12 }}>
                  <input
                    type="radio"
                    name="composer-arrangement"
                    checked={arrangement === "homogeneous"}
                    onChange={() => setArrangement("homogeneous")}
                  />{" "}
                  Homogeneous (skill-focused)
                </label>
                <label>
                  <input
                    type="radio"
                    name="composer-arrangement"
                    checked={arrangement === "balanced"}
                    onChange={() => setArrangement("balanced")}
                  />{" "}
                  Balanced (mixed levels + skills)
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Cusp controls — only visible in cusp mode. Direction radio +
            points-from-cut number + two narrowing checkboxes + the
            live "X eligible → Y sections" readout. */}
        {mode === "cusp" && (
          <div
            style={{
              marginBottom: 10,
              padding: 10,
              border: "1px solid #fde68a",
              background: "#fffbeb",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                alignItems: "center",
              }}
            >
              <div>
                <span style={{ fontWeight: 600, marginRight: 8 }}>Cusp direction</span>
                {(
                  [
                    ["both", "Both"],
                    ["below", "Below cut (L2 → L3)"],
                    ["above", "Above cut (L3 → L4 proficient)"],
                    ["strand", "Strand cusp (L3 + weak strand)"],
                  ] as Array<[CuspDirection, string]>
                ).map(([v, label]) => (
                  <label key={v} style={{ marginRight: 10 }}>
                    <input
                      type="radio"
                      name="composer-cusp-direction"
                      checked={cuspDirection === v}
                      onChange={() => {
                        setCuspDirection(v);
                        // Strand + double-counters isn't supported
                        // server-side; auto-clear the checkbox so
                        // Generate doesn't 400.
                        if (v === "strand") setCuspDoubleCounters(false);
                      }}
                    />{" "}
                    {label}
                  </label>
                ))}
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity:
                    cuspDirection === "strand" || cuspDirection === "above"
                      ? 0.5
                      : 1,
                }}
                title={
                  cuspDirection === "above"
                    ? "Below-cut window doesn't apply when only Above-cut is selected."
                    : cuspDirection === "strand"
                      ? "Point windows don't apply to Strand cusp."
                      : "Points below the L3 cut to include (L2 students close to passing)."
                }
              >
                <span style={{ fontWeight: 600 }}>± Pts below cut</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  disabled={
                    cuspDirection === "strand" || cuspDirection === "above"
                  }
                  value={cuspPointsBelow}
                  onChange={(e) =>
                    setCuspPointsBelow(
                      Math.max(1, Math.min(60, Number(e.target.value) || 15)),
                    )
                  }
                  style={{ padding: 4, width: 70 }}
                />
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity:
                    cuspDirection === "strand" || cuspDirection === "below"
                      ? 0.5
                      : 1,
                }}
                title={
                  cuspDirection === "below"
                    ? "Above-cut window doesn't apply when only Below-cut is selected."
                    : cuspDirection === "strand"
                      ? "Point windows don't apply to Strand cusp."
                      : "Points below the L4 cut to include (L3 students close to proficient)."
                }
              >
                <span style={{ fontWeight: 600 }}>± Pts above cut</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  disabled={
                    cuspDirection === "strand" || cuspDirection === "below"
                  }
                  value={cuspPointsAbove}
                  onChange={(e) =>
                    setCuspPointsAbove(
                      Math.max(1, Math.min(60, Number(e.target.value) || 15)),
                    )
                  }
                  style={{ padding: 4, width: 70 }}
                />
              </label>
            </div>
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 16 }}>
              <label
                style={{
                  opacity: cuspDirection === "strand" ? 0.5 : 1,
                  cursor: cuspDirection === "strand" ? "not-allowed" : "default",
                }}
                title={
                  cuspDirection === "strand"
                    ? "Not available with Strand-cusp direction — pick Both, Below, or Above to enable."
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={cuspDoubleCounters}
                  disabled={cuspDirection === "strand"}
                  onChange={(e) => setCuspDoubleCounters(e.target.checked)}
                />{" "}
                Double-counters only (also cusp in the other FAST subject)
              </label>
              {(() => {
                // Trajectory needs a prior window. Disable on PM1.
                const isPm1 = selectedWindow.endsWith("|pm1");
                return (
                  <label
                    style={{
                      opacity: isPm1 ? 0.5 : 1,
                      cursor: isPm1 ? "not-allowed" : "default",
                    }}
                    title={
                      isPm1
                        ? "Trajectory needs a prior window — pick PM2 or PM3."
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={cuspTrajectory && !isPm1}
                      disabled={isPm1}
                      onChange={(e) => setCuspTrajectory(e.target.checked)}
                    />{" "}
                    Trajectory: was L3, slid to L2 this window
                  </label>
                );
              })()}
              {/* Phase-1 Historical FAST: optional second filter to
                  fold multi-year context into the candidate pool. */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: "#1f2937",
                }}
              >
                Multi-year filter:
                <select
                  value={trajectoryFilter}
                  onChange={(e) =>
                    setTrajectoryFilter(
                      e.target.value as
                        | ""
                        | "first_time_l3"
                        | "consistent_l3_plus",
                    )
                  }
                  style={{
                    padding: "2px 6px",
                    borderRadius: 4,
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    fontSize: 12,
                  }}
                >
                  <option value="">— none —</option>
                  <option value="first_time_l3">
                    First-time L3 (prior year &lt; L3)
                  </option>
                  <option value="consistent_l3_plus">
                    Consistent L3+ (prior + current both L3+)
                  </option>
                </select>
              </label>
            </div>

            {/* Live calculator readout — updates ~400ms after the last
                input change. Shows cuts in use + headcount + sections. */}
            <div
              style={{
                marginTop: 10,
                padding: 8,
                borderRadius: 4,
                background: "#fff",
                border: "1px solid #fcd34d",
              }}
            >
              <div style={{ fontSize: 12, color: "#78350f", marginBottom: 4 }}>
                <strong>Live calculator</strong>
                {calcLoading && " · recalculating…"}
              </div>
              {cuspCalc ? (
                <div style={{ fontSize: 13, color: "#374151" }}>
                  <strong>{cuspCalc.eligible}</strong> students fit this cusp
                  {cuspCalc.totalAtGrade > 0 && (
                    <> (of {cuspCalc.totalAtGrade} at grade {grade})</>
                  )}{" "}
                  → <strong>{cuspCalc.sectionsNeeded}</strong> section
                  {cuspCalc.sectionsNeeded === 1 ? "" : "s"} at {seats}/section.
                  {cuspCalc.cusp?.l3Min != null && cuspCalc.cusp?.l4Min != null && (
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                      L3 cut: {cuspCalc.cusp.l3Min} (below-cut floor{" "}
                      {cuspCalc.cusp.belowCutFloor}) · L4 cut:{" "}
                      {cuspCalc.cusp.l4Min} (above-cut floor{" "}
                      {cuspCalc.cusp.aboveCutFloor}) · Chart grade:{" "}
                      {cuspCalc.cusp.chartGradeUsed ?? "—"}
                    </div>
                  )}
                  <div style={{ marginTop: 4 }}>
                    <LevelMixChips mix={cuspCalc.levelMix} />
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  Pick a window to see the live count.
                </div>
              )}
            </div>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Subject
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{ padding: 6, marginTop: 4 }}
            >
              {SUBJECT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Grade
            <select
              value={grade}
              onChange={(e) => setGrade(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            >
              {[5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Window
            <select
              value={selectedWindow}
              onChange={(e) => setSelectedWindow(e.target.value)}
              style={{ padding: 6, marginTop: 4 }}
              disabled={windowOpts.length === 0}
            >
              {windowOpts.length === 0 && <option value="">— No data —</option>}
              {windowOpts.map((w) => (
                <option key={`${w.schoolYear}|${w.window}`} value={`${w.schoolYear}|${w.window}`}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            # Sections
            <input
              type="number"
              min={1}
              max={20}
              value={sections}
              onChange={(e) => setSections(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Seats / section
            <input
              type="number"
              min={2}
              max={35}
              value={seats}
              onChange={(e) => setSeats(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              color: "#2563eb",
              cursor: "pointer",
              padding: 0,
              fontSize: 12,
            }}
          >
            {showAdvanced ? "▾ Hide advanced" : "▸ Advanced (overall mastery cap)"}
          </button>
          {showAdvanced && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
                color: "#374151",
              }}
            >
              Overall mastery ≤
              <input
                type="number"
                min={0}
                max={100}
                value={eligibilityMaxPct}
                onChange={(e) => setEligibilityMaxPct(Number(e.target.value))}
                style={{ padding: 4, width: 70 }}
              />
              %
              <span style={{ color: "#6b7280" }}>
                (defaults: 70% intensive, 100% regular)
              </span>
            </label>
          )}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            onClick={generate}
            disabled={loading || !selectedWindow}
            style={{
              padding: "8px 16px",
              border: "1px solid #2563eb",
              background: "#2563eb",
              color: "white",
              borderRadius: 6,
              cursor: loading ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            {loading ? "Building…" : "Build groups"}
          </button>
          {result && (
            <>
              <button
                onClick={printReport}
                style={{
                  padding: "8px 14px",
                  border: "1px solid #d1d5db",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Print
              </button>
              <button
                onClick={exportCsv}
                style={{
                  padding: "8px 14px",
                  border: "1px solid #d1d5db",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Export CSV
              </button>
              {activePlan && activePlan.status === "draft" && (
                <button
                  onClick={lockCandidates}
                  disabled={planBusy || result.groups.length === 0}
                  title="Lock all generated groups into the active plan. Locked students are excluded from the next pool."
                  style={{
                    padding: "8px 14px",
                    border: "1px solid #4338ca",
                    background: "#4338ca",
                    color: "white",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Lock into plan ({result.groups.length})
                </button>
              )}
            </>
          )}
        </div>
        {error && (
          <div style={{ color: "#b91c1c", marginTop: 10, fontSize: 13 }}>{error}</div>
        )}
      </section>

      {result && (
        <>
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ fontSize: 18, marginBottom: 4 }}>Proposed groupings</h2>
            {headerSummary}
            <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
              Candidate pool: {result.candidatePool.totalAtGrade} students in grade{" "}
              {result.grade} · {result.candidatePool.eligible} eligible ·{" "}
              {result.candidatePool.unscored} without data
            </div>
            <LevelMixChips mix={result.candidatePool.levelMix} />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            {result.groups.map((g) => (
              <div
                key={g.index}
                className="composer-group-card"
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 12,
                  background: "white",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <h3 style={{ margin: 0, fontSize: 16 }}>Group {g.index}</h3>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>
                    {g.students.length} students
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
                  Skill focus:{" "}
                  <strong>{g.dominantCategory ?? "Mixed"}</strong>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {g.dominantCategory
                    ? `Cohesion ${g.cohesionPct}%`
                    : `Spread cohesion ${g.cohesionPct}% (lower = more varied)`}
                  {g.avgDominantPct != null
                    ? ` · Avg ${g.avgDominantPct}% in focus skill`
                    : ""}
                </div>
                <LevelMixChips mix={g.levelMix} />
                <ol style={{ marginTop: 8, paddingLeft: 18, fontSize: 13 }}>
                  {g.students.map((s) => (
                    <li key={s.studentId} style={{ marginBottom: 3 }}>
                      <span>{fullName(s)}</span>
                      {s.fastLevel != null && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            padding: "0 5px",
                            borderRadius: 8,
                            background: LEVEL_PALETTE[s.fastLevel],
                            color: LEVEL_TEXT[s.fastLevel],
                            fontWeight: 700,
                          }}
                        >
                          L{s.fastLevel}
                        </span>
                      )}
                      <span style={{ color: "#6b7280", marginLeft: 6 }}>
                        ({s.localSisId ?? "—"}
                        {s.overallPct != null ? ` · ${s.overallPct}%` : ""})
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>

          {result.overflow.length > 0 && (
            <div
              style={{
                marginTop: 18,
                border: "1px solid #fca5a5",
                borderRadius: 8,
                padding: 12,
                background: "#fef2f2",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 15, color: "#991b1b" }}>
                Over capacity ({result.overflow.length})
              </h3>
              <p style={{ margin: "4px 0 8px 0", fontSize: 12, color: "#7f1d1d" }}>
                Eligible students who didn't fit in the requested{" "}
                {result.requested.sections} sections × {result.requested.seats}{" "}
                seats. Add another section or raise seats / section to absorb
                them.
              </p>
              <ul style={{ paddingLeft: 18, fontSize: 13, columns: 2 }}>
                {result.overflow.map((u) => (
                  <li key={u.studentId}>
                    {fullName(u)}
                    {u.fastLevel != null && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          padding: "0 5px",
                          borderRadius: 8,
                          background: LEVEL_PALETTE[u.fastLevel],
                          color: LEVEL_TEXT[u.fastLevel],
                          fontWeight: 700,
                        }}
                      >
                        L{u.fastLevel}
                      </span>
                    )}{" "}
                    <span style={{ color: "#6b7280" }}>
                      ({u.localSisId ?? "—"}
                      {u.overallPct != null ? ` · ${u.overallPct}%` : ""})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.unscored.length > 0 && (
            <div
              style={{
                marginTop: 18,
                border: "1px dashed #d1d5db",
                borderRadius: 8,
                padding: 12,
                background: "#fefce8",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 15 }}>
                Unscored ({result.unscored.length})
              </h3>
              <p style={{ margin: "4px 0 8px 0", fontSize: 12, color: "#713f12" }}>
                These students have no FAST item responses for the chosen window
                and weren't auto-placed. Review and place manually.
              </p>
              <ul style={{ paddingLeft: 18, fontSize: 13, columns: 2 }}>
                {result.unscored.map((u) => (
                  <li key={u.studentId}>
                    {fullName(u)}{" "}
                    <span style={{ color: "#6b7280" }}>
                      ({u.localSisId ?? "—"})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
