import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import StudentPicker from "./StudentPicker";

// Teacher-facing Hall Pass Research.
//
// Unlike the admin Research tab (which filters the whole-school pass list
// client-side), everything here is served by roster-scoped endpoints —
// a teacher can only search and summarize students on their own roster.
//
// Layout, top to bottom:
//   1. Gradient header: Total Lost Instruction (minutes + days). Before a
//      search it shows the teacher's whole visible roster; after a search
//      it shows the selected student.
//   2. Filters: From / To dates, student picker, Clear.
//   3. Period dot graph: one cell per bell-schedule period. Green dot =
//      passes today, purple dot = historical passes this school year. The
//      teacher-of-record cells are larger and add a red oval (lost minutes
//      from MY class), a class average, and a quarter selector; tapping a
//      teacher cell expands the exact passes behind the number.
//   4. Pass history list (most recent first) with per-pass duration.

interface RosterStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
  localSisId: string | null;
}

interface PeriodCell {
  period: number;
  lengthMin: number | null;
  todayCount: number;
  historicCount: number;
  isMine: boolean;
  courseName: string | null;
  myLostMin: number | null;
  myQuarterPassCount: number | null;
  classAvgLostMin: number | null;
}

interface ResearchPass {
  id: number;
  originRoom: string | null;
  destination: string | null;
  status: string;
  isTardyReturn: boolean | null;
  maxDurationMinutes: number;
  createdAt: string;
  endedAt: string | null;
  period: number | null;
  lostMin: number | null;
}

interface Summary {
  student: RosterStudent;
  quarter: string;
  quarterWindow: { from: string; to: string };
  periods: PeriodCell[];
  totals: { lostMin: number; days: number | null; periodLen: number | null };
  passes: ResearchPass[];
}

interface RosterTotal {
  lostMin: number;
  days: number | null;
  periodLen: number | null;
  studentCount: number;
}

const GRADIENT =
  "linear-gradient(135deg, #312e81 0%, #4c1d95 55%, #7c3aed 100%)";

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  let h = d.getHours();
  const mn = String(d.getMinutes()).padStart(2, "0");
  const ampm = h < 12 ? "AM" : "PM";
  h = ((h + 11) % 12) + 1;
  return `${m}/${day} ${h}:${mn} ${ampm}`;
}

function durMin(p: ResearchPass): number | null {
  if (!p.endedAt) return null;
  const m =
    (new Date(p.endedAt).getTime() - new Date(p.createdAt).getTime()) / 60000;
  return Math.max(0, Math.round(m * 100) / 100);
}

function statusColor(p: ResearchPass): string {
  if (p.status === "active") return "#3b82f6";
  const d = durMin(p);
  if (d != null && d > p.maxDurationMinutes) return "#f59e0b";
  return "#22c55e";
}

function Dot({
  color,
  value,
  title,
  size = 26,
}: {
  color: string;
  value: number;
  title: string;
  size?: number;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: "white",
        fontWeight: 700,
        fontSize: size >= 26 ? "0.8rem" : "0.72rem",
        opacity: value === 0 ? 0.35 : 1,
        flex: "0 0 auto",
      }}
    >
      {value}
    </span>
  );
}

export default function TeacherHallPassResearch() {
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [rosterTotal, setRosterTotal] = useState<RosterTotal | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quarter, setQuarter] = useState<"all" | "Q1" | "Q2" | "Q3" | "Q4">(
    "all",
  );
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedPeriod, setExpandedPeriod] = useState<number | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const reqIdRef = useRef(0);

  useEffect(() => {
    authFetch("/api/hall-passes/research/students")
      .then((r) => (r.ok ? r.json() : { students: [] }))
      .then((d) => setRoster(Array.isArray(d.students) ? d.students : []))
      .catch(() => setRoster([]));
    authFetch("/api/hall-passes/research/roster-total")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRosterTotal(d))
      .catch(() => setRosterTotal(null));
  }, []);

  const clearSelection = () => {
    // Invalidate any in-flight summary fetch so a late response can't
    // repopulate the view for a no-longer-selected student.
    reqIdRef.current++;
    setSelectedId(null);
    setSummary(null);
    setExpandedPeriod(null);
    setError("");
    setLoading(false);
  };

  useEffect(() => {
    if (!selectedId) return;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError("");
    authFetch(
      `/api/hall-passes/research/summary?studentId=${encodeURIComponent(selectedId)}&quarter=${quarter}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<Summary>;
      })
      .then((d) => {
        if (myReq !== reqIdRef.current) return;
        setSummary(d);
      })
      .catch((e) => {
        if (myReq !== reqIdRef.current) return;
        setSummary(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (myReq === reqIdRef.current) setLoading(false);
      });
  }, [selectedId, quarter]);

  const historyPasses = useMemo(() => {
    if (!summary) return [];
    const fromMs = fromDate
      ? new Date(`${fromDate}T00:00:00`).getTime()
      : -Infinity;
    const toMs = toDate ? new Date(`${toDate}T23:59:59`).getTime() : Infinity;
    return summary.passes.filter((p) => {
      const t = new Date(p.createdAt).getTime();
      return t >= fromMs && t <= toMs;
    });
  }, [summary, fromDate, toDate]);

  const expandedPasses = useMemo(() => {
    if (!summary || expandedPeriod == null) return [];
    const w = summary.quarterWindow;
    return summary.passes.filter((p) => {
      if (p.period !== expandedPeriod) return false;
      const day = p.createdAt.slice(0, 10);
      return day >= w.from && day <= w.to;
    });
  }, [summary, expandedPeriod]);

  const headerLostMin = summary
    ? summary.totals.lostMin
    : (rosterTotal?.lostMin ?? null);
  const headerDays = summary
    ? summary.totals.days
    : (rosterTotal?.days ?? null);
  const headerLabel = summary
    ? `${summary.student.firstName} ${summary.student.lastName} · this school year`
    : rosterTotal
      ? `your ${rosterTotal.studentCount.toLocaleString()} students with passes · this school year`
      : "";
  const periodLen = summary?.totals.periodLen ?? rosterTotal?.periodLen ?? null;

  const quarterLabel = quarter === "all" ? "school year" : quarter;

  return (
    <>
      {/* 1 — Big gradient header */}
      <div
        className="card"
        style={{
          background: GRADIENT,
          color: "white",
          padding: "1.4rem 1.6rem",
        }}
      >
        <div
          style={{
            fontSize: "1.1rem",
            fontWeight: 600,
            letterSpacing: 0.5,
            opacity: 0.9,
            textTransform: "uppercase",
          }}
        >
          Total Lost Instruction
        </div>
        <div style={{ fontSize: "4rem", fontWeight: 800, lineHeight: 1.1 }}>
          {headerLostMin == null ? "—" : `${headerLostMin.toLocaleString()} min`}
        </div>
        <div style={{ fontSize: "1.6rem", fontWeight: 700, opacity: 0.95 }}>
          {headerDays == null
            ? periodLen == null
              ? "days unavailable — no default bell schedule configured"
              : ""
            : `≈ ${headerDays.toLocaleString()} ${headerDays === 1 ? "day" : "days"} of instruction`}
        </div>
        <div style={{ fontSize: "0.85rem", opacity: 0.75, marginTop: 4 }}>
          {headerLabel}
          {periodLen != null &&
            ` · 1 day = ${periodLen} min (average period on your bell schedule)`}
        </div>
      </div>

      {/* 2 — Filters */}
      <div className="card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.75rem",
            alignItems: "flex-end",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: "0.8rem",
              color: "#64748b",
            }}
          >
            Student (your roster)
            <StudentPicker
              mode="local"
              items={roster}
              selectedKey={selectedId ?? undefined}
              getKey={(s) => s.studentId}
              getPrimary={(s) => `${s.firstName} ${s.lastName}`}
              getSearchText={(s) =>
                `${s.firstName} ${s.lastName} ${s.localSisId ?? ""}`
              }
              renderMeta={(s) =>
                `· ${s.localSisId ?? "—"} · Gr ${String(s.grade).padStart(2, "0")}`
              }
              onSelect={(s) => {
                setExpandedPeriod(null);
                setSelectedId(s.studentId);
              }}
              onClear={clearSelection}
              placeholder="Type name or student ID…"
              ariaLabel="Search your roster by name or student ID"
              minWidth={260}
            />
          </div>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: "0.8rem",
              color: "#64748b",
            }}
          >
            From
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              style={{
                padding: "0.35rem 0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                fontSize: "0.9rem",
              }}
            />
          </label>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: "0.8rem",
              color: "#64748b",
            }}
          >
            To
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              style={{
                padding: "0.35rem 0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                fontSize: "0.9rem",
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              clearSelection();
              setFromDate("");
              setToDate("");
              setQuarter("all");
            }}
            style={{ padding: "0.45rem 0.9rem", fontSize: "0.85rem" }}
          >
            Clear filters
          </button>
          {loading && (
            <span style={{ color: "#64748b", fontSize: "0.85rem" }}>
              Loading…
            </span>
          )}
          {error && (
            <span style={{ color: "#dc2626", fontSize: "0.85rem" }}>
              {error}
            </span>
          )}
        </div>
        {!summary && !loading && !error && (
          <div style={{ color: "#64748b", marginTop: "0.75rem" }}>
            Search a student from your roster to see their pass history, a
            period-by-period breakdown, and how much of YOUR class they have
            missed on passes.
          </div>
        )}
      </div>

      {/* 3 — Period dot graph */}
      {summary && (
        <div className="card">
          <h3 style={{ margin: "0 0 0.25rem", color: "#4c1d95" }}>
            Passes by period —{" "}
            {`${summary.student.firstName} ${summary.student.lastName}`}
          </h3>
          <div
            style={{ fontSize: "0.8rem", color: "#64748b", marginBottom: 12 }}
          >
            <Dot color="#16a34a" value={1} title="" size={16} /> today ·{" "}
            <Dot color="#7c3aed" value={9} title="" size={16} /> this school
            year · highlighted cells are periods where this student is in YOUR
            class
          </div>
          {summary.periods.length === 0 ? (
            <div style={{ color: "#64748b" }}>
              No default bell schedule is configured for this school, so
              passes can't be matched to periods yet.
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                alignItems: "stretch",
              }}
            >
              {summary.periods.map((c) => {
                const mine = c.isMine;
                return (
                  <div
                    key={c.period}
                    onClick={
                      mine
                        ? () =>
                            setExpandedPeriod((p) =>
                              p === c.period ? null : c.period,
                            )
                        : undefined
                    }
                    style={{
                      border: mine
                        ? "2px solid #7c3aed"
                        : "1px solid #e2e8f0",
                      background: mine ? "#f5f3ff" : "white",
                      borderRadius: 10,
                      padding: mine ? "0.75rem 0.9rem" : "0.55rem 0.7rem",
                      minWidth: mine ? 210 : 96,
                      cursor: mine ? "pointer" : "default",
                      boxShadow:
                        expandedPeriod === c.period
                          ? "0 0 0 3px #ddd6fe"
                          : undefined,
                    }}
                  >
                    <div
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        color: mine ? "#5b21b6" : "#64748b",
                        marginBottom: 6,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: mine ? 190 : 90,
                      }}
                    >
                      Period {c.period}
                      {mine && c.courseName ? ` · ${c.courseName}` : ""}
                      {mine && " (your class)"}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <Dot
                        color="#16a34a"
                        value={c.todayCount}
                        title={`${c.todayCount} pass(es) today in period ${c.period}`}
                      />
                      <Dot
                        color="#7c3aed"
                        value={
                          mine && c.myQuarterPassCount != null
                            ? c.myQuarterPassCount
                            : c.historicCount + c.todayCount
                        }
                        title={
                          mine
                            ? `${c.myQuarterPassCount} pass(es) from your class this ${quarterLabel}`
                            : `${c.historicCount + c.todayCount} pass(es) this school year in period ${c.period}`
                        }
                      />
                      {mine && (
                        <span
                          title={`Instructional minutes missed from your class this ${quarterLabel}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background: "#dc2626",
                            color: "white",
                            fontWeight: 800,
                            borderRadius: 999,
                            padding: "0.3rem 0.7rem",
                            fontSize: "0.85rem",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.myLostMin ?? 0} min lost
                        </span>
                      )}
                    </div>
                    {mine && (
                      <>
                        <div
                          style={{
                            marginTop: 8,
                            display: "flex",
                            gap: 4,
                            flexWrap: "wrap",
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {(["all", "Q1", "Q2", "Q3", "Q4"] as const).map(
                            (q) => (
                              <button
                                key={q}
                                type="button"
                                onClick={() => setQuarter(q)}
                                style={{
                                  padding: "0.15rem 0.5rem",
                                  fontSize: "0.72rem",
                                  borderRadius: 6,
                                  border:
                                    quarter === q
                                      ? "1px solid #7c3aed"
                                      : "1px solid #cbd5e1",
                                  background:
                                    quarter === q ? "#7c3aed" : "white",
                                  color: quarter === q ? "white" : "#475569",
                                  cursor: "pointer",
                                  fontWeight: 600,
                                }}
                              >
                                {q === "all" ? "Year" : q}
                              </button>
                            ),
                          )}
                        </div>
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: "0.72rem",
                            color: "#64748b",
                          }}
                        >
                          class avg: {c.classAvgLostMin ?? 0} min ·{" "}
                          {c.lengthMin != null
                            ? `${c.lengthMin}-min period`
                            : "period length unknown"}{" "}
                          · tap for details
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Tap-to-expand: the exact passes behind the teacher cell */}
          {expandedPeriod != null && (
            <div
              style={{
                marginTop: 12,
                border: "1px solid #ddd6fe",
                borderRadius: 10,
                padding: "0.75rem 0.9rem",
                background: "#faf5ff",
              }}
            >
              <div style={{ fontWeight: 700, color: "#5b21b6" }}>
                Period {expandedPeriod} passes ({quarterLabel}) —{" "}
                {expandedPasses.length} pass
                {expandedPasses.length === 1 ? "" : "es"},{" "}
                {expandedPasses.reduce((a, p) => a + (p.lostMin ?? 0), 0)} min
                lost
              </div>
              {expandedPasses.length === 0 ? (
                <div style={{ color: "#64748b", marginTop: 6 }}>
                  No passes taken during this period in the selected window.
                </div>
              ) : (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.85rem",
                    marginTop: 6,
                  }}
                >
                  <thead style={{ color: "#64748b", textAlign: "left" }}>
                    <tr>
                      <th style={{ padding: "0.3rem 0.5rem" }}>Date</th>
                      <th style={{ padding: "0.3rem 0.5rem" }}>Destination</th>
                      <th style={{ padding: "0.3rem 0.5rem" }}>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expandedPasses.map((p) => (
                      <tr
                        key={p.id}
                        style={{ borderTop: "1px solid #e9d5ff" }}
                      >
                        <td style={{ padding: "0.3rem 0.5rem" }}>
                          {fmtDateTime(p.createdAt)}
                        </td>
                        <td style={{ padding: "0.3rem 0.5rem" }}>
                          {p.destination}
                        </td>
                        <td style={{ padding: "0.3rem 0.5rem" }}>
                          {p.lostMin == null ? "active" : `${p.lostMin} min`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {/* 4 — Pass history */}
      {summary && (
        <div className="card">
          <h3 style={{ margin: "0 0 0.5rem", color: "#4c1d95" }}>
            Pass history
            <span
              style={{
                marginLeft: "0.6rem",
                fontSize: "0.85rem",
                color: "#64748b",
                fontWeight: 400,
              }}
            >
              {historyPasses.length.toLocaleString()} passes
            </span>
          </h3>
          {historyPasses.length === 0 ? (
            <div style={{ color: "#64748b", padding: "0.5rem 0" }}>
              No passes in the selected date range.
            </div>
          ) : (
            <div style={{ maxHeight: 520, overflow: "auto" }}>
              <table
                className="pulse-table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "0.9rem",
                }}
              >
                <thead
                  style={{
                    position: "sticky",
                    top: 0,
                    background: "#f1f5f9",
                    color: "#64748b",
                    textAlign: "left",
                  }}
                >
                  <tr>
                    <th style={{ padding: "0.6rem 0.75rem", width: 60 }}>
                      Pass
                    </th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Origin</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Destination</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Period</th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>
                      Pass start time
                    </th>
                    <th style={{ padding: "0.6rem 0.75rem" }}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {historyPasses.slice(0, 500).map((p) => {
                    const d = durMin(p);
                    return (
                      <tr
                        key={p.id}
                        style={{
                          borderTop: "1px solid #e2e8f0",
                          background: p.isTardyReturn ? "#ede9fe" : undefined,
                        }}
                      >
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          <span
                            style={{
                              display: "inline-block",
                              width: 36,
                              height: 18,
                              borderRadius: 4,
                              background: statusColor(p),
                            }}
                          />
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          {p.originRoom}
                          {p.isTardyReturn && (
                            <span
                              style={{
                                marginLeft: 6,
                                padding: "1px 6px",
                                borderRadius: 4,
                                background: "#a78bfa",
                                color: "white",
                                fontWeight: 700,
                                fontSize: 10,
                                letterSpacing: 0.5,
                              }}
                            >
                              TARDY
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          {p.destination}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          {p.period ?? "—"}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          {fmtDateTime(p.createdAt)}
                        </td>
                        <td style={{ padding: "0.5rem 0.75rem" }}>
                          {d == null ? "active" : `${d.toFixed(2)} min`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {historyPasses.length > 500 && (
                <div
                  style={{
                    padding: "0.75rem",
                    fontSize: "0.8rem",
                    color: "#64748b",
                  }}
                >
                  Showing first 500 of {historyPasses.length.toLocaleString()}{" "}
                  passes. Narrow the date range to see more.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
