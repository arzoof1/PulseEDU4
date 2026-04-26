// Insights Watchlist — filterable group view showing every student the
// caller can see. Default Insights landing page. Per-row chips
// summarize tier, BQ flags, behavior + ISS counts, and the top risk.
// Click a row to drill into the StudentProfile.
//
// Backed by GET /api/insights/watchlist. The backend handles visibility
// scope — a plain teacher's payload only contains roster ∪ trusted-
// adult students; core team sees the full school.

import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

// Minimal shape for the quick student-lookup combobox. Pulled from
// /api/students which the watchlist already has visibility into (the
// endpoint scopes its response the same way the watchlist itself does
// — roster ∪ trusted-adult for plain teachers, full school for core
// team).
interface StudentLookup {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string | null;
}

type WindowKey = "3" | "7" | "15" | "30" | "custom";

interface Row {
  studentId: string;
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
  topRiskFlag: { code: string; severity: "info" | "watch" | "high"; label: string } | null;
  riskFlagCount: number;
}

interface Filters {
  window: WindowKey;
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

// Built-in saved-filter presets. Mirror the eduCLIMBER team-meeting
// rituals: "what should we look at this week" + two common drill-ins.
// Users can add their own via the "Save current filters" button.
const BUILTIN_PRESETS: Array<{ name: string; filters: Partial<Filters> }> = [
  {
    name: "MTSS Team Weekly Review",
    filters: { window: "7", tier: "" },
  },
  {
    name: "Tier 2 — needs attention",
    filters: { window: "30", tier: "2" },
  },
  {
    name: "Tier 3 — needs attention",
    filters: { window: "30", tier: "3" },
  },
  {
    name: "Bottom Quartile ELA",
    filters: { window: "30", bqEla: "true" },
  },
  {
    name: "Bottom Quartile Math",
    filters: { window: "30", bqMath: "true" },
  },
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
        p && typeof p.name === "string" && p.filters && typeof p.filters === "object",
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

const SEVERITY_STYLES: Record<
  "info" | "watch" | "high",
  { background: string; color: string; border: string }
> = {
  high: { background: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
  watch: { background: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  info: { background: "#e0e7ff", color: "#3730a3", border: "#c7d2fe" },
};

function chip(label: string, sev: "info" | "watch" | "high") {
  const s = SEVERITY_STYLES[sev];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.1rem 0.45rem",
        background: s.background,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: 999,
        fontSize: "0.72rem",
        fontWeight: 600,
        marginRight: 4,
        marginBottom: 2,
      }}
    >
      {label}
    </span>
  );
}

interface Props {
  onOpenStudent: (studentId: string) => void;
  // Optional: when set, renders a small "Spider" pill next to each
  // student's name in the table that opens the whole-child radar
  // (StudentProfile / Spider) directly. Same pattern as TeacherRosterPage
  // — visibility is gated server-side, so we always render it when the
  // caller opts in. Click stops propagation so the row's own onClick
  // (which also navigates) doesn't double-fire.
  onOpenSpider?: (studentId: string) => void;
}

export default function InsightsWatchlist({ onOpenStudent, onOpenSpider }: Props) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<Row[]>([]);
  const [windowLabel, setWindowLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(() =>
    loadSavedPresets(),
  );
  const [sortBy, setSortBy] = useState<
    "name" | "grade" | "tier" | "behavior" | "iss" | "tardy" | "risk"
  >("risk");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Quick-lookup combobox state. Independent of the filter bar — picking
  // a student here jumps straight to the StudentProfile drill-in.
  const [studentDirectory, setStudentDirectory] = useState<StudentLookup[]>([]);
  const [studentQuery, setStudentQuery] = useState("");
  const [studentDropdownOpen, setStudentDropdownOpen] = useState(false);
  const studentBoxRef = useRef<HTMLDivElement | null>(null);

  // Pull the visible-to-actor student list once on mount. /api/students
  // already enforces the same visibility scope as the watchlist, so the
  // dropdown can never surface a student the caller couldn't open.
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/students")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: StudentLookup[]) => {
        if (cancelled) return;
        setStudentDirectory(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        /* silent — dropdown just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the dropdown when the user clicks outside the combobox.
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

  // Narrow the dropdown by typed query — match on first/last name or
  // student ID. Cap to 12 results so the menu stays usable on full
  // rosters; the user can keep typing to narrow further.
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

  // Build the query string from filters. Empty values are dropped so
  // server-side filter parsing treats them as "no filter."
  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("window", filters.window);
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

  // Cohort summary — aggregate stats over the currently filtered set.
  // Turns a list of individuals into actionable cohort intelligence so
  // an MTSS coordinator can read the room before scanning rows. All
  // numbers are derived from the rows the API already returned, so the
  // banner stays in sync with the active filters with no extra fetch.
  const cohortSummary = useMemo(() => {
    const total = rows.length;
    let tier1 = 0;
    let tier2 = 0;
    let tier3 = 0;
    let bqEla = 0;
    let bqMath = 0;
    let highBehavior = 0; // 3+ negative entries in window
    let highTardy = 0; // 5+ tardies in window
    let anyIss = 0;
    let highRisk = 0; // any high-severity top risk
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

  function applyPreset(p: Partial<Filters>) {
    setFilters({ ...EMPTY_FILTERS, ...p } as Filters);
  }

  function saveCurrentAsPreset() {
    const name = window.prompt(
      "Name this preset (e.g., 'Friday MTSS huddle')",
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
    if (!window.confirm(`Delete preset "${name}"?`)) return;
    const next = savedPresets.filter((p) => p.name !== name);
    setSavedPresets(next);
    saveSavedPresets(next);
  }

  function setHeader(col: typeof sortBy) {
    if (sortBy === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortBy(col);
      setSortDir(col === "name" || col === "grade" ? "asc" : "desc");
    }
  }

  function colHeader(col: typeof sortBy, label: string) {
    const active = sortBy === col;
    return (
      <th
        style={{
          textAlign: "left",
          padding: "0.5rem",
          fontSize: "0.85rem",
          cursor: "pointer",
          userSelect: "none",
          background: active ? "#eff6ff" : "transparent",
        }}
        onClick={() => setHeader(col)}
      >
        {label} {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
      </th>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Insights Watchlist</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Filterable view of every student you can see. Use chips to narrow
        the list, then click a row to open the full profile. Presets
        save your filter set in this browser only.
      </p>

      {/* Quick student lookup — bypasses the filter bar entirely.
          Useful for "I just want to check on Maria" without rebuilding
          a preset. Results scoped to the same visibility set the
          watchlist itself uses. */}
      <div
        ref={studentBoxRef}
        style={{
          position: "relative",
          marginBottom: "0.75rem",
          paddingBottom: "0.75rem",
          borderBottom: "1px solid #e5e7eb",
          maxWidth: 460,
        }}
      >
        <label
          htmlFor="watchlist-student-lookup"
          style={{
            display: "block",
            fontSize: "0.78rem",
            fontWeight: 600,
            color: "#374151",
            marginBottom: 4,
          }}
        >
          Look up an individual student
        </label>
        <input
          id="watchlist-student-lookup"
          type="text"
          value={studentQuery}
          placeholder="Search by name or student ID…"
          onFocus={() => setStudentDropdownOpen(true)}
          onChange={(e) => {
            setStudentQuery(e.target.value);
            setStudentDropdownOpen(true);
          }}
          style={{
            width: "100%",
            padding: "0.4rem 0.5rem",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            fontSize: "0.9rem",
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
                <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>
                  {s.studentId}
                  {s.grade !== null && s.grade !== undefined && s.grade !== ""
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

      {/* Filter bar — chip-style controls */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "0.75rem",
          paddingBottom: "0.75rem",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <strong style={{ marginRight: 8 }}>Window:</strong>
        {(["3", "7", "15", "30", "custom"] as WindowKey[]).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setFilters({ ...filters, window: w })}
            style={{
              padding: "0.25rem 0.6rem",
              border: "1px solid",
              borderColor: filters.window === w ? "#0d9488" : "#d1d5db",
              background: filters.window === w ? "#0d9488" : "white",
              color: filters.window === w ? "white" : "#374151",
              borderRadius: 999,
              fontSize: "0.8rem",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {w === "custom" ? "Custom" : `${w}d`}
          </button>
        ))}
        {filters.window === "custom" && (
          <>
            <input
              type="date"
              value={filters.customFrom}
              onChange={(e) => setFilters({ ...filters, customFrom: e.target.value })}
              style={{ padding: "0.2rem" }}
            />
            <span>→</span>
            <input
              type="date"
              value={filters.customTo}
              onChange={(e) => setFilters({ ...filters, customTo: e.target.value })}
              style={{ padding: "0.2rem" }}
            />
          </>
        )}
        {windowLabel && (
          <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>({windowLabel})</span>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: "0.5rem",
          marginBottom: "0.75rem",
        }}
      >
        <select
          value={filters.grade}
          onChange={(e) => setFilters({ ...filters, grade: e.target.value })}
          style={{ padding: "0.3rem" }}
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
          onChange={(e) => setFilters({ ...filters, gender: e.target.value })}
          style={{ padding: "0.3rem" }}
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
              setFilters({ ...filters, [key]: e.target.value as "" | "true" | "false" })
            }
            style={{ padding: "0.3rem" }}
          >
            <option value="">{label}: any</option>
            <option value="true">{label}: yes</option>
            <option value="false">{label}: no</option>
          </select>
        ))}
        <select
          value={filters.tier}
          onChange={(e) =>
            setFilters({ ...filters, tier: e.target.value as Filters["tier"] })
          }
          style={{ padding: "0.3rem" }}
        >
          <option value="">Tier: any</option>
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
          <option value="3">Tier 3</option>
        </select>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <strong style={{ marginRight: 4 }}>Presets:</strong>
        {BUILTIN_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => applyPreset(p.filters)}
            style={{
              padding: "0.2rem 0.55rem",
              background: "#f3f4f6",
              border: "1px solid #d1d5db",
              borderRadius: 999,
              fontSize: "0.75rem",
              cursor: "pointer",
            }}
          >
            {p.name}
          </button>
        ))}
        {savedPresets.map((p) => (
          <span
            key={p.name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              background: "#ecfeff",
              border: "1px solid #a5f3fc",
              borderRadius: 999,
              fontSize: "0.75rem",
            }}
          >
            <button
              type="button"
              onClick={() => applyPreset(p.filters)}
              style={{
                padding: "0.2rem 0.55rem",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              {p.name}
            </button>
            <button
              type="button"
              onClick={() => deletePreset(p.name)}
              title="Delete preset"
              style={{
                padding: "0.2rem 0.4rem",
                background: "transparent",
                border: "none",
                color: "#0e7490",
                cursor: "pointer",
                borderLeft: "1px solid #a5f3fc",
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
            padding: "0.2rem 0.55rem",
            background: "white",
            border: "1px dashed #9ca3af",
            borderRadius: 999,
            fontSize: "0.75rem",
            color: "#374151",
            cursor: "pointer",
          }}
        >
          + Save current
        </button>
        <button
          type="button"
          onClick={() => setFilters(EMPTY_FILTERS)}
          style={{
            padding: "0.2rem 0.55rem",
            background: "white",
            border: "1px solid #d1d5db",
            borderRadius: 999,
            fontSize: "0.75rem",
            color: "#374151",
            cursor: "pointer",
            marginLeft: "auto",
          }}
        >
          Reset filters
        </button>
      </div>

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
          No students match these filters. (If you're a teacher, your scope
          is your roster plus any students you've been linked to as a
          trusted adult.)
        </p>
      ) : (
        <>
          <div
            style={{
              marginBottom: "0.75rem",
              padding: "0.6rem 0.75rem",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.4rem",
              fontSize: "0.78rem",
            }}
            aria-label="Cohort summary"
          >
            <strong style={{ marginRight: "0.25rem" }}>
              Cohort: {cohortSummary.total} student
              {cohortSummary.total === 1 ? "" : "s"}
            </strong>
            {cohortSummary.tier2 > 0 &&
              chip(`${cohortSummary.tier2} Tier 2`, "watch")}
            {cohortSummary.tier3 > 0 &&
              chip(`${cohortSummary.tier3} Tier 3`, "high")}
            {cohortSummary.bqEla > 0 &&
              chip(`${cohortSummary.bqEla} BQ ELA`, "high")}
            {cohortSummary.bqMath > 0 &&
              chip(`${cohortSummary.bqMath} BQ Math`, "high")}
            {cohortSummary.highBehavior > 0 &&
              chip(
                `${cohortSummary.highBehavior} w/ 3+ behavior`,
                "watch",
              )}
            {cohortSummary.highTardy > 0 &&
              chip(`${cohortSummary.highTardy} w/ 5+ tardies`, "watch")}
            {cohortSummary.anyIss > 0 &&
              chip(`${cohortSummary.anyIss} w/ ISS`, "high")}
            {cohortSummary.highRisk > 0 &&
              chip(
                `${cohortSummary.highRisk} high-risk top flag`,
                "high",
              )}
            {cohortSummary.total > 0 &&
              cohortSummary.tier2 === 0 &&
              cohortSummary.tier3 === 0 &&
              cohortSummary.bqEla === 0 &&
              cohortSummary.bqMath === 0 &&
              cohortSummary.highBehavior === 0 &&
              cohortSummary.highTardy === 0 &&
              cohortSummary.anyIss === 0 &&
              cohortSummary.highRisk === 0 && (
                <span style={{ color: "#6b7280" }}>
                  No risk indicators in this cohort.
                </span>
              )}
          </div>
          <div style={{ marginBottom: "0.5rem", color: "#6b7280", fontSize: "0.85rem" }}>
            Showing {sortedRows.length} student{sortedRows.length === 1 ? "" : "s"}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
                  {colHeader("name", "Student")}
                  {colHeader("grade", "Gr")}
                  <th style={{ textAlign: "left", padding: "0.5rem", fontSize: "0.85rem" }}>
                    Demographics
                  </th>
                  {colHeader("tier", "Tier")}
                  {colHeader("behavior", "Behavior")}
                  {colHeader("tardy", "Tardies")}
                  {colHeader("iss", "ISS")}
                  {colHeader("risk", "Top Risk")}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr
                    key={r.studentId}
                    onClick={() => onOpenStudent(r.studentId)}
                    style={{
                      borderBottom: "1px solid #f3f4f6",
                      cursor: "pointer",
                    }}
                  >
                    <td style={{ padding: "0.5rem" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>
                          {r.lastName}, {r.firstName}
                        </span>
                        {onOpenSpider && (
                          <button
                            type="button"
                            onClick={(e) => {
                              // Row has its own onClick that also navigates
                              // to the profile — stop propagation so we
                              // don't double-fire (and so a future change
                              // to the row click target doesn't silently
                              // hijack the pill).
                              e.stopPropagation();
                              onOpenSpider(r.studentId);
                            }}
                            title={`Open whole-child radar for ${r.firstName} ${r.lastName}`}
                            aria-label={`Open whole-child radar for ${r.firstName} ${r.lastName}`}
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
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                        {r.studentId}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem" }}>{r.grade}</td>
                    <td style={{ padding: "0.5rem" }}>
                      {r.flags.ell && chip("ELL", "info")}
                      {r.flags.ese && chip("ESE", "info")}
                      {r.flags.is504 && chip("504", "info")}
                      {r.flags.ctEla && chip("CT ELA", "info")}
                      {r.flags.ctMath && chip("CT Math", "info")}
                      {r.bqEla && chip("BQ ELA", "high")}
                      {r.bqMath && chip("BQ Math", "high")}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {r.mtssTier === 1 ? (
                        <span style={{ color: "#6b7280" }}>1</span>
                      ) : (
                        chip(`Tier ${r.mtssTier}`, r.mtssTier === 3 ? "high" : "watch")
                      )}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {r.behaviorCount > 0
                        ? chip(
                            `${r.behaviorCount}`,
                            r.behaviorCount >= 3 ? "high" : "watch",
                          )
                        : <span style={{ color: "#9ca3af" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {r.tardyCount > 0
                        ? chip(`${r.tardyCount}`, r.tardyCount >= 5 ? "high" : "watch")
                        : <span style={{ color: "#9ca3af" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {r.issDayCount > 0
                        ? chip(`${r.issDayCount}`, "high")
                        : <span style={{ color: "#9ca3af" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {r.topRiskFlag
                        ? chip(r.topRiskFlag.label, r.topRiskFlag.severity)
                        : <span style={{ color: "#9ca3af" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
