// Shared filter header for every Insights page. Three rows of affordances,
// all controlled — owners pass the state in and a setter for each piece:
//
//   Row 1 (top strip)       :  [FILTERS]  [ELA] [Math]?  [All grades] [K]..[12]  [⬇ CSV]?
//   Row 2 (InsightsFilterBar):  Teacher · Period · ESE · 504 · Tier 2+ · Tier 3 · BQ ELA · BQ Math · Clear all
//
// Subject chips are rendered only when `subjects` + `onSubjectsChange` are
// provided (academic pages). CSV button is rendered only when
// `onDownloadCsv` is provided. Grade chips + InsightsFilterBar are always
// rendered.
//
// The chip palette mirrors the AcademicsTrajectory page (the canonical
// implementation): #2563eb fill + soft glow ring on selected. Keeping
// chip styling here in one place stops it from drifting per-dashboard.

import { BookOpen, Calculator, Filter } from "lucide-react";
import InsightsFilterBar, {
  type InsightsFilterValue,
} from "./InsightsFilterBar";

export type Subject = "ela" | "math";

// Canonical K..12 chip list. Empty selection = "All grades".
export const GRADE_CHIPS: { value: string; label: string }[] = [
  { value: "K", label: "K" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5" },
  { value: "6", label: "6" },
  { value: "7", label: "7" },
  { value: "8", label: "8" },
  { value: "9", label: "9" },
  { value: "10", label: "10" },
  { value: "11", label: "11" },
  { value: "12", label: "12" },
];

// Convenience: ["3","5","K"] -> "K, 3, 5" for KPI sublabels.
export function gradesToLabel(selected: string[]): string {
  if (selected.length === 0) return "All grades";
  const order = new Map(GRADE_CHIPS.map((g, i) => [g.value, i]));
  const sorted = [...selected].sort(
    (a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99),
  );
  return sorted.join(", ");
}

interface Props {
  // Subject (academic pages only). Omit both to hide the subject chips.
  subjects?: Subject[];
  onSubjectsChange?: (next: Subject[]) => void;

  // Grade chips (always rendered).
  grades: string[];
  onGradesChange: (next: string[]) => void;

  // Shared filter bar (always rendered).
  filters: InsightsFilterValue;
  onFiltersChange: (next: InsightsFilterValue) => void;

  // CSV button. Omit `onDownloadCsv` to hide the button.
  onDownloadCsv?: () => void | Promise<void>;
  csvDisabled?: boolean;
  csvLabel?: string;
  csvTooltip?: string;
}

export default function InsightsPicker({
  subjects,
  onSubjectsChange,
  grades,
  onGradesChange,
  filters,
  onFiltersChange,
  onDownloadCsv,
  csvDisabled,
  csvLabel = "CSV",
  csvTooltip = "Download per-student CSV (opens in Excel)",
}: Props) {
  // Subject chips — toggle but never let the last one go (matches the
  // AcademicsTrajectory rule: a zero-subject state has no meaning).
  const toggleSubject = (s: Subject) => {
    if (!subjects || !onSubjectsChange) return;
    if (subjects.includes(s)) {
      if (subjects.length === 1) return;
      onSubjectsChange(subjects.filter((x) => x !== s));
      return;
    }
    const next = [...subjects, s];
    onSubjectsChange(
      (["ela", "math"] as Subject[]).filter((x) => next.includes(x)),
    );
  };

  // Grade chips — multi-select toggle. "All grades" clears.
  const toggleGrade = (v: string) => {
    if (grades.includes(v)) {
      onGradesChange(grades.filter((g) => g !== v));
    } else {
      onGradesChange([...grades, v]);
    }
  };
  const clearGrades = () => onGradesChange([]);

  const showSubjects = !!subjects && !!onSubjectsChange;

  return (
    <>
      <div style={topStripStyle}>
        <div style={filtersLabelStyle}>
          <Filter style={{ width: 14, height: 14 }} />
          FILTERS
        </div>

        {showSubjects && (
          <>
            <SubjectChip
              active={subjects!.includes("ela")}
              onClick={() => toggleSubject("ela")}
              icon={BookOpen}
              label="ELA"
            />
            <SubjectChip
              active={subjects!.includes("math")}
              onClick={() => toggleSubject("math")}
              icon={Calculator}
              label="Math"
            />
          </>
        )}

        <GradeChip
          active={grades.length === 0}
          onClick={clearGrades}
          label="All grades"
        />
        {GRADE_CHIPS.map((g) => (
          <GradeChip
            key={g.value}
            active={grades.includes(g.value)}
            onClick={() => toggleGrade(g.value)}
            label={g.label}
          />
        ))}

        {onDownloadCsv && (
          <button
            type="button"
            onClick={onDownloadCsv}
            disabled={csvDisabled}
            title={csvTooltip}
            style={{
              marginLeft: 8,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 700,
              cursor: csvDisabled ? "not-allowed" : "pointer",
              border: "1px solid #047857",
              background: csvDisabled ? "#94a3b8" : "#059669",
              color: "white",
              opacity: csvDisabled ? 0.6 : 1,
            }}
          >
            ⬇ {csvLabel}
          </button>
        )}
      </div>

      <InsightsFilterBar value={filters} onChange={onFiltersChange} />
    </>
  );
}

// ---------------------------------------------------------------------
// Chip + container styles (verbatim from the canonical Trajectory page
// so every Insights screen reads identically).
// ---------------------------------------------------------------------

const topStripStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  marginTop: "0.25rem",
};

const filtersLabelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginRight: 6,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  color: "#64748b",
};

function SubjectChip({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 14px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        transition:
          "background-color 120ms, color 120ms, border-color 120ms",
        border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
        background: active ? "#2563eb" : "white",
        color: active ? "white" : "#334155",
        boxShadow: active ? "0 0 0 2px rgba(37,99,235,0.18)" : "none",
      }}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function GradeChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 34,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        transition:
          "background-color 120ms, color 120ms, border-color 120ms",
        border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
        background: active ? "#2563eb" : "white",
        color: active ? "white" : "#334155",
        boxShadow: active ? "0 0 0 2px rgba(37,99,235,0.18)" : "none",
      }}
    >
      {label}
    </button>
  );
}

// Escape a single CSV cell. Wraps in double-quotes whenever the value
// contains a comma, quote, or newline.
export function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Stream a string of CSV text to the browser as a download.
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Convert a record of named lists-of-objects into a single CSV. Lists
// are separated by a blank line and each section begins with a header
// row prefixed with a `list` column. Lists with different shapes are
// fine — each gets its own header.
export function topListsToCsv(
  lists: Record<string, Array<Record<string, unknown>> | undefined | null>,
): string {
  const out: string[] = [];
  for (const [name, items] of Object.entries(lists)) {
    if (!items || items.length === 0) continue;
    const keys = Object.keys(items[0]);
    out.push(["list", ...keys].map(csvCell).join(","));
    for (const it of items) {
      out.push([name, ...keys.map((k) => csvCell(it[k]))].join(","));
    }
    out.push("");
  }
  return out.join("\n");
}

// Pull "top list" sections out of an Insights response for CSV export.
// Only inspects an allowlist of section names (`topLists`, `topRisk`,
// `recentAbsences`) and any direct array-of-object children of the
// response root. Chart-data arrays (e.g. `trends.*`, `weather`) and
// nested aggregate structures are intentionally skipped — the CSV is
// meant for the human-readable top-N tables, not raw chart data.
const TOP_LIST_SECTION_KEYS = new Set([
  "topLists",
  "topRisk",
  "recentAbsences",
]);

export function extractTopLists(
  obj: unknown,
): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  const isObjectArray = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) &&
    v.length > 0 &&
    typeof v[0] === "object" &&
    v[0] !== null &&
    !Array.isArray(v[0]);

  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (isObjectArray(v)) {
      out[k] = v;
    } else if (
      TOP_LIST_SECTION_KEYS.has(k) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (isObjectArray(sv)) out[`${k}.${sk}`] = sv;
      }
    }
  }
  return out;
}

// Convenience filename builder: `<slug>_<grades>_<yyyy-mm-dd>.csv`.
export function csvFilename(slug: string, grades: string[]): string {
  const g = grades.length > 0 ? grades.join("-") : "all-grades";
  const d = new Date().toISOString().slice(0, 10);
  return `${slug}_${g}_${d}.csv`;
}

// Build a CSV download handler that:
//   1. Calls the backend export route through authFetch (Bearer-token
//      auth survives the Replit iframe cookie sandbox).
//   2. Reads the filename from Content-Disposition, falling back to a
//      `<slug>_<grades>_<yyyy-mm-dd>.csv` default.
//   3. Streams the blob to a temporary <a download> click.
//
// Pass an absolute or `/api/...` path in `url` (the leading slash is
// preserved). `fallbackSlug` is used in the default filename only.
export function buildCsvDownloader(
  url: string,
  fallbackSlug: string,
  grades: string[],
): () => Promise<void> {
  return async () => {
    const { authFetch } = await import("../lib/authToken");
    const res = await authFetch(url);
    if (!res.ok) {
      // Surface the server error in the console — the calling page
      // typically owns its own toast / error display.
      const text = await res.text().catch(() => "");
      console.error("[InsightsPicker] CSV download failed", res.status, text);
      return;
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const dispo = res.headers.get("content-disposition") || "";
    const match = /filename="?([^"]+)"?/i.exec(dispo);
    const filename =
      match?.[1] ||
      `${fallbackSlug}_${
        grades.length > 0 ? grades.join("-") : "all-grades"
      }_${new Date().toISOString().slice(0, 10)}.csv`;
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  };
}
