// Teacher Roster "PM3 history" drawer. Opened by the 📖 book icon on a roster
// row, it shows the student's prior-year FAST PM3 (ELA + Math) grouped by year,
// a divider, then the current year's full PM1 -> PM2 -> PM3 progression.
//
// Data comes from GET /api/student-lookup/:studentId/fast-history, which is
// roster-visibility scoped server-side (a teacher only sees their own students)
// and never returns the FLEID — only localSisId. The studentId passed here is
// the same internal handle every other roster action uses; it is never shown.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import {
  FastScorePill,
  type PillView,
  PillViewContext,
  PillViewToggle,
} from "./FastScorePill";

type Pill = {
  score: number;
  level: number;
  subLevel: string;
} | null;

type YearRow = {
  schoolYear: string;
  gradeInYear: number | null;
  isCurrent: boolean;
  pm1: Pill;
  pm2: Pill;
  pm3: Pill;
  withinYearGrowth: number | null;
  learningGain: boolean | null;
};

type SubjectHistory = { subject: string; rows: YearRow[] };

type FastHistoryResponse = {
  localSisId: string | null;
  currentGrade: number | null;
  currentSchoolYear: string;
  subjects: SubjectHistory[];
};

// "24-25" -> "2024–25" for a friendlier year label.
function fmtYear(y: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(y);
  if (!m) return y;
  return `20${m[1]}–${m[2]}`;
}

function LevelPill({ p, label }: { p: Pill; label: string }) {
  return (
    <FastScorePill
      score={p?.score ?? null}
      level={(p?.level ?? null) as 1 | 2 | 3 | 4 | 5 | null}
      subLevel={p?.subLevel ?? null}
      pmLabel={label}
    />
  );
}

export default function FastHistoryModal({
  studentId,
  studentName,
  localSisId,
  onClose,
}: {
  studentId: string;
  studentName: string;
  localSisId?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<FastHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default to the achievement level. Pills can still be flipped to the scale
  // score to surface the actual PM3 numbers.
  const [pillView, setPillView] = useState<PillView>("level");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(
      `/api/student-lookup/${encodeURIComponent(studentId)}/fast-history`,
    )
      .then((r) => {
        if (!r.ok) {
          throw new Error(
            r.status === 403
              ? "Not in your roster"
              : "Could not load FAST history",
          );
        }
        return r.json();
      })
      .then((j: FastHistoryResponse) => {
        if (!cancelled) setData(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Could not load FAST history",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const rowFor = (subject: string, year: string): YearRow | null => {
    const s = data?.subjects.find((x) => x.subject === subject);
    return s?.rows.find((r) => r.schoolYear === year) ?? null;
  };

  const yearNum = (y: string) => Number(y.slice(0, 2));

  const historicalYears = data
    ? [
        ...new Set(
          data.subjects.flatMap((s) =>
            s.rows.filter((r) => !r.isCurrent).map((r) => r.schoolYear),
          ),
        ),
      ].sort((a, b) => yearNum(b) - yearNum(a))
    : [];

  const currentYear = data?.currentSchoolYear ?? "";
  const hasCurrent = data
    ? data.subjects.some((s) => s.rows.some((r) => r.isCurrent))
    : false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`FAST PM3 history for ${studentName}`}
      style={overlay}
      onClick={onClose}
    >
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1.1rem", color: "#1e3a8a" }}>
              FAST History — {studentName}
            </h3>
            <div
              style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: 2 }}
            >
              {localSisId ? `ID ${localSisId}` : ""}
              {data?.currentGrade != null ? ` · Grade ${data.currentGrade}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <PillViewToggle value={pillView} onChange={setPillView} />
            <button
              type="button"
              onClick={onClose}
              style={closeBtn}
              aria-label="Close FAST history"
            >
              ✕
            </button>
          </div>
        </div>

        {loading && <p style={{ color: "#6b7280" }}>Loading…</p>}
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}

        {data && !loading && !error && (
          <PillViewContext.Provider value={pillView}>
            <section>
              <h4 style={sectionH}>Historical · PM3 by year</h4>
              {historicalYears.length === 0 ? (
                <p style={emptyNote}>No prior-year FAST scores on file.</p>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr style={theadRow}>
                      <th style={thL}>Year</th>
                      <th style={thL}>Grade</th>
                      <th style={thC}>ELA PM3</th>
                      <th style={thC}>Math PM3</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historicalYears.map((y) => {
                      const ela = rowFor("ela", y);
                      const math = rowFor("math", y);
                      return (
                        <tr key={y}>
                          <td style={tdL}>{fmtYear(y)}</td>
                          <td style={tdL}>
                            {ela?.gradeInYear ?? math?.gradeInYear ?? "—"}
                          </td>
                          <td style={tdC}>
                            <LevelPill
                              p={ela?.pm3 ?? null}
                              label={`${y} ELA PM3`}
                            />
                          </td>
                          <td style={tdC}>
                            <LevelPill
                              p={math?.pm3 ?? null}
                              label={`${y} Math PM3`}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            <hr style={divider} />

            <section>
              <h4 style={sectionH}>
                Current year — {fmtYear(currentYear)} · PM1 → PM2 → PM3
              </h4>
              {!hasCurrent ? (
                <p style={emptyNote}>No current-year FAST scores yet.</p>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr style={theadRow}>
                      <th style={thL}>Subject</th>
                      <th style={thC}>PM1</th>
                      <th style={thC}>PM2</th>
                      <th style={thC}>PM3</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["ela", "math"] as const).map((sub) => {
                      const r = rowFor(sub, currentYear);
                      return (
                        <tr key={sub}>
                          <td style={tdL}>{sub === "ela" ? "ELA" : "Math"}</td>
                          <td style={tdC}>
                            <LevelPill p={r?.pm1 ?? null} label="PM1" />
                          </td>
                          <td style={tdC}>
                            <LevelPill p={r?.pm2 ?? null} label="PM2" />
                          </td>
                          <td style={tdC}>
                            <LevelPill p={r?.pm3 ?? null} label="PM3" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            <p style={footnote}>
              Historical rows show the end-of-year PM3 and may reflect a
              different grade level. Pills show the scale score — toggle to see
              the achievement level.
            </p>
          </PillViewContext.Provider>
        )}
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "6vh 16px",
  overflowY: "auto",
  zIndex: 1000,
};

const panel: CSSProperties = {
  background: "white",
  borderRadius: 10,
  padding: "1.25rem",
  maxWidth: 560,
  width: "100%",
  boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: "0.75rem",
  borderBottom: "2px solid #1e3a8a",
  paddingBottom: "0.5rem",
};

const closeBtn: CSSProperties = {
  border: "1px solid #e2e8f0",
  background: "#f8fafc",
  borderRadius: 8,
  width: 30,
  height: 30,
  cursor: "pointer",
  fontSize: 14,
  color: "#475569",
  lineHeight: 1,
  flexShrink: 0,
};

const sectionH: CSSProperties = {
  margin: "0.5rem 0 0.4rem",
  fontSize: "0.82rem",
  fontWeight: 700,
  color: "#334155",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.8rem",
};

const theadRow: CSSProperties = { color: "#6b7280" };
const thL: CSSProperties = {
  textAlign: "left",
  padding: "4px 6px",
  fontWeight: 600,
};
const thC: CSSProperties = {
  textAlign: "center",
  padding: "4px 6px",
  fontWeight: 600,
};
const tdL: CSSProperties = {
  textAlign: "left",
  padding: "6px",
  color: "#334155",
};
const tdC: CSSProperties = { textAlign: "center", padding: "6px" };

const divider: CSSProperties = {
  border: "none",
  borderTop: "2px dashed #cbd5e1",
  margin: "1rem 0",
};

const emptyNote: CSSProperties = {
  color: "#94a3b8",
  fontSize: "0.8rem",
  fontStyle: "italic",
};

const footnote: CSSProperties = {
  marginTop: "0.75rem",
  fontSize: "0.7rem",
  color: "#94a3b8",
  lineHeight: 1.4,
};
