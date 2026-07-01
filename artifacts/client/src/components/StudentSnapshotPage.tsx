// =============================================================================
// Student Snapshot — visual single-student "whole-child" report
// =============================================================================
// A search-first report that renders one student's metrics from the shared
// engine (server: /api/exports/snapshot/:studentId) against their grade cohort:
//   * a 4-pillar radar (oriented so a bigger shape = healthier) vs the cohort
//     median (the 50th-percentile reference ring),
//   * per-metric peer bars (percentile + the student's value vs cohort mean),
//   * a distribution strip per metric (cohort spread with the student marked),
//   * supports (active MTSS tiers) + academics (FAST PM trajectory).
// Sections follow the "mindset for learning" arc: Shows Up -> Stays in Room ->
// Engages -> Achieves, then Supports.
//
// NO FLEID forward-facing: search + the report only render localSisId; the
// canonical studentId is the lookup key only. Cohort comparison is suppressed
// when the grade has fewer than the server's min cohort size.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";
import StudentPicker from "./StudentPicker";
import {
  FastScorePill,
  PillViewContext,
  PillViewToggle,
  type PillView,
  type PillMarker,
} from "./FastScorePill";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface SearchHit {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
}

type Pillar = "shows_up" | "stays" | "engages" | "achieves";

interface MetricCmp {
  key: string;
  label: string;
  direction: "higher_better" | "higher_worse";
  pillar: Pillar;
  value: number | null;
  mean: number | null;
  percentile: number | null;
  n: number;
  suppressed: boolean;
  orientedPercentile: number | null;
  distribution: number[];
}

interface RawMetrics {
  daysAbsent: number | null;
  attendancePct: number | null;
  tardies: number;
  hallPassCount: number;
  hallPassMinutes: number;
  lostInstructionMinutes: number;
  pulloutCount: number;
  pulloutMinutes: number;
  ossServedDays: number;
  issServedDays: number;
  pbisPositivePoints: number;
  pbisNegativePoints: number;
  pbisNetPoints: number;
  mtssT2Active: boolean;
  mtssT3AcademicActive: boolean;
  mtssT3BehaviorActive: boolean;
  fastElaPm1: number | null;
  fastElaPm2: number | null;
  fastElaPm3: number | null;
  fastMathPm1: number | null;
  fastMathPm2: number | null;
  fastMathPm3: number | null;
  currentGrades: {
    courseCode: string;
    courseDesc: string | null;
    teacherName: string | null;
    gradeLevel: string | null;
    grade: number | null;
    quarter: string;
  }[];
  gpa: number | null;
  gpaEnabled: boolean;
}

type FastPlacement = { level: 1 | 2 | 3 | 4 | 5; subLevel: string } | null;

// Teacher-Roster-parity FAST view for one subject (server: lib/fastParity.ts).
interface FastRow {
  subject: "ela" | "math";
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  priorYearScore: number | null;
  priorYearBq: boolean;
  levels: {
    priorYearScore: FastPlacement;
    pm1: FastPlacement;
    pm2: FastPlacement;
    pm3: FastPlacement;
  };
  learningGain: boolean | null;
  ptsToNextLevel: number | null;
  ptsToProficient: number | null;
}

interface Snapshot {
  student: {
    localSisId: string | null;
    firstName: string;
    lastName: string;
    grade: number | null;
    gender: string | null;
    ell: boolean | null;
    ese: boolean | null;
    is504: boolean | null;
  };
  range: { from: string | null; to: string | null };
  cohort: {
    grade: number | null;
    label: string;
    n: number;
    minCohort: number;
    suppressed: boolean;
  };
  metrics: MetricCmp[];
  radar: { pillar: Pillar; label: string; studentScore: number | null; suppressed: boolean }[];
  rawMetrics: RawMetrics;
  fast: FastRow[];
}

interface Props {
  initialStudentId?: string | null;
  initialStudentLabel?: string | null;
  onBack?: () => void;
}

const PILLAR_ORDER: { pillar: Pillar; title: string; blurb: string }[] = [
  { pillar: "shows_up", title: "Shows Up", blurb: "Attendance, absences, and tardies." },
  { pillar: "stays", title: "Stays in the Room", blurb: "Lost instruction, hall passes, and behavior pullouts." },
  { pillar: "engages", title: "Engages", blurb: "Discipline (OSS/ISS) and PBIS recognition." },
  { pillar: "achieves", title: "Achieves", blurb: "FAST progress monitoring." },
];

function gradeLabel(grade: number): string {
  if (grade === 0) return "K";
  return `Grade ${grade}`;
}

// Color a metric by how the student sits vs peers (oriented so higher = better).
function tone(m: MetricCmp): string {
  if (m.suppressed || m.orientedPercentile == null) return "#9ca3af";
  if (m.orientedPercentile >= 66) return "#16a34a";
  if (m.orientedPercentile >= 33) return "#d97706";
  return "#dc2626";
}

function fmt(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

export default function StudentSnapshotPage({
  initialStudentId,
  initialStudentLabel,
  onBack,
}: Props) {
  const [studentId, setStudentId] = useState<string | null>(
    initialStudentId ?? null,
  );
  const [studentLabel, setStudentLabel] = useState<string | null>(
    initialStudentLabel ?? null,
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fastPillView, setFastPillView] = useState<PillView>("level");

  const fetchHits = async (q: string): Promise<SearchHit[]> => {
    const r = await authFetch(
      `/api/student-lookup/search?q=${encodeURIComponent(q)}`,
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body?.error || "Search failed");
    }
    const data = (await r.json()) as { students: SearchHit[] };
    return data.students ?? [];
  };

  const load = useCallback(
    async (sid: string, f: string, t: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (f) params.set("from", f);
        if (t) params.set("to", t);
        const qs = params.toString();
        const r = await authFetch(
          `/api/exports/snapshot/${encodeURIComponent(sid)}${qs ? `?${qs}` : ""}`,
        );
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error || "Could not load snapshot");
        }
        setSnapshot((await r.json()) as Snapshot);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load snapshot");
        setSnapshot(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (studentId) void load(studentId, from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  function pickStudent(hit: SearchHit) {
    setStudentId(hit.studentId);
    setStudentLabel(`${hit.lastName}, ${hit.firstName}`);
    setSnapshot(null);
  }

  function applyRange() {
    if (studentId) void load(studentId, from, to);
  }
  function resetRange() {
    setFrom("");
    setTo("");
    if (studentId) void load(studentId, "", "");
  }

  // ----- Search screen (no student chosen yet) -----
  if (!studentId) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Student Snapshot</h2>
            <p style={{ margin: "4px 0 0", color: "var(--muted)" }}>
              A visual whole-child report comparing one student to their grade
              cohort.
            </p>
          </div>
          {onBack && (
            <button className="btn-secondary" onClick={onBack}>
              ← Back
            </button>
          )}
        </div>
        <StudentPicker
          mode="async"
          fetcher={fetchHits}
          debounceMs={250}
          onSelect={pickStudent}
          getKey={(hit) => hit.studentId}
          getPrimary={(hit) => `${hit.lastName}, ${hit.firstName}`}
          renderMeta={(hit) =>
            `${gradeLabel(hit.grade)} · ID ${hit.localSisId ?? "—"}`
          }
          placeholder="Search by first name, last name, or SIS ID…"
          emptyText="No students found. Teachers can only look up students on their own roster."
          autoFocus
          clearable={false}
          minWidth="100%"
          style={{ display: "block" }}
          inputStyle={{
            padding: "12px 14px",
            fontSize: 16,
            borderRadius: 10,
            border: "1px solid var(--border)",
            boxSizing: "border-box",
          }}
        />
      </div>
    );
  }

  const radarData =
    snapshot?.radar.map((r) => ({
      pillar: r.label,
      You: r.studentScore,
      Cohort: 50,
    })) ?? [];

  const byPillar = (p: Pillar): MetricCmp[] =>
    snapshot?.metrics.filter((m) => m.pillar === p) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Header / identity + controls */}
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <div>
            <button
              className="btn-secondary"
              onClick={() => {
                setStudentId(null);
                setStudentLabel(null);
                setSnapshot(null);
              }}
              style={{ marginBottom: 8 }}
            >
              ← Choose another student
            </button>
            <h2 style={{ margin: 0 }}>
              {snapshot
                ? `${snapshot.student.lastName}, ${snapshot.student.firstName}`
                : (studentLabel ?? "Student Snapshot")}
            </h2>
            <div style={{ color: "var(--muted)", marginTop: 4 }}>
              {snapshot && (
                <>
                  {snapshot.student.grade != null
                    ? gradeLabel(snapshot.student.grade)
                    : "Grade —"}
                  {" · "}
                  ID {snapshot.student.localSisId ?? "—"}
                </>
              )}
            </div>
            {snapshot && (
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {snapshot.student.ell && <Chip>ELL</Chip>}
                {snapshot.student.ese && <Chip>ESE</Chip>}
                {snapshot.student.is504 && <Chip>504</Chip>}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <label style={{ display: "block", fontSize: 12, marginBottom: 2 }}>
                From
              </label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, marginBottom: 2 }}>
                To
              </label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <button onClick={applyRange} disabled={loading}>
              Apply
            </button>
            <button className="btn-secondary" onClick={resetRange} disabled={loading}>
              Reset to YTD
            </button>
          </div>
        </div>

        {snapshot && (
          <p style={{ marginBottom: 0, marginTop: 12, color: "var(--muted)", fontSize: 13 }}>
            Comparing to <strong>{snapshot.cohort.label}</strong> ({snapshot.cohort.n}{" "}
            students). Event metrics cover{" "}
            {snapshot.range.from ?? "the start of records"} →{" "}
            {snapshot.range.to ?? "today"}. Attendance reflects the latest
            semester upload; MTSS &amp; FAST are current.
            {snapshot.cohort.suppressed && (
              <>
                {" "}
                <span style={{ color: "#d97706" }}>
                  Cohort under {snapshot.cohort.minCohort} — peer comparisons are
                  hidden.
                </span>
              </>
            )}
          </p>
        )}
      </div>

      {error && (
        <div className="card" style={{ borderColor: "#e11d48", color: "#e11d48" }}>
          {error}
        </div>
      )}
      {loading && <div className="card">Loading snapshot…</div>}

      {snapshot && !loading && (
        <>
          {/* Radar */}
          <div className="card">
            <h3 style={{ marginTop: 0 }}>At a glance</h3>
            <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13 }}>
              Each spoke is the student's standing across that pillar (0–100,
              higher is healthier). The shaded ring is the cohort median.
            </p>
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer>
                <RadarChart data={radarData} outerRadius="72%">
                  <PolarGrid />
                  <PolarAngleAxis dataKey="pillar" />
                  <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                  <Radar
                    name="Cohort median"
                    dataKey="Cohort"
                    stroke="#94a3b8"
                    fill="#94a3b8"
                    fillOpacity={0.25}
                  />
                  <Radar
                    name="This student"
                    dataKey="You"
                    stroke="#2563eb"
                    fill="#2563eb"
                    fillOpacity={0.45}
                  />
                  <Legend />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Pillar sections with peer bars + distribution */}
          {PILLAR_ORDER.map(({ pillar, title, blurb }) => {
            const metrics = byPillar(pillar);
            if (metrics.length === 0) return null;
            return (
              <div className="card" key={pillar}>
                <h3 style={{ marginTop: 0 }}>{title}</h3>
                <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13 }}>
                  {blurb}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {metrics.map((m) => (
                    <MetricRow key={m.key} m={m} />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Supports */}
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Is Supported</h3>
            <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13 }}>
              Active MTSS intervention plans (current, not date-bound).
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <SupportChip active={snapshot.rawMetrics.mtssT2Active} label="Tier 2" />
              <SupportChip
                active={snapshot.rawMetrics.mtssT3AcademicActive}
                label="Tier 3 — Academic"
              />
              <SupportChip
                active={snapshot.rawMetrics.mtssT3BehaviorActive}
                label="Tier 3 — Behavior"
              />
              {!snapshot.rawMetrics.mtssT2Active &&
                !snapshot.rawMetrics.mtssT3AcademicActive &&
                !snapshot.rawMetrics.mtssT3BehaviorActive && (
                  <span style={{ color: "var(--muted)" }}>
                    No active intervention plans.
                  </span>
                )}
            </div>
          </div>

          {/* Academics — current grades + GPA */}
          {snapshot.rawMetrics.currentGrades.length > 0 && (
            <div className="card">
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <h3 style={{ marginTop: 0 }}>Current Grades</h3>
                {snapshot.rawMetrics.gpaEnabled &&
                  snapshot.rawMetrics.gpa != null && (
                    <div style={{ fontSize: 14 }}>
                      GPA{" "}
                      <span style={{ fontWeight: 700 }}>
                        {snapshot.rawMetrics.gpa.toFixed(2)}
                      </span>
                    </div>
                  )}
              </div>
              <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13 }}>
                Current grade per course (latest reported quarter).
                {snapshot.rawMetrics.gpaEnabled
                  ? " Unweighted 4.0 GPA across the current semester's graded courses."
                  : ""}
              </p>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                }}
              >
                <thead>
                  <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                    <th style={{ padding: "4px 8px" }}>Course</th>
                    <th style={{ padding: "4px 8px" }}>Teacher</th>
                    <th style={{ padding: "4px 8px", textAlign: "right" }}>
                      Grade
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.rawMetrics.currentGrades.map((g, i) => (
                    <tr
                      key={`${g.courseCode}-${i}`}
                      style={{ borderTop: "1px solid var(--border)" }}
                    >
                      <td style={{ padding: "4px 8px" }}>
                        {g.courseDesc || g.courseCode}
                      </td>
                      <td style={{ padding: "4px 8px" }}>
                        {g.teacherName || "—"}
                      </td>
                      <td
                        style={{
                          padding: "4px 8px",
                          textAlign: "right",
                          fontWeight: 600,
                        }}
                      >
                        {g.grade != null ? `${g.grade} (${g.quarter})` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Academics — FAST progress monitoring (Teacher-Roster parity) */}
          <div className="card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <h3 style={{ margin: 0 }}>FAST Progress Monitoring</h3>
              <PillViewToggle value={fastPillView} onChange={setFastPillView} />
            </div>
            <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 13 }}>
              Achievement-level trajectory across the PM windows (current year).
              Click any pill to flip level ↔ scale score.
            </p>
            <PillViewContext.Provider value={fastPillView}>
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginTop: 12 }}>
                {snapshot.fast.map((row) => (
                  <PmTrajectory key={row.subject} row={row} />
                ))}
              </div>
            </PillViewContext.Provider>
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        background: "var(--border)",
        color: "var(--text)",
      }}
    >
      {children}
    </span>
  );
}

function SupportChip({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 13,
        fontWeight: 600,
        padding: "4px 10px",
        borderRadius: 8,
        background: active ? "#fef3c7" : "var(--border)",
        color: active ? "#92400e" : "var(--muted)",
        border: active ? "1px solid #f59e0b" : "1px solid transparent",
      }}
    >
      {active ? "● " : "○ "}
      {label}
    </span>
  );
}

function MetricRow({ m }: { m: MetricCmp }) {
  const color = tone(m);
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span style={{ fontWeight: 600 }}>{m.label}</span>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>
          {m.suppressed ? (
            <em>Cohort too small (n &lt; 10)</em>
          ) : (
            <>
              <strong style={{ color }}>{fmt(m.value)}</strong> · cohort avg{" "}
              {fmt(m.mean)}
              {m.percentile != null && (
                <>
                  {" · "}
                  {m.percentile}
                  <sup>th</sup> pct
                </>
              )}
            </>
          )}
        </span>
      </div>

      {/* Percentile bar (oriented: fill length = how healthy vs peers) */}
      {!m.suppressed && m.orientedPercentile != null && (
        <div
          style={{
            position: "relative",
            height: 10,
            borderRadius: 999,
            background: "var(--border)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${m.orientedPercentile}%`,
              height: "100%",
              background: color,
            }}
          />
        </div>
      )}

      {/* Distribution strip: cohort spread with student + mean markers */}
      {!m.suppressed && m.distribution.length > 0 && (
        <DistributionStrip
          values={m.distribution}
          value={m.value}
          mean={m.mean}
          color={color}
        />
      )}
    </div>
  );
}

function DistributionStrip({
  values,
  value,
  mean,
  color,
}: {
  values: number[];
  value: number | null;
  mean: number | null;
  color: string;
}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pos = (v: number) => ((v - min) / span) * 100;
  return (
    <div
      style={{
        position: "relative",
        height: 28,
        marginTop: 8,
      }}
      title={`Cohort range ${fmt(min)}–${fmt(max)}`}
    >
      {/* baseline */}
      <div
        style={{
          position: "absolute",
          top: 13,
          left: 0,
          right: 0,
          height: 2,
          background: "var(--border)",
        }}
      />
      {/* cohort ticks */}
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${pos(v)}%`,
            top: 8,
            width: 1,
            height: 12,
            background: "#cbd5e1",
            transform: "translateX(-0.5px)",
          }}
        />
      ))}
      {/* mean marker */}
      {mean != null && (
        <div
          style={{
            position: "absolute",
            left: `${pos(mean)}%`,
            top: 4,
            width: 2,
            height: 20,
            background: "#64748b",
            transform: "translateX(-1px)",
          }}
          title={`Cohort avg ${fmt(mean)}`}
        />
      )}
      {/* student marker */}
      {value != null && (
        <div
          style={{
            position: "absolute",
            left: `${pos(value)}%`,
            top: 2,
            width: 12,
            height: 12,
            borderRadius: 999,
            background: color,
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px " + color,
            transform: "translate(-6px, 0)",
          }}
          title={`This student ${fmt(value)}`}
        />
      )}
    </div>
  );
}

// Teacher-Roster-parity FAST trajectory for one subject: level pills (prior →
// PM1 → PM2 → PM3) with scale-score momentum markers, a learning-gain check,
// and a points-to-next-level / points-to-proficiency caption. The pills, the
// level palette, and the placements are single-sourced with the roster
// (FastScorePill + server placePmSet), so the numbers cannot diverge.
function PmTrajectory({ row }: { row: FastRow }) {
  const subjectLabel = row.subject === "ela" ? "ELA" : "Math";

  const marker = (cur: number | null, prev: number | null): PillMarker =>
    cur != null && prev != null
      ? cur > prev
        ? "up"
        : cur < prev
          ? "down"
          : null
      : null;

  const col = (
    label: string,
    score: number | null,
    placement: FastPlacement,
    m: PillMarker,
    bq?: boolean,
  ) => (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 2 }}>
        {label}
        {bq ? " · BQ" : ""}
      </div>
      <FastScorePill
        score={score}
        level={placement?.level ?? null}
        subLevel={placement?.subLevel ?? null}
        pmLabel={`${subjectLabel} ${label}`}
        marker={m}
      />
    </div>
  );

  const captionParts: string[] = [];
  if (row.ptsToNextLevel != null && row.ptsToNextLevel > 0) {
    captionParts.push(`${row.ptsToNextLevel} pts to next level`);
  }
  if (row.ptsToProficient != null) {
    captionParts.push(
      row.ptsToProficient <= 0
        ? "Proficient (L3+)"
        : `${row.ptsToProficient} pts to proficiency`,
    );
  }

  const arrow: React.CSSProperties = {
    color: "var(--muted)",
    alignSelf: "center",
    marginTop: 14,
  };
  const hasPrior = row.priorYearScore != null;

  return (
    <div style={{ minWidth: 240 }}>
      <div
        style={{
          fontWeight: 700,
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>{subjectLabel}</span>
        {row.learningGain === true && (
          <span
            title="Learning gain met (PM3 vs prior year)"
            style={{ color: "#16a34a", fontWeight: 700, fontSize: 13 }}
          >
            ✓ LG
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
        {hasPrior && (
          <>
            {col("Prior", row.priorYearScore, row.levels.priorYearScore, null, row.priorYearBq)}
            <span style={arrow}>→</span>
          </>
        )}
        {col("PM1", row.pm1, row.levels.pm1, null)}
        <span style={arrow}>→</span>
        {col("PM2", row.pm2, row.levels.pm2, marker(row.pm2, row.pm1))}
        <span style={arrow}>→</span>
        {col("PM3", row.pm3, row.levels.pm3, marker(row.pm3, row.pm2))}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        {captionParts.length ? captionParts.join(" · ") : "—"}
      </div>
    </div>
  );
}
