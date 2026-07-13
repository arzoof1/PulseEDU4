// SafetyPlanEditor — modal for creating / editing a single student's
// safety plan. Read-only when the signed-in staff member doesn't have
// edit rights (Guidance Counselor / Admin / Core Team only).
//
// Loads the school's library catalog + the student's current plan in
// parallel; lets the editor toggle library items on/off, add custom
// items, optionally annotate notes per item, set notes / start / end
// dates, and save (PUT) or deactivate. No history tab here — the audit
// log is reachable from a separate admin screen.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  usePrivilegedReauth,
  fetchWithReauth,
} from "../lib/usePrivilegedReauth";

interface SafetyPlanItem {
  label: string;
  active: boolean;
  note?: string;
}
interface LibraryItem {
  id: number;
  label: string;
  isBuiltIn: boolean;
  active: boolean;
  sortOrder: number;
}
interface PlanRow {
  id: number;
  status: string;
  items: SafetyPlanItem[];
  notes: string;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
}

export default function SafetyPlanEditor({
  studentId,
  studentName,
  onClose,
  onSaved,
}: {
  studentId: string;
  studentName?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [items, setItems] = useState<SafetyPlanItem[]>([]);
  const [notes, setNotes] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [newItemLabel, setNewItemLabel] = useState("");
  const { ensureReauth, reauthModal } = usePrivilegedReauth();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Viewing a Safety Plan is step-up gated (Section 1.15): the plan GET
        // 403s until a recent reauth, so prompt + retry; cancel closes the editor.
        const libR = await authFetch("/api/safety-plans/library");
        const planR = await fetchWithReauth(ensureReauth, () =>
          authFetch(
            `/api/safety-plans/student/${encodeURIComponent(studentId)}`,
          ),
        );
        if (cancelled) return;
        if (!planR) {
          onClose();
          return;
        }
        if (!libR.ok) throw new Error(`Library load failed (${libR.status})`);
        if (!planR.ok) throw new Error(`Plan load failed (${planR.status})`);
        const libJ = (await libR.json()) as { items: LibraryItem[] };
        const planJ = (await planR.json()) as {
          plan: PlanRow | null;
          canEdit: boolean;
        };
        if (cancelled) return;
        setLibrary(libJ.items);
        setCanEdit(planJ.canEdit);
        if (planJ.plan) {
          setPlan(planJ.plan);
          setItems(planJ.plan.items ?? []);
          setNotes(planJ.plan.notes ?? "");
          setStartDate(planJ.plan.startDate ?? "");
          setEndDate(planJ.plan.endDate ?? "");
          setStatus(planJ.plan.status === "inactive" ? "inactive" : "active");
        } else {
          // Pre-populate a brand new plan with the active library items
          // turned OFF so the editor starts clean.
          setItems([]);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  // Map current items by label for quick lookup so the library list can
  // show "On / Off" toggles against what's already in the plan.
  const itemByLabel = useMemo(() => {
    const m = new Map<string, SafetyPlanItem>();
    for (const it of items) m.set(it.label, it);
    return m;
  }, [items]);

  function toggleLibraryItem(label: string) {
    if (!canEdit) return;
    const existing = itemByLabel.get(label);
    if (existing) {
      // Remove entirely (toggling off the library item just drops it).
      setItems(items.filter((i) => i.label !== label));
    } else {
      setItems([...items, { label, active: true }]);
    }
  }

  function updateItemNote(label: string, note: string) {
    setItems(
      items.map((i) =>
        i.label === label ? { ...i, note: note || undefined } : i,
      ),
    );
  }

  function removeItem(label: string) {
    setItems(items.filter((i) => i.label !== label));
  }

  function addCustomItem() {
    const label = newItemLabel.trim();
    if (!label) return;
    if (itemByLabel.has(label)) {
      setNewItemLabel("");
      return;
    }
    setItems([...items, { label, active: true }]);
    setNewItemLabel("");
  }

  async function save() {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/safety-plans/student/${encodeURIComponent(studentId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items,
            notes,
            status,
            startDate: startDate || null,
            endDate: endDate || null,
          }),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `Save failed (${r.status})`);
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deactivate() {
    if (!canEdit || !plan) return;
    if (!window.confirm("Deactivate this safety plan? It can be re-activated later."))
      return;
    setSaving(true);
    try {
      const r = await authFetch(
        `/api/safety-plans/student/${encodeURIComponent(studentId)}/deactivate`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(`Deactivate failed (${r.status})`);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const activeLibrary = library.filter((l) => l.active);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "5vh 1rem",
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {reauthModal}
      <div
        style={{
          background: "white",
          borderRadius: 8,
          maxWidth: 720,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            padding: "1rem 1.25rem",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#fef2f2",
            borderTop: "4px solid #dc2626",
            borderRadius: "8px 8px 0 0",
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: "#991b1b", fontWeight: 700, letterSpacing: 0.4 }}>
              SAFETY PLAN
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>
              {studentName ?? "Student"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>

        <div style={{ padding: "1rem 1.25rem" }}>
          {loading && <div>Loading…</div>}
          {error && (
            <div
              style={{
                background: "#fef2f2",
                color: "#991b1b",
                padding: "0.5rem 0.75rem",
                borderRadius: 4,
                marginBottom: "0.75rem",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          {!loading && (
            <>
              {!canEdit && (
                <div
                  style={{
                    background: "#f3f4f6",
                    padding: "0.5rem 0.75rem",
                    borderRadius: 4,
                    marginBottom: "0.75rem",
                    fontSize: 12,
                    color: "#374151",
                  }}
                >
                  View-only — only Guidance Counselor, Admin, and Core Team can edit.
                </div>
              )}

              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: "#374151" }}>
                  Status:{" "}
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
                    disabled={!canEdit}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, color: "#374151" }}>
                  Start:{" "}
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    disabled={!canEdit}
                  />
                </label>
                <label style={{ fontSize: 12, color: "#374151" }}>
                  End:{" "}
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    disabled={!canEdit}
                  />
                </label>
              </div>

              <h3 style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 6px", color: "#111827" }}>
                Library items
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr",
                  gap: 4,
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  padding: 8,
                }}
              >
                {activeLibrary.length === 0 && (
                  <div style={{ color: "#6b7280", fontSize: 12 }}>
                    (No library items configured for this school yet.)
                  </div>
                )}
                {activeLibrary.map((lib) => {
                  const inPlan = itemByLabel.has(lib.label);
                  return (
                    <label
                      key={lib.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "4px 6px",
                        borderRadius: 4,
                        background: inPlan ? "#fef2f2" : "transparent",
                        cursor: canEdit ? "pointer" : "default",
                        fontSize: 13,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={inPlan}
                        disabled={!canEdit}
                        onChange={() => toggleLibraryItem(lib.label)}
                      />
                      <span>{lib.label}</span>
                      {inPlan && canEdit && (
                        <input
                          type="text"
                          placeholder="Note (optional)"
                          value={itemByLabel.get(lib.label)?.note ?? ""}
                          onChange={(e) => updateItemNote(lib.label, e.target.value)}
                          style={{
                            marginLeft: "auto",
                            fontSize: 12,
                            padding: "2px 6px",
                            border: "1px solid #d1d5db",
                            borderRadius: 4,
                            width: 220,
                          }}
                        />
                      )}
                    </label>
                  );
                })}
              </div>

              {/* Custom items added on this plan only (not in library). */}
              {(() => {
                const libLabels = new Set(activeLibrary.map((l) => l.label));
                const custom = items.filter((i) => !libLabels.has(i.label));
                if (custom.length === 0) return null;
                return (
                  <>
                    <h3 style={{ fontSize: 13, fontWeight: 700, margin: "14px 0 6px", color: "#111827" }}>
                      Custom items (this student only)
                    </h3>
                    <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8 }}>
                      {custom.map((it) => (
                        <div
                          key={it.label}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "4px 6px",
                            fontSize: 13,
                          }}
                        >
                          <span style={{ flex: 1 }}>{it.label}</span>
                          {canEdit && (
                            <>
                              <input
                                type="text"
                                placeholder="Note"
                                value={it.note ?? ""}
                                onChange={(e) => updateItemNote(it.label, e.target.value)}
                                style={{
                                  fontSize: 12,
                                  padding: "2px 6px",
                                  border: "1px solid #d1d5db",
                                  borderRadius: 4,
                                  width: 200,
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => removeItem(it.label)}
                                style={{
                                  fontSize: 11,
                                  border: "1px solid #d1d5db",
                                  borderRadius: 4,
                                  background: "white",
                                  padding: "2px 8px",
                                  cursor: "pointer",
                                }}
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                );
              })()}

              {canEdit && (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginTop: 10,
                    alignItems: "center",
                  }}
                >
                  <input
                    type="text"
                    placeholder="Add a custom item…"
                    value={newItemLabel}
                    onChange={(e) => setNewItemLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomItem();
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: "6px 8px",
                      border: "1px solid #d1d5db",
                      borderRadius: 4,
                      fontSize: 13,
                    }}
                  />
                  <button
                    type="button"
                    onClick={addCustomItem}
                    style={{
                      padding: "6px 12px",
                      border: "1px solid #d1d5db",
                      borderRadius: 4,
                      background: "white",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    Add
                  </button>
                </div>
              )}

              <h3 style={{ fontSize: 13, fontWeight: 700, margin: "14px 0 6px", color: "#111827" }}>
                Plan notes
              </h3>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={!canEdit}
                rows={4}
                placeholder="Context, triggers, who to call, etc."
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #d1d5db",
                  borderRadius: 4,
                  fontSize: 13,
                  fontFamily: "inherit",
                  resize: "vertical",
                }}
              />

              {plan?.updatedByName && (
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 8 }}>
                  Last updated{" "}
                  {plan.updatedAt ? new Date(plan.updatedAt).toLocaleString() : ""}{" "}
                  by {plan.updatedByName}
                </div>
              )}
            </>
          )}
        </div>

        {!loading && canEdit && (
          <div
            style={{
              padding: "0.75rem 1.25rem",
              borderTop: "1px solid #e5e7eb",
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              background: "#f9fafb",
              borderRadius: "0 0 8px 8px",
            }}
          >
            {plan && plan.status === "active" && (
              <button
                type="button"
                onClick={deactivate}
                disabled={saving}
                style={{
                  marginRight: "auto",
                  padding: "6px 12px",
                  border: "1px solid #fecaca",
                  background: "white",
                  color: "#991b1b",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Deactivate plan
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "6px 12px",
                border: "1px solid #d1d5db",
                background: "white",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              style={{
                padding: "6px 16px",
                border: "1px solid #dc2626",
                background: "#dc2626",
                color: "white",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {saving ? "Saving…" : "Save plan"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
