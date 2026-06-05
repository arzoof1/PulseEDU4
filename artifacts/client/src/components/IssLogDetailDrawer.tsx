import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";

// Per-day row shape returned by GET /api/admin-hub/iss-logs/:id.
interface DayRow {
  id: number;
  day: string;
  source: string;
  presentPeriods: number[];
  markedServed: boolean;
  rolledFromDate: string | null;
}

interface LogRow {
  id: number;
  studentId: string;
  reasonId: number | null;
  reasonText: string | null;
  notes: string | null;
  createdById: number;
  createdByName: string;
  cancelledAt: string | null;
  cancelledByName: string | null;
  createdAt: string;
}

interface AuditRow {
  id: number;
  action: string;
  actorDisplayName: string;
  editReason: string;
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  createdAt: string;
}

interface DisciplineReason {
  id: number;
  label: string;
}

// A day row counts as "served" if it has any signal that processing
// happened against it. Mirrors the server-side `isDayServed()` helper
// in routes/adminHub.ts.
function isServed(d: DayRow): boolean {
  return (
    (d.presentPeriods?.length ?? 0) > 0 ||
    d.markedServed === true ||
    d.rolledFromDate !== null
  );
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.5)",
  display: "flex",
  justifyContent: "flex-end",
  zIndex: 60,
};

const panel: CSSProperties = {
  width: "min(640px, 100vw)",
  background: "white",
  overflowY: "auto",
  padding: "1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const tabBar: CSSProperties = {
  display: "flex",
  gap: 4,
  borderBottom: "1px solid #e5e7eb",
};

const tabBtn = (active: boolean): CSSProperties => ({
  padding: "0.5rem 0.9rem",
  border: "none",
  borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
  background: "transparent",
  cursor: "pointer",
  fontWeight: active ? 700 : 500,
  color: active ? "#2563eb" : "#475569",
});

const sectionCard: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "0.85rem 1rem",
};

const primaryBtn: CSSProperties = {
  padding: "0.45rem 0.9rem",
  border: "none",
  borderRadius: 6,
  background: "#2563eb",
  color: "white",
  cursor: "pointer",
  fontWeight: 600,
};

const ghostBtn: CSSProperties = {
  padding: "0.4rem 0.85rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  cursor: "pointer",
};

const dangerBtn: CSSProperties = {
  padding: "0.45rem 0.9rem",
  border: "none",
  borderRadius: 6,
  background: "#dc2626",
  color: "white",
  cursor: "pointer",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  font: "inherit",
};

// Centralized "reason for edit" prompt. Min 5 chars enforced both
// here and on the server. Returns null on cancel.
function promptEditReason(action: string): string | null {
  for (;;) {
    const v = window.prompt(
      `Reason for this ${action}? (auditors will read this first — min 5 chars)`,
    );
    if (v === null) return null;
    const t = v.trim();
    if (t.length >= 5) return t;
    window.alert("Please enter at least 5 characters explaining the change.");
  }
}

export default function IssLogDetailDrawer({
  logId,
  studentName,
  onClose,
  onChanged,
}: {
  logId: number;
  studentName: string;
  onClose: () => void;
  // Fires after any successful mutation so the parent can reload its
  // recent feed. Also fires on delete (with `deleted: true`).
  onChanged: (opts?: { deleted?: boolean }) => void;
}) {
  const [log, setLog] = useState<LogRow | null>(null);
  const [days, setDays] = useState<DayRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [reasons, setReasons] = useState<DisciplineReason[]>([]);
  const [tab, setTab] = useState<"detail" | "history">("detail");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline edit form state.
  const [reasonId, setReasonId] = useState<number | "" | "other">("");
  const [reasonText, setReasonText] = useState("");
  const [notes, setNotes] = useState("");
  const [newDay, setNewDay] = useState("");

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [r1, r2] = await Promise.all([
        authFetch(`/api/admin-hub/iss-logs/${logId}`),
        authFetch(`/api/discipline-reasons`),
      ]);
      if (!r1.ok) throw new Error(await r1.text());
      const d = (await r1.json()) as { log: LogRow; days: DayRow[] };
      setLog(d.log);
      setDays(d.days);
      setReasonId(d.log.reasonId ?? (d.log.reasonText ? "other" : ""));
      setReasonText(d.log.reasonId ? "" : d.log.reasonText ?? "");
      setNotes(d.log.notes ?? "");
      // Discipline reasons endpoint is best-effort — if it 403s for a
      // role we still want the drawer to open. Free-text fallback works
      // in either case.
      if (r2.ok) {
        // Endpoint returns a bare array, not a {rows} wrapper.
        const rdata = (await r2.json()) as DisciplineReason[];
        setReasons(Array.isArray(rdata) ? rdata : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [logId]);

  const reloadAudit = useCallback(async () => {
    try {
      const r = await authFetch(`/api/admin-hub/iss-logs/${logId}/audit`);
      if (!r.ok) throw new Error(await r.text());
      const d = (await r.json()) as { rows: AuditRow[] };
      setAudit(d.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "History load failed");
    }
  }, [logId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (tab === "history" && audit === null) {
      void reloadAudit();
    }
  }, [tab, audit, reloadAudit]);

  const today = todayYmd();
  const sortedDays = useMemo(
    () => [...days].sort((a, b) => a.day.localeCompare(b.day)),
    [days],
  );
  const servedCount = useMemo(() => sortedDays.filter(isServed).length, [sortedDays]);
  const canDelete = servedCount === 0 && !log?.cancelledAt;

  const submitReasonNotes = async () => {
    if (!log) return;
    // Build the patch body — only include fields the user actually
    // changed, to keep the audit trail tight.
    const body: Record<string, unknown> = {};
    const newReasonId =
      reasonId === "other" || reasonId === "" ? null : Number(reasonId);
    const newReasonText =
      reasonId === "other" ? reasonText.trim() || null : null;
    const reasonChanged =
      newReasonId !== log.reasonId ||
      (newReasonId === null &&
        newReasonText !== log.reasonText);
    const notesChanged = (notes || "").trim() !== (log.notes ?? "");
    if (!reasonChanged && !notesChanged) {
      window.alert("Nothing changed.");
      return;
    }
    if (reasonChanged) {
      if (newReasonId !== null) body.reasonId = newReasonId;
      else body.reasonText = newReasonText;
    }
    if (notesChanged) body.notes = notes;

    const editReason = promptEditReason("edit");
    if (!editReason) return;
    body.editReason = editReason;

    setBusy(true);
    try {
      const r = await authFetch(`/api/admin-hub/iss-logs/${logId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      await reload();
      setAudit(null); // force history refresh next time
      onChanged();
    } catch (e) {
      window.alert(`Edit failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(false);
    }
  };

  const removeDay = async (day: string) => {
    if (!log) return;
    const editReason = promptEditReason(`removal of ${day}`);
    if (!editReason) return;
    const next = sortedDays.map((d) => d.day).filter((d) => d !== day);
    setBusy(true);
    try {
      const r = await authFetch(`/api/admin-hub/iss-logs/${logId}/dates`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editReason, dates: next }),
      });
      if (!r.ok) throw new Error(await r.text());
      await reload();
      setAudit(null);
      onChanged();
    } catch (e) {
      window.alert(`Trim failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(false);
    }
  };

  const addDay = async () => {
    if (!log) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDay)) {
      window.alert("Enter a valid date (YYYY-MM-DD).");
      return;
    }
    if (newDay < today) {
      window.alert("New days must be today or in the future.");
      return;
    }
    if (sortedDays.some((d) => d.day === newDay)) {
      window.alert("That day is already on this assignment.");
      return;
    }
    const editReason = promptEditReason(`adding ${newDay}`);
    if (!editReason) return;
    const next = [...sortedDays.map((d) => d.day), newDay];
    setBusy(true);
    try {
      const r = await authFetch(`/api/admin-hub/iss-logs/${logId}/dates`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editReason, dates: next }),
      });
      if (!r.ok) throw new Error(await r.text());
      setNewDay("");
      await reload();
      setAudit(null);
      onChanged();
    } catch (e) {
      window.alert(`Add failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteAssignment = async () => {
    if (!log) return;
    if (!canDelete) return;
    if (
      !window.confirm(
        "Delete this entire assignment? This removes all day rows. Only allowed because no day has been served yet.",
      )
    )
      return;
    const editReason = promptEditReason("deletion");
    if (!editReason) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/admin-hub/iss-logs/${logId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editReason }),
      });
      if (!r.ok) throw new Error(await r.text());
      onChanged({ deleted: true });
      onClose();
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : "error"}`);
      setBusy(false);
    }
  };

  return (
    <div
      style={overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>
            ISS · {studentName}
            {log?.cancelledAt && (
              <span style={{ color: "#dc2626", fontSize: 14, marginLeft: 8 }}>
                (cancelled)
              </span>
            )}
          </h2>
          <button type="button" onClick={onClose} style={ghostBtn}>
            Close
          </button>
        </div>

        {error && (
          <div
            style={{
              color: "#991b1b",
              background: "#fee2e2",
              padding: "0.6rem",
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        )}

        <div style={tabBar}>
          <button
            type="button"
            onClick={() => setTab("detail")}
            style={tabBtn(tab === "detail")}
          >
            Detail
          </button>
          <button
            type="button"
            onClick={() => setTab("history")}
            style={tabBtn(tab === "history")}
          >
            History
          </button>
        </div>

        {tab === "detail" && log && (
          <>
            <div style={sectionCard}>
              <div
                style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}
              >
                Created by {log.createdByName} on{" "}
                {new Date(log.createdAt).toLocaleString()} · {sortedDays.length}
                {" "}day{sortedDays.length === 1 ? "" : "s"} ·{" "}
                {servedCount} served
              </div>
              <label style={{ display: "block", marginTop: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Reason</div>
                <select
                  value={reasonId}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "other" || v === "") setReasonId(v);
                    else setReasonId(Number(v));
                  }}
                  disabled={busy || !!log.cancelledAt}
                  style={inputStyle}
                >
                  <option value="">— Select —</option>
                  {reasons.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                  <option value="other">Other (free text)</option>
                </select>
                {reasonId === "other" && (
                  <input
                    type="text"
                    value={reasonText}
                    onChange={(e) => setReasonText(e.target.value)}
                    placeholder="Reason"
                    disabled={busy || !!log.cancelledAt}
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                )}
              </label>
              <label style={{ display: "block", marginTop: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Notes</div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  disabled={busy || !!log.cancelledAt}
                  style={inputStyle}
                />
              </label>
              {!log.cancelledAt && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={submitReasonNotes}
                    disabled={busy}
                    style={primaryBtn}
                  >
                    Save reason / notes
                  </button>
                </div>
              )}
            </div>

            <div style={sectionCard}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Days</div>
              {sortedDays.length === 0 ? (
                <div style={{ color: "#64748b" }}>(no days)</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {sortedDays.map((d) => {
                    const served = isServed(d);
                    const isFuture = d.day > today;
                    const isToday = d.day === today;
                    const removable =
                      !log.cancelledAt && (isFuture || (isToday && !served));
                    return (
                      <div
                        key={d.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "0.35rem 0.5rem",
                          borderRadius: 6,
                          background: served ? "#f0fdf4" : "white",
                          border: "1px solid #e5e7eb",
                        }}
                      >
                        <span style={{ minWidth: 110, fontFamily: "monospace" }}>
                          {d.day}
                        </span>
                        <span style={{ flex: 1, fontSize: 12, color: "#475569" }}>
                          {served
                            ? d.markedServed
                              ? "✓ marked served"
                              : d.rolledFromDate
                                ? `↻ rolled from ${d.rolledFromDate}`
                                : `✓ ${d.presentPeriods.length} period(s) marked`
                            : isFuture
                              ? "future"
                              : isToday
                                ? "today, not yet served"
                                : "past, no record"}
                        </span>
                        {removable && (
                          <button
                            type="button"
                            onClick={() => removeDay(d.day)}
                            disabled={busy}
                            style={{ ...ghostBtn, padding: "2px 8px", fontSize: 12 }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {!log.cancelledAt && (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginTop: 10,
                    alignItems: "center",
                  }}
                >
                  <input
                    type="date"
                    min={today}
                    value={newDay}
                    onChange={(e) => setNewDay(e.target.value)}
                    disabled={busy}
                    style={{ ...inputStyle, width: 180 }}
                  />
                  <button
                    type="button"
                    onClick={addDay}
                    disabled={busy || !newDay}
                    style={ghostBtn}
                  >
                    Add day
                  </button>
                </div>
              )}
            </div>

            {canDelete && (
              <div style={sectionCard}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Delete entire assignment
                </div>
                <div
                  style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}
                >
                  Allowed because no day has been served. Use Cancel
                  (on the recent feed) for partially-served assignments.
                </div>
                <button
                  type="button"
                  onClick={deleteAssignment}
                  disabled={busy}
                  style={dangerBtn}
                >
                  Delete assignment
                </button>
              </div>
            )}
          </>
        )}

        {tab === "history" && (
          <div style={sectionCard}>
            {audit === null ? (
              <div style={{ color: "#64748b" }}>Loading history…</div>
            ) : audit.length === 0 ? (
              <div style={{ color: "#64748b" }}>
                No edits recorded. Only the original creation event exists.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {audit.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      borderLeft: "3px solid #2563eb",
                      paddingLeft: 10,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {a.action.replace(/_/g, " ")} ·{" "}
                      <span style={{ color: "#475569", fontWeight: 400 }}>
                        {a.actorDisplayName}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>
                      {new Date(a.createdAt).toLocaleString()}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        marginTop: 4,
                        background: "#f8fafc",
                        padding: "4px 8px",
                        borderRadius: 4,
                      }}
                    >
                      <strong>Why:</strong> {a.editReason}
                    </div>
                    {(a.beforeJson || a.afterJson) && (
                      <details style={{ marginTop: 4 }}>
                        <summary
                          style={{
                            fontSize: 12,
                            color: "#475569",
                            cursor: "pointer",
                          }}
                        >
                          Before / after
                        </summary>
                        <pre
                          style={{
                            fontSize: 11,
                            background: "#f1f5f9",
                            padding: 6,
                            borderRadius: 4,
                            marginTop: 4,
                            overflowX: "auto",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {JSON.stringify(
                            { before: a.beforeJson, after: a.afterJson },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
