// Aggregate view of every Separation Suggestion teachers have filed in
// the current school year. Lives under Insights → Behavior. Visible to
// the scheduling team only (Admin / DA / SU / Behavior Specialist /
// Counselor / Guidance Counselor / Dean / School Psychologist / MTSS
// Coordinator). Read-only — teachers create the data; this page exists
// so the scheduling team can see "which pairs do multiple teachers want
// kept apart next year?" and drill into a single student's flags.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

interface TagBreakdown {
  tagId: number;
  label: string;
  count: number;
}

interface PairRow {
  studentAId: string;
  studentAName: string;
  studentAGrade: number | null;
  studentBId: string;
  studentBName: string;
  studentBGrade: number | null;
  flagCount: number;
  teacherCount: number;
  sectionCount: number;
  noteCount: number;
  tagBreakdown: TagBreakdown[];
}

interface AggregateResponse {
  schoolYear: string;
  totals: {
    totalFlags: number;
    uniquePairs: number;
    flaggedStudents: number;
  };
  topPairs: PairRow[];
  tagDistribution: TagBreakdown[];
}

interface StudentFlag {
  id: number;
  period: number;
  courseName: string;
  classSectionId: number;
  reporterStaffId: number;
  reporterName: string;
  otherStudentId: string;
  otherStudentName: string;
  reasonNote: string | null;
  tags: Array<{ tagId: number; label: string }>;
  createdAt: string;
}

interface StudentFlagsResponse {
  schoolYear: string;
  flags: StudentFlag[];
}

const card: CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "1rem 1.25rem",
};

const tagPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "1px 8px",
  borderRadius: 999,
  background: "#fef3c7",
  color: "#92400e",
  border: "1px solid #fde68a",
  fontSize: 11,
  fontWeight: 600,
};

interface Props {
  onBack?: () => void;
}

export default function SeparationSuggestionsPage({ onBack }: Props) {
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [grade, setGrade] = useState<string>("all");
  const [minTeachers, setMinTeachers] = useState<number>(1);
  // Drilldown panel — clicking a student name in any pair opens the
  // per-student timeline of every flag they appear on.
  const [drillStudentId, setDrillStudentId] = useState<string | null>(null);
  const [drillData, setDrillData] = useState<StudentFlagsResponse | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const params = new URLSearchParams();
      if (grade !== "all") params.set("grade", grade);
      params.set("minTeachers", String(minTeachers));
      const r = await authFetch(
        `/api/separations/aggregate?${params.toString()}`,
      );
      if (!r.ok) throw new Error(await r.text());
      setData((await r.json()) as AggregateResponse);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [grade, minTeachers]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openDrill = useCallback(async (studentId: string) => {
    setDrillStudentId(studentId);
    setDrillData(null);
    setDrillLoading(true);
    try {
      const r = await authFetch(
        `/api/separations/student/${encodeURIComponent(studentId)}`,
      );
      if (r.ok) setDrillData((await r.json()) as StudentFlagsResponse);
    } finally {
      setDrillLoading(false);
    }
  }, []);

  // Distinct grades present so the filter can offer them. We just look
  // at the loaded pair list rather than a separate fetch.
  const gradeOptions = useMemo(() => {
    if (!data) return [] as number[];
    const s = new Set<number>();
    for (const p of data.topPairs) {
      if (p.studentAGrade !== null) s.add(p.studentAGrade);
      if (p.studentBGrade !== null) s.add(p.studentBGrade);
    }
    return Array.from(s).sort((a, b) => a - b);
  }, [data]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Separation Suggestions</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            Pairs of students teachers have asked you to keep apart when
            building next year's schedule. {data ? `School year ${data.schoolYear}.` : ""}
          </p>
          <HowToUseHelp title="How to use Separation Suggestions">
            <HowToSection title="What this page is">
              The aggregate list of every "keep these two apart" flag
              teachers have submitted this year, grouped by reason
              (using the Separation Tags from school settings). Built
              for next-year scheduling, not in-year intervention.
            </HowToSection>
            <RoleSection for={["admin", "coreTeam"]} title="Scheduling workflow">
              Export the CSV right before master-schedule build. The
              Reason column tells the scheduler whether they're
              looking at safety (must-separate) or social drama
              (nice-to-separate).
            </RoleSection>
          </HowToUseHelp>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            style={{
              padding: "0.4rem 0.8rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              background: "white",
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
        )}
      </div>

      <div style={{ ...card, display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ color: "var(--text-subtle)" }}>Grade</span>
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            style={{ padding: "0.35rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6 }}
          >
            <option value="all">All grades</option>
            {gradeOptions.map((g) => (
              <option key={g} value={String(g)}>
                Grade {g}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ color: "var(--text-subtle)" }}>Minimum teachers</span>
          <select
            value={String(minTeachers)}
            onChange={(e) => setMinTeachers(Number(e.target.value))}
            style={{ padding: "0.35rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6 }}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={String(n)}>
                {n}+ teacher{n > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginLeft: "auto" }}>
            <Stat label="Total flags" value={data.totals.totalFlags} />
            <Stat label="Unique pairs" value={data.totals.uniquePairs} />
            <Stat label="Students flagged" value={data.totals.flaggedStudents} />
          </div>
        )}
      </div>

      {err && (
        <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>
      )}

      <div style={{ ...card }}>
        <h3 style={{ marginTop: 0 }}>Pairs to consider separating</h3>
        {loading ? (
          <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
        ) : !data || data.topPairs.length === 0 ? (
          <p style={{ color: "var(--text-subtle)" }}>
            No flagged pairs match these filters yet.
          </p>
        ) : (
          <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead style={{ textAlign: "left", background: "#f8fafc" }}>
              <tr>
                <th style={{ padding: "6px 10px" }}>Pair</th>
                <th style={{ padding: "6px 10px", width: 100 }}>Teachers</th>
                <th style={{ padding: "6px 10px", width: 80 }}>Sections</th>
                <th style={{ padding: "6px 10px", width: 80 }}>Notes</th>
                <th style={{ padding: "6px 10px" }}>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {data.topPairs.map((p) => (
                <tr
                  key={`${p.studentAId}|${p.studentBId}`}
                  style={{ borderTop: "1px solid #f1f5f9" }}
                >
                  <td style={{ padding: "8px 10px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <button
                        type="button"
                        onClick={() => void openDrill(p.studentAId)}
                        style={linkBtn}
                      >
                        {p.studentAName}{" "}
                        {p.studentAGrade !== null && (
                          <span style={{ color: "#64748b", fontWeight: 400 }}>
                            (Gr {p.studentAGrade})
                          </span>
                        )}
                      </button>
                      <span style={{ color: "#94a3b8", fontSize: 12 }}>+</span>
                      <button
                        type="button"
                        onClick={() => void openDrill(p.studentBId)}
                        style={linkBtn}
                      >
                        {p.studentBName}{" "}
                        {p.studentBGrade !== null && (
                          <span style={{ color: "#64748b", fontWeight: 400 }}>
                            (Gr {p.studentBGrade})
                          </span>
                        )}
                      </button>
                    </div>
                  </td>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>
                    {p.teacherCount}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{p.sectionCount}</td>
                  <td style={{ padding: "8px 10px" }}>{p.noteCount}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.tagBreakdown.length === 0 ? (
                      <span style={{ color: "var(--text-subtle)", fontSize: 12 }}>
                        (no tags — open student to read notes)
                      </span>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {p.tagBreakdown.map((t) => (
                          <span key={t.tagId} style={tagPillStyle}>
                            {t.label} · {t.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.tagDistribution.length > 0 && (
        <div style={{ ...card }}>
          <h3 style={{ marginTop: 0 }}>Reasons used this year</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {data.tagDistribution.map((t) => (
              <span key={t.tagId} style={tagPillStyle}>
                {t.label} · {t.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {drillStudentId && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setDrillStudentId(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: 8,
              padding: "1.25rem 1.5rem",
              minWidth: 480,
              maxWidth: 720,
              maxHeight: "80vh",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <h3 style={{ margin: 0 }}>Flags for student {drillStudentId}</h3>
              <button
                type="button"
                onClick={() => setDrillStudentId(null)}
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: 22,
                  cursor: "pointer",
                  color: "#64748b",
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {drillLoading ? (
              <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
            ) : !drillData || drillData.flags.length === 0 ? (
              <p style={{ color: "var(--text-subtle)" }}>No flags found.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {drillData.flags.map((f) => (
                  <li
                    key={f.id}
                    style={{
                      borderTop: "1px solid #e2e8f0",
                      padding: "0.75rem 0",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      with {f.otherStudentName}
                    </div>
                    <div style={{ color: "#475569", fontSize: 13 }}>
                      Period {f.period} · {f.courseName} · reported by{" "}
                      {f.reporterName}
                    </div>
                    {f.tags.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 4,
                          marginTop: 4,
                        }}
                      >
                        {f.tags.map((t) => (
                          <span key={t.tagId} style={tagPillStyle}>
                            {t.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {f.reasonNote && (
                      <div
                        style={{
                          background: "#f8fafc",
                          border: "1px solid #e2e8f0",
                          borderRadius: 6,
                          padding: "0.5rem 0.75rem",
                          marginTop: 6,
                          fontSize: 13,
                          color: "#1e293b",
                        }}
                      >
                        {f.reasonNote}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: "var(--text-subtle)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

const linkBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#1d4ed8",
  cursor: "pointer",
  textAlign: "left",
  font: "inherit",
  padding: 0,
  textDecoration: "underline",
};
