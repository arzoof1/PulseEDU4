// Academics Dashboard — school-level eduCLIMBER-style "Academics" domain.
// Renders the totals, PM1→PM2→PM3 cohort progression, PM3 placement
// distribution, and top-N lists returned by GET /api/insights/academics.
// Click a student name → opens that student's profile via onOpenProfile.
//
// Permission: backend gates this to core team (Admin / SuperUser /
// Behavior Specialist / MTSS Coord / PBIS Coord). The caller (App.tsx)
// should only mount this when the user passes that bar; we still render
// a clean error message if the backend rejects.
//
// Note: unlike Engagement and Behavior, this dashboard intentionally
// has NO time-window picker — academic data lives at fixed assessment
// dates (PM1/PM2/PM3, AP1/AP2/AP3) so a windowed daily trend would just
// be three spikes. The cohort-progression line is the honest visual.

import { useEffect, useState } from "react";
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
} from "recharts";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, howtoListStyle } from "./HowToUseHelp";
import InsightsFilterBar, {
  EMPTY_FILTERS,
  filtersToQuery,
  type InsightsFilterValue,
} from "./InsightsFilterBar";
import BandStudentsDrawer from "./BandStudentsDrawer";

interface Grower {
  studentId: string;
  studentName: string;
  pm1: number;
  pm3: number;
  delta: number;
}

interface LowPm3 {
  studentId: string;
  studentName: string;
  pm3: number;
  level: 1 | 2 | 3 | 4 | 5;
}

interface AcademicsResponse {
  grade: string | null;
  totals: {
    studentsAssessed: number;
    elaPm3Average: number | null;
    mathPm3Average: number | null;
    atOrAboveLevel3Pct: number | null;
    bottomQuartilePct: number | null;
    growersPct: number | null;
  };
  progression: {
    ela: { window: string; score: number }[];
    math: { window: string; score: number }[];
  };
  placementDistribution: {
    ela: { level: number; count: number }[];
    math: { level: number; count: number }[];
  };
  topLists: {
    topGrowersEla: Grower[];
    topGrowersMath: Grower[];
    lowestPm3Ela: LowPm3[];
    lowestPm3Math: LowPm3[];
  };
  sources: { fast: number; iReady: number; sci: number };
}

interface Props {
  onOpenProfile: (studentId: string) => void;
}

const GRADE_OPTIONS = [
  { value: "", label: "All grades" },
  { value: "K", label: "K" },
  ...Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: `Grade ${i + 1}`,
  })),
];

// Subject palette: blue=ELA, orange=Math (matches conventional ed reports).
const ELA_COLOR = "#2563eb"; // blue-600
const MATH_COLOR = "#ea580c"; // orange-600
// Outcome palette for KPI accents.
const SUCCESS_COLOR = "#16a34a"; // green-600 — % at L3+, % growers
const RISK_COLOR = "#dc2626"; // red-600 — % BQ

interface BandStudent {
  studentId: string;
  studentName: string;
  grade: number | null;
  pm1: number | null;
  pm3: number;
}

interface BandResponse {
  subject: "ela" | "math";
  level: 1 | 2 | 3 | 4 | 5;
  students: BandStudent[];
  truncated: boolean;
  total: number;
}

const LEVEL_LABEL: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "L1 — Below",
  2: "L2 — Approaching",
  3: "L3 — Proficient",
  4: "L4 — Above",
  5: "L5 — Mastery",
};

export default function AcademicsDashboard({ onOpenProfile }: Props) {
  const [grade, setGrade] = useState("");
  const [filters, setFilters] = useState<InsightsFilterValue>(EMPTY_FILTERS);
  const [data, setData] = useState<AcademicsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Drill-in drawer state.
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillSubject, setDrillSubject] = useState<"ela" | "math">("ela");
  const [drillLevel, setDrillLevel] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [drillData, setDrillData] = useState<BandResponse | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState("");

  // Build the shared query string (grade + cross-cutting filters).
  function buildQuery(): URLSearchParams {
    const qs = filtersToQuery(filters);
    if (grade) qs.set("grade", grade);
    return qs;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const qs = buildQuery();
    authFetch(`/api/insights/academics?${qs.toString()}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as AcademicsResponse;
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
  }, [grade, filters]);

  function openBand(subject: "ela" | "math", level: 1 | 2 | 3 | 4 | 5) {
    setDrillSubject(subject);
    setDrillLevel(level);
    setDrillOpen(true);
    setDrillLoading(true);
    setDrillError("");
    setDrillData(null);
    const qs = buildQuery();
    qs.set("subject", subject);
    qs.set("level", String(level));
    authFetch(`/api/insights/academics/band?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setDrillError(body.error || `Request failed (${r.status})`);
          return;
        }
        const json = (await r.json()) as BandResponse;
        setDrillData(json);
      })
      .catch((e) => setDrillError(String(e?.message ?? e)))
      .finally(() => setDrillLoading(false));
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
          <h2 style={{ margin: 0 }}>Academics</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            FAST PM1→PM2→PM3 progress — who's growing, who's still at L1,
            and how the cohort is tracking against proficiency.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            style={selectStyle}
          >
            {GRADE_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <InsightsFilterBar value={filters} onChange={setFilters} />

      <HowToUseHelp title="How to use Academics">
        <HowToSection title="What this dashboard is">
          The school-wide read on FAST progress monitoring (PM1 → PM2 → PM3)
          for ELA and Math. It answers two questions at once: "Is the cohort
          gaining ground over the year?" and "Which kids are still in the
          bottom quartile after the most recent window?"
        </HowToSection>

        <HowToSection title="What the KPIs mean">
          <p style={{ margin: "0 0 0.5rem" }}>
            A <strong>KPI</strong> (Key Performance Indicator) is one of the
            headline numbers at the top of the dashboard — a single value that
            summarizes one slice of what's happening so you can read the whole
            picture at a glance.
          </p>
          <ul style={howtoListStyle}>
            <li>
              <strong>Students assessed</strong> — unique students with at
              least one FAST score in the current school year.
            </li>
            <li>
              <strong>ELA / Math PM3 average</strong> — average FAST scale
              score on the most recent PM window across all assessed
              students. The scale-score → level cutoff is grade- and
              subject-specific (see the placement chart below for how
              this year's cohort distributes across L1-L5).
            </li>
            <li>
              <strong>% at L3+</strong> — share of students whose PM3
              placement is Level 3, 4, or 5. Higher is better.
            </li>
            <li>
              <strong>% in BQ (Bottom Quartile)</strong> — share of students
              placed at <strong>Level 1</strong> on PM3. This is the FAST
              "below benchmark" flag and the same signal Early Warning's
              Academics pillar uses. Lower is better.
            </li>
            <li>
              <strong>% growers</strong> — share of students whose PM3 score
              improved over their PM1 score in at least one subject. Only
              students with both PM1 and PM3 are included so a missing
              window doesn't penalise the rate.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to read the charts">
          <ul style={howtoListStyle}>
            <li>
              <strong>Cohort progression (PM1 → PM2 → PM3)</strong> — two
              overlaid lines. ELA is{" "}
              <span style={{ color: "#2563eb", fontWeight: 700 }}>blue</span>,
              Math is{" "}
              <span style={{ color: "#ea580c", fontWeight: 700 }}>orange</span>
              . An upward slope means the cohort is gaining; a flat or
              downward slope is the conversation to bring to the next
              data team meeting.
            </li>
            <li>
              <strong>PM3 placement distribution</strong> — bar chart
              showing how many students landed at each level (L1-L5) on PM3.
              The L1 bar is the size of the BQ population; the L3+L4+L5
              bars are the proficient population.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to use it day-to-day">
          <ul style={howtoListStyle}>
            <li>
              <strong>Filter by grade</strong> when you want to see one
              team's caseload — e.g. 4th grade ELA can isolate grade 4
              and see only their kids.
            </li>
            <li>
              <strong>Work the "Lowest PM3" lists.</strong> ELA and Math
              each have their own — these are the students to discuss
              first at MTSS. Click any name to open the student profile.
            </li>
            <li>
              <strong>Celebrate the "Top growers" lists.</strong> Sorted
              by PM1 → PM3 delta, they show who's climbing fastest in
              each subject — useful for both staff feedback and student
              recognition.
            </li>
            <li>
              <strong>Watch the % BQ trendline week over week.</strong>{" "}
              That number is the most direct proxy for how many students
              the academic Tier 2 / Tier 3 plans need to cover.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="A few caveats">
          <ul style={howtoListStyle}>
            <li>
              There is intentionally <strong>no time-window picker</strong>{" "}
              here — academic data lives at fixed assessment dates
              (PM1/PM2/PM3, AP1/AP2/AP3), so a daily trend wouldn't be
              meaningful.
            </li>
            <li>
              FAST is the primary source. iReady and SCI counts in the
              footer are shown for transparency but don't drive the
              level-based KPIs.
            </li>
            <li>
              "% growers" requires a student to have both a PM1 and PM3
              score. Students with only one window are excluded from the
              growers rate — they're not counted as "not growing".
            </li>
          </ul>
        </HowToSection>
      </HowToUseHelp>

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading academic data…
        </p>
      )}
      {error && (
        <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>
      )}

      {data && !loading && !error && (
        <Body
          data={data}
          onOpenProfile={onOpenProfile}
          onOpenBand={openBand}
        />
      )}

      <BandStudentsDrawer
        open={drillOpen}
        title={`${drillSubject === "ela" ? "ELA" : "Math"} — ${LEVEL_LABEL[drillLevel]}`}
        subtitle={
          drillData
            ? `${drillData.total} student${drillData.total === 1 ? "" : "s"} placed at this level on PM3${drillData.truncated ? ` (showing first ${drillData.students.length})` : ""}`
            : undefined
        }
        students={drillData?.students ?? []}
        truncated={drillData?.truncated}
        total={drillData?.total}
        loading={drillLoading}
        error={drillError}
        onClose={() => setDrillOpen(false)}
        onOpenProfile={(id) => {
          setDrillOpen(false);
          onOpenProfile(id);
        }}
      />
    </div>
  );
}

// ---------- Body (KPIs + progression + distribution + top-N) ---------------

function Body({
  data,
  onOpenProfile,
  onOpenBand,
}: {
  data: AcademicsResponse;
  onOpenProfile: (id: string) => void;
  onOpenBand: (subject: "ela" | "math", level: 1 | 2 | 3 | 4 | 5) => void;
}) {
  const allZero = data.totals.studentsAssessed === 0;

  // Merge ELA + Math progression into one row per window so the
  // overlaid LineChart can read both `ela` and `math` from one record.
  // PM windows are guaranteed identical across subjects (PM1/PM2/PM3).
  const progressionRows = mergeProgression(
    data.progression.ela,
    data.progression.math,
  );

  // Same merge for placement: pivot the per-subject arrays into one
  // row per level so the bar chart can show ELA + Math side-by-side.
  const placementRows = [1, 2, 3, 4, 5].map((lvl) => {
    const ela = data.placementDistribution.ela.find((d) => d.level === lvl);
    const math = data.placementDistribution.math.find((d) => d.level === lvl);
    return {
      level: `L${lvl}`,
      ela: ela?.count ?? 0,
      math: math?.count ?? 0,
    };
  });

  return (
    <div style={{ marginTop: "1rem" }}>
      {/* KPI strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.75rem",
          marginBottom: "1.25rem",
        }}
      >
        <Kpi
          label="Students assessed"
          value={data.totals.studentsAssessed}
        />
        <Kpi
          label="ELA PM3 average"
          rawValue={fmtNum(data.totals.elaPm3Average)}
          accent={ELA_COLOR}
        />
        <Kpi
          label="Math PM3 average"
          rawValue={fmtNum(data.totals.mathPm3Average)}
          accent={MATH_COLOR}
        />
        <Kpi
          label="% at or above L3"
          rawValue={fmtPct(data.totals.atOrAboveLevel3Pct)}
          accent={SUCCESS_COLOR}
        />
        <Kpi
          label="% bottom quartile"
          rawValue={fmtPct(data.totals.bottomQuartilePct)}
          sub={
            data.totals.bottomQuartilePct !== null &&
            data.totals.bottomQuartilePct > 25
              ? "above 25% — heavy support need"
              : undefined
          }
          accent={RISK_COLOR}
        />
        <Kpi
          label="% growers (PM3 > PM1)"
          rawValue={fmtPct(data.totals.growersPct)}
          accent={SUCCESS_COLOR}
        />
      </div>

      {allZero && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No FAST scores recorded
          {data.grade ? ` for grade ${data.grade}` : ""}. Try a different
          grade cohort, or import scores from the Imports page.
        </p>
      )}

      {/* Progression line: PM1 → PM2 → PM3 averages, ELA vs Math */}
      {!allZero && progressionRows.length > 0 && (
        <div
          style={{
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            padding: "0.85rem 1rem",
            background: "var(--card-bg, white)",
            marginBottom: "1rem",
          }}
        >
          <div style={panelTitleStyle}>
            Cohort progression — PM1 → PM2 → PM3
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={progressionRows}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="window" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 10 }}
                width={40}
                allowDecimals={false}
                domain={["auto", "auto"]}
              />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="ela"
                name="ELA"
                stroke={ELA_COLOR}
                strokeWidth={2.5}
                dot={{ r: 4 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="math"
                name="Math"
                stroke={MATH_COLOR}
                strokeWidth={2.5}
                dot={{ r: 4 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* PM3 placement distribution */}
      {!allZero && (
        <div
          style={{
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            padding: "0.85rem 1rem",
            background: "var(--card-bg, white)",
            marginBottom: "1.25rem",
          }}
        >
          <div style={panelTitleStyle}>
            PM3 placement distribution
            <span
              style={{
                fontSize: 11,
                fontWeight: 400,
                color: "var(--text-subtle)",
                marginLeft: "0.4rem",
              }}
            >
              (click a bar to see students)
            </span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={placementRows}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="level" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="ela"
                name="ELA"
                fill={ELA_COLOR}
                cursor="pointer"
                onClick={(p: { level?: number }) => {
                  if (
                    p?.level === 1 ||
                    p?.level === 2 ||
                    p?.level === 3 ||
                    p?.level === 4 ||
                    p?.level === 5
                  ) {
                    onOpenBand("ela", p.level);
                  }
                }}
              />
              <Bar
                dataKey="math"
                name="Math"
                fill={MATH_COLOR}
                cursor="pointer"
                onClick={(p: { level?: number }) => {
                  if (
                    p?.level === 1 ||
                    p?.level === 2 ||
                    p?.level === 3 ||
                    p?.level === 4 ||
                    p?.level === 5
                  ) {
                    onOpenBand("math", p.level);
                  }
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top-N tables */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <TopGrowerTable
          title="Top growers — ELA"
          rows={data.topLists.topGrowersEla}
          onOpenProfile={onOpenProfile}
          accent={ELA_COLOR}
        />
        <TopGrowerTable
          title="Top growers — Math"
          rows={data.topLists.topGrowersMath}
          onOpenProfile={onOpenProfile}
          accent={MATH_COLOR}
        />
        <LowPm3Table
          title="L1 students — ELA (lowest PM3)"
          rows={data.topLists.lowestPm3Ela}
          onOpenProfile={onOpenProfile}
          accent={ELA_COLOR}
        />
        <LowPm3Table
          title="L1 students — Math (lowest PM3)"
          rows={data.topLists.lowestPm3Math}
          onOpenProfile={onOpenProfile}
          accent={MATH_COLOR}
        />
      </div>

      {/* Data sources footer — hints at vendor coverage and seeded counts */}
      <p
        style={{
          color: "var(--text-subtle)",
          fontSize: 12,
          marginTop: "1rem",
        }}
      >
        Data sources:{" "}
        <strong>{data.sources.fast.toLocaleString()}</strong> FAST PM rows ·{" "}
        <strong>{data.sources.iReady.toLocaleString()}</strong> iReady ·{" "}
        <strong>{data.sources.sci.toLocaleString()}</strong> District SCI
        {data.grade ? ` · Grade ${data.grade}` : ""}
      </p>
    </div>
  );
}

// ---------- Helpers ---------------------------------------------------------

function fmtNum(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

function fmtPct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

// Zip two PM-window series (ELA + Math) into a single rows-by-window
// array suitable for a multi-line LineChart. Server returns each as
// [{window:"PM1",score},…] with windows in order; we preserve the union
// (using the longer one as the spine) so a missing-subject scenario
// still renders cleanly.
function mergeProgression(
  ela: { window: string; score: number }[],
  math: { window: string; score: number }[],
): { window: string; ela: number | null; math: number | null }[] {
  const windows = new Set<string>();
  ela.forEach((p) => windows.add(p.window));
  math.forEach((p) => windows.add(p.window));
  // Stable sort: PM1 < PM2 < PM3 (lex order works for these labels).
  return Array.from(windows)
    .sort()
    .map((w) => ({
      window: w,
      ela: ela.find((p) => p.window === w)?.score ?? null,
      math: math.find((p) => p.window === w)?.score ?? null,
    }));
}

// ---------- Reusable bits ---------------------------------------------------

function Kpi({
  label,
  value,
  rawValue,
  sub,
  accent,
}: {
  label: string;
  value?: number;
  rawValue?: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderLeft: accent ? `3px solid ${accent}` : undefined,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        background: "var(--card-bg, white)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-subtle, #64748b)",
          marginBottom: "0.25rem",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>
        {rawValue ?? (value ?? 0).toLocaleString()}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-subtle, #94a3b8)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function TopGrowerTable({
  title,
  rows,
  onOpenProfile,
  accent,
}: {
  title: string;
  rows: Grower[];
  onOpenProfile: (id: string) => void;
  accent?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderTop: accent ? `3px solid ${accent}` : undefined,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        background: "var(--card-bg, white)",
      }}
    >
      <div style={panelTitleStyle}>{title}</div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No grower data yet — needs PM1 + PM3 scores.
        </p>
      ) : (
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.studentId}
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <td style={{ padding: "0.35rem 0" }}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(r.studentId)}
                    style={linkButtonStyle}
                  >
                    {r.studentName}
                  </button>
                </td>
                <td
                  style={{
                    padding: "0.35rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                  }}
                >
                  {r.pm1} → {r.pm3}{" "}
                  <span style={{ color: r.delta >= 0 ? "#16a34a" : "#dc2626" }}>
                    ({r.delta >= 0 ? "+" : ""}
                    {r.delta})
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LowPm3Table({
  title,
  rows,
  onOpenProfile,
  accent,
}: {
  title: string;
  rows: LowPm3[];
  onOpenProfile: (id: string) => void;
  accent?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderTop: accent ? `3px solid ${accent}` : undefined,
        borderRadius: 8,
        padding: "0.85rem 1rem",
        background: "var(--card-bg, white)",
      }}
    >
      <div style={panelTitleStyle}>{title}</div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No L1 students in this cohort. 🎉
        </p>
      ) : (
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
        >
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.studentId}
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <td style={{ padding: "0.35rem 0" }}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(r.studentId)}
                    style={linkButtonStyle}
                  >
                    {r.studentName}
                  </button>
                </td>
                <td
                  style={{
                    padding: "0.35rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                  }}
                >
                  PM3 {r.pm3} (L{r.level})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  font: "inherit",
  fontSize: 13,
};

const panelTitleStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-subtle, #64748b)",
  marginBottom: "0.5rem",
};

const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  padding: 0,
  font: "inherit",
  textAlign: "left",
};
