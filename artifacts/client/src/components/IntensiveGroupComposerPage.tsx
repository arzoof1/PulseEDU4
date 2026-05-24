// Class Composer — Phase A scheduler-facing suggestion report.
// Admin / Core Team only. Read-only on top of FAST item responses.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface WindowOpt {
  schoolYear: string;
  window: string;
  label: string;
}
interface Profile {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  grade: number | null;
  categories: Array<{
    category: string;
    pct: number;
    responseCount: number;
    benchmarkCodes: string[];
  }>;
  topGaps: string[];
  overallPct: number | null;
}
interface Group {
  index: number;
  dominantCategory: string | null;
  students: Profile[];
  avgDominantPct: number | null;
  cohesionPct: number;
}
interface SuggestResponse {
  subject: string;
  grade: number;
  schoolYear: string;
  window: string;
  available: WindowOpt[];
  eligibilityMaxPct: number;
  requested: { sections: number; seats: number };
  candidatePool: {
    totalAtGrade: number;
    eligible: number;
    unscored: number;
  };
  groups: Group[];
  overflow: Array<{
    studentId: string;
    firstName: string | null;
    lastName: string | null;
    grade: number | null;
    overallPct: number | null;
    topGaps: string[];
  }>;
  unscored: Array<{
    studentId: string;
    firstName: string | null;
    lastName: string | null;
    grade: number | null;
  }>;
}

const SUBJECT_OPTIONS = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "algebra1", label: "Algebra 1" },
  { value: "geometry", label: "Geometry" },
];

const fullName = (
  s: { firstName: string | null; lastName: string | null },
): string =>
  [s.lastName, s.firstName].filter(Boolean).join(", ") || "—";

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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

export default function IntensiveGroupComposerPage({
  onBack,
}: {
  onBack: () => void;
}) {
  const [subject, setSubject] = useState("ela");
  const [grade, setGrade] = useState(6);
  const [sections, setSections] = useState(4);
  const [seats, setSeats] = useState(22);
  const [eligibilityMaxPct, setEligibilityMaxPct] = useState(70);
  const [windowOpts, setWindowOpts] = useState<WindowOpt[]>([]);
  const [selectedWindow, setSelectedWindow] = useState<string>("");
  const [result, setResult] = useState<SuggestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load available windows when subject changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    authFetch(`/api/intensive-groups/windows?subject=${subject}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load windows");
        return r.json();
      })
      .then((d: { available: WindowOpt[] }) => {
        if (cancelled) return;
        setWindowOpts(d.available);
        if (d.available.length > 0) {
          setSelectedWindow(`${d.available[0].schoolYear}|${d.available[0].window}`);
        } else {
          setSelectedWindow("");
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [subject]);

  const generate = async () => {
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const params = new URLSearchParams({
        subject,
        grade: String(grade),
        sections: String(sections),
        seats: String(seats),
        eligibilityMaxPct: String(eligibilityMaxPct),
      });
      if (selectedWindow) {
        const [sy, w] = selectedWindow.split("|");
        params.set("schoolYear", sy);
        params.set("window", w);
      }
      const r = await authFetch(`/api/intensive-groups/suggest?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as SuggestResponse;
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    const rows: string[][] = [
      [
        "Group",
        "Dominant Skill",
        "Cohesion %",
        "Avg Skill %",
        "Student",
        "Student ID",
        "Grade",
        "Overall %",
        "Top Gap 1",
        "Top Gap 2",
        "Top Gap 3",
      ],
    ];
    for (const g of result.groups) {
      for (const s of g.students) {
        rows.push([
          `Group ${g.index}`,
          g.dominantCategory ?? "",
          String(g.cohesionPct),
          g.avgDominantPct == null ? "" : String(g.avgDominantPct),
          fullName(s),
          s.studentId,
          s.grade == null ? "" : String(s.grade),
          s.overallPct == null ? "" : String(s.overallPct),
          s.topGaps[0] ?? "",
          s.topGaps[1] ?? "",
          s.topGaps[2] ?? "",
        ]);
      }
    }
    for (const u of result.unscored) {
      rows.push([
        "Unscored",
        "",
        "",
        "",
        fullName(u),
        u.studentId,
        u.grade == null ? "" : String(u.grade),
        "",
        "",
        "",
        "",
      ]);
    }
    downloadCsv(
      `class-composer-${subject}-g${grade}-${result.schoolYear}-${result.window}.csv`,
      rows,
    );
  };

  const printReport = () => {
    window.print();
  };

  const headerSummary = useMemo(() => {
    if (!result) return null;
    return (
      <div style={{ color: "#374151", fontSize: 13, marginTop: 6 }}>
        Subject <strong>{result.subject.toUpperCase()}</strong> · Grade{" "}
        <strong>{result.grade}</strong> · Window{" "}
        <strong>
          {result.schoolYear} {result.window.toUpperCase()}
        </strong>{" "}
        · Eligibility ≤ <strong>{result.eligibilityMaxPct}%</strong> overall
      </div>
    );
  }, [result]);

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <style>{`
        @media print {
          .composer-no-print { display: none !important; }
          .composer-group-card { break-inside: avoid; }
        }
      `}</style>

      <div className="composer-no-print" style={{ marginBottom: 12 }}>
        <button
          onClick={onBack}
          style={{
            padding: "6px 12px",
            border: "1px solid #d1d5db",
            background: "white",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          ← Back to Insights
        </button>
      </div>

      <h1 style={{ fontSize: 24, margin: "0 0 4px 0" }}>Class Composer</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Suggest intensive-group sections from the latest FAST results. Read-only —
        Skyward / RosterOne stays the source of truth.
      </p>

      <section
        className="composer-no-print"
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 14,
          marginBottom: 14,
          background: "#f9fafb",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Subject
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{ padding: 6, marginTop: 4 }}
            >
              {SUBJECT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Grade
            <select
              value={grade}
              onChange={(e) => setGrade(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            >
              {[5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Window
            <select
              value={selectedWindow}
              onChange={(e) => setSelectedWindow(e.target.value)}
              style={{ padding: 6, marginTop: 4 }}
              disabled={windowOpts.length === 0}
            >
              {windowOpts.length === 0 && <option value="">— No data —</option>}
              {windowOpts.map((w) => (
                <option key={`${w.schoolYear}|${w.window}`} value={`${w.schoolYear}|${w.window}`}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            # Sections
            <input
              type="number"
              min={1}
              max={20}
              value={sections}
              onChange={(e) => setSections(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Seats / section
            <input
              type="number"
              min={2}
              max={35}
              value={seats}
              onChange={(e) => setSeats(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Eligibility ≤ %
            <input
              type="number"
              min={0}
              max={100}
              value={eligibilityMaxPct}
              onChange={(e) => setEligibilityMaxPct(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            onClick={generate}
            disabled={loading || !selectedWindow}
            style={{
              padding: "8px 16px",
              border: "1px solid #2563eb",
              background: "#2563eb",
              color: "white",
              borderRadius: 6,
              cursor: loading ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            {loading ? "Building…" : "Build groups"}
          </button>
          {result && (
            <>
              <button
                onClick={printReport}
                style={{
                  padding: "8px 14px",
                  border: "1px solid #d1d5db",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Print
              </button>
              <button
                onClick={exportCsv}
                style={{
                  padding: "8px 14px",
                  border: "1px solid #d1d5db",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Export CSV
              </button>
            </>
          )}
        </div>
        {error && (
          <div style={{ color: "#b91c1c", marginTop: 10, fontSize: 13 }}>{error}</div>
        )}
      </section>

      {result && (
        <>
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ fontSize: 18, marginBottom: 4 }}>Proposed groupings</h2>
            {headerSummary}
            <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
              Candidate pool: {result.candidatePool.totalAtGrade} students in grade{" "}
              {result.grade} · {result.candidatePool.eligible} eligible (overall ≤{" "}
              {result.eligibilityMaxPct}%) · {result.candidatePool.unscored} without
              data
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            {result.groups.map((g) => (
              <div
                key={g.index}
                className="composer-group-card"
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 12,
                  background: "white",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <h3 style={{ margin: 0, fontSize: 16 }}>Group {g.index}</h3>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>
                    {g.students.length} students
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
                  Skill focus:{" "}
                  <strong>{g.dominantCategory ?? "Mixed"}</strong>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  Cohesion {g.cohesionPct}% ·{" "}
                  {g.avgDominantPct != null
                    ? `Avg ${g.avgDominantPct}% in focus skill`
                    : "—"}
                </div>
                <ol style={{ marginTop: 8, paddingLeft: 18, fontSize: 13 }}>
                  {g.students.map((s) => (
                    <li key={s.studentId} style={{ marginBottom: 3 }}>
                      <span>{fullName(s)}</span>
                      <span style={{ color: "#6b7280", marginLeft: 6 }}>
                        ({s.studentId}
                        {s.overallPct != null ? ` · ${s.overallPct}%` : ""})
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>

          {result.overflow.length > 0 && (
            <div
              style={{
                marginTop: 18,
                border: "1px solid #fca5a5",
                borderRadius: 8,
                padding: 12,
                background: "#fef2f2",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 15, color: "#991b1b" }}>
                Over capacity ({result.overflow.length})
              </h3>
              <p style={{ margin: "4px 0 8px 0", fontSize: 12, color: "#7f1d1d" }}>
                Eligible students who didn't fit in the requested{" "}
                {result.requested.sections} sections × {result.requested.seats}{" "}
                seats. Add another section or raise seats / section to absorb
                them.
              </p>
              <ul style={{ paddingLeft: 18, fontSize: 13, columns: 2 }}>
                {result.overflow.map((u) => (
                  <li key={u.studentId}>
                    {fullName(u)}{" "}
                    <span style={{ color: "#6b7280" }}>
                      ({u.studentId}
                      {u.overallPct != null ? ` · ${u.overallPct}%` : ""})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.unscored.length > 0 && (
            <div
              style={{
                marginTop: 18,
                border: "1px dashed #d1d5db",
                borderRadius: 8,
                padding: 12,
                background: "#fefce8",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 15 }}>
                Unscored ({result.unscored.length})
              </h3>
              <p style={{ margin: "4px 0 8px 0", fontSize: 12, color: "#713f12" }}>
                These students have no FAST item responses for the chosen window
                and weren't auto-placed. Review and place manually.
              </p>
              <ul style={{ paddingLeft: 18, fontSize: 13, columns: 2 }}>
                {result.unscored.map((u) => (
                  <li key={u.studentId}>
                    {fullName(u)}{" "}
                    <span style={{ color: "#6b7280" }}>({u.studentId})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
