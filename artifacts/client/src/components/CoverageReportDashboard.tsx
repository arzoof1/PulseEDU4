import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
  LabelList,
} from "recharts";
import { authFetch } from "../lib/authToken";
import { TeacherPicker, type TeacherOpt } from "./TeacherPicker";

// Coverage Report — a teacher-effectiveness surface. Teachers self-serve
// their own report; Core Team / admins can pick any teacher. Everything is
// scoped to one subject (ELA/Math) and one PM window, and every mastery
// number reconciles with the FAST Benchmarks heatmap (same threshold + grade
// matching on the server).

interface Benchmark {
  code: string;
  coverageCount: number;
  teacherMasteryPct: number | null;
  teacherStudents: number;
  peerMasteryPct: number | null;
  peerStudents: number;
  delta: number | null;
  growth: { pm1: number | null; pm2: number | null; pm3: number | null };
}

interface Report {
  teacher: { id: number; displayName: string | null; department: string | null };
  subject: string;
  window: string;
  schoolYear: string;
  thresholdPct: number;
  availableWindows: { schoolYear: string; window: string; label: string }[];
  peerTeacherCount: number;
  benchmarks: Benchmark[];
}

interface Drill {
  benchmarkCode: string;
  window: string;
  schoolYear: string;
  thresholdPct: number;
  byPeriod: { period: number; students: number; masteryPct: number | null }[];
  bySubgroup: {
    key: string;
    label: string;
    groups: {
      group: string;
      teacherStudents: number;
      teacherMasteryPct: number | null;
      peerStudents: number;
      peerMasteryPct: number | null;
      small: boolean;
    }[];
  }[];
  roster:
    | {
        name: string;
        localSisId: string | null;
        periods: number[];
        earned: number;
        possible: number;
        masteryPct: number | null;
        mastered: boolean;
      }[]
    | null;
  adminOnly: boolean;
}

interface SendOuts {
  teacher: { id: number; displayName: string | null; department: string | null };
  rosterSize: number;
  totalSendOuts: number;
  periods: number[];
  dimensions: {
    key: string;
    label: string;
    groups: {
      group: string;
      rosterCount: number;
      sendOuts: number;
      byPeriod: { period: number; rosterCount: number; sendOuts: number }[];
    }[];
  }[];
}

const SUBJECTS: { key: string; label: string }[] = [
  { key: "ela", label: "ELA" },
  { key: "math", label: "Math" },
  { key: "algebra1", label: "Algebra 1" },
  { key: "geometry", label: "Geometry" },
];

// Match the standard Insights filter-bar teacher control so the picker
// looks identical to the rest of the Insights area (InsightsFilterBar).
const TEACHER_SELECT_STYLE: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "0.85rem",
  minWidth: 180,
};

function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : `${v}%`;
}

function masteryColor(v: number | null): string {
  if (v == null) return "var(--text-subtle)";
  if (v >= 80) return "#15803d";
  if (v >= 60) return "#a16207";
  return "#b91c1c";
}

function deltaColor(d: number | null): string {
  if (d == null) return "var(--text-subtle)";
  if (d > 0) return "#15803d";
  if (d < 0) return "#b91c1c";
  return "var(--text)";
}

export default function CoverageReportDashboard({
  onBack,
}: {
  onBack: () => void;
}) {
  const [teachers, setTeachers] = useState<TeacherOpt[]>([]);
  const [teacherId, setTeacherId] = useState<number | null>(null);
  const [subject, setSubject] = useState("ela");
  const [termKey, setTermKey] = useState<string>(""); // `${schoolYear}|${window}`
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drillCode, setDrillCode] = useState<string | null>(null);

  // Teacher list (self-only for non-core-team; full list for core team).
  useEffect(() => {
    authFetch("/api/teacher-roster/teachers")
      .then((r) => r.json())
      .then((d) => setTeachers(d.teachers ?? []))
      .catch(() => setTeachers([]));
  }, []);

  const loadReport = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ subject });
    if (teacherId != null) params.set("teacherId", String(teacherId));
    if (termKey) {
      const [sy, win] = termKey.split("|");
      params.set("schoolYear", sy);
      params.set("window", win);
    }
    authFetch(`/api/coverage-report?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load");
        return r.json();
      })
      .then((d: Report) => {
        setReport(d);
        // Keep the term selector in sync with what the server resolved.
        if (d.schoolYear) setTermKey(`${d.schoolYear}|${d.window}`);
      })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, [subject, teacherId, termKey]);

  // Reset the resolved term when subject/teacher changes so the server
  // re-defaults to the newest window for the new selection.
  useEffect(() => {
    setTermKey("");
  }, [subject, teacherId]);

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, teacherId]);

  const benchmarks = report?.benchmarks ?? [];

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button className="secondary" onClick={onBack}>
          ← Back
        </button>
        <h2 style={{ margin: 0 }}>📈 Coverage Report</h2>
      </div>
      <p style={{ color: "var(--text-subtle)", marginTop: 6 }}>
        Per-benchmark effectiveness: how much you covered, how your students
        mastered it, and how that compares to fellow teachers of the same
        subject and grade — with growth across PM windows, period and subgroup
        drill-downs, and a discretionary send-out equity check.
      </p>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "flex-end",
          margin: "12px 0",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Teacher</span>
          <TeacherPicker
            teachers={teachers}
            value={teacherId}
            onChange={setTeacherId}
            allowEmpty
            emptyLabel={
              teachers.length <= 1 ? "My report" : "Me (my report)"
            }
            showDeptFilter
            ariaLabel="Teacher"
            selectStyle={TEACHER_SELECT_STYLE}
          />
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Subject</span>
          <div style={{ display: "inline-flex", gap: 4 }}>
            {SUBJECTS.map((s) => (
              <button
                key={s.key}
                className={subject === s.key ? "primary" : "secondary"}
                onClick={() => setSubject(s.key)}
                style={{ padding: "5px 12px" }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Term (PM window)</span>
          <select
            value={termKey}
            onChange={(e) => setTermKey(e.target.value)}
            disabled={!report || report.availableWindows.length === 0}
            style={{ padding: "5px 8px" }}
          >
            {report?.availableWindows.map((w) => (
              <option key={w.label} value={`${w.schoolYear}|${w.window}`}>
                {w.label}
              </option>
            ))}
            {report && report.availableWindows.length === 0 && (
              <option value="">No FAST data</option>
            )}
          </select>
        </label>

        <button
          className="secondary"
          onClick={loadReport}
          disabled={loading}
          style={{ marginBottom: 1 }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div
          style={{
            background: "#fef2f2",
            color: "#b91c1c",
            padding: "8px 12px",
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {report && !error && (
        <>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-subtle)",
              marginBottom: 12,
            }}
          >
            Mastery = share of students scoring ≥ {report.thresholdPct}% on a
            benchmark. Peer = same-grade students of {report.peerTeacherCount}{" "}
            other {report.peerTeacherCount === 1 ? "teacher" : "teachers"} in{" "}
            {SUBJECTS.find((s) => s.key === report.subject)?.label ??
              report.subject}
            .
            {report.peerTeacherCount === 0 &&
              " No peer teachers found — peer columns are blank."}
          </div>

          {benchmarks.length === 0 ? (
            <p style={{ color: "var(--text-subtle)" }}>
              No benchmarks with data for this teacher, subject, and term yet.
            </p>
          ) : (
            <>
              <Layer1Table
                benchmarks={benchmarks}
                windowSel={report.window}
                onDrill={setDrillCode}
              />
              <Layer2Charts benchmarks={benchmarks} />
              <EquityPanel subject={subject} teacherId={teacherId} />
            </>
          )}
        </>
      )}

      {drillCode && report && (
        <DrillDrawer
          benchmarkCode={drillCode}
          subject={subject}
          teacherId={teacherId}
          schoolYear={report.schoolYear}
          windowSel={report.window}
          onClose={() => setDrillCode(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layer 1 — benchmark table.
// ---------------------------------------------------------------------------
function GrowthCells({ g }: { g: Benchmark["growth"] }) {
  const cells: Array<[string, number | null]> = [
    ["PM1", g.pm1],
    ["PM2", g.pm2],
    ["PM3", g.pm3],
  ];
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {cells.map(([lbl, v], i) => (
        <span key={lbl} style={{ display: "inline-flex", alignItems: "center" }}>
          {i > 0 && (
            <span style={{ color: "var(--text-subtle)", margin: "0 2px" }}>
              →
            </span>
          )}
          <span
            title={lbl}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: masteryColor(v),
              minWidth: 30,
              textAlign: "right",
            }}
          >
            {v == null ? "—" : v}
          </span>
        </span>
      ))}
    </span>
  );
}

function Layer1Table({
  benchmarks,
  windowSel,
  onDrill,
}: {
  benchmarks: Benchmark[];
  windowSel: string;
  onDrill: (code: string) => void;
}) {
  const [sort, setSort] = useState<"code" | "coverage" | "mastery" | "delta">(
    "code",
  );
  const sorted = useMemo(() => {
    const arr = [...benchmarks];
    if (sort === "coverage")
      arr.sort((a, b) => b.coverageCount - a.coverageCount);
    else if (sort === "mastery")
      arr.sort(
        (a, b) => (b.teacherMasteryPct ?? -1) - (a.teacherMasteryPct ?? -1),
      );
    else if (sort === "delta")
      arr.sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));
    return arr;
  }, [benchmarks, sort]);

  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <h3 style={{ margin: 0 }}>Benchmarks ({windowSel.toUpperCase()})</h3>
        <label style={{ fontSize: 13 }}>
          Sort:{" "}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="code">Benchmark code</option>
            <option value="coverage">Most covered</option>
            <option value="mastery">Highest mastery</option>
            <option value="delta">Widest gap vs peers</option>
          </select>
        </label>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid var(--border)" }}>
              <th style={{ padding: "6px 8px" }}>Benchmark</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Coverage</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>
                Your mastery
              </th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>
                Peer mastery
              </th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Δ</th>
              <th style={{ padding: "6px 8px" }}>Growth PM1→2→3</th>
              <th style={{ padding: "6px 8px" }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((b) => (
              <tr key={b.code} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 8px", fontWeight: 600 }}>{b.code}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                  {b.coverageCount === 0 ? (
                    <span style={{ color: "#b91c1c" }} title="No deliveries logged">
                      0
                    </span>
                  ) : (
                    b.coverageCount
                  )}
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    color: masteryColor(b.teacherMasteryPct),
                    fontWeight: 600,
                  }}
                >
                  {fmtPct(b.teacherMasteryPct)}
                  <span
                    style={{
                      color: "var(--text-subtle)",
                      fontWeight: 400,
                      fontSize: 11,
                    }}
                  >
                    {" "}
                    (n={b.teacherStudents})
                  </span>
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    color: masteryColor(b.peerMasteryPct),
                  }}
                >
                  {fmtPct(b.peerMasteryPct)}
                  {b.peerStudents > 0 && (
                    <span
                      style={{
                        color: "var(--text-subtle)",
                        fontSize: 11,
                      }}
                    >
                      {" "}
                      (n={b.peerStudents})
                    </span>
                  )}
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    fontWeight: 600,
                    color: deltaColor(b.delta),
                  }}
                >
                  {b.delta == null
                    ? "—"
                    : `${b.delta > 0 ? "+" : ""}${b.delta}`}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  <GrowthCells g={b.growth} />
                </td>
                <td style={{ padding: "6px 8px" }}>
                  <button
                    className="secondary"
                    style={{ padding: "2px 8px", fontSize: 12 }}
                    onClick={() => onDrill(b.code)}
                  >
                    Drill
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layer 2 — charts.
// ---------------------------------------------------------------------------
function Layer2Charts({ benchmarks }: { benchmarks: Benchmark[] }) {
  const scatterData = useMemo(
    () =>
      benchmarks
        .filter((b) => b.teacherMasteryPct != null)
        .map((b) => ({
          code: b.code,
          coverage: b.coverageCount,
          mastery: b.teacherMasteryPct as number,
          n: b.teacherStudents,
        })),
    [benchmarks],
  );

  const divergingData = useMemo(
    () =>
      benchmarks
        .filter((b) => b.delta != null)
        .map((b) => ({ code: b.code, delta: b.delta as number }))
        .sort((a, b) => a.delta - b.delta),
    [benchmarks],
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
        gap: 20,
        marginBottom: 24,
      }}
    >
      <div>
        <h3 style={{ margin: "0 0 4px" }}>Coverage vs mastery</h3>
        <p style={{ fontSize: 12, color: "var(--text-subtle)", margin: "0 0 8px" }}>
          Low-coverage / low-mastery benchmarks (bottom-left) are the clearest
          re-teach targets.
        </p>
        {scatterData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="coverage"
                name="Coverage"
                label={{
                  value: "Deliveries logged",
                  position: "insideBottom",
                  offset: -15,
                  fontSize: 12,
                }}
                allowDecimals={false}
              />
              <YAxis
                type="number"
                dataKey="mastery"
                name="Mastery %"
                domain={[0, 100]}
                label={{
                  value: "Mastery %",
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 12,
                }}
              />
              <ZAxis type="number" dataKey="n" range={[40, 300]} name="Students" />
              <ReferenceLine y={80} stroke="#15803d" strokeDasharray="4 4" />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as {
                    code: string;
                    coverage: number;
                    mastery: number;
                    n: number;
                  };
                  return (
                    <div
                      style={{
                        background: "#fff",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: "6px 10px",
                        fontSize: 12,
                      }}
                    >
                      <strong>{d.code}</strong>
                      <div>Coverage: {d.coverage}</div>
                      <div>Mastery: {d.mastery}%</div>
                      <div>Students: {d.n}</div>
                    </div>
                  );
                }}
              />
              <Scatter data={scatterData} fill="#2563eb">
                {scatterData.map((d) => (
                  <Cell key={d.code} fill={masteryColor(d.mastery)} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>

      <div>
        <h3 style={{ margin: "0 0 4px" }}>You minus peers</h3>
        <p style={{ fontSize: 12, color: "var(--text-subtle)", margin: "0 0 8px" }}>
          Green = your students outperformed peers on that benchmark; red =
          behind. Bars sorted worst-to-best.
        </p>
        {divergingData.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(280, divergingData.length * 22)}
          >
            <BarChart
              layout="vertical"
              data={divergingData}
              margin={{ top: 6, right: 30, bottom: 6, left: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" domain={["auto", "auto"]} fontSize={11} />
              <YAxis
                type="category"
                dataKey="code"
                width={110}
                fontSize={10}
                interval={0}
              />
              <ReferenceLine x={0} stroke="var(--text)" />
              <Tooltip
                formatter={(v: number) => [`${v > 0 ? "+" : ""}${v} pts`, "Δ"]}
              />
              <Bar dataKey="delta">
                {divergingData.map((d) => (
                  <Cell
                    key={d.code}
                    fill={d.delta >= 0 ? "#15803d" : "#b91c1c"}
                  />
                ))}
                <LabelList
                  dataKey="delta"
                  position="right"
                  fontSize={10}
                  formatter={(v: number) => (v > 0 ? `+${v}` : `${v}`)}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div
      style={{
        height: 280,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-subtle)",
        border: "1px dashed var(--border)",
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      Not enough data to chart yet.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layer 3 — drill-down drawer.
// ---------------------------------------------------------------------------
function DrillDrawer({
  benchmarkCode,
  subject,
  teacherId,
  schoolYear,
  windowSel,
  onClose,
}: {
  benchmarkCode: string;
  subject: string;
  teacherId: number | null;
  schoolYear: string;
  windowSel: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Drill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      subject,
      schoolYear,
      window: windowSel,
      benchmarkCode,
    });
    if (teacherId != null) params.set("teacherId", String(teacherId));
    authFetch(`/api/coverage-report/benchmark?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
        return r.json();
      })
      .then((d: Drill) => setData(d))
      .catch((e) => setError(e.message ?? "Failed"))
      .finally(() => setLoading(false));
  }, [benchmarkCode, subject, teacherId, schoolYear, windowSel]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 1000,
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          background: "var(--bg, #fff)",
          height: "100%",
          overflowY: "auto",
          padding: 20,
          boxShadow: "-4px 0 16px rgba(0,0,0,0.12)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2 style={{ margin: 0 }}>{benchmarkCode}</h2>
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ color: "var(--text-subtle)", fontSize: 13 }}>
          {windowSel.toUpperCase()} · {schoolYear}
        </p>

        {loading && <p>Loading…</p>}
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}

        {data && !loading && (
          <>
            <h3>By period</h3>
            {data.byPeriod.length === 0 ? (
              <p style={{ color: "var(--text-subtle)" }}>No period data.</p>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                  marginBottom: 16,
                }}
              >
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                    <th style={{ padding: "4px 6px" }}>Period</th>
                    <th style={{ padding: "4px 6px", textAlign: "right" }}>
                      Students
                    </th>
                    <th style={{ padding: "4px 6px", textAlign: "right" }}>
                      Mastery
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPeriod.map((p) => (
                    <tr key={p.period}>
                      <td style={{ padding: "4px 6px" }}>Period {p.period}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>
                        {p.students}
                      </td>
                      <td
                        style={{
                          padding: "4px 6px",
                          textAlign: "right",
                          color: masteryColor(p.masteryPct),
                          fontWeight: 600,
                        }}
                      >
                        {fmtPct(p.masteryPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>By subgroup</h3>
            <p style={{ fontSize: 12, color: "var(--text-subtle)", marginTop: 0 }}>
              You vs same-grade peers. Groups under 10 students are flagged
              (small n) but never hidden.
            </p>
            {data.bySubgroup.map((dim) => (
              <div key={dim.key} style={{ marginBottom: 14 }}>
                <strong style={{ fontSize: 13 }}>{dim.label}</strong>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                    marginTop: 4,
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        textAlign: "left",
                        color: "var(--text-subtle)",
                      }}
                    >
                      <th style={{ padding: "3px 6px" }}>Group</th>
                      <th style={{ padding: "3px 6px", textAlign: "right" }}>
                        You
                      </th>
                      <th style={{ padding: "3px 6px", textAlign: "right" }}>
                        Peers
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dim.groups.map((g) => (
                      <tr
                        key={g.group}
                        style={{ borderTop: "1px solid var(--border)" }}
                      >
                        <td style={{ padding: "3px 6px" }}>
                          {g.group}
                          {g.small && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 10,
                                color: "#a16207",
                                background: "#fef9c3",
                                padding: "0 4px",
                                borderRadius: 4,
                              }}
                            >
                              small n={g.teacherStudents}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "3px 6px",
                            textAlign: "right",
                            color: masteryColor(g.teacherMasteryPct),
                            fontWeight: 600,
                          }}
                        >
                          {fmtPct(g.teacherMasteryPct)}
                        </td>
                        <td
                          style={{
                            padding: "3px 6px",
                            textAlign: "right",
                            color: masteryColor(g.peerMasteryPct),
                          }}
                        >
                          {fmtPct(g.peerMasteryPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {data.adminOnly && data.roster && (
              <>
                <h3>Student roster (admin)</h3>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--text-subtle)" }}>
                      <th style={{ padding: "3px 6px" }}>Student</th>
                      <th style={{ padding: "3px 6px" }}>Per.</th>
                      <th style={{ padding: "3px 6px", textAlign: "right" }}>
                        Pts
                      </th>
                      <th style={{ padding: "3px 6px", textAlign: "right" }}>
                        %
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.roster.map((s) => (
                      <tr
                        key={`${s.localSisId ?? s.name}`}
                        style={{ borderTop: "1px solid var(--border)" }}
                      >
                        <td style={{ padding: "3px 6px" }}>
                          {s.name}
                          {!s.mastered && (
                            <span
                              style={{ color: "#b91c1c", marginLeft: 4 }}
                              title="Below threshold"
                            >
                              ●
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "3px 6px" }}>
                          {s.periods.join(", ") || "—"}
                        </td>
                        <td style={{ padding: "3px 6px", textAlign: "right" }}>
                          {s.earned}/{s.possible}
                        </td>
                        <td
                          style={{
                            padding: "3px 6px",
                            textAlign: "right",
                            color: masteryColor(s.masteryPct),
                            fontWeight: 600,
                          }}
                        >
                          {fmtPct(s.masteryPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Equity panel — discretionary send-out disproportionality.
// ---------------------------------------------------------------------------
function EquityPanel({
  subject,
  teacherId,
}: {
  subject: string;
  teacherId: number | null;
}) {
  const [data, setData] = useState<SendOuts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ subject });
    if (teacherId != null) params.set("teacherId", String(teacherId));
    authFetch(`/api/coverage-report/send-outs?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
        return r.json();
      })
      .then((d: SendOuts) => setData(d))
      .catch((e) => setError(e.message ?? "Failed"))
      .finally(() => setLoading(false));
  }, [subject, teacherId]);

  return (
    <div style={{ marginTop: 8 }}>
      <h3 style={{ marginBottom: 4 }}>Equity — discretionary send-outs</h3>
      <p style={{ fontSize: 12, color: "var(--text-subtle)", marginTop: 0 }}>
        Non-restroom hall passes you issued this year, shown as{" "}
        <strong>disproportionality</strong>: each subgroup's share of your
        send-outs ÷ its share of your roster. 1.0 = proportional; above ~1.3
        means that group is sent out more than its roster share would predict.
      </p>

      {loading && <p>Loading send-outs…</p>}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}

      {data && !loading && (
        <>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            {data.totalSendOuts} discretionary send-out
            {data.totalSendOuts === 1 ? "" : "s"} across {data.rosterSize}{" "}
            students.
          </div>
          {data.totalSendOuts === 0 ? (
            <p style={{ color: "var(--text-subtle)" }}>
              No discretionary send-outs recorded — nothing to disaggregate.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 16,
              }}
            >
              {data.dimensions.map((dim) => (
                <div
                  key={dim.key}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 10,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>{dim.label}</strong>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: 12,
                      marginTop: 6,
                    }}
                  >
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--text-subtle)" }}>
                        <th style={{ padding: "3px 4px" }}>Group</th>
                        <th style={{ padding: "3px 4px", textAlign: "right" }}>
                          Roster
                        </th>
                        <th style={{ padding: "3px 4px", textAlign: "right" }}>
                          Send-outs
                        </th>
                        <th style={{ padding: "3px 4px", textAlign: "right" }}>
                          Index
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dim.groups.map((g) => {
                        const rosterShare =
                          data.rosterSize > 0
                            ? g.rosterCount / data.rosterSize
                            : 0;
                        const sendShare =
                          data.totalSendOuts > 0
                            ? g.sendOuts / data.totalSendOuts
                            : 0;
                        const index =
                          rosterShare > 0 ? sendShare / rosterShare : null;
                        const over = index != null && index >= 1.3;
                        return (
                          <tr
                            key={g.group}
                            style={{ borderTop: "1px solid var(--border)" }}
                          >
                            <td style={{ padding: "3px 4px" }}>{g.group}</td>
                            <td
                              style={{ padding: "3px 4px", textAlign: "right" }}
                            >
                              {Math.round(rosterShare * 100)}%
                            </td>
                            <td
                              style={{ padding: "3px 4px", textAlign: "right" }}
                            >
                              {g.sendOuts}
                              <span
                                style={{
                                  color: "var(--text-subtle)",
                                  fontSize: 10,
                                }}
                              >
                                {" "}
                                ({Math.round(sendShare * 100)}%)
                              </span>
                            </td>
                            <td
                              style={{
                                padding: "3px 4px",
                                textAlign: "right",
                                fontWeight: 700,
                                color:
                                  index == null
                                    ? "var(--text-subtle)"
                                    : over
                                      ? "#b91c1c"
                                      : index <= 0.7
                                        ? "#15803d"
                                        : "var(--text)",
                              }}
                            >
                              {index == null ? "—" : `${index.toFixed(2)}×`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
