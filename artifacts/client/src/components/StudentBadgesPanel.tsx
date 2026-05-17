import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

// Admin tool — print Student ID badges (PDF, lanyard or CR80, with
// rectangle photo on the badge when consent + photo are present,
// otherwise an initials bubble). Backed by
// POST /api/students/id-badges.pdf which is admin-gated and
// school-scoped on the server side. Phase 4 also surfaces a recent
// reprint audit table via GET /api/students/badge-print-events.

type BadgeSize = "lanyard" | "cr80";

interface StudentRow {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string | null;
}

interface PrintEvent {
  id: number;
  studentRecordId: string | null;
  firstName: string | null;
  lastName: string | null;
  grade: number | string | null;
  printedByName: string;
  size: string;
  reason: string | null;
  batchSize: number;
  printedAt: string;
}

export function StudentBadgesPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [size, setSize] = useState<BadgeSize>("lanyard");

  const [students, setStudents] = useState<StudentRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState<string>("");
  const [reason, setReason] = useState("");

  const [events, setEvents] = useState<PrintEvent[]>([]);

  useEffect(() => {
    authFetch("/api/students")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setStudents(Array.isArray(d) ? d : d?.students ?? []))
      .catch(() => setStudents([]));
    refreshEvents();
  }, []);

  function refreshEvents() {
    authFetch("/api/students/badge-print-events?limit=25")
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d) => setEvents(Array.isArray(d?.events) ? d.events : []))
      .catch(() => setEvents([]));
  }

  const grades = useMemo(() => {
    const s = new Set<string>();
    for (const r of students) {
      if (r.grade !== null && r.grade !== undefined && r.grade !== "")
        s.add(String(r.grade));
    }
    return Array.from(s).sort();
  }, [students]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return students.filter((r) => {
      if (gradeFilter && String(r.grade ?? "") !== gradeFilter) return false;
      if (!q) return true;
      const hay = `${r.firstName} ${r.lastName} ${r.studentId}`.toLowerCase();
      return hay.includes(q);
    });
  }, [students, filter, gradeFilter]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function download(payload: { all: true } | { studentIds: number[] }) {
    setBusy(true);
    setError("");
    try {
      const body = {
        ...payload,
        size,
        reason: reason.trim() || undefined,
      };
      const res = await authFetch("/api/students/id-badges.pdf", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `PDF failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `student-id-badges-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      // Refresh audit after a print so the user sees their entry land.
      setTimeout(refreshEvents, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function printSelection() {
    const ids = Array.from(selected);
    if (ids.length === 0) {
      setError("Select at least one student.");
      return;
    }
    await download({ studentIds: ids });
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Student ID Badges</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Printable badges with the student's photo (when on file and
        consent is granted), name, grade, school, house ribbon, and a
        scannable QR + Code 128. Students scan these at the kiosk to
        sign in to class or create a hall pass.
      </p>

      <fieldset
        style={{
          border: "1px solid var(--border, rgba(0,0,0,0.15))",
          borderRadius: 6,
          padding: "0.5rem 0.75rem",
          margin: "0 0 0.75rem 0",
        }}
      >
        <legend style={{ fontSize: "0.85rem", padding: "0 0.35rem" }}>
          Badge size
        </legend>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: "1rem", cursor: "pointer" }}>
          <input
            type="radio"
            name="badge-size"
            value="lanyard"
            checked={size === "lanyard"}
            onChange={() => setSize("lanyard")}
            disabled={busy}
          />
          <span>Lanyard <span style={{ opacity: 0.65 }}>(3⅜″ × 4¼″, portrait)</span></span>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="radio"
            name="badge-size"
            value="cr80"
            checked={size === "cr80"}
            onChange={() => setSize("cr80")}
            disabled={busy}
          />
          <span>CR80 card <span style={{ opacity: 0.65 }}>(3⅜″ × 2⅛″, landscape)</span></span>
        </label>
      </fieldset>

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

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end", marginBottom: "0.75rem" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => download({ all: true })}
          style={{
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "0.7rem 1.25rem",
            fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? "Generating…" : "Print all student badges"}
        </button>
      </div>

      <details style={{ marginTop: "0.5rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Print specific students ({selected.size} selected)
        </summary>
        <div style={{ marginTop: "0.75rem" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or student id…"
              style={{
                flex: "1 1 220px",
                padding: "0.45rem 0.6rem",
                borderRadius: 6,
                border: "1px solid var(--border, rgba(0,0,0,0.15))",
                boxSizing: "border-box",
              }}
            />
            <select
              value={gradeFilter}
              onChange={(e) => setGradeFilter(e.target.value)}
              style={{
                padding: "0.45rem 0.6rem",
                borderRadius: 6,
                border: "1px solid var(--border, rgba(0,0,0,0.15))",
              }}
            >
              <option value="">All grades</option>
              {grades.map((g) => (
                <option key={g} value={g}>Grade {g}</option>
              ))}
            </select>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional, e.g. lost)"
              maxLength={120}
              style={{
                flex: "1 1 180px",
                padding: "0.45rem 0.6rem",
                borderRadius: 6,
                border: "1px solid var(--border, rgba(0,0,0,0.15))",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div
            style={{
              maxHeight: 280,
              overflowY: "auto",
              border: "1px solid var(--border, rgba(0,0,0,0.15))",
              borderRadius: 6,
              padding: "0.25rem 0.5rem",
              marginBottom: "0.5rem",
              background: "var(--surface, #fff)",
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ opacity: 0.6, padding: "0.5rem" }}>
                No students match your filter.
              </div>
            ) : (
              filtered.slice(0, 500).map((r) => (
                <label
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.25rem 0",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <span style={{ flex: 1 }}>
                    {r.lastName}, {r.firstName}{" "}
                    <span style={{ opacity: 0.6 }}>
                      · {r.studentId}
                      {r.grade !== null && r.grade !== undefined && r.grade !== "" ? ` · Grade ${r.grade}` : ""}
                    </span>
                  </span>
                </label>
              ))
            )}
            {filtered.length > 500 && (
              <div style={{ opacity: 0.6, padding: "0.5rem", fontSize: "0.85rem" }}>
                Showing first 500 of {filtered.length}. Narrow with the filter above.
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={printSelection}
              style={{
                background: "#0f766e",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "0.55rem 1rem",
                fontWeight: 600,
                cursor: busy || selected.size === 0 ? "not-allowed" : "pointer",
                opacity: busy || selected.size === 0 ? 0.6 : 1,
              }}
            >
              Print {selected.size || ""} selected
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
              style={{
                background: "transparent",
                color: "var(--text)",
                border: "1px solid var(--border, rgba(0,0,0,0.2))",
                borderRadius: 6,
                padding: "0.55rem 1rem",
                cursor: selected.size === 0 ? "not-allowed" : "pointer",
                opacity: selected.size === 0 ? 0.5 : 1,
              }}
            >
              Clear selection
            </button>
          </div>
        </div>
      </details>

      <details style={{ marginTop: "1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Recent badge prints ({events.length})
        </summary>
        <div style={{ marginTop: "0.5rem" }}>
          {events.length === 0 ? (
            <div style={{ opacity: 0.65, fontSize: "0.9rem" }}>
              No badge prints recorded yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.88rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, rgba(0,0,0,0.15))" }}>
                    <th style={{ padding: "0.35rem 0.5rem" }}>When</th>
                    <th style={{ padding: "0.35rem 0.5rem" }}>Student</th>
                    <th style={{ padding: "0.35rem 0.5rem" }}>Printed by</th>
                    <th style={{ padding: "0.35rem 0.5rem" }}>Size</th>
                    <th style={{ padding: "0.35rem 0.5rem" }}>Batch</th>
                    <th style={{ padding: "0.35rem 0.5rem" }}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} style={{ borderBottom: "1px solid var(--border, rgba(0,0,0,0.06))" }}>
                      <td style={{ padding: "0.35rem 0.5rem", whiteSpace: "nowrap" }}>
                        {new Date(e.printedAt).toLocaleString()}
                      </td>
                      <td style={{ padding: "0.35rem 0.5rem" }}>
                        {e.firstName ? `${e.lastName}, ${e.firstName}` : "(deleted)"}{" "}
                        <span style={{ opacity: 0.6 }}>{e.studentRecordId ? `· ${e.studentRecordId}` : ""}</span>
                      </td>
                      <td style={{ padding: "0.35rem 0.5rem" }}>{e.printedByName || "—"}</td>
                      <td style={{ padding: "0.35rem 0.5rem" }}>{e.size}</td>
                      <td style={{ padding: "0.35rem 0.5rem" }}>{e.batchSize}</td>
                      <td style={{ padding: "0.35rem 0.5rem" }}>{e.reason || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

export default StudentBadgesPanel;
