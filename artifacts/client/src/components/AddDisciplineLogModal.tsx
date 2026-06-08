import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { authFetch } from "../lib/authToken";
import { searchStudents as searchStudentsApi } from "../lib/students";

interface Props {
  initialKind: "iss" | "oss";
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

interface StudentRow {
  studentId: string;
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: string | null;
  ese?: boolean;
  is504?: boolean;
  ell?: boolean;
}

interface ReasonRow {
  id: number;
  label: string;
  active: boolean;
  sortOrder: number;
  scope?: "district" | "school";
}

interface CapacityResp {
  capacity: number | null;
  behavior: "soft" | "hard";
  usage: { day: string; used: number }[];
  closedDays: { day: string; label: string | null }[];
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.55)",
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
};

const modal: CSSProperties = {
  background: "var(--surface, #fff)",
  borderRadius: 12,
  width: "min(640px, 100%)",
  maxHeight: "92vh",
  overflow: "auto",
  padding: "1.25rem 1.4rem",
  boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
};

const label: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-subtle)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const input: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  font: "inherit",
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export default function AddDisciplineLogModal({
  initialKind,
  onClose,
  onSaved,
}: Props) {
  // The toggle was removed in favour of two distinct entry buttons on
  // AdminHubPage (Add ISS log / Add OSS log), so `kind` is locked to
  // whatever the caller opened the modal with. State is kept (rather
  // than a plain prop reference) so existing reads of `kind` further
  // down don't need to change.
  const [kind] = useState<"iss" | "oss">(initialKind);
  const [studentInput, setStudentInput] = useState("");
  const [studentResults, setStudentResults] = useState<StudentRow[]>([]);
  const [student, setStudent] = useState<StudentRow | null>(null);
  const [reasonId, setReasonId] = useState<string>("");
  const [reasonText, setReasonText] = useState("");
  const [notes, setNotes] = useState("");
  const [reasons, setReasons] = useState<ReasonRow[]>([]);
  const [dates, setDates] = useState<Set<string>>(new Set());
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [capacity, setCapacity] = useState<CapacityResp | null>(null);
  // Admin-entered "Days for reports" — independent of the calendar
  // selection (intentional: we don't auto-derive from dates).
  const [dayCount, setDayCount] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideCap, setOverrideCap] = useState(false);

  // Load reasons once.
  useEffect(() => {
    void (async () => {
      const r = await authFetch("/api/discipline-reasons");
      if (r.ok) {
        const d = (await r.json()) as ReasonRow[];
        setReasons(d.filter((x) => x.active));
      }
    })();
  }, []);

  // Load capacity + closed days for the visible month. The endpoint
  // returns both: ISS uses the capacity meter, OSS uses only the
  // closed-days list (school holidays / no-school dates) so the
  // calendar can grey them out the same way it does for ISS.
  useEffect(() => {
    void (async () => {
      const from = ymd(startOfMonth(month));
      const to = ymd(endOfMonth(month));
      const r = await authFetch(
        `/api/admin-hub/iss-capacity?from=${from}&to=${to}`,
      );
      if (r.ok) setCapacity((await r.json()) as CapacityResp);
    })();
  }, [month]);

  // Student typeahead.
  const searchStudents = useCallback(async (q: string) => {
    if (!q || q.length < 2) {
      setStudentResults([]);
      return;
    }
    try {
      const d = await searchStudentsApi<StudentRow>(q, 8);
      setStudentResults(d);
    } catch {
      setStudentResults([]);
    }
  }, []);

  useEffect(() => {
    if (student) return;
    const t = setTimeout(() => void searchStudents(studentInput), 200);
    return () => clearTimeout(t);
  }, [studentInput, student, searchStudents]);

  const toggleDate = (d: string) => {
    const next = new Set(dates);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    setDates(next);
  };

  const closedSet = useMemo(
    () => new Set((capacity?.closedDays ?? []).map((c) => c.day)),
    [capacity],
  );
  const usageMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of capacity?.usage ?? []) m.set(u.day, u.used);
    return m;
  }, [capacity]);

  const monthCells = useMemo(() => {
    const first = startOfMonth(month);
    const last = endOfMonth(month);
    const cells: { date: Date; ymd: string; inMonth: boolean }[] = [];
    // Pad to start on Sunday
    const startPad = first.getDay();
    for (let i = startPad; i > 0; i--) {
      const d = new Date(first);
      d.setDate(first.getDate() - i);
      cells.push({ date: d, ymd: ymd(d), inMonth: false });
    }
    for (let dd = 1; dd <= last.getDate(); dd++) {
      const d = new Date(month.getFullYear(), month.getMonth(), dd);
      cells.push({ date: d, ymd: ymd(d), inMonth: true });
    }
    while (cells.length % 7 !== 0) {
      const lastCell = cells[cells.length - 1].date;
      const d = new Date(lastCell);
      d.setDate(d.getDate() + 1);
      cells.push({ date: d, ymd: ymd(d), inMonth: false });
    }
    return cells;
  }, [month]);

  const submit = async (forceOverride?: boolean) => {
    setError(null);
    if (!student) {
      setError("Pick a student first.");
      return;
    }
    if (dates.size === 0) {
      setError("Pick at least one date on the calendar.");
      return;
    }
    const useOverride = forceOverride ?? overrideCap;
    setSaving(true);
    const body: Record<string, unknown> = {
      studentId: student.studentId,
      dates: Array.from(dates).sort(),
      notes: notes.trim() || null,
      overrideCapacity: useOverride,
    };
    if (reasonId) body.reasonId = Number(reasonId);
    else if (reasonText.trim()) body.reasonText = reasonText.trim();
    if (dayCount.trim()) {
      const n = Number(dayCount);
      if (!Number.isInteger(n) || n < 1 || n > 60) {
        setError("Days must be a whole number between 1 and 60.");
        setSaving(false);
        return;
      }
      body.dayCount = n;
    }

    const r = await authFetch(`/api/admin-hub/${kind}-logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!r.ok) {
      let msg = "Save failed";
      try {
        const j = (await r.json()) as {
          error?: string;
          requiresConfirm?: boolean;
          overflowDates?: string[];
        };
        msg = j.error ?? msg;
        if (j.requiresConfirm && j.overflowDates && !useOverride) {
          if (
            confirm(
              `ISS capacity reached on: ${j.overflowDates.join(", ")}\n\nSave anyway?`,
            )
          ) {
            setOverrideCap(true);
            // Pass override explicitly so we don't depend on async state.
            await submit(true);
          }
          return;
        }
      } catch {
        msg = await r.text();
      }
      setError(msg);
      return;
    }
    await onSaved();
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true">
      <div style={modal}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <h2 style={{ margin: 0 }}>
            Add {kind.toUpperCase()} log
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              padding: "0.3rem 0.7rem",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>

        {/* Static type header replaces the previous ISS/OSS toggle —
            the modal is opened in a single mode from the Admin Hub
            buttons and shouldn't be switched mid-flow. Colors mirror
            the teacher-roster pills (orange = ISS, red = OSS). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            padding: "0.55rem 0.8rem",
            border: `1px solid ${kind === "iss" ? "#fdba74" : "#fca5a5"}`,
            background: kind === "iss" ? "#fff7ed" : "#fef2f2",
            color: kind === "iss" ? "#9a3412" : "#991b1b",
            borderRadius: 8,
            marginBottom: "0.85rem",
            fontSize: 13,
          }}
        >
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: kind === "iss" ? "#ea580c" : "#dc2626",
              color: "white",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
            }}
          >
            {kind.toUpperCase()}
          </span>
          <span style={{ fontWeight: 600 }}>
            You are logging an{" "}
            {kind === "iss"
              ? "In-School Suspension"
              : "Out-of-School Suspension"}
            .
          </span>
        </div>

        <div style={{ marginBottom: "0.85rem" }}>
          <span style={label}>Student</span>
          {student ? (
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "center",
                padding: "0.5rem 0.7rem",
                background: "#f8fafc",
                borderRadius: 8,
                border: "1px solid #e5e7eb",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {student.firstName} {student.lastName}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                  ID {student.localSisId ?? "—"} · Grade {student.grade ?? "—"}
                  {student.ese && " · ESE"}
                  {student.is504 && " · 504"}
                  {student.ell && " · ELL"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setStudent(null);
                  setStudentInput("");
                }}
                style={{
                  background: "white",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                style={input}
                placeholder="Search by name or ID…"
                value={studentInput}
                onChange={(e) => setStudentInput(e.target.value)}
                autoFocus
              />
              {studentResults.length > 0 && (
                <div
                  style={{
                    marginTop: 4,
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    maxHeight: 180,
                    overflow: "auto",
                  }}
                >
                  {studentResults.map((s) => (
                    <button
                      key={s.studentId}
                      type="button"
                      onClick={() => setStudent(s)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "6px 10px",
                        background: "white",
                        border: "none",
                        borderBottom: "1px solid #f1f5f9",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {s.firstName} {s.lastName}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                        {s.localSisId ?? "—"} · Gr {s.grade ?? "—"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ marginBottom: "0.85rem" }}>
          <span style={label}>Reason</span>
          <select
            style={input}
            value={reasonId}
            onChange={(e) => {
              setReasonId(e.target.value);
              if (e.target.value) setReasonText("");
            }}
          >
            <option value="">— pick from school list —</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          {!reasonId && (
            <input
              style={{ ...input, marginTop: 4 }}
              placeholder="Or type a custom reason…"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              maxLength={200}
            />
          )}
        </div>

        <div style={{ marginBottom: "0.85rem" }}>
          <span style={label}>Notes (optional)</span>
          <textarea
            style={{ ...input, minHeight: 60 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={4000}
          />
        </div>

        <div style={{ marginBottom: "0.85rem", maxWidth: 240 }}>
          <span style={label}>
            Days for reports (optional)
          </span>
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={dayCount}
            onChange={(e) => setDayCount(e.target.value)}
            placeholder="e.g. 3"
            style={input}
          />
          <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 4 }}>
            Total {kind.toUpperCase()} days assigned. Used by reports —
            does not auto-fill the calendar.
          </div>
        </div>

        <div style={{ marginBottom: "0.85rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 4,
            }}
          >
            <span style={label}>
              Dates ({dates.size} selected)
              {kind === "iss" && capacity?.capacity && (
                <span
                  style={{
                    marginLeft: 8,
                    color: "var(--text-subtle)",
                    fontWeight: 400,
                    textTransform: "none",
                  }}
                >
                  Capacity {capacity.capacity}/day ·{" "}
                  {capacity.behavior === "hard" ? "blocks at full" : "warns when full"}
                </span>
              )}
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                type="button"
                onClick={() =>
                  setMonth(
                    new Date(month.getFullYear(), month.getMonth() - 1, 1),
                  )
                }
                style={{
                  border: "1px solid #cbd5e1",
                  background: "white",
                  borderRadius: 6,
                  padding: "2px 8px",
                  cursor: "pointer",
                }}
              >
                ‹
              </button>
              <span
                style={{ minWidth: 110, textAlign: "center", fontWeight: 600 }}
              >
                {month.toLocaleString(undefined, {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  setMonth(
                    new Date(month.getFullYear(), month.getMonth() + 1, 1),
                  )
                }
                style={{
                  border: "1px solid #cbd5e1",
                  background: "white",
                  borderRadius: 6,
                  padding: "2px 8px",
                  cursor: "pointer",
                }}
              >
                ›
              </button>
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 2,
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: 4,
            }}
          >
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  textAlign: "center",
                  color: "var(--text-subtle)",
                  fontWeight: 600,
                }}
              >
                {d}
              </div>
            ))}
            {monthCells.map((c) => {
              const dow = c.date.getDay();
              const isWeekend = dow === 0 || dow === 6;
              const isClosed = closedSet.has(c.ymd);
              const used = usageMap.get(c.ymd) ?? 0;
              const cap = capacity?.capacity ?? null;
              const overCap =
                kind === "iss" && cap !== null && used >= cap;
              const selected = dates.has(c.ymd);
              const disabled = !c.inMonth;
              return (
                <button
                  key={c.ymd}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleDate(c.ymd)}
                  title={
                    isClosed
                      ? "School closed"
                      : isWeekend
                        ? "Weekend"
                        : kind === "iss" && cap
                          ? `${used}/${cap} ISS slots used`
                          : ""
                  }
                  style={{
                    aspectRatio: "1 / 1",
                    border: selected
                      ? "2px solid #1d4ed8"
                      : "1px solid transparent",
                    borderRadius: 6,
                    cursor: disabled ? "default" : "pointer",
                    background: selected
                      ? "#dbeafe"
                      : isClosed
                        ? "#fee2e2"
                        : isWeekend
                          ? "#f1f5f9"
                          : overCap
                            ? "#fef3c7"
                            : "white",
                    color: c.inMonth ? "#0f172a" : "#cbd5e1",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    fontWeight: 600,
                    position: "relative",
                  }}
                >
                  <span>{c.date.getDate()}</span>
                  {kind === "iss" && cap && c.inMonth && !isClosed && !isWeekend && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 500,
                        color: overCap ? "#b45309" : "#64748b",
                      }}
                    >
                      {used}/{cap}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 4 }}>
            Red = school closed · Grey = weekend · Yellow = at/over ISS capacity
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: "0.5rem 0.75rem",
              background: "#fef2f2",
              color: "#991b1b",
              borderRadius: 6,
              marginBottom: "0.75rem",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "0.5rem 1rem",
              border: "1px solid #cbd5e1",
              background: "white",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}

            disabled={saving}
            style={{
              padding: "0.5rem 1rem",
              border: "1px solid transparent",
              background: kind === "iss" ? "#ea580c" : "#dc2626",
              color: "white",
              fontWeight: 600,
              borderRadius: 6,
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : `Save ${kind.toUpperCase()} log`}
          </button>
        </div>
      </div>
    </div>
  );
}
