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
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, howtoListStyle } from "./HowToUseHelp";
import {
  EMPTY_FILTERS,
  filtersToQuery,
  type InsightsFilterValue,
} from "./InsightsFilterBar";
import InsightsPicker, {
  csvFilename,
  downloadCsv,
  extractTopLists,
  topListsToCsv,
} from "./InsightsPicker";

type WindowKey = "7" | "15" | "30" | "custom";

interface TopAbsentRow {
  studentId: string;
  studentName: string;
  absences: number;
  rate: number; // 0..1
}

interface WeatherDay {
  date: string;
  tempHighF: number | null;
  tempLowF: number | null;
  precipInches: number | null;
  weatherCode: number | null;
  summary: string | null;
}

interface RecentAbsenceRow {
  studentId: string;
  studentName: string;
  date: string;
  status: "excused" | "unexcused" | "tardy" | string;
  periods: number[];
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
  weather: WeatherDay[];
  recentAbsences: RecentAbsenceRow[];
}

interface Props {
  onOpenProfile: (studentId: string) => void;
}

// Attendance accent — teal so it's visually distinct from engagement (blue),
// behavior (green/red), academics (purple), equity (amber), seb (red).
const ACCENT = "#0d9488"; // teal-600
const BAD = "#dc2626"; // red-600
const WARN = "#d97706"; // amber-600

export default function AttendanceDashboard({ onOpenProfile }: Props) {
  const [windowKey, setWindowKey] = useState<WindowKey>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [selectedGrades, setSelectedGrades] = useState<string[]>([]);
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
    if (selectedGrades.length > 0) p.set("grades", selectedGrades.join(","));
    for (const [k, v] of filtersToQuery(filters)) p.set(k, v);
    return p.toString();
  }, [windowKey, customFrom, customTo, selectedGrades, filters]);

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
        <WindowChips
          windowKey={windowKey}
          setWindowKey={setWindowKey}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
        />
      </div>

      <InsightsPicker
        grades={selectedGrades}
        onGradesChange={setSelectedGrades}
        filters={filters}
        onFiltersChange={setFilters}
        onDownloadCsv={() => {
          if (!data) return;
          downloadCsv(
            csvFilename("attendance", selectedGrades),
            topListsToCsv(extractTopLists(data)),
          );
        }}
        csvDisabled={!data}
      />

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

        <HowToSection title="Weather vs attendance">
          <p style={{ margin: "0 0 0.5rem" }}>
            The weather card overlays the daily attendance rate on top of
            high temperature and rainfall for the same window. Use it to
            sanity-check whether a dip on the line was a real attendance
            event or just a thunderstorm day. Below the chart you'll see
            the average high and total rainfall for the window, plus the
            count of days with measurable rain (≥0.1").
          </p>
          <p style={{ margin: 0 }}>
            The dashed teal line is the attendance rate, visually rescaled
            to sit alongside the temperature axis — hover any day to see
            the true percentage.
          </p>
        </HowToSection>

        <HowToSection title="Recent events">
          <p style={{ margin: 0 }}>
            The table at the bottom is the PBIS-style log: the 25 most
            recent absence and tardy entries in the window, newest first.
            Each row shows the date, student (clickable), the kind of
            absence, and which periods were missed. Use it to drill from
            the dashboard summary down to the specific incident — e.g.
            "Thursday's dip — who actually missed?"
          </p>
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

function WindowChips({
  windowKey,
  setWindowKey,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
}: {
  windowKey: WindowKey;
  setWindowKey: (w: WindowKey) => void;
  customFrom: string;
  setCustomFrom: (s: string) => void;
  customTo: string;
  setCustomTo: (s: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
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
          {w === "custom"
          ? "Custom"
          : w === "7"
            ? "Recent (7d)"
            : `${w}d`}
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
            windowLabel={data.window.label}
          />
          <AbsenceStackCard
            data={data.trends.dailyAbsencesByType}
            windowLabel={data.window.label}
          />
          <PeriodAbsenceCard
            data={data.periodAbsences}
            windowLabel={data.window.label}
          />
          <WeatherCard
            weather={data.weather}
            attendance={data.trends.dailyAttendanceRate}
            windowLabel={data.window.label}
          />
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

      {/* Recent events — PBIS-style log of the most recent absence entries */}
      <div style={{ marginTop: "0.75rem" }}>
        <RecentAbsencesTable
          rows={data.recentAbsences}
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
  windowLabel,
}: {
  title: string;
  color: string;
  data: { date: string; rate: number }[];
  windowLabel?: string;
}) {
  // Map rate (0..1) → percentage points for the chart so the y-axis reads
  // "92" rather than "0.92".
  const series = data.map((d) => ({ date: d.date, pct: d.rate * 100 }));
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const hovered = hoveredDate
    ? series.find((s) => s.date === hoveredDate) ?? null
    : null;
  return (
    <div style={cardStyle}>
      <CardLabel title={title} windowLabel={windowLabel} />
      <HoverStrip
        items={
          hovered
            ? [
                { label: hovered.date, bold: true },
                { label: "Rate", value: `${hovered.pct.toFixed(1)}%` },
              ]
            : null
        }
        placeholder="Hover the chart to see daily values"
      />
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart
          data={series}
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          onMouseMove={(state: { activeLabel?: string | number }) => {
            const label = state?.activeLabel;
            setHoveredDate(label != null ? String(label) : null);
          }}
          onMouseLeave={() => setHoveredDate(null)}
        >
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
          {/* Cursor line only — values are shown in the hover strip above. */}
          <Tooltip
            cursor={{ stroke: "#94a3b8", strokeDasharray: "3 3" }}
            content={() => null}
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
  windowLabel,
}: {
  data: { date: string; excused: number; unexcused: number; tardy: number }[];
  windowLabel?: string;
}) {
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const hovered = hoveredDate
    ? data.find((d) => d.date === hoveredDate) ?? null
    : null;
  return (
    <div style={cardStyle}>
      <CardLabel title="Absences by type / day" windowLabel={windowLabel} />
      <HoverStrip
        items={
          hovered
            ? [
                { label: hovered.date, bold: true },
                { label: "Unexcused", value: String(hovered.unexcused) },
                { label: "Excused", value: String(hovered.excused) },
                { label: "Tardy", value: String(hovered.tardy) },
              ]
            : null
        }
        placeholder="Hover the chart to see daily values"
      />
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart
          data={data}
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          onMouseMove={(state: { activeLabel?: string | number }) => {
            const label = state?.activeLabel;
            setHoveredDate(label != null ? String(label) : null);
          }}
          onMouseLeave={() => setHoveredDate(null)}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(d: string) => d.slice(5)}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={28} />
          {/* Cursor line only — values are shown in the hover strip above. */}
          <Tooltip
            cursor={{ stroke: "#94a3b8", strokeDasharray: "3 3" }}
            content={() => null}
          />
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
  windowLabel,
}: {
  data: { period: number; absences: number }[];
  windowLabel?: string;
}) {
  const max = data.reduce((m, d) => Math.max(m, d.absences), 0);
  return (
    <div style={cardStyle}>
      <CardLabel title="Period absences" windowLabel={windowLabel} />
      {data.length === 0 || max === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No period-level absences in this window.
        </p>
      ) : (
        <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
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
        <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
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

// ---------- Weather card ----------------------------------------------------
//
// Joins per-day temperature / precipitation against the daily attendance
// rate so a coach can eyeball "did rain knock attendance down on Thursday?"
// We use a composed chart: precip as bars (left axis, inches), high temp
// as a thin line (right axis, °F). The attendance rate is shown as a
// translucent area on the same temp axis (rescaled into the 80–100°F range
// just visually — the tooltip still shows the true %).

// Generic hover strip used by every chart card on this dashboard.
// Renders a one-line readout above the chart so the values never overlap
// the data lines. The DOM stays in place when nothing is hovered (a
// placeholder is shown instead) so the card doesn't reflow.
type HoverItem = { label: string; value?: string; bold?: boolean };
function HoverStrip({
  items,
  placeholder = "Hover the chart to see daily values",
}: {
  items: HoverItem[] | null;
  placeholder?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.65rem",
        alignItems: "baseline",
        fontSize: 12,
        minHeight: 18,
        marginBottom: "0.35rem",
        color: "var(--text, #1f2937)",
      }}
    >
      {items && items.length ? (
        items.map((it, i) =>
          it.bold ? (
            <strong key={i}>{it.label}</strong>
          ) : it.value !== undefined ? (
            <span key={i}>
              <span
                style={{
                  color: "var(--text-subtle, #94a3b8)",
                  marginRight: 4,
                }}
              >
                {it.label}
              </span>
              {it.value}
            </span>
          ) : (
            <span key={i} style={{ color: "var(--text-subtle, #64748b)" }}>
              {it.label}
            </span>
          ),
        )
      ) : (
        <span style={{ color: "var(--text-subtle, #94a3b8)" }}>
          {placeholder}
        </span>
      )}
    </div>
  );
}

function WeatherCard({
  weather,
  attendance,
  windowLabel,
}: {
  weather: WeatherDay[];
  attendance: { date: string; rate: number }[];
  windowLabel?: string;
}) {
  if (weather.length === 0) {
    return (
      <div style={cardStyle}>
        <CardLabel title="Weather vs attendance" windowLabel={windowLabel} />
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No weather data for this window yet. (We pull a few weeks of
          history when the school is restarted.)
        </p>
      </div>
    );
  }

  // Index attendance by date so we can stitch the two series together
  // without assuming they're the same length (weather covers every
  // calendar day; attendance only school days).
  const attByDate = new Map(attendance.map((d) => [d.date, d.rate]));

  // We rescale attendance rate (0..1 → 80..100) into the temp axis so it
  // sits visually next to the high-temp line. Tooltip still reports the
  // actual %.
  const series = weather.map((w) => {
    const rate = attByDate.get(w.date);
    return {
      date: w.date,
      precip: w.precipInches ?? 0,
      tempHigh: w.tempHighF,
      tempLow: w.tempLowF,
      summary: w.summary,
      attRate: rate ?? null,
      attRateScaled:
        rate != null ? Math.max(80, Math.min(100, rate * 100)) : null,
    };
  });

  // Window summary — useful for a quick "this week was wet" read.
  const tempVals = weather
    .map((w) => w.tempHighF)
    .filter((v): v is number => v != null);
  const precipVals = weather
    .map((w) => w.precipInches)
    .filter((v): v is number => v != null);
  const avgHigh = tempVals.length
    ? tempVals.reduce((a, b) => a + b, 0) / tempVals.length
    : null;
  const totalPrecip = precipVals.reduce((a, b) => a + b, 0);
  const wetDays = precipVals.filter((p) => p >= 0.1).length;

  // Track which day the user is hovering. Render the hovered values in an
  // inline strip ABOVE the chart instead of as a floating tooltip popup —
  // floating popups always end up covering the lines on a compact chart.
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const hovered = hoveredDate
    ? series.find((s) => s.date === hoveredDate) ?? null
    : null;

  const hoverItems: HoverItem[] | null = hovered
    ? [
        { label: hovered.date, bold: true },
        ...(hovered.summary
          ? [{ label: hovered.summary } as HoverItem]
          : []),
        {
          label: "Precip",
          value:
            hovered.precip != null
              ? `${hovered.precip.toFixed(2)}"`
              : "—",
        },
        {
          label: "High",
          value:
            hovered.tempHigh != null
              ? `${hovered.tempHigh.toFixed(0)}°F`
              : "—",
        },
        {
          label: "Attendance",
          value:
            hovered.attRate != null
              ? `${(hovered.attRate * 100).toFixed(1)}%`
              : "—",
        },
      ]
    : null;
  return (
    <div style={cardStyle}>
      <CardLabel title="Weather vs attendance" windowLabel={windowLabel} />
      <HoverStrip items={hoverItems} />
      <ResponsiveContainer width="100%" height={140}>
        <ComposedChart
          data={series}
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          onMouseMove={(state: { activeLabel?: string | number }) => {
            const label = state?.activeLabel;
            setHoveredDate(label != null ? String(label) : null);
          }}
          onMouseLeave={() => setHoveredDate(null)}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(d: string) => d.slice(5)}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis
            yAxisId="precip"
            orientation="left"
            tick={{ fontSize: 10 }}
            width={28}
            tickFormatter={(v: number) => `${v.toFixed(1)}"`}
            allowDecimals
          />
          <YAxis
            yAxisId="temp"
            orientation="right"
            tick={{ fontSize: 10 }}
            width={32}
            domain={[40, 100]}
            tickFormatter={(v: number) => `${v}°`}
          />
          {/*
            Render only the vertical cursor line on hover — the values
            themselves are shown in the inline strip above the chart so the
            popup never covers the data.
          */}
          <Tooltip
            cursor={{ stroke: "#94a3b8", strokeDasharray: "3 3" }}
            content={() => null}
          />
          <Bar
            yAxisId="precip"
            dataKey="precip"
            fill="#60a5fa"
            fillOpacity={0.55}
            name="Precip"
          />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="tempHigh"
            stroke="#f97316"
            strokeWidth={2}
            dot={false}
            name="High"
          />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="attRateScaled"
            stroke={ACCENT}
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            name="Attendance"
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          fontSize: 11,
          color: "var(--text-subtle, #64748b)",
          marginTop: "0.25rem",
          flexWrap: "wrap",
        }}
      >
        <Legend color="#60a5fa" label="Precip (in)" />
        <Legend color="#f97316" label="High °F" />
        <Legend color={ACCENT} label="Attendance (scaled)" />
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-subtle, #64748b)",
          marginTop: "0.4rem",
          lineHeight: 1.4,
        }}
      >
        {avgHigh != null && (
          <span>
            Avg high <strong>{avgHigh.toFixed(0)}°F</strong>
          </span>
        )}
        {totalPrecip > 0 && (
          <>
            {" · "}
            <span>
              <strong>{totalPrecip.toFixed(1)}"</strong> rain · {wetDays}{" "}
              wet day{wetDays === 1 ? "" : "s"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Recent absences (PBIS-style "Recent events" list) ---------------

const STATUS_TONE: Record<string, { bg: string; fg: string; label: string }> = {
  unexcused: { bg: "#fee2e2", fg: "#991b1b", label: "Unexcused" },
  excused: { bg: "#fef3c7", fg: "#92400e", label: "Excused" },
  tardy: { bg: "#cffafe", fg: "#155e75", label: "Tardy" },
};

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? {
    bg: "#e5e7eb",
    fg: "#1f2937",
    label: status,
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.1rem 0.5rem",
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {tone.label}
    </span>
  );
}

function periodSummary(periods: number[]): string {
  if (!periods || periods.length === 0) return "All day";
  if (periods.length === 1) return `Period ${periods[0]}`;
  const sorted = [...periods].sort((a, b) => a - b);
  return `Periods ${sorted.join(", ")}`;
}

function RecentAbsencesTable({
  rows,
  onOpenProfile,
}: {
  rows: RecentAbsenceRow[];
  onOpenProfile: (id: string) => void;
}) {
  return (
    <div style={cardStyle}>
      <div style={cardLabelStyle}>Recent events</div>
      <p
        style={{
          fontSize: 12,
          color: "var(--text-subtle, #64748b)",
          margin: "0 0 0.5rem",
        }}
      >
        The most recent absence and tardy entries in the window — newest
        first. Click a name to open that student's profile.
      </p>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No absence events recorded in this window.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="pulse-table"
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
          >
            <thead>
              <tr style={{ color: "var(--text-subtle, #64748b)", fontSize: 11 }}>
                <th
                  style={{
                    textAlign: "left",
                    padding: "0 0.5rem 0.25rem 0",
                    fontWeight: 500,
                  }}
                >
                  Date
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: "0 0.5rem 0.25rem 0",
                    fontWeight: 500,
                  }}
                >
                  Student
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: "0 0.5rem 0.25rem 0",
                    fontWeight: 500,
                  }}
                >
                  Status
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: "0 0 0.25rem",
                    fontWeight: 500,
                  }}
                >
                  Periods
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.studentId}-${r.date}-${i}`}
                  style={{ borderBottom: "1px solid #f1f5f9" }}
                >
                  <td
                    style={{
                      padding: "0.4rem 0.5rem 0.4rem 0",
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--text-subtle, #475569)",
                    }}
                  >
                    {r.date}
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem 0.4rem 0" }}>
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
                  <td style={{ padding: "0.4rem 0.5rem 0.4rem 0" }}>
                    <StatusPill status={r.status} />
                  </td>
                  <td
                    style={{
                      padding: "0.4rem 0",
                      color: "var(--text-subtle, #475569)",
                    }}
                  >
                    {periodSummary(r.periods)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

function CardLabel({
  title,
  windowLabel,
}: {
  title: string;
  windowLabel?: string;
}) {
  return (
    <div
      style={{
        ...cardLabelStyle,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "0.5rem",
        flexWrap: "wrap",
      }}
    >
      <span>{title}</span>
      {windowLabel ? (
        <span
          style={{
            textTransform: "none",
            letterSpacing: 0,
            fontWeight: 400,
            color: "var(--text-subtle, #94a3b8)",
            fontSize: 11,
          }}
        >
          {windowLabel}
        </span>
      ) : null}
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

const chipStyle: React.CSSProperties = {
  padding: "0.4rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 999,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};
