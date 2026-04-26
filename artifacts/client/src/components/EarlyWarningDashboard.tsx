// EarlyWarningDashboard — eduCLIMBER-style composite risk view.
//
// Shows ONE 0-100 score per student rolling up academics + behavior +
// engagement + supports, with a leaderboard of the highest-risk students
// for the active school. Mirrors EquityDashboard's structure (grade
// filter, KPI strip, panel layout, click-through to studentProfile) so
// the insights hub feels uniform.
//
// Two views in one component:
//   * Top KPI strip + risk-band distribution bar — the "how bad is the
//     overall picture" view.
//   * Top-25 leaderboard with pillar breakdown — the "who do I touch
//     first" view. Clicking a row opens the student profile.

import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// ---------- Types (mirror api-server response shape) ----------------------

type Band = "low" | "watch" | "moderate" | "high" | "critical";

type Breakdown = {
  academics: number;
  behavior: number;
  engagement: number;
  supports: number;
};

type Signals = {
  bqSubjects: number;
  negPbis30d: number;
  hallPasses30d: number;
  tardies30d: number;
  pullouts30d: number;
  issDays30d: number;
  weightedEngagement30d: number;
  planTier: number | null;
};

type RiskRow = {
  studentId: string;
  name: string;
  grade: number;
  score: number;
  band: Band;
  breakdown: Breakdown;
  signals: Signals;
  hasActivePlan: boolean;
  isUnsupportedHighRisk: boolean;
};

type EarlyWarningResponse = {
  grade: string | null;
  windowDays: number;
  totals: {
    cohortStudents: number;
    avgScore: number;
    maxScore: number;
    lowCount: number;
    lowPct: number;
    watchCount: number;
    watchPct: number;
    moderateCount: number;
    moderatePct: number;
    highCount: number;
    highPct: number;
    criticalCount: number;
    criticalPct: number;
    highOrCriticalCount: number;
    highOrCriticalPct: number;
    unsupportedHighRiskCount: number;
  };
  topRisk: RiskRow[];
  sources: {
    fastBq: number;
    negPbisLast30d: number;
    hallPassesLast30d: number;
    tardiesLast30d: number;
    pulloutsLast30d: number;
    issDaysLast30d: number;
    activePlans: number;
  };
};

// ---------- Color palette (matches band severity) -------------------------

const BAND_COLORS: Record<Band, { bg: string; fg: string; bar: string; label: string }> = {
  low:      { bg: "#dcfce7", fg: "#166534", bar: "#16a34a", label: "Low" },
  watch:    { bg: "#fef9c3", fg: "#854d0e", bar: "#eab308", label: "Watch" },
  moderate: { bg: "#ffedd5", fg: "#9a3412", bar: "#f97316", label: "Moderate" },
  high:     { bg: "#fee2e2", fg: "#991b1b", bar: "#dc2626", label: "High" },
  critical: { bg: "#ede9fe", fg: "#5b21b6", bar: "#7c3aed", label: "Critical" },
};

const SLATE = "#475569";
const TEAL = "#0d9488";
const ROSE = "#e11d48";
const AMBER = "#d97706";

// ---------- Grade filter options (same set as the other dashboards) -------

const GRADE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All grades" },
  { value: "K", label: "Kindergarten" },
  { value: "1", label: "1st grade" },
  { value: "2", label: "2nd grade" },
  { value: "3", label: "3rd grade" },
  { value: "4", label: "4th grade" },
  { value: "5", label: "5th grade" },
  { value: "6", label: "6th grade" },
  { value: "7", label: "7th grade" },
  { value: "8", label: "8th grade" },
  { value: "9", label: "9th grade" },
  { value: "10", label: "10th grade" },
  { value: "11", label: "11th grade" },
  { value: "12", label: "12th grade" },
];

// ---------- Top-level component -------------------------------------------

type Props = {
  onOpenProfile: (studentId: string) => void;
};

export function EarlyWarningDashboard({ onOpenProfile }: Props) {
  const [grade, setGrade] = useState("");
  const [data, setData] = useState<EarlyWarningResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams();
    if (grade) qs.set("grade", grade);
    authFetch(`/api/insights/early-warning?${qs.toString()}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as EarlyWarningResponse;
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
  }, [grade]);

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
          <h2 style={{ margin: 0 }}>Early Warning</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            One 0-100 composite per student rolling up academics, behavior,
            engagement, and supports — so the team knows exactly who to
            touch first this week.
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

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading early warning…
        </p>
      )}
      {error && <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>}

      {data && !loading && !error && (
        <Body data={data} onOpenProfile={onOpenProfile} />
      )}
    </div>
  );
}

// ---------- Body ----------------------------------------------------------

function Body({
  data,
  onOpenProfile,
}: {
  data: EarlyWarningResponse;
  onOpenProfile: (studentId: string) => void;
}) {
  const t = data.totals;
  const empty = t.cohortStudents === 0;
  // "No signals yet" = there is a cohort but every student scored 0
  // (everyone in the Low band, no BQ flags, no neg PBIS, no engagement
  // disruptions, no plans). Distinct from an empty cohort.
  const noSignals =
    !empty &&
    t.maxScore === 0 &&
    data.sources.fastBq === 0 &&
    data.sources.negPbisLast30d === 0 &&
    data.sources.hallPassesLast30d === 0 &&
    data.sources.tardiesLast30d === 0 &&
    data.sources.pulloutsLast30d === 0 &&
    data.sources.issDaysLast30d === 0 &&
    data.sources.activePlans === 0;

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
        <Kpi label="Cohort size" value={fmtInt(t.cohortStudents)} accent={SLATE} />
        <Kpi
          label="Avg risk score"
          value={t.avgScore.toFixed(1)}
          accent={TEAL}
          sub="0-100 composite"
        />
        <Kpi
          label="Max score"
          value={fmtInt(t.maxScore)}
          accent={AMBER}
          sub="Highest individual risk"
        />
        {/* HEADLINE TILE — the number that drives MTSS triage. */}
        <Kpi
          label="High + Critical"
          value={fmtInt(t.highOrCriticalCount)}
          accent={ROSE}
          big
          sub={`${pctFmt(t.highOrCriticalPct)} of cohort (score ≥ 60)`}
        />
        <Kpi
          label="Unsupported high-risk"
          value={fmtInt(t.unsupportedHighRiskCount)}
          accent={"#7c3aed"}
          sub="Score ≥ 60, no active plan"
        />
      </div>

      {empty && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No students in this cohort
          {data.grade ? ` (grade ${data.grade})` : ""}. Try a different grade.
        </p>
      )}

      {noSignals && (
        <div
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 8,
            padding: "1rem 1.25rem",
            background: "#f8fafc",
            marginBottom: "1.5rem",
            color: "#475569",
            fontSize: 14,
          }}
        >
          No risk signals captured yet for this cohort. Once FAST scores,
          PBIS entries, hall passes, tardies, ISS days, pullouts, or MTSS
          plans land, students will start to score above zero.
        </div>
      )}

      {!empty && !noSignals && (
        <>
          <BandDistributionPanel totals={t} />
          <TopRiskPanel rows={data.topRisk} onOpenProfile={onOpenProfile} />
        </>
      )}

      {/* Footer: window + sources */}
      <div
        style={{
          marginTop: "1.25rem",
          paddingTop: "0.75rem",
          borderTop: "1px solid #f1f5f9",
          color: "var(--text-subtle, #64748b)",
          fontSize: 11,
          lineHeight: 1.6,
        }}
      >
        <div>
          Window: last {data.windowDays} days. Sources:{" "}
          {data.sources.fastBq} BQ flags ·{" "}
          {data.sources.negPbisLast30d} neg PBIS ·{" "}
          {data.sources.hallPassesLast30d} hall passes ·{" "}
          {data.sources.tardiesLast30d} tardies ·{" "}
          {data.sources.pulloutsLast30d} pullouts ·{" "}
          {data.sources.issDaysLast30d} ISS days ·{" "}
          {data.sources.activePlans} active plans.
        </div>
        <div style={{ marginTop: 4, fontStyle: "italic" }}>
          Composite = academics (0-25) + behavior (0-25) + engagement (0-25)
          + supports (0-25). Bands: 0-19 Low · 20-39 Watch · 40-59 Moderate
          · 60-79 High · 80-100 Critical.
        </div>
      </div>
    </div>
  );
}

// ---------- Risk band distribution ----------------------------------------

function BandDistributionPanel({
  totals,
}: {
  totals: EarlyWarningResponse["totals"];
}) {
  const bands: { key: Band; count: number; pct: number }[] = [
    { key: "low",      count: totals.lowCount,      pct: totals.lowPct },
    { key: "watch",    count: totals.watchCount,    pct: totals.watchPct },
    { key: "moderate", count: totals.moderateCount, pct: totals.moderatePct },
    { key: "high",     count: totals.highCount,     pct: totals.highPct },
    { key: "critical", count: totals.criticalCount, pct: totals.criticalPct },
  ];

  return (
    <div style={{ ...panelStyle(SLATE), marginBottom: "1rem" }}>
      <div style={panelTitleStyle}>Risk band distribution</div>

      {/* Segmented bar — proportional widths sum to 100%. Gracefully
          handles a "100% Low" cohort by falling back to equal placeholder
          segments rather than a confusing single-color bar. */}
      <div
        style={{
          display: "flex",
          width: "100%",
          height: 22,
          borderRadius: 4,
          overflow: "hidden",
          background: "#f1f5f9",
          marginBottom: "0.75rem",
        }}
      >
        {bands.map((b) => {
          const width = `${(b.pct * 100).toFixed(2)}%`;
          if (b.pct <= 0) return null;
          return (
            <div
              key={b.key}
              title={`${BAND_COLORS[b.key].label}: ${b.count} (${pctFmt(b.pct)})`}
              style={{
                width,
                background: BAND_COLORS[b.key].bar,
              }}
            />
          );
        })}
      </div>

      {/* Legend — five chips with band name, count, and pct. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.5rem",
        }}
      >
        {bands.map((b) => (
          <div
            key={b.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.4rem 0.6rem",
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: BAND_COLORS[b.key].bar,
                display: "inline-block",
              }}
            />
            <span style={{ fontWeight: 600, color: BAND_COLORS[b.key].fg }}>
              {BAND_COLORS[b.key].label}
            </span>
            <span style={{ marginLeft: "auto", color: "#64748b" }}>
              {fmtInt(b.count)} · {pctFmt(b.pct)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Top-N risk leaderboard ----------------------------------------

function TopRiskPanel({
  rows,
  onOpenProfile,
}: {
  rows: RiskRow[];
  onOpenProfile: (studentId: string) => void;
}) {
  return (
    <div style={panelStyle(ROSE)}>
      <div style={panelTitleStyle}>
        Top {rows.length} highest-risk students — touch these first
      </div>
      {rows.length === 0 ? (
        <p style={emptyRowStyle}>
          No students currently scored above zero. Nothing on the
          leaderboard yet.
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ color: "#64748b", fontSize: 11 }}>
              <th style={{ textAlign: "left", padding: "0.4rem 0", fontWeight: 500 }}>
                Student
              </th>
              <th
                style={{
                  textAlign: "right",
                  padding: "0.4rem 0.5rem",
                  fontWeight: 500,
                }}
              >
                Score
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "0.4rem 0.5rem",
                  fontWeight: 500,
                }}
              >
                Pillar breakdown
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "0.4rem 0",
                  fontWeight: 500,
                }}
              >
                Plan
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = BAND_COLORS[r.band];
              return (
                <tr
                  key={r.studentId}
                  onClick={() => onOpenProfile(r.studentId)}
                  style={{
                    borderTop: "1px solid #f1f5f9",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#f8fafc";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <td style={{ padding: "0.55rem 0", verticalAlign: "middle" }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {r.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#64748b",
                        marginTop: 2,
                      }}
                    >
                      Grade {r.grade === 0 ? "K" : r.grade}
                      {r.isUnsupportedHighRisk && (
                        <span
                          style={{
                            marginLeft: "0.5rem",
                            background: "#fef3c7",
                            color: "#92400e",
                            padding: "1px 6px",
                            borderRadius: 3,
                            fontWeight: 600,
                            fontSize: 10,
                            letterSpacing: "0.02em",
                            textTransform: "uppercase",
                          }}
                        >
                          unsupported
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "0.55rem 0.5rem",
                      textAlign: "right",
                      verticalAlign: "middle",
                    }}
                  >
                    <span
                      style={{
                        background: c.bg,
                        color: c.fg,
                        padding: "3px 10px",
                        borderRadius: 4,
                        fontWeight: 700,
                        fontSize: 13,
                        fontVariantNumeric: "tabular-nums",
                        display: "inline-block",
                        minWidth: 36,
                        textAlign: "center",
                      }}
                      title={`${c.label} risk`}
                    >
                      {r.score}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "0.55rem 0.5rem",
                      verticalAlign: "middle",
                    }}
                  >
                    <PillarBar breakdown={r.breakdown} signals={r.signals} />
                  </td>
                  <td
                    style={{
                      padding: "0.55rem 0",
                      verticalAlign: "middle",
                      fontSize: 12,
                      color: r.hasActivePlan ? "#475569" : "#94a3b8",
                    }}
                  >
                    {r.hasActivePlan
                      ? `Tier ${r.signals.planTier}`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Compact 4-segment stacked bar showing how the composite breaks down
// across the four pillars. Each segment's width is its pillar score / 25.
// Empty pillars render as faint placeholders so the structure stays
// recognizable across rows.
function PillarBar({
  breakdown,
  signals,
}: {
  breakdown: Breakdown;
  signals: Signals;
}) {
  const pillars: {
    key: keyof Breakdown;
    label: string;
    color: string;
    score: number;
    detail: string;
  }[] = [
    {
      key: "academics",
      label: "Aca",
      color: "#0ea5e9",
      score: breakdown.academics,
      detail: `${signals.bqSubjects} BQ subj`,
    },
    {
      key: "behavior",
      label: "Beh",
      color: "#dc2626",
      score: breakdown.behavior,
      detail: `${signals.negPbis30d} neg PBIS`,
    },
    {
      key: "engagement",
      label: "Eng",
      color: "#f97316",
      score: breakdown.engagement,
      detail: `${signals.weightedEngagement30d} wtd events`,
    },
    {
      key: "supports",
      label: "Sup",
      color: "#7c3aed",
      score: breakdown.supports,
      detail:
        signals.planTier == null
          ? "no plan"
          : `T${signals.planTier} plan`,
    },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        alignItems: "center",
      }}
    >
      {pillars.map((p) => {
        const filled = p.score > 0;
        return (
          <div
            key={p.key}
            title={`${p.label}: ${p.score}/25 (${p.detail})`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              padding: "2px 6px",
              borderRadius: 3,
              background: filled ? p.color : "#f1f5f9",
              color: filled ? "white" : "#94a3b8",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.02em",
              minWidth: 38,
              justifyContent: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {p.label} {p.score}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Formatting helpers --------------------------------------------

function pctFmt(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  return `${(p * 100).toFixed(1)}%`;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

// ---------- Reusable bits (mirror EquityDashboard's Kpi/style atoms) ------

function Kpi({
  label,
  value,
  sub,
  accent,
  big,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  big?: boolean;
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
      <div
        style={{
          fontSize: big ? 28 : 22,
          fontWeight: 700,
          color: big ? accent : "inherit",
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: big ? "-0.02em" : undefined,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            color: "var(--text-subtle, #64748b)",
            fontSize: 11,
            marginTop: "0.2rem",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ---------- Style atoms ---------------------------------------------------

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

export default EarlyWarningDashboard;
