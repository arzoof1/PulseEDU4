// Behavior Supports admin — the MTSS team's editor for teacher-facing
// behavior snapshots. Each student gets ONE current snapshot (versioned
// history behind it); when Active, teachers see a purple Behavior pill +
// hover card on the Teacher Roster.
//
// This is a "teacher translation layer": the form only has fields for
// sanitized classroom guidance, so confidential material (diagnoses,
// FBAs, evals, counseling notes) has nowhere to live here by design.
//
// Edit gate mirrors the server (routes/behaviorSupports.ts): Core Team
// (Admin/AP/Principal, MTSS Coordinator, School Psychologist, Behavior
// Specialist, SuperUser, assignable Core Team). Guidance Counselors get
// view-only. Teachers never see this page — their read-only view is the
// roster hover card.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { fetchAllStudents } from "../lib/students";
import StudentPhoto from "./StudentPhoto";

interface RecordRow {
  id: number;
  studentId: string;
  isActive: boolean;
  effectiveDate: string | null;
  reviewDate: string | null;
  behaviors: string[];
  triggers: string[];
  responses: string[];
  replacementBehaviors: string[];
  reinforcement: string[];
  updatedByName: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  firstName?: string;
  lastName?: string;
  grade?: number | string | null;
  localSisId?: string | null;
}

interface Student {
  studentId: string;
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  photoObjectKey?: string | null;
  photoConsent?: boolean | null;
}

interface Props {
  canManage: boolean;
  onBack?: () => void;
}

const MAX_TOTAL_BULLETS = 15;

// The five snapshot lists, in display order. Placeholders serve as gentle
// examples of the expected tone (short, observable, actionable).
const LIST_DEFS: Array<{
  key:
    | "behaviors"
    | "triggers"
    | "responses"
    | "replacementBehaviors"
    | "reinforcement";
  title: string;
  hint: string;
}> = [
  {
    key: "behaviors",
    title: "Behaviors Teachers May Observe",
    hint: "e.g. Refuses work when overwhelmed; Calls out during instruction",
  },
  {
    key: "triggers",
    title: "Common Triggers",
    hint: "e.g. Unexpected schedule changes; Extended wait time",
  },
  {
    key: "responses",
    title: "Recommended Teacher Responses",
    hint: "e.g. Redirect privately; Give a two-minute transition warning",
  },
  {
    key: "replacementBehaviors",
    title: "Replacement Behaviors to Reinforce",
    hint: "e.g. Ask for a break appropriately; Raise hand before speaking",
  },
  {
    key: "reinforcement",
    title: "Positive Reinforcement",
    hint: "e.g. Specific verbal praise; Positive phone call home",
  },
];

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  try {
    // Date-only strings render in local terms without TZ shifting.
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return new Date(`${v}T00:00:00`).toLocaleDateString();
    }
    return new Date(v).toLocaleDateString();
  } catch {
    return "—";
  }
}

type Lists = {
  behaviors: string[];
  triggers: string[];
  responses: string[];
  replacementBehaviors: string[];
  reinforcement: string[];
};

const EMPTY_LISTS: Lists = {
  behaviors: [],
  triggers: [],
  responses: [],
  replacementBehaviors: [],
  reinforcement: [],
};

export default function BehaviorSupportsPage({ canManage, onBack }: Props) {
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  // Editor state
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [picking, setPicking] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [pickerFilter, setPickerFilter] = useState("");
  const [history, setHistory] = useState<RecordRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Form fields
  const [isActive, setIsActive] = useState(true);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const [lists, setLists] = useState<Lists>(EMPTY_LISTS);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [lastMeta, setLastMeta] = useState<{
    updatedByName: string | null;
    updatedAt: string;
  } | null>(null);

  const totalBullets =
    lists.behaviors.length +
    lists.triggers.length +
    lists.responses.length +
    lists.replacementBehaviors.length +
    lists.reinforcement.length;

  const reload = () => {
    setLoading(true);
    setError("");
    authFetch("/api/behavior-supports")
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((body: { records: RecordRow[] }) =>
        setRecords(body.records ?? []),
      )
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GET /api/students returns a PAGE ({ items, nextCursor }), not a bare
  // array. This used to call it directly and guard with Array.isArray, so the
  // envelope failed the check and was dropped on the floor — `students` stayed
  // empty forever and the "Choose a student" picker looked like its search box
  // was broken. fetchAllStudents unwraps the envelope AND follows the cursor,
  // which also fixes the second half: a single page would only have returned
  // the first slice of a large school's roster.
  const [studentsError, setStudentsError] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetchAllStudents<Student>()
      .then((rows) => {
        if (!cancelled) setStudents(rows);
      })
      .catch(() => {
        // Silent failure here is what made this hard to spot. Say so instead.
        if (!cancelled) setStudentsError("Could not load the student list.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    if (!filter.trim()) return records;
    const needle = filter.trim().toLowerCase();
    return records.filter(
      (r) =>
        `${r.firstName ?? ""} ${r.lastName ?? ""}`.toLowerCase().includes(needle) ||
        (r.localSisId ?? "").toLowerCase().includes(needle),
    );
  }, [records, filter]);

  const currentIds = useMemo(
    () => new Set(records.map((r) => r.studentId)),
    [records],
  );

  const pickerStudents = useMemo(() => {
    const needle = pickerFilter.trim().toLowerCase();
    const base = needle
      ? students.filter(
          (s) =>
            `${s.firstName} ${s.lastName}`.toLowerCase().includes(needle) ||
            (s.localSisId ?? "").toLowerCase().includes(needle),
        )
      : students;
    return base.slice(0, 30);
  }, [students, pickerFilter]);

  const openEditor = async (student: Student) => {
    setEditingStudent(student);
    setPicking(false);
    setShowHistory(false);
    setFormError("");
    setDrafts({});
    // Load current + history for this student.
    try {
      const r = await authFetch(
        `/api/behavior-supports/student/${encodeURIComponent(student.studentId)}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as {
        current: RecordRow | null;
        history: RecordRow[];
      };
      setHistory(body.history ?? []);
      if (body.current) {
        setIsActive(body.current.isActive);
        setEffectiveDate(body.current.effectiveDate ?? "");
        setReviewDate(body.current.reviewDate ?? "");
        setLists({
          behaviors: body.current.behaviors ?? [],
          triggers: body.current.triggers ?? [],
          responses: body.current.responses ?? [],
          replacementBehaviors: body.current.replacementBehaviors ?? [],
          reinforcement: body.current.reinforcement ?? [],
        });
        setLastMeta({
          updatedByName: body.current.updatedByName,
          updatedAt: body.current.updatedAt,
        });
      } else {
        setIsActive(true);
        setEffectiveDate(new Date().toISOString().slice(0, 10));
        setReviewDate("");
        setLists(EMPTY_LISTS);
        setLastMeta(null);
      }
    } catch {
      setFormError("Could not load this student's record — try again.");
    }
  };

  const openFromRow = (r: RecordRow) => {
    openEditor({
      studentId: r.studentId,
      localSisId: r.localSisId,
      firstName: r.firstName ?? "",
      lastName: r.lastName ?? "",
      grade: typeof r.grade === "number" ? r.grade : 0,
    });
  };

  const addBullet = (key: keyof Lists) => {
    const draft = (drafts[key] ?? "").trim();
    if (!draft) return;
    if (totalBullets >= MAX_TOTAL_BULLETS) return;
    setLists((prev) => ({ ...prev, [key]: [...prev[key], draft] }));
    setDrafts((prev) => ({ ...prev, [key]: "" }));
  };

  const removeBullet = (key: keyof Lists, idx: number) => {
    setLists((prev) => ({
      ...prev,
      [key]: prev[key].filter((_, i) => i !== idx),
    }));
  };

  const save = async () => {
    if (!editingStudent) return;
    setSaving(true);
    setFormError("");
    try {
      const r = await authFetch(
        `/api/behavior-supports/student/${encodeURIComponent(editingStudent.studentId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            isActive,
            effectiveDate: effectiveDate || null,
            reviewDate: reviewDate || null,
            ...lists,
          }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setEditingStudent(null);
      reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!editingStudent) return;
    setSaving(true);
    setFormError("");
    try {
      const r = await authFetch(
        `/api/behavior-supports/student/${encodeURIComponent(editingStudent.studentId)}/archive`,
        { method: "POST" },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setEditingStudent(null);
      reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setSaving(false);
    }
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div
        className="card no-print"
        style={{
          background: "var(--brand-header-bg)",
          color: "white",
          padding: "1.25rem 1.5rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0, color: "white" }}>Behavior Supports</h2>
            <div style={{ opacity: 0.9, fontSize: "0.9rem", marginTop: 4 }}>
              Teacher-facing classroom strategies for students with active
              behavior supports. Not a BIP or FBA — keep entries observable,
              actionable, and free of confidential information.
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                style={{
                  background: "rgba(255,255,255,0.15)",
                  border: "1px solid rgba(255,255,255,0.4)",
                  color: "white",
                  padding: "0.4rem 0.8rem",
                  borderRadius: 999,
                  cursor: "pointer",
                }}
              >
                ← Back
              </button>
            )}
            {canManage && (
              <button
                type="button"
                onClick={() => {
                  setPicking(true);
                  setPickerFilter("");
                }}
                style={{
                  background: "white",
                  border: "none",
                  color: "#6b21a8",
                  fontWeight: 700,
                  padding: "0.4rem 0.9rem",
                  borderRadius: 999,
                  cursor: "pointer",
                }}
              >
                + New snapshot
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0 }}>
            Current snapshots{" "}
            <span style={{ color: "#64748b", fontWeight: 400, fontSize: "0.85rem" }}>
              ({records.length})
            </span>
          </h3>
          <input
            type="text"
            placeholder="Filter by name or ID…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ maxWidth: 240 }}
          />
        </div>
        {error && <div style={{ color: "#b91c1c" }}>{error}</div>}
        {loading ? (
          <div style={{ color: "#64748b" }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ color: "#64748b", padding: "0.5rem 0" }}>
            {records.length === 0
              ? "No behavior support snapshots yet. Use “+ New snapshot” to write the first one."
              : "No matches."}
          </div>
        ) : (
          <table
            className="pulse-table"
            style={{ width: "100%", borderCollapse: "collapse" }}
            cellPadding={6}
          >
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Student</th>
                <th>Grade</th>
                <th>Status</th>
                <th>Effective</th>
                <th>Review</th>
                <th>Bullets</th>
                <th style={{ textAlign: "left" }}>Last updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const total =
                  r.behaviors.length +
                  r.triggers.length +
                  r.responses.length +
                  r.replacementBehaviors.length +
                  r.reinforcement.length;
                const overdue = !!r.reviewDate && r.reviewDate < today;
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      {r.firstName} {r.lastName}
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 11,
                          color: "#94a3b8",
                          fontWeight: 400,
                        }}
                      >
                        {r.localSisId ?? ""}
                      </span>
                    </td>
                    <td style={{ textAlign: "center" }}>{r.grade ?? "—"}</td>
                    <td style={{ textAlign: "center" }}>
                      {r.isActive ? (
                        <span
                          style={{
                            background: "#f3e8ff",
                            color: "#6b21a8",
                            padding: "2px 8px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          Active
                        </span>
                      ) : (
                        <span style={{ color: "#94a3b8", fontSize: 12 }}>
                          Inactive
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: "center", fontSize: 12 }}>
                      {fmtDate(r.effectiveDate)}
                    </td>
                    <td
                      style={{
                        textAlign: "center",
                        fontSize: 12,
                        color: overdue ? "#92400e" : undefined,
                        fontWeight: overdue ? 700 : undefined,
                      }}
                      title={overdue ? "Review date has passed" : undefined}
                    >
                      {fmtDate(r.reviewDate)}
                      {overdue ? " ⚠" : ""}
                    </td>
                    <td style={{ textAlign: "center", fontSize: 12 }}>{total}</td>
                    <td style={{ fontSize: 12, color: "#64748b" }}>
                      {fmtDate(r.updatedAt)}
                      {r.updatedByName ? ` · ${r.updatedByName}` : ""}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" onClick={() => openFromRow(r)}>
                        {canManage ? "Edit" : "View"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Student picker */}
      {picking && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            zIndex: 1000,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "4rem 1rem 1rem",
          }}
          onClick={() => setPicking(false)}
        >
          <div
            className="card"
            style={{ maxWidth: 460, width: "100%", maxHeight: "70vh", overflow: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Choose a student</h3>
            <input
              autoFocus
              type="text"
              placeholder="Search by name or ID…"
              value={pickerFilter}
              onChange={(e) => setPickerFilter(e.target.value)}
              style={{ width: "100%", marginBottom: "0.5rem" }}
            />
            {studentsError ? (
              <div style={{ color: "#b91c1c", fontSize: 13, padding: "0.5rem 0" }}>
                {studentsError} Refresh the page and try again.
              </div>
            ) : students.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: 13, padding: "0.5rem 0" }}>
                Loading students…
              </div>
            ) : pickerStudents.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: 13, padding: "0.5rem 0" }}>
                No student matches “{pickerFilter}”.
              </div>
            ) : null}
            {pickerStudents.map((s) => {
              const has = currentIds.has(s.studentId);
              return (
                <button
                  key={s.studentId}
                  type="button"
                  onClick={() => openEditor(s)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    width: "100%",
                    textAlign: "left",
                    background: "white",
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                    padding: "0.4rem 0.6rem",
                    marginBottom: 4,
                    cursor: "pointer",
                  }}
                >
                  <StudentPhoto
                    firstName={s.firstName}
                    lastName={s.lastName}
                    photoObjectKey={s.photoObjectKey ?? null}
                    photoConsent={s.photoConsent !== false}
                    size={28}
                  />
                  <span style={{ fontWeight: 600 }}>
                    {s.firstName} {s.lastName}
                  </span>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>
                    G{s.grade} · {s.localSisId ?? s.studentId}
                  </span>
                  {has && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        color: "#6b21a8",
                        background: "#f3e8ff",
                        borderRadius: 6,
                        padding: "1px 6px",
                        fontWeight: 700,
                      }}
                    >
                      has snapshot
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Editor */}
      {editingStudent && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            zIndex: 1000,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "2rem 1rem 1rem",
          }}
          onClick={() => setEditingStudent(null)}
        >
          <div
            className="card"
            style={{
              maxWidth: 640,
              width: "100%",
              maxHeight: "85vh",
              overflow: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "1rem",
              }}
            >
              <div>
                <h3 style={{ margin: 0, color: "#6b21a8" }}>
                  Behavior Supports · {editingStudent.firstName}{" "}
                  {editingStudent.lastName}
                </h3>
                {lastMeta && (
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                    Last updated {fmtDate(lastMeta.updatedAt)}
                    {lastMeta.updatedByName ? ` by ${lastMeta.updatedByName}` : ""}
                  </div>
                )}
              </div>
              <button type="button" onClick={() => setEditingStudent(null)}>
                Close
              </button>
            </div>

            <div
              style={{
                fontSize: 12,
                color: "#92400e",
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 6,
                padding: "0.4rem 0.6rem",
                margin: "0.6rem 0",
              }}
            >
              Teachers see everything below on the roster hover card. Never
              include diagnoses, evaluations, counseling notes, or other
              confidential information.
            </div>

            <div
              style={{
                display: "flex",
                gap: "1rem",
                flexWrap: "wrap",
                alignItems: "center",
                marginBottom: "0.75rem",
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={isActive}
                  disabled={!canManage}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                <strong>Active Behavior Supports</strong>
              </label>
              <label style={{ fontSize: 13 }}>
                Effective{" "}
                <input
                  type="date"
                  value={effectiveDate}
                  disabled={!canManage}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Review by{" "}
                <input
                  type="date"
                  value={reviewDate}
                  disabled={!canManage}
                  onChange={(e) => setReviewDate(e.target.value)}
                />
              </label>
            </div>

            <div
              style={{
                fontSize: 12,
                color: totalBullets >= MAX_TOTAL_BULLETS ? "#b91c1c" : "#64748b",
                marginBottom: "0.5rem",
              }}
            >
              {totalBullets}/{MAX_TOTAL_BULLETS} bullets used
              {totalBullets >= MAX_TOTAL_BULLETS
                ? " — limit reached. Trim before adding more."
                : " — keep it scannable; teachers read this mid-class."}
            </div>

            {LIST_DEFS.map((def) => (
              <div key={def.key} style={{ marginBottom: "0.85rem" }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
                  {def.title}
                </div>
                {lists[def.key].length === 0 && (
                  <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
                    {def.hint}
                  </div>
                )}
                <ul style={{ margin: "0 0 4px", paddingLeft: 18 }}>
                  {lists[def.key].map((item, i) => (
                    <li key={i} style={{ fontSize: 13, marginBottom: 2 }}>
                      {item}
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => removeBullet(def.key, i)}
                          aria-label={`Remove "${item}"`}
                          style={{
                            marginLeft: 6,
                            border: "none",
                            background: "none",
                            color: "#b91c1c",
                            cursor: "pointer",
                            fontWeight: 700,
                          }}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {canManage && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="text"
                      value={drafts[def.key] ?? ""}
                      placeholder="Add a bullet…"
                      maxLength={200}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [def.key]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addBullet(def.key);
                        }
                      }}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => addBullet(def.key)}
                      disabled={
                        !(drafts[def.key] ?? "").trim() ||
                        totalBullets >= MAX_TOTAL_BULLETS
                      }
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            ))}

            {formError && (
              <div
                role="alert"
                style={{
                  color: "#991b1b",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: 6,
                  padding: "0.4rem 0.6rem",
                  marginBottom: "0.5rem",
                }}
              >
                {formError}
              </div>
            )}

            {canManage && (
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  style={{
                    background: "#6b21a8",
                    color: "white",
                    border: "none",
                    borderRadius: 8,
                    padding: "0.5rem 1.1rem",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {saving ? "Saving…" : "Save snapshot"}
                </button>
                {lastMeta && (
                  <button
                    type="button"
                    onClick={archive}
                    disabled={saving}
                    title="Retire the snapshot — the pill disappears; history is kept."
                  >
                    Archive record
                  </button>
                )}
              </div>
            )}

            {history.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#6b21a8",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {showHistory ? "▾" : "▸"} Version history ({history.length})
                </button>
                {showHistory &&
                  history.map((h) => (
                    <div
                      key={h.id}
                      style={{
                        border: "1px solid #e2e8f0",
                        borderRadius: 8,
                        padding: "0.5rem 0.7rem",
                        marginTop: 6,
                        fontSize: 12,
                        color: "#475569",
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {fmtDate(h.createdAt)} → archived {fmtDate(h.archivedAt)}
                        {h.updatedByName ? ` · ${h.updatedByName}` : ""}
                        {!h.isActive ? " · (inactive)" : ""}
                      </div>
                      {LIST_DEFS.map((def) =>
                        h[def.key].length > 0 ? (
                          <div key={def.key} style={{ marginTop: 3 }}>
                            <em>{def.title}:</em> {h[def.key].join(" · ")}
                          </div>
                        ) : null,
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
