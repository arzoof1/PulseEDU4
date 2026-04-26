// Attendance Dashboard — school-level eduCLIMBER-style "Attendance"
// domain. Renders the totals, trends, and top-N lists returned by
// GET /api/insights/attendance. Click a student name → opens that
// student's profile via onOpenProfile (same wiring the watchlist
// uses).
//
// Permission: the backend gates this to core team only (Admin /
// SuperUser / Behavior Specialist / MTSS Coord / PBIS Coord). The
// caller (App.tsx) should only mount this component when the user
// passes that bar; we still render a clean 403 message if the
// backend rejects so a misrouted user gets a real explanation.

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, howtoListStyle } from "./HowToUseHelp";
import InsightsFilterBar, {
  EMPTY_FILTERS,
  filtersToQuery,
  type InsightsFilterValue,
} from "./InsightsFilterBar";

type WindowKey = "7" | "15" | "30" | "custom";

interface TopAbsentRow {
  studentId: string;
  studentName: string;
  absences: number;
  rate: number; // 0..1
}

interface AttendanceResponse {
  window: { from: string; to: string; label: string; days: number | null };
  grade: string | null;
  totals: {
    cohortStudents: number;
    schoolDays: number;
    ada: number; // 0..1
    totalAbsences: number;
    excusedAbsences: number;
    unexcusedAbsences: number;
    tardies: number;
    chronicAbsentStudents: number;
    chronicAbsentPct: number; // 0..1
  };
  trends: {
    dailyAttendanceRate: { date: string; rate: number }[];
    dailyAbsencesByType: {
      date: string;
      excused: number;
      unexcused: number;
      tardy: number;
    }[];
  };
  periodAbsences: { period: number; absences: number }[];
  topLists: {
    mostAbsent: TopAbsentRow[];
    chronicAbsent: TopAbsentRow[];
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

// Attendance accent — teal so it's visually distinct from engagement (blue),
// behavior (green/red), academics (purple), equity (amber), seb (red).
const ACCENT = "#0d9488"; // teal-600
const BAD = "#dc2626"; // red-600
const WARN = "#d97706"; // amber-600

export default function AttendanceDashboard({ onOpenProfile }: Props) {
  const [windowKey, setWindowKey] = useState<WindowKey>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [grade, setGrade] = useState("");
  const [filters, setFilters] = useState<InsightsFilterValue>(EMPTY_FILTERS);
  const [data, setData] = useState<AttendanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (windowKey === "custom") {
      if (!customFrom || !customTo) return null;
      p.set("window", "custom");
      p.set("from", customFrom);
      p.set("to", customTo);
    } else {
      p.set("window", windowKey);
    }
    if (grade) p.set("grade", grade);
    for (const [k, v] of filtersToQuery(filters)) p.set(k, v);
    return p.toString();
  }, [windowKey, customFrom, customTo, grade, filters]);

  useEffect(() => {
    if (queryString === null) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    authFetch(`/api/insights/attendance?${queryString}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as AttendanceResponse;
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
  }, [queryString]);

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
          <h2 style={{ margin: 0 }}>Attendance</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            Daily attendance rate, period absences, and chronic absenteeism —
            who's missing instruction and how often.
          </p>
        </div>
        <Filters
          windowKey={windowKey}
          setWindowKey={setWindowKey}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
          grade={grade}
          setGrade={setGrade}
        />
      </div>

      <InsightsFilterBar value={filters} onChange={setFilters} />

      <HowToUseHelp title="How to use Attendance">
        <HowToSection title="What this dashboard is">
          A school-wide read on who's actually in class. It rolls up daily
          attendance records (present / excused absent / unexcused absent /
          tardy) across the chosen window, breaks them out by period, and
          flags students whose personal absence rate has crossed Florida's
          chronic-absence threshold of 10%.
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
              <strong>ADA (Average Daily Attendance)</strong> — the percent
              of student-days in the window where the student was present
              (tardies count as present). 95%+ is healthy; sub-90% is a
              flashing red light.
            </li>
            <li>
              <strong>Total absences</strong> — full-day absences across the
              cohort (excused + unexcused).
            </li>
            <li>
              <strong>Excused vs Unexcused</strong> — split of those absences.
              A high excused share is usually illness or appointments;
              unexcused is the cohort to call home.
            </li>
            <li>
              <strong>Tardies</strong> — late arrivals. Counted as present for
              ADA but tracked separately because chronic tardies still erode
              instructional time and predict future absenteeism.
            </li>
            <li>
              <strong>Chronic absent students</strong> — count of students
              whose personal absence rate over the window is{" "}
              <strong>more than 10%</strong> (the FL definition). The percent
              underneath is the share of the cohort that hits that bar.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to read the chart and lists">
          <ul style={howtoListStyle}>
            <li>
              <strong>Daily attendance rate</strong> — one point per school
              day. A clean line near 95% is good; dips below 90% are the
              days worth looking into (weather, illness, event days).
            </li>
            <li>
              <strong>Absences by type / day</strong> — stacks excused,
              unexcused, and tardy counts so you can see whether a bad day
              was families calling kids out (excused) or kids just not
              showing (unexcused).
            </li>
            <li>
              <strong>Period absences</strong> — which periods accumulate
              the most missed seat-time. Useful for spotting first-period
              tardy clusters or a single class that's losing students.
            </li>
            <li>
              <strong>Most absent / Chronic absent</strong> — names are
              clickable. Most absent ranks raw count; chronic absent ranks
              by personal absence rate so a high-attender who only missed
              5 days doesn't crowd out a true chronic case.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="How to use it day-to-day">
          <ul style={howtoListStyle}>
            <li>
              <strong>Pick a window.</strong> 7d for the weekly meeting, 30d
              for monthly MTSS. The chronic threshold is computed against
              the window you pick.
            </li>
            <li>
              <strong>Filter by grade or teacher / period</strong> when a
              specific team owns the cohort.
            </li>
            <li>
              <strong>Start with chronic absent.</strong> These are the kids
              already past the 10% line — every additional day matters
              proportionally more.
            </li>
            <li>
              <strong>Cross-check unexcused vs excused.</strong> Unexcused
              concentration usually means a parent-contact campaign; excused
              concentration usually means a health / wellness conversation.
            </li>
          </ul>
        </HowToSection>

        <HowToSection title="A few caveats">
          <ul style={howtoListStyle}>
            <li>
              The chronic threshold (10%) is computed only against the
              days <em>in this window</em>. For an official year-to-date
              chronic count, pick a year-long custom window.
            </li>
            <li>
              Tardies are recorded as "present" for the ADA calculation
              (FL definition) but knock out the first period for the
              Period Absences chart.
            </li>
            <li>
              All counts respect the window picker — changing the window
              re-runs everything together.
            </li>
          </ul>
        </HowToSection>
      </HowToUseHelp>

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading attendance data…
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

// ---------- Filter strip ----------------------------------------------------

function Filters({
  windowKey,
  setWindowKey,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
  grade,
  setGrade,
}: {
  windowKey: WindowKey;
  setWindowKey: (w: WindowKey) => void;
  customFrom: string;
  setCustomFrom: (s: string) => void;
  customTo: string;
  setCustomTo: (s: string) => void;
  grade: string;
  setGrade: (g: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
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
      {(["7", "15", "30", "custom"] as WindowKey[]).map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => setWindowKey(w)}
          style={{
            ...chipStyle,
            background: w === windowKey ? "#1d4ed8" : "white",
            color: w === windowKey ? "white" : "#1f2937",
            borderColor: w === windowKey ? "#1d4ed8" : "#cbd5e1",
          }}
        >
          {w === "custom" ? "Custom" : `${w}d`}
        </button>
      ))}
      {windowKey === "custom" && (
        <>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            style={selectStyle}
          />
          <span style={{ color: "var(--text-subtle)" }}>→</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            style={selectStyle}
          />
        </>
      )}
    </div>
  );
}

// ---------- Body ------------------------------------------------------------

function Body({
  data,
  onOpenProfile,
}: {
  data: AttendanceResponse;
  onOpenProfile: (id: string) => void;
}) {
  const t = data.totals;
  const empty = t.schoolDays === 0 || t.cohortStudents === 0;

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
          label="ADA"
          value={`${(t.ada * 100).toFixed(1)}%`}
          sub={`${t.cohortStudents.toLocaleString()} students · ${t.schoolDays} days`}
          tone={t.ada >= 0.95 ? "good" : t.ada >= 0.9 ? "warn" : "bad"}
        />
        <Kpi label="Total absences" value={t.totalAbsences.toLocaleString()} />
        <Kpi
          label="Excused"
          value={t.excusedAbsences.toLocaleString()}
          sub={pctOf(t.excusedAbsences, t.totalAbsences)}
        />
        <Kpi
          label="Unexcused"
          value={t.unexcusedAbsences.toLocaleString()}
          sub={pctOf(t.unexcusedAbsences, t.totalAbsences)}
          tone={t.unexcusedAbsences > t.excusedAbsences ? "bad" : undefined}
        />
        <Kpi label="Tardies" value={t.tardies.toLocaleString()} />
        <Kpi
          label="Chronic absent (>10%)"
          value={t.chronicAbsentStudents.toLocaleString()}
          sub={`${(t.chronicAbsentPct * 100).toFixed(1)}% of cohort`}
          tone={
            t.chronicAbsentPct >= 0.15
              ? "bad"
              : t.chronicAbsentPct >= 0.1
                ? "warn"
                : undefined
          }
        />
      </div>

      {empty && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No attendance days recorded in this window
          {data.grade ? ` for grade ${data.grade}` : ""}. Try a wider window
          or a different cohort.
        </p>
      )}

      {/* Trends row */}
      {!empty && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "0.75rem",
            marginBottom: "1.25rem",
          }}
        >
          <RateTrendCard
            title="Daily attendance rate"
            color={ACCENT}
            data={data.trends.dailyAttendanceRate}
          />
          <AbsenceStackCard data={data.trends.dailyAbsencesByType} />
          <PeriodAbsenceCard data={data.periodAbsences} />
        </div>
      )}

      {/* Top-N tables */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <TopAbsentTable
          title="Most absent (raw count)"
          rows={data.topLists.mostAbsent}
          rankBy="absences"
          onOpenProfile={onOpenProfile}
        />
        <TopAbsentTable
          title="Chronic absent (>10% rate)"
          rows={data.topLists.chronicAbsent}
          rankBy="rate"
          onOpenProfile={onOpenProfile}
        />
      </div>

      <p
        style={{
          color: "var(--text-subtle)",
          fontSize: 12,
          marginTop: "1rem",
        }}
      >
        Window: {data.window.label}
        {data.grade ? ` · Grade ${data.grade}` : ""} · Chronic threshold: &gt;10%
      </p>
    </div>
  );
}

// ---------- Reusable bits ---------------------------------------------------

function pctOf(n: number, total: number): string {
  if (total <= 0) return "—";
  return `${((n / total) * 100).toFixed(0)}% of absences`;
}

type Tone = "good" | "warn" | "bad";

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: Tone;
}) {
  const toneColor =
    tone === "good"
      ? "#15803d"
      : tone === "warn"
        ? WARN
        : tone === "bad"
          ? BAD
          : undefined;
  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
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
          fontSize: "1.6rem",
          fontWeight: 600,
          color: toneColor,
        }}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-subtle, #94a3b8)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function RateTrendCard({
  title,
  color,
  data,
}: {
  title: string;
  color: string;
  data: { date: string; rate: number }[];
}) {
  // Map rate (0..1) → percentage points for the chart so the y-axis reads
  // "92" rather than "0.92".
  const series = data.map((d) => ({ date: d.date, pct: d.rate * 100 }));
  return (
    <div style={cardStyle}>
      <div style={cardLabelStyle}>{title}</div>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(d: string) => d.slice(5)}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            domain={[80, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={36}
          />
          <Tooltip
            labelFormatter={(d) => d}
            formatter={(v: number) => [`${v.toFixed(1)}%`, "rate"]}
            contentStyle={{ fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="pct"
            stroke={color}
            fill={color}
            fillOpacity={0.18}
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function AbsenceStackCard({
  data,
}: {
  data: { date: string; excused: number; unexcused: number; tardy: number }[];
}) {
  return (
    <div style={cardStyle}>
      <div style={cardLabelStyle}>Absences by type / day</div>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(d: string) => d.slice(5)}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
          <Tooltip contentStyle={{ fontSize: 12 }} />
          <Area
            type="monotone"
            dataKey="unexcused"
            stackId="a"
            stroke={BAD}
            fill={BAD}
            fillOpacity={0.5}
            name="Unexcused"
          />
          <Area
            type="monotone"
            dataKey="excused"
            stackId="a"
            stroke={WARN}
            fill={WARN}
            fillOpacity={0.4}
            name="Excused"
          />
          <Area
            type="monotone"
            dataKey="tardy"
            stackId="a"
            stroke={ACCENT}
            fill={ACCENT}
            fillOpacity={0.3}
            name="Tardy"
          />
        </AreaChart>
      </ResponsiveContainer>
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          fontSize: 11,
          color: "var(--text-subtle, #64748b)",
          marginTop: "0.25rem",
        }}
      >
        <Legend color={BAD} label="Unexcused" />
        <Legend color={WARN} label="Excused" />
        <Legend color={ACCENT} label="Tardy" />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          width: 10,
          height: 10,
          background: color,
          borderRadius: 2,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

function PeriodAbsenceCard({
  data,
}: {
  data: { period: number; absences: number }[];
}) {
  const max = data.reduce((m, d) => Math.max(m, d.absences), 0);
  return (
    <div style={cardStyle}>
      <div style={cardLabelStyle}>Period absences</div>
      {data.length === 0 || max === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No period-level absences in this window.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {data.map((row) => {
              const pct = max > 0 ? (row.absences / max) * 100 : 0;
              return (
                <tr key={row.period}>
                  <td style={{ padding: "0.2rem 0.5rem 0.2rem 0", width: 56 }}>
                    Period {row.period}
                  </td>
                  <td style={{ padding: "0.2rem 0" }}>
                    <div
                      style={{
                        background: "#f1f5f9",
                        height: 10,
                        borderRadius: 4,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          background: ACCENT,
                          width: `${pct}%`,
                          height: "100%",
                        }}
                      />
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "0.2rem 0 0.2rem 0.5rem",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--text-subtle, #475569)",
                      width: 60,
                    }}
                  >
                    {row.absences.toLocaleString()}
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

function TopAbsentTable({
  title,
  rows,
  rankBy,
  onOpenProfile,
}: {
  title: string;
  rows: TopAbsentRow[];
  rankBy: "absences" | "rate";
  onOpenProfile: (id: string) => void;
}) {
  return (
    <div style={cardStyle}>
      <div style={cardLabelStyle}>{title}</div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No data in this window.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--text-subtle, #64748b)", fontSize: 11 }}>
              <th style={{ textAlign: "left", padding: "0 0 0.25rem", fontWeight: 500 }}>
                Student
              </th>
              <th style={{ textAlign: "right", padding: "0 0 0.25rem", fontWeight: 500 }}>
                Absences
              </th>
              <th style={{ textAlign: "right", padding: "0 0 0.25rem", fontWeight: 500 }}>
                Rate
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ratePct = r.rate * 100;
              const rateBad = r.rate > 0.1;
              return (
                <tr key={r.studentId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "0.35rem 0" }}>
                    <button
                      type="button"
                      onClick={() => onOpenProfile(r.studentId)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#1d4ed8",
                        cursor: "pointer",
                        padding: 0,
                        font: "inherit",
                        textAlign: "left",
                      }}
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
                      fontWeight: rankBy === "absences" ? 600 : 400,
                    }}
                  >
                    {r.absences.toLocaleString()}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: rateBad ? BAD : "var(--text-subtle, #475569)",
                      fontWeight: rankBy === "rate" ? 600 : 400,
                    }}
                  >
                    {ratePct.toFixed(1)}%
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

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 8,
  padding: "0.85rem 1rem",
  background: "var(--card-bg, white)",
};

const cardLabelStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-subtle, #64748b)",
  marginBottom: "0.5rem",
};

const selectStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  font: "inherit",
  fontSize: 13,
};

const chipStyle: React.CSSProperties = {
  padding: "0.4rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 999,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};
