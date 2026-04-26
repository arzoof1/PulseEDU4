import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Calculator,
  Filter,
  Info,
  TrendingUp,
} from "lucide-react";

// =============================================================================
// Program Effectiveness — Trajectory Archetypes
// =============================================================================
// Sister screen to ProgramEffectivenessSankey. Same FAST PM data, but
// bucketed by JOURNEY TYPE instead of flow ribbons.
//
// The Sankey answers "where did students move?" — great for a district
// admin scanning for system-wide patterns. This screen answers "which
// kinds of students do I have, and what should I do about them?" — the
// MTSS coordinator's question.
//
// Two views:
//   • Parent — 6 archetype tiles in a 3×2 grid. Each tile is a journey
//     pattern (Climbed / Held the line at At/Above / Slipped / Stuck at
//     Well Below / Volatile / Untested at PM3) with count, % of cohort,
//     a 3-dot journey illustration, a 1-line rule, and a CTA.
//   • Drill — clicking a tile reveals 3-4 sub-archetype tiles for that
//     cohort. Each sub-archetype is an actionable subgroup (e.g. for
//     Stuck: Closest to escape / Deeply stuck / No active intervention
//     / Chronic absence). Counts overlap by design.
//
// Data is synthetic, derived from the same Matrix shape as the Sankey
// so totals tie out when both screens are open side-by-side.
// =============================================================================

type BandKey = "above" | "below" | "well" | "na";
const BAND_ORDER: BandKey[] = ["above", "below", "well", "na"];

const BAND_COLOR: Record<BandKey, string> = {
  above: "#84cc16", // lime-500
  below: "#facc15", // yellow-400
  well: "#f87171", // red-400
  na: "#94a3b8", // slate-400
};

type Subject = "ela" | "math";
type GradeKey = "all" | "K" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";

type Matrix = Record<BandKey, Record<BandKey, number>>;

// -- Synthetic matrix (mirrors the Sankey constants) -------------------------

const BASE_MATRIX_ELA: Matrix = {
  above: { above: 1820, below: 280, well: 60, na: 30 },
  below: { above: 410, below: 520, well: 180, na: 25 },
  well: { above: 110, below: 360, well: 580, na: 30 },
  na: { above: 60, below: 90, well: 70, na: 80 },
};

const BASE_MATRIX_MATH: Matrix = {
  above: { above: 1640, below: 340, well: 90, na: 30 },
  below: { above: 320, below: 600, well: 220, na: 25 },
  well: { above: 80, below: 320, well: 720, na: 35 },
  na: { above: 50, below: 100, well: 80, na: 80 },
};

const GRADE_FACTORS: Record<GradeKey, number> = {
  all: 1.0,
  K: 0.11,
  "1": 0.12,
  "2": 0.12,
  "3": 0.13,
  "4": 0.13,
  "5": 0.13,
  "6": 0.09,
  "7": 0.09,
  "8": 0.08,
};

function buildMatrix(subject: Subject, grade: GradeKey): Matrix {
  const base = subject === "ela" ? BASE_MATRIX_ELA : BASE_MATRIX_MATH;
  const f = GRADE_FACTORS[grade];
  const out: Matrix = {
    above: { above: 0, below: 0, well: 0, na: 0 },
    below: { above: 0, below: 0, well: 0, na: 0 },
    well: { above: 0, below: 0, well: 0, na: 0 },
    na: { above: 0, below: 0, well: 0, na: 0 },
  };
  for (const from of BAND_ORDER) {
    for (const to of BAND_ORDER) {
      out[from][to] = Math.max(1, Math.round(base[from][to] * f));
    }
  }
  return out;
}

// -- Archetypes --------------------------------------------------------------

type ArchetypeKey =
  | "climbed"
  | "stayedHi"
  | "slipped"
  | "stuck"
  | "stayedLo"
  | "untested";

type ToneKey =
  | "emerald"
  | "lime"
  | "orange"
  | "red"
  | "amber"
  | "slate"
  | "violet";

interface ArchetypeDef {
  key: ArchetypeKey;
  title: string;
  rule: string;
  tone: ToneKey;
  // 3-dot journey illustration (PM1, PM2, PM3 representative bands).
  journey: [BandKey, BandKey, BandKey];
}

const ARCHETYPES: ArchetypeDef[] = [
  {
    key: "climbed",
    title: "Climbed",
    rule: "moved up at least one band",
    tone: "emerald",
    journey: ["well", "below", "above"],
  },
  {
    key: "stayedHi",
    title: "Held the line at At/Above",
    rule: "stayed on-grade all year",
    tone: "lime",
    journey: ["above", "above", "above"],
  },
  {
    key: "slipped",
    title: "Slipped",
    rule: "moved down at least one band",
    tone: "orange",
    journey: ["above", "above", "below"],
  },
  {
    key: "stuck",
    title: "Stuck at Well Below",
    rule: "Well Below all 3 PMs",
    tone: "red",
    journey: ["well", "well", "well"],
  },
  {
    key: "stayedLo",
    title: "Held the line at Below",
    rule: "stayed Below benchmark all year",
    tone: "amber",
    journey: ["below", "below", "below"],
  },
  {
    key: "untested",
    title: "Untested",
    rule: "missing PM1 or PM3 (or both)",
    tone: "slate",
    journey: ["above", "below", "na"],
  },
];

// Compute parent counts from the matrix. The 6 archetypes are exhaustive
// and disjoint by construction — every (from, to) cell of the 4×4 matrix
// is referenced exactly once across the buckets, so the sum equals the
// matrix total.
function archetypeCounts(m: Matrix): Record<ArchetypeKey, number> {
  // Climbed: PM3 band strictly above PM1 band (excluding NA on either end).
  //   matrix cells: below→above, well→above, well→below
  const climbed = m.below.above + m.well.above + m.well.below;
  // Held the line at At/Above.
  //   matrix cells: above→above
  const stayedHi = m.above.above;
  // Slipped: PM3 band strictly below PM1 band (excluding NA).
  //   matrix cells: above→below, above→well, below→well
  const slipped = m.above.below + m.above.well + m.below.well;
  // Stuck at Well Below all 3 PMs (only PM1 and PM3 are in the matrix —
  // PM2 wobbles within the band are surfaced in the drilldown).
  //   matrix cells: well→well
  const stuck = m.well.well;
  // Held the line at Below benchmark — stayed in the same off-grade band.
  // PM2 may have wobbled (true bouncers); that's a sub-archetype.
  //   matrix cells: below→below
  const stayedLo = m.below.below;
  // Untested = any student missing a PM1 or PM3 score (or both). This
  // includes na→tested (no baseline) and tested→na (no PM3) plus na→na.
  //   matrix cells: above→na, below→na, well→na, na→above, na→below,
  //                 na→well, na→na
  const untested =
    m.above.na +
    m.below.na +
    m.well.na +
    m.na.above +
    m.na.below +
    m.na.well +
    m.na.na;

  return { climbed, stayedHi, slipped, stuck, stayedLo, untested };
}

// -- Sub-archetype definitions -----------------------------------------------

interface SubCard {
  id: string;
  title: string;
  count: number;
  subtitle: string;
  desc: string;
  tone: ToneKey;
}

function subCardsFor(
  key: ArchetypeKey,
  parentCount: number,
  m: Matrix,
): SubCard[] {
  const r = (frac: number) => Math.max(1, Math.round(parentCount * frac));

  switch (key) {
    case "stuck":
      return [
        {
          id: "near-escape",
          title: "Closest to escape",
          count: r(0.06),
          subtitle: "within 5 points of Below",
          desc: "Small intervention now → band move. Highest leverage in the cohort.",
          tone: "emerald",
        },
        {
          id: "deeply-stuck",
          title: "Deeply stuck",
          count: r(0.24),
          subtitle: "scoring well under threshold",
          desc: "Escalate to Tier-3 referral. Most urgent academic need.",
          tone: "red",
        },
        {
          id: "no-intervention",
          title: "No active intervention",
          count: r(0.26),
          subtitle: "no plan on file",
          desc: "Refer to MTSS team — these students aren't being served yet.",
          tone: "orange",
        },
        {
          id: "chronic-absence",
          title: "Chronic absence",
          count: r(0.14),
          subtitle: "attendance under 80%",
          desc: "Engage family. Attendance is the primary lever, not academics.",
          tone: "slate",
        },
      ];

    case "climbed":
      return [
        {
          id: "big-climb",
          title: "Big climb",
          count: m.well.above,
          subtitle: "Well Below → At/Above",
          desc: "Two-band gainers. Whatever you did with these kids — bottle it.",
          tone: "emerald",
        },
        {
          id: "to-at-above",
          title: "Climbed into At/Above",
          count: m.below.above,
          subtitle: "Below → At/Above",
          desc: "On-grade now. Confirm gains hold next year — coast risk.",
          tone: "emerald",
        },
        {
          id: "out-of-stuck",
          title: "Climbed out of Well Below",
          count: m.well.below,
          subtitle: "Well Below → Below",
          desc: "Real progress. Keep the same intervention through summer.",
          tone: "lime",
        },
      ];

    case "stayedHi":
      return [
        {
          id: "stayed-l5",
          title: "Top of the chart",
          count: r(0.42),
          subtitle: "Level 5 all year",
          desc: "Enrichment candidates. Stretch them or you'll lose them.",
          tone: "lime",
        },
        {
          id: "stayed-l4",
          title: "Solid Level 4",
          count: r(0.36),
          subtitle: "comfortably above benchmark",
          desc: "Keep core instruction. Watch for spring slide.",
          tone: "lime",
        },
        {
          id: "stayed-l3-edge",
          title: "Level 3 — within 5 points of slipping",
          count: r(0.22),
          subtitle: "edge of the band",
          desc: "Quiet at-risk group. One bad PM and they're in Slipped.",
          tone: "amber",
        },
      ];

    case "slipped":
      return [
        {
          id: "slipped-into-stuck",
          title: "Slipped into Well Below",
          count: m.above.well + m.below.well,
          subtitle: "now Well Below",
          desc: "Newly Tier-3. Add to MTSS docket immediately.",
          tone: "red",
        },
        {
          id: "slipped-from-top",
          title: "Slipped from At/Above",
          count: m.above.below + m.above.well,
          subtitle: "regression risk",
          desc: "Re-test if recent. Was it a bad day, or are these kids slipping?",
          tone: "orange",
        },
        {
          id: "slipped-one-band",
          title: "Slipped exactly one band",
          count: m.above.below + m.below.well,
          subtitle: "smaller drops",
          desc: "Salvageable with quick check-ins. Don't wait until next PM.",
          tone: "amber",
        },
      ];

    case "stayedLo":
      return [
        {
          id: "edge-of-climb",
          title: "Edge of climb",
          count: r(0.22),
          subtitle: "within 5 pts of At/Above",
          desc: "One push away from on-grade. Highest leverage in the band.",
          tone: "emerald",
        },
        {
          id: "wobblers",
          title: "Wobbled at PM2",
          count: r(0.30),
          subtitle: "PM2 spiked or dipped, returned to Below",
          desc: "Lost or regained momentum mid-year. Investigate Q2/Q3 events.",
          tone: "orange",
        },
        {
          id: "edge-of-slip",
          title: "Edge of slip",
          count: r(0.20),
          subtitle: "within 5 pts of Well Below",
          desc: "At risk of dropping next year. Add to MTSS watch list.",
          tone: "red",
        },
        {
          id: "core-mid",
          title: "Stable mid-band",
          count: r(0.28),
          subtitle: "comfortably in the middle of Below",
          desc: "Not moving — neither climbing nor slipping. Try a new approach.",
          tone: "slate",
        },
      ];

    case "untested":
      return [
        {
          id: "newly-enrolled",
          title: "No PM1 baseline",
          count: r(0.42),
          subtitle: "arrived after PM1 window",
          desc: "Tested at PM3 but no baseline. Use prior-year score if available.",
          tone: "violet",
        },
        {
          id: "absent-pm3",
          title: "Absent for PM3",
          count: r(0.36),
          subtitle: "need make-up testing",
          desc: "Schedule make-up in the next 2 weeks before window closes.",
          tone: "orange",
        },
        {
          id: "no-data",
          title: "Untested both windows",
          count: r(0.22),
          subtitle: "neither PM1 nor PM3 on file",
          desc: "Likely chronic absence or recent transfer. Pull cumulative file.",
          tone: "slate",
        },
      ];
  }
}

// -- Tone styling ------------------------------------------------------------

interface ToneStyle {
  stripe: string;
  count: string;
  chip: string;
}

const TONE: Record<ToneKey, ToneStyle> = {
  emerald: {
    stripe: "bg-emerald-500",
    count: "text-emerald-600",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  lime: {
    stripe: "bg-lime-400",
    count: "text-lime-600",
    chip: "bg-lime-50 text-lime-700 border-lime-200",
  },
  orange: {
    stripe: "bg-orange-500",
    count: "text-orange-600",
    chip: "bg-orange-50 text-orange-700 border-orange-200",
  },
  red: {
    stripe: "bg-red-500",
    count: "text-red-600",
    chip: "bg-red-50 text-red-700 border-red-200",
  },
  amber: {
    stripe: "bg-amber-400",
    count: "text-amber-600",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
  },
  slate: {
    stripe: "bg-slate-400",
    count: "text-slate-600",
    chip: "bg-slate-100 text-slate-700 border-slate-200",
  },
  violet: {
    stripe: "bg-violet-400",
    count: "text-violet-600",
    chip: "bg-violet-50 text-violet-700 border-violet-200",
  },
};

// =============================================================================
// Main component
// =============================================================================

export function ProgramEffectivenessTrajectory() {
  const [subject, setSubject] = useState<Subject>("ela");
  const [grade, setGrade] = useState<GradeKey>("all");
  const [drillKey, setDrillKey] = useState<ArchetypeKey | null>(null);

  const matrix = useMemo(() => buildMatrix(subject, grade), [subject, grade]);

  const counts = useMemo(() => archetypeCounts(matrix), [matrix]);

  const total = useMemo(
    () =>
      BAND_ORDER.reduce(
        (s, from) =>
          s + BAND_ORDER.reduce((s2, to) => s2 + matrix[from][to], 0),
        0,
      ),
    [matrix],
  );

  // Dev-only invariant: archetype counts must sum to the matrix total.
  // If this ever fires, archetypeCounts() has lost its disjoint-and-
  // exhaustive property — fix it before the screen lies to a coordinator.
  if (import.meta.env.DEV) {
    const sum = Object.values(counts).reduce((s, n) => s + n, 0);
    if (sum !== total) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Trajectory] count mismatch: archetype sum ${sum} !== matrix total ${total}`,
      );
    }
  }

  const drillDef = drillKey
    ? ARCHETYPES.find((a) => a.key === drillKey)!
    : null;

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 flex flex-col">
      {/* HEADER -------------------------------------------------------- */}
      <header className="px-8 py-5 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 grid place-items-center shadow">
              <TrendingUp className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="text-xs font-bold tracking-[0.2em] text-slate-500 uppercase">
                Insights · MTSS
              </div>
              <h1 className="text-2xl font-black leading-tight">
                Program Effectiveness · by Trajectory
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="flex items-center gap-1 text-xs font-semibold text-slate-500 mr-1">
              <Filter className="h-3.5 w-3.5" />
              FILTERS
            </div>
            <SubjectChip
              active={subject === "ela"}
              onClick={() => setSubject("ela")}
              icon={BookOpen}
              label="ELA"
            />
            <SubjectChip
              active={subject === "math"}
              onClick={() => setSubject("math")}
              icon={Calculator}
              label="Math"
            />
            <Select
              value={grade}
              onChange={(v) => setGrade(v as GradeKey)}
              options={[
                { value: "all", label: "All grades" },
                { value: "K", label: "Grade K" },
                { value: "1", label: "Grade 1" },
                { value: "2", label: "Grade 2" },
                { value: "3", label: "Grade 3" },
                { value: "4", label: "Grade 4" },
                { value: "5", label: "Grade 5" },
                { value: "6", label: "Grade 6" },
                { value: "7", label: "Grade 7" },
                { value: "8", label: "Grade 8" },
              ]}
            />
          </div>
        </div>

        {/* Stat strip — same shape as the Sankey strip */}
        <div className="mt-4 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-slate-600">
            <span className="font-semibold text-slate-900">PM1 · Beginning</span>
            <span className="text-slate-400">→</span>
            <span className="font-semibold text-slate-900">PM3 · End</span>
            <span className="text-slate-400 mx-2">·</span>
            <span>
              {subject === "ela" ? "FAST aReading" : "FAST aMath"}
              {grade !== "all" ? ` · ${gradeLabel(grade)}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <Stat label="Total students" value={total.toLocaleString()} />
            <Stat
              label="On track"
              value={(counts.climbed + counts.stayedHi).toLocaleString()}
              tone="up"
            />
            <Stat
              label="Off track"
              value={(
                counts.slipped +
                counts.stuck +
                counts.stayedLo
              ).toLocaleString()}
              tone="down"
            />
            <Stat label="Untested" value={counts.untested.toLocaleString()} />
          </div>
        </div>
      </header>

      {/* BODY ---------------------------------------------------------- */}
      <main className="flex-1 px-8 py-6 flex flex-col gap-4 min-h-0">
        {drillDef ? (
          <DrillView
            def={drillDef}
            count={counts[drillDef.key]}
            total={total}
            matrix={matrix}
            onBack={() => setDrillKey(null)}
          />
        ) : (
          <ParentGrid
            counts={counts}
            total={total}
            onPick={(k) => setDrillKey(k)}
          />
        )}
      </main>

      {/* FOOTER -------------------------------------------------------- */}
      <footer className="px-8 py-3 border-t border-slate-200 bg-white text-xs text-slate-500 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5" />
          {drillDef
            ? "Sub-groups within an archetype may overlap (one student can be in multiple). Counts are per group, not exclusive."
            : "Each student appears in exactly one archetype. Click any tile to see actionable sub-groups."}
        </div>
        <div className="text-slate-400">
          PulseEDU · Insights · Mock data for design review
        </div>
      </footer>
    </div>
  );
}

// =============================================================================
// Parent grid (6 archetype tiles)
// =============================================================================

function ParentGrid({
  counts,
  total,
  onPick,
}: {
  counts: Record<ArchetypeKey, number>;
  total: number;
  onPick: (k: ArchetypeKey) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-4 flex-1 min-h-0">
      {ARCHETYPES.map((a) => (
        <ArchetypeTile
          key={a.key}
          def={a}
          count={counts[a.key]}
          pct={total > 0 ? (counts[a.key] / total) * 100 : 0}
          onClick={() => onPick(a.key)}
        />
      ))}
    </div>
  );
}

function ArchetypeTile({
  def,
  count,
  pct,
  onClick,
}: {
  def: ArchetypeDef;
  count: number;
  pct: number;
  onClick: () => void;
}) {
  const t = TONE[def.tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative text-left bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300 transition-all overflow-hidden flex flex-col"
    >
      {/* tone stripe */}
      <span
        className={`absolute left-0 top-0 bottom-0 w-2 ${t.stripe}`}
        aria-hidden
      />

      <div className="px-5 pt-5 pb-4 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-bold text-slate-900 leading-tight">
            {def.title}
          </h2>
          <JourneyDots journey={def.journey} />
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          <div
            className={`text-5xl font-black tabular-nums leading-none ${t.count}`}
          >
            {count.toLocaleString()}
          </div>
          <div className="text-sm font-semibold text-slate-500 tabular-nums">
            {pct.toFixed(1)}% of cohort
          </div>
        </div>

        <p className="mt-3 text-sm text-slate-600 leading-snug">
          {def.rule}
        </p>

        <div className="mt-auto pt-4 flex items-center justify-between">
          <span
            className={`inline-flex items-center gap-1 text-xs font-bold rounded-full border px-2.5 py-1 ${t.chip}`}
          >
            Trajectory
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-violet-700 group-hover:text-violet-900">
            See these students
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </button>
  );
}

function JourneyDots({ journey }: { journey: [BandKey, BandKey, BandKey] }) {
  return (
    <div className="flex items-center gap-1.5 pt-0.5">
      {journey.map((b, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span
            className="block h-3 w-3 rounded-full ring-2 ring-white shadow-sm"
            style={{ backgroundColor: BAND_COLOR[b] }}
            aria-label={b}
          />
          {i < 2 && (
            <span className="block h-px w-3 bg-slate-300" aria-hidden />
          )}
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Drill view (sub-archetype tiles)
// =============================================================================

function DrillView({
  def,
  count,
  total,
  matrix,
  onBack,
}: {
  def: ArchetypeDef;
  count: number;
  total: number;
  matrix: Matrix;
  onBack: () => void;
}) {
  const t = TONE[def.tone];
  const subs = useMemo(
    () => subCardsFor(def.key, count, matrix),
    [def.key, count, matrix],
  );

  // For the residual chunk: subs may not sum to count (overlap or
  // un-flagged stable students). Compute residual for the footer copy.
  const subsTotal = subs.reduce((s, c) => s + c.count, 0);
  const residual = Math.max(0, count - subsTotal);

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      {/* Drill header card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to trajectories
          </button>
          <div className="flex items-center gap-3">
            <span className={`block h-10 w-2 rounded ${t.stripe}`} aria-hidden />
            <div>
              <div className="text-xs font-bold tracking-[0.18em] text-slate-500 uppercase">
                Trajectory drill-in
              </div>
              <div className="text-xl font-black text-slate-900 leading-tight">
                {def.title}{" "}
                <span className={`font-black tabular-nums ${t.count}`}>
                  · {count.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">
            {total > 0 ? ((count / total) * 100).toFixed(1) : "0.0"}%
          </span>{" "}
          of {total.toLocaleString()} students · sub-divided by what to do next
        </div>
      </div>

      {/* Sub-archetype tiles */}
      <div
        className={`grid gap-4 flex-1 min-h-0 ${
          subs.length === 4 ? "grid-cols-4" : "grid-cols-3"
        }`}
      >
        {subs.map((s) => (
          <SubTile key={s.id} card={s} />
        ))}
      </div>

      {residual > 0 && (
        <div className="text-xs text-slate-500 px-1">
          The remaining{" "}
          <span className="font-semibold text-slate-700">
            {residual.toLocaleString()}
          </span>{" "}
          students in this group don't trip any of the urgent flags above —
          recheck at next PM window.
        </div>
      )}
    </div>
  );
}

function SubTile({ card }: { card: SubCard }) {
  const t = TONE[card.tone];
  return (
    <div className="relative bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <span
        className={`absolute left-0 top-0 bottom-0 w-2 ${t.stripe}`}
        aria-hidden
      />
      <div className="px-5 pt-5 pb-4 flex-1 flex flex-col">
        <h3 className="text-base font-bold text-slate-900 leading-tight">
          {card.title}
        </h3>
        <div
          className={`mt-3 text-5xl font-black tabular-nums leading-none ${t.count}`}
        >
          {card.count.toLocaleString()}
        </div>
        <div className="mt-1 text-xs font-semibold text-slate-500">
          students · {card.subtitle}
        </div>
        <p className="mt-3 text-sm text-slate-600 leading-snug">{card.desc}</p>
        <button
          type="button"
          className="mt-auto pt-4 inline-flex items-center gap-1 text-sm font-semibold text-violet-700 hover:text-violet-900 self-start"
        >
          View these {card.count.toLocaleString()} students
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Small UI helpers (local copies — not shared with the Sankey screen yet)
// =============================================================================

function gradeLabel(g: GradeKey): string {
  return g === "K" ? "Kindergarten" : `Grade ${g}`;
}

function SubjectChip({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold border transition-colors ${
        active
          ? "bg-slate-900 text-white border-slate-900"
          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-full px-3 py-1.5 text-sm font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  const valueColor =
    tone === "up"
      ? "text-emerald-600"
      : tone === "down"
        ? "text-rose-600"
        : "text-slate-900";
  return (
    <div className="flex flex-col items-end">
      <div
        className={`text-base font-black tabular-nums leading-none ${valueColor}`}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">
        {label}
      </div>
    </div>
  );
}
