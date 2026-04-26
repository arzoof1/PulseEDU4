import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { authFetch } from "../lib/authToken";

// ---------------------------------------------------------------------------
// Data Imports — Phase 3 first importer (assessments). Wraps the
// /api/data-imports/* endpoints with a 3-step flow:
//
//   1. Upload  → drag-drop CSV, server returns preview + suggested mapping
//   2. Map     → admin reviews/overrides the column mapping, sees row counts
//   3. Commit  → server inserts rows + history entry
//
// A "History" tab lists past imports with rollback. We deliberately keep
// every step self-contained so the next importer (rosters, attendance) can
// reuse the same component by parameterizing `kind` + the target-field
// dictionary.
// ---------------------------------------------------------------------------

type Kind = "assessments";
type Scope = "school" | "district";

type PreviewResponse = {
  headers: string[];
  autoMapping: Record<string, string>;
  suggestedMapping: Record<string, string>;
  unmappedCsvColumns: string[];
  totalRows: number;
  validRows: number;
  errorRows: number;
  sampleRows: Array<{
    studentId: string;
    assessmentName: string;
    score: number | null;
    scoreLevel: string | null;
    administeredAt: string;
    source: string | null;
    // District scope only — present when the row was routed by school_code.
    schoolId?: number;
    schoolCode?: string;
  }>;
  errors: Array<{ row: number; message: string }>;
  readyToCommit: boolean;
  // District-scope preview only.
  perSchool?: Array<{ schoolId: number; schoolName: string; rows: number }>;
  districtSchoolCount?: number;
};

type ImportTemplate = {
  id: number;
  schoolId: number | null;
  districtId: number | null;
  kind: string;
  name: string;
  mapping: Record<string, string>;
  createdBy: number;
  createdAt: string;
  scope: "school" | "district";
};

type ImportJob = {
  id: number;
  schoolId: number | null;
  districtId: number | null;
  kind: string;
  filename: string;
  uploadedBy: number;
  uploadedAt: string;
  status: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  errorLog: Array<{ row: number; message: string }>;
  mapping: Record<string, string>;
  committedAt: string | null;
  rolledBackAt: string | null;
};

// Target fields the importer recognizes (mirror of HEADER_SYNONYMS in the
// route file). Marked required if the server rejects the mapping without
// them. The `school_code` target is only required in district scope —
// see `assessmentTargetsFor()` below.
type TargetDef = { value: string; label: string; required: boolean };

const ASSESSMENT_TARGETS_BASE: TargetDef[] = [
  { value: "student_id", label: "Student ID (SIS number)", required: true },
  { value: "assessment_name", label: "Assessment name", required: true },
  { value: "administered_at", label: "Administered date", required: true },
  { value: "score", label: "Score (numeric)", required: false },
  { value: "score_level", label: "Score level / band", required: false },
  { value: "source", label: "Source / vendor", required: false },
];

const SCHOOL_CODE_TARGET: TargetDef = {
  value: "school_code",
  label: "School code (state code or school ID)",
  required: true,
};

function assessmentTargetsFor(scope: Scope): TargetDef[] {
  return scope === "district"
    ? [...ASSESSMENT_TARGETS_BASE, SCHOOL_CODE_TARGET]
    : ASSESSMENT_TARGETS_BASE;
}

// Headers list "ignore" as a sentinel — when a CSV column isn't in the
// mapping at all, it's effectively ignored. We surface "ignore" as a
// menu option so the admin can explicitly drop a noisy column.
const IGNORE_VALUE = "__ignore__";

const dropZoneStyle: CSSProperties = {
  border: "2px dashed var(--border, #2a3447)",
  borderRadius: 12,
  padding: "2.5rem 1rem",
  textAlign: "center",
  cursor: "pointer",
  transition: "border-color 120ms, background 120ms",
};

const dropZoneActiveStyle: CSSProperties = {
  ...dropZoneStyle,
  borderColor: "var(--accent, #3b82f6)",
  background: "rgba(59, 130, 246, 0.08)",
};

const tabBtnStyle = (active: boolean): CSSProperties => ({
  padding: "0.55rem 1rem",
  border: "1px solid var(--border, #2a3447)",
  borderBottom: active
    ? "1px solid var(--card-bg, #0f172a)"
    : "1px solid var(--border, #2a3447)",
  borderRadius: "8px 8px 0 0",
  background: active ? "var(--card-bg, #0f172a)" : "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
  fontWeight: active ? 600 : 400,
});

const statusPillStyle = (status: string): CSSProperties => {
  const colors: Record<string, [string, string]> = {
    committed: ["#10b981", "#064e3b"],
    pending: ["#f59e0b", "#78350f"],
    failed: ["#ef4444", "#7f1d1d"],
    rolled_back: ["#94a3b8", "#334155"],
  };
  const [bg, fg] = colors[status] ?? ["#94a3b8", "#334155"];
  return {
    display: "inline-block",
    padding: "0.15rem 0.55rem",
    borderRadius: 999,
    background: bg,
    color: fg,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };
};

type DataImportsProps = {
  // Whether the signed-in user can act as a District Admin (DA or SU).
  // When false, the scope toggle is hidden and every request goes to the
  // school-scope endpoints.
  canActAsDistrict?: boolean;
};

export default function DataImports({
  canActAsDistrict = false,
}: DataImportsProps) {
  const [tab, setTab] = useState<"upload" | "history">("upload");
  const [kind] = useState<Kind>("assessments");
  const [scope, setScope] = useState<Scope>("school");

  // Upload state
  const [filename, setFilename] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [dragActive, setDragActive] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [commitResult, setCommitResult] = useState<{
    jobId: number;
    totalRows: number;
    successRows: number;
    errorRows: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonically increasing token; only the most recent runPreview()
  // call is allowed to write to state. Prevents a stale response from
  // a prior scope/mapping from clobbering the current preview after a
  // fast scope toggle or rapid mapping edits.
  const previewTokenRef = useRef(0);

  // History state
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [rollbackId, setRollbackId] = useState<number | null>(null);

  // Templates state — saved column mappings the user can re-apply.
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Endpoints + target dictionary depend on scope. Memoized so the
  // identity is stable across renders inside the same scope.
  const endpoints = useMemo(() => {
    if (scope === "district") {
      return {
        preview: "/api/data-imports/assessments/preview-district",
        commit: "/api/data-imports/assessments/commit-district",
      };
    }
    return {
      preview: "/api/data-imports/assessments/preview",
      commit: "/api/data-imports/assessments/commit",
    };
  }, [scope]);
  const targets = useMemo(() => assessmentTargetsFor(scope), [scope]);

  const loadJobs = async () => {
    setJobsLoading(true);
    try {
      const params = new URLSearchParams({ kind });
      if (scope === "district") params.set("scope", "district");
      const r = await authFetch(`/api/data-imports/jobs?${params.toString()}`);
      if (r.ok) setJobs(await r.json());
    } finally {
      setJobsLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "history") void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope]);

  // Load templates whenever the user lands on the Upload tab in a given
  // scope. Cheap query (one school's worth of rows at most), so always
  // re-fetching keeps the dropdown current after a save/delete elsewhere.
  const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const params = new URLSearchParams({ kind });
      if (scope === "district") params.set("scope", "district");
      const r = await authFetch(
        `/api/data-imports/templates?${params.toString()}`,
      );
      if (r.ok) setTemplates(await r.json());
    } finally {
      setTemplatesLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "upload") void loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope]);

  // Apply a template's mapping to the current preview. We only keep the
  // pairs whose CSV column actually exists in this file (the user might
  // be uploading a file from a different vendor than the template was
  // built for) — every kept pair is also re-validated by the server when
  // we re-run preview, so there's no risk of saving a stale mapping.
  const applyTemplate = (tplId: number) => {
    if (!preview || !csvText) return;
    const tpl = templates.find((t) => t.id === tplId);
    if (!tpl) return;
    const headerSet = new Set(preview.headers);
    const next: Record<string, string> = {};
    for (const [csvCol, target] of Object.entries(tpl.mapping)) {
      if (headerSet.has(csvCol)) next[csvCol] = target;
    }
    setMapping(next);
    void runPreview(csvText, next);
  };

  const handleSaveTemplate = async () => {
    if (!preview || Object.keys(mapping).length === 0) return;
    const name = window.prompt(
      "Save this mapping as a template. Use the vendor name (e.g. 'FAST', 'iReady'):",
    );
    if (!name || !name.trim()) return;
    setSavingTemplate(true);
    try {
      const body = {
        kind,
        name: name.trim(),
        mapping,
        scope,
      };
      const r = await authFetch("/api/data-imports/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error ?? `Save failed (HTTP ${r.status})`);
        return;
      }
      await loadTemplates();
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (tplId: number, tplName: string) => {
    if (
      !window.confirm(
        `Delete the "${tplName}" template? Anyone using it will need to re-map their next upload.`,
      )
    )
      return;
    const r = await authFetch(`/api/data-imports/templates/${tplId}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? `Delete failed (HTTP ${r.status})`);
      return;
    }
    await loadTemplates();
  };

  const resetUpload = () => {
    // Bumping the token also cancels any in-flight preview from before
    // the reset (its response will be ignored on arrival).
    previewTokenRef.current++;
    setFilename("");
    setCsvText("");
    setPreview(null);
    setMapping({});
    setError("");
    setCommitResult(null);
    setPreviewing(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = async (file: File) => {
    setError("");
    setCommitResult(null);
    if (!/\.csv$/i.test(file.name)) {
      setError("Please choose a .csv file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("CSV exceeds the 10 MB limit. Split the file and try again.");
      return;
    }
    const text = await file.text();
    setFilename(file.name);
    setCsvText(text);
    await runPreview(text, {});
  };

  const runPreview = async (
    text: string,
    overrideMapping: Record<string, string>,
  ) => {
    // Snapshot the token + scope at call time. After the network round
    // trip we only commit state if (a) no newer preview has been kicked
    // off and (b) the scope hasn't been toggled in flight — otherwise a
    // school-scope response could repopulate a now-district session.
    const myToken = ++previewTokenRef.current;
    const callScope = scope;
    setPreviewing(true);
    setError("");
    try {
      const r = await authFetch(endpoints.preview, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, mapping: overrideMapping }),
      });
      if (previewTokenRef.current !== myToken || callScope !== scope) return;
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? `Preview failed (HTTP ${r.status})`);
        setPreview(null);
        return;
      }
      const data: PreviewResponse = await r.json();
      setPreview(data);
      setMapping(data.suggestedMapping);
    } catch (e) {
      if (previewTokenRef.current !== myToken || callScope !== scope) return;
      setError(`Preview failed: ${(e as Error).message}`);
    } finally {
      if (previewTokenRef.current === myToken) setPreviewing(false);
    }
  };

  const handleMappingChange = (csvCol: string, target: string) => {
    const next = { ...mapping };
    if (target === IGNORE_VALUE) {
      delete next[csvCol];
    } else {
      // Enforce uniqueness — if another csv column was already mapped to
      // this target, drop that mapping. Two CSV columns mapping to
      // student_id never makes sense.
      for (const k of Object.keys(next)) {
        if (next[k] === target && k !== csvCol) delete next[k];
      }
      next[csvCol] = target;
    }
    setMapping(next);
    void runPreview(csvText, next);
  };

  const handleCommit = async () => {
    if (!preview || !csvText) return;
    setCommitting(true);
    setError("");
    try {
      const r = await authFetch(endpoints.commit, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText, filename, mapping }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? `Commit failed (HTTP ${r.status})`);
        return;
      }
      setCommitResult(j);
    } catch (e) {
      setError(`Commit failed: ${(e as Error).message}`);
    } finally {
      setCommitting(false);
    }
  };

  const handleRollback = async (id: number) => {
    if (
      !window.confirm(
        "Roll back this import? Every row it added will be deleted.",
      )
    )
      return;
    setRollbackId(id);
    try {
      const r = await authFetch(`/api/data-imports/jobs/${id}/rollback`, {
        method: "POST",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error ?? `Rollback failed (HTTP ${r.status})`);
        return;
      }
      await loadJobs();
    } finally {
      setRollbackId(null);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const requiredTargets = useMemo(
    () => targets.filter((t) => t.required).map((t) => t.value),
    [targets],
  );
  const missingRequired = useMemo(() => {
    if (!preview) return [];
    const have = new Set(Object.values(mapping));
    return requiredTargets.filter((t) => !have.has(t));
  }, [preview, mapping, requiredTargets]);

  // Switching scopes mid-flow would leave a stale preview / mapping
  // pointing at the wrong endpoint, so wipe upload state on toggle. The
  // History tab re-fetches via its own useEffect when scope changes.
  const handleScopeChange = (next: Scope) => {
    if (next === scope) return;
    setScope(next);
    resetUpload();
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Data Imports</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Upload assessment results from FAST, iReady, MAP, or any CSV. The
        importer auto-detects column names — review the mapping, commit,
        and roll back from History if anything looks wrong.
      </p>

      {canActAsDistrict && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginTop: "0.75rem",
            padding: "0.6rem 0.75rem",
            background: "rgba(59, 130, 246, 0.06)",
            border: "1px solid var(--border, #2a3447)",
            borderRadius: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>Scope:</span>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="data-imports-scope"
              checked={scope === "school"}
              onChange={() => handleScopeChange("school")}
            />
            My school only
          </label>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="data-imports-scope"
              checked={scope === "district"}
              onChange={() => handleScopeChange("district")}
            />
            District-wide (rows routed by school code)
          </label>
          {scope === "district" && (
            <span
              style={{
                fontSize: 12,
                color: "var(--text-subtle)",
                marginLeft: "auto",
              }}
            >
              CSV must include a school_code column matching each school's
              state code or ID.
            </span>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border, #2a3447)",
          marginTop: "1rem",
        }}
      >
        <button
          type="button"
          style={tabBtnStyle(tab === "upload")}
          onClick={() => setTab("upload")}
        >
          Upload
        </button>
        <button
          type="button"
          style={tabBtnStyle(tab === "history")}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "upload" && (
        <div style={{ marginTop: "1rem" }}>
          {commitResult ? (
            <div
              style={{
                padding: "1rem",
                background: "rgba(16, 185, 129, 0.1)",
                border: "1px solid #10b981",
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                Import #{commitResult.jobId} committed.
              </div>
              <div style={{ fontSize: 14, color: "var(--text-subtle)" }}>
                {commitResult.successRows} of {commitResult.totalRows} rows
                inserted.
                {commitResult.errorRows > 0 && (
                  <>
                    {" "}
                    {commitResult.errorRows} skipped — see History for the
                    error log.
                  </>
                )}
              </div>
              <div style={{ marginTop: "0.75rem", display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={resetUpload}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    background: "var(--accent, #3b82f6)",
                    color: "white",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  Upload another
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab("history");
                    resetUpload();
                  }}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  View history
                </button>
              </div>
            </div>
          ) : !preview ? (
            <div>
              <div
                style={dragActive ? dropZoneActiveStyle : dropZoneStyle}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div style={{ fontSize: 32, marginBottom: "0.5rem" }}>📥</div>
                <div style={{ fontWeight: 600 }}>
                  Drop a CSV file here, or click to choose
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-subtle)",
                    marginTop: "0.5rem",
                  }}
                >
                  Up to 10 MB. First row should be column headers.
                </div>
                {previewing && (
                  <div style={{ marginTop: "0.75rem", fontSize: 14 }}>
                    Parsing…
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
              {error && (
                <div
                  style={{
                    marginTop: "0.75rem",
                    padding: "0.75rem",
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid #ef4444",
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                >
                  {error}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  marginBottom: "1rem",
                }}
              >
                <span style={{ fontWeight: 600 }}>{filename}</span>
                <span style={{ color: "var(--text-subtle)", fontSize: 14 }}>
                  · {preview.totalRows} rows
                </span>
                <button
                  type="button"
                  onClick={resetUpload}
                  style={{
                    marginLeft: "auto",
                    padding: "0.35rem 0.75rem",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 13,
                  }}
                >
                  Cancel
                </button>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: "1rem",
                  marginBottom: "1rem",
                  flexWrap: "wrap",
                }}
              >
                <Stat label="Total" value={preview.totalRows} />
                <Stat label="Will import" value={preview.validRows} accent />
                <Stat label="Will skip" value={preview.errorRows} warn />
                {scope === "district" && preview.perSchool && (
                  <Stat
                    label="Schools matched"
                    value={preview.perSchool.length}
                  />
                )}
              </div>

              {scope === "district" &&
                preview.perSchool &&
                preview.perSchool.length > 0 && (
                  <details style={{ marginBottom: "1rem" }}>
                    <summary
                      style={{ cursor: "pointer", fontWeight: 600 }}
                    >
                      Per-school breakdown — {preview.perSchool.length} school
                      {preview.perSchool.length === 1 ? "" : "s"} matched
                      {typeof preview.districtSchoolCount === "number" && (
                        <span
                          style={{
                            color: "var(--text-subtle)",
                            fontWeight: 400,
                            marginLeft: 6,
                          }}
                        >
                          (of {preview.districtSchoolCount} in district)
                        </span>
                      )}
                    </summary>
                    <div style={{ marginTop: "0.5rem", overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: 13,
                        }}
                      >
                        <thead>
                          <tr>
                            <th
                              style={{
                                textAlign: "left",
                                padding: "0.35rem",
                                borderBottom:
                                  "1px solid var(--border, #2a3447)",
                              }}
                            >
                              School
                            </th>
                            <th
                              style={{
                                textAlign: "right",
                                padding: "0.35rem",
                                borderBottom:
                                  "1px solid var(--border, #2a3447)",
                              }}
                            >
                              Rows
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.perSchool.map((s) => (
                            <tr key={s.schoolId}>
                              <td style={{ padding: "0.35rem" }}>
                                {s.schoolName}
                              </td>
                              <td
                                style={{
                                  padding: "0.35rem",
                                  textAlign: "right",
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              >
                                {s.rows.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}

              <h3 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>
                Column mapping
              </h3>
              <p
                style={{
                  marginTop: 0,
                  fontSize: 13,
                  color: "var(--text-subtle)",
                }}
              >
                We guessed how each CSV column maps to our fields. Override
                any row, or set a column to "Ignore" to drop it.
              </p>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.75rem",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  Templates:
                </span>
                <select
                  value=""
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v > 0) applyTemplate(v);
                  }}
                  disabled={templatesLoading || templates.length === 0}
                  style={{
                    padding: "0.3rem 0.5rem",
                    background: "var(--card-bg, #0f172a)",
                    color: "inherit",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    font: "inherit",
                    fontSize: 13,
                    minWidth: 200,
                  }}
                >
                  <option value="">
                    {templatesLoading
                      ? "Loading…"
                      : templates.length === 0
                        ? "No saved templates"
                        : "Apply a saved template…"}
                  </option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} {t.scope === "district" ? "🏛 District" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleSaveTemplate}
                  disabled={
                    savingTemplate || Object.keys(mapping).length === 0
                  }
                  style={{
                    padding: "0.3rem 0.75rem",
                    border: "1px solid var(--border, #2a3447)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "inherit",
                    cursor:
                      savingTemplate || Object.keys(mapping).length === 0
                        ? "not-allowed"
                        : "pointer",
                    font: "inherit",
                    fontSize: 13,
                    opacity:
                      savingTemplate || Object.keys(mapping).length === 0
                        ? 0.5
                        : 1,
                  }}
                  title={
                    scope === "district"
                      ? "Saved as a district-wide template (visible to every school in your district)"
                      : "Saved as a template for your school"
                  }
                >
                  {savingTemplate ? "Saving…" : "Save current as template"}
                </button>
                {templates.length > 0 && (
                  <details style={{ marginLeft: "auto" }}>
                    <summary
                      style={{
                        cursor: "pointer",
                        fontSize: 12,
                        color: "var(--text-subtle)",
                      }}
                    >
                      Manage ({templates.length})
                    </summary>
                    <ul
                      style={{
                        marginTop: "0.4rem",
                        paddingLeft: "1.25rem",
                        fontSize: 13,
                      }}
                    >
                      {templates.map((t) => (
                        <li key={t.id} style={{ marginBottom: 4 }}>
                          {t.name}{" "}
                          <span
                            style={{
                              color: "var(--text-subtle)",
                              fontSize: 11,
                            }}
                          >
                            ({t.scope})
                          </span>{" "}
                          <button
                            type="button"
                            onClick={() => handleDeleteTemplate(t.id, t.name)}
                            style={{
                              padding: "0.1rem 0.4rem",
                              border: "1px solid #ef4444",
                              background: "transparent",
                              color: "#ef4444",
                              borderRadius: 4,
                              fontSize: 11,
                              cursor: "pointer",
                              marginLeft: 4,
                            }}
                          >
                            Delete
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0.5rem",
                  marginBottom: "1rem",
                }}
              >
                {preview.headers.map((h) => (
                  <div
                    key={h}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      padding: "0.5rem",
                      border: "1px solid var(--border, #2a3447)",
                      borderRadius: 6,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "monospace",
                        fontSize: 13,
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {h}
                    </span>
                    <span style={{ color: "var(--text-subtle)" }}>→</span>
                    <select
                      value={mapping[h] ?? IGNORE_VALUE}
                      onChange={(e) => handleMappingChange(h, e.target.value)}
                      style={{
                        flex: 1,
                        padding: "0.25rem",
                        background: "var(--card-bg, #0f172a)",
                        color: "inherit",
                        border: "1px solid var(--border, #2a3447)",
                        borderRadius: 4,
                        font: "inherit",
                        fontSize: 13,
                      }}
                    >
                      <option value={IGNORE_VALUE}>Ignore</option>
                      {targets.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                          {t.required ? " *" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {missingRequired.length > 0 && (
                <div
                  style={{
                    padding: "0.75rem",
                    background: "rgba(245, 158, 11, 0.1)",
                    border: "1px solid #f59e0b",
                    borderRadius: 6,
                    fontSize: 14,
                    marginBottom: "1rem",
                  }}
                >
                  Missing required fields: {missingRequired.join(", ")}.
                  Map at least one CSV column to each.
                </div>
              )}

              {preview.sampleRows.length > 0 && (
                <details style={{ marginBottom: "1rem" }}>
                  <summary
                    style={{ cursor: "pointer", fontWeight: 600 }}
                  >
                    Preview first {preview.sampleRows.length} rows
                  </summary>
                  <div
                    style={{
                      marginTop: "0.5rem",
                      overflowX: "auto",
                    }}
                  >
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: 13,
                      }}
                    >
                      <thead>
                        <tr>
                          {[
                            "Student",
                            "Assessment",
                            "Score",
                            "Level",
                            "Date",
                            "Source",
                          ].map((h) => (
                            <th
                              key={h}
                              style={{
                                textAlign: "left",
                                padding: "0.35rem",
                                borderBottom:
                                  "1px solid var(--border, #2a3447)",
                              }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sampleRows.map((r, i) => (
                          <tr key={i}>
                            <td style={{ padding: "0.35rem" }}>
                              {r.studentId}
                            </td>
                            <td style={{ padding: "0.35rem" }}>
                              {r.assessmentName}
                            </td>
                            <td style={{ padding: "0.35rem" }}>
                              {r.score ?? "—"}
                            </td>
                            <td style={{ padding: "0.35rem" }}>
                              {r.scoreLevel ?? "—"}
                            </td>
                            <td style={{ padding: "0.35rem" }}>
                              {new Date(r.administeredAt).toLocaleDateString()}
                            </td>
                            <td style={{ padding: "0.35rem" }}>
                              {r.source ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {preview.errors.length > 0 && (
                <details style={{ marginBottom: "1rem" }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: 600,
                      color: "#f59e0b",
                    }}
                  >
                    {preview.errorRows} skipped row
                    {preview.errorRows === 1 ? "" : "s"} — show errors
                  </summary>
                  <ul
                    style={{
                      marginTop: "0.5rem",
                      paddingLeft: "1.25rem",
                      fontSize: 13,
                    }}
                  >
                    {preview.errors.map((e, i) => (
                      <li key={i}>
                        Row {e.row}: {e.message}
                      </li>
                    ))}
                    {preview.errorRows > preview.errors.length && (
                      <li
                        style={{
                          color: "var(--text-subtle)",
                          listStyle: "none",
                        }}
                      >
                        … and {preview.errorRows - preview.errors.length} more.
                      </li>
                    )}
                  </ul>
                </details>
              )}

              {error && (
                <div
                  style={{
                    marginBottom: "1rem",
                    padding: "0.75rem",
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid #ef4444",
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="button"
                onClick={handleCommit}
                disabled={
                  committing ||
                  !preview.readyToCommit ||
                  preview.validRows === 0
                }
                style={{
                  padding: "0.65rem 1.25rem",
                  border: "1px solid var(--border, #2a3447)",
                  borderRadius: 6,
                  background:
                    committing || !preview.readyToCommit
                      ? "var(--border, #2a3447)"
                      : "var(--accent, #3b82f6)",
                  color: "white",
                  font: "inherit",
                  fontWeight: 600,
                  cursor:
                    committing || !preview.readyToCommit
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    committing || !preview.readyToCommit ? 0.6 : 1,
                }}
              >
                {committing
                  ? "Importing…"
                  : `Import ${preview.validRows} row${preview.validRows === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div style={{ marginTop: "1rem" }}>
          {jobsLoading ? (
            <div style={{ color: "var(--text-subtle)" }}>Loading…</div>
          ) : jobs.length === 0 ? (
            <div
              style={{
                padding: "2rem",
                textAlign: "center",
                color: "var(--text-subtle)",
                border: "1px dashed var(--border, #2a3447)",
                borderRadius: 8,
              }}
            >
              No imports yet. Switch to the Upload tab to get started.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                }}
              >
                <thead>
                  <tr>
                    {[
                      "Date",
                      "File",
                      "Kind",
                      "Status",
                      "Imported",
                      "Skipped",
                      "Actions",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "0.5rem",
                          borderBottom: "1px solid var(--border, #2a3447)",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td style={{ padding: "0.5rem" }}>
                        {new Date(j.uploadedAt).toLocaleString()}
                      </td>
                      <td
                        style={{
                          padding: "0.5rem",
                          fontFamily: "monospace",
                          fontSize: 13,
                        }}
                      >
                        {j.filename}
                        {j.districtId != null && j.schoolId == null && (
                          <span
                            style={{
                              display: "inline-block",
                              marginLeft: 6,
                              padding: "0.05rem 0.4rem",
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                              borderRadius: 999,
                              background: "rgba(59, 130, 246, 0.15)",
                              color: "#3b82f6",
                              border: "1px solid #3b82f6",
                              fontFamily: "inherit",
                            }}
                          >
                            District
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem" }}>{j.kind}</td>
                      <td style={{ padding: "0.5rem" }}>
                        <span style={statusPillStyle(j.status)}>
                          {j.status.replace("_", " ")}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem" }}>{j.successRows}</td>
                      <td style={{ padding: "0.5rem" }}>
                        {j.errorRows > 0 ? (
                          <details>
                            <summary
                              style={{
                                cursor: "pointer",
                                color: "#f59e0b",
                              }}
                            >
                              {j.errorRows}
                            </summary>
                            <ul
                              style={{
                                margin: "0.25rem 0 0 1rem",
                                padding: 0,
                                fontSize: 12,
                              }}
                            >
                              {j.errorLog.slice(0, 10).map((e, i) => (
                                <li key={i}>
                                  Row {e.row}: {e.message}
                                </li>
                              ))}
                              {j.errorLog.length > 10 && (
                                <li style={{ listStyle: "none" }}>…</li>
                              )}
                            </ul>
                          </details>
                        ) : (
                          0
                        )}
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        {j.status === "committed" && (
                          <button
                            type="button"
                            onClick={() => handleRollback(j.id)}
                            disabled={rollbackId === j.id}
                            style={{
                              padding: "0.3rem 0.6rem",
                              border: "1px solid #ef4444",
                              borderRadius: 4,
                              background: "transparent",
                              color: "#ef4444",
                              cursor:
                                rollbackId === j.id
                                  ? "not-allowed"
                                  : "pointer",
                              font: "inherit",
                              fontSize: 13,
                              opacity: rollbackId === j.id ? 0.5 : 1,
                            }}
                          >
                            {rollbackId === j.id ? "…" : "Roll back"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: number;
  accent?: boolean;
  warn?: boolean;
}) {
  const color = warn ? "#f59e0b" : accent ? "#10b981" : "var(--text)";
  return (
    <div
      style={{
        padding: "0.5rem 0.85rem",
        border: "1px solid var(--border, #2a3447)",
        borderRadius: 6,
        minWidth: 90,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--text-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
