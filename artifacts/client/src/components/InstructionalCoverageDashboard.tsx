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

interface TeacherDrill {
  teacherStaffId: number;
  name: string;
  grades: string[];
  rosterStudents: number;
  codes: string[];
  deliveries: number;
  lastTaughtOn: string | null;
  masteryPct: number | null;
  studentsAssessed: number;
}

interface DrillResp {
  subject: string;
  codes: string[];
  category: string | null;
  label: string | null;
  schoolYear: string;
  teachers: TeacherDrill[];
}

// ─────────────────────────────────────────────────────────────────────────
// Effectiveness band — the SINGLE source of truth shared by the schoolwide
// row flag and the per-teacher drawer flag. Both surfaces call
// `computeCoverageBand`; the only difference is what's fed in — the row
// passes the schoolwide aggregate (totalDeliveries + rolled-up mastery),
// the drawer passes one teacher's own numbers. Keeping ONE function means
// the two can never drift apart again.
//
// The ladder deliberately separates two dimensions that used to be mashed
// together:
//   • COVERAGE  — was it taught at all? (the first rung is pure coverage)
//   • MASTERY   — when taught, did students get it? (method effectiveness)
// "Method effectiveness" only has meaning once BOTH a delivery and a
// mastery signal exist, so:
//   - 0 deliveries        → Critical gap  (not taught — nothing to judge)
//   - taught, no FAST data → No signal yet (can't judge effectiveness)
//   - mastery < 50%        → Re-teach     (taught but not landing; any count)
//   - mastery ≥ 70% & ≥2×  → Effective
//   - otherwise            → Building     (mid mastery, or strong but thin)
// Crucially, more deliveries never make a teacher LESS urgent.
export type CoverageBand =
  | "critical"
  | "reteach"
  | "nosignal"
  | "building"
  | "effective";

const EFFECTIVE_MIN_DELIVERIES = 2;

function computeCoverageBand(
  deliveries: number,
  masteryPct: number | null,
): CoverageBand {
  if (deliveries === 0) return "critical";
  if (masteryPct === null) return "nosignal";
  if (masteryPct < 50) return "reteach";
  if (masteryPct >= 70 && deliveries >= EFFECTIVE_MIN_DELIVERIES)
    return "effective";
  return "building";
}

const COVERAGE_BAND_META: Record<
  CoverageBand,
  { label: string; bg: string; fg: string; row: string; rank: number; help: string }
> = {
  critical: {
    label: "Critical gap",
    bg: "#fecaca",
    fg: "#7f1d1d",
    row: "#fef2f2",
    rank: 0,
    help: "Not taught yet (0 deliveries). There's no method to evaluate — this is a coverage gap, not a failed method. Action: schedule instruction.",
  },
  reteach: {
    label: "Re-teach",
    bg: "#fed7aa",
    fg: "#7c2d12",
    row: "#fff7ed",
    rank: 1,
    help: "Taught but mastery <50% (even a single lesson counts). The method isn't landing — coach a different strategy, swap materials, or pull MTSS Tier 2.",
  },
  nosignal: {
    label: "No signal yet",
    bg: "#e2e8f0",
    fg: "#334155",
    row: "#f8fafc",
    rank: 2,
    help: "Taught, but no FAST mastery data yet — effectiveness can't be judged. Action: collect or confirm assessment evidence.",
  },
  building: {
    label: "Building",
    bg: "#fef08a",
    fg: "#713f12",
    row: "#fefce8",
    rank: 3,
    help: "Mid mastery (50–69%), or ≥70% with only one delivery. Trending the right direction — keep going.",
  },
  effective: {
    label: "Effective",
    bg: "#bbf7d0",
    fg: "#14532d",
    row: "#f0fdf4",
    rank: 4,
    help: "Mastery ≥70% with ≥2 deliveries. The methods are working — capture what's being done and share with the team.",
  },
};

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
  // Row-click drilldown: which benchmark row the user clicked into.
  // `key` is what we display in the drawer header (suffix when the row
  // came from a grouped pick, exact code otherwise). `query` is what we
  // send to the API.
  const [drill, setDrill] = useState<{
    key: string;
    label: string | null;
    category: string | null;
    query: { code?: string; suffix?: string };
  } | null>(null);
  const [drillData, setDrillData] = useState<DrillResp | null>(null);
  const [drillLoading, setDrillLoading] = useState<boolean>(false);
  const [drillErr, setDrillErr] = useState<string | null>(null);

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

  // Load the per-teacher drilldown whenever the user picks a row.
  useEffect(() => {
    if (!drill) {
      setDrillData(null);
      setDrillErr(null);
      return;
    }
    let cancelled = false;
    setDrillLoading(true);
    setDrillErr(null);
    setDrillData(null);
    const params = new URLSearchParams({ subject });
    if (drill.query.code) params.set("code", drill.query.code);
    if (drill.query.suffix) params.set("suffix", drill.query.suffix);
    authFetch(
      `/api/insights/instructional-coverage/benchmark?${params.toString()}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<DrillResp>;
      })
      .then((d) => {
        if (cancelled) return;
        setDrillData(d);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setDrillErr(e.message);
      })
      .finally(() => {
        if (cancelled) return;
        setDrillLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drill, subject]);

  // Close the drawer when subject changes — the open benchmark may not
  // exist in the new subject.
  useEffect(() => {
    setDrill(null);
  }, [subject]);

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

  // Schoolwide row flag — reuses the shared band engine (see
  // `computeCoverageBand`), fed the benchmark's aggregate numbers. The
  // per-teacher drawer uses the SAME engine so the two never diverge.
  type Band = CoverageBand;
  const bandOf = (r: Row): Band =>
    computeCoverageBand(r.totalDeliveries, r.masteryPct);
  const BAND_META = COVERAGE_BAND_META;

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
    const c: Record<Band, number> = {
      critical: 0,
      reteach: 0,
      nosignal: 0,
      building: 0,
      effective: 0,
    };
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
          <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "#374151" }}>
            The flag reads two separate things: <strong>coverage</strong> (was
            it taught?) and <strong>method effectiveness</strong> (when taught,
            did students master it?). Effectiveness can only be judged once
            there's both a delivery <em>and</em> a mastery signal — so the first
            rung is purely about coverage, not a verdict on the teaching.
          </p>
          <ul style={howtoListStyle}>
            <li>
              <strong style={{ color: BAND_META.critical.fg }}>
                Critical gap
              </strong>{" "}
              — <em>Coverage gap.</em> 0 deliveries — nobody has taught it, so
              there's no method to evaluate yet. Action: schedule instruction.
            </li>
            <li>
              <strong style={{ color: BAND_META.reteach.fg }}>
                Re-teach
              </strong>{" "}
              — Taught but mastery still under 50% (<em>even a single
              lesson</em> counts — more attempts never make it less urgent).
              The methods being used <em>aren't landing</em> — coach a
              different strategy, swap materials, or pull MTSS Tier 2.
            </li>
            <li>
              <strong style={{ color: BAND_META.nosignal.fg }}>
                No signal yet
              </strong>{" "}
              — Taught, but there's no FAST mastery data behind it yet, so
              effectiveness can't be judged. Action: collect or confirm
              assessment evidence before drawing a conclusion.
            </li>
            <li>
              <strong style={{ color: BAND_META.building.fg }}>
                Building
              </strong>{" "}
              — Mid mastery (50–69%), or ≥70% with only one delivery.
              Trending the right direction; keep going.
            </li>
            <li>
              <strong style={{ color: BAND_META.effective.fg }}>
                Effective
              </strong>{" "}
              — Mastery ≥70% with ≥2 deliveries. The methods are working —
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
            {(
              [
                "critical",
                "reteach",
                "nosignal",
                "building",
                "effective",
              ] as const
            ).map(
              (b) => {
                const meta = BAND_META[b];
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
                      {meta.help}
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
              const isOpen = drill?.query.code === r.code;
              return (
                <tr
                  key={r.code}
                  onClick={() =>
                    setDrill({
                      key: r.code,
                      label: r.label,
                      category: r.category,
                      query: { code: r.code },
                    })
                  }
                  title="Click to see per-teacher breakdown"
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    background: isOpen ? "#dbeafe" : meta.row,
                    cursor: "pointer",
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

      {drill && (
        <BenchmarkDrillDrawer
          benchmarkKey={drill.key}
          label={drill.label}
          category={drill.category}
          loading={drillLoading}
          err={drillErr}
          data={drillData}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// Slide-over drawer that shows the per-teacher breakdown for one
// benchmark. Pure presentation — the parent owns the fetch lifecycle.
// Effectiveness bands here mirror the row pill in the main table so a
// coach can scan "who's in the red" at a glance.
function BenchmarkDrillDrawer({
  benchmarkKey,
  label,
  category,
  loading,
  err,
  data,
  onClose,
}: {
  benchmarkKey: string;
  label: string | null;
  category: string | null;
  loading: boolean;
  err: string | null;
  data: DrillResp | null;
  onClose: () => void;
}) {
  // Per-teacher flag — the SAME shared band engine the schoolwide row
  // uses (`computeCoverageBand`), just fed one teacher's own deliveries +
  // mastery instead of the aggregate. This is the "separated by teacher"
  // application of the single source of truth, so the drawer pill and the
  // row pill can't drift apart.
  const teacherBand = (t: TeacherDrill): CoverageBand =>
    computeCoverageBand(t.deliveries, t.masteryPct);
  const BAND = COVERAGE_BAND_META;
  const sortedTeachers = data
    ? [...data.teachers].sort(
        (a, b) =>
          BAND[teacherBand(a)].rank - BAND[teacherBand(b)].rank ||
          (a.masteryPct ?? 101) - (b.masteryPct ?? 101) ||
          a.name.localeCompare(b.name),
      )
    : [];

  // Roll-up across teachers for the drawer's top stat strip.
  const totals = data
    ? data.teachers.reduce(
        (acc, t) => {
          acc.deliveries += t.deliveries;
          acc.teachers += 1;
          if (t.deliveries > 0) acc.taught += 1;
          if (t.lastTaughtOn) {
            if (!acc.lastTaughtOn || t.lastTaughtOn > acc.lastTaughtOn) {
              acc.lastTaughtOn = t.lastTaughtOn;
            }
          }
          return acc;
        },
        {
          deliveries: 0,
          teachers: 0,
          taught: 0,
          lastTaughtOn: null as string | null,
        },
      )
    : null;

  return (
    <>
      {/* backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.4)",
          zIndex: 40,
        }}
      />
      <aside
        role="dialog"
        aria-label={`Per-teacher breakdown for ${benchmarkKey}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(640px, 92vw)",
          background: "white",
          boxShadow: "-12px 0 24px rgba(15, 23, 42, 0.15)",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
          fontSize: 13,
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 16,
                fontWeight: 700,
                color: "#0f172a",
              }}
            >
              {benchmarkKey}
              {data && data.codes.length > 1 && (
                <span
                  style={{
                    marginLeft: 8,
                    fontFamily: "inherit",
                    fontSize: 11,
                    color: "#64748b",
                    fontWeight: 500,
                  }}
                >
                  spans {data.codes.length} grade
                  {data.codes.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {label && (
              <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
                {label}
              </div>
            )}
            {category && (
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                {category}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "1px solid #cbd5e1",
              background: "white",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontWeight: 600,
              color: "#0f172a",
            }}
          >
            Close
          </button>
        </header>

        <div style={{ padding: "12px 18px", overflowY: "auto", flex: 1 }}>
          {loading && (
            <div style={{ color: "#64748b" }}>Loading per-teacher data…</div>
          )}
          {err && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                padding: "8px 12px",
                borderRadius: 6,
              }}
            >
              {err}
            </div>
          )}
          {!loading && !err && data && totals && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                  gap: 8,
                  marginBottom: 14,
                }}
              >
                <DrillStat label="Teachers" value={totals.teachers} />
                <DrillStat
                  label="Logged ≥1 time"
                  value={`${totals.taught} / ${totals.teachers}`}
                />
                <DrillStat label="Total deliveries" value={totals.deliveries} />
                <DrillStat
                  label="Last taught"
                  value={totals.lastTaughtOn ?? "—"}
                />
              </div>

              {data.teachers.length === 0 ? (
                <div style={{ color: "#64748b" }}>
                  No teachers on roster are responsible for this benchmark's
                  grade level.
                </div>
              ) : (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12.5,
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        background: "#f8fafc",
                        textAlign: "left",
                        borderBottom: "1px solid #e2e8f0",
                      }}
                    >
                      <th style={{ padding: "6px 8px" }}>Teacher</th>
                      <th
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          width: 80,
                        }}
                      >
                        Lessons
                      </th>
                      <th
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          width: 90,
                        }}
                      >
                        Mastery
                      </th>
                      <th style={{ padding: "6px 8px", width: 100 }}>
                        Last taught
                      </th>
                      <th style={{ padding: "6px 8px", width: 110 }}>Flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTeachers.map((t) => {
                      const b = teacherBand(t);
                      const meta = BAND[b];
                      return (
                        <tr
                          key={t.teacherStaffId}
                          style={{ borderBottom: "1px solid #f1f5f9" }}
                        >
                          <td style={{ padding: "8px 8px" }}>
                            <div style={{ fontWeight: 600, color: "#0f172a" }}>
                              {t.name}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: "#64748b",
                                marginTop: 2,
                              }}
                            >
                              {t.grades.length > 0
                                ? t.grades
                                    .map((g) => (g === "K" ? "K" : `G${g}`))
                                    .join(" · ")
                                : "—"}
                              {t.rosterStudents > 0 && (
                                <>
                                  {" · "}
                                  {t.rosterStudents} student
                                  {t.rosterStudents === 1 ? "" : "s"}
                                </>
                              )}
                              {t.studentsAssessed > 0 && (
                                <>
                                  {" · "}
                                  {t.studentsAssessed} assessed
                                </>
                              )}
                            </div>
                          </td>
                          <td
                            style={{
                              padding: "8px 8px",
                              textAlign: "right",
                              fontWeight: 600,
                              color:
                                t.deliveries === 0 ? "#b91c1c" : "#0f172a",
                            }}
                          >
                            {t.deliveries}
                          </td>
                          <td
                            style={{
                              padding: "8px 8px",
                              textAlign: "right",
                              fontWeight: 600,
                              color:
                                t.masteryPct === null
                                  ? "#9ca3af"
                                  : t.masteryPct < 60
                                    ? "#b91c1c"
                                    : t.masteryPct < 80
                                      ? "#92400e"
                                      : "#047857",
                            }}
                          >
                            {t.masteryPct === null
                              ? "—"
                              : `${t.masteryPct}%`}
                          </td>
                          <td
                            style={{
                              padding: "8px 8px",
                              color: t.lastTaughtOn ? "#0f172a" : "#9ca3af",
                              fontSize: 11.5,
                            }}
                          >
                            {t.lastTaughtOn ?? "Never"}
                          </td>
                          <td style={{ padding: "8px 8px" }}>
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

              <div
                style={{
                  marginTop: 14,
                  fontSize: 11,
                  color: "#64748b",
                  lineHeight: 1.4,
                }}
              >
                Mastery = % correct on this benchmark's FAST items for kids
                on that teacher's roster, current school year ({data.schoolYear}
                ). Flags (same logic as the schoolwide row):{" "}
                <strong>Critical gap</strong> = never taught (coverage gap, no
                method to judge); <strong>Re-teach</strong> = taught but mastery
                &lt; 50% (even a single lesson);{" "}
                <strong>No signal yet</strong> = taught, no FAST data to judge;{" "}
                <strong>Effective</strong> = mastery ≥ 70% with ≥ 2 deliveries;{" "}
                <strong>Building</strong> = everything else.
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function DrillStat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        background: "#f8fafc",
        borderRadius: 6,
        padding: "6px 10px",
      }}
    >
      <div style={{ fontSize: 10.5, color: "#64748b", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
        {value}
      </div>
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
