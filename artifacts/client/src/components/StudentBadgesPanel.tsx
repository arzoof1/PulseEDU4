import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { fetchAllStudents } from "../lib/students";
import { CardDesignPanel } from "./CardDesignPanel";
import { TeacherPicker } from "./TeacherPicker";

// Admin tool — print Student ID badges (PDF, a single landscape
// credit-card / CR80 ID, with a rectangle photo on the badge when consent
// + photo are present, otherwise an initials bubble). Backed by
// POST /api/students/id-badges.pdf which is admin-gated and
// school-scoped on the server side. Phase 4 also surfaces a recent
// reprint audit table via GET /api/students/badge-print-events.

interface StudentRow {
  id: number;
  studentId: string;
  /** District-local SIS number — student-facing credential. */
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number | string | null;
}

interface PrintEvent {
  id: number;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  grade: number | string | null;
  printedByName: string;
  size: string;
  reason: string | null;
  batchSize: number;
  printedAt: string;
}

interface TeacherOption {
  id: number;
  displayName: string;
  department?: string | null;
}

export function StudentBadgesPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [students, setStudents] = useState<StudentRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState<string>("");
  const [reason, setReason] = useState("");

  // Two-step confirmation gate for the bulk "print everyone" action so it is a
  // deliberate decision, never an accidental tap. 0 = closed, 1 = first
  // "compile" warning, 2 = final "print" confirmation.
  const [confirmAllStage, setConfirmAllStage] = useState<0 | 1 | 2>(0);
  const [allBtnHover, setAllBtnHover] = useState(false);
  const allCount = students.length;

  const [events, setEvents] = useState<PrintEvent[]>([]);

  // Print-by-teacher state.
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [teacherId, setTeacherId] = useState<string>("");
  const [teacherPeriods, setTeacherPeriods] = useState<number[]>([]);
  const [periodSel, setPeriodSel] = useState<string>("");
  const [rosterCount, setRosterCount] = useState<number | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  useEffect(() => {
    fetchAllStudents<StudentRow>()
      .then((rows) => setStudents(rows))
      .catch(() => setStudents([]));
    authFetch("/api/teacher-roster/teachers")
      .then((r) => (r.ok ? r.json() : { teachers: [] }))
      .then((d) => setTeachers(Array.isArray(d?.teachers) ? d.teachers : []))
      .catch(() => setTeachers([]));
    refreshEvents();
  }, []);

  // When a teacher is picked, pull their roster so we can offer a period
  // dropdown and preview how many badges the print will produce. The
  // teacher-roster endpoint already returns availablePeriods + the
  // (period-filtered) student list, so we reuse it rather than adding a
  // new endpoint. Period "" = all of the teacher's classes.
  useEffect(() => {
    if (!teacherId) {
      setTeacherPeriods([]);
      setPeriodSel("");
      setRosterCount(null);
      return;
    }
    const params = new URLSearchParams({ teacherId });
    if (periodSel) params.set("period", periodSel);
    setRosterLoading(true);
    authFetch(`/api/teacher-roster?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) {
          setTeacherPeriods([]);
          setRosterCount(null);
          return;
        }
        setTeacherPeriods(
          Array.isArray(d.availablePeriods) ? d.availablePeriods : [],
        );
        setRosterCount(Array.isArray(d.students) ? d.students.length : 0);
      })
      .catch(() => {
        setTeacherPeriods([]);
        setRosterCount(null);
      })
      .finally(() => setRosterLoading(false));
  }, [teacherId, periodSel]);

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
      const hay = `${r.firstName} ${r.lastName} ${r.localSisId ?? ""}`.toLowerCase();
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

  async function download(
    payload:
      | { all: true }
      | { studentIds: number[] }
      | { teacherId: number; period?: number },
  ) {
    setBusy(true);
    setError("");
    try {
      const body = {
        ...payload,
        reason: reason.trim() || undefined,
      };
      const res = await authFetch("/api/students/id-badges.pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  async function printByTeacher() {
    const tid = Number(teacherId);
    if (!Number.isInteger(tid) || tid <= 0) {
      setError("Pick a teacher first.");
      return;
    }
    const payload: { teacherId: number; period?: number } = { teacherId: tid };
    if (periodSel) payload.period = Number(periodSel);
    await download(payload);
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

      <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: "0.85rem" }}>
        Printed as a credit-card ID (CR80) — choose landscape (3⅜″ × 2⅛″) or a
        portrait lanyard badge in Card design below.
      </p>

      <details style={{ marginTop: "1rem" }} open>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Card design
        </summary>
        <p style={{ color: "var(--text-subtle)", fontSize: "0.85rem", marginBottom: 0 }}>
          Customize the printed badge: landscape or portrait orientation, a
          school-color or uploaded background across the top (behind the header
          + photo), header text contrast, and an optional house footer band.
          The QR, barcode, and crisis line always stay on clean white so they
          scan and read reliably.
        </p>
        <CardDesignPanel />
      </details>

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

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
        <button
          type="button"
          disabled={busy || allCount === 0}
          onClick={() => setConfirmAllStage(1)}
          onMouseEnter={() => setAllBtnHover(true)}
          onMouseLeave={() => setAllBtnHover(false)}
          title="Generates a PDF of every student's badge"
          style={{
            background:
              allBtnHover && !busy && allCount > 0 ? "#2563eb" : "transparent",
            color:
              allBtnHover && !busy && allCount > 0 ? "#fff" : "var(--text)",
            border:
              allBtnHover && !busy && allCount > 0
                ? "1px solid #2563eb"
                : "1px solid var(--border, rgba(0,0,0,0.25))",
            borderRadius: 6,
            padding: "0.4rem 0.8rem",
            fontWeight: 500,
            fontSize: "0.85rem",
            cursor: busy || allCount === 0 ? "not-allowed" : "pointer",
            opacity: busy || allCount === 0 ? 0.55 : 1,
            transition: "background 0.15s ease, color 0.15s ease, border-color 0.15s ease",
          }}
        >
          {busy ? "Generating…" : `Print all student badges (${allCount})`}
        </button>
      </div>

      {confirmAllStage > 0 && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setConfirmAllStage(0)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "1rem",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface, #fff)",
              color: "var(--text)",
              borderRadius: 10,
              padding: "1.25rem 1.5rem",
              maxWidth: 460,
              width: "100%",
              boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
            }}
          >
            {confirmAllStage === 1 ? (
              <>
                <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>
                  Compile all {allCount} badges?
                </h3>
                <p style={{ marginTop: 0, color: "var(--text-subtle)" }}>
                  Are you sure you want to compile{" "}
                  <strong>{allCount}</strong> badge{allCount === 1 ? "" : "s"}?
                  This process can take a lengthy amount of time and{" "}
                  <strong>cannot be stopped</strong> once it starts.
                </p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
                  <button
                    type="button"
                    onClick={() => setConfirmAllStage(0)}
                    style={{
                      background: "transparent",
                      color: "var(--text)",
                      border: "1px solid var(--border, rgba(0,0,0,0.2))",
                      borderRadius: 6,
                      padding: "0.5rem 1rem",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAllStage(2)}
                    style={{
                      background: "#b45309",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "0.5rem 1rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>
                  Print {allCount} badges?
                </h3>
                <p style={{ marginTop: 0, color: "var(--text-subtle)" }}>
                  Final check — this will generate a single PDF containing all{" "}
                  <strong>{allCount}</strong> student badge
                  {allCount === 1 ? "" : "s"}. Are you sure you want to print{" "}
                  <strong>{allCount}</strong> badge{allCount === 1 ? "" : "s"}?
                </p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
                  <button
                    type="button"
                    onClick={() => setConfirmAllStage(0)}
                    style={{
                      background: "transparent",
                      color: "var(--text)",
                      border: "1px solid var(--border, rgba(0,0,0,0.2))",
                      borderRadius: 6,
                      padding: "0.5rem 1rem",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      setConfirmAllStage(0);
                      void download({ all: true });
                    }}
                    style={{
                      background: "#2563eb",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "0.5rem 1rem",
                      fontWeight: 600,
                      cursor: busy ? "not-allowed" : "pointer",
                      opacity: busy ? 0.7 : 1,
                    }}
                  >
                    Print {allCount} badge{allCount === 1 ? "" : "s"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <details style={{ marginTop: "0.5rem" }} open>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Print by teacher & period
        </summary>
        <div style={{ marginTop: "0.75rem" }}>
          <p style={{ color: "var(--text-subtle)", fontSize: "0.85rem", marginTop: 0 }}>
            Print every badge on a teacher's roster. Choose a period to limit
            it to a single class, or leave it on "All periods" for every
            student that teacher sees. Rosters come from Skyward/RosterOne.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
            <TeacherPicker
              teachers={teachers}
              value={teacherId ? Number(teacherId) : null}
              allowEmpty
              emptyLabel="Select a teacher…"
              showDeptFilter
              ariaLabel="Teacher"
              style={{ flex: "1 1 240px" }}
              selectStyle={{
                width: "100%",
                padding: "0.45rem 0.6rem",
                borderRadius: 6,
                border: "1px solid var(--border, rgba(0,0,0,0.15))",
              }}
              onChange={(id) => {
                setTeacherId(id ? String(id) : "");
                setPeriodSel("");
              }}
            />
            <select
              value={periodSel}
              onChange={(e) => setPeriodSel(e.target.value)}
              disabled={!teacherId || teacherPeriods.length === 0}
              style={{
                padding: "0.45rem 0.6rem",
                borderRadius: 6,
                border: "1px solid var(--border, rgba(0,0,0,0.15))",
                opacity: !teacherId || teacherPeriods.length === 0 ? 0.5 : 1,
              }}
            >
              <option value="">All periods</option>
              {teacherPeriods.map((p) => (
                <option key={p} value={String(p)}>
                  Period {p}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !teacherId || rosterCount === 0}
              onClick={printByTeacher}
              style={{
                background: "#0f766e",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "0.55rem 1rem",
                fontWeight: 600,
                cursor:
                  busy || !teacherId || rosterCount === 0
                    ? "not-allowed"
                    : "pointer",
                opacity: busy || !teacherId || rosterCount === 0 ? 0.6 : 1,
              }}
            >
              {busy
                ? "Generating…"
                : rosterCount !== null && teacherId
                  ? `Print ${rosterCount} badge${rosterCount === 1 ? "" : "s"}`
                  : "Print badges"}
            </button>
          </div>
          {teacherId && (
            <div style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--text-subtle)" }}>
              {rosterLoading
                ? "Loading roster…"
                : rosterCount === null
                  ? ""
                  : rosterCount === 0
                    ? "No students on this roster for the selected period."
                    : `${rosterCount} student${rosterCount === 1 ? "" : "s"} ${
                        periodSel ? `in period ${periodSel}` : "across all periods"
                      }.`}
            </div>
          )}
        </div>
      </details>

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
                      · {r.localSisId ?? "—"}
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
                        <span style={{ opacity: 0.6 }}>{e.localSisId ? `· ${e.localSisId}` : ""}</span>
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
