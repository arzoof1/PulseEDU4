// Group Insights — teacher-facing deep view on TeacherRosterPage.
// Works for any section (regular or intensive) — the engine just
// needs FAST scores for enrolled students. Intensive-flagged
// sections get a badge but aren't required.

import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface WindowOpt {
  schoolYear: string;
  window: string;
  label: string;
}
interface Profile {
  studentId: string;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  grade: number | null;
  topGaps: string[];
  overallPct: number | null;
}
interface Subgroup {
  index: number;
  dominantCategory: string | null;
  students: Profile[];
  avgDominantPct: number | null;
  cohesionPct: number;
}
interface SectionInfo {
  id: number;
  period: number;
  courseName: string;
  teacherStaffId: number;
  isIntensive: boolean;
}
interface InsightsResponse {
  section: SectionInfo;
  subject: string;
  schoolYear: string;
  window: string;
  available: WindowOpt[];
  rosterSize: number;
  sectionProfile: {
    totalStudents: number;
    studentsWithData: number;
    dominantCategories: Array<{
      category: string;
      studentCount: number;
      avgPct: number;
    }>;
    homogeneityPct: number;
    recommendedFocusCodes: string[];
  };
  subgroups: Subgroup[];
  drift: {
    comparedWindow: string | null;
    outgrew: Array<{ studentId: string; name: string | null }>;
    wouldNowFit: Array<{ studentId: string; name: string | null }>;
  } | null;
  profiles: Profile[];
}
interface SectionRow {
  id: number;
  period: number;
  courseName: string;
  teacherStaffId: number;
  teacherName: string;
  isIntensive?: boolean;
}

const fullName = (s: {
  firstName: string | null;
  lastName: string | null;
}): string => [s.lastName, s.firstName].filter(Boolean).join(", ") || "—";

export default function GroupInsightsTab({
  teacherId,
}: {
  teacherId: number;
}) {
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<string>("");
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load this teacher's sections.
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/intensive-groups/sections")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load sections");
        return r.json();
      })
      .then((d: { sections: SectionRow[] }) => {
        if (cancelled) return;
        const mine = d.sections.filter((s) => s.teacherStaffId === teacherId);
        setSections(mine);
        if (mine.length > 0) setSelectedSectionId(mine[0].id);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [teacherId]);

  // Load insights when section / window changes.
  useEffect(() => {
    if (!selectedSectionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ sectionId: String(selectedSectionId) });
    if (selectedWindow) {
      const [sy, w] = selectedWindow.split("|");
      params.set("schoolYear", sy);
      params.set("window", w);
    }
    authFetch(`/api/intensive-groups/insights?${params.toString()}`)
      .then((r) => {
        if (!r.ok) {
          return r.json().then((j: { error?: string }) => {
            throw new Error(j.error || `HTTP ${r.status}`);
          });
        }
        return r.json();
      })
      .then((d: InsightsResponse) => {
        if (cancelled) return;
        setData(d);
        // Initial selected window inherits the server's pick.
        if (!selectedWindow) {
          setSelectedWindow(`${d.schoolYear}|${d.window}`);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSectionId, selectedWindow]);

  if (sections.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          border: "1px dashed #d1d5db",
          borderRadius: 8,
          color: "#6b7280",
          fontSize: 13,
        }}
      >
        No sections were found for this teacher. Group Insights activates
        once the teacher has at least one enrolled section with FAST scores
        for the selected window.
      </div>
    );
  }

  const printReport = () => window.print();
  const exportSubgroupsCsv = () => {
    if (!data) return;
    const rows: string[][] = [
      [
        "Sub-group",
        "Focus",
        "Cohesion %",
        "Avg dominant %",
        "Local SIS ID",
        "Last name",
        "First name",
        "Grade",
        "Overall %",
        "Top gaps",
      ],
    ];
    for (const g of data.subgroups) {
      for (const s of g.students) {
        rows.push([
          String(g.index),
          g.dominantCategory ?? "Mixed",
          String(g.cohesionPct),
          g.avgDominantPct != null ? String(g.avgDominantPct) : "",
          s.localSisId ?? "",
          s.lastName ?? "",
          s.firstName ?? "",
          s.grade != null ? String(s.grade) : "",
          s.overallPct != null ? String(s.overallPct) : "",
          s.topGaps.join("; "),
        ]);
      }
    }
    const sec = data.section;
    downloadCsv(
      `group-insights-per${sec.period}-${sec.courseName.replace(/[^a-z0-9]+/gi, "_")}-${data.subject}-${data.schoolYear}-${data.window}.csv`,
      rows,
    );
  };

  return (
    <div style={{ padding: 4 }}>
      <style>{`
        @media print {
          .gi-no-print { display: none !important; }
        }
      `}</style>
      {/* Section + window picker row */}
      <div
        className="gi-no-print"
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <label style={{ fontSize: 13 }}>
          Section:&nbsp;
          <select
            value={selectedSectionId ?? ""}
            onChange={(e) => {
              setSelectedSectionId(Number(e.target.value));
              setSelectedWindow("");
              setData(null);
            }}
            style={{ padding: 4 }}
          >
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                Per {s.period} · {s.courseName}
                {s.isIntensive ? " · Intensive" : ""}
              </option>
            ))}
          </select>
        </label>
        {data && data.available.length > 0 && (
          <label style={{ fontSize: 13 }}>
            Window:&nbsp;
            <select
              value={selectedWindow}
              onChange={(e) => setSelectedWindow(e.target.value)}
              style={{ padding: 4 }}
            >
              {data.available.map((w) => (
                <option
                  key={`${w.schoolYear}|${w.window}`}
                  value={`${w.schoolYear}|${w.window}`}
                >
                  {w.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {data && (
          <span style={{ fontSize: 12, color: "#6b7280" }}>
            Roster: {data.rosterSize} · With data:{" "}
            {data.sectionProfile.studentsWithData} · Subject{" "}
            <strong>{data.subject.toUpperCase()}</strong>
          </span>
        )}
        {data && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={printReport}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                border: "1px solid #d1d5db",
                background: "white",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Print
            </button>
            <button
              type="button"
              onClick={exportSubgroupsCsv}
              disabled={data.subgroups.length === 0}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                border: "1px solid #d1d5db",
                background: data.subgroups.length === 0 ? "#f3f4f6" : "white",
                borderRadius: 4,
                cursor: data.subgroups.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              Export sub-groups CSV
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>
          {error}
        </div>
      )}
      {loading && <div style={{ fontSize: 13 }}>Loading…</div>}

      {data && !loading && (
        <div style={{ display: "grid", gap: 12 }}>
          {/* Section profile */}
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: 12,
              background: "white",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16 }}>Section profile</h3>
            <div style={{ fontSize: 13, color: "#374151", marginTop: 6 }}>
              Homogeneity score:{" "}
              <strong>{data.sectionProfile.homogeneityPct}%</strong>
            </div>
            <div style={{ marginTop: 10 }}>
              <table style={{ fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f3f4f6" }}>
                    <th style={{ textAlign: "left", padding: "4px 8px" }}>
                      Dominant skill area
                    </th>
                    <th style={{ textAlign: "right", padding: "4px 8px" }}>
                      Students
                    </th>
                    <th style={{ textAlign: "right", padding: "4px 8px" }}>
                      Avg mastery
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.sectionProfile.dominantCategories.map((c) => (
                    <tr key={c.category}>
                      <td style={{ padding: "4px 8px" }}>{c.category}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>
                        {c.studentCount}
                      </td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>
                        {c.avgPct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.sectionProfile.recommendedFocusCodes.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                Recommended focus standards:{" "}
                {data.sectionProfile.recommendedFocusCodes.map((c) => (
                  <code
                    key={c}
                    style={{
                      background: "#eef2ff",
                      padding: "2px 6px",
                      borderRadius: 4,
                      marginRight: 4,
                      fontSize: 12,
                    }}
                  >
                    {c}
                  </code>
                ))}
              </div>
            )}
          </section>

          {/* Sub-groups */}
          {data.subgroups.length > 0 && (
            <section
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: 12,
                background: "white",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>
                Suggested sub-groups for small-group instruction
              </h3>
              <div
                style={{
                  marginTop: 8,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  gap: 10,
                }}
              >
                {data.subgroups.map((g) => (
                  <div
                    key={g.index}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 6,
                      padding: 10,
                      background: "#f9fafb",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      Sub-group {g.index}
                    </div>
                    <div style={{ fontSize: 12, color: "#374151" }}>
                      Focus: {g.dominantCategory ?? "Mixed"}
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>
                      Cohesion {g.cohesionPct}%
                      {g.avgDominantPct != null
                        ? ` · Avg ${g.avgDominantPct}%`
                        : ""}
                    </div>
                    <ul style={{ paddingLeft: 18, fontSize: 12, marginTop: 6 }}>
                      {g.students.map((s) => (
                        <li key={s.studentId}>{fullName(s)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Drift panel */}
          {data.drift && (
            <section
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: 12,
                background: "white",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>
                Drift since {data.drift.comparedWindow?.toUpperCase()}
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                  marginTop: 8,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#065f46" }}>
                    Outgrew the focus skills ({data.drift.outgrew.length})
                  </div>
                  <ul style={{ paddingLeft: 18, fontSize: 12 }}>
                    {data.drift.outgrew.map((s) => (
                      <li key={s.studentId}>
                        {s.name ?? "Student"}
                      </li>
                    ))}
                    {data.drift.outgrew.length === 0 && (
                      <li style={{ color: "#6b7280", listStyle: "none" }}>
                        None this window.
                      </li>
                    )}
                  </ul>
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#92400e" }}>
                    Would fit this section now ({data.drift.wouldNowFit.length})
                  </div>
                  <ul style={{ paddingLeft: 18, fontSize: 12 }}>
                    {data.drift.wouldNowFit.map((s) => (
                      <li key={s.studentId}>{s.name ?? "Student"}</li>
                    ))}
                    {data.drift.wouldNowFit.length === 0 && (
                      <li style={{ color: "#6b7280", listStyle: "none" }}>
                        None within reach.
                      </li>
                    )}
                  </ul>
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#6b7280",
                  marginTop: 8,
                  fontStyle: "italic",
                }}
              >
                Skyward stays the source of truth — these are review-only
                signals, not roster changes.
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
