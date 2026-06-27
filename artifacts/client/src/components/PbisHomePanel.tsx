import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type WeekRow = {
  weekStart: string;
  weekEnd: string;
  pointsAwarded: number;
  studentsRecognized: number;
  teachersActive: number;
  avgPointsPerStudent: number;
};

type HomeStats = {
  weeks: WeekRow[];
  totalStudents: number;
  totalTeachingStaff: number;
  thisWeek: WeekRow | null;
  lastWeek: WeekRow | null;
};

type KpiKey =
  | "pointsAwarded"
  | "studentsRecognized"
  | "teachersActive"
  | "avgPointsPerStudent";

type KpiCfg = {
  key: KpiKey;
  label: string;
  color: string;
  format: (n: number, stats: HomeStats) => string;
  describe: (stats: HomeStats) => string;
};

const kpis: KpiCfg[] = [
  {
    key: "pointsAwarded",
    label: "Points Awarded",
    color: "#7c3aed",
    format: (n) => n.toLocaleString(),
    describe: () => "this week",
  },
  {
    key: "studentsRecognized",
    label: "Students Recognized",
    color: "#0d9488",
    format: (n, s) =>
      s.totalStudents > 0
        ? `${Math.round((n / s.totalStudents) * 100)}%`
        : "—",
    describe: (s) =>
      s.thisWeek
        ? `${s.thisWeek.studentsRecognized} of ${s.totalStudents}`
        : "this week",
  },
  {
    key: "teachersActive",
    label: "Staff Active",
    color: "#0e7490",
    format: (n, s) =>
      s.totalTeachingStaff > 0
        ? `${Math.round((n / s.totalTeachingStaff) * 100)}%`
        : "—",
    describe: (s) =>
      s.thisWeek
        ? `${s.thisWeek.teachersActive} of ${s.totalTeachingStaff}`
        : "this week",
  },
  {
    key: "avgPointsPerStudent",
    label: "Avg Points / Student",
    color: "#b45309",
    format: (n) => n.toFixed(1),
    describe: () => "this week",
  },
];

function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) {
    if (curr === 0) return 0;
    return null; // undefined % change from a zero base
  }
  return ((curr - prev) / prev) * 100;
}

function Sparkline({
  values,
  color,
  width = 110,
  height = 28,
}: {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block" }}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function PbisHomePanel() {
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await authFetch("/api/pbis/home-stats");
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) {
            setError(
              (j && j.error) ||
                `Couldn't load PBIS stats (HTTP ${res.status}).`,
            );
            setStats(null);
          }
          return;
        }
        if (!cancelled) setStats(j as HomeStats);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStats(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const series = useMemo(() => {
    if (!stats) return null;
    return {
      pointsAwarded: stats.weeks.map((w) => w.pointsAwarded),
      studentsRecognized: stats.weeks.map((w) => w.studentsRecognized),
      teachersActive: stats.weeks.map((w) => w.teachersActive),
      avgPointsPerStudent: stats.weeks.map((w) => w.avgPointsPerStudent),
    };
  }, [stats]);

  return (
    <div
      className="card no-print"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "0.75rem",
      }}
    >
      {loading && (
        <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
          Loading PBIS stats…
        </div>
      )}
      {!loading && error && (
        <div style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{error}</div>
      )}
      {!loading &&
        !error &&
        stats &&
        series &&
        kpis.map((k) => {
          const currRaw = stats.thisWeek ? stats.thisWeek[k.key] : 0;
          const prevRaw = stats.lastWeek ? stats.lastWeek[k.key] : 0;
          const display = k.format(currRaw, stats);
          const change = deltaPct(currRaw, prevRaw);
          let trendColor = "#64748b";
          let trendArrow = "→";
          let trendText = "no change";
          if (change == null) {
            trendArrow = "—";
            trendText = "vs last week";
          } else if (change > 0.5) {
            trendColor = "#15803d";
            trendArrow = "▲";
            trendText = `${change.toFixed(0)}% vs last week`;
          } else if (change < -0.5) {
            trendColor = "#b91c1c";
            trendArrow = "▼";
            trendText = `${Math.abs(change).toFixed(0)}% vs last week`;
          } else {
            trendText = "flat vs last week";
          }
          return (
            <div
              key={k.key}
              style={{
                background: "white",
                border: `1px solid ${k.color}22`,
                borderLeft: `4px solid ${k.color}`,
                borderRadius: 8,
                padding: "0.85rem 1rem",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: "0.78rem",
                    color: "#475569",
                    fontWeight: 600,
                    letterSpacing: 0.2,
                    textTransform: "uppercase",
                  }}
                >
                  {k.label}
                </span>
                <Sparkline values={series[k.key]} color={k.color} />
              </div>
              <div
                style={{
                  fontSize: "1.65rem",
                  fontWeight: 700,
                  color: k.color,
                  lineHeight: 1.1,
                }}
              >
                {display}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                {k.describe(stats)}
              </div>
              <div
                style={{
                  fontSize: "0.78rem",
                  color: trendColor,
                  fontWeight: 600,
                }}
              >
                {trendArrow} {trendText}
              </div>
            </div>
          );
        })}
    </div>
  );
}
