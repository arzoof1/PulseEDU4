// Student Support Meetings (v1).
//
// Organizers (Core Team + counselors) schedule support meetings (504 / IEP /
// MTSS / parent conference) for a student. The student's schedule teachers
// are auto-added as attendees; the organizer can add/remove staff. Teachers
// see their meetings here, Confirm or mark Unable to Attend, and — when
// declining — are prompted for the structured feedback form so their input
// still reaches the meeting.
//
// Tabs: "My Meetings" (every staff member) and "Manage" (organizers only:
// school-wide list + create/edit/cancel/remind).

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import StudentPicker from "./StudentPicker";
import { TeacherPicker, type TeacherOpt } from "./TeacherPicker";

// ---------------------------------------------------------------------------
// Types (mirror the /api/support-meetings JSON shapes)
// ---------------------------------------------------------------------------

interface MeetingListItem {
  id: number;
  meetingType: string;
  studentName: string;
  grade: number | null;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string | null;
  location: string;
  virtualLink: string;
  status: "scheduled" | "canceled" | "completed";
  organizerStaffId: number;
  organizerName: string;
  counts: {
    attendees: number;
    confirmed: number;
    declined: number;
    pending: number;
    feedback: number;
  };
  my: { response: string; feedbackSubmitted: boolean } | null;
}

interface MeetingDetail {
  meeting: {
    id: number;
    meetingType: string;
    studentId: string;
    studentName: string;
    grade: number | null;
    date: string;
    startTime: string;
    endTime: string | null;
    location: string;
    virtualLink: string;
    notes: string;
    status: string;
    organizerStaffId: number;
    organizerName: string;
  };
  attendees: {
    staffId: number;
    displayName: string;
    fromSchedule: boolean;
    response: string;
    respondedAt: string | null;
    remindedAt: string | null;
    feedbackSubmitted: boolean;
  }[];
  feedback: {
    staffId: number;
    displayName: string;
    academicPerformance: string;
    strengths: string;
    concerns: string;
    accommodations: string;
    recommendations: string;
    additional: string;
    updatedAt: string;
  }[];
  my: {
    staffId: number;
    isAttendee: boolean;
    response: string | null;
    feedbackSubmitted: boolean;
    canEdit: boolean;
  };
}

interface StudentHit {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number | null;
}

interface ScheduleTeacher {
  staffId: number;
  displayName: string;
  sections: { period: number | null; courseName: string | null }[];
}

const FEEDBACK_FIELDS: { key: FeedbackKey; label: string }[] = [
  { key: "academicPerformance", label: "Current academic performance" },
  { key: "strengths", label: "Strengths observed" },
  { key: "concerns", label: "Concerns" },
  { key: "accommodations", label: "Accommodations working well" },
  { key: "recommendations", label: "Recommendations" },
  { key: "additional", label: "Anything else the team should know" },
];
type FeedbackKey =
  | "academicPerformance"
  | "strengths"
  | "concerns"
  | "accommodations"
  | "recommendations"
  | "additional";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtTime(t: string | null): string {
  if (!t) return "";
  const [h, min] = t.split(":").map(Number);
  if (h == null || Number.isNaN(h)) return t;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min ?? 0).padStart(2, "0")} ${ampm}`;
}

const statusChip: Record<string, { label: string; bg: string; fg: string }> = {
  scheduled: { label: "Scheduled", bg: "#dbeafe", fg: "#1d4ed8" },
  completed: { label: "Completed", bg: "#dcfce7", fg: "#15803d" },
  canceled: { label: "Canceled", bg: "#fee2e2", fg: "#b91c1c" },
};

function Chip({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span
      style={{
        background: bg,
        color: fg,
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: "0.75rem",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function responseChip(response: string) {
  if (response === "confirmed")
    return <Chip label="Confirmed" bg="#dcfce7" fg="#15803d" />;
  if (response === "declined")
    return <Chip label="Unable to attend" bg="#fef3c7" fg="#b45309" />;
  return <Chip label="No response yet" bg="#f1f5f9" fg="#475569" />;
}

const cardStyle: React.CSSProperties = {
  background: "var(--surface, #fff)",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 12,
  padding: 16,
};

const btn: React.CSSProperties = {
  border: "1px solid var(--border, #cbd5e1)",
  borderRadius: 8,
  padding: "6px 14px",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
  background: "var(--surface, #fff)",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "#2563eb",
  borderColor: "#2563eb",
  color: "#fff",
};
const inputStyle: React.CSSProperties = {
  border: "1px solid var(--border, #cbd5e1)",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: "0.9rem",
  width: "100%",
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 700,
  marginBottom: 4,
  display: "block",
};

// ---------------------------------------------------------------------------
// Feedback form (used from decline flow AND the "Add feedback" button)
// ---------------------------------------------------------------------------

function FeedbackForm({
  meetingId,
  initial,
  onDone,
  onCancel,
}: {
  meetingId: number;
  initial?: Partial<Record<FeedbackKey, string>>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<FeedbackKey, string>>({
    academicPerformance: initial?.academicPerformance ?? "",
    strengths: initial?.strengths ?? "",
    concerns: initial?.concerns ?? "",
    accommodations: initial?.accommodations ?? "",
    recommendations: initial?.recommendations ?? "",
    additional: initial?.additional ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await authFetch(`/api/support-meetings/${meetingId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error || "Could not save feedback");
        return;
      }
      onDone();
    } catch {
      setError("Could not save feedback");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {FEEDBACK_FIELDS.map((f) => (
        <div key={f.key}>
          <label style={labelStyle}>{f.label}</label>
          <textarea
            value={values[f.key]}
            onChange={(e) =>
              setValues((v) => ({ ...v, [f.key]: e.target.value }))
            }
            rows={2}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </div>
      ))}
      {error && (
        <div style={{ color: "#b91c1c", fontSize: "0.85rem" }}>{error}</div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={btn} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" style={btnPrimary} onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Submit Feedback"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit meeting form (organizer)
// ---------------------------------------------------------------------------

function MeetingForm({
  meetingTypes,
  editing,
  onDone,
  onCancel,
}: {
  meetingTypes: string[];
  editing: MeetingDetail | null; // null = create
  onDone: () => void;
  onCancel: () => void;
}) {
  const [meetingType, setMeetingType] = useState(
    editing?.meeting.meetingType ?? "",
  );
  const [student, setStudent] = useState<StudentHit | null>(
    editing
      ? {
          studentId: editing.meeting.studentId,
          localSisId: null,
          firstName: editing.meeting.studentName,
          lastName: "",
          grade: editing.meeting.grade,
        }
      : null,
  );
  const [date, setDate] = useState(editing?.meeting.date ?? "");
  const [startTime, setStartTime] = useState(editing?.meeting.startTime ?? "");
  const [endTime, setEndTime] = useState(editing?.meeting.endTime ?? "");
  const [location, setLocation] = useState(editing?.meeting.location ?? "");
  const [virtualLink, setVirtualLink] = useState(
    editing?.meeting.virtualLink ?? "",
  );
  const [notes, setNotes] = useState(editing?.meeting.notes ?? "");
  const [attendees, setAttendees] = useState<
    { staffId: number; displayName: string; fromSchedule: boolean }[]
  >(
    editing
      ? editing.attendees.map((a) => ({
          staffId: a.staffId,
          displayName: a.displayName,
          fromSchedule: a.fromSchedule,
        }))
      : [],
  );
  const [staffOptions, setStaffOptions] = useState<TeacherOpt[]>([]);
  const [addPick, setAddPick] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadingSchedule, setLoadingSchedule] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await authFetch("/api/support-meetings/staff-options");
        if (!res.ok) return;
        const body = (await res.json()) as {
          staff: { id: number; displayName: string; department: string | null }[];
        };
        if (alive) setStaffOptions(body.staff);
      } catch {
        /* picker just stays empty */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const searchStudents = useCallback(async (q: string) => {
    const res = await authFetch(
      `/api/student-lookup/search?q=${encodeURIComponent(q)}`,
    );
    if (!res.ok) throw new Error("search failed");
    const body = (await res.json()) as { students: StudentHit[] };
    return body.students;
  }, []);

  // On student selection (create mode): pull grade + schedule teachers and
  // seed the attendee list with them.
  const pickStudent = async (s: StudentHit) => {
    setStudent(s);
    setLoadingSchedule(true);
    try {
      const res = await authFetch(
        `/api/support-meetings/student-context?studentId=${encodeURIComponent(s.studentId)}`,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          scheduleTeachers: ScheduleTeacher[];
        };
        setAttendees(
          body.scheduleTeachers.map((t) => ({
            staffId: t.staffId,
            displayName: t.displayName,
            fromSchedule: true,
          })),
        );
      }
    } finally {
      setLoadingSchedule(false);
    }
  };

  const addAttendee = (id: number | null) => {
    setAddPick(null);
    if (id == null) return;
    if (attendees.some((a) => a.staffId === id)) return;
    const opt = staffOptions.find((o) => o.id === id);
    if (!opt) return;
    setAttendees((prev) => [
      ...prev,
      { staffId: id, displayName: opt.displayName ?? "Staff", fromSchedule: false },
    ]);
  };

  const submit = async () => {
    setError("");
    if (!meetingType) return setError("Choose a meeting type.");
    if (!editing && !student) return setError("Choose a student.");
    if (!date) return setError("Choose a date.");
    if (!startTime) return setError("Choose a start time.");
    if (attendees.length === 0)
      return setError("Add at least one attendee.");
    setSaving(true);
    try {
      const payloadCommon = {
        meetingType,
        date,
        startTime,
        endTime: endTime || "",
        location,
        virtualLink,
        notes,
        attendeeStaffIds: attendees.map((a) => a.staffId),
      };
      const res = editing
        ? await authFetch(`/api/support-meetings/${editing.meeting.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payloadCommon),
          })
        : await authFetch("/api/support-meetings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payloadCommon,
              studentId: student!.studentId,
              // schedule teachers are already in attendeeStaffIds; the
              // server re-resolves fromSchedule flags itself on create.
              includeScheduleTeachers: false,
            }),
          });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error || "Could not save the meeting");
        return;
      }
      onDone();
    } catch {
      setError("Could not save the meeting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "1fr 1fr" }}>
        <div>
          <label style={labelStyle}>Meeting type</label>
          <select
            value={meetingType}
            onChange={(e) => setMeetingType(e.target.value)}
            style={inputStyle}
          >
            <option value="">Select…</option>
            {meetingTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Student</label>
          {editing ? (
            <div style={{ ...inputStyle, background: "#f8fafc" }}>
              {editing.meeting.studentName}
              {editing.meeting.grade != null
                ? ` · Gr ${editing.meeting.grade}`
                : ""}
            </div>
          ) : student ? (
            <div
              style={{
                ...inputStyle,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>
                {student.firstName} {student.lastName}
                {student.grade != null ? ` · Gr ${student.grade}` : ""}
              </span>
              <button
                type="button"
                style={{ ...btn, padding: "2px 8px" }}
                onClick={() => {
                  setStudent(null);
                  setAttendees([]);
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <StudentPicker
              mode="async"
              fetcher={searchStudents}
              getKey={(s) => s.studentId}
              getPrimary={(s) => `${s.firstName} ${s.lastName}`}
              renderMeta={(s) =>
                ` · ${s.localSisId ?? "—"}${s.grade != null ? ` · Gr ${s.grade}` : ""}`
              }
              onSelect={pickStudent}
              placeholder="Search student…"
              ariaLabel="Search student"
            />
          )}
        </div>
        <div>
          <label style={labelStyle}>Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Start time</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>End time (optional)</label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Location</label>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Conference Room B"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Virtual meeting link (optional)</label>
          <input
            value={virtualLink}
            onChange={(e) => setVirtualLink(e.target.value)}
            placeholder="https://…"
            style={inputStyle}
          />
        </div>
      </div>
      <div>
        <label style={labelStyle}>Notes for staff (never shown to families)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </div>
      <div>
        <label style={labelStyle}>
          Attendees{" "}
          {loadingSchedule && (
            <span style={{ fontWeight: 400, color: "#64748b" }}>
              (loading the student's teachers…)
            </span>
          )}
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {attendees.map((a) => (
            <span
              key={a.staffId}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: a.fromSchedule ? "#eef2ff" : "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: 999,
                padding: "3px 10px",
                fontSize: "0.82rem",
              }}
            >
              {a.displayName}
              {a.fromSchedule && (
                <span style={{ color: "#6366f1", fontSize: "0.7rem", fontWeight: 700 }}>
                  schedule
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${a.displayName}`}
                onClick={() =>
                  setAttendees((prev) =>
                    prev.filter((x) => x.staffId !== a.staffId),
                  )
                }
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 700,
                  color: "#64748b",
                  padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ))}
          {attendees.length === 0 && (
            <span style={{ color: "#64748b", fontSize: "0.85rem" }}>
              No attendees yet — pick a student to auto-add their teachers, or
              add staff below.
            </span>
          )}
        </div>
        <TeacherPicker
          teachers={staffOptions}
          value={addPick}
          onChange={addAttendee}
          allowEmpty
          emptyLabel="Add a staff member…"
          searchPlaceholder="Search staff…"
          ariaLabel="Add attendee"
        />
      </div>
      {error && (
        <div style={{ color: "#b91c1c", fontSize: "0.85rem" }}>{error}</div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={btn} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" style={btnPrimary} onClick={submit} disabled={saving}>
          {saving ? "Saving…" : editing ? "Save Changes" : "Schedule Meeting"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "5vh 16px",
        overflowY: "auto",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--surface, #fff)",
          borderRadius: 14,
          padding: 20,
          width: "100%",
          maxWidth: wide ? 780 : 560,
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <h3 style={{ margin: 0, fontSize: "1.05rem" }}>{title}</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ ...btn, padding: "2px 10px" }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SupportMeetingsPage({
  onCountsChanged,
}: {
  /** Called after any respond/feedback action so App can refresh the badge. */
  onCountsChanged?: () => void;
}) {
  const [canOrganize, setCanOrganize] = useState(false);
  const [meetingTypes, setMeetingTypes] = useState<string[]>([]);
  const [tab, setTab] = useState<"mine" | "manage">("mine");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<MeetingDetail | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<number | null>(null);
  const [feedbackInitial, setFeedbackInitial] = useState<
    Partial<Record<FeedbackKey, string>> | undefined
  >(undefined);

  // Open the feedback form pre-filled with anything I've already submitted
  // (editing must never blank previously-saved answers).
  const openFeedback = async (id: number) => {
    let initial: Partial<Record<FeedbackKey, string>> | undefined;
    try {
      const res = await authFetch(`/api/support-meetings/${id}`);
      if (res.ok) {
        const body = (await res.json()) as MeetingDetail;
        // My own row is always included in `feedback` when it exists —
        // find it regardless of organizer/attendee view.
        const mine = body.feedback.find((f) => f.staffId === body.my.staffId);
        if (mine) {
          initial = {
            academicPerformance: mine.academicPerformance,
            strengths: mine.strengths,
            concerns: mine.concerns,
            accommodations: mine.accommodations,
            recommendations: mine.recommendations,
            additional: mine.additional,
          };
        }
      }
    } catch {
      /* fall through with a blank form */
    }
    setFeedbackInitial(initial);
    setFeedbackTarget(id);
  };
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [confirmCancelId, setConfirmCancelId] = useState<number | null>(null);
  const [showPast, setShowPast] = useState(false);

  const loadList = useCallback(
    async (which: "mine" | "manage") => {
      setLoading(true);
      setLoadError("");
      try {
        const res = await authFetch(`/api/support-meetings?scope=${which}`);
        if (!res.ok) throw new Error("load failed");
        const body = (await res.json()) as {
          meetings: MeetingListItem[];
          canOrganize: boolean;
        };
        setMeetings(body.meetings);
        setCanOrganize(body.canOrganize);
      } catch {
        setLoadError("Could not load meetings. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch("/api/support-meetings/meta");
        if (res.ok) {
          const body = (await res.json()) as {
            meetingTypes: string[];
            canOrganize: boolean;
          };
          setMeetingTypes(body.meetingTypes);
          setCanOrganize(body.canOrganize);
        }
      } catch {
        /* form just shows no types; list load surfaces real errors */
      }
    })();
  }, []);

  useEffect(() => {
    loadList(tab);
  }, [tab, loadList]);

  const openDetail = async (id: number) => {
    try {
      const res = await authFetch(`/api/support-meetings/${id}`);
      if (!res.ok) {
        setNotice("Could not open that meeting.");
        return;
      }
      setDetail((await res.json()) as MeetingDetail);
    } catch {
      setNotice("Could not open that meeting.");
    }
  };

  const refreshAll = async () => {
    await loadList(tab);
    onCountsChanged?.();
  };

  const respond = async (id: number, response: "confirmed" | "declined") => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/support-meetings/${id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        needsFeedback?: boolean;
      };
      if (!res.ok) {
        setNotice(body.error || "Could not save your response.");
        return;
      }
      if (body.needsFeedback) await openFeedback(id);
      await refreshAll();
      if (detail?.meeting.id === id) await openDetail(id);
    } finally {
      setBusyId(null);
    }
  };

  const remind = async (id: number) => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/support-meetings/${id}/remind`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        reminded?: number;
        error?: string;
      };
      if (!res.ok) {
        setNotice(body.error || "Could not send reminders.");
        return;
      }
      setNotice(
        body.reminded
          ? `Reminder noted for ${body.reminded} attendee(s) — their Meetings badge stays lit until they respond.`
          : "Everyone has already responded.",
      );
      if (detail?.meeting.id === id) await openDetail(id);
    } finally {
      setBusyId(null);
    }
  };

  const cancelMeeting = async (id: number) => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/support-meetings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "canceled" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(body.error || "Could not cancel the meeting.");
        return;
      }
      setConfirmCancelId(null);
      setDetail(null);
      await refreshAll();
    } finally {
      setBusyId(null);
    }
  };

  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const visible = useMemo(() => {
    if (showPast) return meetings;
    return meetings.filter(
      (m) => m.date >= today || m.status === "scheduled",
    );
  }, [meetings, showPast, today]);

  const needsAction = useMemo(
    () =>
      meetings.filter(
        (m) =>
          m.status === "scheduled" &&
          m.date >= today &&
          m.my &&
          (m.my.response === "pending" ||
            (m.my.response === "declined" && !m.my.feedbackSubmitted)),
      ),
    [meetings, today],
  );

  const renderRow = (m: MeetingListItem) => {
    const chip = statusChip[m.status] ?? statusChip.scheduled;
    return (
      <div
        key={m.id}
        style={{
          ...cardStyle,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
        }}
      >
        <div style={{ flex: "1 1 260px", minWidth: 220 }}>
          <div style={{ fontWeight: 700 }}>
            {m.studentName}
            {m.grade != null && (
              <span style={{ color: "#64748b", fontWeight: 400 }}>
                {" "}
                · Gr {m.grade}
              </span>
            )}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#475569" }}>
            {m.meetingType}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#475569" }}>
            {fmtDate(m.date)} · {fmtTime(m.startTime)}
            {m.endTime ? `–${fmtTime(m.endTime)}` : ""}
            {m.location ? ` · ${m.location}` : ""}
          </div>
          <div style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
            Organized by {m.organizerName}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
          <Chip {...chip} />
          {tab === "manage" ? (
            <div style={{ fontSize: "0.8rem", color: "#475569" }}>
              {m.counts.confirmed}/{m.counts.attendees} confirmed ·{" "}
              {m.counts.feedback} feedback
            </div>
          ) : (
            m.my && responseChip(m.my.response)
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tab === "mine" && m.status === "scheduled" && m.my && (
            <>
              {m.my.response !== "confirmed" && (
                <button
                  type="button"
                  style={btnPrimary}
                  disabled={busyId === m.id}
                  onClick={() => respond(m.id, "confirmed")}
                >
                  Confirm
                </button>
              )}
              {m.my.response !== "declined" && (
                <button
                  type="button"
                  style={btn}
                  disabled={busyId === m.id}
                  onClick={() => respond(m.id, "declined")}
                >
                  Unable to Attend
                </button>
              )}
              {m.my.response === "declined" && !m.my.feedbackSubmitted && (
                <button
                  type="button"
                  style={{ ...btnPrimary, background: "#b45309", borderColor: "#b45309" }}
                  onClick={() => openFeedback(m.id)}
                >
                  Add Feedback
                </button>
              )}
            </>
          )}
          {tab === "manage" && m.status === "scheduled" && (
            <button
              type="button"
              style={btn}
              disabled={busyId === m.id}
              onClick={() => remind(m.id)}
            >
              Send Reminder
            </button>
          )}
          <button type="button" style={btn} onClick={() => openDetail(m.id)}>
            Details
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 980 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Meetings</h2>
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Student support meetings — 504, IEP, MTSS, parent conferences.
          </div>
        </div>
        {canOrganize && (
          <button type="button" style={btnPrimary} onClick={() => setShowCreate(true)}>
            + Schedule Meeting
          </button>
        )}
      </div>

      {canOrganize && (
        <div style={{ display: "flex", gap: 8 }}>
          {(["mine", "manage"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                ...btn,
                background: tab === t ? "#2563eb" : "var(--surface, #fff)",
                color: tab === t ? "#fff" : undefined,
                borderColor: tab === t ? "#2563eb" : undefined,
              }}
            >
              {t === "mine" ? "My Meetings" : "Manage"}
            </button>
          ))}
        </div>
      )}

      {notice && (
        <div
          style={{
            ...cardStyle,
            background: "#eff6ff",
            borderColor: "#bfdbfe",
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <span style={{ fontSize: "0.9rem" }}>{notice}</span>
          <button type="button" style={{ ...btn, padding: "2px 10px" }} onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}

      {tab === "mine" && needsAction.length > 0 && (
        <div
          style={{
            ...cardStyle,
            background: "#fffbeb",
            borderColor: "#fde68a",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Needs your action ({needsAction.length})
          </div>
          <div style={{ fontSize: "0.85rem", color: "#78716c" }}>
            Please confirm or respond to the highlighted meetings below —
            declining will ask you for quick feedback so your input still
            reaches the team.
          </div>
        </div>
      )}

      {loading ? (
        <div style={cardStyle}>Loading meetings…</div>
      ) : loadError ? (
        <div style={{ ...cardStyle, color: "#b91c1c" }}>{loadError}</div>
      ) : visible.length === 0 ? (
        <div style={{ ...cardStyle, color: "#64748b" }}>
          {tab === "mine"
            ? "You have no support meetings right now."
            : "No meetings scheduled yet."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>{visible.map(renderRow)}</div>
      )}

      <label style={{ fontSize: "0.85rem", color: "#64748b", display: "flex", gap: 6 }}>
        <input
          type="checkbox"
          checked={showPast}
          onChange={(e) => setShowPast(e.target.checked)}
        />
        Show past & canceled meetings
      </label>

      {showCreate && (
        <Modal title="Schedule a Support Meeting" onClose={() => setShowCreate(false)} wide>
          <MeetingForm
            meetingTypes={meetingTypes}
            editing={null}
            onCancel={() => setShowCreate(false)}
            onDone={async () => {
              setShowCreate(false);
              await refreshAll();
            }}
          />
        </Modal>
      )}

      {editTarget && (
        <Modal title="Edit Meeting" onClose={() => setEditTarget(null)} wide>
          <MeetingForm
            meetingTypes={meetingTypes}
            editing={editTarget}
            onCancel={() => setEditTarget(null)}
            onDone={async () => {
              setEditTarget(null);
              setDetail(null);
              await refreshAll();
            }}
          />
        </Modal>
      )}

      {feedbackTarget != null && (
        <Modal
          title="Meeting Feedback"
          onClose={() => setFeedbackTarget(null)}
          wide
        >
          <div style={{ color: "#64748b", fontSize: "0.88rem", marginBottom: 12 }}>
            You can't make this meeting — no problem. Share what the team
            should know about this student so your voice is still in the room.
          </div>
          <FeedbackForm
            meetingId={feedbackTarget}
            initial={feedbackInitial}
            onCancel={() => setFeedbackTarget(null)}
            onDone={async () => {
              setFeedbackTarget(null);
              await refreshAll();
              if (detail?.meeting.id === feedbackTarget)
                await openDetail(feedbackTarget);
            }}
          />
        </Modal>
      )}

      {detail && (
        <Modal
          title={`${detail.meeting.meetingType} — ${detail.meeting.studentName}`}
          onClose={() => setDetail(null)}
          wide
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <Chip {...(statusChip[detail.meeting.status] ?? statusChip.scheduled)} />
              <span style={{ fontSize: "0.9rem" }}>
                {fmtDate(detail.meeting.date)} · {fmtTime(detail.meeting.startTime)}
                {detail.meeting.endTime ? `–${fmtTime(detail.meeting.endTime)}` : ""}
              </span>
              {detail.meeting.location && (
                <span style={{ fontSize: "0.9rem" }}>📍 {detail.meeting.location}</span>
              )}
              {detail.meeting.virtualLink && (
                <a
                  href={detail.meeting.virtualLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "0.9rem" }}
                >
                  Join virtually
                </a>
              )}
            </div>
            <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
              Organized by {detail.meeting.organizerName}
            </div>
            {detail.my.canEdit && detail.meeting.notes && (
              <div style={{ ...cardStyle, background: "#f8fafc" }}>
                <div style={{ ...labelStyle }}>Staff-only notes</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>
                  {detail.meeting.notes}
                </div>
              </div>
            )}

            <div>
              <div style={labelStyle}>Attendees</div>
              <div style={{ display: "grid", gap: 6 }}>
                {detail.attendees.map((a) => (
                  <div
                    key={a.staffId}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      border: "1px solid var(--border, #e2e8f0)",
                      borderRadius: 8,
                    }}
                  >
                    <span style={{ fontSize: "0.9rem" }}>
                      {a.displayName}
                      {a.fromSchedule && (
                        <span style={{ color: "#6366f1", fontSize: "0.72rem", fontWeight: 700, marginLeft: 6 }}>
                          schedule
                        </span>
                      )}
                    </span>
                    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {a.feedbackSubmitted && (
                        <Chip label="Feedback in" bg="#ede9fe" fg="#6d28d9" />
                      )}
                      {responseChip(a.response)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {detail.feedback.length > 0 && (
              <div>
                <div style={labelStyle}>Teacher feedback</div>
                <div style={{ display: "grid", gap: 10 }}>
                  {detail.feedback.map((f) => (
                    <div key={f.staffId} style={{ ...cardStyle, background: "#faf5ff" }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>
                        {f.displayName}
                      </div>
                      {FEEDBACK_FIELDS.map(({ key, label }) =>
                        f[key] ? (
                          <div key={key} style={{ marginBottom: 6 }}>
                            <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#7c3aed" }}>
                              {label}
                            </div>
                            <div style={{ fontSize: "0.88rem", whiteSpace: "pre-wrap" }}>
                              {f[key]}
                            </div>
                          </div>
                        ) : null,
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              {detail.my.isAttendee && detail.meeting.status === "scheduled" && (
                <>
                  {detail.my.response !== "confirmed" && (
                    <button
                      type="button"
                      style={btnPrimary}
                      onClick={() => respond(detail.meeting.id, "confirmed")}
                    >
                      Confirm
                    </button>
                  )}
                  {detail.my.response !== "declined" && (
                    <button
                      type="button"
                      style={btn}
                      onClick={() => respond(detail.meeting.id, "declined")}
                    >
                      Unable to Attend
                    </button>
                  )}
                  <button
                    type="button"
                    style={btn}
                    onClick={() => openFeedback(detail.meeting.id)}
                  >
                    {detail.my.feedbackSubmitted ? "Edit My Feedback" : "Add Feedback"}
                  </button>
                </>
              )}
              {detail.my.canEdit && detail.meeting.status === "scheduled" && (
                <>
                  <button
                    type="button"
                    style={btn}
                    onClick={() => {
                      setEditTarget(detail);
                    }}
                  >
                    Edit
                  </button>
                  {confirmCancelId === detail.meeting.id ? (
                    <>
                      <button
                        type="button"
                        style={{ ...btnPrimary, background: "#dc2626", borderColor: "#dc2626" }}
                        disabled={busyId === detail.meeting.id}
                        onClick={() => cancelMeeting(detail.meeting.id)}
                      >
                        Yes, cancel it
                      </button>
                      <button type="button" style={btn} onClick={() => setConfirmCancelId(null)}>
                        Keep meeting
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      style={{ ...btn, color: "#dc2626", borderColor: "#fca5a5" }}
                      onClick={() => setConfirmCancelId(detail.meeting.id)}
                    >
                      Cancel Meeting
                    </button>
                  )}
                  {detail.meeting.status === "scheduled" && (
                    <button
                      type="button"
                      style={btn}
                      disabled={busyId === detail.meeting.id}
                      onClick={() => remind(detail.meeting.id)}
                    >
                      Send Reminder
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
