// Teacher Roster — per-teacher student list with FAST PM1/PM2/PM3
// pills, level placement, BQ flag, and bucket-icon target gap.
//
// Visibility:
//   - A plain teacher sees only their own roster.
//   - A "core team" member (Admin / SuperUser / ESE / Behavior Specialist
//     / MTSS Coordinator) gets a teacher picker that lists every teacher
//     in their school who has at least one section.
//
// Data shape comes from GET /api/teacher-roster — server-side computes
// placements (PM1/PM2 use current-grade chart; PM3 uses prior-grade
// chart) and the bucket gap (next-level min on current grade − PM3).
// Bucket is intentionally suppressed for grade 3 and for any subject
// without a chart (Algebra 1 / Geometry — not in v1).

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface TeacherOpt {
  id: number;
  displayName: string | null;
}

interface Placement {
  level: 1 | 2 | 3 | 4 | 5;
  subLevel: string;
}

interface Bucket {
  targetScore: number | null;
  gap: number | null;
  color: "green" | "orange" | "red" | null;
}

interface SubjectBlock {
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  pm1Placement: Placement | null;
  pm2Placement: Placement | null;
  pm3Placement: Placement | null;
  bucket: Bucket;
  priorYearScore: number | null;
  priorYearBq: boolean;
  noChart: boolean;
}

interface RosterRow {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string;
  ela: SubjectBlock;
  math: SubjectBlock;
}

interface RosterResponse {
  teacher: { id: number; displayName: string | null };
  availablePeriods: number[];
  selectedPeriod: number | null;
  students: RosterRow[];
}

interface Props {
  isCoreTeam: boolean;
  defaultTeacherId: number | null;
  onBack?: () => void;
}

// Level → background color. Per product preference:
// L1 red, L2 orange, L3 green, L4 blue, L5 purple.
const LEVEL_BG: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#dc2626", // red
  2: "#f59e0b", // orange
  3: "#16a34a", // green
  4: "#2563eb", // blue
  5: "#7c3aed", // purple
};
// All chosen backgrounds are dark enough to take white text legibly.
const LEVEL_FG: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#fff",
  2: "#fff",
  3: "#fff",
  4: "#fff",
  5: "#fff",
};

const BUCKET_COLOR: Record<"green" | "orange" | "red", string> = {
  green: "#16a34a",
  orange: "#f59e0b",
  red: "#dc2626",
};

function ScorePill({
  score,
  placement,
  pmLabel,
}: {
  score: number | null;
  placement: Placement | null;
  pmLabel: string;
}) {
  if (score == null || placement == null) {
    return (
      <span
        title={`${pmLabel}: no score`}
        style={{
          display: "inline-block",
          minWidth: 28,
          padding: "2px 6px",
          borderRadius: 6,
          background: "#e5e7eb",
          color: "#6b7280",
          fontSize: 11,
          textAlign: "center",
        }}
      >
        —
      </span>
    );
  }
  return (
    <span
      title={`${pmLabel} • Level ${placement.subLevel} • Scale score ${score}`}
      style={{
        display: "inline-block",
        minWidth: 36,
        padding: "2px 8px",
        borderRadius: 6,
        background: LEVEL_BG[placement.level],
        color: LEVEL_FG[placement.level],
        fontSize: 11,
        fontWeight: 600,
        textAlign: "center",
      }}
    >
      {placement.subLevel}
    </span>
  );
}

// Pail-shaped SVG bucket — filled with the gap color, with the gap
// number (or check) rendered on top in white. Used in place of the old
// plain circular badge.
function BucketIcon({ bucket }: { bucket: Bucket }) {
  if (bucket.targetScore == null || bucket.color == null) return null;
  const gap = bucket.gap ?? 0;
  const label =
    gap <= 0
      ? `At/above target (target ${bucket.targetScore})`
      : `${gap} pt${gap === 1 ? "" : "s"} to next level (target ${bucket.targetScore})`;
  const fill = BUCKET_COLOR[bucket.color];
  const overlay = gap <= 0 ? "✓" : String(Math.abs(gap));
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        position: "relative",
        display: "inline-block",
        width: 22,
        height: 22,
        lineHeight: 0,
      }}
    >
      <svg
        width={22}
        height={22}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        {/* Handle arc above the rim. */}
        <path
          d="M7 6 C 8.5 3, 15.5 3, 17 6"
          fill="none"
          stroke={fill}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
        {/* Pail body — wider rim, narrower base. */}
        <path
          d="M5.5 7 H 18.5 L 17 20 H 7 Z"
          fill={fill}
          stroke={fill}
          strokeWidth={0.5}
          strokeLinejoin="round"
        />
      </svg>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Nudge the label down a touch so it sits in the body of the
          // pail rather than on top of the handle.
          paddingTop: 4,
          color: "#fff",
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          textShadow: "0 1px 1px rgba(0,0,0,0.35)",
        }}
      >
        {overlay}
      </span>
    </span>
  );
}

// Empty placeholder cell used when the LG column has nothing to render
// (grade 3 / Algebra / Geometry / no chart). Keeps column alignment.
function BucketCell({ bucket }: { bucket: Bucket }) {
  if (bucket.targetScore == null || bucket.color == null) {
    return <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>;
  }
  return <BucketIcon bucket={bucket} />;
}

// Renders four <td>s (PM1 / PM2 / PM3 / LG) so the per-pill column
// headers in the table header line up cleanly above each pill. When the
// subject has no chart for the student's grade (e.g. Math for a 9th
// grader), spans the whole subject group with an "n/a" placeholder.
function SubjectCells({
  block,
  subjectLabel,
}: {
  block: SubjectBlock;
  subjectLabel: string;
}) {
  if (block.noChart) {
    return (
      <td
        colSpan={4}
        style={{ padding: "6px 10px", color: "#9ca3af", fontSize: 12 }}
      >
        n/a
      </td>
    );
  }
  const cell: React.CSSProperties = {
    padding: "6px 6px",
    textAlign: "center",
  };
  return (
    <>
      <td style={cell}>
        <ScorePill
          score={block.pm1}
          placement={block.pm1Placement}
          pmLabel={`${subjectLabel} PM1`}
        />
      </td>
      <td style={cell}>
        <ScorePill
          score={block.pm2}
          placement={block.pm2Placement}
          pmLabel={`${subjectLabel} PM2`}
        />
      </td>
      <td style={cell}>
        <ScorePill
          score={block.pm3}
          placement={block.pm3Placement}
          pmLabel={`${subjectLabel} PM3`}
        />
      </td>
      <td style={cell}>
        <BucketCell bucket={block.bucket} />
      </td>
    </>
  );
}

function BqPills({ row }: { row: RosterRow }) {
  const flags: Array<{ subject: string; score: number | null }> = [];
  if (row.ela.priorYearBq) {
    flags.push({ subject: "ELA", score: row.ela.priorYearScore });
  }
  if (row.math.priorYearBq) {
    flags.push({ subject: "Math", score: row.math.priorYearScore });
  }
  if (flags.length === 0) {
    return <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>;
  }
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {flags.map((f) => (
        <span
          key={f.subject}
          title={`Bottom Quartile in ${f.subject} (prior year final ${
            f.score ?? "?"
          })`}
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 6,
            background: "#7c2d12",
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          BQ {f.subject}
        </span>
      ))}
    </div>
  );
}

export default function TeacherRosterPage({
  isCoreTeam,
  defaultTeacherId,
  onBack,
}: Props) {
  const [teachers, setTeachers] = useState<TeacherOpt[]>([]);
  const [teacherId, setTeacherId] = useState<number | null>(
    defaultTeacherId,
  );
  const [period, setPeriod] = useState<number | null>(null);
  const [data, setData] = useState<RosterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Load teacher options on mount (the API decides what to return based
  // on the caller's role — plain teachers get a single-entry list).
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/teacher-roster/teachers")
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load teachers");
        return r.json();
      })
      .then((j: { teachers: TeacherOpt[] }) => {
        if (cancelled) return;
        setTeachers(j.teachers);
        // Pre-select the user's own row if no default came in.
        if (teacherId == null && j.teachers.length > 0) {
          setTeacherId(j.teachers[0].id);
        }
      })
      .catch(() => {
        // Non-fatal — picker just stays empty.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload roster when teacher or period changes.
  useEffect(() => {
    if (teacherId == null) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    params.set("teacherId", String(teacherId));
    if (period != null) params.set("period", String(period));
    authFetch(`/api/teacher-roster?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to load roster");
        }
        return r.json();
      })
      .then((j: RosterResponse) => {
        if (cancelled) return;
        setData(j);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teacherId, period]);

  const periodOptions = data?.availablePeriods ?? [];

  // Reset period when switching teachers if the new teacher doesn't
  // teach the previously-selected period.
  useEffect(() => {
    if (period != null && periodOptions.length > 0 && !periodOptions.includes(period)) {
      setPeriod(null);
    }
  }, [periodOptions, period]);

  const summary = useMemo(() => {
    if (!data) return null;
    const total = data.students.length;
    const elaBq = data.students.filter((s) => s.ela.priorYearBq).length;
    const mathBq = data.students.filter((s) => s.math.priorYearBq).length;
    return { total, elaBq, mathBq };
  }, [data]);

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {onBack && (
            <button onClick={onBack} style={{ padding: "4px 10px" }}>
              ← Back
            </button>
          )}
          <h2 style={{ margin: 0 }}>Teacher Roster</h2>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {isCoreTeam && teachers.length > 1 && (
            <label style={{ fontSize: 13 }}>
              Teacher:&nbsp;
              <select
                value={teacherId ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setTeacherId(v ? Number(v) : null);
                  setPeriod(null);
                }}
              >
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName ?? `Staff #${t.id}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {/* Period selector — chip row */}
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13, color: "#6b7280" }}>Period:</span>
        <button
          onClick={() => setPeriod(null)}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: period == null ? "#1f2937" : "#fff",
            color: period == null ? "#fff" : "#1f2937",
            cursor: "pointer",
          }}
        >
          All
        </button>
        {periodOptions.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              background: period === p ? "#1f2937" : "#fff",
              color: period === p ? "#fff" : "#1f2937",
              cursor: "pointer",
            }}
          >
            P{p}
          </button>
        ))}
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 8,
          fontSize: 12,
          color: "#374151",
        }}
      >
        <span>Pills: PM1 / PM2 / PM3 (sub-level on current chart; PM3 on prior-grade chart)</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          LG (learning-gain bucket) =
          <BucketIcon
            bucket={{ targetScore: 0, gap: 0, color: "green" }}
          />
          at/above
          <BucketIcon
            bucket={{ targetScore: 0, gap: 3, color: "orange" }}
          />
          1–5
          <BucketIcon
            bucket={{ targetScore: 0, gap: 9, color: "red" }}
          />
          &gt; 5 pts to next level
        </span>
        <span>BQ = Bottom Quartile (prior-year final scale score)</span>
      </div>

      {summary && (
        <div style={{ fontSize: 13, color: "#374151", marginBottom: 12 }}>
          {summary.total} student{summary.total === 1 ? "" : "s"} •{" "}
          {summary.elaBq} ELA BQ • {summary.mathBq} Math BQ
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 8,
            background: "#fee2e2",
            color: "#7f1d1d",
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {loading && <div>Loading roster…</div>}

      {!loading && data && data.students.length === 0 && (
        <div style={{ color: "#6b7280" }}>
          No students on the roster
          {period != null ? ` for period ${period}` : ""}.
        </div>
      )}

      {!loading && data && data.students.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              borderCollapse: "collapse",
              width: "100%",
              fontSize: 13,
            }}
          >
            <thead>
              {/* Top row groups the four PM/LG sub-columns under their
                  subject label. The right vertical border on ELA's
                  group separates it from Math visually. */}
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <th rowSpan={2} style={{ padding: "8px 10px", verticalAlign: "bottom" }}>
                  Student
                </th>
                <th rowSpan={2} style={{ padding: "8px 10px", verticalAlign: "bottom" }}>
                  Grade
                </th>
                <th
                  colSpan={4}
                  style={{
                    padding: "8px 10px",
                    textAlign: "center",
                    borderRight: "1px solid #e5e7eb",
                  }}
                >
                  ELA
                </th>
                <th
                  colSpan={4}
                  style={{ padding: "8px 10px", textAlign: "center" }}
                >
                  Math
                </th>
                <th rowSpan={2} style={{ padding: "8px 10px", verticalAlign: "bottom" }}>
                  BQ
                </th>
              </tr>
              <tr
                style={{
                  background: "#f3f4f6",
                  textAlign: "center",
                  fontSize: 11,
                  color: "#4b5563",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                <th style={{ padding: "4px 6px", fontWeight: 600 }}>PM1</th>
                <th style={{ padding: "4px 6px", fontWeight: 600 }}>PM2</th>
                <th style={{ padding: "4px 6px", fontWeight: 600 }}>PM3</th>
                <th
                  style={{
                    padding: "4px 6px",
                    fontWeight: 600,
                    borderRight: "1px solid #e5e7eb",
                  }}
                >
                  LG
                </th>
                <th style={{ padding: "4px 6px", fontWeight: 600 }}>PM1</th>
                <th style={{ padding: "4px 6px", fontWeight: 600 }}>PM2</th>
                <th style={{ padding: "4px 6px", fontWeight: 600 }}>PM3</th>
                <th style={{ padding: "4px 6px", fontWeight: 600 }}>LG</th>
              </tr>
            </thead>
            <tbody>
              {data.students.map((row) => (
                <tr
                  key={row.studentId}
                  style={{ borderTop: "1px solid #e5e7eb" }}
                >
                  <td style={{ padding: "6px 10px" }}>
                    {row.lastName}, {row.firstName}
                  </td>
                  <td style={{ padding: "6px 10px" }}>{row.grade}</td>
                  <SubjectCells block={row.ela} subjectLabel="ELA" />
                  <SubjectCells block={row.math} subjectLabel="Math" />
                  <td style={{ padding: "6px 10px" }}>
                    <BqPills row={row} />
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
