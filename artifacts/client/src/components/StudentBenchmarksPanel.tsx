// FAST Phase 3 — Per-student benchmark history panel.
//
// Student-at-a-glance view: ELA and Math render side-by-side as two
// independent columns, each with its own window/year/sort controls.
// Drops into the Academics pillar on the Student Profile page.
//
// Compact 3-column table (Benchmark · Mastery · Trend) so two
// subjects can sit side-by-side in the profile panel without
// horizontal scroll. Category + attempts are inlined under the
// benchmark code to free horizontal space.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { authFetch } from "../lib/authToken";

interface BenchmarkRow {
  code: string;
  category: string | null;
  description?: string | null;
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
  historyByCode?: Record<string, HistoryPoint[]>;
}

function Sparkline({
  points,
  thresholdPct,
  width = 64,
  height = 18,
  activeWindow,
  activeSchoolYear,
}: {
  points: HistoryPoint[];
  thresholdPct: number;
  width?: number;
  height?: number;
  // The currently-selected testing window ("pm1"/"pm2"/"pm3") and school
  // year. The dot for THIS window+year is emphasized so the big dot
  // tracks the window toggle (not always PM3). When no point matches
  // (the selected window has no data for this benchmark), every dot
  // renders at the smaller size.
  activeWindow?: string | null;
  activeSchoolYear?: string | null;
}): ReactElement | null {
  if (points.length < 2) return null;
  // Dot radii: the dot for the selected window is emphasized; all other
  // windows (+ any cross-year history) get a smaller-but-clearly-visible
  // dot. The plot padding is reserved to the LARGEST dot radius so no dot
  // ever clips on any edge of the fixed-size cell (cell height stays put).
  const emphasizedIdx = points.findIndex(
    (p) =>
      p.window === activeWindow &&
      (activeSchoolYear == null || p.schoolYear === activeSchoolYear),
  );
  const endR = 6;
  const midR = 4;
  const pad = endR;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const xs = points.map((_, i) =>
    points.length === 1
      ? pad + innerW / 2
      : pad + (i / (points.length - 1)) * innerW,
  );
  const ys = points.map(
    (p) => pad + innerH * (1 - Math.max(0, Math.min(100, p.pct)) / 100),
  );
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ");
  const thresholdY = pad + innerH * (1 - thresholdPct / 100);
  const label = points
    .map((p) => `${p.schoolYear} ${p.window.toUpperCase()}: ${p.pct}%`)
    .join(" → ");
  return (
    <svg width={width} height={height} role="img" aria-label={label}>
      <title>{label}</title>
      <line
        x1={pad}
        x2={pad + innerW}
        y1={thresholdY}
        y2={thresholdY}
        stroke="#d1d5db"
        strokeDasharray="2,2"
        strokeWidth={0.5}
      />
      <path d={path} stroke="#475569" strokeWidth={1} fill="none" />
      {points.map((p, i) => (
        <circle
          key={`${p.schoolYear}-${p.window}-${i}`}
          cx={xs[i]}
          cy={ys[i]}
          r={i === emphasizedIdx ? endR : midR}
          fill={cellColor(p.pct, thresholdPct).fg}
          stroke="#ffffff"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}

type SubjectKey = "ela" | "math";
type SortKey = "category" | "mastery_asc" | "code";

const SUBJECT_LABEL: Record<SubjectKey, string> = {
  ela: "ELA",
  math: "Math",
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

function SubjectColumn({
  studentId,
  subject,
}: {
  studentId: string;
  subject: SubjectKey;
}) {
  const [schoolYear, setSchoolYear] = useState<string | null>(null);
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
        if (json.windows.length > 0) {
          const last = json.windows[json.windows.length - 1]!;
          setActiveWindow((prev) => {
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
    return rows;
  }, [currentWindow, sortKey]);

  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          flexWrap: "wrap",
          marginBottom: "0.4rem",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "0.8rem" }}>
          {SUBJECT_LABEL[subject]}
        </div>
        <select
          aria-label={`${SUBJECT_LABEL[subject]} school year`}
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
          aria-label={`${SUBJECT_LABEL[subject]} sort`}
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          style={selectStyle}
        >
          <option value="category">Sort: Category</option>
          <option value="mastery_asc">Sort: Mastery low → high</option>
          <option value="code">Sort: Code</option>
        </select>
        {data && (
          <span style={{ color: "#6b7280", fontSize: "0.7rem" }}>
            ≥ {data.thresholdPct}%
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
          No FAST data imported for {SUBJECT_LABEL[subject]} yet.
        </div>
      )}

      {data && data.windows.length > 0 && (
        <>
          <div
            role="tablist"
            aria-label={`${SUBJECT_LABEL[subject]} FAST window`}
            style={{ display: "flex", gap: 4, marginBottom: "0.5rem" }}
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
                    padding: "0.2rem 0.55rem",
                    border: "1px solid",
                    borderColor: active ? "#1e40af" : "#d1d5db",
                    background: active ? "#dbeafe" : "white",
                    color: active ? "#1e3a8a" : "#374151",
                    fontWeight: active ? 700 : 500,
                    fontSize: "0.75rem",
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
              {currentWindow.categoryRollups.length > 0 && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 6,
                    marginBottom: "0.5rem",
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
                          padding: "0.35rem 0.5rem",
                        }}
                      >
                        <div style={{ fontSize: "0.65rem", opacity: 0.85 }}>
                          {c.category}
                        </div>
                        <div
                          style={{
                            fontSize: "1rem",
                            fontWeight: 700,
                            lineHeight: 1.1,
                          }}
                        >
                          {c.masteryPct}%
                        </div>
                        <div style={{ fontSize: "0.65rem", opacity: 0.85 }}>
                          {c.benchmarkCount} bm
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <table
                className="pulse-table"
                style={{
                  width: "100%",
                  fontSize: "0.72rem",
                  tableLayout: "fixed",
                }}
              >
                <colgroup>
                  <col style={{ width: "48%" }} />
                  <col style={{ width: "52%" }} />
                </colgroup>
                <thead>
                  <tr style={{ color: "#6b7280" }}>
                    <th style={{ textAlign: "left" }}>Benchmark</th>
                    <th style={{ textAlign: "right" }}>
                      Mastery · PM1 · PM2 · PM3
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedBenchmarks.map((r) => {
                    const col = cellColor(r.masteryPct, data.thresholdPct);
                    const hist = data.historyByCode?.[r.code] ?? [];
                    return (
                      <tr key={r.code}>
                        <td style={{ paddingRight: 4, minWidth: 0 }}>
                          <div
                            style={{
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, monospace",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={`${r.code}${r.category ? ` — ${r.category}` : ""}${r.description ? `\n\n${r.description}` : ""}`}
                          >
                            {r.code}
                            {r.mtssTagged && (
                              <span
                                title="MTSS plan targets this benchmark"
                                style={{
                                  marginLeft: 5,
                                  background: "#ede9fe",
                                  color: "#5b21b6",
                                  border: "1px solid #c4b5fd",
                                  borderRadius: 999,
                                  fontSize: "0.58rem",
                                  fontWeight: 700,
                                  padding: "0.02rem 0.3rem",
                                }}
                              >
                                MTSS
                              </span>
                            )}
                          </div>
                          {r.category && (
                            <div
                              style={{
                                color: "#9ca3af",
                                fontSize: "0.62rem",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={r.category}
                            >
                              {r.category} · {r.attempts} att
                            </div>
                          )}
                        </td>
                        <td
                          style={{
                            textAlign: "right",
                            whiteSpace: "nowrap",
                          }}
                          title={`${statusLabel(r.status)} — ${r.earned}/${r.possible} pts (${r.attempts} attempt${r.attempts === 1 ? "" : "s"})`}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              justifyContent: "flex-end",
                            }}
                          >
                            <span
                              style={{
                                background: col.bg,
                                color: col.fg,
                                border: `1px solid ${col.fg}33`,
                                borderRadius: 6,
                                padding: "0.05rem 0.35rem",
                                fontWeight: 700,
                              }}
                            >
                              {r.masteryPct}%
                            </span>
                            <span
                              style={{
                                color: "#6b7280",
                                fontSize: "0.64rem",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {r.earned}/{r.possible}
                            </span>
                            {hist.length >= 2 ? (
                              <Sparkline
                                points={hist}
                                thresholdPct={data.thresholdPct}
                                width={120}
                                height={24}
                                activeWindow={activeWindow}
                                activeSchoolYear={schoolYear ?? data.schoolYear}
                              />
                            ) : (
                              <span
                                style={{
                                  color: "#d1d5db",
                                  fontSize: "0.7rem",
                                  width: 120,
                                  display: "inline-block",
                                  textAlign: "center",
                                }}
                                title="Need ≥ 2 windows for a trend"
                              >
                                —
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {currentWindow.overallMasteryPct != null && (
                <div
                  style={{
                    marginTop: "0.35rem",
                    fontSize: "0.7rem",
                    color: "#6b7280",
                  }}
                >
                  Overall: {currentWindow.totalEarned}/
                  {currentWindow.totalPossible} pts (
                  {currentWindow.overallMasteryPct}%) ·{" "}
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

// `subject` prop renders a single subject column for that subject
// (used when callers want to place ELA and Math in different layout
// cells on the page). Omitted prop keeps the original behavior of
// rendering ELA + Math side-by-side under a shared "FAST Benchmarks"
// header — preserved for any other callers.
export default function StudentBenchmarksPanel({
  studentId,
  subject,
  showHeader = true,
  showTopBorder = true,
}: {
  studentId: string;
  subject?: SubjectKey;
  showHeader?: boolean;
  showTopBorder?: boolean;
}) {
  const wrapperStyle: React.CSSProperties = {
    marginTop: showTopBorder ? "0.75rem" : 0,
    paddingTop: showTopBorder ? "0.6rem" : 0,
    borderTop: showTopBorder ? "1px dashed #e5e7eb" : undefined,
  };
  if (subject) {
    return (
      <div style={wrapperStyle}>
        {showHeader && (
          <div
            style={{
              fontWeight: 600,
              fontSize: "0.85rem",
              marginBottom: "0.5rem",
            }}
          >
            FAST Benchmarks — {SUBJECT_LABEL[subject]}
          </div>
        )}
        <SubjectColumn studentId={studentId} subject={subject} />
      </div>
    );
  }
  return (
    <div style={wrapperStyle}>
      {showHeader && (
        <div
          style={{
            fontWeight: 600,
            fontSize: "0.85rem",
            marginBottom: "0.5rem",
          }}
        >
          FAST Benchmarks
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <SubjectColumn studentId={studentId} subject="ela" />
        <SubjectColumn studentId={studentId} subject="math" />
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "0.15rem 0.35rem",
  fontSize: "0.75rem",
  background: "white",
};

const mutedStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  padding: "0.5rem 0",
};
