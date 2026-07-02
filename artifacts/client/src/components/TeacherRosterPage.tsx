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

import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { authFetch } from "../lib/authToken";
import SuggestSeparationModal from "./SuggestSeparationModal";
import StudentPhoto from "./StudentPhoto";
import TeacherBenchmarksTab from "./TeacherBenchmarksTab";
import GroupInsightsTab from "./GroupInsightsTab";
import TeacherInstructionLogTab from "./TeacherInstructionLogTab";
import Tier3WeeklyForm from "./Tier3WeeklyForm";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";
import { LEVEL_BG, LEVEL_FG, PmDelta, nextStopCaption } from "./FastScorePill";
import { TeacherPicker } from "./TeacherPicker";
import { SelfDataChatModal, FollowupReminders } from "./DataChats";
import { type TeacherOpt } from "./teacherDepartments";

// Top-level tab in this page. "roster" is the original FAST PM
// pills + flags table; "benchmarks" is the FAST Phase 2 per-item
// mastery heatmap + bottom-3 tile.
type RosterTab = "roster" | "benchmarks" | "instruction" | "groupInsights";

interface Placement {
  level: 1 | 2 | 3 | 4 | 5;
  subLevel: string;
  // Points to the NEXT sub-level on the current-grade chart, and the
  // label of that next sub-level. Both null when the student is at L5
  // (no next stop) or when no current-grade chart exists. Rendered as a
  // small "+12 → L3 lo" caption under each PM pill so teachers see at a
  // glance what each student needs to climb the chart.
  gap?: number | null;
  nextStopLabel?: string | null;
}

type BucketColor = "red" | "orange" | "green" | "blue" | "purple";

interface Bucket {
  targetScore: number | null;
  gap: number | null;
  color: BucketColor | null;
  currentSubLevel: string | null;
  nextStopLabel: string | null;
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
  // Most-recent prior-year PM3 from the FL historical importer. Rendered
  // as the leftmost pill in the chronological story
  // Prior → PM1 → PM2 → PM3 → LG. Null when no historical row has been
  // uploaded for this (student, subject). Placement is computed against
  // the prior-grade chart on the server; null for EOC subjects (Algebra
  // 1 / Geometry) where the prior-grade chart doesn't apply.
  priorPm3: {
    schoolYear: string;
    pm3: number;
    placement: Placement | null;
  } | null;
  // Multi-year PM3 growth series (PM3-only), newest-first. `delta` is
  // the year-over-year change vs. the immediately-older year; null on
  // the oldest entry. Powers the expandable growth chip. FAST scale
  // scores are re-referenced per grade, so deltas are directional
  // signal only — never summed into a total.
  pm3History: Array<{
    schoolYear: string;
    pm3: number;
    delta: number | null;
  }>;
  // FAST Learning Gain (server-computed). When true the LG column
  // renders a green check instead of the bucket icon — the student
  // either moved up a performance level vs. prior-year PM3 or
  // maintained L3/L4/L5. false = decided "no LG" (bucket stays).
  // null = cannot decide (missing prior or current PM3, no chart,
  // no placement). See server-side `buildSubjectBlock` for the full
  // rule + Phase 1 caveats.
  learningGain: boolean | null;
  noChart: boolean;
}

interface SafetyPlanItem {
  label: string;
  active: boolean;
  note?: string;
}

interface SafetyPlanSummary {
  itemCount: number;
  items: SafetyPlanItem[];
  notes: string;
  updatedAt: string | null;
  updatedByName: string | null;
}

interface RosterRow {
  studentId: string;
  // District-level Local SIS ID (6-digit). Co-exists with FLEID; FLEID
  // remains canonical for FAST. Render this as the visible identifier
  // everywhere outside FAST screens.
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number | string;
  // Student photo (server-supplied). Renders as <StudentPhoto/>; falls
  // back to colored initials bubble when null OR consent=false.
  photoObjectKey?: string | null;
  photoConsent?: boolean;
  ela: SubjectBlock;
  math: SubjectBlock;
  safetyPlan: SafetyPlanSummary | null;
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
  // ISS / OSS today (Admin Hub surface). issToday is non-null when the
  // student is on ISS today (any source); ossToday is true on OSS days.
  // issAcks lists this teacher's already-recorded acknowledgements
  // (period + method) for today.
  issToday: { source: string; adminLogId: number | null } | null;
  ossToday: boolean;
  issAcks: Array<{ period: number; method: string }>;
  // Grades the student was retained in (ascending). Empty when none.
  // Drives the small black "R" pill rendered after the chain icon.
  retainedGrades: number[];
  // Additive read-only attendance (from the Eligibility Hub upload).
  // daysAbsent is the raw absence total; attendancePct is an ESTIMATE
  // (weekday denominator since the semester start). Null when missing.
  attendance?: {
    daysAbsent: number | null;
    daysTardy: number | null;
    attendancePct: number | null;
  } | null;
}

interface RosterResponse {
  teacher: { id: number; displayName: string | null };
  availablePeriods: number[];
  selectedPeriod: number | null;
  // Tier-aware invisible-student windows (school days), keyed by MTSS tier
  // ("1" = no active plan). Mirrors PBIS Needs Attention so the teacher
  // sees the same definition.
  invisibleDaysByTier?: { "1": number; "2": number; "3": number };
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
  // When provided, clicking the red "SP" pill calls this with the
  // studentId so the host can open the Safety Plan editor. When not
  // provided, the pill is still visible (everyone needs to know about
  // active safety plans) but is non-clickable — hover still shows the
  // contents popover.
  onOpenSafetyPlan?: (studentId: string) => void;
  // When provided, the Benchmarks tab's "Suggest small group" modal
  // shows a "Open in Class Composer" button that calls this. Gated by
  // the host (admin / Core Team only); regular teachers see the
  // suggested list but no composer handoff.
  onOpenClassComposer?: () => void;
  // Fires whenever the user picks a different teacher from the
  // dropdown. The host (App.tsx) uses this to remember the picked
  // teacher across page unmounts — e.g. when a SuperUser opens a
  // Student Profile (spider) and clicks Back, we want to land back on
  // the *picked* teacher's roster, not on the SuperUser's own (which
  // doesn't exist). For roles where the dropdown is locked to self,
  // this still fires once on first load and is harmless.
  onTeacherChange?: (teacherId: number) => void;
}

// Red "SP" pill that appears immediately after the student's name when
// they have an active safety plan. Hover (or focus) shows a popover
// listing the active items + notes — visible to every staff member who
// can see the roster.
function SafetyPlanPill({
  plan,
  studentName,
  onOpen,
}: {
  plan: SafetyPlanSummary;
  studentName: string;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const updated = plan.updatedAt
    ? new Date(plan.updatedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  const tooltip = `Active safety plan${updated ? ` — last updated ${updated}` : ""}${onOpen ? " (click to edit)" : ""}`;
  const Tag = onOpen ? "button" : "span";
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <Tag
        type={onOpen ? "button" : undefined}
        onClick={onOpen}
        title={tooltip}
        aria-label={tooltip}
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: 999,
          background: "#dc2626",
          color: "#fff",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.4,
          border: "none",
          cursor: onOpen ? "pointer" : "default",
          fontFamily: "inherit",
          lineHeight: 1.4,
        }}
      >
        SP
      </Tag>
      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            zIndex: 10,
            background: "white",
            border: "1px solid #fecaca",
            borderTop: "3px solid #dc2626",
            borderRadius: 6,
            padding: "0.55rem 0.75rem",
            boxShadow: "0 6px 18px rgba(0,0,0,0.14)",
            minWidth: 240,
            maxWidth: 360,
            color: "#111827",
            textAlign: "left",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#991b1b",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 6,
            }}
          >
            Safety plan — {studentName}
          </div>
          {plan.items.length === 0 ? (
            <div style={{ color: "#6b7280", fontSize: 12 }}>
              (No active items)
            </div>
          ) : (
            <ul
              style={{
                margin: 0,
                paddingLeft: 16,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {plan.items.map((it, i) => (
                <li key={`${it.label}-${i}`}>
                  {it.label}
                  {it.note ? (
                    <span style={{ color: "#6b7280" }}> — {it.note}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {plan.notes && (
            <div
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: "1px solid #f3f4f6",
                fontSize: 11,
                color: "#374151",
                whiteSpace: "pre-wrap",
              }}
            >
              {plan.notes}
            </div>
          )}
          {(plan.updatedAt || plan.updatedByName) && (
            <div
              style={{
                marginTop: 6,
                fontSize: 10,
                color: "#9ca3af",
              }}
            >
              Updated{" "}
              {plan.updatedAt
                ? new Date(plan.updatedAt).toLocaleDateString()
                : ""}
              {plan.updatedByName ? ` • ${plan.updatedByName}` : ""}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

// Level → background/foreground colors live in the shared FastScorePill
// module so the Roster pills and the Insights drill-down level pills can
// never silently diverge. Imported above as LEVEL_BG / LEVEL_FG.

// Pastel fill + dark text/stroke for the bucket icon, keyed to the
// student's CURRENT FAST level (per the FAST palette: L1 red, L2
// orange, L3 green, L4 blue, L5 purple). The earlier solid-color fill
// with white text didn't have enough contrast for the gap number to be
// readable at any size, so the icon uses a tinted pail with a matching
// dark stroke/number.
const BUCKET_FILL: Record<BucketColor, string> = {
  red: "#fee2e2",
  orange: "#fef3c7",
  green: "#dcfce7",
  blue: "#dbeafe",
  purple: "#ede9fe",
};
const BUCKET_INK: Record<BucketColor, string> = {
  red: "#7f1d1d",
  orange: "#78350f",
  green: "#14532d",
  blue: "#1e3a8a",
  purple: "#4c1d95",
};

// Roster-wide default for what every ScorePill shows on its front
// face. The toggle at the top of the Roster tab flips this for the
// whole page; individual pills can still be clicked to override on a
// case-by-case basis, but the next change to the global toggle
// re-syncs every pill to the new default so the page never gets
// stuck in a half-flipped state.
type PillView = "level" | "score";
const PillViewContext = createContext<PillView>("level");

// Click-to-flip pill. Default face is driven by PillViewContext
// (Roster-wide "Show: Level | Scale score" toggle); a per-pill click
// overrides locally so users can pop open just the cells they care
// about without losing the rest of the table. When the global view
// changes, the local override is cleared so every pill snaps back to
// the new default — otherwise stale overrides would silently
// contradict what the toggle says.
function ScorePill({
  score,
  placement,
  pmLabel,
}: {
  score: number | null;
  placement: Placement | null;
  pmLabel: string;
}) {
  const view = useContext(PillViewContext);
  const [override, setOverride] = useState<PillView | null>(null);
  useEffect(() => {
    setOverride(null);
  }, [view]);
  const effective: PillView = override ?? view;
  const flipped = effective === "score";
  // Pills sized to roughly match the 44px bucket icon for a consistent
  // visual rhythm across the row. Raw scale scores can be 3 digits, so
  // minWidth needs to accommodate that without wrapping.
  // All pill cells render with the same vertical envelope (pill +
  // reserved caption slot) so rows stay aligned even when some cells
  // have a "+12 → L3 lo" caption and adjacent cells don't.
  const CAPTION_SLOT_HEIGHT = 12;
  if (score == null || placement == null) {
    return (
      <span
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
        }}
      >
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
        <span aria-hidden style={{ height: CAPTION_SLOT_HEIGHT }} />
      </span>
    );
  }
  const tooltip = `${pmLabel} • Level ${placement.subLevel} • Scale score ${score} (click to flip)`;
  // Caption mirrors the FAST Benchmarks tab: "+12 → L3 lo" when there's
  // still climb available, "At {next}" once the student has met the next
  // sub-level, nothing when they're at L5 / no chart. Renders just below
  // the pill; adds ~12px of vertical space per row.
  const caption = nextStopCaption(placement.gap, placement.nextStopLabel);
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
      }}
    >
      <button
        type="button"
        title={tooltip}
        aria-label={tooltip}
        aria-pressed={flipped}
        onClick={() =>
          setOverride(effective === "level" ? "score" : "level")
        }
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
      <span
        aria-hidden={caption ? undefined : true}
        style={{
          minHeight: CAPTION_SLOT_HEIGHT,
          fontSize: 9,
          fontWeight: 600,
          color: caption?.color ?? "transparent",
          lineHeight: 1.1,
          whiteSpace: "nowrap",
        }}
      >
        {caption?.text ?? "\u00A0"}
      </span>
    </span>
  );
}

// Pail-shaped SVG bucket. Pastel fill + dark stroke + dark number for
// readability — solid backgrounds with white text read poorly,
// especially at the previous 22px size. Now sized at 44px (≈ 2× the
// original) so the gap number is comfortably legible.
const BUCKET_PX = 44;
function BucketIcon({ bucket }: { bucket: Bucket }) {
  if (bucket.color == null) return null;
  // L5 (top of chart) has no next stop, but we still want a colored
  // pail so the achievement is visible. Show a checkmark.
  const atTop = bucket.targetScore == null && bucket.currentSubLevel === "5";
  if (bucket.targetScore == null && !atTop) return null;
  const gap = bucket.gap ?? 0;
  const stop = bucket.nextStopLabel ?? "next level";
  const label = atTop
    ? "At top of chart (Level 5)"
    : gap <= 0
      ? `At/above ${stop} (target ${bucket.targetScore})`
      : `${gap} pt${gap === 1 ? "" : "s"} to ${stop} (target ${bucket.targetScore})`;
  const fill = BUCKET_FILL[bucket.color];
  const ink = BUCKET_INK[bucket.color];
  const overlay = atTop || gap <= 0 ? "✓" : String(Math.abs(gap));
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
// Monday (local) of the week containing `today`, as YYYY-MM-DD.
// Mirrors LogInterventionLauncher's helper so the roster pill opens the
// same week the bell-triggered form would.
function mondayOf(today: Date): string {
  const d = new Date(today);
  const dow = d.getDay();
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + shift);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

// Tier 3 MTSS pill shown on roster rows whose highest active plan is
// Tier 3. When the logged-in user is the assigned interventionist
// (`actionable`), the pill is a button that opens the weekly tracking
// form for that student; an amber count badge shows how many scheduled
// meeting days are still unscored this week. Otherwise it renders as a
// plain informational badge (e.g. Core Team viewing someone's roster).
function Tier3Pill({
  actionable,
  missingCount,
  studentName,
  onOpen,
}: {
  actionable: boolean;
  missingCount: number;
  studentName: string;
  onOpen: () => void;
}) {
  const behind = missingCount > 0;
  const label = actionable
    ? behind
      ? `Tier 3 weekly tracking for ${studentName} — ${missingCount} meeting ${
          missingCount === 1 ? "day" : "days"
        } unscored this week. Click to log.`
      : `Tier 3 weekly tracking for ${studentName} — up to date this week. Click to view/edit.`
    : `Active MTSS Tier 3 plan for ${studentName}`;
  const pillStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "1px 7px",
    borderRadius: 999,
    fontSize: "0.68rem",
    fontWeight: 700,
    lineHeight: 1.5,
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    whiteSpace: "nowrap",
  };
  const badge = behind ? (
    <span
      aria-hidden="true"
      style={{
        minWidth: 14,
        height: 14,
        padding: "0 3px",
        borderRadius: 7,
        background: "#dc2626",
        color: "#fff",
        fontSize: 9,
        fontWeight: 800,
        lineHeight: "14px",
        textAlign: "center",
      }}
    >
      {missingCount}
    </span>
  ) : null;
  if (!actionable) {
    return (
      <span title={label} aria-label={label} style={pillStyle}>
        T3
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={label}
      style={{ ...pillStyle, cursor: "pointer" }}
    >
      T3{badge}
    </button>
  );
}

// Resolve the invisible-student window (school days) for a student's
// highest active MTSS tier from the tier-keyed map (no plan → tier 1).
function invisibleWindowForTier(
  byTier: { "1": number; "2": number; "3": number } | undefined,
  tier: number | null,
): number | null {
  if (!byTier) return null;
  if (tier && tier >= 3) return byTier["3"];
  if (tier === 2) return byTier["2"];
  return byTier["1"];
}

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

// Green check shown in the LG column when the student demonstrated a
// FAST Learning Gain (moved up a performance level OR maintained L3+).
// Replaces the bucket icon entirely — the bucket is "points to next
// sub-level" guidance and is moot once LG is already realized.
// Tooltip explains the rule so a teacher hovering over the check
// understands what triggered it.
function LgCheck({
  priorLevel,
  currentLevel,
}: {
  priorLevel: number | null;
  currentLevel: number | null;
}) {
  const reason =
    priorLevel != null && currentLevel != null
      ? currentLevel > priorLevel
        ? `Moved L${priorLevel} → L${currentLevel}`
        : `Maintained L${currentLevel}`
      : "Learning Gain met";
  return (
    <span
      title={`${reason} — FAST Learning Gain met`}
      aria-label={`Learning Gain met: ${reason}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: "50%",
        background: "#dcfce7",
        border: "1.5px solid #16a34a",
        color: "#15803d",
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="5 12 10 17 19 8" />
      </svg>
    </span>
  );
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

// PmDelta ("+12 from PM1") is single-sourced in FastScorePill.tsx and imported
// above, so the Roster / Snapshot / band-drawer deltas can never diverge.

// Multi-year PM3 growth chip. Compact trigger showing the most-recent
// year-over-year delta; on click it expands an absolutely-positioned
// card listing each year's PM3 and its "+pts" change (newest-first).
// PM3-only, no summed total (FAST scale scores are re-referenced per
// grade year to year, so a running sum is meaningless). Renders nothing
// unless there are at least two historical years (one delta to show).
function Pm3GrowthChip({
  history,
  subjectLabel,
}: {
  history: Array<{ schoolYear: string; pm3: number; delta: number | null }>;
  subjectLabel: string;
}) {
  const [open, setOpen] = useState(false);
  // Need ≥2 years for a year-over-year delta to exist.
  if (history.length < 2) return null;
  const latest = history[0];
  const deltaColor = (d: number | null): string =>
    d == null || d === 0 ? "#6b7280" : d > 0 ? "#15803d" : "#b91c1c";
  const deltaText = (d: number | null): string => {
    if (d == null) return "—";
    const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
    return `${sign}${Math.abs(d)}`;
  };
  return (
    <div style={{ position: "relative", marginTop: 3 }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={`${subjectLabel} multi-year PM3 growth — click for year-by-year detail`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          padding: "1px 6px",
          border: "1px solid var(--border, #d1d5db)",
          borderRadius: 999,
          background: open ? "var(--surface, #f3f4f6)" : "transparent",
          color: deltaColor(latest.delta),
          font: "inherit",
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1.4,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden style={{ fontSize: 9 }}>
          {latest.delta != null && latest.delta > 0
            ? "▲"
            : latest.delta != null && latest.delta < 0
              ? "▼"
              : "•"}
        </span>
        {deltaText(latest.delta)}
        <span style={{ color: "#9ca3af", fontWeight: 500 }}>growth</span>
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            minWidth: 150,
            padding: "8px 10px",
            background: "var(--surface, #ffffff)",
            border: "1px solid var(--border, #d1d5db)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
            textAlign: "left",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-muted, #6b7280)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 4,
              whiteSpace: "nowrap",
            }}
          >
            {subjectLabel} PM3 growth
          </div>
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: 12,
              width: "100%",
            }}
          >
            <tbody>
              {history.map((h) => (
                <tr key={h.schoolYear}>
                  <td
                    style={{
                      padding: "2px 8px 2px 0",
                      color: "var(--text, #374151)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h.schoolYear}
                  </td>
                  <td
                    style={{
                      padding: "2px 8px 2px 0",
                      fontWeight: 600,
                      color: "var(--text, #374151)",
                      textAlign: "right",
                    }}
                  >
                    {h.pm3}
                  </td>
                  <td
                    style={{
                      padding: "2px 0",
                      fontWeight: 700,
                      color: deltaColor(h.delta),
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {deltaText(h.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div
            style={{
              marginTop: 5,
              fontSize: 9,
              lineHeight: 1.3,
              color: "#9ca3af",
            }}
          >
            Year-over-year PM3 change. Scale scores re-reference each
            grade, so changes are directional — not a running total.
          </div>
        </div>
      )}
    </div>
  );
}

function SubjectCells({
  block,
  subjectLabel,
  showLg,
  showPriorPm3,
  showPm3,
  showPm1,
  showPm2,
}: {
  block: SubjectBlock;
  subjectLabel: string;
  showLg: boolean;
  showPriorPm3: boolean;
  showPm3: boolean;
  showPm1: boolean;
  showPm2: boolean;
}) {
  // colspan shrinks to match the actually-rendered cells so the "n/a"
  // row still exactly fills the subject group.
  const groupCols =
    (showPriorPm3 ? 1 : 0) +
    (showPm1 ? 1 : 0) +
    (showPm2 ? 1 : 0) +
    (showPm3 ? 1 : 0) +
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
    // Top-align so every pill sits on the same baseline across Prior /
    // PM1 / PM2 / PM3. Without this, cells whose caption stack is
    // taller (e.g. PM2 with a "+12 from PM1" delta line, or Prior with
    // its year sub-label) middle-align and push their pill up relative
    // to neighbors that only render the pill + reserved caption slot.
    verticalAlign: "top",
  };
  // True chronological order: Prior (last year's PM3) → PM1 (fall) →
  // PM2 (winter) → PM3 (spring) → LG bucket. Deltas read naturally
  // left-to-right, each one comparing against the immediately previous
  // window so the eye can scan the trajectory across the row.
  let dividerUsed = false;
  const dividerStyle = (): React.CSSProperties => {
    if (dividerUsed) return cell;
    dividerUsed = true;
    return { ...cell, ...GROUP_DIVIDER };
  };
  const prior = block.priorPm3;
  return (
    <>
      {showPriorPm3 && (
        <td style={dividerStyle()}>
          {prior ? (
            <>
              <ScorePill
                score={prior.pm3}
                placement={prior.placement}
                pmLabel={`${subjectLabel} prior-year PM3 (${prior.schoolYear})`}
              />
              <div
                title={`${prior.schoolYear} PM3 from historical import`}
                style={{
                  marginTop: 2,
                  fontSize: 10,
                  lineHeight: 1.2,
                  color: "#9ca3af",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                {prior.schoolYear}
              </div>
              <Pm3GrowthChip
                history={block.pm3History}
                subjectLabel={subjectLabel}
              />
            </>
          ) : (
            <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>
          )}
        </td>
      )}
      {showPm1 && (
        <td style={dividerStyle()}>
          <ScorePill
            score={block.pm1}
            placement={block.pm1Placement}
            pmLabel={`${subjectLabel} PM1`}
          />
          {/* Prior-PM3 → PM1 is a cross-year comparison (different
              chart, different grade), so we only render the delta when
              the user has the Prior column visible — otherwise the
              "from Prior" label has no anchor on screen. */}
          {showPriorPm3 && (
            <PmDelta
              from={prior?.pm3 ?? null}
              to={block.pm1}
              fromLabel="Prior"
            />
          )}
        </td>
      )}
      {showPm2 && (
        <td style={dividerStyle()}>
          <ScorePill
            score={block.pm2}
            placement={block.pm2Placement}
            pmLabel={`${subjectLabel} PM2`}
          />
          <PmDelta from={block.pm1} to={block.pm2} fromLabel="PM1" />
        </td>
      )}
      {showPm3 && (
        <td style={dividerStyle()}>
          <ScorePill
            score={block.pm3}
            placement={block.pm3Placement}
            pmLabel={`${subjectLabel} PM3`}
          />
          <PmDelta from={block.pm2} to={block.pm3} fromLabel="PM2" />
        </td>
      )}
      {showLg && (
        <td style={dividerStyle()}>
          {block.learningGain === true ? (
            <LgCheck
              priorLevel={prior?.placement?.level ?? null}
              currentLevel={block.pm3Placement?.level ?? null}
            />
          ) : prior ? (
            // Bucket = "points to next sub-level vs. last year's PM3
            // baseline." Without a prior-year PM3 the digit inside the
            // pail is meaningless, so we render a plain "—" instead of
            // a bucket. Once the historical PM3 lands, the bucket (or
            // the green ✓ if LG was met) takes its place.
            <BucketCell bucket={block.bucket} />
          ) : (
            <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>
          )}
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

// Self-contained hover/focus popover per pill, mirroring SafetyPlanPill so
// the hover never depends on a shared row-level state. Each pill renders
// its own popover with the program label, full title, and the student's
// accommodations list (or a friendly empty-state when there are none).
function ProgramPill({
  kind,
  row,
}: {
  kind: "ese" | "504" | "ell";
  row: RosterRow;
}) {
  const meta = PROGRAM_META[kind];
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  // Popover uses position:fixed so it escapes the roster table's horizontal
  // overflow container (which was clipping it on right-edge chips and
  // bottom rows). Measure on open and again on scroll/resize so it tracks
  // the anchor.
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const measure = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const W = 280;
      // Prefer left-align under the chip; clamp 8px from viewport edges.
      let left = r.left;
      if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
      if (left < 8) left = 8;
      setCoords({ top: r.bottom + 4, left });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  const sorted = [...row.accommodations].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span
        ref={anchorRef}
        tabIndex={0}
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
          cursor: "default",
          outline: "none",
        }}
      >
        {meta.label}
      </span>
      {open && coords && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            zIndex: 10000,
            background: "white",
            border: "1px solid #e5e7eb",
            borderTop: `3px solid ${meta.fg}`,
            borderRadius: 6,
            padding: "0.55rem 0.75rem",
            boxShadow: "0 6px 18px rgba(0,0,0,0.14)",
            minWidth: 240,
            maxWidth: 360,
            color: "#111827",
            textAlign: "left",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: meta.fg,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 6,
            }}
          >
            {meta.label} — {row.firstName} {row.lastName}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#6b7280",
              marginBottom: 6,
            }}
          >
            {meta.title}
          </div>
          {sorted.length === 0 ? (
            <div style={{ color: "#6b7280", fontSize: 12 }}>
              No accommodations on file.
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 4,
                }}
              >
                Accommodations
              </div>
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
            </>
          )}
        </div>
      )}
    </span>
  );
}

function ProgramPills({ row }: { row: RosterRow }) {
  const chips: Array<"ese" | "504" | "ell"> = [];
  if (row.ese) chips.push("ese");
  if (row.is504) chips.push("504");
  if (row.ell) chips.push("ell");
  // The school recognizes only ESE / 504 / ELL as trackable program
  // identifiers. If a student has none of these flags we render a
  // placeholder em-dash, regardless of whether they have
  // accommodations on file. (Students with accommodations but no
  // program flag indicate a SIS data-quality issue — the source
  // system should be reflagged, not the UI.)
  if (chips.length === 0) {
    return <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>;
  }
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {chips.map((c) => (
        <ProgramPill key={c} kind={c} row={row} />
      ))}
    </div>
  );
}

// Soft reminder banner shown beneath the student's name when they're on
// admin-logged ISS today AND this teacher has not yet acknowledged the
// assignment for the current period. Two buttons let the teacher record
// "Posted in Canvas" or "Sent hard copy"; the row reloads after the
// POST so the banner disappears.
function IssReminder({
  row,
  period,
  onAcknowledged,
}: {
  row: RosterRow;
  period: number | null;
  onAcknowledged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Only nudge for admin-logged ISS — walk-in / pullout rows are not
  // missed-instruction events, so no Canvas-post reminder is needed.
  if (!row.issToday || row.issToday.source !== "admin") return null;
  if (period == null) return null;
  // Once acknowledged for this period, the soft-reminder banner
  // disappears entirely — the orange "ISS" pill next to the student's
  // name is sufficient signal, and we don't want a persistent "✓"
  // chip cluttering every row of the roster.
  if (row.issAcks.some((a) => a.period === period)) return null;
  const post = async (method: "canvas" | "hardcopy") => {
    setBusy(true);
    try {
      const r = await authFetch("/api/teacher-roster/iss-acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: row.studentId,
          period,
          method,
        }),
      });
      if (r.ok) onAcknowledged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      style={{
        marginTop: 6,
        padding: "6px 8px",
        background: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: 6,
        fontSize: 11,
        color: "#92400e",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span>On ISS today — please send work for Period {period}.</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void post("canvas")}
        style={{
          padding: "2px 8px",
          borderRadius: 4,
          border: "1px solid #fcd34d",
          background: "#fef3c7",
          color: "#78350f",
          fontSize: 11,
          fontWeight: 600,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        Posted in Canvas
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void post("hardcopy")}
        style={{
          padding: "2px 8px",
          borderRadius: 4,
          border: "1px solid #fcd34d",
          background: "#fef3c7",
          color: "#78350f",
          fontSize: 11,
          fontWeight: 600,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        Sent hard copy
      </button>
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

// ----- Quick Log (behavior + classroom interventions) -----
// Lightweight types for the roster quick-log modal. Behaviors come from the
// existing negative `pbis_reasons`; interventions from `intervention_types`.
type NegBehavior = { id: number; name: string; defaultPoints: number };
type IvType = { id: number; name: string; category?: string | null };
type EffByType = Record<
  string,
  { worked: number; recurred: number; pending: number }
>;

// Self-contained roster quick-log form. Lets any signed-in teacher record a
// low-level behavior + the classroom intervention(s) they tried in one shot,
// reusing POST /api/pbis (negative) and POST /api/interventions (with the new
// behaviorReason link). Shows "what's worked before" effectiveness for the
// selected student+behavior so the teacher can pick a proven intervention.
function QuickLogForm({
  studentId,
  studentName,
  localSisId,
  behaviors,
  interventionTypes,
  onSaved,
  onCancel,
}: {
  studentId: string;
  studentName: string;
  localSisId?: string | null;
  behaviors: NegBehavior[];
  interventionTypes: IvType[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [behaviorId, setBehaviorId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [eff, setEff] = useState<EffByType | null>(null);
  const [effLoading, setEffLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedBehavior =
    behaviors.find((b) => b.id === behaviorId) ?? null;

  // Load "what's worked before" for this student + behavior whenever the
  // selected behavior changes. School-wide across teachers.
  useEffect(() => {
    setEff(null);
    if (!selectedBehavior) return;
    let cancelled = false;
    setEffLoading(true);
    authFetch(
      `/api/interventions/effectiveness?studentId=${encodeURIComponent(
        studentId,
      )}&behaviorReason=${encodeURIComponent(selectedBehavior.name)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { byType?: EffByType } | null) => {
        if (!cancelled && j) setEff(j.byType ?? {});
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setEffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [behaviorId, studentId, selectedBehavior]);

  function toggleIv(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const canSubmit = Boolean(selectedBehavior) && selected.size > 0 && !submitting;

  async function submit() {
    if (!selectedBehavior || selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    const trimmedNote = note.trim() || undefined;
    try {
      // Single atomic write — the server records the behavior + every selected
      // intervention in one transaction, so a partial failure can't leave a
      // behavior without its interventions (or vice versa).
      const res = await authFetch("/api/interventions/quick-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          reasonId: selectedBehavior.id,
          interventionTypeIds: [...selected],
          note: trimmedNote,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j && typeof j.error === "string" && j.error) ||
            "Could not save. Please try again.",
        );
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 18 }}>
          Log behavior &amp; intervention
        </h3>
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          {studentName}
          {localSisId ? (
            <span style={{ fontFamily: "ui-monospace, monospace" }}>
              {" "}
              · ID {localSisId}
            </span>
          ) : null}
        </div>
      </div>

      {/* Behavior */}
      <label
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 600,
          color: "#374151",
          marginBottom: 6,
        }}
      >
        Behavior
      </label>
      <select
        value={behaviorId ?? ""}
        onChange={(e) => {
          setBehaviorId(e.target.value ? Number(e.target.value) : null);
          setSelected(new Set());
        }}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid #d1d5db",
          fontSize: 14,
          marginBottom: 16,
        }}
      >
        <option value="">Select a behavior…</option>
        {behaviors.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      {behaviors.length === 0 && (
        <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16 }}>
          No negative behaviors are configured yet. An admin can add them under
          PBIS reasons.
        </div>
      )}

      {/* Interventions */}
      <label
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 600,
          color: "#374151",
          marginBottom: 6,
        }}
      >
        Intervention(s) tried
        {selectedBehavior && effLoading && (
          <span style={{ fontWeight: 400, color: "#9ca3af" }}>
            {" "}
            · checking what's worked…
          </span>
        )}
      </label>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: 260,
          overflowY: "auto",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 8,
          marginBottom: 16,
        }}
      >
        {interventionTypes.length === 0 && (
          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            No intervention types are configured yet.
          </div>
        )}
        {interventionTypes.map((iv) => {
          const stats = eff?.[iv.name];
          const worked = stats?.worked ?? 0;
          const recurred = stats?.recurred ?? 0;
          const checked = selected.has(iv.id);
          return (
            <label
              key={iv.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                cursor: "pointer",
                background: checked ? "#ecfdf5" : "transparent",
                border: checked
                  ? "1px solid #a7f3d0"
                  : "1px solid transparent",
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleIv(iv.id)}
              />
              <span style={{ flex: 1, fontSize: 14, color: "#111827" }}>
                {iv.name}
              </span>
              {selectedBehavior && worked > 0 && (
                <span
                  title={`Worked ${worked}× before for this student (behavior did not recur within the window)`}
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#047857",
                    background: "#d1fae5",
                    borderRadius: 999,
                    padding: "1px 8px",
                  }}
                >
                  ✓ Worked {worked}×
                </span>
              )}
              {selectedBehavior && worked === 0 && recurred > 0 && (
                <span
                  title={`Behavior recurred within the window ${recurred}× after this intervention`}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#92400e",
                    background: "#fef3c7",
                    borderRadius: 999,
                    padding: "1px 8px",
                  }}
                >
                  recurred {recurred}×
                </span>
              )}
            </label>
          );
        })}
      </div>

      {/* Note */}
      <label
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 600,
          color: "#374151",
          marginBottom: 6,
        }}
      >
        Note (optional)
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Context, what you observed…"
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid #d1d5db",
          fontSize: 14,
          resize: "vertical",
          marginBottom: 16,
        }}
      />

      {error && (
        <div
          style={{
            fontSize: 13,
            color: "#b91c1c",
            background: "#fee2e2",
            borderRadius: 8,
            padding: "8px 10px",
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            background: "white",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            background: canSubmit ? "#4f46e5" : "#c7d2fe",
            color: "white",
            fontSize: 14,
            fontWeight: 600,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {submitting ? "Saving…" : "Log it"}
        </button>
      </div>
    </div>
  );
}

export default function TeacherRosterPage({
  isCoreTeam,
  defaultTeacherId,
  onBack,
  onOpenSpider,
  onOpenSafetyPlan,
  onOpenClassComposer,
  onTeacherChange,
}: Props) {
  const [teachers, setTeachers] = useState<TeacherOpt[]>([]);
  const [teacherId, setTeacherId] = useState<number | null>(
    defaultTeacherId,
  );
  // Track whether the user has manually picked a teacher in this
  // session. Initial "the user just landed and we filled in their own
  // id from the prop" does NOT count — so when `defaultTeacherId`
  // arrives late (auth still hydrating at mount time), we still get
  // to honor it. After any explicit pick from the dropdown, we stop
  // overriding their choice.
  const userPickedTeacherRef = useRef(false);
  // If `defaultTeacherId` was null at mount (auth still loading) and
  // then arrives a tick later, sync local state — otherwise the page
  // sits on whatever `sorted[0]` the teachers-load effect picked,
  // which is rarely what the user wanted.
  useEffect(() => {
    if (userPickedTeacherRef.current) return;
    if (defaultTeacherId != null && defaultTeacherId !== teacherId) {
      setTeacherId(defaultTeacherId);
    }
  }, [defaultTeacherId, teacherId]);
  // Bubble every teacher change up to the host so it can remember the
  // picked teacher across unmounts (spider round-trip, etc).
  useEffect(() => {
    if (teacherId != null && onTeacherChange) onTeacherChange(teacherId);
  }, [teacherId, onTeacherChange]);
  const [period, setPeriod] = useState<number | null>(null);
  const [tab, setTab] = useState<RosterTab>("roster");
  // Roster-wide pill view default. Persisted to localStorage so the
  // teacher's choice survives reloads + navigation. Per-browser, not
  // per-server-user — keeps the schema clean and avoids a round-trip
  // for what is purely a display preference. Default "level" matches
  // the historical behavior (pills show FAST sub-level on first load).
  const PILL_VIEW_KEY = "pulseedu.teacherRoster.pillView";
  const [pillView, setPillView] = useState<PillView>(() => {
    if (typeof window === "undefined") return "level";
    const raw = window.localStorage.getItem(PILL_VIEW_KEY);
    return raw === "score" ? "score" : "level";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PILL_VIEW_KEY, pillView);
  }, [pillView]);
  const [data, setData] = useState<RosterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Bump to trigger a roster reload (e.g. after the IssReminder banner
  // posts an acknowledgement so today's row picks up the new ack).
  const [reloadTick, setReloadTick] = useState(0);
  const refresh = () => setReloadTick((n) => n + 1);
  // Per-user view toggles. Each maps to one optional column. Defaults
  // to all-on; persisted to localStorage so the teacher's preference
  // survives reloads. Bumped key to v2 since we added pm-level toggles.
  type SubjectFilter = "both" | "ela" | "math";
  type Visibility = {
    lg: boolean;
    bq: boolean;
    invisible: boolean;
    priorPm3: boolean;
    pm3: boolean;
    pm1: boolean;
    pm2: boolean;
    programs: boolean;
    attendance: boolean;
    subject: SubjectFilter;
  };
  const VIS_DEFAULT: Visibility = {
    lg: true,
    bq: true,
    invisible: true,
    priorPm3: true,
    pm3: true,
    pm1: true,
    pm2: true,
    programs: true,
    attendance: true,
    subject: "both",
  };
  // Bumped to v3 because the Programs (ESE / 504 / ELL) toggle was
  // added; previous keys are missing the field but the `??` fallbacks
  // below default it to true, so old saved prefs upgrade cleanly.
  // (The subject filter, added later, also falls back to "both".)
  const VIS_KEY = "teacherRoster.visibility.v3";
  const [visibility, setVisibility] = useState<Visibility>(() => {
    if (typeof window === "undefined") return VIS_DEFAULT;
    try {
      const raw = window.localStorage.getItem(VIS_KEY);
      if (!raw) return VIS_DEFAULT;
      const parsed = JSON.parse(raw) as Partial<Visibility>;
      const subject: SubjectFilter =
        parsed.subject === "ela" || parsed.subject === "math"
          ? parsed.subject
          : "both";
      return {
        lg: parsed.lg ?? true,
        bq: parsed.bq ?? true,
        invisible: parsed.invisible ?? true,
        priorPm3: parsed.priorPm3 ?? true,
        pm3: parsed.pm3 ?? true,
        pm1: parsed.pm1 ?? true,
        pm2: parsed.pm2 ?? true,
        programs: parsed.programs ?? true,
        attendance: parsed.attendance ?? true,
        subject,
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
  const toggleVis = (key: Exclude<keyof Visibility, "subject">) =>
    setVisibility((v) => ({ ...v, [key]: !v[key] }));
  const showEla = visibility.subject !== "math";
  const showMath = visibility.subject !== "ela";

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
        // Sort alphabetically by display name (case-insensitive,
        // locale-aware) so Core Team can scan the dropdown quickly.
        // Staff without a display name sink to the bottom.
        const sorted = [...j.teachers].sort((a, b) => {
          const an = a.displayName ?? "";
          const bn = b.displayName ?? "";
          if (!an && !bn) return 0;
          if (!an) return 1;
          if (!bn) return -1;
          return an.localeCompare(bn, undefined, { sensitivity: "base" });
        });
        setTeachers(sorted);
        // Only fall back to the alphabetically-first teacher if we
        // truly have no default (e.g. unauthenticated preview). If
        // `defaultTeacherId` arrives a tick later, the sync effect
        // above will catch up.
        if (
          teacherId == null &&
          defaultTeacherId == null &&
          sorted.length > 0
        ) {
          setTeacherId(sorted[0].id);
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

  // Reload roster when teacher or period changes, or when refresh() is
  // called (reloadTick bumps).
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
  }, [teacherId, period, reloadTick]);

  // ----- Tier 3 weekly-tracking status (interventionist) -----
  // Maps studentId -> count of scheduled meeting days this week that
  // the logged-in user still owes a score for. The map ONLY contains
  // students for whom the current user is the assigned interventionist
  // (server-scoped to req staff id), so membership in the map is what
  // makes a roster Tier 3 pill actionable. Core Team viewers get an
  // empty list from the server (they aren't an interventionist), so
  // their pills render as plain informational badges.
  const [tier3Missing, setTier3Missing] = useState<Map<string, number>>(
    new Map(),
  );
  const [tier3WeekStart, setTier3WeekStart] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/interventions/my-tier3-status")
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then(
        (
          j: {
            weekStartDate: string;
            students: Array<{ studentId: string; missingDayCount: number }>;
          } | null,
        ) => {
          if (cancelled || !j) return;
          const m = new Map<string, number>();
          for (const s of j.students) m.set(s.studentId, s.missingDayCount);
          setTier3Missing(m);
          setTier3WeekStart(j.weekStartDate);
        },
      )
      .catch(() => {
        /* non-fatal — pills just render informational */
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // Open Tier 3 weekly form for a specific student (roster pill click).
  const [tier3Modal, setTier3Modal] = useState<{
    studentId: string;
    studentName: string;
  } | null>(null);

  // ----- Quick Log modal (behavior + intervention) -----
  const [logModal, setLogModal] = useState<{
    studentId: string;
    studentName: string;
    localSisId?: string | null;
  } | null>(null);
  // Inline data-chat icon: which student is being chatted with, plus the
  // set of students still PENDING in one of this teacher's active
  // campaigns (tints the icon purple + logging counts toward the campaign).
  const [chatModal, setChatModal] = useState<string | null>(null);
  const [pendingChatIds, setPendingChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [chatTick, setChatTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/data-chats/pending-students", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { studentIds?: string[] } | null) => {
        if (!cancelled && Array.isArray(d?.studentIds)) {
          setPendingChatIds(new Set(d.studentIds));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chatTick]);
  const [negBehaviors, setNegBehaviors] = useState<NegBehavior[]>([]);
  const [ivTypes, setIvTypes] = useState<IvType[]>([]);
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/pbis-reasons")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled || !Array.isArray(rows)) return;
        setNegBehaviors(
          rows
            .filter(
              (r) =>
                r &&
                r.polarity === "negative" &&
                r.active !== false,
            )
            .map((r) => ({
              id: r.id,
              name: r.name,
              defaultPoints: Number(r.defaultPoints) || 1,
            })),
        );
      })
      .catch(() => {});
    authFetch("/api/intervention-types")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled || !Array.isArray(rows)) return;
        setIvTypes(
          rows
            .filter((r) => r && r.active !== false)
            .map((r) => ({
              id: r.id,
              name: r.name,
              category: r.category ?? null,
            })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const periodOptions = data?.availablePeriods ?? [];

  // ----- Separation Suggestions (per-period) -----
  // The roster only knows the period number, but the Suggest-Separation
  // modal needs the class_section_id. Resolve it once per (teacher,
  // period) via a tiny lookup, then pull this section's existing flags
  // so we can show a "🚫 N" pill on each row that's already in a
  // flagged pair.
  //
  // Visibility: own roster always; Core Team viewers also get the icon
  // when sitting on another teacher's roster so they can file pairs
  // they've spotted from cross-class trends. Server stamps the flag
  // with the logged-in user's staff id either way.
  const isOwnRoster = teacherId === defaultTeacherId;
  const canFlagSeparations = isOwnRoster || isCoreTeam;
  const [sepSectionId, setSepSectionId] = useState<number | null>(null);
  type SepRow = {
    id: number;
    studentAId: string;
    studentBId: string;
    reasonTagIds: number[];
    reasonNote: string | null;
  };
  const [sepRows, setSepRows] = useState<SepRow[]>([]);
  const [sepTick, setSepTick] = useState(0);
  const [sepTarget, setSepTarget] = useState<{
    studentId: string;
    studentName: string;
  } | null>(null);

  useEffect(() => {
    setSepSectionId(null);
    setSepRows([]);
    if (!canFlagSeparations || period == null || teacherId == null) return;
    let cancelled = false;
    const tidQs = isOwnRoster ? "" : `&teacherId=${teacherId}`;
    authFetch(`/api/separations/section-for-period?period=${period}${tidQs}`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j: { id: number } | null) => {
        if (cancelled || !j) return;
        setSepSectionId(j.id);
      })
      .catch(() => {
        /* non-fatal: feature just stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [canFlagSeparations, isOwnRoster, period, teacherId]);

  useEffect(() => {
    if (sepSectionId == null) {
      setSepRows([]);
      return;
    }
    let cancelled = false;
    authFetch(`/api/separations/my?classSectionId=${sepSectionId}`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j: { separations: SepRow[] } | null) => {
        if (cancelled || !j) return;
        setSepRows(j.separations);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [sepSectionId, sepTick]);

  // Per-student count of flagged pairs in the current period (for the
  // "🚫 N" pill). Derived once from sepRows.
  const sepCountByStudent = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of sepRows) {
      m.set(r.studentAId, (m.get(r.studentAId) ?? 0) + 1);
      m.set(r.studentBId, (m.get(r.studentBId) ?? 0) + 1);
    }
    return m;
  }, [sepRows]);

  // Reset period when switching teachers if the new teacher doesn't
  // teach the previously-selected period. Also auto-select the first
  // available period if none is currently chosen — the per-row
  // Separation Suggestions icon is bound to a single class section, so
  // it can only render once a period is picked. Auto-selecting avoids
  // the "where are my icons?" confusion users hit on first load.
  useEffect(() => {
    if (period != null && periodOptions.length > 0 && !periodOptions.includes(period)) {
      setPeriod(null);
      return;
    }
    if (period == null && periodOptions.length > 0) {
      setPeriod(periodOptions[0]);
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
            <button
              onClick={() => {
                // If the user is on the Benchmarks or Instruction Log
                // sub-tab, "Back" should step back to the Roster sub-tab
                // first — not exit the page entirely. Only when they're
                // already on the Roster sub-tab do we leave the page.
                if (tab !== "roster") {
                  setTab("roster");
                  return;
                }
                onBack();
              }}
              style={{ padding: "4px 10px" }}
              title={tab !== "roster" ? "Back to Roster" : "Back"}
            >
              ← {tab !== "roster" ? "Back to Roster" : "Back"}
            </button>
          )}
          <h2 style={{ margin: 0 }}>Teacher Roster</h2>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {isCoreTeam && teachers.length > 1 && (
            <label style={{ fontSize: 13 }}>
              Teacher:&nbsp;
              <TeacherPicker
                teachers={teachers}
                value={teacherId}
                showDeptFilter
                ariaLabel="Teacher"
                onChange={(id) => {
                  userPickedTeacherRef.current = true;
                  setTeacherId(id);
                  setPeriod(null);
                }}
              />
            </label>
          )}
        </div>
      </div>

      <HowToUseHelp title="How to use Teacher Roster">
        <HowToSection title="What this page is">
          One row per student in your class with FAST scores, program
          flags (ESE / 504 / ELL / CT-ELA / CT-Math), MTSS tier, and a
          safety-plan indicator. Use the period chip row to focus on a
          single block, and the visibility toggles to hide columns you
          don't need today.
        </HowToSection>
        <HowToSection title="What the columns mean">
          <ul style={howtoListStyle}>
            <li><strong>LG column</strong> — a green check ✓ appears when the student met the FAST Learning Gain (moved up a performance level vs. last year's PM3, OR maintained L3/L4/L5). Otherwise the LG column shows the bucket icon (points to next sub-level). Empty when there's no prior-year PM3 to compare to, or no current PM3 yet.</li>
            <li><strong>BQ</strong> — Bottom Quartile flag from last year's PM3.</li>
            <li><strong>Prior → PM1 → PM2 → PM3</strong> — last year's spring PM3 (from the historical importer) followed by this year's three FAST Progress Monitoring windows, in chronological order. Small "+N from PMx" deltas under each pill show point-change since the previous window.</li>
            <li><strong>Programs</strong> — service flags driving accommodations.</li>
            <li><strong>Bucket gap</strong> — points to next FAST level on this grade. Suppressed for grade 3 and untracked subjects. Replaced by a green check ✓ when LG is met.</li>
            <li>
              <strong>🔗 chain</strong> next to a name — opens the
              "Suggest separation" dialog so you can flag students who
              should be kept apart this period. Once a student is in one
              or more flagged pairs, the icon turns into a red{" "}
              <strong>🚫 N</strong> pill (N = number of pairings) — click
              it to view or edit the existing suggestions. Suggestions
              are scoped to the period you're viewing and are visible to
              the next teacher who has the same students.
            </li>
            <li>
              <strong>R</strong> in a black circle — student has been
              retained at one or more grade levels. Hover for the list
              (e.g. "Retained: Grade 3, Grade 5"). Admins, Behavior
              Specialists, MTSS Coordinators, and Counselors can
              mark/unmark from the Student Profile.
            </li>
          </ul>
        </HowToSection>
        <RoleSection for="teacher" title="Daily use for teachers">
          Click any student to open their full profile. The shield icon
          means they have an active safety plan — read it before the
          first contact of the day. The amber row banner is an ISS
          reminder you need to acknowledge.
        </RoleSection>
        <RoleSection for="coreTeam" title="Core Team — viewing other teachers">
          Use the "Teacher" dropdown above to switch into any teacher's
          roster. Useful for SST meetings or before walking into a
          classroom observation.
        </RoleSection>
      </HowToUseHelp>

      {/* Top-level tabs: classic roster vs FAST Phase 2 benchmark
          heatmap. Hidden state (period, visibility toggles) is
          preserved across tab switches so a user can flip back to
          the roster with their period chip still set. */}
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid #d4d4d4",
          marginBottom: 12,
        }}
        role="tablist"
        aria-label="Teacher Roster views"
      >
        {(
          [
            { value: "roster", label: "Roster" },
            { value: "benchmarks", label: "Benchmarks" },
            { value: "instruction", label: "Instruction Log" },
            { value: "groupInsights", label: "Group Insights" },
          ] as Array<{ value: RosterTab; label: string }>
        ).map((t) => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.value)}
              style={{
                padding: "8px 14px",
                border: "1px solid #d4d4d4",
                borderBottom: active ? "1px solid white" : "1px solid #d4d4d4",
                borderRadius: "6px 6px 0 0",
                background: active ? "white" : "#f3f4f6",
                color: active ? "#111827" : "#374151",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "benchmarks" && (
        <TeacherBenchmarksTab
          teacherId={teacherId}
          isOwnRoster={isOwnRoster}
          rosterSelectedPeriod={data?.selectedPeriod ?? null}
          rosterAvailablePeriods={data?.availablePeriods ?? []}
          onOpenClassComposer={onOpenClassComposer}
        />
      )}

      {tab === "instruction" && (
        <TeacherInstructionLogTab
          teacherId={teacherId}
          isOwnRoster={isOwnRoster}
          isCoreTeam={isCoreTeam}
        />
      )}

      {tab === "groupInsights" && teacherId != null && (
        <GroupInsightsTab teacherId={teacherId} />
      )}

      {tab === "roster" && (
      <PillViewContext.Provider value={pillView}>
      {/* Period selector + Pill view toggle — combined row.
          Period chips on the left (primary filter), pill-view toggle
          right-aligned (display preference, persisted per browser).
          Keeping both on a single row trims one full row of vertical
          chrome above the roster without hiding either control. */}
      <div
        style={{
          display: "flex",
          gap: 10,
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
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "#6b7280" }}>Show pills as:</span>
        <div
          role="group"
          aria-label="FAST pill display mode"
          title="Flip every FAST pill on the page. Click any individual pill to flip just that one."
          style={{
            display: "inline-flex",
            border: "1px solid #d1d5db",
            borderRadius: 999,
            overflow: "hidden",
            background: "#fff",
          }}
        >
          {(
            [
              { value: "level", label: "Level" },
              { value: "score", label: "Scale score" },
            ] as Array<{ value: PillView; label: string }>
          ).map((opt, i) => {
            const active = pillView === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => setPillView(opt.value)}
                style={{
                  padding: "4px 12px",
                  border: "none",
                  borderLeft: i === 0 ? "none" : "1px solid #d1d5db",
                  background: active ? "#1f2937" : "transparent",
                  color: active ? "#fff" : "#374151",
                  fontWeight: active ? 700 : 500,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Legend — wrapped in the same disclosure pattern as
          "How to use Teacher Roster" so veteran users get a clean
          header without losing reference info. Defaults to collapsed;
          HowToUseHelp uses the global help-mode flag, so legend also
          honors the user's "hide all help" preference. */}
      <HowToUseHelp title="Legend">
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
          padding: "8px 12px",
          fontSize: 12,
          color: "#374151",
        }}
      >
        <span>Pills: Prior PM3 → PM1 → PM2 → PM3 (chronological; sub-level on current chart, PM3 + Prior on prior-grade chart)</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          LG bucket = pts to next sub-level (Low1 → Mid1 → High1 → Low2 → High2 → L3 → L4 → L5). Color = current FAST level:
          <BucketIcon
            bucket={{ targetScore: 0, gap: 4, color: "red", currentSubLevel: "1.2", nextStopLabel: "High 1" }}
          />
          L1
          <BucketIcon
            bucket={{ targetScore: 0, gap: 3, color: "orange", currentSubLevel: "2.1", nextStopLabel: "High 2" }}
          />
          L2
          <BucketIcon
            bucket={{ targetScore: 0, gap: 5, color: "green", currentSubLevel: "3", nextStopLabel: "Level 4" }}
          />
          L3
          <BucketIcon
            bucket={{ targetScore: 0, gap: 6, color: "blue", currentSubLevel: "4", nextStopLabel: "Level 5" }}
          />
          L4
          <BucketIcon
            bucket={{ targetScore: 0, gap: 0, color: "purple", currentSubLevel: "5", nextStopLabel: null }}
          />
          L5
        </span>
        <span>BQ = Bottom Quartile (prior-year final scale score)</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Programs:
          {(["ese", "504", "ell"] as const).map((k) => {
            const m = PROGRAM_META[k];
            return (
              <span
                key={k}
                title={m.title}
                aria-label={m.title}
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  borderRadius: 6,
                  background: m.bg,
                  color: m.fg,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.2,
                }}
              >
                {m.label}
              </span>
            );
          })}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InvisibleEyeIcon
            tier={null}
            windowDays={data?.invisibleDaysByTier?.["1"] ?? null}
          />
          Invisible (0 PBIS in last {data?.invisibleDaysByTier?.["1"] ?? 8}{" "}
          school days)
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InvisibleEyeIcon
            tier={2}
            windowDays={data?.invisibleDaysByTier?.["2"] ?? null}
          />
          + active MTSS Tier 2 ({data?.invisibleDaysByTier?.["2"] ?? 5} days)
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InvisibleEyeIcon
            tier={3}
            windowDays={data?.invisibleDaysByTier?.["3"] ?? null}
          />
          + active MTSS Tier 3 ({data?.invisibleDaysByTier?.["3"] ?? 3} days)
        </span>
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Click on the row to suggest a separation pairing for this period; the icon turns red with a count once one or more pairs are flagged."
        >
          <span aria-hidden="true">🔗</span>
          suggest separation /
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              padding: "1px 6px",
              borderRadius: 999,
              border: "1px solid #fca5a5",
              background: "#fef2f2",
              color: "#b91c1c",
              fontWeight: 700,
            }}
          >
            🚫 N
          </span>
          already flagged this period (click to edit)
        </span>
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Student has been retained at one or more grade levels. Hover the badge on a row for the list."
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "#0f172a",
              color: "white",
              fontSize: 11,
              fontWeight: 800,
              lineHeight: 1,
            }}
          >
            R
          </span>
          retained (hover for grade levels)
        </span>
      </div>
      </HowToUseHelp>

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
        <span
          role="group"
          aria-label="Subject filter"
          title="Show only ELA columns, only Math columns, or both"
          style={{
            display: "inline-flex",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {(["both", "ela", "math"] as const).map((opt) => {
            const active = visibility.subject === opt;
            const label = opt === "both" ? "Both" : opt === "ela" ? "ELA" : "Math";
            return (
              <button
                key={opt}
                type="button"
                onClick={() =>
                  setVisibility((v) => ({ ...v, subject: opt }))
                }
                aria-pressed={active}
                style={{
                  padding: "3px 10px",
                  border: "none",
                  borderLeft: opt === "both" ? "none" : "1px solid #cbd5e1",
                  background: active ? "#1d4ed8" : "white",
                  color: active ? "white" : "#374151",
                  fontWeight: active ? 700 : 500,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </span>
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="Show or hide the prior-year PM3 column (most-recent historical PM3 from the FL importer)"
        >
          <input
            type="checkbox"
            checked={visibility.priorPm3}
            onChange={() => toggleVis("priorPm3")}
          />
          Prior PM3
        </label>
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
          title="Show or hide the Attendance column (days absent + estimated %)"
        >
          <input
            type="checkbox"
            checked={visibility.attendance}
            onChange={() => toggleVis("attendance")}
          />
          Attendance
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

      <FollowupReminders onOpenChat={(sid) => setChatModal(sid)} />

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
          <table className="pulse-table"
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
                {visibility.attendance && (
                  <th
                    rowSpan={2}
                    style={{ padding: "8px 10px", verticalAlign: "bottom" }}
                    title="Days absent (from the Eligibility Hub upload) and an ESTIMATED attendance % (weekday denominator since the semester start)"
                  >
                    Attend.
                  </th>
                )}
                {(() => {
                  const groupCols =
                    (visibility.priorPm3 ? 1 : 0) +
                    (visibility.pm1 ? 1 : 0) +
                    (visibility.pm2 ? 1 : 0) +
                    (visibility.pm3 ? 1 : 0) +
                    (visibility.lg ? 1 : 0);
                  if (groupCols === 0) return null;
                  return (
                    <>
                      {showEla && (
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
                      )}
                      {showMath && (
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
                      )}
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
                {(["ELA", "Math"] as const)
                  .filter((g) => (g === "ELA" ? showEla : showMath))
                  .map((group) => {
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
                      {visibility.priorPm3 && (
                        <th
                          style={div()}
                          title="Most-recent prior-year PM3 from the FL historical importer. Renders as a real pill (color-coded against last year's grade chart). Use it to spot summer regression at a glance."
                        >
                          Prior
                        </th>
                      )}
                      {visibility.pm1 && <th style={div()}>PM1</th>}
                      {visibility.pm2 && <th style={div()}>PM2</th>}
                      {visibility.pm3 && <th style={div()}>PM3</th>}
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
                          windowDays={invisibleWindowForTier(
                            data.invisibleDaysByTier,
                            row.mtssTier,
                          )}
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
                      <StudentPhoto
                        firstName={row.firstName}
                        lastName={row.lastName}
                        photoObjectKey={row.photoObjectKey}
                        photoConsent={row.photoConsent}
                        size={28}
                      />
                      <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.15 }}>
                        <span>{row.lastName}, {row.firstName}</span>
                        {row.localSisId && (
                          <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
                            ID {row.localSisId}
                          </span>
                        )}
                      </span>
                      {row.safetyPlan && (
                        <SafetyPlanPill
                          plan={row.safetyPlan}
                          studentName={`${row.firstName} ${row.lastName}`}
                          onOpen={
                            onOpenSafetyPlan
                              ? () => onOpenSafetyPlan(row.studentId)
                              : undefined
                          }
                        />
                      )}
                      {row.mtssTier != null && row.mtssTier >= 3 && (
                        <Tier3Pill
                          actionable={tier3Missing.has(row.studentId)}
                          missingCount={tier3Missing.get(row.studentId) ?? 0}
                          studentName={`${row.firstName} ${row.lastName}`}
                          onOpen={() =>
                            setTier3Modal({
                              studentId: row.studentId,
                              studentName: `${row.firstName} ${row.lastName}`,
                            })
                          }
                        />
                      )}
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
                      <button
                        type="button"
                        onClick={() =>
                          setLogModal({
                            studentId: row.studentId,
                            studentName: `${row.firstName} ${row.lastName}`,
                            localSisId: row.localSisId,
                          })
                        }
                        title={`Log a behavior & intervention for ${row.firstName} ${row.lastName}`}
                        aria-label={`Log a behavior & intervention for ${row.firstName} ${row.lastName}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "1px solid #fbcfe8",
                          background: "#fdf2f8",
                          color: "#9d174d",
                          fontSize: 11,
                          fontWeight: 600,
                          lineHeight: 1.2,
                          cursor: "pointer",
                        }}
                      >
                        <span aria-hidden="true">📝</span>
                        <span>Log</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setChatModal(row.studentId)}
                        title={
                          pendingChatIds.has(row.studentId)
                            ? `Data chat pending for ${row.firstName} ${row.lastName} — log it now`
                            : `Log a data chat with ${row.firstName} ${row.lastName}`
                        }
                        aria-label={`Log a data chat with ${row.firstName} ${row.lastName}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: pendingChatIds.has(row.studentId)
                            ? "1px solid #c4b5fd"
                            : "1px solid #e2e8f0",
                          background: pendingChatIds.has(row.studentId)
                            ? "#f5f3ff"
                            : "#f8fafc",
                          color: pendingChatIds.has(row.studentId)
                            ? "#6d28d9"
                            : "#475569",
                          fontSize: 11,
                          fontWeight: 600,
                          lineHeight: 1.2,
                          cursor: "pointer",
                        }}
                      >
                        <span aria-hidden="true">💬</span>
                        <span>
                          {pendingChatIds.has(row.studentId) ? "Chat!" : "Chat"}
                        </span>
                      </button>
                      {sepSectionId != null && (() => {
                        const n = sepCountByStudent.get(row.studentId) ?? 0;
                        // Two-state icon per the product spec:
                        //  - Default (no flag yet): chain-link 🔗 — "could be
                        //    paired with someone in this class".
                        //  - After flagged: red prohibition 🚫 — easy at-a-
                        //    glance recognition that this student already has
                        //    one or more separation suggestions on file.
                        const flagged = n > 0;
                        return (
                          <button
                            type="button"
                            onClick={() =>
                              setSepTarget({
                                studentId: row.studentId,
                                studentName: `${row.firstName} ${row.lastName}`,
                              })
                            }
                            title={
                              flagged
                                ? `${n} separation suggestion${n === 1 ? "" : "s"} for ${row.firstName} this period — click to edit`
                                : `Suggest a separation pairing for ${row.firstName}`
                            }
                            aria-label={
                              flagged
                                ? `Edit ${n} separation suggestion${n === 1 ? "" : "s"} for ${row.firstName} ${row.lastName}`
                                : `Suggest separation for ${row.firstName} ${row.lastName}`
                            }
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              padding: "2px 8px",
                              borderRadius: 999,
                              border: flagged
                                ? "1px solid #fca5a5"
                                : "1px solid #cbd5e1",
                              background: flagged ? "#fef2f2" : "white",
                              color: flagged ? "#b91c1c" : "#475569",
                              fontSize: 12,
                              fontWeight: 600,
                              lineHeight: 1.2,
                              cursor: "pointer",
                            }}
                          >
                            <span aria-hidden="true">{flagged ? "🚫" : "🔗"}</span>
                            {flagged && <span>{n}</span>}
                          </button>
                        );
                      })()}
                      {row.retainedGrades && row.retainedGrades.length > 0 && (
                        <span
                          title={`Retained: ${row.retainedGrades
                            .map((g) => `Grade ${g}`)
                            .join(", ")}`}
                          aria-label={`Retained at ${row.retainedGrades
                            .map((g) => `Grade ${g}`)
                            .join(", ")}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 18,
                            height: 18,
                            borderRadius: "50%",
                            background: "#0f172a",
                            color: "white",
                            fontSize: 11,
                            fontWeight: 800,
                            lineHeight: 1,
                            cursor: "help",
                          }}
                        >
                          R
                        </span>
                      )}
                      {row.issToday && (
                        <span
                          title="On In-School Suspension today"
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            border: "1px solid #fdba74",
                            background: "#fff7ed",
                            color: "#9a3412",
                            fontSize: 11,
                            fontWeight: 700,
                            lineHeight: 1.2,
                          }}
                        >
                          ISS
                        </span>
                      )}
                      {row.ossToday && (
                        <span
                          title="On Out-of-School Suspension today"
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            border: "1px solid #fca5a5",
                            background: "#fef2f2",
                            color: "#991b1b",
                            fontSize: 11,
                            fontWeight: 700,
                            lineHeight: 1.2,
                          }}
                        >
                          OSS
                        </span>
                      )}
                    </span>
                    <IssReminder
                      row={row}
                      period={data.selectedPeriod}
                      onAcknowledged={refresh}
                    />
                  </td>
                  {visibility.programs && (
                    <td style={{ padding: "6px 10px" }}>
                      <ProgramPills row={row} />
                    </td>
                  )}
                  <td style={{ padding: "6px 10px" }}>{row.grade}</td>
                  {visibility.attendance && (
                    <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>
                      {row.attendance?.daysAbsent != null ? (
                        <span
                          title={
                            row.attendance.attendancePct != null
                              ? `${row.attendance.attendancePct}% estimated attendance${row.attendance.daysTardy != null ? ` · ${row.attendance.daysTardy} tardies` : ""}`
                              : "Attendance % unavailable (no semester start configured)"
                          }
                        >
                          {row.attendance.daysAbsent}d
                          {row.attendance.attendancePct != null && (
                            <span style={{ color: "#6b7280", fontSize: 11 }}>
                              {" "}
                              (~{row.attendance.attendancePct}%)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: "#d1d5db", fontSize: 12 }}>—</span>
                      )}
                    </td>
                  )}
                  {showEla && (
                    <SubjectCells
                      block={row.ela}
                      subjectLabel="ELA"
                      showLg={visibility.lg}
                      showPriorPm3={visibility.priorPm3}
                      showPm3={visibility.pm3}
                      showPm1={visibility.pm1}
                      showPm2={visibility.pm2}
                    />
                  )}
                  {showMath && (
                    <SubjectCells
                      block={row.math}
                      subjectLabel="Math"
                      showLg={visibility.lg}
                      showPriorPm3={visibility.priorPm3}
                      showPm3={visibility.pm3}
                      showPm1={visibility.pm1}
                      showPm2={visibility.pm2}
                    />
                  )}
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
      </PillViewContext.Provider>
      )}
      {sepTarget && sepSectionId != null && (
        <SuggestSeparationModal
          classSectionId={sepSectionId}
          primaryStudentId={sepTarget.studentId}
          primaryStudentName={sepTarget.studentName}
          onClose={() => setSepTarget(null)}
          onSaved={() => setSepTick((t) => t + 1)}
        />
      )}
      {tier3Modal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Tier 3 weekly tracking for ${tier3Modal.studentName}`}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "3vh 16px",
            overflowY: "auto",
            zIndex: 1000,
          }}
          onClick={() => setTier3Modal(null)}
        >
          <div
            style={{
              background: "white",
              borderRadius: 10,
              padding: "1.25rem",
              maxWidth: 920,
              width: "100%",
              boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Tier3WeeklyForm
              studentId={tier3Modal.studentId}
              studentName={tier3Modal.studentName}
              isCoreTeam={isCoreTeam}
              weekStartDate={tier3WeekStart || mondayOf(new Date())}
              onSaved={() => {
                setTier3Modal(null);
                refresh();
              }}
              onCancel={() => setTier3Modal(null)}
            />
          </div>
        </div>
      )}
      {logModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "3vh 16px",
            overflowY: "auto",
            zIndex: 1000,
          }}
          onClick={() => setLogModal(null)}
        >
          <div
            style={{
              background: "white",
              borderRadius: 10,
              padding: "1.25rem",
              maxWidth: 560,
              width: "100%",
              boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <QuickLogForm
              studentId={logModal.studentId}
              studentName={logModal.studentName}
              localSisId={logModal.localSisId}
              behaviors={negBehaviors}
              interventionTypes={ivTypes}
              onSaved={() => {
                setLogModal(null);
                refresh();
              }}
              onCancel={() => setLogModal(null)}
            />
          </div>
        </div>
      )}
      {chatModal && (
        <SelfDataChatModal
          key={chatModal}
          studentId={chatModal}
          onClose={() => setChatModal(null)}
          onLogged={() => setChatTick((n) => n + 1)}
        />
      )}
    </div>
  );
}
