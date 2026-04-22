import { useEffect, useMemo, useRef, useState } from "react";

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

interface Props {
  open: boolean;
  onClose: () => void;
  students: TardyStudent[];
  periods: string[];
  onSubmit: (payload: LogTardyPayload) => Promise<void> | void;
}

export default function LogTardyModal({
  open,
  onClose,
  students,
  periods,
  onSubmit,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<TardyStudent | null>(
    null,
  );
  const [period, setPeriod] = useState<string>("");
  const [createReturnPass, setCreateReturnPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const studentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setStudentQuery("");
    setSelectedStudent(null);
    setPeriod("");
    setCreateReturnPass(false);
    setError(null);
    setSubmitting(false);
    setTimeout(() => studentInputRef.current?.focus(), 50);
  }, [open]);

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
    if (!selectedStudent || !period) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        studentId: selectedStudent.studentId,
        period,
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
            {step === 2 && "Which Period?"}
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
              </div>

              <div className="cp-time">
                <div className="cp-time-label">Period</div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  {periods.map((p) => {
                    const active = period === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPeriod(p)}
                        style={{
                          padding: "0.6rem 1rem",
                          borderRadius: 999,
                          border: active
                            ? "2px solid #0f766e"
                            : "1px solid #cbd5e1",
                          background: active ? "#ccfbf1" : "white",
                          color: active ? "#0f766e" : "#1e293b",
                          fontWeight: active ? 700 : 500,
                          fontSize: "0.95rem",
                          cursor: "pointer",
                          minWidth: 56,
                        }}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>

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
                  We'll look up the teacher for that period from the student's
                  schedule.
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
                  disabled={!period || submitting}
                  onClick={handleSubmit}
                  style={{ opacity: !period || submitting ? 0.6 : 1 }}
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
