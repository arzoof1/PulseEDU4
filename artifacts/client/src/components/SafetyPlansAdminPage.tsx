// Safety Plans admin — dedicated page for the school's safety-plan
// caseload. Mirrors MtssPlansAdmin.tsx so the workflow feels identical
// to Tier 2/3 management. Edit gate (canEditSafetyPlan) is the same
// rule the server enforces in routes/safetyPlans.ts: Guidance Counselor
// or Core Team (Admin / Behavior Specialist / MTSS Coordinator /
// PBIS Coordinator / SuperUser).
//
// The page is a thin shell around the existing SafetyPlanEditor modal.
// Creating a plan = pick a student (no active plan) → open editor.
// Editing = click a row → open editor on that student.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import SafetyPlanEditor from "./SafetyPlanEditor";

type StatusFilter = "active" | "inactive" | "all";

interface SafetyPlanItem {
  label: string;
  active: boolean;
  note?: string;
}

interface PlanRow {
  id: number;
  studentId: string;
  studentName: string | null;
  studentGrade: number | null;
  status: string;
  items: SafetyPlanItem[];
  notes: string | null;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
}

interface Student {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
}

interface Props {
  canManage: boolean;
  onBack?: () => void;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

function activeItemCount(items: SafetyPlanItem[] | null | undefined): number {
  if (!Array.isArray(items)) return 0;
  return items.filter((i) => i && i.active !== false).length;
}

export default function SafetyPlansAdminPage({ canManage, onBack }: Props) {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [filter, setFilter] = useState("");

  // Editor target. "new" opens the student picker; a string opens the
  // editor for that studentId.
  const [editingStudentId, setEditingStudentId] = useState<string | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [pickerFilter, setPickerFilter] = useState("");

  const reload = () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ status });
    authFetch(`/api/safety-plans/list?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((body: { plans: PlanRow[] }) => setPlans(body.plans ?? []))
      .catch((e) => setError(e.message ?? "Failed to load plans"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Pre-load students once for the create-plan picker (school-scoped).
  useEffect(() => {
    authFetch("/api/students")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Student[]) => Array.isArray(rows) && setStudents(rows))
      .catch(() => {});
  }, []);

  const visiblePlans = useMemo(() => {
    if (!filter.trim()) return plans;
    const needle = filter.trim().toLowerCase();
    return plans.filter(
      (p) =>
        p.studentId.toLowerCase().includes(needle) ||
        (p.studentName ?? "").toLowerCase().includes(needle),
    );
  }, [plans, filter]);

  // Students who already have an active plan — disabled in the picker
  // when status is "active" so we don't let counselors double-create.
  const activePlanStudentIds = useMemo(
    () => new Set(plans.filter((p) => p.status === "active").map((p) => p.studentId)),
    [plans],
  );

  const visiblePickerStudents = useMemo(() => {
    const sorted = [...students].sort((a, b) => {
      const lc = (a.lastName ?? "").localeCompare(b.lastName ?? "");
      if (lc !== 0) return lc;
      return (a.firstName ?? "").localeCompare(b.firstName ?? "");
    });
    if (!pickerFilter.trim()) return sorted.slice(0, 200);
    const needle = pickerFilter.trim().toLowerCase();
    return sorted
      .filter(
        (s) =>
          s.studentId.toLowerCase().includes(needle) ||
          s.firstName.toLowerCase().includes(needle) ||
          s.lastName.toLowerCase().includes(needle),
      )
      .slice(0, 200);
  }, [students, pickerFilter]);

  const editingStudent = useMemo(() => {
    if (!editingStudentId) return null;
    const stu = students.find((s) => s.studentId === editingStudentId);
    if (stu) {
      return {
        studentId: stu.studentId,
        name: `${stu.firstName} ${stu.lastName}`.trim(),
      };
    }
    const fromPlan = plans.find((p) => p.studentId === editingStudentId);
    if (fromPlan) {
      return {
        studentId: fromPlan.studentId,
        name: fromPlan.studentName ?? fromPlan.studentId,
      };
    }
    return { studentId: editingStudentId, name: editingStudentId };
  }, [editingStudentId, students, plans]);

  return (
    <>
      <div
        style={{
          borderTopLeftRadius: "var(--radius-lg, 8px)",
          borderTopRightRadius: "var(--radius-lg, 8px)",
          overflow: "hidden",
          marginBottom: "-1px",
        }}
      >
        <div
          className="section-header-bar-teal"
          style={{ width: "100%", margin: 0 }}
        />
        <div
          className="section-header-band-hub"
          style={{ width: "100%", margin: 0 }}
        >
          <h2
            style={{
              margin: 0,
              color: "white",
              fontSize: "1.5rem",
              fontWeight: 700,
            }}
          >
            Safety Plans
          </h2>
        </div>
      </div>

      <section className="card no-print">
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              style={{
                background: "#ede9fe",
                color: "#6d28d9",
                border: "1px solid #ddd6fe",
                borderRadius: 999,
                padding: "0.4rem 0.9rem",
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              ← Back
            </button>
          )}
          <label style={{ fontSize: "0.85rem", color: "#475569" }}>
            Status:
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              style={{ marginLeft: "0.5rem" }}
            >
              <option value="active">Active</option>
              <option value="inactive">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          <input
            type="text"
            placeholder="Filter by name or student id…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              flex: "1 1 240px",
              padding: "0.4rem 0.6rem",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
            }}
          />
          {canManage && (
            <button
              type="button"
              onClick={() => {
                setPickerFilter("");
                setPicking(true);
              }}
              style={{
                background: "#dc2626",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "0.5rem 1rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + New Safety Plan
            </button>
          )}
        </div>

        {error && (
          <div
            style={{
              background: "#fef2f2",
              color: "#991b1b",
              padding: "0.75rem 1rem",
              borderRadius: 6,
              marginBottom: "1rem",
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ color: "#64748b" }}>Loading safety plans…</div>
        ) : visiblePlans.length === 0 ? (
          <div
            style={{
              padding: "1.5rem",
              border: "1px dashed #cbd5e1",
              borderRadius: 8,
              color: "#64748b",
              textAlign: "center",
            }}
          >
            {plans.length === 0
              ? "No safety plans yet. Click \u201c+ New Safety Plan\u201d to create one."
              : "No plans match the current filter."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr style={{ background: "#f1f5f9", textAlign: "left" }}>
                  <th style={{ padding: "0.5rem" }}>Student</th>
                  <th style={{ padding: "0.5rem" }}>Active items</th>
                  <th style={{ padding: "0.5rem" }}>Effective</th>
                  <th style={{ padding: "0.5rem" }}>Last updated</th>
                  <th style={{ padding: "0.5rem" }}>Status</th>
                  <th style={{ padding: "0.5rem", width: 1 }}></th>
                </tr>
              </thead>
              <tbody>
                {visiblePlans.map((p) => (
                  <tr
                    key={p.id}
                    style={{ borderBottom: "1px solid #e2e8f0" }}
                  >
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 600 }}>
                        {p.studentName ?? "(unknown)"}
                      </div>
                      <div
                        style={{ color: "#64748b", fontSize: "0.78rem" }}
                      >
                        ID {p.studentId}
                        {p.studentGrade != null
                          ? ` • Gr ${p.studentGrade}`
                          : ""}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {activeItemCount(p.items)}
                    </td>
                    <td
                      style={{ padding: "0.5rem", whiteSpace: "nowrap" }}
                    >
                      {p.startDate || p.endDate
                        ? `${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}`
                        : "—"}
                    </td>
                    <td
                      style={{ padding: "0.5rem", whiteSpace: "nowrap" }}
                    >
                      <div>{fmtDate(p.updatedAt)}</div>
                      {p.updatedByName && (
                        <div
                          style={{
                            color: "#64748b",
                            fontSize: "0.78rem",
                          }}
                        >
                          by {p.updatedByName}
                        </div>
                      )}
                    </td>
                    <td
                      style={{ padding: "0.5rem", whiteSpace: "nowrap" }}
                    >
                      {p.status === "active" ? (
                        <span
                          style={{
                            background: "#fee2e2",
                            color: "#991b1b",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: "0.78rem",
                            fontWeight: 700,
                            letterSpacing: 0.4,
                          }}
                        >
                          ACTIVE
                        </span>
                      ) : (
                        <span
                          style={{
                            background: "#e2e8f0",
                            color: "#475569",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: "0.78rem",
                          }}
                        >
                          Archived
                        </span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem",
                        whiteSpace: "nowrap",
                        textAlign: "right",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setEditingStudentId(p.studentId)}
                        style={{
                          background: "#f1f5f9",
                          border: "1px solid #cbd5e1",
                          borderRadius: 4,
                          padding: "2px 10px",
                          fontSize: "0.78rem",
                          cursor: "pointer",
                          fontWeight: 600,
                        }}
                      >
                        {canManage ? "Edit" : "View"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {picking && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => setPicking(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: 10,
              padding: "1.25rem 1.25rem 1rem",
              width: "min(540px, 92vw)",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 14px 30px rgba(0,0,0,0.18)",
            }}
          >
            <h3 style={{ margin: 0, marginBottom: "0.75rem" }}>
              Pick a student
            </h3>
            <input
              type="text"
              autoFocus
              placeholder="Search by name or ID…"
              value={pickerFilter}
              onChange={(e) => setPickerFilter(e.target.value)}
              style={{
                padding: "0.45rem 0.65rem",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                marginBottom: "0.5rem",
              }}
            />
            <div
              style={{
                overflowY: "auto",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                flex: 1,
              }}
            >
              {visiblePickerStudents.length === 0 ? (
                <div
                  style={{
                    padding: "1rem",
                    color: "#64748b",
                    textAlign: "center",
                  }}
                >
                  No students match.
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                  }}
                >
                  {visiblePickerStudents.map((s) => {
                    const hasActive = activePlanStudentIds.has(s.studentId);
                    return (
                      <li key={s.studentId}>
                        <button
                          type="button"
                          disabled={hasActive}
                          onClick={() => {
                            setPicking(false);
                            setEditingStudentId(s.studentId);
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "0.5rem 0.75rem",
                            background: hasActive ? "#f8fafc" : "white",
                            border: "none",
                            borderBottom: "1px solid #f1f5f9",
                            cursor: hasActive ? "not-allowed" : "pointer",
                            color: hasActive ? "#94a3b8" : "#0f172a",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                          }}
                          title={
                            hasActive
                              ? "Already has an active safety plan — open it from the list"
                              : `Create safety plan for ${s.firstName} ${s.lastName}`
                          }
                        >
                          <span>
                            <strong>
                              {s.lastName}, {s.firstName}
                            </strong>
                            <span
                              style={{
                                color: "#64748b",
                                marginLeft: 8,
                                fontSize: "0.78rem",
                              }}
                            >
                              Gr {s.grade} · ID {s.studentId}
                            </span>
                          </span>
                          {hasActive && (
                            <span
                              style={{
                                fontSize: "0.7rem",
                                background: "#fee2e2",
                                color: "#991b1b",
                                padding: "1px 6px",
                                borderRadius: 999,
                                fontWeight: 700,
                              }}
                            >
                              has SP
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: "0.75rem",
              }}
            >
              <button
                type="button"
                onClick={() => setPicking(false)}
                style={{
                  background: "transparent",
                  border: "1px solid #cbd5e1",
                  padding: "0.4rem 0.9rem",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {editingStudentId && editingStudent && (
        <SafetyPlanEditor
          studentId={editingStudent.studentId}
          studentName={editingStudent.name}
          onClose={() => setEditingStudentId(null)}
          onSaved={() => {
            setEditingStudentId(null);
            reload();
          }}
        />
      )}
    </>
  );
}
