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

import { Fragment, useEffect, useMemo, useState } from "react";
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
  // Invisible Student Finder signals (server-computed). isInvisible =
  // 0 non-voided PBIS recognitions in the school's invisibleDays
  // window. mtssTier = highest active MTSS plan tier, or null.
  isInvisible: boolean;
  mtssTier: number | null;
  // Whole-child program flags. Source of truth is the SIS / roster
  // import; rendered as small chips in the Programs column.
  ese: boolean;
  is504: boolean;
  ell: boolean;
  // Active accommodations (no removedAt) joined to the school catalog
  // so the Programs hover popover can group + color them by category.
  // Empty array when the student has none.
  accommodations: Array<{ name: string; category: string }>;
}

interface RosterResponse {
  teacher: { id: number; displayName: string | null };
  availablePeriods: number[];
  selectedPeriod: number | null;
  // Days of school used for the invisible-student window (mirrors PBIS
  // Needs Attention so the teacher sees the same definition).
  invisibleDays?: number;
  students: RosterRow[];
}

interface Props {
  isCoreTeam: boolean;
  defaultTeacherId: number | null;
  onBack?: () => void;
  // When provided, each row shows a small "Spider" pill next to the
  // student name that opens the Insights → Student Profile (the
  // whole-child radar). Safe to show to everyone who can reach this
  // page: the server endpoint /insights/students/:id/profile accepts
  // the "core", "roster", and "trusted-adult" visibility paths. Regular
  // teachers can only view their OWN roster (the teacher-switch
  // dropdown is gated on isCoreTeam), so every row they see is in
  // their visibility set by definition. Core team / admins always pass
  // the visibility check on every row. Caller is responsible for
  // navigation + back-routing.
  onOpenSpider?: (studentId: string) => void;
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

// Pastel fill + dark text/stroke for the bucket icon. The earlier
// solid-color fill with white text didn't have enough contrast for the
// gap number to be readable at any size, so the icon now uses a tinted
// pail with the matching dark color for the stroke and number.
const BUCKET_FILL: Record<"green" | "orange" | "red", string> = {
  green: "#dcfce7",
  orange: "#fef3c7",
  red: "#fee2e2",
};
const BUCKET_INK: Record<"green" | "orange" | "red", string> = {
  green: "#14532d",
  orange: "#78350f",
  red: "#7f1d1d",
};

// Click-to-flip pill. Default face shows the FAST sub-level; clicking
// (or focusing + pressing Enter/Space) flips it to show the raw scale
// score. Each pill manages its own flipped state so users can pop open
// just the cells they care about without losing the rest of the table.
function ScorePill({
  score,
  placement,
  pmLabel,
}: {
  score: number | null;
  placement: Placement | null;
  pmLabel: string;
}) {
  const [flipped, setFlipped] = useState(false);
  // Pills sized to roughly match the 44px bucket icon for a consistent
  // visual rhythm across the row. Raw scale scores can be 3 digits, so
  // minWidth needs to accommodate that without wrapping.
  if (score == null || placement == null) {
    return (
      <span
        title={`${pmLabel}: no score`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 44,
          height: 36,
          padding: "0 10px",
          borderRadius: 8,
          background: "#e5e7eb",
          color: "#6b7280",
          fontSize: 14,
          textAlign: "center",
        }}
      >
        —
      </span>
    );
  }
  const tooltip = `${pmLabel} • Level ${placement.subLevel} • Scale score ${score} (click to flip)`;
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={flipped}
      onClick={() => setFlipped((f) => !f)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 44,
        height: 36,
        padding: "0 10px",
        borderRadius: 8,
        border: "none",
        background: LEVEL_BG[placement.level],
        color: LEVEL_FG[placement.level],
        fontSize: 16,
        fontWeight: 700,
        textAlign: "center",
        cursor: "pointer",
        fontFamily: "inherit",
        lineHeight: 1,
      }}
    >
      {flipped ? score : placement.subLevel}
    </button>
  );
}

// Pail-shaped SVG bucket. Pastel fill + dark stroke + dark number for
// readability — solid backgrounds with white text read poorly,
// especially at the previous 22px size. Now sized at 44px (≈ 2× the
// original) so the gap number is comfortably legible.
const BUCKET_PX = 44;
function BucketIcon({ bucket }: { bucket: Bucket }) {
  if (bucket.targetScore == null || bucket.color == null) return null;
  const gap = bucket.gap ?? 0;
  const label =
    gap <= 0
      ? `At/above target (target ${bucket.targetScore})`
      : `${gap} pt${gap === 1 ? "" : "s"} to next level (target ${bucket.targetScore})`;
  const fill = BUCKET_FILL[bucket.color];
  const ink = BUCKET_INK[bucket.color];
  const overlay = gap <= 0 ? "✓" : String(Math.abs(gap));
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        position: "relative",
        display: "inline-block",
        width: BUCKET_PX,
        height: BUCKET_PX,
        lineHeight: 0,
      }}
    >
      <svg
        width={BUCKET_PX}
        height={BUCKET_PX}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        {/* Handle arc above the rim. */}
        <path
          d="M7 6 C 8.5 3, 15.5 3, 17 6"
          fill="none"
          stroke={ink}
          strokeWidth={1.4}
          strokeLinecap="round"
        />
        {/* Pail body — wider rim, narrower base, dark outline. */}
        <path
          d="M5.5 7 H 18.5 L 17 20 H 7 Z"
          fill={fill}
          stroke={ink}
          strokeWidth={1.2}
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
          // Nudge the label down so it sits in the body of the pail
          // rather than on top of the handle. Scales with icon size.
          paddingTop: BUCKET_PX * 0.18,
          color: ink,
          // Smaller, less dominant gap number — the pail is the focal
          // shape; the digit is supplemental.
          fontSize: Math.round(BUCKET_PX * 0.28),
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {overlay}
      </span>
    </span>
  );
}

// Eye-with-slash icon used to flag "invisible" students — those who
// have received zero non-voided PBIS recognitions in the school's
// invisible-student window. The same shape is used for every tier; we
// vary the color and add a small superscript ("2"/"3") for students
// who also have an active MTSS plan at that tier so they read as a
// "more urgent" version of the same indicator.
function InvisibleEyeIcon({
  tier,
  windowDays,
}: {
  tier: number | null;
  windowDays: number | null;
}) {
  // Color encodes severity. Badge ink is intentionally dark so the
  // small "2"/"3" stays readable against the orange/red fill (white
  // text fails WCAG contrast on #f59e0b at this size).
  let color = "#6b7280"; // gray default — invisible, no MTSS plan
  let badgeInk = "#fff";
  let badge: string | null = null;
  if (tier === 2) {
    color = "#f59e0b"; // orange — Tier 2
    badgeInk = "#78350f"; // dark amber for contrast
    badge = "2";
  } else if (tier && tier >= 3) {
    color = "#dc2626"; // red — Tier 3+
    badgeInk = "#7f1d1d"; // dark red for contrast
    badge = "3";
  }
  const baseLabel =
    windowDays != null
      ? `Invisible — 0 PBIS recognitions in the last ${windowDays} school days`
      : "Invisible — 0 recent PBIS recognitions";
  const tierLabel =
    tier && tier >= 2 ? ` • Active MTSS Tier ${tier} plan` : "";
  const label = `${baseLabel}${tierLabel}`;
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
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Eye outline + pupil + diagonal slash */}
        <path d="M2 12 C 5 6, 9 4, 12 4 C 15 4, 19 6, 22 12 C 19 18, 15 20, 12 20 C 9 20, 5 18, 2 12 Z" />
        <circle cx="12" cy="12" r="3" />
        <line x1="3" y1="3" x2="21" y2="21" />
      </svg>
      {badge && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -4,
            right: -6,
            minWidth: 12,
            height: 12,
            padding: "0 3px",
            borderRadius: 6,
            background: color,
            color: badgeInk,
            fontSize: 9,
            fontWeight: 800,
            lineHeight: "12px",
            textAlign: "center",
          }}
        >
          {badge}
        </span>
      )}
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
// Vertical divider drawn on the FIRST sub-cell of each subject group
// (and on the no-chart placeholder). Pairs with the matching divider in
// the table header so the column boundary runs cleanly top-to-bottom.
const GROUP_DIVIDER: React.CSSProperties = {
  borderLeft: "1px solid #e5e7eb",
};

function SubjectCells({
  block,
  subjectLabel,
  showLg,
  showPm3,
  showPm1,
  showPm2,
}: {
  block: SubjectBlock;
  subjectLabel: string;
  showLg: boolean;
  showPm3: boolean;
  showPm1: boolean;
  showPm2: boolean;
}) {
  // colspan shrinks to match the actually-rendered cells so the "n/a"
  // row still exactly fills the subject group.
  const groupCols =
    (showPm3 ? 1 : 0) +
    (showPm1 ? 1 : 0) +
    (showPm2 ? 1 : 0) +
    (showLg ? 1 : 0);
  if (block.noChart) {
    if (groupCols === 0) return null;
    return (
      <td
        colSpan={groupCols}
        style={{
          padding: "6px 10px",
          color: "#9ca3af",
          fontSize: 12,
          textAlign: "center",
          ...GROUP_DIVIDER,
        }}
      >
        n/a
      </td>
    );
  }
  const cell: React.CSSProperties = {
    padding: "6px 6px",
    textAlign: "center",
  };
  // Per product preference, PM3 is the most-recent / most important
  // score and renders first, followed by the older PM1 and PM2, then
  // the LG bucket. The first visible cell carries the group divider.
  let dividerUsed = false;
  const dividerStyle = (): React.CSSProperties => {
    if (dividerUsed) return cell;
    dividerUsed = true;
    return { ...cell, ...GROUP_DIVIDER };
  };
  return (
    <>
      {showPm3 && (
        <td style={dividerStyle()}>
          <ScorePill
            score={block.pm3}
            placement={block.pm3Placement}
            pmLabel={`${subjectLabel} PM3`}
          />
        </td>
      )}
      {showPm1 && (
        <td style={dividerStyle()}>
          <ScorePill
            score={block.pm1}
            placement={block.pm1Placement}
            pmLabel={`${subjectLabel} PM1`}
          />
        </td>
      )}
      {showPm2 && (
        <td style={dividerStyle()}>
          <ScorePill
            score={block.pm2}
            placement={block.pm2Placement}
            pmLabel={`${subjectLabel} PM2`}
          />
        </td>
      )}
      {showLg && (
        <td style={dividerStyle()}>
          <BucketCell bucket={block.bucket} />
        </td>
      )}
    </>
  );
}

// Compact pill for one whole-child program flag. Colors are chosen so
// the three chips are visually distinct from the BQ pill (dark brown)
// and from each other while staying calm enough not to dominate the
// row. Title text spells the abbreviation out for screen readers.
const PROGRAM_META: Record<
  "ese" | "504" | "ell",
  { label: string; bg: string; fg: string; title: string }
> = {
  ese: {
    label: "ESE",
    bg: "#dbeafe",
    fg: "#1e3a8a",
    title: "Exceptional Student Education plan",
  },
  "504": {
    label: "504",
    bg: "#ede9fe",
    fg: "#5b21b6",
    title: "Section 504 plan",
  },
  ell: {
    label: "ELL",
    bg: "#dcfce7",
    fg: "#14532d",
    title: "English Language Learner",
  },
};

function ProgramChip({ kind }: { kind: "ese" | "504" | "ell" }) {
  const meta = PROGRAM_META[kind];
  return (
    <span
      title={meta.title}
      aria-label={meta.title}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 6,
        background: meta.bg,
        color: meta.fg,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.2,
      }}
    >
      {meta.label}
    </span>
  );
}

function ProgramPills({ row }: { row: RosterRow }) {
  const chips: Array<"ese" | "504" | "ell"> = [];
  if (row.ese) chips.push("ese");
  if (row.is504) chips.push("504");
  if (row.ell) chips.push("ell");
  // No flags AND no accommodations: render the placeholder em-dash so
  // the row stays aligned. (When the student HAS accommodations but
  // none of the three program flags, we still want to show a hover
  // affordance — handled in the parent <td>.)
  if (chips.length === 0 && row.accommodations.length === 0) {
    return <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>;
  }
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {chips.map((c) => (
        <ProgramChip key={c} kind={c} />
      ))}
      {/* If the only signal is "has accommodations" with no program
          flag, surface a soft "Acc" chip so there's something to hover
          on. Same pastel + dark-ink treatment as the program chips. */}
      {chips.length === 0 && row.accommodations.length > 0 && (
        <span
          title={`${row.accommodations.length} active accommodation${
            row.accommodations.length === 1 ? "" : "s"
          } — hover to view`}
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 6,
            background: "#f1f5f9",
            color: "#334155",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.2,
          }}
        >
          Acc
        </span>
      )}
    </div>
  );
}

function AccommodationsPopover({
  row,
}: {
  row: RosterRow;
}) {
  // The popover lists accommodations as a flat bullet list. We
  // intentionally do NOT group by the accommodation's school-catalog
  // category here — that field describes what plan TYPE the
  // accommodation is typically used for at the school level, NOT
  // which plan THIS student is on. Showing "504" as a header above
  // an ESE student's accommodations was misleading. Instead, we
  // show the student's actual program badges (from row.ese /
  // row.is504 / row.ell) at the top, then list their accommodations
  // alphabetically.
  const programBadges: Array<{ label: string; bg: string; fg: string }> = [];
  if (row.ese)
    programBadges.push({ label: "ESE", bg: "#dbeafe", fg: "#1e3a8a" });
  if (row.is504)
    programBadges.push({ label: "504", bg: "#ede9fe", fg: "#5b21b6" });
  if (row.ell)
    programBadges.push({ label: "ELL", bg: "#dcfce7", fg: "#14532d" });

  const sorted = [...row.accommodations].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <div
      role="tooltip"
      style={{
        position: "absolute",
        top: "100%",
        left: 8,
        marginTop: 4,
        zIndex: 5,
        background: "white",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        padding: "0.5rem 0.7rem",
        boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
        minWidth: 240,
        maxWidth: 360,
        color: "#111827",
        textAlign: "left",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#6b7280",
          marginBottom: programBadges.length > 0 ? 4 : 6,
        }}
      >
        Accommodations for {row.firstName} {row.lastName}
      </div>
      {programBadges.length > 0 && (
        <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
          {programBadges.map((b) => (
            <span
              key={b.label}
              style={{
                display: "inline-block",
                padding: "2px 8px",
                borderRadius: 6,
                background: b.bg,
                color: b.fg,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.2,
              }}
            >
              {b.label}
            </span>
          ))}
        </div>
      )}
      <ul
        style={{
          margin: 0,
          paddingLeft: 16,
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {sorted.map((a) => (
          <li key={a.name}>{a.name}</li>
        ))}
      </ul>
    </div>
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
  onOpenSpider,
}: Props) {
  const [teachers, setTeachers] = useState<TeacherOpt[]>([]);
  const [teacherId, setTeacherId] = useState<number | null>(
    defaultTeacherId,
  );
  const [period, setPeriod] = useState<number | null>(null);
  const [data, setData] = useState<RosterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Which student's Programs cell is currently being hovered (or has
  // been click-pinned). Mirrors the Accommodations Class View pattern
  // so a teacher can either glance via hover or pin the popover open
  // by clicking. Null = no popover.
  const [programHoverId, setProgramHoverId] = useState<string | null>(null);

  // Per-user view toggles. Each maps to one optional column. Defaults
  // to all-on; persisted to localStorage so the teacher's preference
  // survives reloads. Bumped key to v2 since we added pm-level toggles.
  type Visibility = {
    lg: boolean;
    bq: boolean;
    invisible: boolean;
    pm3: boolean;
    pm1: boolean;
    pm2: boolean;
    programs: boolean;
  };
  const VIS_DEFAULT: Visibility = {
    lg: true,
    bq: true,
    invisible: true,
    pm3: true,
    pm1: true,
    pm2: true,
    programs: true,
  };
  // Bumped to v3 because the Programs (ESE / 504 / ELL) toggle was
  // added; previous keys are missing the field but the `??` fallbacks
  // below default it to true, so old saved prefs upgrade cleanly.
  const VIS_KEY = "teacherRoster.visibility.v3";
  const [visibility, setVisibility] = useState<Visibility>(() => {
    if (typeof window === "undefined") return VIS_DEFAULT;
    try {
      const raw = window.localStorage.getItem(VIS_KEY);
      if (!raw) return VIS_DEFAULT;
      const parsed = JSON.parse(raw) as Partial<Visibility>;
      return {
        lg: parsed.lg ?? true,
        bq: parsed.bq ?? true,
        invisible: parsed.invisible ?? true,
        pm3: parsed.pm3 ?? true,
        pm1: parsed.pm1 ?? true,
        pm2: parsed.pm2 ?? true,
        programs: parsed.programs ?? true,
      };
    } catch {
      return VIS_DEFAULT;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(VIS_KEY, JSON.stringify(visibility));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [visibility]);
  const toggleVis = (key: keyof Visibility) =>
    setVisibility((v) => ({ ...v, [key]: !v[key] }));

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
    const ese = data.students.filter((s) => s.ese).length;
    const five04 = data.students.filter((s) => s.is504).length;
    const ell = data.students.filter((s) => s.ell).length;
    return { total, elaBq, mathBq, ese, five04, ell };
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
        <span>Pills: PM3 / PM1 / PM2 (sub-level on current chart; PM3 on prior-grade chart)</span>
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Programs:
          <ProgramChip kind="ese" />
          <ProgramChip kind="504" />
          <ProgramChip kind="ell" />
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InvisibleEyeIcon tier={null} windowDays={data?.invisibleDays ?? null} />
          Invisible (0 PBIS in last {data?.invisibleDays ?? 10} school days)
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InvisibleEyeIcon tier={2} windowDays={data?.invisibleDays ?? null} />
          + active MTSS Tier 2
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InvisibleEyeIcon tier={3} windowDays={data?.invisibleDays ?? null} />
          + active MTSS Tier 3
        </span>
      </div>

      {/* View toggles — let teachers hide optional columns. PM pills
          stay always-on since they're the core data. Preferences are
          remembered per browser. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 12,
          padding: "6px 10px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          fontSize: 12,
          color: "#374151",
        }}
      >
        <span style={{ fontWeight: 600 }}>Show:</span>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the PM3 column for both ELA and Math"
        >
          <input
            type="checkbox"
            checked={visibility.pm3}
            onChange={() => toggleVis("pm3")}
          />
          PM3
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the PM1 column for both ELA and Math"
        >
          <input
            type="checkbox"
            checked={visibility.pm1}
            onChange={() => toggleVis("pm1")}
          />
          PM1
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the PM2 column for both ELA and Math"
        >
          <input
            type="checkbox"
            checked={visibility.pm2}
            onChange={() => toggleVis("pm2")}
          />
          PM2
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the LG (learning-gain bucket) column for both ELA and Math"
        >
          <input
            type="checkbox"
            checked={visibility.lg}
            onChange={() => toggleVis("lg")}
          />
          LG bucket
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the Bottom-Quartile column"
        >
          <input
            type="checkbox"
            checked={visibility.bq}
            onChange={() => toggleVis("bq")}
          />
          BQ flag
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the Programs column (ESE / 504 / ELL)"
        >
          <input
            type="checkbox"
            checked={visibility.programs}
            onChange={() => toggleVis("programs")}
          />
          Programs
        </label>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the invisible-student eye icon column"
        >
          <input
            type="checkbox"
            checked={visibility.invisible}
            onChange={() => toggleVis("invisible")}
          />
          Invisible-student eye
        </label>
      </div>

      {summary && (
        <div style={{ fontSize: 13, color: "#374151", marginBottom: 12 }}>
          {summary.total} student{summary.total === 1 ? "" : "s"} •{" "}
          {summary.elaBq} ELA BQ • {summary.mathBq} Math BQ • {summary.ese} ESE
          {" • "}
          {summary.five04} 504 • {summary.ell} ELL
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
                  subject label. Vertical dividers run between
                  Grade↔ELA and ELA↔Math; the matching borderLeft on the
                  first cell of each subject group in the body extends
                  the divider down through every row. */}
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                {/* Eye-icon column. Header is intentionally blank — the
                    legend (and the icon's tooltip) carry the meaning. */}
                {visibility.invisible && (
                  <th
                    rowSpan={2}
                    style={{ padding: "8px 6px", verticalAlign: "bottom", width: 32 }}
                    aria-label="Invisible-student indicator"
                  />
                )}
                <th rowSpan={2} style={{ padding: "8px 10px", verticalAlign: "bottom" }}>
                  Student
                </th>
                {visibility.programs && (
                  <th
                    rowSpan={2}
                    style={{ padding: "8px 10px", verticalAlign: "bottom" }}
                    title="ESE / 504 / ELL designations from the SIS"
                  >
                    Programs
                  </th>
                )}
                <th rowSpan={2} style={{ padding: "8px 10px", verticalAlign: "bottom" }}>
                  Grade
                </th>
                {(() => {
                  const groupCols =
                    (visibility.pm3 ? 1 : 0) +
                    (visibility.pm1 ? 1 : 0) +
                    (visibility.pm2 ? 1 : 0) +
                    (visibility.lg ? 1 : 0);
                  if (groupCols === 0) return null;
                  return (
                    <>
                      <th
                        colSpan={groupCols}
                        style={{
                          padding: "8px 10px",
                          textAlign: "center",
                          ...GROUP_DIVIDER,
                        }}
                      >
                        ELA
                      </th>
                      <th
                        colSpan={groupCols}
                        style={{
                          padding: "8px 10px",
                          textAlign: "center",
                          ...GROUP_DIVIDER,
                        }}
                      >
                        Math
                      </th>
                    </>
                  );
                })()}
                {visibility.bq && (
                  <th rowSpan={2} style={{ padding: "8px 10px", verticalAlign: "bottom" }}>
                    BQ
                  </th>
                )}
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
                {(["ELA", "Math"] as const).map((group) => {
                  // First visible cell in each group carries the divider.
                  let divUsed = false;
                  const div = (): React.CSSProperties => {
                    const base: React.CSSProperties = {
                      padding: "4px 6px",
                      fontWeight: 600,
                    };
                    if (divUsed) return base;
                    divUsed = true;
                    return { ...base, ...GROUP_DIVIDER };
                  };
                  return (
                    <Fragment key={group}>
                      {visibility.pm3 && <th style={div()}>PM3</th>}
                      {visibility.pm1 && <th style={div()}>PM1</th>}
                      {visibility.pm2 && <th style={div()}>PM2</th>}
                      {visibility.lg && <th style={div()}>LG</th>}
                    </Fragment>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.students.map((row, idx) => (
                <tr
                  key={row.studentId}
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    // Subtle zebra striping for easier row tracking
                    // across the wide PM/LG columns.
                    background: idx % 2 === 1 ? "#f9fafb" : "transparent",
                  }}
                >
                  {visibility.invisible && (
                    <td
                      style={{
                        padding: "6px 6px",
                        width: 32,
                        textAlign: "center",
                      }}
                    >
                      {row.isInvisible && (
                        <InvisibleEyeIcon
                          tier={row.mtssTier}
                          windowDays={data.invisibleDays ?? null}
                        />
                      )}
                    </td>
                  )}
                  <td style={{ padding: "6px 10px" }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>
                        {row.lastName}, {row.firstName}
                      </span>
                      {onOpenSpider && (
                        <button
                          type="button"
                          onClick={() => onOpenSpider(row.studentId)}
                          title={`Open whole-child radar for ${row.firstName} ${row.lastName}`}
                          aria-label={`Open whole-child radar for ${row.firstName} ${row.lastName}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "2px 8px",
                            borderRadius: 999,
                            border: "1px solid #c7d2fe",
                            background: "#eef2ff",
                            color: "#3730a3",
                            fontSize: 11,
                            fontWeight: 600,
                            lineHeight: 1.2,
                            cursor: "pointer",
                          }}
                        >
                          <span aria-hidden="true">🕸️</span>
                          <span>Spider</span>
                        </button>
                      )}
                    </span>
                  </td>
                  {visibility.programs && (
                    <td
                      style={{
                        padding: "6px 10px",
                        position: "relative",
                        cursor:
                          row.accommodations.length > 0 ? "pointer" : "default",
                      }}
                      onMouseEnter={() => {
                        if (row.accommodations.length > 0) {
                          setProgramHoverId(row.studentId);
                        }
                      }}
                      onMouseLeave={() =>
                        setProgramHoverId((cur) =>
                          cur === row.studentId ? null : cur,
                        )
                      }
                      onClick={() =>
                        setProgramHoverId((cur) =>
                          cur === row.studentId
                            ? null
                            : row.accommodations.length > 0
                              ? row.studentId
                              : cur,
                        )
                      }
                    >
                      <ProgramPills row={row} />
                      {programHoverId === row.studentId &&
                        row.accommodations.length > 0 && (
                          <AccommodationsPopover row={row} />
                        )}
                    </td>
                  )}
                  <td style={{ padding: "6px 10px" }}>{row.grade}</td>
                  <SubjectCells
                    block={row.ela}
                    subjectLabel="ELA"
                    showLg={visibility.lg}
                    showPm3={visibility.pm3}
                    showPm1={visibility.pm1}
                    showPm2={visibility.pm2}
                  />
                  <SubjectCells
                    block={row.math}
                    subjectLabel="Math"
                    showLg={visibility.lg}
                    showPm3={visibility.pm3}
                    showPm1={visibility.pm1}
                    showPm2={visibility.pm2}
                  />
                  {visibility.bq && (
                    <td style={{ padding: "6px 10px" }}>
                      <BqPills row={row} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
