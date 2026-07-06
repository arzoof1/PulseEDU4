import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { TeacherPicker } from "./TeacherPicker";
import type { TeacherOpt } from "./teacherDepartments";

// Export-only kinds (mirror of the importer kinds the server's
// /api/data-imports/export endpoint supports). Keeping this list
// local to the export feature so adding a new importer doesn't
// silently break export rendering.
export type ExportKind =
  | "rosters"
  | "behavior"
  | "fast_scores"
  | "fast_prior_year"
  | "assessments";
export type ExportScope = "school" | "district";

type ExportConfig = {
  cols: string[];
  required: string[];
  filters: ("grade" | "date" | "subject" | "noteType" | "assessmentName")[];
  supportsDistrict: boolean;
};

const EXPORT_CONFIG: Record<ExportKind, ExportConfig> = {
  rosters: {
    cols: [
      "local_sis_id",
      "first_name",
      "last_name",
      "grade",
      "parent_name",
      "parent_email",
      "parent_phone",
      "gender",
      "ell",
      "ese",
      "is_504",
    ],
    required: ["local_sis_id", "first_name", "last_name", "grade"],
    filters: ["grade"],
    supportsDistrict: false,
  },
  behavior: {
    cols: [
      "local_sis_id",
      "note_type",
      "note_text",
      "staff_name",
      "created_at",
    ],
    required: ["local_sis_id", "note_text"],
    filters: ["grade", "date", "noteType"],
    supportsDistrict: false,
  },
  fast_scores: {
    cols: [
      "local_sis_id",
      "subject",
      "pm1",
      "pm2",
      "pm3",
      "prior_year_score",
      "prior_year_bq",
    ],
    required: ["local_sis_id", "subject"],
    filters: ["grade", "subject"],
    supportsDistrict: false,
  },
  fast_prior_year: {
    cols: ["local_sis_id", "subject", "prior_year_score", "prior_year_bq"],
    required: ["local_sis_id", "subject", "prior_year_score"],
    filters: ["grade", "subject"],
    supportsDistrict: false,
  },
  assessments: {
    cols: [
      "local_sis_id",
      "assessment_name",
      "score",
      "score_level",
      "administered_at",
      "source",
      "school_code",
    ],
    required: ["local_sis_id", "assessment_name", "administered_at"],
    filters: ["grade", "date", "assessmentName"],
    supportsDistrict: true,
  },
};

const KIND_LABELS: Record<ExportKind, string> = {
  rosters: "Roster",
  behavior: "Behavior notes",
  fast_scores: "FAST scores",
  fast_prior_year: "FAST prior-year scores",
  assessments: "Assessments",
};

// Grade chips: K + 1..12. Rendered for every kind that supports grade
// filtering; un-applicable grades (e.g. 9-12 chips on a K-5 school) just
// yield zero rows on the server.
const GRADE_CHIPS: { value: number; label: string }[] = [
  { value: 0, label: "K" },
  ...Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: String(i + 1),
  })),
];

// ---------------------------------------------------------------------------
// DataExportPanel — full-page filter + column picker for "Export data".
// Lives under Settings → Data Management → Export. Fires
// GET /api/data-imports/export with query params; the server validates
// filters, applies LIKE escapes, projects columns (always re-injecting the
// importer's required columns), and streams a CSV. We trigger the download
// via a hidden anchor so the user stays on the page.
// ---------------------------------------------------------------------------
export default function DataExportPanel({
  canActAsDistrict,
}: {
  canActAsDistrict: boolean;
}) {
  const [kind, setKind] = useState<ExportKind>("rosters");
  const [scope, setScope] = useState<ExportScope>("school");
  const cfg = EXPORT_CONFIG[kind];
  // Effective scope: only assessments support district mode today; for
  // every other kind we silently clamp to school.
  const effectiveScope: ExportScope =
    cfg.supportsDistrict && canActAsDistrict ? scope : "school";

  // Filter state. We deliberately keep the union here (grades, from/to,
  // subject, noteType, assessmentName) instead of making it kind-specific
  // so switching kinds doesn't blow away the user's grade/date selections
  // — a common case is "give me grade 6, three different ways".
  const [grades, setGrades] = useState<Set<number>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState<"" | "ela" | "math">("");
  const [noteType, setNoteType] = useState("");
  const [assessmentName, setAssessmentName] = useState("");
  // Teacher + period filters apply to EVERY kind (all exports are
  // student-centric; the server intersects with section enrollment), so
  // they live outside the kind-specific cfg.filters gating.
  const [teacherId, setTeacherId] = useState<number | null>(null);
  const [period, setPeriod] = useState<number | "">("");
  const [teachers, setTeachers] = useState<TeacherOpt[]>([]);
  const [periods, setPeriods] = useState<number[]>([]);
  const [includedCols, setIncludedCols] = useState<Set<string>>(
    () => new Set(cfg.cols),
  );

  // Load the teachers + periods that actually have sections so the pickers
  // never offer a filter that yields zero rows.
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/data-imports/export/section-filters")
      .then((r) => (r.ok ? r.json() : { teachers: [], periods: [] }))
      .then((d: { teachers?: TeacherOpt[]; periods?: number[] }) => {
        if (cancelled) return;
        setTeachers(d.teachers ?? []);
        setPeriods(d.periods ?? []);
      })
      .catch(() => {
        /* pickers stay empty; teacher/period filtering is optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When kind changes, reset the column set to "all of the new kind's
  // columns" — column names don't transfer across kinds, so carrying
  // them over would silently strip every checkbox.
  const lastKindRef = useState<ExportKind>(kind);
  if (lastKindRef[0] !== kind) {
    lastKindRef[1](kind);
    setIncludedCols(new Set(cfg.cols));
  }

  const requiredSet = useMemo(() => new Set(cfg.required), [cfg.required]);

  const toggleGrade = (g: number) => {
    setGrades((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };
  const toggleCol = (c: string) => {
    if (requiredSet.has(c)) return;
    setIncludedCols((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const handleDownload = () => {
    const params = new URLSearchParams();
    params.set("kind", kind);
    params.set("scope", effectiveScope);
    if (cfg.filters.includes("grade") && grades.size > 0) {
      params.set("grades", Array.from(grades).sort((a, b) => a - b).join(","));
    }
    if (cfg.filters.includes("date")) {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    }
    if (cfg.filters.includes("subject") && subject) {
      params.set("subject", subject);
    }
    if (cfg.filters.includes("noteType") && noteType.trim()) {
      params.set("noteType", noteType.trim());
    }
    if (cfg.filters.includes("assessmentName") && assessmentName.trim()) {
      params.set("assessmentName", assessmentName.trim());
    }
    // Teacher / period apply to every kind — send whenever selected.
    if (teacherId !== null) {
      params.set("teacherStaffId", String(teacherId));
    }
    if (period !== "") {
      params.set("period", String(period));
    }
    // Only send the columns param if the user actually narrowed the set
    // — saves a query-string round-trip and keeps the URL short for the
    // common "download everything" case.
    if (includedCols.size < cfg.cols.length) {
      params.set("columns", Array.from(includedCols).join(","));
    }
    const url = `/api/data-imports/export?${params.toString()}`;
    // Anchor-with-download so the response streams to disk without
    // navigating away from the page.
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const sectionLabel: CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-subtle)",
    marginBottom: 6,
  };
  const chip = (selected: boolean): CSSProperties => ({
    padding: "0.3rem 0.65rem",
    border: `1px solid ${selected ? "#3b82f6" : "var(--border, #2a3447)"}`,
    background: selected ? "#3b82f622" : "transparent",
    color: "inherit",
    borderRadius: 999,
    fontSize: 12,
    cursor: "pointer",
  });
  const inputStyle: CSSProperties = {
    padding: "0.35rem 0.55rem",
    border: "1px solid var(--border, #2a3447)",
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    fontSize: 13,
  };

  const KIND_OPTIONS: ExportKind[] = [
    "rosters",
    "behavior",
    "fast_scores",
    "fast_prior_year",
    "assessments",
  ];

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Export data</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Download your school's current data as a CSV. Use filters to narrow
        the rows and the column picker to slim the file. Students are
        identified by your district Local SIS ID (the state FLEID is never
        exported).
      </p>

      <div style={{ marginTop: "1rem" }}>
        <div style={sectionLabel}>Data type</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {KIND_OPTIONS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              style={chip(kind === k)}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      {cfg.supportsDistrict && canActAsDistrict && (
        <div style={{ marginTop: "1rem" }}>
          <div style={sectionLabel}>Scope</div>
          <div style={{ display: "flex", gap: 6 }}>
            {([
              ["school", "This school"],
              ["district", "Whole district"],
            ] as const).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setScope(val)}
                style={chip(scope === val)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: "1rem" }}>
        <div style={sectionLabel}>Teacher &amp; period (optional)</div>
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <TeacherPicker
            teachers={teachers}
            value={teacherId}
            onChange={setTeacherId}
            allowEmpty
            emptyLabel="All teachers"
            showDeptFilter
            searchPlaceholder="Search teacher…"
            selectStyle={{ ...inputStyle, minWidth: 220 }}
          />
          <input
            list="export-period-list"
            value={period === "" ? "" : String(period)}
            onChange={(e) => {
              const v = e.target.value.trim();
              if (v === "") {
                setPeriod("");
                return;
              }
              const n = Number(v);
              setPeriod(Number.isInteger(n) && n >= 0 ? n : "");
            }}
            placeholder="All periods (type to search)"
            aria-label="Period"
            style={{ ...inputStyle, minWidth: 180 }}
          />
          <datalist id="export-period-list">
            {periods.map((p) => (
              <option key={p} value={String(p)}>
                {`Period ${p}`}
              </option>
            ))}
          </datalist>
          {(teacherId !== null || period !== "") && (
            <button
              type="button"
              onClick={() => {
                setTeacherId(null);
                setPeriod("");
              }}
              style={{
                ...chip(false),
                borderStyle: "dashed",
                color: "var(--text-subtle)",
              }}
            >
              Clear
            </button>
          )}
        </div>
        <div
          style={{ marginTop: 6, fontSize: 12, color: "var(--text-subtle)" }}
        >
          Restrict the export to students enrolled in a specific teacher's
          class and/or a specific period. Leave both empty for all students.
        </div>
      </div>

      {cfg.filters.includes("grade") && (
        <div style={{ marginTop: "1rem" }}>
          <div style={sectionLabel}>Grade (leave empty for all)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {GRADE_CHIPS.map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => toggleGrade(g.value)}
                style={chip(grades.has(g.value))}
              >
                {g.label}
              </button>
            ))}
            {grades.size > 0 && (
              <button
                type="button"
                onClick={() => setGrades(new Set())}
                style={{
                  ...chip(false),
                  borderStyle: "dashed",
                  color: "var(--text-subtle)",
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {cfg.filters.includes("date") && (
        <div style={{ marginTop: "1rem" }}>
          <div style={sectionLabel}>Date range</div>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <label style={{ fontSize: 12, color: "var(--text-subtle)" }}>
              From{" "}
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-subtle)" }}>
              To{" "}
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={inputStyle}
              />
            </label>
          </div>
        </div>
      )}

      {cfg.filters.includes("subject") && (
        <div style={{ marginTop: "1rem" }}>
          <div style={sectionLabel}>Subject</div>
          <div style={{ display: "flex", gap: 6 }}>
            {([
              ["", "All"],
              ["ela", "ELA"],
              ["math", "Math"],
            ] as const).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setSubject(val)}
                style={chip(subject === val)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
      )}

      {cfg.filters.includes("noteType") && (
        <div style={{ marginTop: "1rem" }}>
          <div style={sectionLabel}>Note type contains</div>
          <input
            value={noteType}
            onChange={(e) => setNoteType(e.target.value)}
            placeholder="e.g. referral"
            style={{ ...inputStyle, width: "100%", maxWidth: 320 }}
          />
        </div>
      )}

      {cfg.filters.includes("assessmentName") && (
        <div style={{ marginTop: "1rem" }}>
          <div style={sectionLabel}>Assessment name contains</div>
          <input
            value={assessmentName}
            onChange={(e) => setAssessmentName(e.target.value)}
            placeholder="e.g. iReady"
            style={{ ...inputStyle, width: "100%", maxWidth: 320 }}
          />
        </div>
      )}

      <div style={{ marginTop: "1rem" }}>
        <div style={sectionLabel}>Columns</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem 1.25rem" }}>
          {cfg.cols.map((c) => {
            const isReq = requiredSet.has(c);
            const checked = includedCols.has(c) || isReq;
            return (
              <label
                key={c}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: isReq ? "var(--text-subtle)" : "inherit",
                  cursor: isReq ? "not-allowed" : "pointer",
                }}
                title={isReq ? "Required by the importer" : undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isReq}
                  onChange={() => toggleCol(c)}
                />
                {c}
                {isReq && <span style={{ opacity: 0.6 }}> (required)</span>}
              </label>
            );
          })}
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: "var(--text-subtle)",
          }}
        >
          Required columns are always included so the file can round-trip
          back through the importer.
        </div>
      </div>

      <div
        style={{
          marginTop: "1.25rem",
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          onClick={handleDownload}
          style={{
            padding: "0.5rem 1rem",
            border: "1px solid #3b82f6",
            background: "#3b82f6",
            color: "white",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Download CSV
        </button>
      </div>
    </div>
  );
}
