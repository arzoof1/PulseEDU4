// Insights → Instructional Coverage.
//
// Schoolwide rollup of the per-teacher Instruction Log: every benchmark
// in the catalog with total deliveries (anyone), distinct teacher
// coverage, last-taught date, and current-year mastery (when FAST data
// exists for the subject).
//
// Core-Team gated server-side (routes/benchmarkDeliveries.ts) so this
// page just renders whatever the API returns.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import BenchmarkStar from "./BenchmarkStar";

interface Row {
  code: string;
  category: string | null;
  label: string | null;
  totalDeliveries: number;
  distinctTeachers: number;
  lastTaughtOn: string | null;
  masteryPct: number | null;
}

interface Resp {
  subject: string;
  schoolYear: string;
  benchmarks: Row[];
}

const SUBJECTS: Array<{ value: string; label: string }> = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "writing", label: "Writing" },
  { value: "science", label: "Science" },
  { value: "social_studies", label: "Social Studies" },
];

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const then = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today.getTime() - then.getTime()) / 86400000);
}

interface Props {
  onBack: () => void;
}

// Florida benchmark codes encode grade as the 2nd dotted segment
// (e.g. "ELA.6.R.1.1" → "6", "MA.K.NSO.1.1" → "K"). Returns the
// uppercased token, or null when the code doesn't follow the pattern.
function gradeTokenFromCode(code: string): string | null {
  const parts = code.split(".");
  if (parts.length < 2) return null;
  const g = parts[1]?.trim().toUpperCase();
  return g ? g : null;
}

export default function InstructionalCoverageDashboard({ onBack }: Props) {
  const [subject, setSubject] = useState<string>("ela");
  const [grade, setGrade] = useState<string>("all");
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  // Sort: total | teachers | mastery | weakUntaught
  const [sort, setSort] = useState<"total" | "teachers" | "mastery" | "weak">(
    "weak",
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    authFetch(`/api/insights/instructional-coverage?subject=${subject}`)
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<Resp>;
      })
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subject]);

  // Grades present in the returned catalog (subject-aware). Drives the
  // grade picker so we only ever offer choices that actually exist —
  // a Math catalog limited to grades 3–5 won't surface a "Grade 8"
  // option that returns zero rows.
  const availableGrades = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const r of data.benchmarks) {
      const tok = gradeTokenFromCode(r.code);
      if (tok) set.add(tok);
    }
    // Sort: K, 1, 2, …, 12, then anything else alphabetically.
    const order = (t: string): number => {
      if (t === "K") return 0;
      const n = Number(t);
      return Number.isFinite(n) ? n : 1000;
    };
    return Array.from(set).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  }, [data]);

  // Reset the grade picker when the subject (and therefore the
  // available grades) changes — keeps the user from being stuck on a
  // grade the new subject doesn't have.
  useEffect(() => {
    setGrade("all");
  }, [subject]);

  const filteredBenchmarks = useMemo(() => {
    if (!data) return [] as Row[];
    if (grade === "all") return data.benchmarks;
    return data.benchmarks.filter((r) => gradeTokenFromCode(r.code) === grade);
  }, [data, grade]);

  const sorted = useMemo(() => {
    if (!data) return [] as Row[];
    const rows = [...filteredBenchmarks];
    if (sort === "total") {
      rows.sort((a, b) => b.totalDeliveries - a.totalDeliveries);
    } else if (sort === "teachers") {
      rows.sort((a, b) => b.distinctTeachers - a.distinctTeachers);
    } else if (sort === "mastery") {
      rows.sort(
        (a, b) =>
          (a.masteryPct ?? 101) - (b.masteryPct ?? 101) ||
          a.totalDeliveries - b.totalDeliveries,
      );
    } else {
      // "weak + untaught" = low mastery AND no recent instruction.
      // Score = (100 - mastery) + bonus when no delivery in 14 days.
      const score = (r: Row) => {
        const m = r.masteryPct ?? 50;
        const ago = daysAgo(r.lastTaughtOn);
        const stale = ago === null || ago > 14;
        return (100 - m) + (stale ? 30 : 0);
      };
      rows.sort((a, b) => score(b) - score(a));
    }
    return rows;
  }, [data, filteredBenchmarks, sort]);

  const totals = useMemo(() => {
    if (!data) return { rows: 0, deliveries: 0, taught: 0, untaught: 0 };
    const deliveries = filteredBenchmarks.reduce(
      (s, r) => s + r.totalDeliveries,
      0,
    );
    const taught = filteredBenchmarks.filter((r) => r.totalDeliveries > 0).length;
    return {
      rows: filteredBenchmarks.length,
      deliveries,
      taught,
      untaught: filteredBenchmarks.length - taught,
    };
  }, [data, filteredBenchmarks]);

  return (
    <div style={{ padding: "1rem", maxWidth: 1200 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <button onClick={onBack} style={{ padding: "4px 10px" }}>
          ← Back
        </button>
        <h2 style={{ margin: 0 }}>Instructional Coverage</h2>
        <label style={{ fontSize: 13, marginLeft: "auto" }}>
          Subject:&nbsp;
          <select value={subject} onChange={(e) => setSubject(e.target.value)}>
            {SUBJECTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          Grade:&nbsp;
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            disabled={availableGrades.length === 0}
          >
            <option value="all">All grades</option>
            {availableGrades.map((g) => (
              <option key={g} value={g}>
                {g === "K" ? "Kindergarten" : `Grade ${g}`}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          Sort by:&nbsp;
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="weak">Weak + untaught first</option>
            <option value="total">Most deliveries</option>
            <option value="teachers">Most teacher coverage</option>
            <option value="mastery">Lowest mastery</option>
          </select>
        </label>
      </div>

      {data && (
        <div
          style={{
            display: "flex",
            gap: 16,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <SummaryTile label="Benchmarks in catalog" value={totals.rows} />
          <SummaryTile label="Total deliveries" value={totals.deliveries} />
          <SummaryTile
            label="Taught at least once"
            value={`${totals.taught} / ${totals.rows}`}
          />
          <SummaryTile
            label="Untaught this year"
            value={totals.untaught}
            warn={totals.untaught > 0}
          />
          <div style={{ fontSize: 12, color: "#6b7280", alignSelf: "center" }}>
            School year: {data.schoolYear}
          </div>
        </div>
      )}

      {loading && <div style={{ fontSize: 13 }}>Loading…</div>}
      {err && (
        <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>
          {err}
        </div>
      )}

      {data && data.benchmarks.length === 0 && (
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          No standards catalog for {subject.toUpperCase()} yet. ELA / Math
          auto-populate from FAST imports; Writing / Science / Social Studies
          need an admin to import a standards CSV.
        </div>
      )}

      {data &&
        data.benchmarks.length > 0 &&
        filteredBenchmarks.length === 0 && (
          <div style={{ fontSize: 13, color: "#6b7280" }}>
            No {subject.toUpperCase()} benchmarks for{" "}
            {grade === "K" ? "Kindergarten" : `Grade ${grade}`}.
          </div>
        )}

      {data && filteredBenchmarks.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
              <th style={{ padding: "6px 8px", width: 64 }}>Coverage</th>
              <th style={{ padding: "6px 8px" }}>Benchmark</th>
              <th style={{ padding: "6px 8px" }}>Category</th>
              <th style={{ padding: "6px 8px", textAlign: "right", width: 100 }}>
                Deliveries
              </th>
              <th style={{ padding: "6px 8px", textAlign: "right", width: 100 }}>
                Teachers
              </th>
              <th style={{ padding: "6px 8px", width: 110 }}>Last taught</th>
              <th style={{ padding: "6px 8px", textAlign: "right", width: 90 }}>
                Mastery
              </th>
              <th style={{ padding: "6px 8px", width: 130 }}>Flag</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const ago = daysAgo(r.lastTaughtOn);
              const stale = ago === null || ago > 14;
              const weak = r.masteryPct !== null && r.masteryPct < 60;
              const weakUntaught = weak && stale;
              return (
                <tr
                  key={r.code}
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    background: weakUntaught ? "#fef2f2" : undefined,
                  }}
                >
                  <td style={{ padding: "6px 8px" }}>
                    <BenchmarkStar
                      count={r.totalDeliveries}
                      lastTaughtOn={r.lastTaughtOn}
                      size={26}
                    />
                  </td>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                    {r.code}
                    {r.label && (
                      <div
                        style={{
                          fontFamily: "inherit",
                          color: "#6b7280",
                          fontSize: 11,
                        }}
                      >
                        {r.label}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px", color: "#374151" }}>
                    {r.category ?? ""}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {r.totalDeliveries}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {r.distinctTeachers}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {r.lastTaughtOn ?? (
                      <span style={{ color: "#9ca3af" }}>—</span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "6px 8px",
                      textAlign: "right",
                      color:
                        r.masteryPct === null
                          ? "#9ca3af"
                          : r.masteryPct < 60
                            ? "#b91c1c"
                            : r.masteryPct < 80
                              ? "#92400e"
                              : "#047857",
                      fontWeight: 600,
                    }}
                  >
                    {r.masteryPct === null ? "—" : `${r.masteryPct}%`}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {weakUntaught && (
                      <span
                        style={{
                          background: "#fecaca",
                          color: "#7f1d1d",
                          padding: "1px 6px",
                          borderRadius: 3,
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      >
                        Weak + untaught
                      </span>
                    )}
                    {!weakUntaught && r.totalDeliveries === 0 && (
                      <span
                        style={{
                          background: "#e5e7eb",
                          color: "#374151",
                          padding: "1px 6px",
                          borderRadius: 3,
                          fontSize: 10,
                        }}
                      >
                        Untaught
                      </span>
                    )}
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

function SummaryTile({
  label,
  value,
  warn,
}: {
  label: string;
  value: number | string;
  warn?: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        padding: "8px 12px",
        minWidth: 140,
        background: warn ? "#fef2f2" : "white",
      }}
    >
      <div style={{ fontSize: 11, color: "#6b7280" }}>{label}</div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: warn ? "#b91c1c" : "#111827",
        }}
      >
        {value}
      </div>
    </div>
  );
}
