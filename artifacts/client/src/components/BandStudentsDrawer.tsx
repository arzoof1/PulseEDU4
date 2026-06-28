// Drill-in panel for "students in this band" — opened by clicking on
// a band/segment in an insights chart (e.g., the L1..L5 placement bars
// on the Academics dashboard).
//
// Renders as a right-side overlay panel rather than a modal dialog so
// the user keeps the chart in view for context. Click the dim layer or
// the close button to dismiss; ESC closes too. Scroll-locks the body
// while open.

import { useEffect, useState } from "react";
import {
  FastScorePill,
  PillViewContext,
  PillViewToggle,
  type PillView,
  type PillMarker,
} from "./FastScorePill";

// One PM window's FAST placement (level + sub-level). Mirrors the server
// `Placement` shape carried on the `levels` field.
interface PmCell {
  level: 1 | 2 | 3 | 4 | 5;
  subLevel: string;
}

interface Student {
  studentId: string;
  studentName: string;
  grade?: number | null;
  // Prior-year FAST score (the "previous year PM3" baseline). Optional so
  // existing callers that never set it keep rendering "—".
  priorYearScore?: number | null;
  pm1?: number | null;
  pm2?: number | null;
  // Nullable so the Trajectory drawer can honestly render "—" for the
  // Untested archetype rather than fabricating a 0 score. The render
  // path below already null-checks so existing callers that always set
  // a number remain safe.
  pm3?: number | null;
  // Per-PM FAST placements for the roster-style level pills. Optional so
  // callers that don't render the PM columns are unaffected; when absent
  // the pill falls back to a neutral "—".
  levels?: {
    priorYearScore: PmCell | null;
    pm1: PmCell | null;
    pm2: PmCell | null;
    pm3: PmCell | null;
  } | null;
  // Optional per-student pills shown next to the name. Program (ESE|504)
  // and MTSS (Tier 2+|Tier 3) are mutually exclusive within their group;
  // BQ ELA / BQ Math are independent ("lowest 25% prior-year FAST").
  programPill?: "ESE" | "504" | null;
  mtssPill?: "Tier 2+" | "Tier 3" | null;
  bqEla?: boolean;
  bqMath?: boolean;
  // Teacher-Roster parity context (additive). ELL flag, active safety-plan
  // summary (SP indicator), and the FAST learning-gain green-check. Optional
  // so callers that don't supply them are unaffected.
  ell?: boolean;
  safetyPlan?: {
    itemCount: number;
    items?: unknown[];
    notes?: string | null;
    updatedAt?: string | null;
    updatedByName?: string | null;
  } | null;
  learningGain?: boolean | null;
  // Optional additive metrics (shared insights source of truth). Only
  // rendered when the caller opts in via `scoreColumns`. daysAbsent /
  // attendancePct from the Eligibility Hub upload; ptsToNextLevel /
  // ptsToProficient from the FAST cut-score charts.
  daysAbsent?: number | null;
  attendancePct?: number | null;
  ptsToNextLevel?: number | null;
  ptsToProficient?: number | null;
}

// A score-table column. `key` is used as a React key and (when no custom
// `render` is given) as the field read off the Student. `render` lets a
// caller format a cell (e.g. "92%" or a "—") without the drawer needing to
// know about the metric. Back-compat: existing callers pass only
// { key: "pm1" | "pm3", label } and get the default numeric cell.
export interface ScoreColumn {
  key: string;
  label: string;
  render?: (s: Student) => React.ReactNode;
}

// Small gain/decline cue for PM2 / PM3 vs the PM1 baseline (raw scale
// score). The pill itself now encodes the achievement level (color), so
// the ▲/▼ marker preserves the at-a-glance momentum read. Equal scores or
// a missing baseline → no marker.
function markerVsPm1(
  value: number | null | undefined,
  baseline: number | null | undefined,
): PillMarker {
  if (value == null || baseline == null) return null;
  if (value > baseline) return "up";
  if (value < baseline) return "down";
  return null;
}

// Shared PM progression columns for the Insights drill-downs: prior-year
// PM3 baseline, then PM1 -> PM2 -> PM3, each rendered as a roster-style
// FAST achievement-level pill (level color, click to flip to the scale
// score, surface-wide toggle). PM2 / PM3 keep a small ▲/▼ marker for
// movement vs the PM1 baseline. Callers prepend these to
// INSIGHTS_METRIC_COLUMNS so the Academics band drawer and Academic
// Trajectories render an identical table.
export const INSIGHTS_PM_COLUMNS: ScoreColumn[] = [
  {
    key: "priorYearScore",
    label: "Prior PM3",
    render: (s) => (
      <FastScorePill
        score={s.priorYearScore}
        level={s.levels?.priorYearScore?.level}
        subLevel={s.levels?.priorYearScore?.subLevel}
        pmLabel="Prior PM3"
      />
    ),
  },
  {
    key: "pm1",
    label: "PM1",
    render: (s) => (
      <FastScorePill
        score={s.pm1}
        level={s.levels?.pm1?.level}
        subLevel={s.levels?.pm1?.subLevel}
        pmLabel="PM1"
      />
    ),
  },
  {
    key: "pm2",
    label: "PM2",
    render: (s) => (
      <FastScorePill
        score={s.pm2}
        level={s.levels?.pm2?.level}
        subLevel={s.levels?.pm2?.subLevel}
        pmLabel="PM2"
        marker={markerVsPm1(s.pm2, s.pm1)}
      />
    ),
  },
  {
    key: "pm3",
    label: "PM3",
    render: (s) => (
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        <FastScorePill
          score={s.pm3}
          level={s.levels?.pm3?.level}
          subLevel={s.levels?.pm3?.subLevel}
          pmLabel="PM3"
          marker={markerVsPm1(s.pm3, s.pm1)}
        />
        {s.learningGain === true && (
          <span
            title="FAST learning gain met (PM3 vs prior-year PM3)"
            aria-label="FAST learning gain met"
            style={lgCheckStyle}
          >
            ✓
          </span>
        )}
      </span>
    ),
  },
];

// Shared additive metric columns for the Insights drill-downs (Academics
// band drawer + Academic Trajectories). Renders Days Absent, approximate
// attendance % (estimate — see the drawer subtitle note), points to the
// next FAST sub-level, and points to proficiency (Level 3). Callers append
// these to their base PM columns so the two surfaces stay identical.
export const INSIGHTS_METRIC_COLUMNS: ScoreColumn[] = [
  {
    key: "daysAbsent",
    label: "Days Abs",
    render: (s) => (s.daysAbsent != null ? s.daysAbsent : "—"),
  },
  {
    key: "attendancePct",
    label: "Att %*",
    render: (s) => (s.attendancePct != null ? `${s.attendancePct}%` : "—"),
  },
  {
    key: "ptsToNextLevel",
    label: "→ Next",
    render: (s) => (s.ptsToNextLevel != null ? s.ptsToNextLevel : "—"),
  },
  {
    key: "ptsToProficient",
    label: "→ L3",
    render: (s) =>
      s.ptsToProficient == null
        ? "—"
        : s.ptsToProficient === 0
          ? "✓"
          : s.ptsToProficient,
  },
];

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  students: Student[];
  truncated?: boolean;
  total?: number;
  loading?: boolean;
  error?: string;
  onClose: () => void;
  onOpenProfile: (studentId: string) => void;
  // Optional column config for the score table — defaults to PM1/PM3
  // columns. Different dashboards can pass different columns, including
  // custom-rendered metric columns (attendance, FAST gaps).
  scoreColumns?: ScoreColumn[];
  // Optional CSV download button rendered in the drawer header. Caller
  // generates the CSV (client- or server-side) and triggers the download
  // — drawer just exposes the button slot so it stays generic.
  onDownloadCsv?: () => void;
  // When true, renders the "Show: Level | Scale score" toggle in the
  // header and drives every FastScorePill in the table from it. Opt-in so
  // callers that don't render the PM level pills get no stray toggle.
  showScoreToggle?: boolean;
}

const DEFAULT_COLUMNS: ScoreColumn[] = [
  { key: "pm1", label: "PM1" },
  { key: "pm3", label: "PM3" },
];

export default function BandStudentsDrawer({
  open,
  title,
  subtitle,
  students,
  truncated,
  total,
  loading,
  error,
  onClose,
  onOpenProfile,
  scoreColumns = DEFAULT_COLUMNS,
  onDownloadCsv,
  showScoreToggle,
}: Props) {
  // Surface-wide pill face ("Level" by default). Only meaningful when
  // showScoreToggle is on; otherwise the provider just supplies the
  // default so any pills still render their level face.
  const [pillView, setPillView] = useState<PillView>("level");
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onClose} role="dialog" aria-modal="true">
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1.05rem" }}>{title}</h3>
            {subtitle && (
              <p
                style={{
                  margin: "0.2rem 0 0",
                  color: "var(--text-subtle)",
                  fontSize: "0.85rem",
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {showScoreToggle && students.length > 0 && (
              <PillViewToggle value={pillView} onChange={setPillView} />
            )}
            {onDownloadCsv && students.length > 0 && (
              <button
                type="button"
                onClick={onDownloadCsv}
                title="Download these students as CSV"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  border: "1px solid #047857",
                  background: "#059669",
                  color: "white",
                }}
              >
                ⬇ CSV
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={closeBtnStyle}
            >
              ×
            </button>
          </div>
        </div>

        <PillViewContext.Provider value={pillView}>
        <div style={bodyStyle}>
          {loading && (
            <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
          )}
          {error && (
            <p style={{ color: "var(--danger, #dc2626)" }}>{error}</p>
          )}
          {!loading && !error && students.length === 0 && (
            <p style={{ color: "var(--text-subtle)" }}>
              No students match this band with the current filters.
            </p>
          )}
          {!loading && !error && students.length > 0 && (
            <>
              <p style={countLineStyle}>
                {total != null
                  ? `${total} student${total === 1 ? "" : "s"}`
                  : `${students.length} student${students.length === 1 ? "" : "s"}`}
                {truncated ? ` — showing first ${students.length}` : ""}
              </p>
              <style>{`.bsd-row:hover { background: #f8fafc; }`}</style>
              <table className="pulse-table" style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Student</th>
                    <th style={thStyleNum}>Grade</th>
                    {scoreColumns.map((c) => (
                      <th key={c.key} style={thStyleNum}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr
                      key={s.studentId}
                      className="bsd-row"
                      onClick={() => onOpenProfile(s.studentId)}
                      style={{ cursor: "pointer" }}
                      title="Open Student Profile"
                    >
                      <td style={tdStyle}>
                        <button
                          type="button"
                          onClick={(e) => {
                            // Row already handles open-profile; stop here so
                            // the name click doesn't fire it twice.
                            e.stopPropagation();
                            onOpenProfile(s.studentId);
                          }}
                          style={linkBtnStyle}
                        >
                          {s.studentName}
                        </button>
                        {s.safetyPlan && (
                          <span
                            style={spPillStyle}
                            title={`Active safety plan${
                              s.safetyPlan.itemCount
                                ? ` — ${s.safetyPlan.itemCount} item${
                                    s.safetyPlan.itemCount === 1 ? "" : "s"
                                  }`
                                : ""
                            }`}
                            aria-label="Active safety plan"
                          >
                            SP
                          </span>
                        )}
                        {(s.programPill ||
                          s.mtssPill ||
                          s.ell ||
                          s.bqEla ||
                          s.bqMath) && (
                          <span style={pillRowStyle}>
                            {s.programPill && (
                              <span style={pillStyle(PILL_TONES.program)}>
                                {s.programPill}
                              </span>
                            )}
                            {s.ell && (
                              <span
                                style={pillStyle(PILL_TONES.ell)}
                                title="English Language Learner"
                              >
                                ELL
                              </span>
                            )}
                            {s.mtssPill && (
                              <span
                                style={pillStyle(
                                  s.mtssPill === "Tier 3"
                                    ? PILL_TONES.tier3
                                    : PILL_TONES.tier2,
                                )}
                              >
                                {s.mtssPill}
                              </span>
                            )}
                            {s.bqEla && (
                              <span style={pillStyle(PILL_TONES.bq)}>
                                BQ ELA
                              </span>
                            )}
                            {s.bqMath && (
                              <span style={pillStyle(PILL_TONES.bq)}>
                                BQ Math
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td style={tdStyleNum}>
                        {s.grade != null
                          ? s.grade === 0
                            ? "K"
                            : s.grade
                          : "—"}
                      </td>
                      {scoreColumns.map((c) => {
                        const v = (s as unknown as Record<string, unknown>)[
                          c.key
                        ];
                        return (
                          <td
                            key={c.key}
                            style={tdStyleNum}
                            // Score cells host click-to-flip FAST pills; stop
                            // the click from bubbling to the row's
                            // open-profile handler so flipping a pill never
                            // navigates away.
                            onClick={(e) => e.stopPropagation()}
                          >
                            {c.render
                              ? c.render(s)
                              : v != null
                                ? (v as React.ReactNode)
                                : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        </PillViewContext.Provider>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  zIndex: 1000,
  display: "flex",
  justifyContent: "flex-end",
};

const panelStyle: React.CSSProperties = {
  width: "min(860px, 100%)",
  background: "var(--surface, #0f172a)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "-8px 0 24px rgba(0,0,0,0.4)",
  display: "flex",
  flexDirection: "column",
  maxHeight: "100vh",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  padding: "1rem 1.1rem",
  borderBottom: "1px solid var(--border)",
};

const closeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text)",
  fontSize: "1.6rem",
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 0.25rem",
};

const bodyStyle: React.CSSProperties = {
  padding: "0.9rem 1.1rem",
  overflowY: "auto",
  flex: 1,
};

const countLineStyle: React.CSSProperties = {
  margin: "0 0 0.6rem",
  color: "var(--text-subtle)",
  fontSize: "0.85rem",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-subtle)",
  fontWeight: 600,
};

const thStyleNum: React.CSSProperties = {
  ...thStyle,
  textAlign: "right",
};

const tdStyle: React.CSSProperties = {
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--border)",
};

const tdStyleNum: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
};

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#2563eb",
  cursor: "pointer",
  padding: 0,
  font: "inherit",
  textAlign: "left",
};

const pillRowStyle: React.CSSProperties = {
  display: "inline-flex",
  flexWrap: "wrap",
  gap: 4,
  marginLeft: 6,
  verticalAlign: "middle",
};

const PILL_TONES = {
  // Program (ESE / 504) — slate so it reads as a status, not a risk.
  program: { bg: "#f1f5f9", fg: "#334155", border: "#cbd5e1" },
  // Tier 2+ — amber (watch). Tier 3 — red (urgent).
  tier2: { bg: "#fef3c7", fg: "#92400e", border: "#fde68a" },
  tier3: { bg: "#fee2e2", fg: "#b91c1c", border: "#fecaca" },
  // BQ = "lowest 25% prior-year FAST" — violet to match insights accent.
  bq: { bg: "#ede9fe", fg: "#5b21b6", border: "#ddd6fe" },
  // ELL — green, matching the Teacher Roster program chip palette.
  ell: { bg: "#dcfce7", fg: "#14532d", border: "#bbf7d0" },
} as const;

// Solid-red "SP" indicator shown right after the name when a student has an
// active safety plan — mirrors the Teacher Roster SafetyPlanPill so the cue
// reads identically across surfaces.
const spPillStyle: React.CSSProperties = {
  display: "inline-block",
  marginLeft: 6,
  padding: "1px 7px",
  borderRadius: 999,
  background: "#dc2626",
  color: "#fff",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.04em",
  lineHeight: 1.4,
  verticalAlign: "middle",
  whiteSpace: "nowrap",
};

// Green check appended to the PM3 pill when the student met the FAST
// learning gain (PM3 vs prior-year PM3) — same green-check cue as the
// Teacher Roster.
const lgCheckStyle: React.CSSProperties = {
  color: "#16a34a",
  fontSize: 13,
  fontWeight: 900,
  lineHeight: 1,
};

function pillStyle(tone: { bg: string; fg: string; border: string }): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1.4,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    background: tone.bg,
    color: tone.fg,
    border: `1px solid ${tone.border}`,
    whiteSpace: "nowrap",
  };
}
