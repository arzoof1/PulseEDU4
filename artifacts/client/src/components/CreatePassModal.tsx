import { useEffect, useMemo, useRef, useState } from "react";

export interface CreatePassStudent {
  id: number | string;
  studentId: string;
  firstName: string;
  lastName: string;
}

export interface CreatePassPayload {
  studentId: string;
  destination: string;
  originRoom: string;
  maxDurationMinutes: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  students: CreatePassStudent[];
  destinationsByRoom: Record<string, string[]>;
  defaultOriginRoom: string;
  currentStaffUser: string;
  onCreate: (payload: CreatePassPayload) => Promise<void> | void;
}

const MIN_MIN = 1;
const MAX_MIN = 30;
const DEFAULT_MIN = 5;

const EkgBar = () => (
  <svg
    className="cp-ekg"
    viewBox="0 0 200 12"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path
      d="M0 6 L40 6 L46 2 L52 10 L58 6 L100 6 L106 1 L112 11 L118 6 L200 6"
      fill="none"
      stroke="var(--accent, #ef4444)"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.7"
    />
  </svg>
);

export default function CreatePassModal({
  open,
  onClose,
  students,
  destinationsByRoom,
  defaultOriginRoom,
  currentStaffUser,
  onCreate,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudent, setSelectedStudent] =
    useState<CreatePassStudent | null>(null);
  const [originRoom, setOriginRoom] = useState(defaultOriginRoom);
  const [destQuery, setDestQuery] = useState("");
  const [destination, setDestination] = useState("");
  const [minutes, setMinutes] = useState<number>(DEFAULT_MIN);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const studentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setStudentQuery("");
    setSelectedStudent(null);
    setOriginRoom(defaultOriginRoom);
    setDestQuery("");
    setDestination("");
    setMinutes(DEFAULT_MIN);
    setError(null);
    setSubmitting(false);
    setTimeout(() => studentInputRef.current?.focus(), 50);
  }, [open, defaultOriginRoom]);

  const allRooms = useMemo(
    () => Object.keys(destinationsByRoom).sort((a, b) => a.localeCompare(b)),
    [destinationsByRoom],
  );

  const availableDestinations = useMemo(() => {
    if (originRoom && destinationsByRoom[originRoom]) {
      return destinationsByRoom[originRoom];
    }
    const set = new Set<string>();
    for (const arr of Object.values(destinationsByRoom)) {
      for (const d of arr) set.add(d);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [destinationsByRoom, originRoom]);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return students.slice(0, 8);
    return students
      .filter(
        (s) =>
          s.firstName.toLowerCase().includes(q) ||
          s.lastName.toLowerCase().includes(q) ||
          s.studentId.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [students, studentQuery]);

  const filteredDestinations = useMemo(() => {
    const q = destQuery.trim().toLowerCase();
    if (!q) return availableDestinations;
    return availableDestinations.filter((d) => d.toLowerCase().includes(q));
  }, [availableDestinations, destQuery]);

  if (!open) return null;

  const handleSend = async () => {
    if (!selectedStudent || !destination || !originRoom) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        studentId: selectedStudent.studentId,
        destination,
        originRoom,
        maxDurationMinutes: minutes,
      });
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create pass.";
      setError(msg);
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
      aria-label="Create Hall Pass"
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
            {step === 2 && "Where to?"}
            {step === 3 && "How long?"}
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
        <EkgBar />

        <div className="cp-body">
          {step === 1 && (
            <>
              <input
                ref={studentInputRef}
                className="cp-input cp-input-lg"
                placeholder="Student name or ID"
                value={studentQuery}
                onChange={(e) => setStudentQuery(e.target.value)}
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
                  <span className="cp-context-label">From</span>
                  {allRooms.length > 0 ? (
                    <select
                      className="cp-room-select"
                      value={originRoom}
                      onChange={(e) => {
                        setOriginRoom(e.target.value);
                        setDestination("");
                      }}
                    >
                      <option value="">— select origin —</option>
                      {allRooms.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <strong>{originRoom || currentStaffUser}</strong>
                  )}
                </div>
              </div>

              <input
                className="cp-input"
                placeholder="Search destinations"
                value={destQuery}
                onChange={(e) => setDestQuery(e.target.value)}
                disabled={!originRoom}
              />
              {!originRoom && (
                <p className="cp-empty">Select an origin room to continue.</p>
              )}
              <ul className="cp-list">
                {originRoom &&
                  filteredDestinations.map((d) => (
                    <li key={d}>
                      <button
                        type="button"
                        className="cp-list-item"
                        onClick={() => {
                          setDestination(d);
                          setStep(3);
                        }}
                      >
                        <span className="cp-dest-dot" aria-hidden="true" />
                        <span className="cp-list-text">
                          <strong>{d}</strong>
                        </span>
                      </button>
                    </li>
                  ))}
                {originRoom && filteredDestinations.length === 0 && (
                  <li className="cp-empty">No destinations match.</li>
                )}
              </ul>
            </>
          )}

          {step === 3 && selectedStudent && destination && (
            <>
              <div className="cp-context">
                <div className="cp-context-row">
                  <span className="cp-context-label">Student</span>
                  <strong>
                    {selectedStudent.firstName} {selectedStudent.lastName}
                  </strong>
                </div>
                <div className="cp-context-row">
                  <span className="cp-context-label">From</span>
                  <strong>{originRoom}</strong>
                </div>
                <div className="cp-context-row">
                  <span className="cp-context-label">To</span>
                  <strong>{destination}</strong>
                </div>
              </div>

              <div className="cp-time">
                <div className="cp-time-label">
                  How much time does the student need?
                </div>
                <div className="cp-time-value">
                  {minutes} <span className="cp-time-unit">min</span>
                </div>
                <input
                  className="cp-slider"
                  type="range"
                  min={MIN_MIN}
                  max={MAX_MIN}
                  step={1}
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                  aria-label="Pass duration in minutes"
                />
                <div className="cp-slider-ticks">
                  <span>{MIN_MIN}</span>
                  <span>10</span>
                  <span>20</span>
                  <span>{MAX_MIN}</span>
                </div>
              </div>

              {error && <div className="cp-error">{error}</div>}

              <button
                type="button"
                className="cp-send"
                onClick={handleSend}
                disabled={submitting}
              >
                {submitting ? "Sending…" : "Send Pass ›"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
