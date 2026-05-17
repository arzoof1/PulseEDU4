// Academics Trajectory — graduates the "Trajectory Archetypes" mockup
// from the canvas into the live Insights hub. Same six-archetype taxonomy
// (Climbed / Held the line at At/Above / Slipped / Stuck at Well Below /
// Held the line at Below / Untested), but every count comes from a real
// FAST PM1 → PM3 placement via /api/insights/academics/trajectory.
//
// The 4×4 (PM1 band × PM3 band) matrix returned by the API is exhaustive
// and disjoint by construction, so the parent counts always sum to the
// cohort total — and within each parent the sub-archetype counts also
// sum to the parent count. A DEV-only invariant warns if either tie-out
// ever drifts.
//
// Permission: backend gates this to core team (same predicate as
// /insights/academics).

import { useEffect, useMemo, useState } from "react";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Calculator,
  Filter,
  Info,
  TrendingUp,
} from "lucide-react";
import { authFetch } from "../lib/authToken";
import InsightsFilterBar, {
  EMPTY_FILTERS,
  filtersToQuery,
  type InsightsFilterValue,
} from "./InsightsFilterBar";
import BandStudentsDrawer from "./BandStudentsDrawer";

// =============================================================================
// Types
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
type Matrix = Record<BandKey, Record<BandKey, number>>;

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
    rule: "Well Below at PM1 and PM3",
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

// =============================================================================
// Sub-archetype display config
// =============================================================================
//
// Each entry maps a backend `subKey` to a UI presentation (title, subtitle,
// description, tone). The order is the order tiles appear in the drill view.
// `count` is filled in at render time from `subCounts[archetype][subKey]`.

interface SubCardDef {
  subKey: string;
  title: string;
  subtitle: string;
  desc: string;
  tone: ToneKey;
}

const SUBS: Record<ArchetypeKey, SubCardDef[]> = {
  climbed: [
    {
      subKey: "bigLeap",
      title: "Big leap",
      subtitle: "Well Below → At/Above",
      desc: "Two-band gainers. Whatever you did with these kids — bottle it.",
      tone: "emerald",
    },
    {
      subKey: "crossedToProf",
      title: "Crossed to At/Above",
      subtitle: "Below → At/Above",
      desc: "On-grade now. Confirm the gain holds next year — coast risk.",
      tone: "emerald",
    },
    {
      subKey: "firstStep",
      title: "First step up",
      subtitle: "Well Below → Below",
      desc: "Real progress. Keep the same intervention through summer.",
      tone: "lime",
    },
  ],
  stayedHi: [
    {
      subKey: "l5",
      title: "Top of the chart",
      subtitle: "Level 5 at PM3",
      desc: "Enrichment candidates. Stretch them or you'll lose them.",
      tone: "lime",
    },
    {
      subKey: "l4",
      title: "Solid Level 4",
      subtitle: "comfortably above benchmark",
      desc: "Keep core instruction. Watch for spring slide.",
      tone: "lime",
    },
    {
      subKey: "l3",
      title: "Steady at Level 3",
      subtitle: "on the edge of the proficient band",
      desc: "Quietest at-risk group. One bad PM and they're in Slipped.",
      tone: "amber",
    },
  ],
  slipped: [
    {
      subKey: "slippedToL1",
      title: "Slipped from Below to L1",
      subtitle: "Below → Well Below",
      desc: "Newly Tier-3. Add to MTSS docket immediately.",
      tone: "red",
    },
    {
      subKey: "bigDrop",
      title: "Big drop from At/Above",
      subtitle: "At/Above → Well Below",
      desc: "Two-band slip. Re-test if recent — bad day, or real regression?",
      tone: "red",
    },
    {
      subKey: "slippedOneBand",
      title: "Slipped one band",
      subtitle: "At/Above → Below",
      desc: "Salvageable with quick check-ins. Don't wait until next PM.",
      tone: "orange",
    },
  ],
  stuck: [
    {
      subKey: "closestToEscape",
      title: "Closest to escape",
      subtitle: "L1 High at PM3",
      desc: "Small intervention now → band move. Highest leverage in this cohort.",
      tone: "emerald",
    },
    {
      subKey: "midStuck",
      title: "Mid Level 1",
      subtitle: "L1 Middle at PM3",
      desc: "Steady but stuck. Try a fresh strategy — current plan isn't moving them.",
      tone: "orange",
    },
    {
      subKey: "deeplyStuck",
      title: "Deeply stuck",
      subtitle: "L1 Low at PM3",
      desc: "Escalate to Tier-3 referral. Most urgent academic need.",
      tone: "red",
    },
  ],
  stayedLo: [
    {
      subKey: "edgeOfClimb",
      title: "Edge of climb",
      subtitle: "PM3 in upper Below (L2 High)",
      desc: "One push away from on-grade. Highest leverage in the band.",
      tone: "emerald",
    },
    {
      subKey: "wobbled",
      title: "Wobbled at PM2",
      subtitle: "PM2 placement differed from PM1 + PM3",
      desc: "Lost or regained momentum mid-year. Investigate Q2 / Q3 events.",
      tone: "orange",
    },
    {
      subKey: "edgeOfSlip",
      title: "Edge of slip",
      subtitle: "PM3 in lower Below (L2 Low)",
      desc: "At risk of dropping next year. Add to MTSS watch list.",
      tone: "red",
    },
  ],
  untested: [
    {
      subKey: "noPm1",
      title: "No PM1 baseline",
      subtitle: "tested at PM3 only",
      desc: "Use prior-year score if available; flag for next year's PM1.",
      tone: "violet",
    },
    {
      subKey: "noPm3",
      title: "Absent for PM3",
      subtitle: "tested at PM1 only",
      desc: "Schedule make-up before the window closes.",
      tone: "orange",
    },
    {
      subKey: "bothMissing",
      title: "Untested both windows",
      subtitle: "no FAST score on file",
      desc: "Likely chronic absence or recent transfer. Pull cumulative file.",
      tone: "slate",
    },
  ],
};

// =============================================================================
// Tone styling — mockup palette, kept verbatim so the live screen visually
// matches the design review.
// =============================================================================

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
// API shape (mirrors routes/insights.ts)
// =============================================================================

interface TrajectoryResponse {
  subject: Subject;
  grade: string | null;
  total: number;
  bandOrder: BandKey[];
  matrix: Matrix;
  counts: Record<ArchetypeKey, number>;
  subCounts: Record<ArchetypeKey, Record<string, number>>;
}

interface TrajStudent {
  studentId: string;
  studentName: string;
  grade: number | null;
  pm1: number | null;
  pm3: number | null;
}

interface TrajectoryStudentsResponse {
  subject: Subject;
  archetype: ArchetypeKey;
  subKey: string | null;
  students: TrajStudent[];
  truncated: boolean;
  total: number;
}

// =============================================================================
// Props + grade options
// =============================================================================

interface Props {
  onOpenProfile: (studentId: string) => void;
}

// Multi-select grade chips. "" = special "All grades" pseudo-value, kept
// separate from the Set so it stays the canonical "no filter" state.
const GRADE_CHIPS: { value: string; label: string }[] = [
  { value: "K", label: "K" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5" },
  { value: "6", label: "6" },
  { value: "7", label: "7" },
  { value: "8", label: "8" },
  { value: "9", label: "9" },
  { value: "10", label: "10" },
  { value: "11", label: "11" },
  { value: "12", label: "12" },
];

// =============================================================================
// Main component
// =============================================================================

export default function AcademicsTrajectory({ onOpenProfile }: Props) {
  const [subject, setSubject] = useState<Subject>("ela");
  // Empty set = "all grades". Order is preserved in the query string.
  const [selectedGrades, setSelectedGrades] = useState<string[]>([]);
  const [filters, setFilters] = useState<InsightsFilterValue>(EMPTY_FILTERS);
  const [drillKey, setDrillKey] = useState<ArchetypeKey | null>(null);

  const [data, setData] = useState<TrajectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Drill drawer state.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerArchetype, setDrawerArchetype] = useState<ArchetypeKey | null>(
    null,
  );
  const [drawerSubKey, setDrawerSubKey] = useState<string | null>(null);
  const [drawerData, setDrawerData] =
    useState<TrajectoryStudentsResponse | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState("");

  function buildQuery(): URLSearchParams {
    const qs = filtersToQuery(filters);
    qs.set("subject", subject);
    if (selectedGrades.length > 0) qs.set("grades", selectedGrades.join(","));
    return qs;
  }

  const toggleGrade = (v: string) => {
    setSelectedGrades((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  };
  const clearGrades = () => setSelectedGrades([]);

  const gradeLabel =
    selectedGrades.length === 0
      ? "All grades"
      : selectedGrades.length === 1
      ? `Grade ${selectedGrades[0]}`
      : `${selectedGrades.length} grades`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const qs = buildQuery();
    authFetch(`/api/insights/academics/trajectory?${qs.toString()}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as TrajectoryResponse;
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, selectedGrades, filters]);

  // Switching subject/grade should drop the drill state — counts will
  // shift and the open archetype may end up empty.
  useEffect(() => {
    setDrillKey(null);
  }, [subject, selectedGrades, filters]);

  // Dev-only invariants: parent counts must sum to total; sub counts
  // within each parent must sum to that parent's count. If either ever
  // fires, the API is lying and the screen is misleading the coordinator.
  useEffect(() => {
    if (!data || !import.meta.env.DEV) return;
    const sum = Object.values(data.counts).reduce((s, n) => s + n, 0);
    if (sum !== data.total) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Trajectory] parent count mismatch: ${sum} !== matrix total ${data.total}`,
      );
    }
    for (const k of Object.keys(data.counts) as ArchetypeKey[]) {
      const sub = data.subCounts[k] ?? {};
      const subSum = Object.values(sub).reduce((s, n) => s + n, 0);
      if (subSum !== data.counts[k]) {
        // eslint-disable-next-line no-console
        console.warn(
          `[Trajectory] sub count mismatch for ${k}: subSum ${subSum} !== parent ${data.counts[k]}`,
        );
      }
    }
  }, [data]);

  function openDrawer(archetype: ArchetypeKey, subKey: string | null) {
    setDrawerArchetype(archetype);
    setDrawerSubKey(subKey);
    setDrawerOpen(true);
    setDrawerLoading(true);
    setDrawerError("");
    setDrawerData(null);
    const qs = buildQuery();
    qs.set("archetype", archetype);
    if (subKey) qs.set("subKey", subKey);
    authFetch(
      `/api/insights/academics/trajectory/students?${qs.toString()}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setDrawerError(body.error || `Request failed (${r.status})`);
          return;
        }
        const json = (await r.json()) as TrajectoryStudentsResponse;
        setDrawerData(json);
      })
      .catch((e) => setDrawerError(String(e?.message ?? e)))
      .finally(() => setDrawerLoading(false));
  }

  const drillDef = drillKey
    ? ARCHETYPES.find((a) => a.key === drillKey) ?? null
    : null;

  // Drawer title (parent or sub-card).
  let drawerTitle = "";
  if (drawerArchetype) {
    const parent = ARCHETYPES.find((a) => a.key === drawerArchetype);
    if (parent) {
      if (drawerSubKey) {
        const sub = SUBS[drawerArchetype].find(
          (s) => s.subKey === drawerSubKey,
        );
        drawerTitle = `${parent.title} · ${sub?.title ?? drawerSubKey}`;
      } else {
        drawerTitle = parent.title;
      }
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Academic Trajectories</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            FAST PM1 → PM3 by journey type — click any archetype to see
            actionable sub-groups and the students inside them.
          </p>
          <HowToUseHelp title="How to use Academic Trajectories">
            <HowToSection title="What this page is">
              A grouping of every progress-monitored student into one
              of six journeys (Soaring, Climbing, Plateauing, Sliding,
              Stuck-Low, New Data). Sub-groups inside each card surface
              the kids you can act on this week.
            </HowToSection>
            <HowToSection title="How to read the chart">
              <ul style={howtoListStyle}>
                <li>Each line is one student PM1 → PM2 → PM3.</li>
                <li>The grade-band thresholds are the dashed grid.</li>
                <li>Click an archetype card to filter the chart and the student list.</li>
              </ul>
            </HowToSection>
            <RoleSection for={["coreTeam", "admin"]} title="What to do with it">
              The "Sliding" and "Stuck-Low" buckets are the SST referral
              shortlist. Click into a student to see the full profile
              and start an MTSS plan from there.
            </RoleSection>
          </HowToUseHelp>
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 700,
              color: "#64748b",
              marginRight: 4,
            }}
          >
            <Filter style={{ width: 14, height: 14 }} />
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
          <GradeChip
            active={selectedGrades.length === 0}
            onClick={clearGrades}
            label="All grades"
          />
          {GRADE_CHIPS.map((g) => (
            <GradeChip
              key={g.value}
              active={selectedGrades.includes(g.value)}
              onClick={() => toggleGrade(g.value)}
              label={g.label}
            />
          ))}
        </div>
      </div>

      <InsightsFilterBar value={filters} onChange={setFilters} />

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading trajectory data…
        </p>
      )}
      {error && (
        <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>
      )}

      {data && !loading && !error && (
        <>
          {/* KPI strip */}
          <div
            style={{
              marginTop: "1rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "0.75rem",
              borderTop: "1px solid #e2e8f0",
              paddingTop: "0.75rem",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "#475569",
              }}
            >
              <TrendingUp
                style={{ width: 16, height: 16, color: "#7c3aed" }}
              />
              <span style={{ fontWeight: 700, color: "#0f172a" }}>
                PM1 · Beginning
              </span>
              <span style={{ color: "#94a3b8" }}>→</span>
              <span style={{ fontWeight: 700, color: "#0f172a" }}>
                PM3 · End
              </span>
              <span style={{ color: "#94a3b8", margin: "0 4px" }}>·</span>
              <span>
                {subject === "ela" ? "FAST aReading" : "FAST aMath"}
                {selectedGrades.length > 0 ? ` · ${gradeLabel}` : ""}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "1rem",
                fontSize: 12,
              }}
            >
              <Stat
                label="Total students"
                value={data.total.toLocaleString()}
              />
              <Stat
                label="On track"
                value={(
                  data.counts.climbed + data.counts.stayedHi
                ).toLocaleString()}
                tone="up"
              />
              <Stat
                label="Off track"
                value={(
                  data.counts.slipped +
                  data.counts.stuck +
                  data.counts.stayedLo
                ).toLocaleString()}
                tone="down"
              />
              <Stat
                label="Untested"
                value={data.counts.untested.toLocaleString()}
              />
            </div>
          </div>

          {/* Body */}
          <div style={{ marginTop: "1rem" }}>
            {drillDef ? (
              <DrillView
                def={drillDef}
                count={data.counts[drillDef.key]}
                total={data.total}
                subCounts={data.subCounts[drillDef.key] ?? {}}
                onBack={() => setDrillKey(null)}
                onOpenStudents={(subKey) =>
                  openDrawer(drillDef.key, subKey)
                }
              />
            ) : (
              <ParentGrid
                counts={data.counts}
                total={data.total}
                onPick={(k) => setDrillKey(k)}
              />
            )}
          </div>

          {/* Footer note */}
          <div
            style={{
              marginTop: "0.75rem",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "#64748b",
            }}
          >
            <Info style={{ width: 14, height: 14 }} />
            {drillDef
              ? "Sub-groups within an archetype are disjoint — each student appears in exactly one sub-group, and the sub-counts sum to the parent."
              : "Each student appears in exactly one archetype. Click any tile to see actionable sub-groups."}
          </div>
        </>
      )}

      <BandStudentsDrawer
        open={drawerOpen}
        title={drawerTitle}
        subtitle={
          drawerData
            ? `${drawerData.total} student${drawerData.total === 1 ? "" : "s"}${drawerData.truncated ? ` (showing first ${drawerData.students.length})` : ""}`
            : undefined
        }
        // Pass pm1/pm3 through as-is (including nulls). The drawer
        // renders "—" for missing scores, which is the honest signal
        // for the Untested archetype rather than a fabricated 0.
        students={drawerData?.students ?? []}
        truncated={drawerData?.truncated}
        total={drawerData?.total}
        loading={drawerLoading}
        error={drawerError}
        onClose={() => setDrawerOpen(false)}
        onOpenProfile={(id) => {
          setDrawerOpen(false);
          onOpenProfile(id);
        }}
      />
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
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
      <span
        className={`absolute left-0 top-0 bottom-0 w-2 ${t.stripe}`}
        aria-hidden
      />
      <div className="px-5 pt-5 pb-4 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-bold text-slate-900 leading-tight">
            {def.title}
          </h3>
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
        <p className="mt-3 text-sm text-slate-600 leading-snug">{def.rule}</p>
        <div className="mt-auto pt-4 flex items-center justify-between">
          <span
            className={`inline-flex items-center gap-1 text-xs font-bold rounded-full border px-2.5 py-1 ${t.chip}`}
          >
            Trajectory
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-violet-700 group-hover:text-violet-900">
            See sub-groups
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
          {i < BAND_ORDER.length - 2 && (
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
  subCounts,
  onBack,
  onOpenStudents,
}: {
  def: ArchetypeDef;
  count: number;
  total: number;
  subCounts: Record<string, number>;
  onBack: () => void;
  onOpenStudents: (subKey: string) => void;
}) {
  const t = TONE[def.tone];
  const subCards = useMemo(
    () =>
      SUBS[def.key].map((s) => ({ ...s, count: subCounts[s.subKey] ?? 0 })),
    [def.key, subCounts],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Drill header */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex items-center justify-between flex-wrap gap-3">
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
            <span
              className={`block h-10 w-2 rounded ${t.stripe}`}
              aria-hidden
            />
            <div>
              <div className="text-[10px] font-bold tracking-[0.18em] text-slate-500 uppercase">
                Trajectory drill-in
              </div>
              <div className="text-lg font-black text-slate-900 leading-tight">
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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {subCards.map((s) => (
          <SubTile
            key={s.subKey}
            card={s}
            onOpen={() => onOpenStudents(s.subKey)}
          />
        ))}
      </div>
    </div>
  );
}

function SubTile({
  card,
  onOpen,
}: {
  card: SubCardDef & { count: number };
  onOpen: () => void;
}) {
  const t = TONE[card.tone];
  const disabled = card.count === 0;
  return (
    <div className="relative bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <span
        className={`absolute left-0 top-0 bottom-0 w-2 ${t.stripe}`}
        aria-hidden
      />
      <div className="px-5 pt-5 pb-4 flex-1 flex flex-col">
        <h4 className="text-base font-bold text-slate-900 leading-tight">
          {card.title}
        </h4>
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
          onClick={onOpen}
          disabled={disabled}
          className={`mt-auto pt-4 inline-flex items-center gap-1 text-sm font-semibold self-start ${
            disabled
              ? "text-slate-400 cursor-not-allowed"
              : "text-violet-700 hover:text-violet-900"
          }`}
        >
          {disabled
            ? "No students in this group"
            : `View these ${card.count.toLocaleString()} students`}
          {!disabled && <ArrowRight className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Small UI helpers
// =============================================================================

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

function GradeChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  // Match InsightsFilterBar's selected-chip palette (#2563eb / white)
  // so multi-select feels native to the rest of the insights screens.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 34,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        transition: "background-color 120ms, color 120ms, border-color 120ms",
        border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
        background: active ? "#2563eb" : "white",
        color: active ? "white" : "#334155",
        boxShadow: active ? "0 0 0 2px rgba(37,99,235,0.18)" : "none",
      }}
    >
      {label}
    </button>
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
    tone === "up" ? "#16a34a" : tone === "down" ? "#dc2626" : "#0f172a";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 900,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          color: valueColor,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "#64748b",
          marginTop: 2,
        }}
      >
        {label}
      </div>
    </div>
  );
}

