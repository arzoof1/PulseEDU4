// Insights Watchlist — system-driven, data-backed view of every student
// the caller can see, sorted so the highest-need students surface
// first. Default Insights landing page.
//
// v2 layout (graduated April 2026): card-grid redesign with severity
// stripes, signal chips, pillar mini-grid, and saved-view pill tabs.
// Same data + filter behavior as v1 — only the render changed. The
// table-style v1 lived here from launch through April 2026; the new
// cards are easier to scan at a glance, especially for the cohort
// triage workflow ("who needs attention this week?").
//
// Backed by GET /api/insights/watchlist. The backend handles visibility
// scope — a plain teacher's payload only contains roster ∪ trusted-
// adult students; core team sees the full school.
//
// Follow-ups not yet wired (would need API extensions):
//   - "Trend" microcopy ("↑ 6 more negatives than last week")
//   - "New on watch this week" badges
//   - System ↔ My Watch List cross-link (heart pin if also bookmarked)

import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import { fetchAllStudents } from "../lib/students";
import {
  HowToUseHelp,
  HowToSection,
  howtoListStyle,
} from "./HowToUseHelp";

interface StudentLookup {
  studentId: string;
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number | string | null;
}

type WindowKey = "3" | "7" | "15" | "30" | "custom";

interface Row {
  studentId: string;
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  gender: string | null;
  flags: {
    ell: boolean;
    ese: boolean;
    is504: boolean;
    ctEla: boolean;
    ctMath: boolean;
  };
  mtssTier: number;
  bqEla: boolean;
  bqMath: boolean;
  behaviorCount: number;
  tardyCount: number;
  issDayCount: number;
  // Semester-total official days absent (null when the school has no
  // Eligibility Hub upload — never fabricated to 0).
  absences: number | null;
  // True when the student trips at least one risk trigger (server-computed
  // using the school's Watch List thresholds). Drives the default gate.
  needsAttention: boolean;
  // Counts from the immediately-prior window of the same length —
  // used to render the "↑ N from prior" trend microcopy and the
  // "✨ New this period" badge. Always present; the server defaults
  // to 0 when no rows existed for that student in the prev window.
  previousBehaviorCount: number;
  previousIssDayCount: number;
  isNewThisWindow: boolean;
  topRiskFlag:
    | { code: string; severity: "info" | "watch" | "high"; label: string }
    | null;
  riskFlagCount: number;
}

interface Filters {
  window: WindowKey;
  // "attention" (default) shows only students tripping ≥1 risk trigger;
  // "all" is the "show full roster" escape hatch.
  scope: "attention" | "all";
  customFrom: string;
  customTo: string;
  grade: string;
  gender: string;
  ell: "" | "true" | "false";
  ese: "" | "true" | "false";
  is504: "" | "true" | "false";
  ctEla: "" | "true" | "false";
  ctMath: "" | "true" | "false";
  tier: "" | "1" | "2" | "3";
  bqEla: "" | "true" | "false";
  bqMath: "" | "true" | "false";
}

const EMPTY_FILTERS: Filters = {
  window: "30",
  scope: "attention",
  customFrom: "",
  customTo: "",
  grade: "",
  gender: "",
  ell: "",
  ese: "",
  is504: "",
  ctEla: "",
  ctMath: "",
  tier: "",
  bqEla: "",
  bqMath: "",
};

// Built-in saved-filter presets — surfaced as pill tabs at the top of
// the page. Mirror the eduCLIMBER team-meeting rituals: "what should
// we look at this week" + a few common drill-ins. Users can add their
// own via the "Save current view" button.
const BUILTIN_PRESETS: Array<{ name: string; filters: Partial<Filters> }> = [
  { name: "MTSS Team · this week", filters: { window: "7", tier: "" } },
  { name: "Tier 2", filters: { window: "30", tier: "2" } },
  { name: "Tier 3", filters: { window: "30", tier: "3" } },
  { name: "Bottom Quartile ELA", filters: { window: "30", bqEla: "true" } },
  { name: "Bottom Quartile Math", filters: { window: "30", bqMath: "true" } },
];

const PRESETS_STORAGE_KEY = "pulseedu.insights.watchlist.presets";

interface SavedPreset {
  name: string;
  filters: Filters;
}

function loadSavedPresets(): SavedPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedPreset =>
        p &&
        typeof p.name === "string" &&
        p.filters &&
        typeof p.filters === "object",
    );
  } catch {
    return [];
  }
}

function saveSavedPresets(presets: SavedPreset[]) {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* localStorage full / disabled — silent */
  }
}

// Severity tone palette. Keep in sync with the WatchListRedesign mockup
// in mockup-sandbox so future variant explorations stay visually
// continuous with the live page.
const SEVERITY_TONES: Record<
  "info" | "watch" | "high",
  {
    bg: string;
    fg: string;
    border: string;
    stripe: string;
    soft: string;
  }
> = {
  high: {
    bg: "#fee2e2",
    fg: "#991b1b",
    border: "#fca5a5",
    stripe: "#dc2626",
    soft: "#fff1f2",
  },
  watch: {
    bg: "#fef3c7",
    fg: "#92400e",
    border: "#fcd34d",
    stripe: "#d97706",
    soft: "#fffbeb",
  },
  info: {
    bg: "#e0e7ff",
    fg: "#3730a3",
    border: "#c7d2fe",
    stripe: "#6366f1",
    soft: "#eef2ff",
  },
};

function chip(
  label: string,
  sev: "info" | "watch" | "high",
  size: "sm" | "xs" = "sm",
) {
  const s = SEVERITY_TONES[sev];
  return (
    <span
      style={{
        display: "inline-block",
        padding: size === "xs" ? "0.05rem 0.4rem" : "0.1rem 0.45rem",
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        borderRadius: 999,
        fontSize: size === "xs" ? "0.66rem" : "0.72rem",
        fontWeight: 600,
        marginRight: 4,
        marginBottom: 2,
        lineHeight: 1.3,
      }}
    >
      {label}
    </span>
  );
}

interface Props {
  onOpenStudent: (studentId: string) => void;
  onOpenSpider?: (studentId: string) => void;
}

// Pillar status type — whether a given dimension has any signal at all
// in this row, and how severe it is. Drives the 4-cell mini-grid on the
// right side of each card.
type PillarStatus = "ok" | "info" | "watch" | "high";

// School-configurable count-based thresholds surfaced by the watchlist
// endpoint. The client uses them so chip/pillar severity stays in step with
// the school's tuned Watch List triggers. Fallbacks match the schema defaults.
interface WatchlistThresholds {
  absence: number;
  behavior: number;
  tardy: number;
  iss: number;
}

const DEFAULT_THRESHOLDS: WatchlistThresholds = {
  absence: 10,
  behavior: 3,
  tardy: 5,
  iss: 1,
};

function computePillars(
  r: Row,
  thresholds: WatchlistThresholds,
): {
  academic: PillarStatus;
  behavior: PillarStatus;
  attendance: PillarStatus;
  mtss: PillarStatus;
} {
  // Academic: BQ flags are the strongest signal we have on the row
  // payload. Both quartiles → high; either → watch.
  const academic: PillarStatus =
    r.bqEla && r.bqMath ? "high" : r.bqEla || r.bqMath ? "watch" : "ok";

  // Behavior: ISS days at/above the ISS threshold are high; behavior
  // entries at/above the behavior threshold high; any below → watch.
  const behavior: PillarStatus =
    r.issDayCount >= thresholds.iss
      ? "high"
      : r.behaviorCount >= thresholds.behavior
        ? "high"
        : r.behaviorCount > 0 || r.issDayCount > 0
          ? "watch"
          : "ok";

  // Attendance proxy: tardies (and absences) are the attendance signals in
  // the watchlist payload. At/above the tardy or absence threshold → high;
  // any below → watch.
  const attendanceHigh =
    r.tardyCount >= thresholds.tardy ||
    (r.absences != null && r.absences >= thresholds.absence);
  const attendanceWatch =
    r.tardyCount > 0 || (r.absences != null && r.absences > 0);
  const attendance: PillarStatus = attendanceHigh
    ? "high"
    : attendanceWatch
      ? "watch"
      : "ok";

  // MTSS: tier 3 high, tier 2 watch, tier 1 ok.
  const mtss: PillarStatus =
    r.mtssTier >= 3 ? "high" : r.mtssTier === 2 ? "watch" : "ok";

  return { academic, behavior, attendance, mtss };
}

function pillarTone(status: PillarStatus): {
  bg: string;
  fg: string;
  border: string;
  label: string;
} {
  switch (status) {
    case "high":
      return {
        bg: "#fee2e2",
        fg: "#991b1b",
        border: "#fca5a5",
        label: "high",
      };
    case "watch":
      return {
        bg: "#fef3c7",
        fg: "#92400e",
        border: "#fcd34d",
        label: "watch",
      };
    case "info":
      return {
        bg: "#e0e7ff",
        fg: "#3730a3",
        border: "#c7d2fe",
        label: "info",
      };
    default:
      return {
        bg: "#f3f4f6",
        fg: "#9ca3af",
        border: "#e5e7eb",
        label: "ok",
      };
  }
}

// Initials for the avatar dot. First letter of first + last name; falls
// back to "?" if both are empty.
function initials(first: string, last: string): string {
  const f = first?.trim()?.[0] ?? "";
  const l = last?.trim()?.[0] ?? "";
  const both = `${f}${l}`.toUpperCase();
  return both || "?";
}

// Stable color tone for the avatar based on the studentId hash. Keeps
// each kid's avatar visually consistent across renders without needing
// a stored preference.
function avatarTone(studentId: string): { bg: string; fg: string } {
  const palette: Array<{ bg: string; fg: string }> = [
    { bg: "#dbeafe", fg: "#1e40af" },
    { bg: "#dcfce7", fg: "#166534" },
    { bg: "#fef3c7", fg: "#92400e" },
    { bg: "#fce7f3", fg: "#9d174d" },
    { bg: "#ede9fe", fg: "#5b21b6" },
    { bg: "#cffafe", fg: "#155e75" },
    { bg: "#fee2e2", fg: "#991b1b" },
    { bg: "#fef9c3", fg: "#854d0e" },
  ];
  let h = 0;
  for (let i = 0; i < studentId.length; i++) {
    h = (h * 31 + studentId.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length];
}

// Sort options surfaced in the toolbar. Shorter than v1's per-column
// header click since cards don't have headers — instead the user
// chooses a sort axis once.
const SORT_OPTIONS: Array<{
  value: "risk" | "name" | "grade" | "tier" | "behavior" | "iss" | "tardy";
  label: string;
}> = [
  { value: "risk", label: "Top risk" },
  { value: "tier", label: "MTSS tier" },
  { value: "behavior", label: "Behavior count" },
  { value: "iss", label: "ISS days" },
  { value: "tardy", label: "Tardies" },
  { value: "name", label: "Name (A→Z)" },
  { value: "grade", label: "Grade (low→high)" },
];

export default function InsightsWatchlist({
  onOpenStudent,
  onOpenSpider,
}: Props) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<Row[]>([]);
  const [windowLabel, setWindowLabel] = useState("");
  const [scopeCounts, setScopeCounts] = useState<{
    totalInScope: number | null;
    attentionCount: number | null;
  }>({ totalInScope: null, attentionCount: null });
  const [thresholds, setThresholds] =
    useState<WatchlistThresholds>(DEFAULT_THRESHOLDS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() =>
    loadSavedPresets(),
  );
  const [sortBy, setSortBy] = useState<
    "name" | "grade" | "tier" | "behavior" | "iss" | "tardy" | "risk"
  >("risk");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [studentDirectory, setStudentDirectory] = useState<StudentLookup[]>([]);
  const [studentQuery, setStudentQuery] = useState("");
  const [studentDropdownOpen, setStudentDropdownOpen] = useState(false);
  const studentBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAllStudents<StudentLookup>()
      .then((rowsResp) => {
        if (cancelled) return;
        setStudentDirectory(rowsResp);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!studentDropdownOpen) return;
    function onDocClick(e: MouseEvent) {
      if (
        studentBoxRef.current &&
        !studentBoxRef.current.contains(e.target as Node)
      ) {
        setStudentDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [studentDropdownOpen]);

  const studentMatches = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return studentDirectory.slice(0, 12);
    return studentDirectory
      .filter((s) => {
        const name = `${s.firstName} ${s.lastName}`.toLowerCase();
        const flipped = `${s.lastName} ${s.firstName}`.toLowerCase();
        return (
          name.includes(q) ||
          flipped.includes(q) ||
          (s.studentId ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, 12);
  }, [studentQuery, studentDirectory]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("window", filters.window);
    p.set("scope", filters.scope);
    if (filters.window === "custom") {
      if (filters.customFrom) p.set("from", filters.customFrom);
      if (filters.customTo) p.set("to", filters.customTo);
    }
    if (filters.grade) p.set("grade", filters.grade);
    if (filters.gender) p.set("gender", filters.gender);
    if (filters.ell) p.set("ell", filters.ell);
    if (filters.ese) p.set("ese", filters.ese);
    if (filters.is504) p.set("is504", filters.is504);
    if (filters.ctEla) p.set("ctEla", filters.ctEla);
    if (filters.ctMath) p.set("ctMath", filters.ctMath);
    if (filters.tier) p.set("tier", filters.tier);
    if (filters.bqEla) p.set("bqEla", filters.bqEla);
    if (filters.bqMath) p.set("bqMath", filters.bqMath);
    return p.toString();
  }, [filters]);

  useEffect(() => {
    setLoading(true);
    setError("");
    let cancelled = false;
    authFetch(`/api/insights/watchlist?${queryString}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setRows(data.rows ?? []);
        setWindowLabel(data.window?.label ?? "");
        setScopeCounts({
          totalInScope:
            typeof data.totalInScope === "number" ? data.totalInScope : null,
          attentionCount:
            typeof data.attentionCount === "number"
              ? data.attentionCount
              : null,
        });
        const t = data.thresholds;
        setThresholds({
          absence:
            typeof t?.absence === "number"
              ? t.absence
              : DEFAULT_THRESHOLDS.absence,
          behavior:
            typeof t?.behavior === "number"
              ? t.behavior
              : DEFAULT_THRESHOLDS.behavior,
          tardy:
            typeof t?.tardy === "number" ? t.tardy : DEFAULT_THRESHOLDS.tardy,
          iss: typeof t?.iss === "number" ? t.iss : DEFAULT_THRESHOLDS.iss,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message ?? "Failed to load watchlist");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  const cohortSummary = useMemo(() => {
    const total = rows.length;
    let tier1 = 0;
    let tier2 = 0;
    let tier3 = 0;
    let bqEla = 0;
    let bqMath = 0;
    let highBehavior = 0;
    let highTardy = 0;
    let anyIss = 0;
    let highRisk = 0;
    let watchRisk = 0;
    for (const r of rows) {
      if (r.mtssTier <= 1) tier1++;
      else if (r.mtssTier === 2) tier2++;
      else if (r.mtssTier >= 3) tier3++;
      if (r.bqEla) bqEla++;
      if (r.bqMath) bqMath++;
      if (r.behaviorCount >= 3) highBehavior++;
      if (r.tardyCount >= 5) highTardy++;
      if (r.issDayCount > 0) anyIss++;
      if (r.topRiskFlag?.severity === "high") highRisk++;
      if (r.topRiskFlag?.severity === "watch") watchRisk++;
    }
    return {
      total,
      tier1,
      tier2,
      tier3,
      bqEla,
      bqMath,
      highBehavior,
      highTardy,
      anyIss,
      highRisk,
      watchRisk,
    };
  }, [rows]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const dir = sortDir === "asc" ? 1 : -1;
    const SEV_RANK = { high: 3, watch: 2, info: 1 } as const;
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "name":
          cmp = `${a.lastName} ${a.firstName}`.localeCompare(
            `${b.lastName} ${b.firstName}`,
          );
          break;
        case "grade":
          cmp = a.grade - b.grade;
          break;
        case "tier":
          cmp = a.mtssTier - b.mtssTier;
          break;
        case "behavior":
          cmp = a.behaviorCount - b.behaviorCount;
          break;
        case "iss":
          cmp = a.issDayCount - b.issDayCount;
          break;
        case "tardy":
          cmp = a.tardyCount - b.tardyCount;
          break;
        case "risk": {
          const ar = a.topRiskFlag ? SEV_RANK[a.topRiskFlag.severity] : 0;
          const br = b.topRiskFlag ? SEV_RANK[b.topRiskFlag.severity] : 0;
          cmp = ar - br || a.riskFlagCount - b.riskFlagCount;
          break;
        }
      }
      return cmp * dir;
    });
    return copy;
  }, [rows, sortBy, sortDir]);

  // Map a row to its driving severity (the stripe color + the avatar
  // ring). Falls back to "info" when the API hasn't surfaced a top
  // risk so the card still has a definite tone.
  function rowSeverity(r: Row): "info" | "watch" | "high" {
    if (r.topRiskFlag) return r.topRiskFlag.severity;
    // No top risk flag — use the tier as a soft signal.
    if (r.mtssTier >= 3) return "high";
    if (r.mtssTier === 2) return "watch";
    return "info";
  }

  // Build the inline "what fired" chip list. Order: top risk first,
  // then behavior counts, ISS, tardies, BQ, tier label, demographic
  // flags. Capped at ~5 visible chips so the cards stay scannable;
  // overflow is shown as "+N more".
  function rowSignals(r: Row): Array<{
    label: string;
    sev: "info" | "watch" | "high";
  }> {
    const out: Array<{ label: string; sev: "info" | "watch" | "high" }> = [];
    if (r.topRiskFlag) {
      out.push({ label: r.topRiskFlag.label, sev: r.topRiskFlag.severity });
    }
    if (r.behaviorCount > 0) {
      out.push({
        label: `Negatives ${r.behaviorCount}`,
        sev: r.behaviorCount >= thresholds.behavior ? "high" : "watch",
      });
    }
    if (r.issDayCount > 0) {
      out.push({
        label: `ISS days ${r.issDayCount}`,
        sev: r.issDayCount >= thresholds.iss ? "high" : "watch",
      });
    }
    if (r.tardyCount > 0) {
      out.push({
        label: `Tardies ${r.tardyCount}`,
        sev: r.tardyCount >= thresholds.tardy ? "high" : "watch",
      });
    }
    if (r.absences != null && r.absences > 0) {
      out.push({
        label: `Absences ${r.absences}`,
        sev: r.absences >= thresholds.absence ? "high" : "watch",
      });
    }
    if (r.bqEla) out.push({ label: "BQ ELA", sev: "high" });
    if (r.bqMath) out.push({ label: "BQ Math", sev: "high" });
    if (r.mtssTier >= 2) {
      out.push({
        label: `Tier ${r.mtssTier} plan`,
        sev: r.mtssTier === 3 ? "high" : "watch",
      });
    }
    if (r.flags.ell) out.push({ label: "ELL", sev: "info" });
    if (r.flags.ese) out.push({ label: "ESE", sev: "info" });
    if (r.flags.is504) out.push({ label: "504", sev: "info" });
    if (r.flags.ctEla) out.push({ label: "CT ELA", sev: "info" });
    if (r.flags.ctMath) out.push({ label: "CT Math", sev: "info" });
    return out;
  }

  function applyPreset(p: Partial<Filters>) {
    setFilters({ ...EMPTY_FILTERS, ...p } as Filters);
  }

  function saveCurrentAsPreset() {
    const name = window.prompt(
      "Name this view (e.g., 'Friday MTSS huddle')",
    );
    if (!name) return;
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) return;
    const next = [
      ...savedPresets.filter((p) => p.name !== trimmed),
      { name: trimmed, filters },
    ];
    setSavedPresets(next);
    saveSavedPresets(next);
  }

  function deletePreset(name: string) {
    if (!window.confirm(`Delete view "${name}"?`)) return;
    const next = savedPresets.filter((p) => p.name !== name);
    setSavedPresets(next);
    saveSavedPresets(next);
  }

  // Detect whether the current filters match a built-in preset (so we
  // can highlight that pill). Compares only the non-default fields.
  function presetIsActive(presetFilters: Partial<Filters>): boolean {
    const merged = { ...EMPTY_FILTERS, ...presetFilters } as Filters;
    return (
      merged.window === filters.window &&
      merged.tier === filters.tier &&
      merged.bqEla === filters.bqEla &&
      merged.bqMath === filters.bqMath
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: "0.75rem",
          marginBottom: "0.25rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Watch List</h2>
        <span
          style={{
            color: "var(--text-subtle)",
            fontSize: "0.85rem",
          }}
        >
          {windowLabel
            ? `Window: ${windowLabel}`
            : "All students you can see, sorted by top risk"}
        </span>
        <div
          role="radiogroup"
          aria-label="Watch List scope"
          style={{
            display: "inline-flex",
            border: "1px solid #d1d5db",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {(
            [
              { key: "attention", label: "Needs attention" },
              { key: "all", label: "Full roster" },
            ] as { key: Filters["scope"]; label: string }[]
          ).map((opt) => {
            const active = filters.scope === opt.key;
            const count =
              opt.key === "attention"
                ? scopeCounts.attentionCount
                : scopeCounts.totalInScope;
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setFilters({ ...filters, scope: opt.key })}
                style={{
                  border: "none",
                  padding: "0.3rem 0.7rem",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  background: active ? "#0d9488" : "white",
                  color: active ? "white" : "#0d9488",
                }}
              >
                {opt.label}
                {count != null ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>
      </div>
      {filters.scope === "attention" &&
        scopeCounts.totalInScope != null &&
        scopeCounts.attentionCount != null &&
        scopeCounts.totalInScope > scopeCounts.attentionCount && (
          <p
            style={{
              margin: "0 0 0.5rem",
              fontSize: "0.82rem",
              color: "var(--text-subtle)",
            }}
          >
            Showing {scopeCounts.attentionCount} student
            {scopeCounts.attentionCount === 1 ? "" : "s"} who need attention.{" "}
            <button
              type="button"
              onClick={() => setFilters({ ...filters, scope: "all" })}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                color: "#0d9488",
                fontWeight: 600,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Show full roster ({scopeCounts.totalInScope})
            </button>
          </p>
        )}
      <HowToUseHelp title="How to use the Watch List">
        <HowToSection title="What this is">
          The Watch List shows every student you can see, ranked by
          their top current risk signal. Cards are coloured by severity
          (red = High, amber = Watch, blue = Info) and surface the
          biggest concerns first — recent referrals, low FAST/iReady
          performance, attendance dips, MTSS plan status, and more.
          Data refreshes whenever the page loads.
        </HowToSection>
        <HowToSection title="How to read a card">
          <ul style={howtoListStyle}>
            <li>
              <strong>Severity stripe</strong> on the left — at-a-glance
              urgency. Red cards are usually worth opening first.
            </li>
            <li>
              <strong>Signal chips</strong> in the middle — the specific
              flags that put the student here (e.g. "3 referrals last 30d",
              "FAST below proficient"). Up to five chips fit; an overflow
              chip ("+3 more") summarises the rest — open the profile to
              see them all.
            </li>
            <li>
              <strong>Pillar mini-grid</strong> on the right — quick read
              on whether the student has Acad / Beh / Att / MTSS signals.
              A filled square means there's something to look at in that
              area.
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="Day-to-day workflow">
          <ul style={howtoListStyle}>
            <li>
              <strong>Filter to who you care about.</strong> Use the preset
              pill row at the top (e.g. "My students", "High risk only",
              "Math concerns") or "More filters" for grade / pillar /
              severity / MTSS-tier. Saved filter presets show up as their
              own pills.
            </li>
            <li>
              <strong>Sort to suit.</strong> The default is by top risk;
              switch to alphabetical, by grade, or by recently-changed via
              the sort menu.
            </li>
            <li>
              <strong>Click a card</strong> to open the full Student
              Profile (the whole-child view). Use Back to return — your
              filters and scroll position are preserved.
            </li>
            <li>
              <strong>Quick lookup</strong> — start typing a name in the
              search box to jump straight to a student without scrolling.
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="Watch List vs My Watch List">
          This page is the <em>system</em> Watch List — driven by the
          data, refreshed automatically, and shared with anyone else
          who has the same student visibility. If you want a personal
          space to track "kids on my mind" with your own notes and
          follow-ups, use <strong>My Watch List</strong> in the
          sidebar — that one's private to you.
        </HowToSection>
      </HowToUseHelp>
      <p
        style={{
          color: "var(--text-subtle)",
          marginTop: "0.75rem",
          marginBottom: "0.75rem",
          fontSize: "0.85rem",
        }}
      >
        Card grid view of every student in scope. Click a card to open
        the full profile, or use the sidebar tabs to swap to your
        personal "My Watch List" of bookmarked students.
      </p>

      {/* KPI strip — derived from the currently-loaded rows. Gives the
          cohort context at a glance before scanning individual cards. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.5rem",
          marginBottom: "0.75rem",
        }}
        aria-label="Cohort KPI strip"
      >
        <KpiTile
          label="Students in view"
          value={cohortSummary.total}
          tone="info"
        />
        <KpiTile
          label="High-risk top flag"
          value={cohortSummary.highRisk}
          tone={cohortSummary.highRisk > 0 ? "high" : "info"}
        />
        <KpiTile
          label="Watch-level top flag"
          value={cohortSummary.watchRisk}
          tone={cohortSummary.watchRisk > 0 ? "watch" : "info"}
        />
        <KpiTile
          label="Tier 3"
          value={cohortSummary.tier3}
          tone={cohortSummary.tier3 > 0 ? "high" : "info"}
        />
        <KpiTile
          label="Tier 2"
          value={cohortSummary.tier2}
          tone={cohortSummary.tier2 > 0 ? "watch" : "info"}
        />
        <KpiTile
          label="With ISS days"
          value={cohortSummary.anyIss}
          tone={cohortSummary.anyIss > 0 ? "high" : "info"}
        />
      </div>

      {/* Saved-view pills — built-in + user saved. Acts as the primary
          "what am I looking at" tab bar; full filter set lives behind
          the "More filters" toggle below. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.4rem",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
        aria-label="Saved views"
      >
        <button
          type="button"
          onClick={() => setFilters(EMPTY_FILTERS)}
          style={pillStyle(
            filters.window === "30" &&
              filters.tier === "" &&
              filters.bqEla === "" &&
              filters.bqMath === "",
            "indigo",
          )}
        >
          All · 30d
        </button>
        {BUILTIN_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => applyPreset(p.filters)}
            style={pillStyle(presetIsActive(p.filters), "indigo")}
          >
            {p.name}
          </button>
        ))}
        {savedPresets.map((p) => (
          <span
            key={p.name}
            style={{
              display: "inline-flex",
              alignItems: "stretch",
              borderRadius: 999,
              border: "1px solid #a5f3fc",
              background: "#ecfeff",
              fontSize: "0.78rem",
              fontWeight: 600,
            }}
          >
            <button
              type="button"
              onClick={() => applyPreset(p.filters)}
              style={{
                padding: "0.25rem 0.7rem",
                background: "transparent",
                border: "none",
                color: "#0e7490",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {p.name}
            </button>
            <button
              type="button"
              onClick={() => deletePreset(p.name)}
              title="Delete view"
              aria-label={`Delete view ${p.name}`}
              style={{
                padding: "0.25rem 0.5rem",
                background: "transparent",
                border: "none",
                borderLeft: "1px solid #a5f3fc",
                color: "#0e7490",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={saveCurrentAsPreset}
          style={{
            padding: "0.25rem 0.7rem",
            background: "white",
            border: "1px dashed #9ca3af",
            borderRadius: 999,
            fontSize: "0.78rem",
            color: "#374151",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          + Save current view
        </button>
      </div>

      {/* Toolbar row — quick lookup, window selector, sort, more filters. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          gap: "0.5rem",
          marginBottom: "0.75rem",
          paddingBottom: "0.75rem",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <div ref={studentBoxRef} style={{ position: "relative", flex: "1 1 240px", minWidth: 220 }}>
          <label
            htmlFor="watchlist-student-lookup"
            style={{
              display: "block",
              fontSize: "0.72rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: 2,
            }}
          >
            Quick lookup
          </label>
          <input
            id="watchlist-student-lookup"
            type="text"
            value={studentQuery}
            placeholder="Find a student by name or ID…"
            aria-label="Look up an individual student by name or ID"
            onFocus={() => setStudentDropdownOpen(true)}
            onChange={(e) => {
              setStudentQuery(e.target.value);
              setStudentDropdownOpen(true);
            }}
            style={{
              width: "100%",
              padding: "0.35rem 0.5rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          />
          {studentDropdownOpen && studentMatches.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                background: "white",
                border: "1px solid #d1d5db",
                borderRadius: 6,
                marginTop: 2,
                boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                maxHeight: 280,
                overflowY: "auto",
                zIndex: 20,
              }}
            >
              {studentMatches.map((s) => (
                <button
                  key={s.studentId}
                  type="button"
                  onClick={() => {
                    setStudentDropdownOpen(false);
                    setStudentQuery("");
                    onOpenStudent(s.studentId);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "0.4rem 0.6rem",
                    background: "white",
                    border: "none",
                    borderBottom: "1px solid #f3f4f6",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <div style={{ fontWeight: 600 }}>
                    {s.lastName}, {s.firstName}
                  </div>
                  <div
                    style={{
                      fontSize: "0.72rem",
                      color: "#9ca3af",
                    }}
                  >
                    {s.localSisId ?? "—"}
                    {s.grade !== null &&
                    s.grade !== undefined &&
                    s.grade !== ""
                      ? ` · Grade ${s.grade}`
                      : ""}
                  </div>
                </button>
              ))}
            </div>
          )}
          {studentDropdownOpen &&
            studentQuery.trim() &&
            studentMatches.length === 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  background: "white",
                  border: "1px solid #d1d5db",
                  borderRadius: 6,
                  marginTop: 2,
                  padding: "0.5rem 0.6rem",
                  fontSize: "0.8rem",
                  color: "#6b7280",
                  zIndex: 20,
                }}
              >
                No students match "{studentQuery}".
              </div>
            )}
        </div>

        <div>
          <label
            htmlFor="watchlist-window"
            style={{
              display: "block",
              fontSize: "0.72rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: 2,
            }}
          >
            Window
          </label>
          <select
            id="watchlist-window"
            value={filters.window}
            onChange={(e) =>
              setFilters({ ...filters, window: e.target.value as WindowKey })
            }
            style={{
              padding: "0.35rem 0.5rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.85rem",
              background: "white",
            }}
          >
            <option value="3">Last 3 days</option>
            <option value="7">Last 7 days</option>
            <option value="15">Last 15 days</option>
            <option value="30">Last 30 days</option>
            <option value="custom">Custom range…</option>
          </select>
        </div>

        {filters.window === "custom" && (
          <>
            <div>
              <label
                htmlFor="watchlist-from"
                style={{
                  display: "block",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 2,
                }}
              >
                From
              </label>
              <input
                id="watchlist-from"
                type="date"
                value={filters.customFrom}
                onChange={(e) =>
                  setFilters({ ...filters, customFrom: e.target.value })
                }
                style={{
                  padding: "0.3rem",
                  border: "1px solid #d1d5db",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                }}
              />
            </div>
            <div>
              <label
                htmlFor="watchlist-to"
                style={{
                  display: "block",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  color: "#374151",
                  marginBottom: 2,
                }}
              >
                To
              </label>
              <input
                id="watchlist-to"
                type="date"
                value={filters.customTo}
                onChange={(e) =>
                  setFilters({ ...filters, customTo: e.target.value })
                }
                style={{
                  padding: "0.3rem",
                  border: "1px solid #d1d5db",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                }}
              />
            </div>
          </>
        )}

        <div>
          <label
            htmlFor="watchlist-sort"
            style={{
              display: "block",
              fontSize: "0.72rem",
              fontWeight: 600,
              color: "#374151",
              marginBottom: 2,
            }}
          >
            Sort by
          </label>
          <select
            id="watchlist-sort"
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [b, d] = e.target.value.split(":");
              setSortBy(b as typeof sortBy);
              setSortDir(d as "asc" | "desc");
            }}
            style={{
              padding: "0.35rem 0.5rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.85rem",
              background: "white",
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <optgroup key={o.value} label={o.label}>
                <option value={`${o.value}:desc`}>
                  {o.label} (high → low)
                </option>
                <option value={`${o.value}:asc`}>
                  {o.label} (low → high)
                </option>
              </optgroup>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          style={{
            marginLeft: "auto",
            padding: "0.4rem 0.7rem",
            background: filtersOpen ? "#0d9488" : "white",
            color: filtersOpen ? "white" : "#0d9488",
            border: "1px solid #0d9488",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: "0.8rem",
            fontWeight: 600,
          }}
          aria-expanded={filtersOpen}
          aria-controls="watchlist-more-filters"
        >
          {filtersOpen ? "Hide filters" : "More filters"}
        </button>

        <button
          type="button"
          onClick={() => setFilters(EMPTY_FILTERS)}
          style={{
            padding: "0.4rem 0.7rem",
            background: "white",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: "0.8rem",
            color: "#374151",
            fontWeight: 600,
          }}
        >
          Reset
        </button>
      </div>

      {/* Collapsible advanced filters — keeps the v1 demographic /
          flag selectors available without crowding the toolbar. */}
      {filtersOpen && (
        <div
          id="watchlist-more-filters"
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fill, minmax(160px, 1fr))",
            gap: "0.5rem",
            marginBottom: "0.75rem",
            padding: "0.6rem",
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
          }}
        >
          <select
            value={filters.grade}
            onChange={(e) =>
              setFilters({ ...filters, grade: e.target.value })
            }
            style={selectStyle}
            aria-label="Grade"
          >
            <option value="">Any grade</option>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
              <option key={g} value={g}>
                Grade {g}
              </option>
            ))}
          </select>
          <select
            value={filters.gender}
            onChange={(e) =>
              setFilters({ ...filters, gender: e.target.value })
            }
            style={selectStyle}
            aria-label="Gender"
          >
            <option value="">Any gender</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Non-binary">Non-binary</option>
          </select>
          {(
            [
              ["ell", "ELL"],
              ["ese", "ESE"],
              ["is504", "504"],
              ["ctEla", "CT ELA"],
              ["ctMath", "CT Math"],
              ["bqEla", "BQ ELA"],
              ["bqMath", "BQ Math"],
            ] as const
          ).map(([key, label]) => (
            <select
              key={key}
              value={filters[key]}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  [key]: e.target.value as "" | "true" | "false",
                })
              }
              style={selectStyle}
              aria-label={`${label} filter`}
            >
              <option value="">{label}: any</option>
              <option value="true">{label}: yes</option>
              <option value="false">{label}: no</option>
            </select>
          ))}
          <select
            value={filters.tier}
            onChange={(e) =>
              setFilters({
                ...filters,
                tier: e.target.value as Filters["tier"],
              })
            }
            style={selectStyle}
            aria-label="MTSS tier"
          >
            <option value="">Tier: any</option>
            <option value="1">Tier 1</option>
            <option value="2">Tier 2</option>
            <option value="3">Tier 3</option>
          </select>
        </div>
      )}

      {error && (
        <div
          style={{
            background: "#fee2e2",
            color: "#991b1b",
            padding: "0.5rem",
            borderRadius: 6,
            marginBottom: "0.5rem",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      ) : sortedRows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          No students match these filters. (If you're a teacher, your
          scope is your roster plus any students you've been linked to as
          a trusted adult.)
        </p>
      ) : (
        <>
          <div
            style={{
              marginBottom: "0.5rem",
              color: "#6b7280",
              fontSize: "0.85rem",
            }}
          >
            Showing {sortedRows.length} student
            {sortedRows.length === 1 ? "" : "s"}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fill, minmax(360px, 1fr))",
              gap: "0.75rem",
            }}
          >
            {sortedRows.map((r) => (
              <WatchCard
                key={r.studentId}
                row={r}
                severity={rowSeverity(r)}
                signals={rowSignals(r)}
                pillars={computePillars(r, thresholds)}
                onOpen={() => onOpenStudent(r.studentId)}
                onSpider={
                  onOpenSpider ? () => onOpenSpider(r.studentId) : undefined
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Helpers + sub-components ----------------------------------------

const selectStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: "0.8rem",
  background: "white",
};

function pillStyle(
  active: boolean,
  tone: "indigo",
): React.CSSProperties {
  // tone reserved for future per-pill colorways; today only "indigo"
  // for built-in views.
  void tone;
  return {
    padding: "0.25rem 0.7rem",
    background: active ? "#1e40af" : "#eef2ff",
    color: active ? "white" : "#1e40af",
    border: `1px solid ${active ? "#1e40af" : "#c7d2fe"}`,
    borderRadius: 999,
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}

function KpiTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "info" | "watch" | "high";
}) {
  const t = SEVERITY_TONES[tone];
  return (
    <div
      style={{
        background: t.soft,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: "0.5rem 0.6rem",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span
        style={{
          fontSize: "1.25rem",
          fontWeight: 700,
          color: t.fg,
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: "0.72rem",
          color: "#4b5563",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function WatchCard({
  row,
  severity,
  signals,
  pillars,
  onOpen,
  onSpider,
}: {
  row: Row;
  severity: "info" | "watch" | "high";
  signals: Array<{ label: string; sev: "info" | "watch" | "high" }>;
  pillars: ReturnType<typeof computePillars>;
  onOpen: () => void;
  onSpider?: () => void;
}) {
  const tone = SEVERITY_TONES[severity];
  const av = avatarTone(row.studentId);
  const visibleSignals = signals.slice(0, 5);
  const overflow = signals.length - visibleSignals.length;

  return (
    <div
      style={{
        position: "relative",
        background: "white",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        overflow: "hidden",
        display: "flex",
        cursor: "pointer",
      }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Open profile for ${row.firstName} ${row.lastName}`}
    >
      {/* Severity stripe — left edge */}
      <div
        aria-hidden="true"
        style={{ width: 6, background: tone.stripe, flexShrink: 0 }}
      />
      <div
        style={{
          padding: "0.7rem 0.75rem",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: "0.45rem",
          minWidth: 0,
        }}
      >
        {/* Header: avatar, name, grade, spider pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.55rem",
            minWidth: 0,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: av.bg,
              color: av.fg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: "0.85rem",
              border: `2px solid ${tone.border}`,
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            {initials(row.firstName, row.lastName)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: "0.92rem",
                color: "#111827",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {row.lastName}, {row.firstName}
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "#6b7280",
              }}
            >
              Grade {row.grade} · {row.localSisId ?? "—"}
            </div>
          </div>
          {row.isNewThisWindow && (
            <span
              title="No behavior or ISS in the prior window — this is a new appearance on the watch list."
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid #fde68a",
                background: "#fffbeb",
                color: "#92400e",
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1.2,
                flexShrink: 0,
              }}
            >
              <span aria-hidden="true">✨</span>
              <span>New this period</span>
            </span>
          )}
          {onSpider && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSpider();
              }}
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
                flexShrink: 0,
              }}
            >
              <span aria-hidden="true">🕸️</span>
              <span>Spider</span>
            </button>
          )}
        </div>

        {/* Signals — top risk + counts + flags. Capped to ~5. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 0 }}>
          {visibleSignals.length === 0 ? (
            <span style={{ color: "#9ca3af", fontSize: "0.78rem" }}>
              On the list — no recent flags in this window.
            </span>
          ) : (
            visibleSignals.map((s, i) => (
              <span key={i}>{chip(s.label, s.sev)}</span>
            ))
          )}
          {overflow > 0 && (
            <span
              style={{
                display: "inline-block",
                padding: "0.05rem 0.4rem",
                background: "#f3f4f6",
                color: "#374151",
                border: "1px solid #e5e7eb",
                borderRadius: 999,
                fontSize: "0.66rem",
                fontWeight: 600,
                marginRight: 4,
                marginBottom: 2,
              }}
            >
              +{overflow} more
            </span>
          )}
        </div>

        {/* Pillar mini-grid — Acad / Beh / Att / MTSS at-a-glance. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 4,
          }}
          aria-label="Pillar status"
        >
          <PillarCell
            label="Acad"
            status={pillars.academic}
          />
          <PillarCell
            label="Beh"
            status={pillars.behavior}
            trend={behaviorTrend(row)}
          />
          <PillarCell label="Att" status={pillars.attendance} />
          <PillarCell label="MTSS" status={pillars.mtss} />
        </div>
      </div>
    </div>
  );
}

// "↑ 2 from prior" / "↓ 1 from prior" microcopy under the Beh pillar.
// Returns null when the count is unchanged so the cell stays compact.
function behaviorTrend(r: Row): {
  arrow: "up" | "down";
  delta: number;
} | null {
  const delta = r.behaviorCount - r.previousBehaviorCount;
  if (delta === 0) return null;
  return { arrow: delta > 0 ? "up" : "down", delta: Math.abs(delta) };
}

function PillarCell({
  label,
  status,
  trend,
}: {
  label: string;
  status: PillarStatus;
  // Optional behavior trend microcopy. Currently only the Beh pillar
  // passes a value; other pillars omit it and render the standard
  // single-line cell.
  trend?: { arrow: "up" | "down"; delta: number } | null;
}) {
  const t = pillarTone(status);
  return (
    <div
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        padding: "0.25rem 0.3rem",
        textAlign: "center",
        fontSize: "0.68rem",
        fontWeight: 700,
        color: t.fg,
        textTransform: "uppercase",
        letterSpacing: 0.3,
        lineHeight: 1.2,
      }}
      title={
        trend
          ? `${label}: ${t.label} · ${trend.arrow === "up" ? "↑" : "↓"} ${trend.delta} from prior window`
          : `${label}: ${t.label}`
      }
    >
      {label}
      {trend && (
        <div
          style={{
            fontSize: "0.6rem",
            fontWeight: 600,
            textTransform: "none",
            letterSpacing: 0,
            opacity: 0.85,
            marginTop: 1,
          }}
        >
          {trend.arrow === "up" ? "↑" : "↓"} {trend.delta} from prior
        </div>
      )}
    </div>
  );
}
