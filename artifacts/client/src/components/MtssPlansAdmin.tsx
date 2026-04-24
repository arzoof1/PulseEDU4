// MTSS Plans admin — manages student-level intervention plans for the
// "core team" (admin / Behavior Specialist / MTSS Coordinator / PBIS
// Coordinator / SuperUser). v1: plan creation, editing, close/reopen,
// delete. v2 will add per-staff tracking against the point range.
//
// The list/edit screens both honor the active-school silo because the
// API is school-scoped. canManage is computed in App.tsx and mirrors
// the server's requireCoreTeam gate in routes/mtssPlans.ts.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type StatusFilter = "active" | "closed" | "all";

interface Plan {
  id: number;
  schoolId: number;
  studentId: string;
  studentName: string | null;
  studentGrade: number | null;
  title: string;
  goals: string;
  tier: number;
  pointRangeMin: number | null;
  pointRangeMax: number | null;
  notes: string;
  openedAt: string;
  openedByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
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

const TIER_COLORS: Record<number, string> = {
  1: "#0d9488", // teal
  2: "#d97706", // amber
  3: "#b91c1c", // red
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

export default function MtssPlansAdmin({ canManage, onBack }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [studentFilter, setStudentFilter] = useState("");
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const [students, setStudents] = useState<Student[]>([]);

  const reload = () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ status });
    authFetch(`/api/mtss-plans?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((rows: Plan[]) => setPlans(rows))
      .catch((e) => setError(e.message ?? "Failed to load plans"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Pre-load students once for the create-plan picker. The /api/students
  // endpoint is school-scoped, so this returns just the active school's
  // roster.
  useEffect(() => {
    authFetch("/api/students")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Student[]) => Array.isArray(rows) && setStudents(rows))
      .catch(() => {});
  }, []);

  const visiblePlans = useMemo(() => {
    if (!studentFilter.trim()) return plans;
    const needle = studentFilter.trim().toLowerCase();
    return plans.filter((p) => {
      const name = (p.studentName ?? "").toLowerCase();
      return (
        p.studentId.toLowerCase().includes(needle) ||
        name.includes(needle) ||
        p.title.toLowerCase().includes(needle)
      );
    });
  }, [plans, studentFilter]);

  const closePlan = async (plan: Plan) => {
    if (!canManage) return;
    if (!window.confirm(`Close plan "${plan.title}"? You can reopen later.`)) return;
    const r = await authFetch(`/api/mtss-plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closed: true }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to close plan");
      return;
    }
    reload();
  };

  const reopenPlan = async (plan: Plan) => {
    if (!canManage) return;
    const r = await authFetch(`/api/mtss-plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closed: false }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to reopen plan");
      return;
    }
    reload();
  };

  const deletePlan = async (plan: Plan) => {
    if (!canManage) return;
    if (
      !window.confirm(
        `Permanently delete plan "${plan.title}" for ${plan.studentName ?? plan.studentId}? This cannot be undone.`,
      )
    )
      return;
    const r = await authFetch(`/api/mtss-plans/${plan.id}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to delete plan");
      return;
    }
    reload();
  };

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
            MTSS Plans
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
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          </label>
          <input
            type="text"
            placeholder="Filter by name, student id, or title…"
            value={studentFilter}
            onChange={(e) => setStudentFilter(e.target.value)}
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
              onClick={() => setEditing("new")}
              style={{
                background: "#0d9488",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "0.5rem 1rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + New Plan
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
          <div style={{ color: "#64748b" }}>Loading plans…</div>
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
              ? "No MTSS plans yet. Click \u201c+ New Plan\u201d to create one."
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
                  <th style={{ padding: "0.5rem" }}>Tier</th>
                  <th style={{ padding: "0.5rem" }}>Title</th>
                  <th style={{ padding: "0.5rem" }}>Goals</th>
                  <th style={{ padding: "0.5rem" }}>Point Range</th>
                  <th style={{ padding: "0.5rem" }}>Opened</th>
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
                      <div style={{ color: "#64748b", fontSize: "0.78rem" }}>
                        ID {p.studentId}
                        {p.studentGrade != null
                          ? ` • Gr ${p.studentGrade}`
                          : ""}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      <span
                        style={{
                          background: TIER_COLORS[p.tier] ?? "#475569",
                          color: "white",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: "0.78rem",
                          fontWeight: 600,
                        }}
                      >
                        T{p.tier}
                      </span>
                    </td>
                    <td style={{ padding: "0.5rem" }}>{p.title}</td>
                    <td
                      style={{
                        padding: "0.5rem",
                        maxWidth: 320,
                        color: "#475569",
                      }}
                    >
                      <div
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                        }}
                      >
                        {p.goals || <em>—</em>}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {p.pointRangeMin != null || p.pointRangeMax != null
                        ? `${p.pointRangeMin ?? "—"} – ${p.pointRangeMax ?? "—"}`
                        : "—"}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      <div>{fmtDate(p.openedAt)}</div>
                      {p.openedByName && (
                        <div
                          style={{ color: "#64748b", fontSize: "0.78rem" }}
                        >
                          by {p.openedByName}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {p.closedAt ? (
                        <span
                          style={{
                            background: "#e2e8f0",
                            color: "#475569",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: "0.78rem",
                          }}
                        >
                          Closed {fmtDate(p.closedAt)}
                        </span>
                      ) : (
                        <span
                          style={{
                            background: "#dcfce7",
                            color: "#166534",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: "0.78rem",
                            fontWeight: 600,
                          }}
                        >
                          Active
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
                      {canManage && (
                        <div
                          style={{
                            display: "inline-flex",
                            gap: 6,
                            flexWrap: "wrap",
                            justifyContent: "flex-end",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setEditing(p)}
                            style={{
                              background: "#f1f5f9",
                              border: "1px solid #cbd5e1",
                              borderRadius: 4,
                              padding: "2px 8px",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                          >
                            Edit
                          </button>
                          {p.closedAt ? (
                            <button
                              type="button"
                              onClick={() => reopenPlan(p)}
                              style={{
                                background: "#dbeafe",
                                color: "#1e40af",
                                border: "1px solid #bfdbfe",
                                borderRadius: 4,
                                padding: "2px 8px",
                                fontSize: "0.78rem",
                                cursor: "pointer",
                              }}
                            >
                              Reopen
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => closePlan(p)}
                              style={{
                                background: "#fef3c7",
                                color: "#92400e",
                                border: "1px solid #fde68a",
                                borderRadius: 4,
                                padding: "2px 8px",
                                fontSize: "0.78rem",
                                cursor: "pointer",
                              }}
                            >
                              Close
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => deletePlan(p)}
                            style={{
                              background: "#fee2e2",
                              color: "#991b1b",
                              border: "1px solid #fecaca",
                              borderRadius: 4,
                              padding: "2px 8px",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing !== null && (
        <PlanModal
          plan={editing === "new" ? null : editing}
          students={students}
          existingActivePlanStudentIds={new Set(
            plans.filter((p) => !p.closedAt).map((p) => p.studentId),
          )}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

interface PlanModalProps {
  plan: Plan | null;
  students: Student[];
  existingActivePlanStudentIds: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}

function PlanModal({
  plan,
  students,
  existingActivePlanStudentIds,
  onClose,
  onSaved,
}: PlanModalProps) {
  const isEdit = plan !== null;
  const [studentId, setStudentId] = useState(plan?.studentId ?? "");
  const [title, setTitle] = useState(plan?.title ?? "");
  const [goals, setGoals] = useState(plan?.goals ?? "");
  const [tier, setTier] = useState<number>(plan?.tier ?? 2);
  const [pointMin, setPointMin] = useState<string>(
    plan?.pointRangeMin == null ? "" : String(plan.pointRangeMin),
  );
  const [pointMax, setPointMax] = useState<string>(
    plan?.pointRangeMax == null ? "" : String(plan.pointRangeMax),
  );
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const studentLabel = (s: Student) =>
    `${s.firstName} ${s.lastName} — ID ${s.studentId} (Gr ${s.grade})`;

  // For the new-plan picker, surface a hint if the student already has
  // an active plan. We don't block — multiple plans per student are
  // allowed (e.g. behavior + attendance).
  const dupHint =
    !isEdit &&
    studentId.trim() &&
    existingActivePlanStudentIds.has(studentId.trim())
      ? "This student already has an active plan. Creating a second plan is allowed."
      : "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!studentId.trim()) {
      setError("Pick a student");
      return;
    }
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    const minN = pointMin.trim() === "" ? null : Number(pointMin);
    const maxN = pointMax.trim() === "" ? null : Number(pointMax);
    if (minN !== null && (!Number.isFinite(minN) || !Number.isInteger(minN))) {
      setError("Point range min must be a whole number");
      return;
    }
    if (maxN !== null && (!Number.isFinite(maxN) || !Number.isInteger(maxN))) {
      setError("Point range max must be a whole number");
      return;
    }
    if (minN !== null && maxN !== null && minN > maxN) {
      setError("Point range min cannot exceed max");
      return;
    }
    setBusy(true);
    try {
      const url = isEdit ? `/api/mtss-plans/${plan!.id}` : "/api/mtss-plans";
      const method = isEdit ? "PATCH" : "POST";
      const body: Record<string, unknown> = {
        title: title.trim(),
        goals: goals.trim(),
        tier,
        pointRangeMin: minN,
        pointRangeMax: maxN,
        notes: notes.trim(),
      };
      if (!isEdit) body.studentId = studentId.trim();
      const r = await authFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const respBody = await r.json().catch(() => ({}));
        throw new Error(respBody.error ?? `HTTP ${r.status}`);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message ?? "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 8,
          padding: "1.25rem 1.5rem",
          maxWidth: 560,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <h3 style={{ marginTop: 0 }}>
          {isEdit ? "Edit MTSS Plan" : "New MTSS Plan"}
        </h3>

        {!isEdit ? (
          <div style={{ marginBottom: "0.75rem" }}>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Student
            </label>
            <input
              list="mtss-plan-students"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              placeholder="Type a name or ID…"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
              required
            />
            <datalist id="mtss-plan-students">
              {students.map((s) => (
                <option key={s.studentId} value={s.studentId}>
                  {studentLabel(s)}
                </option>
              ))}
            </datalist>
            {dupHint && (
              <div
                style={{
                  fontSize: "0.78rem",
                  color: "#92400e",
                  marginTop: 4,
                }}
              >
                {dupHint}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: "0.75rem", color: "#475569" }}>
            <strong>Student:</strong>{" "}
            {plan!.studentName ?? "(unknown)"} — ID {plan!.studentId}
          </div>
        )}

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Tier 2 Behavior Support"
            maxLength={200}
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
            }}
            required
          />
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Tier
          </label>
          <select
            value={tier}
            onChange={(e) => setTier(Number(e.target.value))}
            style={{
              padding: "0.4rem 0.6rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
            }}
          >
            <option value={1}>Tier 1 — monitoring</option>
            <option value={2}>Tier 2 — small-group</option>
            <option value={3}>Tier 3 — intensive</option>
          </select>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Goals
          </label>
          <textarea
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            rows={4}
            maxLength={4000}
            placeholder="What does success look like for this student?"
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontFamily: "inherit",
            }}
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.75rem",
            marginBottom: "0.75rem",
          }}
        >
          <div>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Point Range Min
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={pointMin}
              onChange={(e) => setPointMin(e.target.value)}
              placeholder="optional"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
            />
          </div>
          <div>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
            >
              Point Range Max
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={pointMax}
              onChange={(e) => setPointMax(e.target.value)}
              placeholder="optional"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
            />
          </div>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
          >
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Anything else the team should know."
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontFamily: "inherit",
            }}
          />
        </div>

        {error && (
          <div
            style={{
              background: "#fef2f2",
              color: "#991b1b",
              padding: "0.5rem 0.75rem",
              borderRadius: 6,
              marginBottom: "0.75rem",
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              background: "#ede9fe",
              color: "#6d28d9",
              border: "1px solid #ddd6fe",
              borderRadius: 6,
              padding: "0.5rem 1rem",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            style={{
              background: "#0d9488",
              color: "white",
              border: "none",
              borderRadius: 6,
              padding: "0.5rem 1.25rem",
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : "Create plan"}
          </button>
        </div>
      </form>
    </div>
  );
}
