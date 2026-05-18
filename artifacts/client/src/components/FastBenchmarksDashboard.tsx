// FAST Phase 4 — Admin "FAST Benchmarks" Insights dashboard.
//
// Surfaces the three rollups the building-level Core Team asks for
// after every benchmark window closes:
//   1. Per-grade × per-category mastery grid.
//   2. School-wide bottom-3 benchmarks (suppressed to n ≥ 5).
//   3. Outlier teachers vs school mean+stdev on a chosen benchmark.
//   4. Year-over-year cohort comparison (prior G-1 PM3 vs current G PM1)
//      — grade-aligned summer-slide / transfer view.
//
// Auth + tenant scoping all happen server-side; this component is just
// a thin renderer. Empty states everywhere because prior-year data is
// optional and many benchmarks won't have ≥5 students to qualify for
// the bottom-3 tile.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";

type SubjectKey = "ela" | "math" | "algebra1" | "geometry";
type WindowKey = "pm1" | "pm2" | "pm3";

const SUBJECT_OPTIONS: Array<{ value: SubjectKey; label: string }> = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "algebra1", label: "Algebra 1" },
  { value: "geometry", label: "Geometry" },
];
const WINDOW_OPTIONS: Array<{ value: WindowKey; label: string }> = [
  { value: "pm1", label: "PM1" },
  { value: "pm2", label: "PM2" },
  { value: "pm3", label: "PM3" },
];

interface RollupRow {
  grade: number;
  category: string;
  masteryPct: number | null;
  benchmarkCount: number;
  studentCount: number;
}
interface BottomEntry {
  code: string;
  category: string | null;
  masteryPct: number;
  studentCount: number;
}
interface RollupResponse {
  subject: string;
  schoolYear: string;
  window: string;
  thresholdPct: number;
  rollup: RollupRow[];
  bottom3: BottomEntry[];
}

interface AvailableBenchmark {
  code: string;
  category: string | null;
  schoolMasteryPct: number;
  studentCount: number;
}
interface OutlierTeacher {
  teacherId: number;
  displayName: string | null;
  meanPct: number;
  studentCount: number;
  zScore: number;
  flagged: boolean;
  direction?: "low" | "high" | null;
}
interface OutlierResponse {
  subject: string;
  schoolYear: string;
  window: string;
  zThreshold: number;
  schoolMeanPct?: number;
  stdevPct?: number;
  benchmarkCode: string | null;
  benchmarkCategory: string | null;
  teachers: OutlierTeacher[];
  availableBenchmarks: AvailableBenchmark[];
}

interface YoyBenchmark {
  code: string;
  category: string | null;
  priorPct: number | null;
  currentPct: number | null;
  delta: number | null;
  priorN: number;
  currentN: number;
}
interface YoyResponse {
  subject: string;
  grade: number;
  currentSchoolYear: string;
  priorSchoolYear: string;
  currentWindow: string;
  priorWindow: string;
  benchmarks: YoyBenchmark[];
  cohortSize: number;
  priorCohortMatchCount: number;
}

function cellColor(pct: number, threshold: number): { bg: string; fg: string } {
  if (pct >= threshold) return { bg: "#bbf7d0", fg: "#065f46" };
  if (pct >= Math.max(0, threshold - 10))
    return { bg: "#fef08a", fg: "#854d0e" };
  if (pct >= Math.max(0, threshold - 30))
    return { bg: "#fed7aa", fg: "#9a3412" };
  return { bg: "#fecaca", fg: "#991b1b" };
}

function deltaColor(delta: number): { bg: string; fg: string } {
  if (delta >= 7) return { bg: "#bbf7d0", fg: "#065f46" };
  if (delta >= 3) return { bg: "#dcfce7", fg: "#166534" };
  if (delta > -3) return { bg: "#e5e7eb", fg: "#374151" };
  if (delta > -7) return { bg: "#fecaca", fg: "#991b1b" };
  return { bg: "#fca5a5", fg: "#7f1d1d" };
}

// Current school year picker — server-side seed uses the
// schoolYearLabelFor helper to compute the live "YY-YY" label. To keep
// the client simple we derive a sensible default from today's date
// (Aug rolls over) and let the admin edit it freely. Matches the
// import side that also asks the user to confirm the year.
function defaultSchoolYearYy(): string {
  const today = new Date();
  const month = today.getMonth(); // 0=Jan
  const year = today.getFullYear();
  // School year rolls in August.
  const startYear = month >= 7 ? year : year - 1;
  const a = String(startYear % 100).padStart(2, "0");
  const b = String((startYear + 1) % 100).padStart(2, "0");
  return `${a}-${b}`;
}

export default function FastBenchmarksDashboard({
  onBack,
}: {
  onBack: () => void;
}) {
  const [subject, setSubject] = useState<SubjectKey>("ela");
  const [window, setWindow] = useState<WindowKey>("pm1");
  const [schoolYear, setSchoolYear] = useState<string>(defaultSchoolYearYy());
  const [grade, setGrade] = useState<number>(3);

  const [rollup, setRollup] = useState<RollupResponse | null>(null);
  const [rollupLoading, setRollupLoading] = useState(false);
  const [rollupError, setRollupError] = useState("");

  const [outlierCode, setOutlierCode] = useState<string>("");
  const [outliers, setOutliers] = useState<OutlierResponse | null>(null);
  const [outliersLoading, setOutliersLoading] = useState(false);
  const [outliersError, setOutliersError] = useState("");

  const [yoy, setYoy] = useState<YoyResponse | null>(null);
  const [yoyLoading, setYoyLoading] = useState(false);
  const [yoyError, setYoyError] = useState("");

  // Category rollup load.
  useEffect(() => {
    let cancelled = false;
    setRollupLoading(true);
    setRollupError("");
    const p = new URLSearchParams({
      subject,
      window,
      schoolYear,
    });
    authFetch(`/api/insights/fast-benchmarks/category-rollup?${p}`)
      .then(async (r) => {
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(
            (b as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as RollupResponse;
      })
      .then((j) => {
        if (!cancelled) setRollup(j);
      })
      .catch((e: Error) => {
        if (!cancelled) setRollupError(e.message);
      })
      .finally(() => {
        if (!cancelled) setRollupLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subject, window, schoolYear]);

  // Outliers load — subject/window/schoolYear/(optional code).
  useEffect(() => {
    let cancelled = false;
    setOutliersLoading(true);
    setOutliersError("");
    const p = new URLSearchParams({
      subject,
      window,
      schoolYear,
    });
    if (outlierCode) p.set("benchmarkCode", outlierCode);
    authFetch(`/api/insights/fast-benchmarks/outliers?${p}`)
      .then(async (r) => {
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(
            (b as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as OutlierResponse;
      })
      .then((j) => {
        if (!cancelled) {
          setOutliers(j);
          // First load — sync the picker to the server's auto-pick
          // (weakest benchmark). User can override after that.
          if (!outlierCode && j.benchmarkCode) {
            setOutlierCode(j.benchmarkCode);
          }
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setOutliersError(e.message);
      })
      .finally(() => {
        if (!cancelled) setOutliersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subject, window, schoolYear, outlierCode]);

  // YoY load.
  useEffect(() => {
    let cancelled = false;
    setYoyLoading(true);
    setYoyError("");
    const p = new URLSearchParams({
      subject,
      schoolYear,
      grade: String(grade),
    });
    authFetch(`/api/insights/fast-benchmarks/year-over-year?${p}`)
      .then(async (r) => {
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(
            (b as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as YoyResponse;
      })
      .then((j) => {
        if (!cancelled) setYoy(j);
      })
      .catch((e: Error) => {
        if (!cancelled) setYoyError(e.message);
      })
      .finally(() => {
        if (!cancelled) setYoyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subject, schoolYear, grade]);

  // Pivot rollup rows into a (grade × category) grid for render.
  const rollupGrid = useMemo(() => {
    if (!rollup) return null;
    const grades = Array.from(
      new Set(rollup.rollup.map((r) => r.grade)),
    ).sort((a, b) => a - b);
    const categories = Array.from(
      new Set(rollup.rollup.map((r) => r.category)),
    ).sort();
    const byKey = new Map<string, RollupRow>();
    for (const r of rollup.rollup) {
      byKey.set(`${r.grade}|${r.category}`, r);
    }
    return { grades, categories, byKey };
  }, [rollup]);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <h2 style={{ margin: 0 }}>FAST Benchmarks</h2>
        <button onClick={onBack}>← Back to Insights</button>
      </div>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        School-wide rollups across grade × category, the three weakest
        benchmarks, outlier teachers on any benchmark, and year-over-year
        cohort comparison (prior PM3 vs current PM1, grade-aligned).
      </p>

      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          margin: "12px 0",
        }}
      >
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Subject:
          <select
            value={subject}
            onChange={(e) => setSubject(e.target.value as SubjectKey)}
          >
            {SUBJECT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Window:
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value as WindowKey)}
          >
            {WINDOW_OPTIONS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          School year:
          <input
            type="text"
            value={schoolYear}
            placeholder="25-26"
            pattern="\d{2}-\d{2}"
            onChange={(e) => setSchoolYear(e.target.value)}
            style={{ width: 80 }}
            title="Format: YY-YY (e.g. 25-26)"
          />
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          YoY grade:
          <select
            value={grade}
            onChange={(e) => setGrade(Number(e.target.value))}
            title="Compares prior G-1 PM3 vs current G PM1"
          >
            {Array.from({ length: 13 }, (_, i) => i).map((g) => (
              <option key={g} value={g}>
                G{g}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Category rollup */}
      <section style={{ marginBottom: 18 }}>
        <h3 style={{ margin: "0 0 8px" }}>
          Mastery by grade × category
          {rollup && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 12,
                fontWeight: 400,
                color: "#6b7280",
              }}
            >
              threshold {rollup.thresholdPct}%
            </span>
          )}
        </h3>
        {rollupLoading && <div>Loading category rollup…</div>}
        {rollupError && (
          <div style={errorStyle}>{rollupError}</div>
        )}
        {!rollupLoading &&
          !rollupError &&
          rollup &&
          rollup.rollup.length === 0 && (
            <div style={{ color: "#6b7280" }}>
              No FAST item-level data in {schoolYear} {window.toUpperCase()}{" "}
              for {subject.toUpperCase()}. Import via Data Importer first.
            </div>
          )}
        {!rollupLoading && rollupGrid && rollupGrid.grades.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: 12,
                minWidth: 480,
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}>
                    Grade
                  </th>
                  {rollupGrid.categories.map((c) => (
                    <th
                      key={c}
                      style={{
                        padding: "6px 8px",
                        textAlign: "center",
                        minWidth: 110,
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rollupGrid.grades.map((g) => (
                  <tr key={g} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td
                      style={{
                        padding: "6px 8px",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      G{g}
                    </td>
                    {rollupGrid.categories.map((c) => {
                      const cell = rollupGrid.byKey.get(`${g}|${c}`);
                      if (!cell || cell.masteryPct == null) {
                        return (
                          <td
                            key={c}
                            style={{
                              padding: "6px 8px",
                              textAlign: "center",
                              color: "#9ca3af",
                            }}
                          >
                            —
                          </td>
                        );
                      }
                      const col = cellColor(
                        cell.masteryPct,
                        rollup?.thresholdPct ?? 80,
                      );
                      return (
                        <td
                          key={c}
                          style={{
                            padding: "6px 8px",
                            textAlign: "center",
                            background: col.bg,
                            color: col.fg,
                            fontWeight: 700,
                          }}
                          title={`G${g} · ${c} — ${cell.benchmarkCount} benchmarks across ${cell.studentCount} students`}
                        >
                          {cell.masteryPct}%
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bottom-3 school-wide */}
      <section style={{ marginBottom: 18 }}>
        <h3 style={{ margin: "0 0 8px" }}>Weakest 3 benchmarks (school-wide)</h3>
        {rollup && rollup.bottom3.length === 0 && !rollupLoading && (
          <div style={{ color: "#6b7280" }}>
            No benchmarks with ≥5 students in this window.
          </div>
        )}
        {rollup && rollup.bottom3.length > 0 && (
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {rollup.bottom3.map((b) => (
              <li key={b.code} style={{ marginBottom: 4 }}>
                <code style={{ fontFamily: "monospace" }}>{b.code}</code>
                {b.category && (
                  <span style={{ color: "#6b7280" }}> · {b.category}</span>
                )}{" "}
                — school avg <strong>{b.masteryPct}%</strong> across{" "}
                {b.studentCount} students
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Outlier teachers */}
      <section style={{ marginBottom: 18 }}>
        <h3 style={{ margin: "0 0 8px" }}>
          Outlier teachers
          {outliers && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 12,
                fontWeight: 400,
                color: "#6b7280",
              }}
            >
              flag threshold |z| &gt; {outliers.zThreshold.toFixed(2)} (high or low)
            </span>
          )}
        </h3>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 8,
          }}
        >
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Benchmark:
            <select
              value={outlierCode}
              onChange={(e) => setOutlierCode(e.target.value)}
              disabled={
                !outliers || outliers.availableBenchmarks.length === 0
              }
            >
              {outliers?.availableBenchmarks.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.code} — {b.schoolMasteryPct}%
                </option>
              ))}
              {(!outliers ||
                outliers.availableBenchmarks.length === 0) && (
                <option value="">— no benchmarks —</option>
              )}
            </select>
          </label>
          {outliers && outliers.benchmarkCategory && (
            <span style={{ color: "#6b7280", fontSize: 12 }}>
              {outliers.benchmarkCategory}
            </span>
          )}
          {outliers &&
            outliers.schoolMeanPct != null &&
            outliers.stdevPct != null && (
              <span style={{ color: "#6b7280", fontSize: 12 }}>
                school mean {outliers.schoolMeanPct}% · σ{" "}
                {outliers.stdevPct}
              </span>
            )}
        </div>
        {outliersLoading && <div>Loading outliers…</div>}
        {outliersError && <div style={errorStyle}>{outliersError}</div>}
        {!outliersLoading &&
          outliers &&
          outliers.teachers.length === 0 && (
            <div style={{ color: "#6b7280" }}>
              No teachers with ≥5 students on this benchmark.
            </div>
          )}
        {!outliersLoading && outliers && outliers.teachers.length > 0 && (
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: 13,
              width: "100%",
              maxWidth: 720,
            }}
          >
            <thead>
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Teacher</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>
                  Class mean
                </th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>
                  Students
                </th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>
                  z
                </th>
                <th style={{ padding: "6px 8px" }}>Flag</th>
              </tr>
            </thead>
            <tbody>
              {outliers.teachers.map((t) => (
                <tr
                  key={t.teacherId}
                  style={{
                    borderTop: "1px solid #f3f4f6",
                    background: t.flagged
                      ? t.direction === "high"
                        ? "#ecfdf5"
                        : "#fef2f2"
                      : undefined,
                  }}
                >
                  <td style={{ padding: "6px 8px" }}>
                    {t.displayName ?? `Teacher #${t.teacherId}`}
                  </td>
                  <td
                    style={{
                      padding: "6px 8px",
                      textAlign: "right",
                      fontWeight: 600,
                    }}
                  >
                    {t.meanPct}%
                  </td>
                  <td
                    style={{ padding: "6px 8px", textAlign: "right" }}
                  >
                    {t.studentCount}
                  </td>
                  <td
                    style={{
                      padding: "6px 8px",
                      textAlign: "right",
                      color: t.zScore < 0 ? "#991b1b" : "#065f46",
                    }}
                  >
                    {t.zScore > 0 ? "+" : ""}
                    {t.zScore.toFixed(2)}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {t.flagged ? (
                      <span
                        style={{
                          background:
                            t.direction === "high" ? "#bbf7d0" : "#fecaca",
                          color:
                            t.direction === "high" ? "#065f46" : "#991b1b",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {t.direction === "high" ? "high outlier" : "low outlier"}
                      </span>
                    ) : (
                      <span style={{ color: "#9ca3af" }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Year-over-year */}
      <section style={{ marginBottom: 6 }}>
        <h3 style={{ margin: "0 0 8px" }}>
          Year-over-year (G{grade}){" "}
          {yoy && (
            <span
              style={{
                marginLeft: 4,
                fontSize: 12,
                fontWeight: 400,
                color: "#6b7280",
              }}
            >
              {yoy.priorSchoolYear} PM3 → {yoy.currentSchoolYear} PM1 · cohort{" "}
              {yoy.cohortSize} (matched prior {yoy.priorCohortMatchCount})
            </span>
          )}
        </h3>
        {yoyLoading && <div>Loading year-over-year…</div>}
        {yoyError && <div style={errorStyle}>{yoyError}</div>}
        {!yoyLoading &&
          yoy &&
          (yoy.benchmarks.length === 0 ||
            yoy.priorCohortMatchCount === 0 ||
            yoy.benchmarks.every((b) => b.priorPct == null)) && (
            <div style={{ color: "#6b7280" }}>
              No grade-aligned benchmarks with paired data. Prior-year
              PM3 for G{Math.max(0, grade - 1)} may not be imported yet.
            </div>
          )}
        {!yoyLoading &&
          yoy &&
          yoy.benchmarks.length > 0 &&
          yoy.priorCohortMatchCount > 0 &&
          yoy.benchmarks.some((b) => b.priorPct != null) && (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: 12,
                minWidth: 540,
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                  <th style={{ padding: "6px 8px" }}>Benchmark</th>
                  <th style={{ padding: "6px 8px" }}>Category</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>
                    Prior PM3
                  </th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>
                    Current PM1
                  </th>
                  <th
                    style={{ padding: "6px 8px", textAlign: "right" }}
                    title="Current PM1 − Prior PM3 (percentage points)"
                  >
                    Δ
                  </th>
                </tr>
              </thead>
              <tbody>
                {yoy.benchmarks.map((b) => {
                  const dc =
                    b.delta == null
                      ? { bg: "transparent", fg: "#9ca3af" }
                      : deltaColor(b.delta);
                  const sign = b.delta != null && b.delta > 0 ? "+" : "";
                  return (
                    <tr
                      key={b.code}
                      style={{ borderTop: "1px solid #f3f4f6" }}
                    >
                      <td
                        style={{
                          padding: "6px 8px",
                          fontFamily: "monospace",
                        }}
                      >
                        {b.code}
                      </td>
                      <td style={{ padding: "6px 8px", color: "#6b7280" }}>
                        {b.category ?? ""}
                      </td>
                      <td
                        style={{ padding: "6px 8px", textAlign: "right" }}
                      >
                        {b.priorPct == null ? (
                          <span style={{ color: "#9ca3af" }}>—</span>
                        ) : (
                          <>
                            {b.priorPct}%{" "}
                            <span
                              style={{ color: "#9ca3af", fontSize: 11 }}
                            >
                              (n={b.priorN})
                            </span>
                          </>
                        )}
                      </td>
                      <td
                        style={{ padding: "6px 8px", textAlign: "right" }}
                      >
                        {b.currentPct == null ? (
                          <span style={{ color: "#9ca3af" }}>—</span>
                        ) : (
                          <>
                            {b.currentPct}%{" "}
                            <span
                              style={{ color: "#9ca3af", fontSize: 11 }}
                            >
                              (n={b.currentN})
                            </span>
                          </>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          background: dc.bg,
                          color: dc.fg,
                          fontWeight: 600,
                        }}
                      >
                        {b.delta == null ? "—" : `${sign}${b.delta}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const errorStyle: CSSProperties = {
  color: "#991b1b",
  background: "#fee2e2",
  border: "1px solid #fca5a5",
  padding: "0.4rem 0.6rem",
  borderRadius: 6,
  fontSize: 13,
};
