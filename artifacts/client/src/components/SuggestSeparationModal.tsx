// Modal launched from Teacher Roster's per-student row. Lets a teacher
// pick a SECOND student from the same period and (optionally) attach
// reason tags + a free-text note. Existing flags for the current pair
// are loaded in so this acts like an "edit" if the teacher re-opens it.
//
// Server enforces: the section must belong to the calling teacher and
// both students must be on its roster.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";

interface TagRow {
  id: number;
  label: string;
  active: boolean;
}

interface ClassmateRow {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
}

interface SeparationRow {
  id: number;
  studentAId: string;
  studentBId: string;
  reasonTagIds: number[];
  reasonNote: string | null;
}

interface Props {
  classSectionId: number;
  primaryStudentId: string;
  primaryStudentName: string;
  onClose: () => void;
  onSaved: () => void;
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15,23,42,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialog: CSSProperties = {
  background: "white",
  borderRadius: 8,
  padding: "1.25rem 1.5rem",
  width: 520,
  maxWidth: "90vw",
  maxHeight: "85vh",
  overflowY: "auto",
};

const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--text-subtle)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  font: "inherit",
};

export default function SuggestSeparationModal({
  classSectionId,
  primaryStudentId,
  primaryStudentName,
  onClose,
  onSaved,
}: Props) {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [classmates, setClassmates] = useState<ClassmateRow[]>([]);
  const [existing, setExisting] = useState<SeparationRow[]>([]);
  const [otherId, setOtherId] = useState<string>("");
  const [pickedTagIds, setPickedTagIds] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // Initial load: tags + classmates + existing flags.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [tagsR, rosterR, mineR] = await Promise.all([
          authFetch("/api/separation-reason-tags"),
          authFetch(`/api/separations/section/${classSectionId}/students`),
          authFetch(
            `/api/separations/my?classSectionId=${classSectionId}`,
          ),
        ]);
        if (cancelled) return;
        if (tagsR.ok) {
          const all = (await tagsR.json()) as TagRow[];
          setTags(all.filter((t) => t.active));
        }
        if (rosterR.ok) {
          const j = (await rosterR.json()) as { students: ClassmateRow[] };
          setClassmates(
            j.students.filter((s) => s.studentId !== primaryStudentId),
          );
        }
        if (mineR.ok) {
          const j = (await mineR.json()) as { separations: SeparationRow[] };
          setExisting(j.separations);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [classSectionId, primaryStudentId]);

  // When the picked classmate changes, prefill from any existing flag
  // for that pair so re-opening acts like an "edit".
  useEffect(() => {
    if (!otherId) {
      setPickedTagIds(new Set());
      setNote("");
      return;
    }
    const aId =
      primaryStudentId < otherId ? primaryStudentId : otherId;
    const bId = primaryStudentId < otherId ? otherId : primaryStudentId;
    const match = existing.find(
      (e) => e.studentAId === aId && e.studentBId === bId,
    );
    if (match) {
      setPickedTagIds(new Set(match.reasonTagIds));
      setNote(match.reasonNote ?? "");
    } else {
      setPickedTagIds(new Set());
      setNote("");
    }
  }, [otherId, existing, primaryStudentId]);

  const existingPairs = useMemo(() => {
    return existing
      .filter(
        (e) =>
          e.studentAId === primaryStudentId ||
          e.studentBId === primaryStudentId,
      )
      .map((e) => {
        const otherId =
          e.studentAId === primaryStudentId ? e.studentBId : e.studentAId;
        const cm = classmates.find((c) => c.studentId === otherId);
        return {
          ...e,
          otherId,
          otherName: cm
            ? `${cm.lastName}, ${cm.firstName}`
            : otherId,
        };
      });
  }, [existing, classmates, primaryStudentId]);

  const toggleTag = (id: number) => {
    setPickedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = useCallback(async () => {
    if (!otherId) {
      setErr("Pick a classmate to flag.");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const r = await authFetch("/api/separations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classSectionId,
          studentAId: primaryStudentId,
          studentBId: otherId,
          reasonTagIds: Array.from(pickedTagIds),
          reasonNote: note.trim() || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [
    classSectionId,
    primaryStudentId,
    otherId,
    pickedTagIds,
    note,
    onSaved,
    onClose,
  ]);

  const remove = useCallback(
    async (id: number) => {
      setErr("");
      const r = await authFetch(`/api/separations/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        setErr(await r.text());
        return;
      }
      // Refresh local list so the existing-pairs section drops it.
      setExisting((prev) => prev.filter((e) => e.id !== id));
      onSaved();
    },
    [onSaved],
  );

  return (
    <div role="dialog" aria-modal="true" style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "start",
            marginBottom: "0.75rem",
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>Suggest separation</h3>
            <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0", fontSize: 13 }}>
              For <strong>{primaryStudentName}</strong>. Only the
              scheduling team sees the aggregated list.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: "#64748b",
            }}
          >
            ×
          </button>
        </div>

        {loading ? (
          <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
        ) : (
          <>
            {existingPairs.length > 0 && (
              <div
                style={{
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  borderRadius: 6,
                  padding: "0.5rem 0.75rem",
                  marginBottom: "0.75rem",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: "#92400e" }}>
                  Already flagged in this period
                </div>
                <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem", fontSize: 13 }}>
                  {existingPairs.map((p) => (
                    <li key={p.id} style={{ marginBottom: 2 }}>
                      <span style={{ marginRight: 8 }}>{p.otherName}</span>
                      <button
                        type="button"
                        onClick={() => void remove(p.id)}
                        style={{
                          fontSize: 11,
                          color: "#b91c1c",
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          textDecoration: "underline",
                        }}
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ marginBottom: "0.75rem" }}>
              <label style={fieldLabel} htmlFor="other-student">
                Don't pair with
              </label>
              <select
                id="other-student"
                value={otherId}
                onChange={(e) => setOtherId(e.target.value)}
                style={inputStyle}
              >
                <option value="">Pick a classmate…</option>
                {classmates.map((c) => (
                  <option key={c.studentId} value={c.studentId}>
                    {c.lastName}, {c.firstName}
                  </option>
                ))}
              </select>
              {classmates.length === 0 && (
                <div style={{ color: "var(--text-subtle)", fontSize: 12, marginTop: 4 }}>
                  No other students on this section's roster.
                </div>
              )}
            </div>

            <div style={{ marginBottom: "0.75rem" }}>
              <label style={fieldLabel}>Reasons (optional)</label>
              {tags.length === 0 ? (
                <div style={{ color: "var(--text-subtle)", fontSize: 13 }}>
                  No tags configured yet. Ask your Behavior Specialist to
                  add some, or just use the note below.
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {tags.map((t) => {
                    const on = pickedTagIds.has(t.id);
                    return (
                      <button
                        type="button"
                        key={t.id}
                        onClick={() => toggleTag(t.id)}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                          border: on
                            ? "1px solid #1d4ed8"
                            : "1px solid #cbd5e1",
                          background: on ? "#dbeafe" : "white",
                          color: on ? "#1e40af" : "#334155",
                        }}
                        aria-pressed={on}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <label style={fieldLabel} htmlFor="note">
                Note (optional)
              </label>
              <textarea
                id="note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                placeholder="Anything the scheduling team should know…"
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>

            {err && (
              <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>
                {err}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "0.45rem 0.9rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !otherId}
                style={{
                  padding: "0.45rem 0.9rem",
                  border: "none",
                  borderRadius: 6,
                  background: !otherId || saving ? "#94a3b8" : "#1d4ed8",
                  color: "white",
                  fontWeight: 600,
                  cursor: !otherId || saving ? "not-allowed" : "pointer",
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
