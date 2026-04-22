import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

export interface TardyStudent {
  id: number | string;
  studentId: string;
  firstName: string;
  lastName: string;
}

export interface LogTardyPayload {
  studentId: string;
  period: string;
  createReturnPass: boolean;
}

interface BellPeriod {
  id: number;
  periodNumber: number;
  name: string;
  startTime: string;
  endTime: string;
}

interface BellSchedule {
  id: number;
  name: string;
  kind: string;
  isDefault: boolean;
  active: boolean;
  periods: BellPeriod[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  students: TardyStudent[];
  onSubmit: (payload: LogTardyPayload) => Promise<void> | void;
}

function toMinutes(t: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function findCurrentPeriod(
  schedule: BellSchedule | null,
  now: Date,
): BellPeriod | null {
  if (!schedule) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const p of schedule.periods) {
    const s = toMinutes(p.startTime);
    const e = toMinutes(p.endTime);
    if (s == null || e == null) continue;
    if (mins >= s && mins < e) return p;
  }
  return null;
}

export default function LogTardyModal({
  open,
  onClose,
  students,
  onSubmit,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<TardyStudent | null>(
    null,
  );
  const [createReturnPass, setCreateReturnPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const studentInputRef = useRef<HTMLInputElement>(null);

  const [schedule, setSchedule] = useState<BellSchedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [testTime, setTestTime] = useState<string>("");
  const isDev = import.meta.env.DEV;
  const effectiveNow = useMemo(() => {
    if (!isDev || !testTime) return now;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(testTime);
    if (!m) return now;
    const d = new Date(now);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return d;
  }, [isDev, testTime, now]);

  const [teacherName, setTeacherName] = useState<string | null>(null);
  const [teacherLoading, setTeacherLoading] = useState(false);
  const [teacherError, setTeacherError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setStudentQuery("");
    setSelectedStudent(null);
    setCreateReturnPass(false);
    setError(null);
    setSubmitting(false);
    setTeacherName(null);
    setTeacherError(null);
    setSchedule(null);
    setNow(new Date());
    setTimeout(() => studentInputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setScheduleLoading(true);
    (async () => {
      try {
        const r = await authFetch("/api/bell-schedules");
        if (!r.ok) throw new Error("Failed to load bell schedule.");
        const body: unknown = await r.json();
        const list: BellSchedule[] = Array.isArray(body)
          ? (body as BellSchedule[])
          : Array.isArray(
                (body as { schedules?: BellSchedule[] })?.schedules,
              )
            ? ((body as { schedules: BellSchedule[] }).schedules)
            : [];
        const regular =
          list.find((s) => s.kind === "regular" && s.isDefault && s.active) ||
          list.find((s) => s.kind === "regular" && s.active) ||
          list.find((s) => s.kind === "regular") ||
          null;
        if (!cancelled) setSchedule(regular);
      } catch {
        if (!cancelled) setSchedule(null);
      } finally {
        if (!cancelled) setScheduleLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  const currentPeriod = useMemo(
    () => findCurrentPeriod(schedule, effectiveNow),
    [schedule, effectiveNow],
  );
  const periodValue = currentPeriod
    ? String(currentPeriod.periodNumber)
    : "";

  useEffect(() => {
    if (!open || step !== 2 || !selectedStudent || !periodValue) {
      setTeacherName(null);
      setTeacherError(null);
      return;
    }
    let cancelled = false;
    setTeacherLoading(true);
    setTeacherError(null);
    (async () => {
      try {
        const r = await authFetch(
          `/api/section-lookup?studentId=${encodeURIComponent(selectedStudent.studentId)}&period=${encodeURIComponent(periodValue)}`,
        );
        if (!r.ok) {
          if (!cancelled) {
            setTeacherName(null);
            setTeacherError("No teacher found for this period.");
          }
          return;
        }
        const info = await r.json();
        if (!cancelled) setTeacherName(info.teacherName ?? null);
      } catch {
        if (!cancelled) {
          setTeacherName(null);
          setTeacherError("Lookup failed.");
        }
      } finally {
        if (!cancelled) setTeacherLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, step, selectedStudent, periodValue]);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return students.slice(0, 25);
    const scored: Array<{ s: TardyStudent; rank: number }> = [];
    for (const s of students) {
      const first = s.firstName.toLowerCase();
      const last = s.lastName.toLowerCase();
      const sid = s.studentId.toLowerCase();
      let rank = -1;
      if (first.startsWith(q) || last.startsWith(q)) rank = 0;
      else if (sid.startsWith(q)) rank = 1;
      else if (first.includes(q) || last.includes(q) || sid.includes(q))
        rank = 2;
      if (rank >= 0) scored.push({ s, rank });
    }
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const al = a.s.lastName.localeCompare(b.s.lastName);
      return al !== 0 ? al : a.s.firstName.localeCompare(b.s.firstName);
    });
    return scored.map((x) => x.s);
  }, [students, studentQuery]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!selectedStudent || !periodValue) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        studentId: selectedStudent.studentId,
        period: periodValue,
        createReturnPass,
      });
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to log tardy.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const goBack = () => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2) : s));

  return (
    <div
      className="cp-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Log Tardy"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cp-card">
        <div className="cp-header">
          {step > 1 ? (
            <button
              type="button"
              className="cp-back"
              onClick={goBack}
              aria-label="Back"
            >
              ‹
            </button>
          ) : (
            <span className="cp-back cp-back-spacer" aria-hidden="true" />
          )}
          <div className="cp-title">
            {step === 1 && "Select Student"}
            {step === 2 && "Confirm Tardy"}
          </div>
          <button
            type="button"
            className="cp-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="cp-body">
          {step === 1 && (
            <>
              <input
                ref={studentInputRef}
                className="cp-input cp-input-lg"
                placeholder="Student name or ID"
                value={studentQuery}
                onChange={(e) => setStudentQuery(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <ul className="cp-list">
                {filteredStudents.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="cp-list-item"
                      onClick={() => {
                        setSelectedStudent(s);
                        setStep(2);
                      }}
                    >
                      <span className="cp-avatar" aria-hidden="true">
                        {s.firstName.charAt(0)}
                        {s.lastName.charAt(0)}
                      </span>
                      <span className="cp-list-text">
                        <strong>
                          {s.firstName} {s.lastName}
                        </strong>
                        <span className="cp-list-sub">{s.studentId}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {filteredStudents.length === 0 && (
                  <li className="cp-empty">No students match.</li>
                )}
              </ul>
            </>
          )}

          {step === 2 && selectedStudent && (
            <>
              <div className="cp-context">
                <div className="cp-context-row">
                  <span className="cp-context-label">Student</span>
                  <strong>
                    {selectedStudent.firstName} {selectedStudent.lastName}
                  </strong>
                </div>
                <div className="cp-context-row">
                  <span className="cp-context-label">ID</span>
                  <strong>{selectedStudent.studentId}</strong>
                </div>
                <div className="cp-context-row">
                  <span className="cp-context-label">Period</span>
                  <strong>
                    {scheduleLoading
                      ? "Loading…"
                      : currentPeriod
                        ? `${currentPeriod.periodNumber}${currentPeriod.name ? ` · ${currentPeriod.name}` : ""}`
                        : "No active period"}
                  </strong>
                </div>
                {isDev && (
                  <div className="cp-context-row">
                    <span className="cp-context-label">Test time (dev)</span>
                    <input
                      type="time"
                      value={testTime}
                      onChange={(e) => setTestTime(e.target.value)}
                      style={{
                        padding: "0.25rem 0.5rem",
                        border: "1px dashed #f59e0b",
                        borderRadius: 4,
                        fontSize: "0.85rem",
                        background: "#fffbeb",
                      }}
                      title="Dev only — overrides current time so you can test outside school hours."
                    />
                  </div>
                )}
                <div className="cp-context-row">
                  <span className="cp-context-label">Teacher</span>
                  <strong>
                    {!periodValue
                      ? "—"
                      : teacherLoading
                        ? "Looking up…"
                        : teacherName
                          ? teacherName
                          : teacherError || "—"}
                  </strong>
                </div>
              </div>

              {!periodValue && !scheduleLoading && (
                <p
                  style={{
                    margin: "0.75rem 0 0",
                    color: "#b91c1c",
                    fontSize: "0.85rem",
                  }}
                >
                  The current time isn't inside any period of the regular bell
                  schedule. Wait for the next period to start, or update the
                  bell schedule.
                </p>
              )}

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginTop: "1rem",
                  fontSize: "0.95rem",
                }}
              >
                <input
                  type="checkbox"
                  checked={createReturnPass}
                  onChange={(e) => setCreateReturnPass(e.target.checked)}
                />
                Create return pass to class
              </label>
              {createReturnPass && (
                <p
                  style={{
                    margin: "0.25rem 0 0 1.65rem",
                    color: "#64748b",
                    fontSize: "0.8rem",
                  }}
                >
                  We'll send the student back to the teacher shown above.
                </p>
              )}

              {error && (
                <p
                  style={{
                    color: "#b91c1c",
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    padding: "0.5rem 0.75rem",
                    borderRadius: 6,
                    marginTop: "0.75rem",
                  }}
                >
                  {error}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.5rem",
                  marginTop: "1rem",
                }}
              >
                <button
                  type="button"
                  className="cp-cta-button"
                  disabled={!periodValue || submitting}
                  onClick={handleSubmit}
                  style={{
                    opacity: !periodValue || submitting ? 0.6 : 1,
                  }}
                >
                  {submitting ? "Saving…" : "Log Tardy"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
