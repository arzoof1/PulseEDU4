// FAST Phase 2 — Benchmarks tab on Teacher Roster.
//
// Renders a (students × benchmarks) heatmap of FAST per-item mastery
// percentages for the selected (subject, school year, window), plus a
// "Bottom 3 benchmarks" tile and a drill-down modal listing the
// students under the mastery threshold for a clicked benchmark.
//
// Empty-state handling is explicit: a school that hasn't imported any
// Florida per-student xlsx yet sees a friendly "no item-level data"
// banner pointing them to Data Importer, not an empty grid.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Cell {
  pct: number;
  earned: number;
  possible: number;
}

interface StudentRow {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string;
  cells: Record<string, Cell | null>;
}

interface Benchmark {
  code: string;
  category: string | null;
}

interface BottomEntry {
  code: string;
  category: string | null;
  avgPct: number;
  studentsBelowThreshold: number;
  totalStudents: number;
}

interface WindowOpt {
  schoolYear: string;
  window: string;
  label: string;
}

interface MatrixResponse {
  teacher: { id: number; displayName: string | null };
  subject: string;
  window: string;
  schoolYear: string;
  availableWindows: WindowOpt[];
  thresholdPct: number;
  benchmarks: Benchmark[];
  students: StudentRow[];
  bottom3: BottomEntry[];
}

interface DrillItem {
  itemSeq: number;
  pointsEarned: number | null;
  pointsPossible: number | null;
}

interface DrillStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string;
  pct: number | null;
  earned: number | null;
  possible: number | null;
  items: DrillItem[];
}

interface DrillResponse {
  benchmark: { code: string; category: string | null };
  thresholdPct: number;
  students: DrillStudent[];
}

const SUBJECT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "algebra1", label: "Algebra 1" },
  { value: "geometry", label: "Geometry" },
];

function cellColor(pct: number, threshold: number): {
  bg: string;
  fg: string;
} {
  if (pct >= threshold) return { bg: "#bbf7d0", fg: "#065f46" };
  if (pct >= Math.max(0, threshold - 10)) return { bg: "#fef08a", fg: "#854d0e" };
  if (pct >= Math.max(0, threshold - 30)) return { bg: "#fed7aa", fg: "#9a3412" };
  return { bg: "#fecaca", fg: "#991b1b" };
}

export default function TeacherBenchmarksTab({
  teacherId,
  isOwnRoster,
}: {
  teacherId: number | null;
  // Reserved for future role-aware UI; currently the server enforces
  // every gate, but kept on the prop for parity with the parent.
  isOwnRoster: boolean;
}) {
  void isOwnRoster;

  const [subject, setSubject] = useState<string>("ela");
  // Window selection is "{schoolYear}|{window}" so a single <select>
  // can drive both fields without juggling two pieces of state.
  const [windowKey, setWindowKey] = useState<string>("");
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [drillCode, setDrillCode] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillResponse | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

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
    params.set("subject", subject);
    if (windowKey.includes("|")) {
      const [sy, w] = windowKey.split("|");
      params.set("schoolYear", sy);
      params.set("window", w);
    }
    authFetch(`/api/teacher-roster/benchmarks?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as MatrixResponse;
      })
      .then((j) => {
        if (cancelled) return;
        setData(j);
        // Keep the picker in sync when the server picked the default
        // window for us (initial load + after subject change).
        const serverKey = `${j.schoolYear}|${j.window}`;
        if (serverKey !== windowKey) setWindowKey(serverKey);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, subject, windowKey]);

  // Drill modal data load.
  useEffect(() => {
    if (drillCode == null || teacherId == null || data == null) {
      setDrill(null);
      return;
    }
    let cancelled = false;
    setDrillLoading(true);
    const params = new URLSearchParams();
    params.set("teacherId", String(teacherId));
    params.set("subject", subject);
    params.set("schoolYear", data.schoolYear);
    params.set("window", data.window);
    params.set("benchmarkCode", drillCode);
    authFetch(`/api/teacher-roster/benchmarks/drill?${params.toString()}`)
      .then(async (r) => (r.ok ? ((await r.json()) as DrillResponse) : null))
      .then((j) => {
        if (cancelled) return;
        setDrill(j);
      })
      .finally(() => {
        if (!cancelled) setDrillLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drillCode, teacherId, subject, data]);

  // Group benchmarks by category so we can render colSpan'd category
  // header bands on the heatmap. Categories preserve the server's sort.
  const grouped = useMemo(() => {
    if (!data) return [] as Array<{ category: string; codes: Benchmark[] }>;
    const out: Array<{ category: string; codes: Benchmark[] }> = [];
    for (const b of data.benchmarks) {
      const cat = b.category ?? "(Uncategorized)";
      const last = out[out.length - 1];
      if (last && last.category === cat) {
        last.codes.push(b);
      } else {
        out.push({ category: cat, codes: [b] });
      }
    }
    return out;
  }, [data]);

  if (teacherId == null) {
    return (
      <div style={{ color: "#6b7280", padding: 12 }}>
        Pick a teacher to view their benchmark heatmap.
      </div>
    );
  }

  const pdfHref = data
    ? `/api/teacher-roster/benchmarks/pdf?teacherId=${teacherId}` +
      `&subject=${subject}` +
      `&schoolYear=${encodeURIComponent(data.schoolYear)}` +
      `&window=${data.window}`
    : null;

  const openPdf = () => {
    if (!pdfHref) return;
    // authFetch → blob → object URL so the auth header rides along.
    authFetch(pdfHref)
      .then(async (r) => {
        if (!r.ok) throw new Error(`PDF ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(() => {
        setError("Could not generate PDF.");
      });
  };

  return (
    <div>
      {/* Toolbar: subject + window picker + threshold readout + PDF */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
          padding: "8px 10px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Subject:
          <select
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              // Let the server pick the most recent window for the new
              // subject — clearing windowKey forces that path.
              setWindowKey("");
            }}
          >
            {SUBJECT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Window:
          <select
            value={windowKey}
            onChange={(e) => setWindowKey(e.target.value)}
            disabled={!data || data.availableWindows.length === 0}
          >
            {data && data.availableWindows.length === 0 && (
              <option value="">— no data —</option>
            )}
            {data?.availableWindows.map((w) => (
              <option
                key={`${w.schoolYear}|${w.window}`}
                value={`${w.schoolYear}|${w.window}`}
              >
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <span style={{ color: "#6b7280" }}>
            Mastery threshold: <strong>{data.thresholdPct}%</strong>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={openPdf}
          disabled={!data || data.benchmarks.length === 0}
          style={{ padding: "4px 10px" }}
          title="Open printable PDF of this heatmap"
        >
          Print PDF
        </button>
      </div>

      {/* Color legend */}
      {data && (
        <div
          style={{
            display: "flex",
            gap: 14,
            alignItems: "center",
            flexWrap: "wrap",
            fontSize: 12,
            color: "#374151",
            marginBottom: 10,
          }}
        >
          {[
            { label: `≥ ${data.thresholdPct}% (mastery)`, pct: data.thresholdPct },
            {
              label: `${Math.max(0, data.thresholdPct - 10)}–${data.thresholdPct - 1}%`,
              pct: data.thresholdPct - 5,
            },
            {
              label: `${Math.max(0, data.thresholdPct - 30)}–${Math.max(0, data.thresholdPct - 11)}%`,
              pct: data.thresholdPct - 20,
            },
            {
              label: `< ${Math.max(0, data.thresholdPct - 30)}%`,
              pct: 0,
            },
          ].map((swatch) => {
            const c = cellColor(swatch.pct, data.thresholdPct);
            return (
              <span
                key={swatch.label}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 16,
                    height: 16,
                    background: c.bg,
                    border: "1px solid #d4d4d4",
                    borderRadius: 3,
                  }}
                />
                {swatch.label}
              </span>
            );
          })}
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

      {loading && <div>Loading benchmarks…</div>}

      {/* Empty states */}
      {!loading && data && data.availableWindows.length === 0 && (
        <div
          style={{
            padding: 16,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#78350f",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          <strong>No item-level FAST data yet for this subject.</strong>
          <div style={{ marginTop: 4 }}>
            Import a Florida <em>per-student</em> xlsx for this teacher's
            roster from <strong>Data Importer → FAST</strong>. Once the
            commit succeeds, this heatmap populates automatically.
          </div>
        </div>
      )}

      {!loading &&
        data &&
        data.availableWindows.length > 0 &&
        data.students.length === 0 && (
          <div style={{ color: "#6b7280", marginBottom: 12 }}>
            No students on this teacher's roster.
          </div>
        )}

      {!loading &&
        data &&
        data.students.length > 0 &&
        data.benchmarks.length === 0 && (
          <div style={{ color: "#6b7280", marginBottom: 12 }}>
            No benchmark responses in this window for the current roster.
          </div>
        )}

      {/* Bottom-3 tile */}
      {!loading && data && data.bottom3.length > 0 && (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "#991b1b",
              marginBottom: 6,
            }}
          >
            Bottom 3 benchmarks — {data.schoolYear}{" "}
            {data.window.toUpperCase()}
          </div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {data.bottom3.map((b) => (
              <li key={b.code} style={{ marginBottom: 4 }}>
                <button
                  onClick={() => setDrillCode(b.code)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#0369a1",
                    textDecoration: "underline",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                  }}
                  title="Click to see which students are below the threshold"
                >
                  {b.code}
                </button>
                {b.category && (
                  <span style={{ color: "#6b7280" }}> · {b.category}</span>
                )}{" "}
                — class avg <strong>{b.avgPct}%</strong> ·{" "}
                <strong>{b.studentsBelowThreshold}</strong> of{" "}
                {b.totalStudents} below {data.thresholdPct}%
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Heatmap */}
      {!loading &&
        data &&
        data.students.length > 0 &&
        data.benchmarks.length > 0 && (
          <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}>
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: 11,
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th
                    rowSpan={2}
                    style={{
                      padding: "6px 8px",
                      textAlign: "left",
                      position: "sticky",
                      left: 0,
                      background: "#f3f4f6",
                      minWidth: 160,
                      borderRight: "1px solid #d4d4d4",
                      zIndex: 2,
                    }}
                  >
                    Student
                  </th>
                  {grouped.map((g) => (
                    <th
                      key={g.category}
                      colSpan={g.codes.length}
                      style={{
                        padding: "4px 6px",
                        fontSize: 11,
                        textAlign: "center",
                        borderLeft: "1px solid #d4d4d4",
                        background: "#e5e7eb",
                      }}
                      title={g.category}
                    >
                      {g.category}
                    </th>
                  ))}
                </tr>
                <tr style={{ background: "#f3f4f6" }}>
                  {data.benchmarks.map((b, i) => {
                    // Find if this is the first code in its category for
                    // the divider styling.
                    const isFirstInCat =
                      i === 0 ||
                      (data.benchmarks[i - 1].category ?? "(Uncategorized)") !==
                        (b.category ?? "(Uncategorized)");
                    return (
                      <th
                        key={b.code}
                        style={{
                          padding: "4px 2px",
                          fontSize: 9,
                          fontFamily: "monospace",
                          fontWeight: 600,
                          width: 44,
                          minWidth: 44,
                          textAlign: "center",
                          borderLeft: isFirstInCat
                            ? "1px solid #9ca3af"
                            : "1px solid #e5e7eb",
                          whiteSpace: "nowrap",
                          color: "#374151",
                        }}
                        title={b.code}
                      >
                        <button
                          onClick={() => setDrillCode(b.code)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            color: "inherit",
                            fontFamily: "inherit",
                            fontSize: "inherit",
                            fontWeight: "inherit",
                            textDecoration: "underline",
                            textDecorationStyle: "dotted",
                          }}
                          title="Click to see students below threshold"
                        >
                          {/* Show just the last 2 segments to fit the
                              column; full code in the title. */}
                          {b.code.split(".").slice(-2).join(".")}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.students.map((s) => (
                  <tr key={s.studentId} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td
                      style={{
                        padding: "4px 8px",
                        position: "sticky",
                        left: 0,
                        background: "white",
                        borderRight: "1px solid #d4d4d4",
                        whiteSpace: "nowrap",
                        zIndex: 1,
                      }}
                      title={`${s.firstName} ${s.lastName} (G${s.grade})`}
                    >
                      {s.lastName}, {s.firstName}
                    </td>
                    {data.benchmarks.map((b, i) => {
                      const cell = s.cells[b.code];
                      const isFirstInCat =
                        i === 0 ||
                        (data.benchmarks[i - 1].category ?? "(Uncategorized)") !==
                          (b.category ?? "(Uncategorized)");
                      if (cell == null) {
                        return (
                          <td
                            key={b.code}
                            style={{
                              padding: 0,
                              textAlign: "center",
                              background: "#f3f4f6",
                              color: "#9ca3af",
                              borderLeft: isFirstInCat
                                ? "1px solid #9ca3af"
                                : "1px solid #e5e7eb",
                            }}
                            title={`${b.code}: no data`}
                          >
                            —
                          </td>
                        );
                      }
                      const c = cellColor(cell.pct, data.thresholdPct);
                      return (
                        <td
                          key={b.code}
                          style={{
                            padding: "4px 2px",
                            textAlign: "center",
                            background: c.bg,
                            color: c.fg,
                            fontWeight: 600,
                            borderLeft: isFirstInCat
                              ? "1px solid #9ca3af"
                              : "1px solid #e5e7eb",
                            cursor: "help",
                          }}
                          title={`${s.lastName}, ${s.firstName} · ${b.code}: ${cell.earned}/${cell.possible} (${cell.pct}%)`}
                        >
                          {cell.pct}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {/* Drill modal */}
      {drillCode && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setDrillCode(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: 8,
              padding: 18,
              maxWidth: 560,
              width: "94%",
              maxHeight: "84vh",
              overflowY: "auto",
              boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {drillCode}
                {drill?.benchmark.category && (
                  <span
                    style={{
                      color: "#6b7280",
                      fontSize: 12,
                      fontWeight: 400,
                      marginLeft: 8,
                    }}
                  >
                    {drill.benchmark.category}
                  </span>
                )}
              </h3>
              <button onClick={() => setDrillCode(null)}>Close</button>
            </div>
            <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>
              Students below the {data?.thresholdPct ?? 80}% mastery threshold for
              {" "}{data?.schoolYear} {data?.window.toUpperCase()}.
            </div>
            {drillLoading && <div>Loading…</div>}
            {!drillLoading && drill && drill.students.length === 0 && (
              <div style={{ color: "#065f46", padding: 8 }}>
                Every student met the threshold — nothing to drill into.
              </div>
            )}
            {!drillLoading && drill && drill.students.length > 0 && (
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px" }}>Student</th>
                    <th style={{ padding: "6px 8px" }}>Grade</th>
                    <th style={{ padding: "6px 8px" }}>Items</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>Total</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.students.map((s) => (
                    <tr
                      key={s.studentId}
                      style={{ borderTop: "1px solid #f3f4f6", verticalAlign: "top" }}
                    >
                      <td style={{ padding: "6px 8px" }}>
                        {s.lastName}, {s.firstName}
                      </td>
                      <td style={{ padding: "6px 8px" }}>{s.grade}</td>
                      <td
                        style={{
                          padding: "6px 8px",
                          fontFamily: "monospace",
                          fontSize: 12,
                          color: "#374151",
                        }}
                      >
                        {s.items.length === 0 ? (
                          <span style={{ color: "#9ca3af" }}>no items</span>
                        ) : (
                          // Per-item performance: each chip shows
                          // "item#: earned/possible" so the teacher
                          // can see exactly which item(s) tripped
                          // the student up (multi-item benchmarks
                          // are common in Florida xlsx).
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {s.items.map((it) => {
                              const correct =
                                it.pointsPossible != null &&
                                it.pointsEarned != null &&
                                it.pointsEarned >= it.pointsPossible;
                              const missing = it.pointsPossible == null;
                              return (
                                <span
                                  key={it.itemSeq}
                                  title={`Item ${it.itemSeq + 1}: ${it.pointsEarned ?? "—"}/${it.pointsPossible ?? "—"}`}
                                  style={{
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    background: missing
                                      ? "#f3f4f6"
                                      : correct
                                        ? "#dcfce7"
                                        : "#fee2e2",
                                    color: missing
                                      ? "#6b7280"
                                      : correct
                                        ? "#166534"
                                        : "#991b1b",
                                    fontSize: 11,
                                  }}
                                >
                                  #{it.itemSeq + 1}:{" "}
                                  {it.pointsEarned ?? "—"}/
                                  {it.pointsPossible ?? "—"}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>
                        {s.earned != null && s.possible != null
                          ? `${s.earned}/${s.possible}`
                          : "—"}
                      </td>
                      <td
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          fontWeight: 600,
                          color:
                            s.pct == null
                              ? "#9ca3af"
                              : s.pct < (data?.thresholdPct ?? 80) - 30
                                ? "#991b1b"
                                : "#9a3412",
                        }}
                      >
                        {s.pct == null ? "no data" : `${s.pct}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
