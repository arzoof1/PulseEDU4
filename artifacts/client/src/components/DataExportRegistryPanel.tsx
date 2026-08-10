import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  usePrivilegedReauth,
  fetchWithReauth,
} from "../lib/usePrivilegedReauth";

// =============================================================================
// Data Export (registry-backed) — admin panel
// =============================================================================
// Distinct from Settings → Data Management → Export (which mirrors the importer
// kinds via /api/data-imports/export). This panel is driven by the server-side
// dataset registry (/api/exports/*): the server owns WHAT can be exported
// (datasets, columns, permissions, school + visibility scoping, FLEID boundary,
// CSV injection neutralization). The UI just lets an admin / Core Team member
// pick a dataset, choose columns + filters, preview the first rows, and
// download the full set as CSV or XLSX. Downloads use an authed blob (the
// preview iframe blocks the session cookie, so we never open-in-tab).
// =============================================================================

type ColumnDef = { id: string; label: string };

type Dataset = {
  key: string;
  label: string;
  description: string;
  category: string;
  supportsGrade: boolean;
  supportsTeacher: boolean;
  supportsStudent: boolean;
  supportsDateRange: boolean;
  columns: ColumnDef[];
};

type Teacher = { id: number; displayName: string };

type PreviewState = {
  columns: ColumnDef[];
  rows: Record<string, string>[];
  truncated: boolean;
  previewLimit: number;
};

type Filters = {
  grade: string;
  teacherStaffId: string;
  studentId: string;
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: Filters = {
  grade: "",
  teacherStaffId: "",
  studentId: "",
  dateFrom: "",
  dateTo: "",
};

function filenameFromDisposition(res: Response, fallback: string): string {
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = /filename="?([^"]+)"?/i.exec(cd);
  return m?.[1] ?? fallback;
}

export function DataExportRegistryPanel() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(
    new Set(),
  );
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "csv" | "xlsx">("");
  const { ensureReauth, reauthModal } = usePrivilegedReauth();

  const dataset = useMemo(
    () => datasets?.find((d) => d.key === selectedKey) ?? null,
    [datasets, selectedKey],
  );

  // Load the dataset registry + teacher options once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [dRes, tRes] = await Promise.all([
          authFetch("/api/exports/datasets"),
          authFetch("/api/exports/teachers"),
        ]);
        if (!dRes.ok) throw new Error("Could not load datasets");
        const dJson = (await dRes.json()) as { datasets: Dataset[] };
        const tJson = tRes.ok
          ? ((await tRes.json()) as { teachers: Teacher[] })
          : { teachers: [] };
        if (!alive) return;
        setDatasets(dJson.datasets);
        setTeachers(tJson.teachers ?? []);
        if (dJson.datasets.length) {
          setSelectedKey((prev) => prev || dJson.datasets[0].key);
        }
      } catch (err) {
        if (alive)
          setLoadError(
            err instanceof Error ? err.message : "Could not load datasets",
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // When the dataset changes, default to all columns + clear filters/preview.
  useEffect(() => {
    if (!dataset) return;
    setSelectedColumns(new Set(dataset.columns.map((c) => c.id)));
    setFilters(EMPTY_FILTERS);
    setPreview(null);
  }, [dataset]);

  function toggleColumn(id: string) {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Build the request body shared by preview + download. Only sends filters the
  // dataset actually supports.
  function buildBody(format?: "csv" | "xlsx") {
    if (!dataset) return null;
    const cols = dataset.columns
      .filter((c) => selectedColumns.has(c.id))
      .map((c) => c.id);
    const f: Record<string, unknown> = {};
    if (dataset.supportsGrade && filters.grade.trim() !== "")
      f.grade = Number(filters.grade);
    if (dataset.supportsTeacher && filters.teacherStaffId !== "")
      f.teacherStaffId = Number(filters.teacherStaffId);
    if (dataset.supportsStudent && filters.studentId.trim() !== "")
      f.studentId = filters.studentId.trim();
    if (dataset.supportsDateRange) {
      if (filters.dateFrom) f.dateFrom = filters.dateFrom;
      if (filters.dateTo) f.dateTo = filters.dateTo;
    }
    return {
      dataset: dataset.key,
      columns: cols,
      filters: f,
      ...(format ? { format } : {}),
    };
  }

  async function runPreview() {
    const body = buildBody();
    if (!body) return;
    setBusy("preview");
    setLoadError(null);
    try {
      const res = await authFetch("/api/exports/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Preview failed");
      setPreview((await res.json()) as PreviewState);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy("");
    }
  }

  async function runDownload(format: "csv" | "xlsx") {
    const body = buildBody(format);
    if (!body || !dataset) return;
    setBusy(format);
    setLoadError(null);
    try {
      const res = await fetchWithReauth(ensureReauth, () =>
        authFetch("/api/exports/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      if (!res) return; // step-up cancelled
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const fallback = `${dataset.key}.${format}`;
      const name = filenameFromDisposition(res, fallback);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusy("");
    }
  }

  const noColumns = selectedColumns.size === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {reauthModal}
      <div className="card">
        <h2>Data Export</h2>
        <p style={{ marginTop: 0, color: "var(--text-subtle, #666)" }}>
          Pick a dataset, choose the columns and filters you want, preview the
          first rows, then download the full set as CSV or Excel. Every download
          is logged.
        </p>
      </div>

      {loadError && (
        <div
          className="card"
          style={{ borderColor: "#e11d48", color: "#e11d48" }}
        >
          {loadError}
        </div>
      )}

      {datasets === null && !loadError && (
        <div className="card">Loading datasets…</div>
      )}

      {datasets && datasets.length === 0 && (
        <div className="card">
          You don't have permission to export any datasets.
        </div>
      )}

      {dataset && (
        <>
          <div className="card">
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Dataset
            </label>
            <select
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              style={{ minWidth: 280 }}
            >
              {datasets!.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.category} — {d.label}
                </option>
              ))}
            </select>
            <p style={{ color: "var(--text-subtle, #666)", marginBottom: 0 }}>
              {dataset.description}
            </p>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Columns</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: "0.4rem",
              }}
            >
              {dataset.columns.map((c) => (
                <label
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    fontWeight: 400,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedColumns.has(c.id)}
                    onChange={() => toggleColumn(c.id)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </div>

          {(dataset.supportsGrade ||
            dataset.supportsTeacher ||
            dataset.supportsDateRange) && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Filters</h3>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "1rem",
                  alignItems: "flex-end",
                }}
              >
                {dataset.supportsGrade && (
                  <div>
                    <label style={{ display: "block", marginBottom: 4 }}>
                      Grade
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={12}
                      value={filters.grade}
                      placeholder="All"
                      onChange={(e) =>
                        setFilters((f) => ({ ...f, grade: e.target.value }))
                      }
                      style={{ width: 90 }}
                    />
                  </div>
                )}
                {dataset.supportsTeacher && (
                  <div>
                    <label style={{ display: "block", marginBottom: 4 }}>
                      Teacher
                    </label>
                    <select
                      value={filters.teacherStaffId}
                      onChange={(e) =>
                        setFilters((f) => ({
                          ...f,
                          teacherStaffId: e.target.value,
                        }))
                      }
                      style={{ minWidth: 200 }}
                    >
                      <option value="">All teachers</option>
                      {teachers.map((t) => (
                        <option key={t.id} value={String(t.id)}>
                          {t.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {dataset.supportsDateRange && (
                  <>
                    <div>
                      <label style={{ display: "block", marginBottom: 4 }}>
                        From
                      </label>
                      <input
                        type="date"
                        value={filters.dateFrom}
                        onChange={(e) =>
                          setFilters((f) => ({
                            ...f,
                            dateFrom: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", marginBottom: 4 }}>
                        To
                      </label>
                      <input
                        type="date"
                        value={filters.dateTo}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, dateTo: e.target.value }))
                        }
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <div
            className="card"
            style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}
          >
            <button onClick={runPreview} disabled={busy !== "" || noColumns}>
              {busy === "preview" ? "Loading…" : "Preview"}
            </button>
            <button
              onClick={() => runDownload("csv")}
              disabled={busy !== "" || noColumns}
            >
              {busy === "csv" ? "Preparing…" : "Download CSV"}
            </button>
            <button
              onClick={() => runDownload("xlsx")}
              disabled={busy !== "" || noColumns}
            >
              {busy === "xlsx" ? "Preparing…" : "Download Excel"}
            </button>
            {noColumns && (
              <span style={{ color: "#e11d48", alignSelf: "center" }}>
                Select at least one column.
              </span>
            )}
          </div>

          {preview && (
            <div className="card" style={{ overflowX: "auto" }}>
              <h3 style={{ marginTop: 0 }}>
                Preview{" "}
                <span
                  style={{ fontWeight: 400, color: "var(--text-subtle, #666)" }}
                >
                  ({preview.rows.length} row
                  {preview.rows.length === 1 ? "" : "s"}
                  {preview.truncated
                    ? ` — first ${preview.previewLimit}, download for all`
                    : ""}
                  )
                </span>
              </h3>
              {preview.rows.length === 0 ? (
                <p style={{ color: "var(--text-subtle, #666)" }}>
                  No rows match these filters.
                </p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      {preview.columns.map((c) => (
                        <th
                          key={c.id}
                          style={{ textAlign: "left", whiteSpace: "nowrap" }}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i}>
                        {preview.columns.map((c) => (
                          <td key={c.id} style={{ whiteSpace: "nowrap" }}>
                            {r[c.id] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
