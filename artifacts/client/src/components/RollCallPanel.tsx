import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// Phase 4 — staff-facing "Who signed in to class today?" roll-call.
// Reads class_signins rows for the current school day, grouped by
// teacher/room. Refreshes on demand; no realtime push (the kiosk
// writes are append-only and idempotent within window). Backed by
// GET /api/class-signins/today.

interface RollCallRow {
  id: number;
  studentRecordId: string;
  firstName: string;
  lastName: string;
  grade: number | string | null;
  teacherName: string;
  signedInAt: string;
}

export function RollCallPanel() {
  const [rows, setRows] = useState<RollCallRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  function load() {
    setLoading(true);
    setError("");
    authFetch("/api/class-signins/today")
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
    load();
  }, []);

  // Group by teacher so a section-leader can scan their period quickly.
  const grouped = (() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, RollCallRow[]>();
    for (const r of rows) {
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
  })();

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Class Sign-Ins — Today</h2>
        <button
          type="button"
          onClick={load}
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
        Live roll-call from kiosk class sign-ins. Grouped by teacher.
      </p>

      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name, student id, or teacher…"
        style={{
          width: "100%",
          padding: "0.5rem 0.65rem",
          borderRadius: 6,
          border: "1px solid var(--border, rgba(0,0,0,0.15))",
          boxSizing: "border-box",
          marginBottom: "0.75rem",
        }}
      />

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
          No class sign-ins today{filter ? " match your filter" : ""}.
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
