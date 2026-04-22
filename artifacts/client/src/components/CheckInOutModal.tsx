import { useEffect, useMemo, useRef, useState } from "react";

export interface CheckInStudent {
  id: number | string;
  studentId: string;
  firstName: string;
  lastName: string;
}

export interface CheckInOutPayload {
  studentId: string;
  entryType: "checkin" | "checkout";
  checkInWith: string;
  notes: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  students: CheckInStudent[];
  currentUser: string;
  onSubmit: (payload: CheckInOutPayload) => Promise<void> | void;
}

export default function CheckInOutModal({
  open,
  onClose,
  students,
  currentUser,
  onSubmit,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [entryType, setEntryType] = useState<"checkin" | "checkout">("checkin");
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<CheckInStudent | null>(
    null,
  );
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const studentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setEntryType("checkin");
    setStudentQuery("");
    setSelectedStudent(null);
    setNotes("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (step === 2) {
      setTimeout(() => studentInputRef.current?.focus(), 50);
    }
  }, [step]);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return students.slice(0, 25);
    const scored: Array<{ s: CheckInStudent; rank: number }> = [];
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

  const handleSubmit = async (student: CheckInStudent) => {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        studentId: student.studentId,
        entryType,
        checkInWith: currentUser,
        notes,
      });
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to log entry.";
      setError(msg);
      setStep(3);
    } finally {
      setSubmitting(false);
    }
  };

  const goBack = () => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s));

  return (
    <div
      className="cp-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Log Check-In or Check-Out"
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
            {step === 1 && "Check-In or Check-Out?"}
            {step === 2 && "Select Student"}
            {step === 3 && (entryType === "checkin" ? "Confirm Check-In" : "Confirm Check-Out")}
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
            <ul className="cp-list">
              <li>
                <button
                  type="button"
                  className="cp-list-item"
                  onClick={() => {
                    setEntryType("checkin");
                    setStep(2);
                  }}
                >
                  <span
                    className="cp-dest-dot cp-dest-dot-near"
                    aria-hidden="true"
                  />
                  <span className="cp-list-text">
                    <strong>Check-In</strong>
                    <span className="cp-list-sub">
                      Student arriving from off-campus or starting their day
                    </span>
                  </span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="cp-list-item"
                  onClick={() => {
                    setEntryType("checkout");
                    setStep(2);
                  }}
                >
                  <span
                    className="cp-dest-dot cp-dest-dot-other"
                    aria-hidden="true"
                  />
                  <span className="cp-list-text">
                    <strong>Check-Out</strong>
                    <span className="cp-list-sub">
                      Student leaving campus early
                    </span>
                  </span>
                </button>
              </li>
            </ul>
          )}

          {step === 2 && (
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
                      disabled={submitting}
                      onClick={() => {
                        setSelectedStudent(s);
                        handleSubmit(s);
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

          {step === 3 && selectedStudent && (
            <>
              <div className="cp-context">
                <div className="cp-context-row">
                  <span className="cp-context-label">Student</span>
                  <strong>
                    {selectedStudent.firstName} {selectedStudent.lastName}
                  </strong>
                </div>
                <div className="cp-context-row">
                  <span className="cp-context-label">Type</span>
                  <strong>
                    {entryType === "checkin" ? "Check-In" : "Check-Out"}
                  </strong>
                </div>
              </div>

              <div className="cp-time">
                <div className="cp-time-label">
                  {entryType === "checkin" ? "Checking in with" : "Checking out with"}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  {checkInWithOptions.map((opt) => {
                    const active = checkInWith === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setCheckInWith(opt)}
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
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  marginTop: "1rem",
                  fontSize: "0.85rem",
                  color: "#475569",
                  gap: 4,
                }}
              >
                Notes (optional)
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="cp-input"
                />
              </label>

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
                  disabled={!checkInWith || submitting}
                  onClick={handleSubmit}
                  style={{ opacity: !checkInWith || submitting ? 0.6 : 1 }}
                >
                  {submitting
                    ? "Saving…"
                    : entryType === "checkin"
                      ? "Log Check-In"
                      : "Log Check-Out"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
