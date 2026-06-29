import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

// Phase 4 — staff-facing "Who signed in to class?" roll-call.
// Reads class_signins rows for a chosen school day (defaults to
// today), grouped by teacher/room. Refreshes on demand; no realtime
// push (the kiosk writes are append-only and idempotent within
// window). Backed by GET /api/class-signins/today[?date=YYYY-MM-DD].
//
// Filters (all client-side, read-only): a date picker to look back
// at any day, a Teacher dropdown, a Period dropdown (period is
// INFERRED server-side from the sign-in time against the school's
// default bell schedule — blank when no schedule is configured), and
// a free-text name/student-id search.

interface RollCallRow {
  id: number;
  studentRecordId: string;
  firstName: string;
  lastName: string;
  grade: number | string | null;
  teacherName: string;
  signedInAt: string;
  periodNumber: number | null;
  periodName: string;
}

// Local YYYY-MM-DD (school staff browse in their own local day).
function todayStr(): string {
  return new Date().toLocaleDateString("en-CA");
}

// Stable key for the period dropdown ("none" groups rows with no
// inferred period, e.g. before/after the bell schedule or when none
// is configured).
function periodKeyOf(r: RollCallRow): string {
  return r.periodNumber != null ? String(r.periodNumber) : "none";
}

function periodLabelOf(r: RollCallRow): string {
  if (r.periodName) return r.periodName;
  if (r.periodNumber != null) return `Period ${r.periodNumber}`;
  return "No period";
}

// "Mon, Jun 23, 2026" — parsed at local midnight to avoid a tz shift.
function prettyDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function RollCallPanel() {
  const [rows, setRows] = useState<RollCallRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState(todayStr());
  const [filter, setFilter] = useState("");
  const [teacherFilter, setTeacherFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");

  function load(forDate: string) {
    setLoading(true);
    setError("");
    authFetch(`/api/class-signins/today?date=${encodeURIComponent(forDate)}`)
      .then(async (r) => {
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(b.error ?? `Load failed (${r.status})`);
        }
        return r.json();
      })
      .then((d) => setRows(Array.isArray(d?.signins) ? d.signins : []))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(date);
  }, [date]);

  // Teacher options: distinct teachers present in the loaded day.
  const teacherOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.teacherName) set.add(r.teacherName);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Period options: distinct inferred periods present, ordered by
  // period number with "No period" last.
  const periodOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) map.set(periodKeyOf(r), periodLabelOf(r));
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === "none") return 1;
      if (b[0] === "none") return -1;
      return Number(a[0]) - Number(b[0]);
    });
  }, [rows]);

  // If a chosen teacher/period vanishes after a date change, reset it
  // so the dropdown never points at a value not in the list.
  useEffect(() => {
    if (teacherFilter && !teacherOptions.includes(teacherFilter)) {
      setTeacherFilter("");
    }
  }, [teacherOptions, teacherFilter]);
  useEffect(() => {
    if (periodFilter && !periodOptions.some(([k]) => k === periodFilter)) {
      setPeriodFilter("");
    }
  }, [periodOptions, periodFilter]);

  // Group by teacher so a section-leader can scan their period quickly.
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, RollCallRow[]>();
    for (const r of rows) {
      if (teacherFilter && r.teacherName !== teacherFilter) continue;
      if (periodFilter && periodKeyOf(r) !== periodFilter) continue;
      if (q) {
        const hay = `${r.firstName} ${r.lastName} ${r.studentRecordId} ${r.teacherName}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const k = r.teacherName || "(unassigned)";
      const arr = map.get(k) ?? [];
      arr.push(r);
      map.set(k, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, filter, teacherFilter, periodFilter]);

  const hasActiveFilter = Boolean(
    filter.trim() || teacherFilter || periodFilter,
  );
  const isToday = date === todayStr();

  const controlStyle: React.CSSProperties = {
    padding: "0.5rem 0.65rem",
    borderRadius: 6,
    border: "1px solid var(--border, rgba(0,0,0,0.15))",
    boxSizing: "border-box",
    background: "var(--surface, #fff)",
    color: "inherit",
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>
          Class Sign-Ins — {isToday ? "Today" : prettyDate(date)}
        </h2>
        <button
          type="button"
          onClick={() => load(date)}
          disabled={loading}
          style={{
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "0.45rem 0.9rem",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p style={{ color: "var(--text-subtle)", marginTop: "0.5rem" }}>
        Roll-call from kiosk class sign-ins. Grouped by teacher. Period is
        inferred from each sign-in's time using the school's default bell
        schedule.
      </p>

      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "0.75rem",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.8rem", color: "var(--text-subtle)" }}>
          Date
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value || todayStr())}
            style={controlStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.8rem", color: "var(--text-subtle)" }}>
          Teacher
          <select
            value={teacherFilter}
            onChange={(e) => setTeacherFilter(e.target.value)}
            style={{ ...controlStyle, minWidth: 170 }}
          >
            <option value="">All teachers</option>
            {teacherOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.8rem", color: "var(--text-subtle)" }}>
          Period
          <select
            value={periodFilter}
            onChange={(e) => setPeriodFilter(e.target.value)}
            disabled={periodOptions.length === 0}
            style={{ ...controlStyle, minWidth: 140 }}
          >
            <option value="">All periods</option>
            {periodOptions.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.8rem", color: "var(--text-subtle)", flex: "1 1 220px" }}>
          Search
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Name or student id…"
            style={{ ...controlStyle, width: "100%" }}
          />
        </label>
      </div>

      {error && (
        <div
          style={{
            color: "#b91c1c",
            background: "rgba(220,38,38,0.08)",
            border: "1px solid rgba(220,38,38,0.3)",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      {grouped.length === 0 ? (
        <div style={{ opacity: 0.65 }}>
          No class sign-ins {isToday ? "today" : `on ${prettyDate(date)}`}
          {hasActiveFilter ? " match your filters" : ""}.
        </div>
      ) : (
        grouped.map(([teacher, list]) => (
          <details
            key={teacher}
            open
            style={{ marginBottom: "0.75rem", border: "1px solid var(--border, rgba(0,0,0,0.12))", borderRadius: 6, padding: "0.5rem 0.75rem" }}
          >
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>
              {teacher}{" "}
              <span style={{ opacity: 0.65, fontWeight: 400 }}>
                · {list.length} student{list.length === 1 ? "" : "s"}
              </span>
            </summary>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem", fontSize: "0.9rem" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, rgba(0,0,0,0.12))" }}>
                  <th style={{ padding: "0.3rem 0.4rem" }}>Time</th>
                  <th style={{ padding: "0.3rem 0.4rem" }}>Period</th>
                  <th style={{ padding: "0.3rem 0.4rem" }}>Student</th>
                  <th style={{ padding: "0.3rem 0.4rem" }}>Grade</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--border, rgba(0,0,0,0.06))" }}>
                    <td style={{ padding: "0.3rem 0.4rem", whiteSpace: "nowrap" }}>
                      {new Date(r.signedInAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td style={{ padding: "0.3rem 0.4rem", whiteSpace: "nowrap", opacity: r.periodNumber != null ? 1 : 0.5 }}>
                      {r.periodNumber != null ? periodLabelOf(r) : "—"}
                    </td>
                    <td style={{ padding: "0.3rem 0.4rem" }}>
                      {r.lastName}, {r.firstName}{" "}
                      <span style={{ opacity: 0.6 }}>· {r.studentRecordId}</span>
                    </td>
                    <td style={{ padding: "0.3rem 0.4rem" }}>
                      {r.grade !== null && r.grade !== undefined && r.grade !== "" ? r.grade : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}
    </div>
  );
}

export default RollCallPanel;
