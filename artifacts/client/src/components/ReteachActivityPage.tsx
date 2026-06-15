// Reteach Activity — school-wide rollup of benchmark_reteach_log.
// Read-only audience: admin / Core Team / counselor. Teachers see
// their own roster's reteach via the progress-report footer.
//
// Server contract: artifacts/api-server/src/routes/reteachActivity.ts.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { authFetch } from "../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "./HowToUseHelp";

interface SummaryResponse {
  days: number;
  oneOnOne: number;
  smallGroup: number;
  uniqueStudents: number;
  uniqueBenchmarks: number;
  topLoggers: Array<{ staffId: number; name: string; count: number }>;
  topBenchmarks: Array<{ benchmarkCode: string; count: number }>;
}

interface RowEntry {
  id: number;
  createdAt: string;
  studentId: string;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  grade: number | null;
  benchmarkCode: string;
  teacherStaffId: number;
  teacherName: string;
  format: string;
  groupSessionId: string | null;
  strategy: string | null;
  minutes: number | null;
  note: string | null;
  schoolYear: string;
  pmWindowAtLog: string | null;
}

interface ListResponse {
  rows: RowEntry[];
  truncated: boolean;
  limit: number;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "2-digit",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function todayLocalISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysAgoLocalISO(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // CSV formula-injection hardening: cells starting with =, +, -, @,
  // tab, or CR are interpreted as formulas by Excel/Sheets. Prefix
  // with a single quote so the value renders literally.
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

interface Props {
  onBack: () => void;
}

export default function ReteachActivityPage({ onBack }: Props): ReactElement {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dateFrom, setDateFrom] = useState<string>(daysAgoLocalISO(30));
  const [dateTo, setDateTo] = useState<string>(todayLocalISO());
  const [gradeFilter, setGradeFilter] = useState<string>("");
  const [teacherFilter, setTeacherFilter] = useState<string>("");
  const [benchmarkFilter, setBenchmarkFilter] = useState<string>("");
  const [formatFilter, setFormatFilter] = useState<string>("");

  const loadSummary = useCallback(async () => {
    try {
      const res = await authFetch("/api/reteach-activity/summary?days=30");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as SummaryResponse;
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load summary");
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (gradeFilter) params.set("grade", gradeFilter);
      if (teacherFilter) params.set("teacherId", teacherFilter);
      if (benchmarkFilter) params.set("benchmarkCode", benchmarkFilter);
      if (formatFilter) params.set("format", formatFilter);
      const res = await authFetch(`/api/reteach-activity?${params.toString()}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as ListResponse;
      setList(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, gradeFilter, teacherFilter, benchmarkFilter, formatFilter]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Build distinct teacher + benchmark + grade dropdowns from the
  // current row set so admins can narrow without typing IDs.
  const teacherOptions = useMemo(() => {
    if (!list) return [];
    const map = new Map<number, string>();
    for (const r of list.rows) map.set(r.teacherStaffId, r.teacherName);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [list]);
  const benchmarkOptions = useMemo(() => {
    if (!list) return [];
    return Array.from(new Set(list.rows.map((r) => r.benchmarkCode))).sort();
  }, [list]);
  const gradeOptions = useMemo(() => {
    if (!list) return [];
    return Array.from(new Set(list.rows.map((r) => r.grade).filter((g): g is number => g != null))).sort(
      (a, b) => a - b,
    );
  }, [list]);

  const downloadCsv = () => {
    if (!list) return;
    const header = [
      "date",
      "local_sis_id",
      "first_name",
      "last_name",
      "grade",
      "benchmark_code",
      "format",
      "minutes",
      "teacher",
      "school_year",
      "pm_window_at_log",
      "strategy",
      "note",
    ];
    const lines = [header.join(",")];
    for (const r of list.rows) {
      lines.push(
        [
          fmtDate(r.createdAt),
          r.localSisId ?? "",
          r.firstName ?? "",
          r.lastName ?? "",
          r.grade ?? "",
          r.benchmarkCode,
          r.format,
          r.minutes ?? "",
          r.teacherName,
          r.schoolYear,
          r.pmWindowAtLog ?? "",
          r.strategy ?? "",
          r.note ?? "",
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reteach-activity-${dateFrom}-to-${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <button
            type="button"
            className="btn-secondary"
            onClick={onBack}
            style={{ marginRight: "0.75rem" }}
          >
            ← Back to Insights
          </button>
          <h2 style={{ display: "inline", margin: 0 }}>
            🔁 Reteach Activity
          </h2>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={downloadCsv}
          disabled={!list || list.rows.length === 0}
        >
          Download CSV
        </button>
      </div>

      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        School-wide view of reteach logged from the Teacher Roster
        Benchmarks heatmap. Read-only — teachers see their own
        roster's totals on the progress report.
      </p>
      <HowToUseHelp title="How to use Reteach Activity">
        <HowToSection title="What this page is">
          A school-wide rollup of reteach logged from the Teacher Roster
          Benchmarks heatmap.
        </HowToSection>
        <HowToSection title="Day-to-day">
          <ul style={howtoListStyle}>
            <li>Scan which benchmarks are being retaught and by whom.</li>
            <li>Export to CSV for grade-level or PLC conversations.</li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam", "counselor"]} title="Read-only">
          Reteach is logged from the Teacher Roster — this page only reports it.
          Teachers see their own totals on the progress report.
        </RoleSection>
      </HowToUseHelp>

      {/* 30-day summary tiles */}
      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <SummaryTile label="🔁 1:1 (last 30d)" value={summary.oneOnOne} />
          <SummaryTile
            label="👥 Small group (last 30d)"
            value={summary.smallGroup}
          />
          <SummaryTile label="Students reached" value={summary.uniqueStudents} />
          <SummaryTile
            label="Benchmarks targeted"
            value={summary.uniqueBenchmarks}
          />
        </div>
      )}

      {summary &&
        (summary.topLoggers.length > 0 || summary.topBenchmarks.length > 0) && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "0.75rem",
              marginBottom: "1rem",
            }}
          >
            {summary.topLoggers.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "0.75rem",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                  Top loggers (last 30d)
                </div>
                {summary.topLoggers.map((l) => (
                  <div
                    key={l.staffId}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "0.15rem 0",
                    }}
                  >
                    <span>{l.name}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {l.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {summary.topBenchmarks.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "0.75rem",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                  Top benchmarks (last 30d)
                </div>
                {summary.topBenchmarks.map((b) => (
                  <div
                    key={b.benchmarkCode}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "0.15rem 0",
                    }}
                  >
                    <span style={{ fontFamily: "monospace" }}>
                      {b.benchmarkCode}
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {b.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: "0.75rem",
          padding: "0.5rem",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-subtle, #f7f7f8)",
        }}
      >
        <FilterField label="From">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </FilterField>
        <FilterField label="To">
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </FilterField>
        <FilterField label="Teacher">
          <select
            value={teacherFilter}
            onChange={(e) => setTeacherFilter(e.target.value)}
          >
            <option value="">All</option>
            {teacherOptions.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Grade">
          <select
            value={gradeFilter}
            onChange={(e) => setGradeFilter(e.target.value)}
          >
            <option value="">All</option>
            {gradeOptions.map((g) => (
              <option key={g} value={String(g)}>
                {g === 0 ? "K" : g}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Benchmark">
          <select
            value={benchmarkFilter}
            onChange={(e) => setBenchmarkFilter(e.target.value)}
          >
            <option value="">All</option>
            {benchmarkOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Format">
          <select
            value={formatFilter}
            onChange={(e) => setFormatFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="one_on_one">🔁 1:1</option>
            <option value="small_group">👥 Small group</option>
          </select>
        </FilterField>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setDateFrom(daysAgoLocalISO(30));
            setDateTo(todayLocalISO());
            setGradeFilter("");
            setTeacherFilter("");
            setBenchmarkFilter("");
            setFormatFilter("");
          }}
        >
          Reset
        </button>
      </div>

      {error && (
        <div style={{ color: "var(--danger, #b00020)", marginBottom: "0.5rem" }}>
          {error}
        </div>
      )}

      {loading && !list ? (
        <div>Loading…</div>
      ) : list && list.rows.length === 0 ? (
        <div style={{ color: "var(--text-subtle)", padding: "1rem 0" }}>
          No reteach logged in this window.
        </div>
      ) : list ? (
        <div style={{ overflowX: "auto" }}>
          {list.truncated && (
            <div
              style={{
                color: "var(--text-subtle)",
                fontSize: "0.85em",
                marginBottom: "0.25rem",
              }}
            >
              Showing first {list.limit} rows — narrow the date range or
              filters for the full set.
            </div>
          )}
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9em",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "0.4rem" }}>Date</th>
                <th style={{ padding: "0.4rem" }}>Student</th>
                <th style={{ padding: "0.4rem" }}>Grade</th>
                <th style={{ padding: "0.4rem" }}>Benchmark</th>
                <th style={{ padding: "0.4rem" }}>Format</th>
                <th style={{ padding: "0.4rem" }}>Min</th>
                <th style={{ padding: "0.4rem" }}>Teacher</th>
                <th style={{ padding: "0.4rem" }}>PM</th>
                <th style={{ padding: "0.4rem" }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border-soft, #eee)" }}>
                  <td style={{ padding: "0.4rem", whiteSpace: "nowrap" }}>
                    {fmtDate(r.createdAt)}
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    {r.firstName ?? ""} {r.lastName ?? ""}
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    {r.grade == null ? "" : r.grade === 0 ? "K" : r.grade}
                  </td>
                  <td style={{ padding: "0.4rem", fontFamily: "monospace" }}>
                    {r.benchmarkCode}
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    {r.format === "one_on_one"
                      ? "🔁 1:1"
                      : r.format === "small_group"
                        ? "👥 Small"
                        : r.format}
                  </td>
                  <td style={{ padding: "0.4rem" }}>{r.minutes ?? ""}</td>
                  <td style={{ padding: "0.4rem" }}>{r.teacherName}</td>
                  <td style={{ padding: "0.4rem" }}>{r.pmWindowAtLog ?? ""}</td>
                  <td
                    style={{
                      padding: "0.4rem",
                      maxWidth: 280,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={r.note ?? ""}
                  >
                    {r.note ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function SummaryTile({
  label,
  value,
}: {
  label: string;
  value: number;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.75rem",
        background: "var(--bg-subtle, #f7f7f8)",
      }}
    >
      <div style={{ color: "var(--text-subtle)", fontSize: "0.85em" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "1.6em",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}): ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85em" }}>
      <span style={{ color: "var(--text-subtle)", marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  );
}
