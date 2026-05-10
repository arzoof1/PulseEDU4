// Trusted Adults Admin — manage which staff members count as a
// student's "trusted adult" for the Insights visibility model. A
// trusted-adult assignment widens the staff member's roster scope so
// the Insights watchlist + profile pages will surface that student
// even when there's no class roster connection.
//
// Permission mirrors the server's requireCoreTeam in
// routes/trustedAdultLinks.ts. canManage is computed in App.tsx and
// must be true for the parent component to mount this screen.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

interface Link {
  id: number;
  studentId: string;
  staffId: number;
  studentFirstName: string | null;
  studentLastName: string | null;
  studentGrade: number | null;
  staffName: string | null;
  staffEmail: string | null;
  assignedByName: string | null;
  assignedAt: string;
  notes: string | null;
}

interface Student {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
}

interface Staff {
  id: number;
  displayName: string;
  email: string | null;
}

interface Props {
  canManage: boolean;
}

export default function TrustedAdultsAdmin({ canManage }: Props) {
  const [links, setLinks] = useState<Link[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [studentQuery, setStudentQuery] = useState("");
  const [staffQuery, setStaffQuery] = useState("");
  const [pickedStudent, setPickedStudent] = useState<string>("");
  const [pickedStaff, setPickedStaff] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function reload() {
    setLoading(true);
    setError("");
    authFetch("/api/trusted-adult-links")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Link[]) => setLinks(data))
      .catch((e) => setError(e.message ?? "Failed to load links"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!canManage) return;
    reload();
    // Pre-load the student + staff pickers in parallel. Both endpoints
    // are school-scoped server-side, so we don't need to filter here.
    authFetch("/api/students")
      .then((r) => r.json())
      .then((rows: Student[]) => setStudents(rows))
      .catch(() => undefined);
    authFetch("/api/trusted-adult-links/staff-directory")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Staff[]) => setStaff(rows))
      .catch(() => undefined);
  }, [canManage]);

  // Searchable list — narrow by typed query, cap to a few results so
  // the dropdown stays usable on long rosters.
  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return students.slice(0, 10);
    return students
      .filter((s) =>
        `${s.lastName}, ${s.firstName} ${s.studentId}`
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 20);
  }, [students, studentQuery]);

  const filteredStaff = useMemo(() => {
    const q = staffQuery.trim().toLowerCase();
    if (!q) return staff.slice(0, 10);
    return staff
      .filter((s) =>
        `${s.displayName} ${s.email ?? ""}`.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [staff, staffQuery]);

  const filteredLinks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) => {
      const sName = `${l.studentLastName ?? ""} ${l.studentFirstName ?? ""}`.toLowerCase();
      const tName = (l.staffName ?? "").toLowerCase();
      return (
        sName.includes(q) ||
        tName.includes(q) ||
        l.studentId.toLowerCase().includes(q)
      );
    });
  }, [links, filter]);

  async function assign() {
    if (!pickedStudent) {
      setError("Pick a student");
      return;
    }
    if (pickedStaff == null) {
      setError("Pick a staff member");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const r = await authFetch("/api/trusted-adult-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: pickedStudent,
          staffId: pickedStaff,
          notes: notes.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      // Reset picker, reload list.
      setPickedStudent("");
      setPickedStaff(null);
      setStudentQuery("");
      setStaffQuery("");
      setNotes("");
      reload();
    } catch (e) {
      setError((e as Error).message ?? "Failed to assign");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Remove this trusted-adult assignment?")) return;
    try {
      const r = await authFetch(`/api/trusted-adult-links/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      reload();
    } catch (e) {
      setError((e as Error).message ?? "Failed to remove");
    }
  }

  if (!canManage) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Trusted Adults</h2>
        <p style={{ color: "var(--text-subtle)" }}>
          Only Admin, Behavior Specialist, MTSS Coordinator, and PBIS
          Coordinator roles can manage trusted-adult assignments.
        </p>
      </div>
    );
  }

  const pickedStudentLabel = pickedStudent
    ? (() => {
        const s = students.find((x) => x.studentId === pickedStudent);
        return s ? `${s.lastName}, ${s.firstName} (Gr ${s.grade})` : pickedStudent;
      })()
    : "";
  const pickedStaffLabel =
    pickedStaff != null
      ? staff.find((s) => s.id === pickedStaff)?.displayName ?? `#${pickedStaff}`
      : "";

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Trusted Adults</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Link a student to a staff member as their "trusted adult." That
        staff member will be able to see the student in their Insights
        Watchlist and open their profile, regardless of class roster
        membership. Helpful for counselors, deans, mentors, and coaches
        who don't appear on a teacher schedule.
      </p>
      <HowToUseHelp title="How to assign Trusted Adults">
        <HowToSection title="Why it matters">
          A trusted-adult link is the bypass that lets a non-roster
          staff member see a student's full profile and intervention
          history. It's also the gate for the "check in with my
          adult" workflow students can use to self-regulate.
        </HowToSection>
        <RoleSection for={["mtssCoordinator", "behaviorSpecialist", "admin", "pbisCoordinator"]} title="Best practice">
          One adult per student is plenty. A second adult only helps
          if the first is regularly absent. Inactivate an old link
          rather than delete — keeps the audit trail intact.
        </RoleSection>
      </HowToUseHelp>

      {error && (
        <div
          style={{
            background: "#fee2e2",
            color: "#991b1b",
            padding: "0.5rem 0.75rem",
            borderRadius: "6px",
            marginBottom: "0.75rem",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.75rem",
          marginBottom: "0.75rem",
        }}
      >
        <div>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
            Student
          </label>
          {pickedStudent ? (
            <div
              style={{
                padding: "0.4rem 0.6rem",
                background: "#ecfdf5",
                border: "1px solid #a7f3d0",
                borderRadius: 6,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{pickedStudentLabel}</span>
              <button
                type="button"
                onClick={() => {
                  setPickedStudent("");
                  setStudentQuery("");
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#065f46",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={studentQuery}
                onChange={(e) => setStudentQuery(e.target.value)}
                placeholder="Search by name or student ID"
                style={{ width: "100%", padding: "0.4rem 0.5rem" }}
              />
              {studentQuery && (
                <div
                  style={{
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    marginTop: 4,
                    maxHeight: 180,
                    overflowY: "auto",
                  }}
                >
                  {filteredStudents.length === 0 ? (
                    <div style={{ padding: "0.4rem", color: "var(--text-subtle)" }}>
                      No matches
                    </div>
                  ) : (
                    filteredStudents.map((s) => (
                      <button
                        key={s.studentId}
                        type="button"
                        onClick={() => {
                          setPickedStudent(s.studentId);
                          setStudentQuery("");
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "0.4rem 0.6rem",
                          background: "white",
                          border: "none",
                          borderBottom: "1px solid #f3f4f6",
                          cursor: "pointer",
                        }}
                      >
                        {s.lastName}, {s.firstName} — Gr {s.grade} ({s.studentId})
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
            Trusted Adult (staff)
          </label>
          {pickedStaff != null ? (
            <div
              style={{
                padding: "0.4rem 0.6rem",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 6,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{pickedStaffLabel}</span>
              <button
                type="button"
                onClick={() => {
                  setPickedStaff(null);
                  setStaffQuery("");
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#1e40af",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={staffQuery}
                onChange={(e) => setStaffQuery(e.target.value)}
                placeholder="Search by name or email"
                style={{ width: "100%", padding: "0.4rem 0.5rem" }}
              />
              {staffQuery && (
                <div
                  style={{
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    marginTop: 4,
                    maxHeight: 180,
                    overflowY: "auto",
                  }}
                >
                  {filteredStaff.length === 0 ? (
                    <div style={{ padding: "0.4rem", color: "var(--text-subtle)" }}>
                      No matches
                    </div>
                  ) : (
                    filteredStaff.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setPickedStaff(s.id);
                          setStaffQuery("");
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "0.4rem 0.6rem",
                          background: "white",
                          border: "none",
                          borderBottom: "1px solid #f3f4f6",
                          cursor: "pointer",
                        }}
                      >
                        {s.displayName}
                        {s.email && (
                          <span style={{ color: "#6b7280", marginLeft: 6 }}>
                            ({s.email})
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div style={{ marginBottom: "0.75rem" }}>
        <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
          Notes (optional)
        </label>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder='e.g., "Mentor since BOY 24-25" — stays visible on the assignment row'
          maxLength={500}
          style={{ width: "100%", padding: "0.4rem 0.5rem" }}
        />
      </div>

      <button
        type="button"
        onClick={assign}
        disabled={saving || !pickedStudent || pickedStaff == null}
        style={{
          background: "#0d9488",
          color: "white",
          border: "none",
          padding: "0.5rem 1rem",
          borderRadius: 6,
          fontWeight: 600,
          cursor:
            saving || !pickedStudent || pickedStaff == null
              ? "not-allowed"
              : "pointer",
          opacity: saving || !pickedStudent || pickedStaff == null ? 0.5 : 1,
        }}
      >
        {saving ? "Saving…" : "Assign Trusted Adult"}
      </button>

      <hr style={{ margin: "1.5rem 0", border: "none", borderTop: "1px solid #e5e7eb" }} />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <h3 style={{ margin: 0 }}>
          Current Assignments {links.length > 0 && `(${links.length})`}
        </h3>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by student or staff name"
          style={{ padding: "0.3rem 0.5rem", width: 280 }}
        />
      </div>

      {loading ? (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      ) : filteredLinks.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          {links.length === 0
            ? "No trusted-adult assignments yet."
            : "No assignments match that filter."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ textAlign: "left", padding: "0.5rem", fontSize: "0.85rem" }}>Student</th>
                <th style={{ textAlign: "left", padding: "0.5rem", fontSize: "0.85rem" }}>Trusted Adult</th>
                <th style={{ textAlign: "left", padding: "0.5rem", fontSize: "0.85rem" }}>Notes</th>
                <th style={{ textAlign: "left", padding: "0.5rem", fontSize: "0.85rem" }}>Assigned</th>
                <th style={{ width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {filteredLinks.map((l) => (
                <tr key={l.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.5rem" }}>
                    {l.studentLastName ?? "?"}, {l.studentFirstName ?? "?"}
                    {l.studentGrade != null && (
                      <span style={{ color: "#6b7280", marginLeft: 6 }}>
                        Gr {l.studentGrade}
                      </span>
                    )}
                    <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                      {l.studentId}
                    </div>
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    {l.staffName ?? `Staff #${l.staffId}`}
                    {l.staffEmail && (
                      <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                        {l.staffEmail}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem", color: "#6b7280", fontSize: "0.85rem" }}>
                    {l.notes ?? "—"}
                  </td>
                  <td style={{ padding: "0.5rem", color: "#6b7280", fontSize: "0.85rem" }}>
                    {new Date(l.assignedAt).toLocaleDateString()}
                    {l.assignedByName && (
                      <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                        by {l.assignedByName}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => remove(l.id)}
                      style={{
                        background: "transparent",
                        color: "#b91c1c",
                        border: "1px solid #fecaca",
                        padding: "0.2rem 0.5rem",
                        borderRadius: 4,
                        fontSize: "0.8rem",
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
