// Engagement Dashboard — school-level eduCLIMBER-style "Engagement"
// domain. Renders the totals, trends, and top-N lists returned by
// GET /api/insights/engagement. Click a student name → opens that
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

type WindowKey = "7" | "15" | "30" | "custom";

interface TopByCount {
  studentId: string;
  studentName: string;
  count: number;
}

interface TopIssStudent {
  studentId: string;
  studentName: string;
  dayCount: number;
}

interface EngagementResponse {
  window: { from: string; to: string; label: string; days: number | null };
  grade: string | null;
  totals: {
    hallPasses: number;
    tardies: number;
    issDays: number;
    pullouts: number;
    hallPassMinutesLost: number;
  };
  trends: {
    hallPassesByDay: { date: string; count: number }[];
    tardiesByDay: { date: string; count: number }[];
    issDaysByDay: { date: string; count: number }[];
  };
  topLists: {
    hallPassTakers: TopByCount[];
    hallPassDestinations: { destination: string; count: number }[];
    tardyStudents: TopByCount[];
    tardyPeriods: { period: string; count: number }[];
    issStudents: TopIssStudent[];
  };
}

interface Props {
  onOpenProfile: (studentId: string) => void;
}

// Same grade options the watchlist uses, kept in sync visually.
const GRADE_OPTIONS = [
  { value: "", label: "All grades" },
  { value: "K", label: "K" },
  ...Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: `Grade ${i + 1}`,
  })),
];

export default function EngagementDashboard({ onOpenProfile }: Props) {
  const [windowKey, setWindowKey] = useState<WindowKey>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [grade, setGrade] = useState("");
  const [data, setData] = useState<EngagementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (windowKey === "custom") {
      if (!customFrom || !customTo) return null; // wait for both
      p.set("window", "custom");
      p.set("from", customFrom);
      p.set("to", customTo);
    } else {
      p.set("window", windowKey);
    }
    if (grade) p.set("grade", grade);
    return p.toString();
  }, [windowKey, customFrom, customTo, grade]);

  useEffect(() => {
    if (queryString === null) return; // custom range incomplete
    let cancelled = false;
    setLoading(true);
    setError("");
    authFetch(`/api/insights/engagement?${queryString}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body.error || `Request failed (${r.status})`);
          setData(null);
          return;
        }
        const json = (await r.json()) as EngagementResponse;
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
          <h2 style={{ margin: 0 }}>Engagement</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            Hall passes, tardies, ISS days, and pullouts — what's pulling
            students out of instruction.
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

      {loading && (
        <p style={{ color: "var(--text-subtle)", marginTop: "1rem" }}>
          Loading engagement data…
        </p>
      )}
      {error && (
        <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>
      )}

      {data && !loading && !error && <Body data={data} onOpenProfile={onOpenProfile} />}
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

// ---------- Body (KPIs + trends + top-N tables) ----------------------------

function Body({
  data,
  onOpenProfile,
}: {
  data: EngagementResponse;
  onOpenProfile: (id: string) => void;
}) {
  const allZero =
    data.totals.hallPasses === 0 &&
    data.totals.tardies === 0 &&
    data.totals.issDays === 0 &&
    data.totals.pullouts === 0;

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
        <Kpi label="Hall Passes" value={data.totals.hallPasses} />
        <Kpi
          label="Minutes Lost (Hall)"
          value={data.totals.hallPassMinutesLost}
          sub="capped 8h/pass"
        />
        <Kpi label="Tardies" value={data.totals.tardies} />
        <Kpi label="ISS Days" value={data.totals.issDays} />
        <Kpi label="Pullouts" value={data.totals.pullouts} />
      </div>

      {allZero && (
        <p style={{ color: "var(--text-subtle)", margin: "0.5rem 0 1.5rem" }}>
          No engagement events recorded in this window
          {data.grade ? ` for grade ${data.grade}` : ""}. Try a wider window
          or a different grade cohort.
        </p>
      )}

      {/* Trends row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "0.75rem",
          marginBottom: "1.25rem",
        }}
      >
        <TrendCard
          title="Hall passes / day"
          color="#2563eb"
          data={data.trends.hallPassesByDay}
        />
        <TrendCard
          title="Tardies / day"
          color="#d97706"
          data={data.trends.tardiesByDay}
        />
        <TrendCard
          title="ISS days / day"
          color="#dc2626"
          data={data.trends.issDaysByDay}
        />
      </div>

      {/* Top-N tables */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <TopStudentTable
          title="Top hall-pass takers"
          rows={data.topLists.hallPassTakers}
          unit="passes"
          onOpenProfile={onOpenProfile}
        />
        <TopValueTable
          title="Top hall-pass destinations"
          rows={data.topLists.hallPassDestinations.map((r) => ({
            label: r.destination,
            value: r.count,
          }))}
          unit="passes"
        />
        <TopStudentTable
          title="Top tardy students"
          rows={data.topLists.tardyStudents}
          unit="tardies"
          onOpenProfile={onOpenProfile}
        />
        <TopValueTable
          title="Top tardy periods"
          rows={data.topLists.tardyPeriods.map((r) => ({
            label: r.period,
            value: r.count,
          }))}
          unit="tardies"
        />
        <TopStudentTable
          title="Top ISS students"
          rows={data.topLists.issStudents.map((r) => ({
            studentId: r.studentId,
            studentName: r.studentName,
            count: r.dayCount,
          }))}
          unit="days"
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
        {data.grade ? ` · Grade ${data.grade}` : ""}
      </p>
    </div>
  );
}

// ---------- Reusable bits ---------------------------------------------------

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub?: string;
}) {
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

function TrendCard({
  title,
  color,
  data,
}: {
  title: string;
  color: string;
  data: { date: string; count: number }[];
}) {
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
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-subtle, #64748b)",
          marginBottom: "0.5rem",
        }}
      >
        {title}
      </div>
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
          <YAxis
            tick={{ fontSize: 10 }}
            allowDecimals={false}
            width={28}
          />
          <Tooltip
            labelFormatter={(d) => d}
            formatter={(v: number) => [v, "count"]}
            contentStyle={{ fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="count"
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

function TopStudentTable({
  title,
  rows,
  unit,
  onOpenProfile,
}: {
  title: string;
  rows: { studentId: string; studentName: string; count: number }[];
  unit: string;
  onOpenProfile: (id: string) => void;
}) {
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
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-subtle, #64748b)",
          marginBottom: "0.5rem",
        }}
      >
        {title}
      </div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No data in this window.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {rows.map((r) => (
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
                  }}
                >
                  {r.count.toLocaleString()} {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TopValueTable({
  title,
  rows,
  unit,
}: {
  title: string;
  rows: { label: string; value: number }[];
  unit: string;
}) {
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
          fontSize: 12,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-subtle, #64748b)",
          marginBottom: "0.5rem",
        }}
      >
        {title}
      </div>
      {rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: 0 }}>
          No data in this window.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "0.35rem 0" }}>{r.label}</td>
                <td
                  style={{
                    padding: "0.35rem 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-subtle, #475569)",
                  }}
                >
                  {r.value.toLocaleString()} {unit}
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

const chipStyle: React.CSSProperties = {
  padding: "0.4rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 999,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};
