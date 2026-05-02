// MTSS Reports — trends + charts page for the Core Team.
//
// Two modes, same component:
//   - Standalone: pass no `planId`. The user picks filters across
//     every active plan in the school.
//   - Per-plan: pass `planId`. Shows that plan's metadata up top,
//     and unlocks the "Since plan opened" date preset.
//
// Charts:
//   - Weekly trend line (T2 % completion + T3 % avg score)
//   - Per-teacher completion bar (with score column)
//   - Per-subject completion bar (T2)
//   - Day-of-week heatmap (Mon–Fri)
//   - T3 weekly average score trend line
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
  };
  planMeta: {
    id: number;
    studentId: string;
    studentName: string;
    grade: string | null;
    tier: number;
    subType: string | null;
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
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
    t3ScoredCount: number;
    t3AvgScore: number | null;
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

// Color the dow heatmap from completion% (0=red, 100=green).
function heatColor(pct: number | null): string {
  if (pct == null) return "#e5e7eb";
  // simple red→amber→green ramp.
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped >= 90) return "#16a34a";
  if (clamped >= 80) return "#65a30d";
  if (clamped >= 70) return "#ca8a04";
  if (clamped >= 50) return "#ea580c";
  return "#dc2626";
}

// ---------------- component ----------------

export default function MtssReportsPage({
  onBack,
  planId,
  initialPlanTitle,
}: Props) {
  const isPerPlan = planId != null;

  // ---- filters ----
  const [range, setRange] = useState<RangePreset>(isPerPlan ? "30" : "30");
  const [tier, setTier] = useState<"all" | "2" | "3">("all");
  const [subType, setSubType] = useState<string>("");
  const [grade, setGrade] = useState<string>("");
  const [teacherStaffId, setTeacherStaffId] = useState<number | "">("");

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
        if (planId) params.set("planId", String(planId));
        if (!isPerPlan) {
          if (tier !== "all") params.set("tier", tier);
          if (subType) params.set("subType", subType);
          if (grade) params.set("grade", grade);
          if (teacherStaffId !== "")
            params.set("teacherStaffId", String(teacherStaffId));
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
  }, [range, planId, isPerPlan, tier, subType, grade, teacherStaffId]);

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
              <div>
                T{data.planMeta.tier}
                {data.planMeta.subType ? ` — ${data.planMeta.subType}` : ""}
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
                <label style={labelStyle} htmlFor="rep-tier">
                  Tier
                </label>
                <select
                  id="rep-tier"
                  value={tier}
                  onChange={(e) =>
                    setTier(e.target.value as "all" | "2" | "3")
                  }
                  style={inputStyle}
                >
                  <option value="all">All tiers</option>
                  <option value="2">Tier 2</option>
                  <option value="3">Tier 3</option>
                </select>
              </div>
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
      {loading && !data && (
        <div className="mtss-reports-card" style={cardStyle}>
          Loading…
        </div>
      )}

      {/* ---- summary tiles ---- */}
      {data && (
        <div
          className="mtss-reports-card"
          style={{
            ...cardStyle,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
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
            label="T2 completion (overall)"
            value={fmtPct(overallT2)}
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
            label="T3 avg score (overall)"
            value={fmtScore(overallT3)}
            sub={overallT3 != null ? "/ 5" : undefined}
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
        </div>
      )}

      {/* ---- weekly trend chart ---- */}
      {data && data.weeklyTrend.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Weekly trend</h3>
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
              <Line
                type="monotone"
                dataKey="t3AvgScorePct"
                stroke="#a855f7"
                name="T3 % avg score"
                connectNulls
                dot
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ---- per-teacher chart + table ---- */}
      {data && data.perTeacher.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>By teacher</h3>
          <ResponsiveContainer width="100%" height={Math.max(220, data.perTeacher.length * 28)}>
            <BarChart
              data={data.perTeacher}
              layout="vertical"
              margin={{ left: 80, right: 16, top: 8, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" domain={[0, 100]} />
              <YAxis
                type="category"
                dataKey="teacherName"
                width={160}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              <Bar
                dataKey="t2CompletionPct"
                fill="#2563eb"
                name="T2 % completion"
              />
            </BarChart>
          </ResponsiveContainer>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
              }}
            >
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={th}>Teacher</th>
                  <th style={th}>T2 done</th>
                  <th style={th}>T2 expected</th>
                  <th style={th}>T2 %</th>
                  <th style={th}>T3 scored</th>
                  <th style={th}>T3 avg</th>
                </tr>
              </thead>
              <tbody>
                {data.perTeacher.map((r) => (
                  <tr key={r.teacherStaffId}>
                    <td style={td}>{r.teacherName}</td>
                    <td style={tdR}>{r.t2Completed}</td>
                    <td style={tdR}>{r.t2Expected}</td>
                    <td style={tdR}>{fmtPct(r.t2CompletionPct)}</td>
                    <td style={tdR}>{r.t3ScoredCount}</td>
                    <td style={tdR}>{fmtScore(r.t3AvgScore)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- per-subject chart ---- */}
      {data && data.perSubject.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>By subject (Tier 2)</h3>
          <ResponsiveContainer width="100%" height={Math.max(200, data.perSubject.length * 28)}>
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

      {/* ---- day-of-week heatmap ---- */}
      {data && data.dayOfWeek.length > 0 && (
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

      {/* ---- T3 trend ---- */}
      {data && data.t3GoalTrend.length > 0 && (
        <div className="mtss-reports-card" style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Tier 3 weekly average score</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.t3GoalTrend}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="weekStartDate" />
              <YAxis domain={[0, 5]} />
              <Tooltip />
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

      {/* ---- empty-state nudge ---- */}
      {data &&
        data.weeklyTrend.length === 0 &&
        data.perTeacher.length === 0 && (
          <div
            className="mtss-reports-card"
            style={{ ...cardStyle, color: "#64748b" }}
          >
            No intervention activity in this date range for the chosen
            filters. Try a wider preset or a different filter.
          </div>
        )}
    </div>
  );
}

// ---------------- mini bits ----------------

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "1px solid #e5e7eb",
  fontSize: "0.75rem",
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const td: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #f1f5f9",
};
const tdR: React.CSSProperties = { ...td, textAlign: "right" };

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
