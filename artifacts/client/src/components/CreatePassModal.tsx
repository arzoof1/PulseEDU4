import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

export interface CreatePassStudent {
  id: number | string;
  studentId: string;
  /** District-local SIS number — student-facing credential. */
  localSisId?: string | null;
  firstName: string;
  lastName: string;
}

export interface CreatePassPayload {
  studentId: string;
  destination: string;
  originRoom: string;
  maxDurationMinutes: number;
  destinationTeacher: string | null;
  contactedAcknowledged: boolean;
  /** Teacher selected in the From combobox (admins can change this). */
  fromTeacher: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  students: CreatePassStudent[];
  destinationsByRoom: Record<string, string[]>;
  defaultOriginRoom: string;
  currentStaffUser: string;
  staffUsers: string[];
  /** Map of teacher name → their default room (used when From-teacher changes). */
  staffDefaults: Record<string, string>;
  /** When true, the user can pick a different teacher in the From combobox. */
  canChangeTeacher: boolean;
  /** Names of destinations the current teacher is configured to send to without contact-ack. */
  nearDestinations: string[];
  /** When true (e.g. Hall Pass admin), the contact-ack is never required. */
  bypassContactAck: boolean;
  /**
   * Restroom Access Control. When true, restroom-kind destinations are
   * HARD-LIMITED to the resolved allowed set (per-teacher override if the
   * teacher has one, else the origin room default). Unselected restrooms
   * are hidden entirely. Non-restroom destinations are never affected.
   */
  restroomAccessEnabled?: boolean;
  /** Every restroom-kind destination name for the school. */
  restroomNames?: string[];
  /** Per-origin-room default allowed restroom names. */
  restroomRoomDefaults?: Record<string, string[]>;
  /**
   * Per-teacher restroom override (names). A key being present means that
   * teacher has an override and inherits NOTHING from the room default.
   */
  restroomTeacherOverrides?: Record<string, string[]>;
  /** Maximum minutes a teacher can request (set in school settings). */
  maxMinutes?: number;
  /** Default starting value for the time slider. */
  defaultMinutes?: number;
  /** When true (core team), a "Log as tardy" toggle appears on step 1. */
  canLogTardy: boolean;
  /**
   * Log a tardy for this student in the given period and send them back to
   * their teacher of record. The parent owns the POST + return-pass flow.
   */
  onLogTardy: (payload: { studentId: string; period: string }) => Promise<void>;
  onCreate: (payload: CreatePassPayload) => Promise<void> | void;
}

const MIN_MIN = 1;
const FALLBACK_MAX = 30;
const FALLBACK_DEFAULT = 5;

// --- Tardy mode: bell-schedule period detection (mirrors LogTardyModal) ---
interface TardyBellPeriod {
  id: number;
  periodNumber: number;
  name: string;
  startTime: string;
  endTime: string;
}
interface TardyBellSchedule {
  id: number;
  name: string;
  kind: string;
  isDefault: boolean;
  active: boolean;
  periods: TardyBellPeriod[];
}
function tardyToMinutes(t: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function findCurrentTardyPeriod(
  schedule: TardyBellSchedule | null,
  now: Date,
): TardyBellPeriod | null {
  if (!schedule) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const p of schedule.periods) {
    const s = tardyToMinutes(p.startTime);
    const e = tardyToMinutes(p.endTime);
    if (s == null || e == null) continue;
    if (mins >= s && mins < e) return p;
  }
  return null;
}

function RoomCombobox({
  rooms,
  value,
  onChange,
}: {
  rooms: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rooms.filter((r) => r.toLowerCase().includes(q)) : rooms;
  }, [rooms, query]);

  return (
    <div className="cp-teacher-picker" ref={wrapRef}>
      {!open ? (
        <button
          type="button"
          className="cp-teacher-chip"
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
          title="Change room"
        >
          <strong>{value || "— select —"}</strong>
          <span className="cp-teacher-chip-edit">change</span>
        </button>
      ) : (
        <div className="cp-teacher-pop">
          <input
            className="cp-input cp-teacher-input"
            placeholder="Search rooms"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <ul className="cp-list cp-teacher-list">
            {filtered.map((r) => (
              <li key={r}>
                <button
                  type="button"
                  className="cp-list-item"
                  onClick={() => {
                    onChange(r);
                    setOpen(false);
                  }}
                >
                  <span className="cp-list-text">
                    <strong>{r}</strong>
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li>
                <p className="cp-empty">No rooms match.</p>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

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
  staffUsers,
  staffDefaults,
  canChangeTeacher,
  nearDestinations,
  bypassContactAck,
  restroomAccessEnabled,
  restroomNames,
  restroomRoomDefaults,
  restroomTeacherOverrides,
  maxMinutes,
  defaultMinutes,
  canLogTardy,
  onLogTardy,
  onCreate,
}: Props) {
  const MAX_MIN = Math.max(
    MIN_MIN,
    Math.min(240, Math.trunc(maxMinutes ?? FALLBACK_MAX)),
  );
  const DEFAULT_MIN = Math.max(
    MIN_MIN,
    Math.min(MAX_MIN, Math.trunc(defaultMinutes ?? FALLBACK_DEFAULT)),
  );
  // Slider tick labels scale to the configured max. Hardcoding 1/10/20/max
  // produced nonsense like "1 10 20 10" when a school's max was below 20.
  const sliderTicks = Array.from(
    new Set([
      MIN_MIN,
      Math.round(MAX_MIN / 3),
      Math.round((MAX_MIN * 2) / 3),
      MAX_MIN,
    ]),
  )
    .filter((n) => n >= MIN_MIN && n <= MAX_MIN)
    .sort((a, b) => a - b);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudent, setSelectedStudent] =
    useState<CreatePassStudent | null>(null);
  const [selectedTeacher, setSelectedTeacher] = useState(currentStaffUser);
  const [teacherQuery, setTeacherQuery] = useState("");
  const [teacherPickerOpen, setTeacherPickerOpen] = useState(false);
  const [originRoom, setOriginRoom] = useState(defaultOriginRoom);
  const [destQuery, setDestQuery] = useState("");
  const [destination, setDestination] = useState("");
  const [minutes, setMinutes] = useState<number>(DEFAULT_MIN);
  const [contactedAck, setContactedAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const studentInputRef = useRef<HTMLInputElement>(null);

  // --- Tardy mode state ---
  const [logAsTardy, setLogAsTardy] = useState(false);
  const [schedule, setSchedule] = useState<TardyBellSchedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [testTime, setTestTime] = useState("");
  const [tardyTeacher, setTardyTeacher] = useState<string | null>(null);
  const [tardyTeacherLoading, setTardyTeacherLoading] = useState(false);
  const [tardyTeacherError, setTardyTeacherError] = useState<string | null>(
    null,
  );
  const isDev = import.meta.env.DEV;

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setStudentQuery("");
    setSelectedStudent(null);
    setSelectedTeacher(currentStaffUser);
    setTeacherQuery("");
    setTeacherPickerOpen(false);
    setOriginRoom(defaultOriginRoom);
    setDestQuery("");
    setDestination("");
    setMinutes(DEFAULT_MIN);
    setContactedAck(false);
    setError(null);
    setSubmitting(false);
    setLogAsTardy(false);
    setSchedule(null);
    setNow(new Date());
    setTestTime("");
    setTardyTeacher(null);
    setTardyTeacherError(null);
    setTimeout(() => studentInputRef.current?.focus(), 50);
  }, [open, defaultOriginRoom, currentStaffUser]);

  const effectiveNow = useMemo(() => {
    if (!isDev || !testTime) return now;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(testTime);
    if (!m) return now;
    const d = new Date(now);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return d;
  }, [isDev, testTime, now]);

  const currentTardyPeriod = useMemo(
    () => findCurrentTardyPeriod(schedule, effectiveNow),
    [schedule, effectiveNow],
  );
  const tardyPeriodValue = currentTardyPeriod
    ? String(currentTardyPeriod.periodNumber)
    : "";

  // Load the default regular bell schedule once the modal opens (core team
  // only) so tardy mode can resolve the current period.
  useEffect(() => {
    if (!open || !canLogTardy) return;
    let cancelled = false;
    setScheduleLoading(true);
    (async () => {
      try {
        const r = await authFetch("/api/bell-schedules");
        if (!r.ok) throw new Error("Failed to load bell schedule.");
        const body: unknown = await r.json();
        const list: TardyBellSchedule[] = Array.isArray(body)
          ? (body as TardyBellSchedule[])
          : Array.isArray(
                (body as { schedules?: TardyBellSchedule[] })?.schedules,
              )
            ? (body as { schedules: TardyBellSchedule[] }).schedules
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
  }, [open, canLogTardy]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  // Resolve the student's teacher of record for the detected period so the
  // tardy-confirm step can show who they'll be sent back to.
  useEffect(() => {
    if (!logAsTardy || step !== 2 || !selectedStudent || !tardyPeriodValue) {
      setTardyTeacher(null);
      setTardyTeacherError(null);
      return;
    }
    let cancelled = false;
    setTardyTeacherLoading(true);
    setTardyTeacherError(null);
    (async () => {
      try {
        const r = await authFetch(
          `/api/section-lookup?studentId=${encodeURIComponent(selectedStudent.studentId)}&period=${encodeURIComponent(tardyPeriodValue)}`,
        );
        if (!r.ok) {
          if (!cancelled) {
            setTardyTeacher(null);
            setTardyTeacherError("No teacher found for this period.");
          }
          return;
        }
        const info = await r.json();
        if (!cancelled) setTardyTeacher(info.teacherName ?? null);
      } catch {
        if (!cancelled) {
          setTardyTeacher(null);
          setTardyTeacherError("Lookup failed.");
        }
      } finally {
        if (!cancelled) setTardyTeacherLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [logAsTardy, step, selectedStudent, tardyPeriodValue]);

  const allRooms = useMemo(
    () => Object.keys(destinationsByRoom).sort((a, b) => a.localeCompare(b)),
    [destinationsByRoom],
  );

  const roomAvailableDestinations = useMemo(() => {
    if (originRoom && destinationsByRoom[originRoom]) {
      return destinationsByRoom[originRoom];
    }
    const set = new Set<string>();
    for (const arr of Object.values(destinationsByRoom)) {
      for (const d of arr) set.add(d);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [destinationsByRoom, originRoom]);

  const restroomNameSet = useMemo(
    () => new Set(restroomNames ?? []),
    [restroomNames],
  );

  // Apply Restroom Access Control on top of the room's destination list.
  // When OFF (or no restrooms configured), behavior is identical to before.
  // When ON: strip every restroom-kind destination, then add back ONLY the
  // resolved allowed restrooms — the teacher's override if they have one,
  // otherwise the origin room's default restroom set. A teacher override
  // wins outright over the room default (it does not merge). Non-restroom
  // destinations pass through untouched.
  const availableDestinations = useMemo(() => {
    if (!restroomAccessEnabled || restroomNameSet.size === 0) {
      return roomAvailableDestinations;
    }
    const override = restroomTeacherOverrides?.[selectedTeacher];
    const allowed =
      override !== undefined
        ? override
        : (restroomRoomDefaults?.[originRoom] ?? []);
    const allowedRestroomSet = new Set(
      allowed.filter((d) => restroomNameSet.has(d)),
    );
    const nonRestrooms = roomAvailableDestinations.filter(
      (d) => !restroomNameSet.has(d),
    );
    const allowedRestrooms = Array.from(allowedRestroomSet);
    return [...nonRestrooms, ...allowedRestrooms].sort((a, b) =>
      a.localeCompare(b),
    );
  }, [
    roomAvailableDestinations,
    restroomAccessEnabled,
    restroomNameSet,
    restroomTeacherOverrides,
    restroomRoomDefaults,
    selectedTeacher,
    originRoom,
  ]);

  // Explicit empty-state guardrail: when Restroom Access Control is ON and
  // the resolved set for this room/teacher has no restrooms, the modal must
  // say so (and point to the admin screen) instead of silently showing none.
  const noRestroomsAvailable = useMemo(() => {
    if (!restroomAccessEnabled || restroomNameSet.size === 0) return false;
    return !availableDestinations.some((d) => restroomNameSet.has(d));
  }, [restroomAccessEnabled, restroomNameSet, availableDestinations]);

  // If the currently-picked destination is a restroom that just got
  // hidden (origin room / teacher changed, or override applied), clear it
  // so a stale, now-blocked restroom can't be submitted. Only restroom
  // destinations are touched — teacher-name and other destinations stay.
  useEffect(() => {
    if (!restroomAccessEnabled) return;
    if (
      destination &&
      restroomNameSet.has(destination) &&
      !availableDestinations.includes(destination)
    ) {
      setDestination("");
    }
  }, [
    restroomAccessEnabled,
    destination,
    restroomNameSet,
    availableDestinations,
  ]);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return students.slice(0, canChangeTeacher ? 25 : 8);
    const scored: Array<{ s: CreatePassStudent; rank: number }> = [];
    for (const s of students) {
      const first = s.firstName.toLowerCase();
      const last = s.lastName.toLowerCase();
      const localSid = (s.localSisId ?? "").toLowerCase();
      let rank = -1;
      if (first.startsWith(q) || last.startsWith(q)) rank = 0;
      else if (localSid && localSid.startsWith(q)) rank = 1;
      else if (
        first.includes(q) ||
        last.includes(q) ||
        (localSid && localSid.includes(q))
      )
        rank = 2;
      if (rank >= 0) scored.push({ s, rank });
    }
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const al = a.s.lastName.localeCompare(b.s.lastName);
      return al !== 0 ? al : a.s.firstName.localeCompare(b.s.firstName);
    });
    const matches = scored.map((x) => x.s);
    return canChangeTeacher ? matches : matches.slice(0, 50);
  }, [students, studentQuery, canChangeTeacher]);

  const nearSet = useMemo(() => {
    const set = new Set<string>();
    const source =
      nearDestinations.length > 0 ? nearDestinations : availableDestinations;
    for (const d of source) set.add(d);
    return set;
  }, [nearDestinations, availableDestinations]);

  const groupedDestinations = useMemo(() => {
    const q = destQuery.trim().toLowerCase();
    const filtered = q
      ? availableDestinations.filter((d) => d.toLowerCase().includes(q))
      : availableDestinations;
    const near = filtered.filter((d) => nearSet.has(d));
    const other = filtered.filter((d) => !nearSet.has(d));
    // Sort the "go see another teacher" group by LAST name. Display names
    // are usually "First Last" but tolerate "Last, First" too.
    const lastNameKey = (full: string) => {
      const s = full.trim();
      if (s.includes(",")) return s.split(",")[0]!.trim().toLowerCase();
      const parts = s.split(/\s+/);
      return (parts[parts.length - 1] || s).toLowerCase();
    };
    const teachers = staffUsers
      .filter((s) => s && s !== selectedTeacher)
      .filter((s) => !q || s.toLowerCase().includes(q))
      .sort((a, b) => {
        const k = lastNameKey(a).localeCompare(lastNameKey(b));
        return k !== 0 ? k : a.localeCompare(b);
      });
    return { near, other, teachers };
  }, [availableDestinations, destQuery, nearSet, staffUsers, selectedTeacher]);

  const filteredTeachers = useMemo(() => {
    const q = teacherQuery.trim().toLowerCase();
    const list = q
      ? staffUsers.filter((s) => s.toLowerCase().includes(q))
      : staffUsers;
    return list.slice(0, 8);
  }, [staffUsers, teacherQuery]);

  const pickTeacher = (name: string) => {
    setSelectedTeacher(name);
    const def = staffDefaults[name];
    if (def) {
      setOriginRoom(def);
      setDestination("");
    }
    setTeacherQuery("");
    setTeacherPickerOpen(false);
  };

  if (!open) return null;

  const isOffRoute = Boolean(destination) && !nearSet.has(destination);
  const showContactAck = isOffRoute && !bypassContactAck;
  const needsContactAck = showContactAck && !contactedAck;

  const handleSend = async () => {
    if (!selectedStudent || !destination) return;
    if (!originRoom) {
      setError(
        "Pick an origin room before sending. (Set a default room in Staff Defaults to skip this step.)",
      );
      return;
    }
    if (needsContactAck) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        studentId: selectedStudent.studentId,
        destination,
        originRoom,
        maxDurationMinutes: minutes,
        destinationTeacher: null,
        contactedAcknowledged: showContactAck ? contactedAck : false,
        fromTeacher: selectedTeacher,
      });
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create pass.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogTardy = async () => {
    if (!selectedStudent || !tardyPeriodValue) return;
    setSubmitting(true);
    setError(null);
    try {
      await onLogTardy({
        studentId: selectedStudent.studentId,
        period: tardyPeriodValue,
      });
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to log tardy.";
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
            {step === 2 && (logAsTardy ? "Confirm Tardy" : "Where to?")}
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
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                name="cp-student-search"
              />
              {canLogTardy && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    margin: "0.5rem 0 0.25rem",
                    fontSize: "0.9rem",
                    color: "#334155",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={logAsTardy}
                    onChange={(e) => setLogAsTardy(e.target.checked)}
                  />
                  Log as tardy — send to current-period teacher
                </label>
              )}
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
                        <span className="cp-list-sub">{s.localSisId ?? "—"}</span>
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

          {step === 2 && selectedStudent && logAsTardy && (
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
                  <strong>{selectedStudent.localSisId ?? "—"}</strong>
                </div>
                <div className="cp-context-row">
                  <span className="cp-context-label">Period</span>
                  <strong>
                    {scheduleLoading
                      ? "Loading…"
                      : currentTardyPeriod
                        ? `${currentTardyPeriod.periodNumber}${currentTardyPeriod.name ? ` · ${currentTardyPeriod.name}` : ""}`
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
                    {!tardyPeriodValue
                      ? "—"
                      : tardyTeacherLoading
                        ? "Looking up…"
                        : tardyTeacher
                          ? tardyTeacher
                          : tardyTeacherError || "—"}
                  </strong>
                </div>
              </div>

              {!tardyPeriodValue && !scheduleLoading && (
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

              <p
                style={{
                  margin: "0.75rem 0 0",
                  color: "#64748b",
                  fontSize: "0.85rem",
                }}
              >
                We'll log the tardy and send {selectedStudent.firstName} back to
                their current-period teacher.
              </p>

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
                  disabled={!tardyPeriodValue || submitting}
                  onClick={handleLogTardy}
                  style={{ opacity: !tardyPeriodValue || submitting ? 0.6 : 1 }}
                >
                  {submitting ? "Saving…" : "Log Tardy & Send to Class"}
                </button>
              </div>
            </>
          )}

          {step === 2 && selectedStudent && !logAsTardy && (
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
                  {canChangeTeacher ? (
                    <div className="cp-teacher-picker">
                      {!teacherPickerOpen ? (
                        <button
                          type="button"
                          className="cp-teacher-chip"
                          onClick={() => setTeacherPickerOpen(true)}
                          title="Change teacher"
                        >
                          <strong>{selectedTeacher}</strong>
                          <span className="cp-teacher-chip-edit">change</span>
                        </button>
                      ) : (
                        <div className="cp-teacher-pop">
                          <input
                            className="cp-input cp-teacher-input"
                            placeholder="Search teachers"
                            value={teacherQuery}
                            onChange={(e) => setTeacherQuery(e.target.value)}
                            autoFocus
                          />
                          <ul className="cp-list cp-teacher-list">
                            {filteredTeachers.map((name) => (
                              <li key={name}>
                                <button
                                  type="button"
                                  className="cp-list-item"
                                  onClick={() => pickTeacher(name)}
                                >
                                  <span className="cp-list-text">
                                    <strong>{name}</strong>
                                    {staffDefaults[name] && (
                                      <span className="cp-list-sub">
                                        {staffDefaults[name]}
                                      </span>
                                    )}
                                  </span>
                                </button>
                              </li>
                            ))}
                            {filteredTeachers.length === 0 && (
                              <li>
                                <p className="cp-empty">No teachers match.</p>
                              </li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <strong>{selectedTeacher}</strong>
                  )}
                </div>
                {allRooms.length > 0 && (
                  <div className="cp-context-row">
                    <span className="cp-context-label">Room</span>
                    {canChangeTeacher ? (
                      <RoomCombobox
                        rooms={allRooms}
                        value={originRoom}
                        onChange={(r) => {
                          setOriginRoom(r);
                          setDestination("");
                        }}
                      />
                    ) : (
                      <strong>{originRoom || "—"}</strong>
                    )}
                  </div>
                )}
              </div>

              <input
                className="cp-input"
                placeholder="Search destinations"
                value={destQuery}
                onChange={(e) => setDestQuery(e.target.value)}
              />
              <div className="cp-groups">
                  {groupedDestinations.near.length > 0 && (
                    <>
                      <div className="cp-group-label">Your locations</div>
                      <ul className="cp-list">
                        {groupedDestinations.near.map((d) => (
                          <li key={d}>
                            <button
                              type="button"
                              className="cp-list-item"
                              onClick={() => {
                                setDestination(d);
                                setContactedAck(false);
                                setStep(3);
                              }}
                            >
                              <span
                                className="cp-dest-dot cp-dest-dot-near"
                                aria-hidden="true"
                              />
                              <span className="cp-list-text">
                                <strong>{d}</strong>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {groupedDestinations.other.length > 0 && (
                    <>
                      <div className="cp-group-label">Other common areas</div>
                      <ul className="cp-list">
                        {groupedDestinations.other.map((d) => (
                          <li key={d}>
                            <button
                              type="button"
                              className="cp-list-item"
                              onClick={() => {
                                setDestination(d);
                                setContactedAck(false);
                                setStep(3);
                              }}
                            >
                              <span
                                className="cp-dest-dot cp-dest-dot-other"
                                aria-hidden="true"
                              />
                              <span className="cp-list-text">
                                <strong>{d}</strong>
                                {!bypassContactAck && (
                                  <span className="cp-list-sub">
                                    Requires contact confirmation
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {groupedDestinations.teachers.length > 0 && (
                    <>
                      <div className="cp-group-label">Additional or other</div>
                      <ul className="cp-list">
                        {groupedDestinations.teachers.map((name) => (
                          <li key={`t:${name}`}>
                            <button
                              type="button"
                              className="cp-list-item"
                              onClick={() => {
                                setDestination(name);
                                setContactedAck(false);
                                setStep(3);
                              }}
                            >
                              <span
                                className="cp-dest-dot cp-dest-dot-near"
                                aria-hidden="true"
                              />
                              <span className="cp-list-text">
                                <strong>{name}</strong>
                                {staffDefaults[name] && (
                                  <span className="cp-list-sub">
                                    {staffDefaults[name]}
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {noRestroomsAvailable && (
                    <p className="cp-empty">
                      No restrooms are available for this room
                      {selectedTeacher ? ` / ${selectedTeacher}` : ""}. An admin
                      can enable them under Settings → Restroom Access.
                    </p>
                  )}
                  {groupedDestinations.near.length === 0 &&
                    groupedDestinations.other.length === 0 &&
                    groupedDestinations.teachers.length === 0 &&
                    !noRestroomsAvailable && (
                      <p className="cp-empty">No destinations match.</p>
                    )}
                </div>
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
                  <strong>
                    {selectedTeacher}
                    {originRoom && originRoom !== selectedTeacher
                      ? ` — ${originRoom}`
                      : ""}
                  </strong>
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
                  {sliderTicks.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              </div>

              {showContactAck && (
                <div className="cp-offroute">
                  <div className="cp-offroute-title">
                    Off‑route destination
                  </div>
                  <p className="cp-offroute-text">
                    {destination} isn't on your saved locations. Please contact
                    someone there before sending.
                  </p>
                  <label className="cp-ack">
                    <input
                      type="checkbox"
                      checked={contactedAck}
                      onChange={(e) => setContactedAck(e.target.checked)}
                    />
                    <span>I've contacted them</span>
                  </label>
                </div>
              )}

              {error && <div className="cp-error">{error}</div>}

              <button
                type="button"
                className="cp-send"
                onClick={handleSend}
                disabled={submitting || needsContactAck}
                title={
                  needsContactAck
                    ? "Confirm you've contacted the destination to enable."
                    : undefined
                }
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
