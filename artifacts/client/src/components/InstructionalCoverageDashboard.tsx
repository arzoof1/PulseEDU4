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
import {
  HowToUseHelp,
  HowToSection,
  howtoListStyle,
} from "./HowToUseHelp";

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
  const [benchmarkCode, setBenchmarkCode] = useState<string>("all");
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

  // Reset the grade + benchmark pickers when the subject (and therefore the
  // available grades) changes — keeps the user from being stuck on a
  // grade the new subject doesn't have.
  useEffect(() => {
    setGrade("all");
    setBenchmarkCode("all");
  }, [subject]);

  // Reset the benchmark picker when the grade changes, since the picker's
  // options are scoped to the current grade.
  useEffect(() => {
    setBenchmarkCode("all");
  }, [grade]);

  // Strip the subject + grade tokens (e.g. "ELA.7." or "MA.8.") so a
  // benchmark suffix like "R.1.1" can be matched across grades. Used by
  // both the dropdown options (grouping) and the table filter.
  const suffixOf = (code: string): string => {
    const parts = code.split(".");
    return parts.length > 2 ? parts.slice(2).join(".") : code;
  };

  const filteredBenchmarks = useMemo(() => {
    if (!data) return [] as Row[];
    let rows = data.benchmarks;
    if (grade !== "all") {
      rows = rows.filter((r) => gradeTokenFromCode(r.code) === grade);
    }
    if (benchmarkCode !== "all") {
      // Match by suffix so picking "R.1.1" with Grade=All surfaces every
      // grade's R.1.1 row. When a specific grade is selected, the grade
      // filter above has already narrowed it to a single row.
      rows = rows.filter((r) => suffixOf(r.code) === benchmarkCode);
    }
    return rows;
  }, [data, grade, benchmarkCode]);

  // Benchmark dropdown options — grouped by suffix so duplicates across
  // grades collapse into one entry. With Grade = All you see one "R.1.1"
  // option that filters the table to every grade's R.1.1. With a specific
  // grade selected there's only one benchmark per suffix anyway, so the
  // grouping is a no-op. The label shows which grades carry the suffix
  // (e.g. "R.1.1 (G6, G7, G8) — Reading Prose and Poetry") so coaches
  // know it spans the school.
  const benchmarkOptions = useMemo(() => {
    if (!data) return [] as Array<{ suffix: string; label: string }>;
    const rows =
      grade === "all"
        ? data.benchmarks
        : data.benchmarks.filter((r) => gradeTokenFromCode(r.code) === grade);
    const groups = new Map<
      string,
      { grades: Set<string>; category: string | null }
    >();
    for (const r of rows) {
      const suffix = suffixOf(r.code);
      const g = gradeTokenFromCode(r.code);
      const existing = groups.get(suffix);
      if (existing) {
        if (g) existing.grades.add(g);
        if (!existing.category && r.category) existing.category = r.category;
      } else {
        groups.set(suffix, {
          grades: new Set(g ? [g] : []),
          category: r.category,
        });
      }
    }
    const gradeOrder = (g: string) => (g === "K" ? -1 : Number(g));
    return Array.from(groups.entries())
      .map(([suffix, info]) => {
        const grades = Array.from(info.grades).sort(
          (a, b) => gradeOrder(a) - gradeOrder(b),
        );
        const gradePart =
          grade === "all" && grades.length > 1
            ? ` (${grades.map((g) => (g === "K" ? "K" : `G${g}`)).join(", ")})`
            : "";
        const catPart = info.category ? ` — ${info.category}` : "";
        return { suffix, label: `${suffix}${gradePart}${catPart}` };
      })
      .sort((a, b) => a.suffix.localeCompare(b.suffix));
  }, [data, grade]);

  // Effectiveness band — combines delivery count with mastery to indicate
  // whether the methods being used are landing. Used for both the row Flag
  // pill and the default sort order.
  type Band = "critical" | "reteach" | "building" | "effective";
  const bandOf = (r: Row): Band => {
    const m = r.masteryPct;
    const d = r.totalDeliveries;
    if (d === 0) return "critical";
    if (m === null) {
      // Taught but no mastery signal yet — treat as building.
      return d >= 2 ? "building" : "critical";
    }
    if (d === 1 && m < 50) return "critical";
    if (d >= 2 && m < 50) return "reteach";
    if (m >= 70 && d >= 3) return "effective";
    return "building";
  };
  const BAND_META: Record<
    Band,
    { label: string; bg: string; fg: string; row: string; rank: number; help: string }
  > = {
    critical: {
      label: "Critical gap",
      bg: "#fecaca",
      fg: "#7f1d1d",
      row: "#fef2f2",
      rank: 0,
      help: "Untaught or barely touched + low mastery",
    },
    reteach: {
      label: "Re-teach",
      bg: "#fed7aa",
      fg: "#7c2d12",
      row: "#fff7ed",
      rank: 1,
      help: "Taught but mastery <50% — methods aren't landing",
    },
    building: {
      label: "Building",
      bg: "#fef08a",
      fg: "#713f12",
      row: "#fefce8",
      rank: 2,
      help: "Mid mastery or limited coverage — trending",
    },
    effective: {
      label: "Effective",
      bg: "#bbf7d0",
      fg: "#14532d",
      row: "#f0fdf4",
      rank: 3,
      help: "Mastery ≥70% with ≥3 deliveries — methods working",
    },
  };

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
      // "weak" → sort by effectiveness band, worst first; tiebreak by mastery.
      rows.sort((a, b) => {
        const ra = BAND_META[bandOf(a)].rank;
        const rb = BAND_META[bandOf(b)].rank;
        if (ra !== rb) return ra - rb;
        return (a.masteryPct ?? 101) - (b.masteryPct ?? 101);
      });
    }
    return rows;
  }, [data, filteredBenchmarks, sort]);

  const bandCounts = useMemo(() => {
    const c = { critical: 0, reteach: 0, building: 0, effective: 0 };
    for (const r of filteredBenchmarks) c[bandOf(r)]++;
    return c;
  }, [filteredBenchmarks]);

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
          Benchmark:&nbsp;
          <select
            value={benchmarkCode}
            onChange={(e) => setBenchmarkCode(e.target.value)}
            disabled={benchmarkOptions.length === 0}
            style={{ maxWidth: 320 }}
          >
            <option value="all">All benchmarks</option>
            {benchmarkOptions.map((b) => (
              <option key={b.suffix} value={b.suffix}>
                {b.label}
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
          <div style={{ fontSize: 12, color: "#6b7280", alignSelf: "center" }}>
            School year: {data.schoolYear}
          </div>
        </div>
      )}

      <HowToUseHelp title="How to use Instructional Coverage">
        <HowToSection title="What this report is">
          A schoolwide rollup that combines{" "}
          <strong>what teachers logged teaching</strong> (Instruction Log)
          with <strong>how students performed on FAST</strong> (per-benchmark
          mastery), so coaches and admins can tell whether the instructional
          methods being used are actually moving students.
        </HowToSection>
        <HowToSection title="How to read it day-to-day">
          <ul style={howtoListStyle}>
            <li>
              <strong>Pick a Subject</strong> (and optionally a Grade) to
              scope the catalog.
            </li>
            <li>
              <strong>Scan the effectiveness legend</strong> — the counts
              show how many benchmarks fall in each band right now.
            </li>
            <li>
              <strong>Sort by "Weak + untaught first"</strong> to surface the
              critical and re-teach benchmarks at the top.
            </li>
            <li>
              <strong>Use the Benchmark dropdown</strong> to drill into a
              single standard schoolwide — useful for coaching conversations
              or PLC planning ("everyone struggled on R.2.2, let's plan a
              shared re-teach").
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="What the bands mean">
          <ul style={howtoListStyle}>
            <li>
              <strong style={{ color: BAND_META.critical.fg }}>
                Critical gap
              </strong>{" "}
              — 0 deliveries, or 1 delivery and mastery still under 50%.
              Either nobody's taught it or one touch wasn't enough.
              Action: schedule instruction.
            </li>
            <li>
              <strong style={{ color: BAND_META.reteach.fg }}>
                Re-teach
              </strong>{" "}
              — Taught at least twice, but mastery still under 50%. The
              methods being used <em>aren't landing</em> — coach a
              different strategy, swap materials, or pull MTSS Tier 2.
            </li>
            <li>
              <strong style={{ color: BAND_META.building.fg }}>
                Building
              </strong>{" "}
              — Mid mastery (50–69%) or ≥70% with limited coverage.
              Trending the right direction; keep going.
            </li>
            <li>
              <strong style={{ color: BAND_META.effective.fg }}>
                Effective
              </strong>{" "}
              — Mastery ≥70% with ≥3 deliveries. The methods are working —
              capture what's being done and share with the team.
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="Columns at a glance">
          <ul style={howtoListStyle}>
            <li>
              <strong>Coverage circle</strong> — total schoolwide
              deliveries. Faded purple = no recent activity.
            </li>
            <li>
              <strong>Deliveries</strong> / <strong>Teachers</strong> — how
              many lessons logged, and how many distinct teachers logged
              them.
            </li>
            <li>
              <strong>Last taught</strong> — most recent date any teacher
              logged this benchmark.
            </li>
            <li>
              <strong>Mastery</strong> — % correct on FAST items aligned to
              this benchmark in the most recent PM window. Red &lt;60%,
              amber 60–79%, green ≥80%.
            </li>
            <li>
              <strong>Flag</strong> — the effectiveness band (see above).
            </li>
          </ul>
        </HowToSection>
      </HowToUseHelp>

      {data && filteredBenchmarks.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            background: "#fafafa",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#374151",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Method effectiveness — how many benchmarks fall in each band
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            {(["critical", "reteach", "building", "effective"] as const).map(
              (b) => {
                const meta = BAND_META[b];
                const explanations: Record<typeof b, string> = {
                  critical:
                    "0 deliveries, or 1 delivery + mastery <50%. Not being taught.",
                  reteach:
                    "≥2 deliveries but mastery <50%. Methods aren't landing — try a different strategy.",
                  building:
                    "Mid mastery (50–69%), or ≥70% with limited coverage. Trending right.",
                  effective:
                    "Mastery ≥70% with ≥3 deliveries. Methods are working — keep going.",
                };
                return (
                  <div
                    key={b}
                    style={{
                      background: meta.row,
                      borderLeft: `4px solid ${meta.bg}`,
                      borderRadius: 4,
                      padding: "6px 10px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 2,
                      }}
                    >
                      <span
                        style={{
                          background: meta.bg,
                          color: meta.fg,
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {meta.label}
                      </span>
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: meta.fg,
                        }}
                      >
                        {bandCounts[b]}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "#374151",
                        lineHeight: 1.35,
                      }}
                    >
                      {explanations[b]}
                    </div>
                  </div>
                );
              },
            )}
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
              const band = bandOf(r);
              const meta = BAND_META[band];
              return (
                <tr
                  key={r.code}
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    background: meta.row,
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
                    <span
                      title={meta.help}
                      style={{
                        background: meta.bg,
                        color: meta.fg,
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {meta.label}
                    </span>
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
