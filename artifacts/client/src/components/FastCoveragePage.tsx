import { useEffect, useState } from "react";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "./HowToUseHelp";

// FAST Coverage telemetry — surfaces per-(subject, grade) score
// loading status so an admin can see at a glance which grades need
// imports before exposing the Teacher Roster (which silently renders
// blank pills / buckets when scores aren't present).
//
// Backed by GET /api/insights/fast-coverage. Admin-gated server-side.

type Subject = "ela" | "math" | "algebra1" | "geometry";

interface CoverageRow {
  subject: Subject;
  grade: number;
  studentsTotal: number;
  withPm1: number;
  withPm2: number;
  withPm3: number;
  withPriorYear: number;
  hasChart: boolean;
}

const SUBJECT_LABEL: Record<Subject, string> = {
  ela: "ELA",
  math: "Math",
  algebra1: "Algebra 1 EOC",
  geometry: "Geometry EOC",
};

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

function rowStatus(r: CoverageRow): {
  label: string;
  color: string;
  bg: string;
} {
  if (!r.hasChart) {
    return {
      label: "No chart",
      color: "#6b7280",
      bg: "#f3f4f6",
    };
  }
  if (r.studentsTotal === 0) {
    return { label: "No students", color: "#6b7280", bg: "#f3f4f6" };
  }
  if (r.withPm3 === 0) {
    return { label: "Missing PM3", color: "#b91c1c", bg: "#fee2e2" };
  }
  if (r.withPm3 < r.studentsTotal) {
    return { label: "Partial PM3", color: "#92400e", bg: "#fef3c7" };
  }
  return { label: "Complete", color: "#166534", bg: "#dcfce7" };
}

export default function FastCoveragePage() {
  const [rows, setRows] = useState<CoverageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/insights/fast-coverage", {
          credentials: "include",
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const body = (await r.json()) as { rows: CoverageRow[] };
        if (!cancelled) setRows(body.rows);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <h2>FAST Coverage</h2>
        <p style={{ color: "#b91c1c" }}>Couldn't load coverage: {error}</p>
      </div>
    );
  }

  if (!rows) {
    return (
      <div style={{ padding: 24 }}>
        <h2>FAST Coverage</h2>
        <p>Loading…</p>
      </div>
    );
  }

  // Filter: only show rows where students exist AND a chart exists
  // OR PM3 is incomplete. "No chart" + 0 students rows are pure
  // noise.
  const visible = rows.filter(
    (r) => r.studentsTotal > 0 && (r.hasChart || r.withPm3 > 0),
  );

  // Group by subject for readability.
  const bySubject = new Map<Subject, CoverageRow[]>();
  for (const r of visible) {
    const list = bySubject.get(r.subject) ?? [];
    list.push(r);
    bySubject.set(r.subject, list);
  }

  const missingChartSubjects = (["algebra1", "geometry"] as Subject[]).filter(
    (s) => rows.some((r) => r.subject === s && r.studentsTotal > 0),
  );

  return (
    <div style={{ padding: 24, maxWidth: 980 }}>
      <h2 style={{ marginTop: 0 }}>FAST Score Coverage</h2>
      <HowToUseHelp title="How to use FAST Coverage">
        <HowToSection title="What this page is">
          A completeness check — how many students have FAST scores loaded per
          window, so you can catch import gaps before they skew reports.
        </HowToSection>
        <HowToSection title="Day-to-day">
          <ul style={howtoListStyle}>
            <li>
              Look for grades or windows with low coverage — usually a missing
              or partial import.
            </li>
            <li>Fix gaps in Data Imports, then re-check here.</li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Check before you share">
          Run this before opening the Teacher Roster to staff — grades flagged
          Missing PM3 render blank Learning-Gain buckets.
        </RoleSection>
      </HowToUseHelp>
      <p style={{ color: "#4b5563", marginTop: 4 }}>
        Per-grade snapshot of FAST score loading. Use this before
        sharing the Teacher Roster with staff — grades flagged{" "}
        <strong>Missing PM3</strong> will render blank LG buckets.
      </p>

      {missingChartSubjects.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "#fef3c7",
            border: "1px solid #fbbf24",
            borderRadius: 6,
            fontSize: 14,
            color: "#78350f",
          }}
        >
          <strong>Awaiting cut-score data:</strong>{" "}
          {missingChartSubjects.map((s) => SUBJECT_LABEL[s]).join(", ")}.
          Scores can be imported, but bucket placement won't render
          until the FL DOE cut-score chart is wired in.
        </div>
      )}

      {visible.length === 0 ? (
        <p style={{ marginTop: 24, color: "#6b7280" }}>
          No FAST-eligible students rostered yet.
        </p>
      ) : (
        Array.from(bySubject.entries()).map(([subject, list]) => (
          <section key={subject} style={{ marginTop: 24 }}>
            <h3 style={{ marginBottom: 8 }}>{SUBJECT_LABEL[subject]}</h3>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 14,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "#4b5563" }}>
                  <th style={{ padding: "6px 8px" }}>Grade</th>
                  <th style={{ padding: "6px 8px" }}>Students</th>
                  <th style={{ padding: "6px 8px" }}>PM1</th>
                  <th style={{ padding: "6px 8px" }}>PM2</th>
                  <th style={{ padding: "6px 8px" }}>PM3</th>
                  <th style={{ padding: "6px 8px" }}>Prior yr</th>
                  <th style={{ padding: "6px 8px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const s = rowStatus(r);
                  return (
                    <tr
                      key={`${r.subject}-${r.grade}`}
                      style={{ borderTop: "1px solid #e5e7eb" }}
                    >
                      <td style={{ padding: "6px 8px" }}>{r.grade}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {r.studentsTotal}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        {pct(r.withPm1, r.studentsTotal)}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        {pct(r.withPm2, r.studentsTotal)}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        {pct(r.withPm3, r.studentsTotal)}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        {pct(r.withPriorYear, r.studentsTotal)}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: s.bg,
                            color: s.color,
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {s.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}
