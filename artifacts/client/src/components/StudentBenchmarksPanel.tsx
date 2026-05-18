// FAST Phase 3 — Per-student benchmark history panel.
//
// Drops into the Academics pillar on the Student Profile page. Shows
// every benchmark this student has been tested on for the selected
// subject + school year, grouped by category, with a category-level
// rollup card at the top. Window switcher (PM1/PM2/PM3) toggles
// in-place without a round-trip.
//
// Color scale (≥T green, ≥T-10 yellow, ≥T-30 orange, else red) is
// identical to the Phase 2 teacher heatmap on purpose — heatmap and
// profile should feel like one product.
//
// MTSS pill: read path is wired but never lights up until Phase 5
// starts persisting benchmark-tagged plans. Server returns
// `mtssTagged: false` for every benchmark today.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { authFetch } from "../lib/authToken";

interface BenchmarkRow {
  code: string;
  category: string | null;
  attempts: number;
  earned: number;
  possible: number;
  masteryPct: number;
  status: "below" | "near" | "at_above";
  mtssTagged: boolean;
}

interface CategoryRollup {
  category: string;
  earned: number;
  possible: number;
  masteryPct: number;
  benchmarkCount: number;
  status: "below" | "near" | "at_above";
}

interface WindowBlock {
  window: string;
  label: string;
  benchmarks: BenchmarkRow[];
  categoryRollups: CategoryRollup[];
  totalEarned: number;
  totalPossible: number;
  overallMasteryPct: number | null;
}

interface HistoryPoint {
  schoolYear: string;
  window: string;
  pct: number;
}

interface PayloadShape {
  student: {
    studentId: string;
    firstName: string | null;
    lastName: string | null;
    grade: number;
  };
  subject: string;
  schoolYear: string;
  availableSchoolYears: string[];
  thresholdPct: number;
  windows: WindowBlock[];
  // Phase 4 — chronological mastery% per benchmark across ALL years
  // this student has data for. Optional so the server can omit it
  // without breaking the type during older clients.
  historyByCode?: Record<string, HistoryPoint[]>;
}

// Tiny inline SVG sparkline. Domain is the count of points; range is
// 0–100% (FAST mastery). Renders a polyline + endpoint dot colored by
// the final point's status. Returns null when fewer than 2 points
// exist — a single point isn't a trend.
function Sparkline({
  points,
  thresholdPct,
  width = 64,
  height = 18,
}: {
  points: HistoryPoint[];
  thresholdPct: number;
  width?: number;
  height?: number;
}): ReactElement | null {
  if (points.length < 2) return null;
  const padX = 2;
  const padY = 2;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const xs = points.map((_, i) =>
    points.length === 1
      ? padX + innerW / 2
      : padX + (i / (points.length - 1)) * innerW,
  );
  const ys = points.map(
    (p) => padY + innerH * (1 - Math.max(0, Math.min(100, p.pct)) / 100),
  );
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ");
  const lastIdx = points.length - 1;
  const lastPct = points[lastIdx].pct;
  const endColor = cellColor(lastPct, thresholdPct).fg;
  // Faint threshold rule so the eye anchors the line against the cut.
  const thresholdY = padY + innerH * (1 - thresholdPct / 100);
  const label = points
    .map((p) => `${p.schoolYear} ${p.window.toUpperCase()}: ${p.pct}%`)
    .join(" → ");
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <line
        x1={padX}
        x2={padX + innerW}
        y1={thresholdY}
        y2={thresholdY}
        stroke="#d1d5db"
        strokeDasharray="2,2"
        strokeWidth={0.5}
      />
      <path d={path} stroke="#475569" strokeWidth={1} fill="none" />
      <circle cx={xs[lastIdx]} cy={ys[lastIdx]} r={1.8} fill={endColor} />
    </svg>
  );
}

type SubjectKey = "ela" | "math" | "algebra1" | "geometry";
type SortKey = "category" | "mastery_asc" | "code";

const SUBJECT_LABEL: Record<SubjectKey, string> = {
  ela: "ELA",
  math: "Math",
  algebra1: "Algebra 1",
  geometry: "Geometry",
};

// Same palette as TeacherBenchmarksTab — DO NOT change one without
// changing the other. Phase 2 heatmap and Phase 3 profile read the
// same thresholdPct from school_settings, so the visual semantics
// must match exactly.
function cellColor(pct: number, threshold: number): { bg: string; fg: string } {
  if (pct >= threshold) return { bg: "#bbf7d0", fg: "#065f46" };
  if (pct >= Math.max(0, threshold - 10))
    return { bg: "#fef08a", fg: "#854d0e" };
  if (pct >= Math.max(0, threshold - 30))
    return { bg: "#fed7aa", fg: "#9a3412" };
  return { bg: "#fecaca", fg: "#991b1b" };
}

function statusLabel(s: "below" | "near" | "at_above"): string {
  if (s === "at_above") return "At/Above";
  if (s === "near") return "Near";
  return "Below";
}

export default function StudentBenchmarksPanel({
  studentId,
}: {
  studentId: string;
}) {
  const [subject, setSubjectRaw] = useState<SubjectKey>("ela");
  const [schoolYear, setSchoolYear] = useState<string | null>(null);

  // Subject changes reset the school-year selection so the next load
  // re-resolves to "most recent year with data for the NEW subject".
  // Without this reset, a stale year picked for ELA would suppress
  // the default when the user switches to Math (and that year might
  // have no Math data at all).
  const setSubject = (next: SubjectKey) => {
    setSubjectRaw(next);
    setSchoolYear(null);
  };
  const [activeWindow, setActiveWindow] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("category");
  const [data, setData] = useState<PayloadShape | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("studentId", studentId);
        params.set("subject", subject);
        if (schoolYear) params.set("schoolYear", schoolYear);
        const r = await authFetch(
          `/api/student-benchmarks?${params.toString()}`,
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Request failed (${r.status})`);
        }
        const json = (await r.json()) as PayloadShape;
        if (cancelled) return;
        setData(json);
        // Default to the most recent window in this year (server
        // returns PM1 → PM3 order; "most recent" is the last entry).
        if (json.windows.length > 0) {
          const last = json.windows[json.windows.length - 1]!;
          setActiveWindow((prev) => {
            // Keep user's selection if it still exists in the new
            // year's window set; else snap to most-recent.
            if (prev && json.windows.some((w) => w.window === prev)) {
              return prev;
            }
            return last.window;
          });
        } else {
          setActiveWindow(null);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load benchmarks");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [studentId, subject, schoolYear]);

  const currentWindow = useMemo<WindowBlock | null>(() => {
    if (!data || !activeWindow) return null;
    return data.windows.find((w) => w.window === activeWindow) ?? null;
  }, [data, activeWindow]);

  const sortedBenchmarks = useMemo<BenchmarkRow[]>(() => {
    if (!currentWindow) return [];
    const rows = [...currentWindow.benchmarks];
    if (sortKey === "mastery_asc") {
      rows.sort((a, b) => a.masteryPct - b.masteryPct);
    } else if (sortKey === "code") {
      rows.sort((a, b) => a.code.localeCompare(b.code));
    }
    // "category" — already sorted by (category, code) on the server.
    return rows;
  }, [currentWindow, sortKey]);

  // Group by category for the table render. Preserves the sorted
  // order so "mastery_asc" still groups visually but within each
  // category the rows are mastery-ascending.
  const grouped = useMemo<Map<string, BenchmarkRow[]>>(() => {
    const m = new Map<string, BenchmarkRow[]>();
    for (const r of sortedBenchmarks) {
      const key = r.category ?? "Uncategorized";
      const list = m.get(key) ?? [];
      list.push(r);
      m.set(key, list);
    }
    return m;
  }, [sortedBenchmarks]);

  return (
    <div
      style={{
        marginTop: "0.75rem",
        paddingTop: "0.6rem",
        borderTop: "1px dashed #e5e7eb",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginBottom: "0.5rem",
        }}
      >
        <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
          FAST Benchmarks
        </div>
        <select
          aria-label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value as SubjectKey)}
          style={selectStyle}
        >
          {(Object.keys(SUBJECT_LABEL) as SubjectKey[]).map((k) => (
            <option key={k} value={k}>
              {SUBJECT_LABEL[k]}
            </option>
          ))}
        </select>
        <select
          aria-label="School year"
          value={schoolYear ?? data?.schoolYear ?? ""}
          onChange={(e) => setSchoolYear(e.target.value || null)}
          disabled={!data || data.availableSchoolYears.length === 0}
          style={selectStyle}
        >
          {(data?.availableSchoolYears ?? []).map((sy) => (
            <option key={sy} value={sy}>
              {sy}
            </option>
          ))}
          {data && data.availableSchoolYears.length === 0 && (
            <option value="">{data.schoolYear} (no data)</option>
          )}
        </select>
        <select
          aria-label="Sort"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          style={selectStyle}
        >
          <option value="category">Sort: Category</option>
          <option value="mastery_asc">Sort: Mastery % (low → high)</option>
          <option value="code">Sort: Benchmark code</option>
        </select>
        {data && (
          <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>
            Mastery threshold {data.thresholdPct}%
          </span>
        )}
      </div>

      {loading && <div style={mutedStyle}>Loading…</div>}
      {error && (
        <div
          style={{
            color: "#991b1b",
            background: "#fee2e2",
            border: "1px solid #fca5a5",
            padding: "0.4rem 0.6rem",
            borderRadius: 6,
            fontSize: "0.8rem",
          }}
        >
          {error}
        </div>
      )}
      {!loading && !error && data && data.windows.length === 0 && (
        <div style={mutedStyle}>
          No FAST item-level data imported for this subject/year yet.
        </div>
      )}

      {data && data.windows.length > 0 && (
        <>
          {/* Window picker */}
          <div
            role="tablist"
            aria-label="FAST window"
            style={{ display: "flex", gap: 4, marginBottom: "0.6rem" }}
          >
            {data.windows.map((w) => {
              const active = w.window === activeWindow;
              return (
                <button
                  key={w.window}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveWindow(w.window)}
                  style={{
                    padding: "0.25rem 0.7rem",
                    border: "1px solid",
                    borderColor: active ? "#1e40af" : "#d1d5db",
                    background: active ? "#dbeafe" : "white",
                    color: active ? "#1e3a8a" : "#374151",
                    fontWeight: active ? 700 : 500,
                    fontSize: "0.8rem",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  {w.label}
                </button>
              );
            })}
          </div>

          {currentWindow && (
            <>
              {/* Category rollup */}
              {currentWindow.categoryRollups.length > 0 && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(160px, 1fr))",
                    gap: 6,
                    marginBottom: "0.6rem",
                  }}
                >
                  {currentWindow.categoryRollups.map((c) => {
                    const col = cellColor(c.masteryPct, data.thresholdPct);
                    return (
                      <div
                        key={c.category}
                        title={`${c.earned}/${c.possible} pts across ${c.benchmarkCount} benchmarks`}
                        style={{
                          background: col.bg,
                          color: col.fg,
                          border: `1px solid ${col.fg}33`,
                          borderRadius: 6,
                          padding: "0.4rem 0.55rem",
                        }}
                      >
                        <div style={{ fontSize: "0.7rem", opacity: 0.85 }}>
                          {c.category}
                        </div>
                        <div
                          style={{
                            fontSize: "1.1rem",
                            fontWeight: 700,
                            lineHeight: 1.1,
                          }}
                        >
                          {c.masteryPct}%
                        </div>
                        <div style={{ fontSize: "0.7rem", opacity: 0.85 }}>
                          {c.benchmarkCount} benchmark
                          {c.benchmarkCount === 1 ? "" : "s"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Benchmark rows */}
              <div style={{ overflowX: "auto" }}>
                <table
                  className="pulse-table"
                  style={{ width: "100%", fontSize: "0.8rem" }}
                >
                  <thead>
                    <tr style={{ color: "#6b7280" }}>
                      <th style={{ textAlign: "left" }}>Benchmark</th>
                      <th style={{ textAlign: "left" }}>Category</th>
                      <th style={{ textAlign: "right" }}>Attempts</th>
                      <th style={{ textAlign: "right" }}>Earned / Possible</th>
                      <th style={{ textAlign: "right" }}>Mastery</th>
                      <th
                        style={{ textAlign: "left", paddingLeft: 8 }}
                        title="Mastery trend across all windows on file (PM1 → PM3, across years)"
                      >
                        Trend
                      </th>
                      <th style={{ textAlign: "left", paddingLeft: 8 }}>
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(grouped.entries()).map(([cat, rows]) =>
                      rows.map((r, i) => {
                        const col = cellColor(r.masteryPct, data.thresholdPct);
                        return (
                          <tr key={`${cat}|${r.code}`}>
                            <td
                              style={{
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, monospace",
                              }}
                            >
                              {r.code}
                              {r.mtssTagged && (
                                <span
                                  title="MTSS plan targets this benchmark"
                                  style={{
                                    marginLeft: 6,
                                    background: "#ede9fe",
                                    color: "#5b21b6",
                                    border: "1px solid #c4b5fd",
                                    borderRadius: 999,
                                    fontSize: "0.65rem",
                                    fontWeight: 700,
                                    padding: "0.05rem 0.4rem",
                                  }}
                                >
                                  MTSS
                                </span>
                              )}
                            </td>
                            <td style={{ color: "#6b7280" }}>
                              {/* Only print the category on the first row
                                  of each group so the eye reads the
                                  grouping without column noise. */}
                              {i === 0 ? cat : ""}
                            </td>
                            <td style={{ textAlign: "right" }}>{r.attempts}</td>
                            <td style={{ textAlign: "right" }}>
                              {r.earned} / {r.possible}
                            </td>
                            <td
                              style={{
                                textAlign: "right",
                                fontWeight: 700,
                                color: col.fg,
                              }}
                            >
                              {r.masteryPct}%
                            </td>
                            <td style={{ paddingLeft: 8 }}>
                              {(() => {
                                const hist =
                                  data.historyByCode?.[r.code] ?? [];
                                if (hist.length < 2) {
                                  return (
                                    <span
                                      style={{
                                        color: "#9ca3af",
                                        fontSize: "0.7rem",
                                      }}
                                      title="Need ≥ 2 windows for a trend"
                                    >
                                      —
                                    </span>
                                  );
                                }
                                return (
                                  <Sparkline
                                    points={hist}
                                    thresholdPct={data.thresholdPct}
                                  />
                                );
                              })()}
                            </td>
                            <td style={{ paddingLeft: 8 }}>
                              <span
                                style={{
                                  background: col.bg,
                                  color: col.fg,
                                  border: `1px solid ${col.fg}33`,
                                  borderRadius: 999,
                                  padding: "0.05rem 0.5rem",
                                  fontSize: "0.7rem",
                                  fontWeight: 600,
                                }}
                              >
                                {statusLabel(r.status)}
                              </span>
                            </td>
                          </tr>
                        );
                      }),
                    )}
                  </tbody>
                </table>
              </div>

              {currentWindow.overallMasteryPct != null && (
                <div
                  style={{
                    marginTop: "0.4rem",
                    fontSize: "0.75rem",
                    color: "#6b7280",
                  }}
                >
                  Overall: {currentWindow.totalEarned} /{" "}
                  {currentWindow.totalPossible} pts (
                  {currentWindow.overallMasteryPct}%) across{" "}
                  {currentWindow.benchmarks.length} benchmark
                  {currentWindow.benchmarks.length === 1 ? "" : "s"}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "0.2rem 0.4rem",
  fontSize: "0.8rem",
  background: "white",
};

const mutedStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  padding: "0.5rem 0",
};
