// SEB / SEL Dashboard — school-level eduCLIMBER-style "Whole Child" view of
// social-emotional + behavioral support coverage and risk concentration.
// Renders the totals, plan-area mix, risk-overlap histogram, and top-N
// lists returned by GET /api/insights/sebsel. Click a student name → opens
// that student's profile via onOpenProfile.
//
// Permission: backend gates this to the core team (Admin / SuperUser /
// Behavior Specialist / MTSS Coord / PBIS Coord). The caller (App.tsx)
// should only mount this when the user passes that bar; we still render
// a clean error message if the backend rejects.
//
// No time-window picker — most signals are stateful (open MTSS plans,
// active accommodations, IEP/504/ELL flags). The one windowed signal,
// "recent negative behavior", is hard-coded server-side to a 30-day
// "active concern" window and surfaced in the page footer.

import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  LabelList,
} from "recharts";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, howtoListStyle } from "./HowToUseHelp";
import InsightsFilterBar, {
  EMPTY_FILTERS,
  filtersToQuery,
  type InsightsFilterValue,
} from "./InsightsFilterBar";

type FlagKey = "plan" | "bq" | "negatives" | "iep504";

interface HighestNeed {
  studentId: string;
  studentName: string;
  grade: number | null;
  flags: FlagKey[];
}

interface AtRiskWithoutPlan {
  studentId: string;
  studentName: string;
  grade: number | null;
  bq: boolean;
  negatives: number;
}

interface SelPlanRosterEntry {
  studentId: string;
  studentName: string;
  grade: number | null;
  planTitle: string;
}

interface MostAccommodatedEntry {
  studentId: string;
  studentName: string;
  grade: number | null;
  accommodationCount: number;
}

interface SebSelResponse {
  grade: string | null;
  windowDays: number;
  totals: {
    cohortStudents: number;
    activeMtssPlans: number;
    selFlaggedPlans: number;
    iepStudents: number;
    students504: number;
    ellStudents: number;
    multiRiskStudents: number;
  };
  planAreaMix: { area: string; count: number }[];
  riskOverlap: { flagCount: number; students: number }[];
  topLists: {
    highestNeed: HighestNeed[];
    atRiskWithoutPlan: AtRiskWithoutPlan[];
    selPlanRoster: SelPlanRosterEntry[];
    mostAccommodated: MostAccommodatedEntry[];
  };
  sources: {
    plans: number;
    accommodations: number;
    negativePbisLast30d: number;
    fastBq: number;
  };
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

// Palette: keep it distinct from the prior three dashboards.
//   - purple = MTSS / plan-related KPIs
//   - blue   = demographic SEL flags (IEP / 504 / ELL)
//   - red    = the "multi-risk" risk concentration KPI
const PLAN_COLOR = "#7c3aed"; // violet-600
const DEMO_COLOR = "#2563eb"; // blue-600
const RISK_COLOR = "#dc2626"; // red-600

// Plan-area palette — one color per area so the bar chart reads at a glance.
// Order matches the server's PLAN_AREA_ORDER, but we look up by name so a
// reorder on either side stays correct.
const PLAN_AREA_COLORS: Record<string, string> = {
  Behavior: "#dc2626", // red-600
  SEL: "#7c3aed",      // violet-600
  Academic: "#2563eb", // blue-600
  Attendance: "#ea580c", // orange-600
  Other: "#64748b",    // slate-500
};

// Risk-overlap palette: hotter as flag-count grows. flagCount 4 = max.
const RISK_OVERLAP_COLORS: Record<number, string> = {
  1: "#facc15", // yellow-400
  2: "#fb923c", // orange-400
  3: "#ef4444", // red-500
  4: "#991b1b", // red-800
};

// Human-readable chip label per risk flag.
const FLAG_LABEL: Record<FlagKey, string> = {
  plan: "Plan",
  bq: "BQ",
  negatives: "Negatives",
  iep504: "IEP/504",
};

export default function SebSelDashboard({ onOpenProfile }: Props) {
  const [grade, setGrade] = useState("");
  const [filters, setFilters] = useState<InsightsFilterValue>(EMPTY_FILTERS);
  const [data, setData] = useState<SebSelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams();
    if (grade) qs.set("grade", grade);
    for (const [k, v] of filtersToQuery(filters)) qs.set(k, v);
    authFetch(`/api/insights/sebsel?${qs.toString()}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as SebSelResponse;
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
  }, [grade, filters]);

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
          <h2 style={{ margin: 0 }}>SEB / SEL</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            MTSS plan coverage, demographic SEL flags, and where risk is
            stacking up — including the kids who are slipping but aren't on a
            plan yet.
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

      <HowToUseHelp title="How to use SEB / SEL">
        <HowToSection title="What this dashboard is">
          A whole-child read on social-emotional + behavioral support
          coverage. It answers two questions at once: "How well are we
          covering the kids who are already on plans?" and "Where is
          risk concentrating in kids who <em>aren't</em> on a plan yet?"
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
              <strong>Cohort students</strong> — total students used as
              the denominator for every count and percentage on the page
              (filtered by grade if a grade is selected).
            </li>
            <li>
              <strong>Active MTSS plans</strong> — count of currently
              active MTSS plans across the cohort. One plan per student.
            </li>
            <li>
              <strong>SEL-flagged plans</strong> — subset of active plans
              whose primary area is SEL.
            </li>
            <li>
              <strong>IEP / 504 / ELL students</strong> — counts of
              students carrying each demographic SEL-related flag. These
              are stateful (no time window).
            </li>
            <li>
              <strong>Multi-risk students</strong> — students who have{" "}
              <strong>2 or more</strong> of the four risk flags:{" "}
              <em>active MTSS plan</em>, <em>prior-year FAST bottom
              quartile</em>, <em>3 or more negative PBIS entries in the
              last 30 days</em>, or <em>IEP/504</em>. This is the cohort
              the team should triage first.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to read the charts and lists">
          <ul style={howtoListStyle}>
            <li>
              <strong>Plan-area mix</strong> — how the active plans break
              down across Behavior / SEL / Academic / Attendance / Other.
              A team that runs almost entirely Behavior plans is missing
              the SEL conversation.
            </li>
            <li>
              <strong>Risk overlap histogram</strong> — bars showing how
              many students hit 1 flag, 2 flags, 3 flags, or all 4. The
              right-hand side of the chart is your most acute caseload.
            </li>
            <li>
              <strong>Highest need</strong> — students with the most
              flags fired, with the flag chips visible inline. Click a
              name to open the student profile.
            </li>
            <li>
              <strong>At-risk without a plan</strong> — the action list.
              Students with academic or behavior flags fired but{" "}
              <em>no</em> active MTSS plan. These are the kids the team
              hasn't reached yet.
            </li>
            <li>
              <strong>SEL plan roster</strong> — the current SEL caseload,
              one row per student on an SEL-flagged plan. Useful for
              counselor / SEL coach caseload audits.
            </li>
            <li>
              <strong>Most accommodated</strong> — students with the most
              active accommodations on file. Worth a glance to make sure
              accommodations are being implemented in the classroom.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to use it day-to-day">
          <ul style={howtoListStyle}>
            <li>
              <strong>Start with "At-risk without a plan."</strong> Each
              row is a student the team should consider for a Tier 2
              referral this week. This is the highest-leverage list on
              the page.
            </li>
            <li>
              <strong>Watch the multi-risk count.</strong> If it grows
              week over week, the team is falling behind on plan
              coverage even if total plans is steady.
            </li>
            <li>
              <strong>Use the plan-area mix to spot blind spots.</strong>{" "}
              An imbalance toward Behavior with little SEL is a common
              signal that the team's response is reactive rather than
              preventive.
            </li>
            <li>
              <strong>Filter by grade</strong> when a grade-level team
              wants to see only their students.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="A few caveats">
          <ul style={howtoListStyle}>
            <li>
              Most signals are <strong>stateful</strong> — open MTSS
              plans, active accommodations, IEP/504/ELL flags. There is
              intentionally no window picker.
            </li>
            <li>
              The one windowed signal is "negative PBIS in the last
              30 days", which feeds the negatives flag and the
              at-risk-without-plan list.
            </li>
            <li>
              "FAST BQ" uses the same Bottom Quartile flag as the
              Academics dashboard and Early Warning, so a student
              flagged here is flagged everywhere.
            </li>
          </ul>
        </HowToSection>
      </HowToUseHelp>

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading SEB/SEL data…
        </p>
      )}
      {error && (
        <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>
      )}

      {data && !loading && !error && (
        <Body data={data} onOpenProfile={onOpenProfile} />
      )}
    </div>
  );
}

// ---------- Body (KPIs + viz + top-N) -------------------------------------

function Body({
  data,
  onOpenProfile,
}: {
  data: SebSelResponse;
  onOpenProfile: (id: string) => void;
}) {
  const totals = data.totals;
  // "Empty cohort" = no students returned by the grade filter at all.
  // (Different from "everything is zero" — a real empty grade selection
  //  should suppress the whole grid.)
  const allEmpty = totals.cohortStudents === 0;
  // No SEB/SEL signal — we have students but no plans, no risk flags, and
  // no demographic flags lit up. Triggers the friendly empty-state copy
  // without hiding the page.
  const noSignal =
    !allEmpty &&
    totals.activeMtssPlans === 0 &&
    totals.iepStudents === 0 &&
    totals.students504 === 0 &&
    totals.ellStudents === 0 &&
    totals.multiRiskStudents === 0;

  const planAreaRows = data.planAreaMix.map((d) => ({
    ...d,
    fill: PLAN_AREA_COLORS[d.area] ?? "#64748b",
  }));
  const riskRows = data.riskOverlap.map((d) => ({
    label: `${d.flagCount} flag${d.flagCount === 1 ? "" : "s"}`,
    flagCount: d.flagCount,
    students: d.students,
    fill: RISK_OVERLAP_COLORS[d.flagCount] ?? "#94a3b8",
  }));

  const planAreaHasData = planAreaRows.some((r) => r.count > 0);
  const riskHasData = riskRows.some((r) => r.students > 0);

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
          label="Active MTSS plans"
          value={totals.activeMtssPlans}
          accent={PLAN_COLOR}
          sub={
            totals.cohortStudents > 0
              ? `${pct(totals.activeMtssPlans, totals.cohortStudents)} of cohort`
              : undefined
          }
        />
        <Kpi
          label="SEL-flagged plans"
          value={totals.selFlaggedPlans}
          accent={PLAN_COLOR}
          sub="Behavior + Social-Emotional bucket"
        />
        <Kpi
          label="IEP students"
          value={totals.iepStudents}
          accent={DEMO_COLOR}
          sub={
            totals.cohortStudents > 0
              ? `${pct(totals.iepStudents, totals.cohortStudents)} of cohort`
              : undefined
          }
        />
        <Kpi
          label="504 students"
          value={totals.students504}
          accent={DEMO_COLOR}
          sub={
            totals.cohortStudents > 0
              ? `${pct(totals.students504, totals.cohortStudents)} of cohort`
              : undefined
          }
        />
        <Kpi
          label="ELL students"
          value={totals.ellStudents}
          accent={DEMO_COLOR}
          sub={
            totals.cohortStudents > 0
              ? `${pct(totals.ellStudents, totals.cohortStudents)} of cohort`
              : undefined
          }
        />
        <Kpi
          label="Multi-risk students"
          value={totals.multiRiskStudents}
          accent={RISK_COLOR}
          sub="≥ 2 of {plan, BQ, negatives, IEP/504}"
        />
      </div>

      {allEmpty && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No students in this cohort
          {data.grade ? ` (grade ${data.grade})` : ""}. Try a different grade.
        </p>
      )}

      {noSignal && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No SEB/SEL signals yet for this cohort. Plans, accommodations, or
          recent behavior data will populate this view as they're recorded.
        </p>
      )}

      {/* Plan area mix */}
      {!allEmpty && planAreaHasData && (
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
            Active plans by area — what kind of support is going out
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={planAreaRows}
              layout="vertical"
              margin={{ top: 4, right: 24, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                type="number"
                tick={{ fontSize: 10 }}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="area"
                tick={{ fontSize: 11 }}
                width={90}
              />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="count" name="Active plans">
                {planAreaRows.map((entry) => (
                  <Cell key={entry.area} fill={entry.fill} />
                ))}
                <LabelList
                  dataKey="count"
                  position="right"
                  style={{ fontSize: 11, fill: "#475569" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Risk overlap histogram */}
      {!allEmpty && riskHasData && (
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
            Risk concentration — students by number of risk flags
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={riskRows}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="students" name="Students">
                {riskRows.map((entry) => (
                  <Cell key={entry.flagCount} fill={entry.fill} />
                ))}
                <LabelList
                  dataKey="students"
                  position="top"
                  style={{ fontSize: 11, fill: "#475569" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p
            style={{
              fontSize: 11,
              color: "var(--text-subtle, #64748b)",
              margin: "0.5rem 0 0",
            }}
          >
            Flags = active MTSS plan, prior-year FAST BQ, ≥3 negative PBIS
            entries in last 30 days, or IEP/504 status.
          </p>
        </div>
      )}

      {/* Top-N tables */}
      {!allEmpty && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "0.75rem",
          }}
        >
          <HighestNeedTable
            title="Highest need — most risk flags"
            rows={data.topLists.highestNeed}
            onOpenProfile={onOpenProfile}
            accent={RISK_COLOR}
          />
          <AtRiskWithoutPlanTable
            title="At risk without a plan"
            rows={data.topLists.atRiskWithoutPlan}
            onOpenProfile={onOpenProfile}
            accent={RISK_COLOR}
          />
          <SelPlanRosterTable
            title="SEL plan roster"
            rows={data.topLists.selPlanRoster}
            onOpenProfile={onOpenProfile}
            accent={PLAN_COLOR}
          />
          <MostAccommodatedTable
            title="Most accommodated — heaviest support footprint"
            rows={data.topLists.mostAccommodated}
            onOpenProfile={onOpenProfile}
            accent={DEMO_COLOR}
          />
        </div>
      )}

      {/* Data sources footer */}
      <p
        style={{
          color: "var(--text-subtle)",
          fontSize: 12,
          marginTop: "1rem",
        }}
      >
        Data sources:{" "}
        <strong>{data.sources.plans.toLocaleString()}</strong> active MTSS
        plans ·{" "}
        <strong>{data.sources.accommodations.toLocaleString()}</strong>{" "}
        accommodations ·{" "}
        <strong>
          {data.sources.negativePbisLast30d.toLocaleString()}
        </strong>{" "}
        negative PBIS (last {data.windowDays}d) ·{" "}
        <strong>{data.sources.fastBq.toLocaleString()}</strong> FAST BQ flags
        {data.grade ? ` · Grade ${data.grade}` : ""}
      </p>
    </div>
  );
}

// ---------- Helpers --------------------------------------------------------

function pct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

// ---------- Reusable bits --------------------------------------------------

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
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
        {value.toLocaleString()}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-subtle, #94a3b8)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function FlagChip({ flag }: { flag: FlagKey }) {
  const palette: Record<FlagKey, { bg: string; fg: string }> = {
    plan: { bg: "#ede9fe", fg: "#5b21b6" }, // violet
    bq: { bg: "#fee2e2", fg: "#991b1b" }, // red
    negatives: { bg: "#ffedd5", fg: "#9a3412" }, // orange
    iep504: { bg: "#dbeafe", fg: "#1e3a8a" }, // blue
  };
  const c = palette[flag];
  return (
    <span
      style={{
        display: "inline-block",
        background: c.bg,
        color: c.fg,
        fontSize: 10,
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: 4,
        marginRight: 4,
      }}
    >
      {FLAG_LABEL[flag]}
    </span>
  );
}

function HighestNeedTable({
  title,
  rows,
  onOpenProfile,
  accent,
}: {
  title: string;
  rows: HighestNeed[];
  onOpenProfile: (id: string) => void;
  accent?: string;
}) {
  return (
    <div style={panelStyle(accent)}>
      <div style={panelTitleStyle}>{title}</div>
      {rows.length === 0 ? (
        <p style={emptyRowStyle}>
          No students with any risk flag in this cohort. 🎉
        </p>
      ) : (
        <table className="pulse-table" style={tableStyle}>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.studentId}
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <td style={{ padding: "0.4rem 0", verticalAlign: "top" }}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(r.studentId)}
                    style={linkButtonStyle}
                  >
                    {r.studentName}
                  </button>
                  {r.grade !== null && (
                    <span style={gradeChipStyle}>
                      G{r.grade === 0 ? "K" : r.grade}
                    </span>
                  )}
                  <div style={{ marginTop: 2 }}>
                    {r.flags.map((f) => (
                      <FlagChip key={f} flag={f} />
                    ))}
                  </div>
                </td>
                <td
                  style={{
                    padding: "0.4rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                    verticalAlign: "top",
                  }}
                >
                  {r.flags.length} flag{r.flags.length === 1 ? "" : "s"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AtRiskWithoutPlanTable({
  title,
  rows,
  onOpenProfile,
  accent,
}: {
  title: string;
  rows: AtRiskWithoutPlan[];
  onOpenProfile: (id: string) => void;
  accent?: string;
}) {
  return (
    <div style={panelStyle(accent)}>
      <div style={panelTitleStyle}>{title}</div>
      {rows.length === 0 ? (
        <p style={emptyRowStyle}>
          Every at-risk student in this cohort already has an active MTSS plan.
        </p>
      ) : (
        <table className="pulse-table" style={tableStyle}>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.studentId}
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <td style={{ padding: "0.4rem 0" }}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(r.studentId)}
                    style={linkButtonStyle}
                  >
                    {r.studentName}
                  </button>
                  {r.grade !== null && (
                    <span style={gradeChipStyle}>
                      G{r.grade === 0 ? "K" : r.grade}
                    </span>
                  )}
                </td>
                <td
                  style={{
                    padding: "0.4rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                    fontSize: 12,
                  }}
                >
                  {r.bq && <span style={{ marginRight: 6 }}>BQ</span>}
                  {r.negatives > 0 && <>{r.negatives} neg.</>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SelPlanRosterTable({
  title,
  rows,
  onOpenProfile,
  accent,
}: {
  title: string;
  rows: SelPlanRosterEntry[];
  onOpenProfile: (id: string) => void;
  accent?: string;
}) {
  return (
    <div style={panelStyle(accent)}>
      <div style={panelTitleStyle}>{title}</div>
      {rows.length === 0 ? (
        <p style={emptyRowStyle}>
          No active SEL- or Behavior-bucket plans in this cohort.
        </p>
      ) : (
        <table className="pulse-table" style={tableStyle}>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.studentId}
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <td style={{ padding: "0.4rem 0" }}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(r.studentId)}
                    style={linkButtonStyle}
                  >
                    {r.studentName}
                  </button>
                  {r.grade !== null && (
                    <span style={gradeChipStyle}>
                      G{r.grade === 0 ? "K" : r.grade}
                    </span>
                  )}
                </td>
                <td
                  style={{
                    padding: "0.4rem 0",
                    textAlign: "right",
                    color: "var(--text-subtle, #475569)",
                    fontSize: 12,
                  }}
                >
                  {r.planTitle}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MostAccommodatedTable({
  title,
  rows,
  onOpenProfile,
  accent,
}: {
  title: string;
  rows: MostAccommodatedEntry[];
  onOpenProfile: (id: string) => void;
  accent?: string;
}) {
  return (
    <div style={panelStyle(accent)}>
      <div style={panelTitleStyle}>{title}</div>
      {rows.length === 0 ? (
        <p style={emptyRowStyle}>
          No active accommodations in this cohort yet.
        </p>
      ) : (
        <table className="pulse-table" style={tableStyle}>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.studentId}
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <td style={{ padding: "0.4rem 0" }}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(r.studentId)}
                    style={linkButtonStyle}
                  >
                    {r.studentName}
                  </button>
                  {r.grade !== null && (
                    <span style={gradeChipStyle}>
                      G{r.grade === 0 ? "K" : r.grade}
                    </span>
                  )}
                </td>
                <td
                  style={{
                    padding: "0.4rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                  }}
                >
                  {r.accommodationCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Style atoms ----------------------------------------------------

function panelStyle(accent?: string): React.CSSProperties {
  return {
    border: "1px solid var(--border, #e5e7eb)",
    borderTop: accent ? `3px solid ${accent}` : undefined,
    borderRadius: 8,
    padding: "0.85rem 1rem",
    background: "var(--card-bg, white)",
  };
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const emptyRowStyle: React.CSSProperties = {
  color: "var(--text-subtle)",
  fontSize: 13,
  margin: 0,
};

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

const gradeChipStyle: React.CSSProperties = {
  // Slight bump in left margin + a thin border so the chip reads as a
  // visually distinct token rather than running into the trailing letters
  // of the student's name (e.g. "...lker G8" no longer looks like "lkerG8").
  display: "inline-block",
  marginLeft: 10,
  fontSize: 10,
  fontWeight: 600,
  background: "#e2e8f0",
  color: "#334155",
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid #cbd5e1",
  verticalAlign: "middle",
  letterSpacing: "0.02em",
};
