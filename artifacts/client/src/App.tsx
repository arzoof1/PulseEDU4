import { useEffect, useMemo, useRef, useState } from "react";
import Login from "./Login";
import CreatePassModal from "./components/CreatePassModal";
import TeacherAllowlistAdmin from "./components/TeacherAllowlistAdmin";
import StaffDefaultsAdmin from "./components/StaffDefaultsAdmin";
import StaffRolesMatrix from "./components/StaffRolesMatrix";

const destinationsByRoom: Record<string, string[]> = {
  "Room 101": ["Boys Restroom", "Girls Restroom", "Nurse", "Front Office"],
  "Room 102": ["Boys Restroom", "Girls Restroom", "Front Office"],
  "Room 201": ["Boys Restroom", "Girls Restroom", "Library", "Guidance"],
  "Room 202": ["Boys Restroom", "Girls Restroom", "Nurse"],
  "Room 204": ["Library", "Boys Restroom", "Girls Restroom", "Guidance"],
  "Room 305": ["Boys Restroom", "Girls Restroom", "Media Center", "Front Office"],
  "Gym": ["Nurse", "Front Office", "Cafeteria"],
  "Cafeteria": ["Boys Restroom", "Girls Restroom", "Nurse", "Front Office"],
};

interface Student {
  id: number;
  studentId: string;
  parentName?: string | null;
  parentEmail?: string | null;
  parentPhone?: string | null;
  accommodations?: string[];
  firstName: string;
  lastName: string;
  grade: number;
}

interface HallPass {
  id: number;
  studentId: string;
  destination: string;
  originRoom: string;
  teacherName: string;
  destinationTeacher: string | null;
  contactedAcknowledged: boolean;
  status: string;
  maxDurationMinutes: number;
  createdAt: string;
  endedAt: string | null;
}

const teachers = ["Ms. Rivera", "Mr. Johnson", "Coach Lee"];

const staffUsers = [
  "Ms. Rivera",
  "Mr. Johnson",
  "Coach Lee",
  "Ms. Patel (Counselor)",
  "Mr. Davis (Admin)",
  "Ms. Garcia (Interventionist)",
];

// (staffPeriods removed; replaced by mySections derived from /api/schedule)

interface Tardy {
  id: number;
  studentId: string;
  teacherName: string;
  period: string;
  reason: string;
  entryType: "tardy" | "checkin" | "checkout";
  checkInWith: string | null;
  notes: string;
  createdAt: string;
}

interface PbisEntry {
  id: number;
  studentId: string;
  reason: string;
  points: number;
  staffId: number | null;
  staffName: string;
  createdAt: string;
  voidedAt: string | null;
  voidedById: number | null;
  voidedByName: string | null;
  voidReason: string | null;
}

interface SupportNote {
  id: number;
  studentId: string;
  noteType: string;
  noteText: string;
  staffName: string;
  createdAt: string;
}

const supportNoteTypes = [
  "Parent Contact",
  "Student Conference",
  "Behavior Follow-Up",
  "Academic Concern",
  "Intervention",
  "Other",
];

const pbisOptions: { reason: string; points: number }[] = [
  { reason: "Respectful", points: 1 },
  { reason: "Responsible", points: 1 },
  { reason: "Helpful", points: 2 },
  { reason: "Leadership", points: 3 },
  { reason: "Academic Excellence", points: 5 },
];

const checkInWithOptions = [
  "Counselor",
  "Interventionist",
  "Behavior Specialist",
  "Trusted Adult",
  "Administrator",
  "Teacher",
  "Other",
];

function fmtTime(iso?: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function isCreatedToday(createdAt: string): boolean {
  const d = new Date(createdAt);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function getTimeStatusColor(pass: HallPass, now: number): string {
  if (pass.status !== "active") return "#e2e8f0";
  const totalMs = pass.maxDurationMinutes * 60 * 1000;
  const expiresAt = new Date(pass.createdAt).getTime() + totalMs;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return "#fee2e2";
  if (remainingMs < totalMs / 2) return "#fef3c7";
  return "#dcfce7";
}

function formatTimeStatus(pass: HallPass, now: number): string {
  if (pass.status === "system_ended") return "System Ended";
  if (pass.status === "ended") return "Ended";
  const expiresAt =
    new Date(pass.createdAt).getTime() + pass.maxDurationMinutes * 60 * 1000;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return "Overdue";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s left`;
}

type InterventionTypeLite = {
  id: number;
  name: string;
  category: string;
  active: boolean;
};

type PulloutReasonLite = {
  id: number;
  name: string;
  category: string;
  active: boolean;
};

function RequestPulloutSection({
  students,
  interventionTypes,
  reasonOptions,
  isAdmin,
}: {
  students: Student[];
  interventionTypes: InterventionTypeLite[];
  reasonOptions: PulloutReasonLite[];
  isAdmin?: boolean;
}) {
  const [studentSearch, setStudentSearch] = useState("");
  const [studentId, setStudentId] = useState<string>("");
  const [period, setPeriod] = useState<string>("");
  const [reasonChoice, setReasonChoice] = useState<string>("");
  const [reasonOther, setReasonOther] = useState<string>("");
  const reason =
    reasonChoice.toLowerCase() === "other"
      ? reasonOther.trim()
        ? `Other: ${reasonOther.trim()}`
        : ""
      : reasonChoice;
  const activeReasonOptions = useMemo(
    () =>
      reasonOptions
        .filter((r) => r.active)
        .sort((a, b) => {
          const ao = a.name.toLowerCase() === "other" ? 1 : 0;
          const bo = b.name.toLowerCase() === "other" ? 1 : 0;
          if (ao !== bo) return ao - bo;
          if (a.category !== b.category)
            return a.category.localeCompare(b.category);
          return a.name.localeCompare(b.name);
        }),
    [reasonOptions],
  );
  const groupedReasons = useMemo(() => {
    const map = new Map<string, PulloutReasonLite[]>();
    for (const r of activeReasonOptions) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    return Array.from(map.entries());
  }, [activeReasonOptions]);
  const [selectedInterventionIds, setSelectedInterventionIds] = useState<
    Set<number>
  >(new Set());
  const [otherIntervention, setOtherIntervention] = useState<string>("");
  const [acknowledgeNoIntervention, setAcknowledgeNoIntervention] =
    useState(false);

  const activeInterventions = useMemo(
    () =>
      interventionTypes
        .filter((t) => t.active)
        .sort((a, b) => {
          const ao = a.name.toLowerCase() === "other" ? 1 : 0;
          const bo = b.name.toLowerCase() === "other" ? 1 : 0;
          if (ao !== bo) return ao - bo;
          return a.name.localeCompare(b.name);
        }),
    [interventionTypes],
  );
  const otherSelected = useMemo(
    () =>
      activeInterventions.some(
        (t) =>
          selectedInterventionIds.has(t.id) &&
          t.name.toLowerCase() === "other",
      ),
    [activeInterventions, selectedInterventionIds],
  );

  const buildInterventionsTried = (): string => {
    const names = activeInterventions
      .filter((t) => selectedInterventionIds.has(t.id))
      .map((t) =>
        t.name.toLowerCase() === "other" && otherIntervention.trim()
          ? `Other: ${otherIntervention.trim()}`
          : t.name,
      )
      .filter((n) => n.toLowerCase() !== "other");
    if (
      otherSelected &&
      !names.some((n) => n.toLowerCase().startsWith("other:"))
    ) {
      // "Other" picked but no description typed — still record the choice.
      names.push("Other");
    }
    return names.join("; ");
  };
  const interventionsTried = buildInterventionsTried();
  const toggleIntervention = (id: number) => {
    setSelectedInterventionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const [preflight, setPreflight] = useState<{
    hasRecentIntervention: boolean;
    windowDays: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const sortedStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    const list = q
      ? students.filter(
          (s) =>
            s.firstName.toLowerCase().includes(q) ||
            s.lastName.toLowerCase().includes(q) ||
            s.studentId.toLowerCase().includes(q),
        )
      : students;
    // Admins/SuperUsers see all matches; non-admins keep the original 50-cap
    // safety limit so the dropdown can't render a huge list.
    return isAdmin ? list : list.slice(0, 50);
  }, [students, studentSearch, isAdmin]);

  const selectedStudent = useMemo(
    () => students.find((s) => s.studentId === studentId) ?? null,
    [students, studentId],
  );

  const selectedStudentLabel = selectedStudent
    ? `${selectedStudent.firstName} ${selectedStudent.lastName}`
    : "";

  // Fetch preflight when student changes.
  useEffect(() => {
    if (!studentId) {
      setPreflight(null);
      setAcknowledgeNoIntervention(false);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/pullouts/preflight?studentId=${encodeURIComponent(studentId)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setPreflight({
          hasRecentIntervention: !!d.hasRecentIntervention,
          windowDays: d.windowDays ?? 7,
        });
        setAcknowledgeNoIntervention(false);
      })
      .catch(() => {
        if (!cancelled) setPreflight(null);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!studentId || !reason.trim()) {
      setMsg({ ok: false, text: "Pick a student and enter a reason." });
      return;
    }
    if (
      preflight &&
      !preflight.hasRecentIntervention &&
      !acknowledgeNoIntervention
    ) {
      setMsg({
        ok: false,
        text: `No classroom intervention is logged for this student in the past ${preflight.windowDays} school days. Either log one first, or check the acknowledgment box below.`,
      });
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/pullouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          reason: reason.trim(),
          period: period ? Number(period) : null,
          interventionsTried: interventionsTried.trim() || null,
          acknowledgeNoIntervention,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || "Could not submit." });
      } else {
        const er = data?.dispatchEmail;
        let dispatchTail = "";
        if (er?.status === "sent") {
          dispatchTail = ` Dispatch team notified by email.`;
        } else if (er?.status === "skipped") {
          dispatchTail = ` Dispatch email skipped: ${er.errorMsg ?? "no recipients"}.`;
        } else if (er?.status === "error") {
          dispatchTail = ` Dispatch email failed: ${er.errorMsg ?? "unknown"}.`;
        }
        setMsg({
          ok: true,
          text: `Pullout request #${data.id} submitted. An administrator will verify it shortly.${dispatchTail}`,
        });
        setStudentId("");
        setStudentSearch("");
        setPeriod("");
        setReasonChoice("");
        setReasonOther("");
        setSelectedInterventionIds(new Set());
        setOtherIntervention("");
        setAcknowledgeNoIntervention(false);
        setPreflight(null);
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card">
      <h2>Request Pullout</h2>
      <p style={{ color: "var(--text-subtle, #64748b)", marginTop: 0 }}>
        Submit a pullout request when a student needs to be removed from class
        after classroom interventions have been tried. An administrator, dean,
        or MTSS coordinator will verify before the student is sent.
      </p>
      {msg && (
        <div
          style={{
            margin: "0.5rem 0 1rem",
            padding: "0.5rem 0.75rem",
            background: msg.ok ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${msg.ok ? "#a7f3d0" : "#fecaca"}`,
            color: msg.ok ? "#065f46" : "#b91c1c",
            borderRadius: 6,
          }}
        >
          {msg.text}
        </div>
      )}
      <form onSubmit={submit} style={{ display: "grid", gap: "0.75rem" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span>Student</span>
          <input
            type="text"
            placeholder="Search by name or ID…"
            value={studentSearch}
            onChange={(e) => setStudentSearch(e.target.value)}
          />
          <select
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
          >
            <option value="">— select a student —</option>
            {sortedStudents.map((s) => (
              <option key={s.id} value={s.studentId}>
                {s.firstName} {s.lastName} ({s.studentId})
              </option>
            ))}
          </select>
        </label>
        {selectedStudent && preflight && (
          <div
            style={{
              padding: "0.5rem 0.75rem",
              borderRadius: 6,
              background: preflight.hasRecentIntervention
                ? "#ecfdf5"
                : "#fef9c3",
              border: `1px solid ${
                preflight.hasRecentIntervention ? "#a7f3d0" : "#fde68a"
              }`,
              color: preflight.hasRecentIntervention ? "#065f46" : "#854d0e",
              fontSize: "0.9rem",
            }}
          >
            {preflight.hasRecentIntervention
              ? `✓ At least one classroom intervention is logged for ${selectedStudentLabel} within the past ${preflight.windowDays} days.`
              : `⚠ No classroom interventions are logged for ${selectedStudentLabel} in the past ${preflight.windowDays} days.`}
          </div>
        )}
        <label style={{ display: "grid", gap: 4 }}>
          <span>Period</span>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            <option value="">— optional —</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
              <option key={p} value={p}>
                Period {p}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span>Reason for pullout</span>
          {activeReasonOptions.length === 0 ? (
            <textarea
              value={reasonOther}
              onChange={(e) => {
                setReasonChoice("Other");
                setReasonOther(e.target.value);
              }}
              rows={3}
              placeholder="What's happening that requires the student to leave class?"
            />
          ) : (
            <select
              value={reasonChoice}
              onChange={(e) => {
                setReasonChoice(e.target.value);
                if (e.target.value.toLowerCase() !== "other") {
                  setReasonOther("");
                }
              }}
            >
              <option value="">— select a reason —</option>
              {groupedReasons.map(([category, items]) => (
                <optgroup key={category} label={category}>
                  {items.map((r) => (
                    <option key={r.id} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          {reasonChoice.toLowerCase() === "other" && (
            <input
              type="text"
              value={reasonOther}
              onChange={(e) => setReasonOther(e.target.value)}
              placeholder="Describe the reason in your own words…"
              autoFocus
            />
          )}
        </label>
        <fieldset
          style={{
            display: "grid",
            gap: 6,
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: "0.5rem 0.75rem",
          }}
        >
          <legend style={{ padding: "0 0.25rem", fontWeight: 600 }}>
            Interventions tried
          </legend>
          {activeInterventions.length === 0 ? (
            <div
              style={{ fontSize: "0.85rem", color: "var(--text-subtle, #64748b)" }}
            >
              No intervention options have been set up yet. Ask your behavior
              specialist or admin to add some in Settings.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(180px, 1fr))",
                gap: "0.25rem 0.75rem",
              }}
            >
              {activeInterventions.map((t) => (
                <label
                  key={t.id}
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    fontSize: "0.9rem",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedInterventionIds.has(t.id)}
                    onChange={() => toggleIntervention(t.id)}
                  />
                  <span>{t.name}</span>
                </label>
              ))}
            </div>
          )}
          {otherSelected && (
            <input
              type="text"
              value={otherIntervention}
              onChange={(e) => setOtherIntervention(e.target.value)}
              placeholder="Describe the 'Other' intervention you tried…"
              autoFocus
            />
          )}
          {interventionsTried && (
            <div
              style={{
                fontSize: "0.8rem",
                color: "var(--text-subtle, #64748b)",
              }}
            >
              Will be recorded as: {interventionsTried}
            </div>
          )}
        </fieldset>
        {selectedStudent &&
          preflight &&
          !preflight.hasRecentIntervention && (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                fontSize: "0.9rem",
              }}
            >
              <input
                type="checkbox"
                checked={acknowledgeNoIntervention}
                onChange={(e) =>
                  setAcknowledgeNoIntervention(e.target.checked)
                }
                style={{ marginTop: 3 }}
              />
              <span>
                I have tried classroom interventions but did not log them.
                Submit this pullout anyway.
              </span>
            </label>
          )}
        <div>
          <button
            type="submit"
            disabled={submitting || !studentId || !reason.trim()}
            className="btn-primary"
          >
            {submitting ? "Submitting…" : "Submit pullout request"}
          </button>
        </div>
      </form>
    </section>
  );
}

type PulloutRow = {
  id: number;
  studentId: string;
  requestedById: number | null;
  requestedByName: string;
  requestedAt: string;
  referringTeacherStaffId: number | null;
  referringTeacherName: string;
  period: number | null;
  reason: string;
  editedReason: string | null;
  interventionsTried: string | null;
  status: string;
  verifiedById: number | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  arrivedAt: string | null;
  arrivedById: number | null;
  arrivedByName: string | null;
  returnedAt: string | null;
  closedAt: string | null;
  parentEmailSentAt: string | null;
  parentEmailStatus: string | null;
  parentEmailErrorMsg: string | null;
  parentEmailTo: string | null;
  reviewedAt: string | null;
  reviewedById: number | null;
  reviewedByName: string | null;
  reviewNotes: string | null;
};

function VerifyPulloutsSection({
  students,
  onChange,
}: {
  students: Student[];
  onChange: () => void;
}) {
  const [rows, setRows] = useState<PulloutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [edits, setEdits] = useState<
    Record<
      number,
      {
        editedReason: string;
        period: string;
        referringTeacherName: string;
        rejectedReason: string;
      }
    >
  >({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const studentName = (id: string) => {
    const s = students.find((x) => x.studentId === id);
    return s ? `${s.firstName} ${s.lastName}` : `Student ${id}`;
  };

  const refresh = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/pullouts?scope=pending");
      if (!r.ok) {
        setMsg({ ok: false, text: "Could not load pending pullouts." });
        setRows([]);
      } else {
        const data: PulloutRow[] = await r.json();
        setRows(data);
        // seed edit drafts
        const next: typeof edits = {};
        for (const p of data) {
          next[p.id] = {
            editedReason: p.editedReason ?? p.reason,
            period: p.period == null ? "" : String(p.period),
            referringTeacherName: p.referringTeacherName,
            rejectedReason: "",
          };
        }
        setEdits(next);
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEdit = (
    id: number,
    patch: Partial<{
      editedReason: string;
      period: string;
      referringTeacherName: string;
      rejectedReason: string;
    }>,
  ) => {
    setEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  };

  const verify = async (p: PulloutRow) => {
    const draft = edits[p.id];
    setBusyId(p.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/pullouts/${p.id}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          editedReason: draft?.editedReason ?? "",
          period: draft?.period === "" ? null : Number(draft?.period ?? ""),
          referringTeacherName: draft?.referringTeacherName ?? "",
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || "Could not verify." });
      } else {
        setMsg({
          ok: true,
          text: `Verified pullout #${p.id} for ${studentName(p.studentId)}.`,
        });
        await refresh();
        onChange();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (p: PulloutRow) => {
    const draft = edits[p.id];
    if (!draft?.rejectedReason.trim()) {
      setMsg({
        ok: false,
        text: `Add a rejection reason for pullout #${p.id} before rejecting.`,
      });
      return;
    }
    setBusyId(p.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/pullouts/${p.id}/reject`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejectedReason: draft.rejectedReason.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || "Could not reject." });
      } else {
        setMsg({
          ok: true,
          text: `Rejected pullout #${p.id} for ${studentName(p.studentId)}.`,
        });
        await refresh();
        onChange();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card">
      <h2>Verify Pullouts</h2>
      <p style={{ color: "var(--text-subtle, #64748b)", marginTop: 0 }}>
        Review pending pullout requests. You can edit the reason, period, or
        referring teacher name before verifying — those edits become the
        record sent to the ISS room and to parents.
      </p>
      {msg && (
        <div
          style={{
            margin: "0.5rem 0 1rem",
            padding: "0.5rem 0.75rem",
            background: msg.ok ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${msg.ok ? "#a7f3d0" : "#fecaca"}`,
            color: msg.ok ? "#065f46" : "#b91c1c",
            borderRadius: 6,
          }}
        >
          {msg.text}
        </div>
      )}
      {loading ? (
        <div style={{ color: "var(--text-subtle, #64748b)" }}>Loading…</div>
      ) : msg && !msg.ok && rows.length === 0 ? (
        <button type="button" onClick={refresh}>
          Try again
        </button>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--text-subtle, #64748b)" }}>
          No pending pullouts. 🎉
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {rows.map((p) => {
            const draft = edits[p.id] ?? {
              editedReason: p.reason,
              period: p.period == null ? "" : String(p.period),
              referringTeacherName: p.referringTeacherName,
              rejectedReason: "",
            };
            return (
              <div
                key={p.id}
                style={{
                  border: "1px solid var(--border, #e2e8f0)",
                  borderRadius: 8,
                  padding: "0.75rem 1rem",
                  background: "var(--surface, white)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <div>
                    <strong>{studentName(p.studentId)}</strong>{" "}
                    <span style={{ color: "#64748b" }}>
                      (#{p.studentId}) · pullout #{p.id}
                    </span>
                  </div>
                  <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                    Requested by {p.requestedByName} ·{" "}
                    {new Date(p.requestedAt).toLocaleString()}
                  </div>
                </div>
                {p.interventionsTried && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: "0.88rem",
                      color: "#475569",
                    }}
                  >
                    <em>Interventions tried:</em> {p.interventionsTried}
                  </div>
                )}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)",
                    gap: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: "0.85rem" }}>Reason (editable)</span>
                    <textarea
                      rows={2}
                      value={draft.editedReason}
                      onChange={(e) =>
                        setEdit(p.id, { editedReason: e.target.value })
                      }
                    />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: "0.85rem" }}>Period</span>
                    <select
                      value={draft.period}
                      onChange={(e) =>
                        setEdit(p.id, { period: e.target.value })
                      }
                    >
                      <option value="">—</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: "0.85rem" }}>
                      Referring teacher
                    </span>
                    <input
                      type="text"
                      value={draft.referringTeacherName}
                      onChange={(e) =>
                        setEdit(p.id, {
                          referringTeacherName: e.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    marginTop: "0.75rem",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busyId === p.id}
                    onClick={() => verify(p)}
                  >
                    {busyId === p.id ? "Working…" : "Verify & send to ISS"}
                  </button>
                  <input
                    type="text"
                    placeholder="Rejection reason"
                    value={draft.rejectedReason}
                    onChange={(e) =>
                      setEdit(p.id, { rejectedReason: e.target.value })
                    }
                    style={{ flex: 1, minWidth: 180 }}
                  />
                  <button
                    type="button"
                    disabled={busyId === p.id}
                    onClick={() => reject(p)}
                    style={{
                      background: "transparent",
                      color: "#b91c1c",
                      border: "1px solid #fecaca",
                      borderRadius: 6,
                      padding: "0.4rem 0.8rem",
                      cursor: "pointer",
                    }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function IssDashboardSection({ students }: { students: Student[] }) {
  const [rows, setRows] = useState<PulloutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const studentName = (id: string) => {
    const s = students.find((x) => x.studentId === id);
    return s ? `${s.firstName} ${s.lastName}` : `Student ${id}`;
  };

  const refresh = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/pullouts?scope=active");
      if (!r.ok) {
        setMsg({ ok: false, text: "Could not load ISS dashboard." });
        setRows([]);
      } else {
        setRows(await r.json());
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const act = async (
    p: PulloutRow,
    action: "arrived" | "returned" | "closed",
  ) => {
    setBusyId(p.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/pullouts/${p.id}/${action}`, {
        method: "PATCH",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || `Could not ${action}.` });
      } else if (action === "arrived") {
        const er = data?.parentEmail;
        if (er?.status === "sent") {
          setMsg({
            ok: true,
            text: `Arrived. Parent email sent to ${er.emailTo}.`,
          });
        } else if (er?.status === "skipped") {
          setMsg({
            ok: true,
            text: `Arrived. Parent email skipped: ${er.errorMsg}.`,
          });
        } else if (er?.status === "error") {
          setMsg({
            ok: false,
            text: `Arrived, but parent email failed: ${er.errorMsg}.`,
          });
        } else {
          setMsg({ ok: true, text: "Marked arrived." });
        }
        await refresh();
      } else {
        setMsg({ ok: true, text: `Marked ${action}.` });
        await refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  const onTheWay = rows.filter(
    (r) => r.status === "verified" || r.status === "enroute",
  );
  const arrived = rows.filter((r) => r.status === "arrived");

  const renderCard = (
    p: PulloutRow,
    actions: { label: string; action: "arrived" | "returned" | "closed" }[],
  ) => (
    <div
      key={p.id}
      style={{
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: 8,
        padding: "0.65rem 0.9rem",
        background: "var(--surface, white)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <strong>{studentName(p.studentId)}</strong>{" "}
          <span style={{ color: "#64748b" }}>
            (#{p.studentId}) · pullout #{p.id}
          </span>
        </div>
        <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
          {p.referringTeacherName}
          {p.period ? ` · period ${p.period}` : ""}
        </div>
      </div>
      <div style={{ marginTop: 4, fontSize: "0.92rem" }}>
        <em>Reason:</em> {p.editedReason ?? p.reason}
      </div>
      {p.status === "arrived" && (
        <div
          style={{ marginTop: 4, fontSize: "0.85rem", color: "#475569" }}
        >
          Arrived {new Date(p.arrivedAt!).toLocaleTimeString()}{" "}
          {p.parentEmailStatus === "sent" && (
            <span style={{ color: "#065f46" }}>
              · parent email sent to {p.parentEmailTo}
            </span>
          )}
          {p.parentEmailStatus === "skipped" && (
            <span style={{ color: "#854d0e" }}>
              · parent email skipped ({p.parentEmailErrorMsg})
            </span>
          )}
          {p.parentEmailStatus === "error" && (
            <span style={{ color: "#b91c1c" }}>
              · parent email failed ({p.parentEmailErrorMsg})
            </span>
          )}
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          marginTop: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            disabled={busyId === p.id}
            className={a.action === "arrived" ? "btn-primary" : undefined}
            onClick={() => act(p, a.action)}
            style={
              a.action === "arrived"
                ? undefined
                : {
                    background: "transparent",
                    color: "#1f2937",
                    border: "1px solid var(--border, #cbd5e1)",
                    borderRadius: 6,
                    padding: "0.35rem 0.75rem",
                    cursor: "pointer",
                  }
            }
          >
            {busyId === p.id ? "…" : a.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <h2>ISS Dashboard</h2>
        <button
          type="button"
          onClick={refresh}
          style={{
            background: "transparent",
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: 6,
            padding: "0.3rem 0.7rem",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          Refresh
        </button>
      </div>
      <p style={{ color: "var(--text-subtle, #64748b)", marginTop: 0 }}>
        Track verified pullouts. Marking <strong>Arrived</strong> sends the
        parent notification automatically.
      </p>
      {msg && (
        <div
          style={{
            margin: "0.5rem 0 1rem",
            padding: "0.5rem 0.75rem",
            background: msg.ok ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${msg.ok ? "#a7f3d0" : "#fecaca"}`,
            color: msg.ok ? "#065f46" : "#b91c1c",
            borderRadius: 6,
          }}
        >
          {msg.text}
        </div>
      )}
      {loading ? (
        <div style={{ color: "var(--text-subtle, #64748b)" }}>Loading…</div>
      ) : msg && !msg.ok && rows.length === 0 ? (
        <button type="button" onClick={refresh}>
          Try again
        </button>
      ) : (
        <>
          <h3 style={{ marginTop: "1rem" }}>
            On the way ({onTheWay.length})
          </h3>
          {onTheWay.length === 0 ? (
            <div style={{ color: "var(--text-subtle, #64748b)" }}>
              Nothing on the way.
            </div>
          ) : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {onTheWay.map((p) =>
                renderCard(p, [
                  { label: "Mark Arrived", action: "arrived" },
                  { label: "Cancel (close)", action: "closed" },
                ]),
              )}
            </div>
          )}
          <h3 style={{ marginTop: "1.25rem" }}>
            Arrived ({arrived.length})
          </h3>
          {arrived.length === 0 ? (
            <div style={{ color: "var(--text-subtle, #64748b)" }}>
              No students currently in the room.
            </div>
          ) : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {arrived.map((p) =>
                renderCard(p, [
                  { label: "Mark Returned", action: "returned" },
                  { label: "Close", action: "closed" },
                ]),
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BehaviorReviewSection({
  students,
  onChange,
}: {
  students: Student[];
  onChange: () => void;
}) {
  const [rows, setRows] = useState<PulloutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const studentName = (id: string) => {
    const s = students.find((x) => x.studentId === id);
    return s ? `${s.firstName} ${s.lastName}` : `Student ${id}`;
  };

  const refresh = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/pullouts?scope=unreviewed");
      if (!r.ok) {
        setMsg({ ok: false, text: "Could not load review queue." });
        setRows([]);
      } else {
        const data: PulloutRow[] = await r.json();
        setRows(data);
        const seed: Record<number, string> = {};
        for (const p of data) seed[p.id] = "";
        setNotes(seed);
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const review = async (p: PulloutRow) => {
    setBusyId(p.id);
    setMsg(null);
    try {
      const body = notes[p.id]?.trim()
        ? { reviewNotes: notes[p.id].trim() }
        : {};
      const r = await fetch(`/api/pullouts/${p.id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || "Could not mark reviewed." });
      } else {
        setMsg({ ok: true, text: `Marked reviewed.` });
        await refresh();
        onChange();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card">
      <h2>Behavior Review</h2>
      <p style={{ color: "var(--text-subtle, #64748b)", marginTop: 0 }}>
        Closed pullouts awaiting behavior-specialist review. Add optional
        notes for your records, then mark reviewed to clear from the queue.
      </p>
      {msg && (
        <p style={{ color: msg.ok ? "green" : "crimson" }}>{msg.text}</p>
      )}
      {loading ? (
        <p>Loading…</p>
      ) : msg && !msg.ok && rows.length === 0 ? (
        <button type="button" onClick={refresh}>
          Try again
        </button>
      ) : rows.length === 0 ? (
        <p>No pullouts awaiting review. 🎉</p>
      ) : (
        <table
          border={1}
          cellPadding={6}
          style={{ borderCollapse: "collapse", width: "100%" }}
        >
          <thead>
            <tr>
              <th>student</th>
              <th>requested</th>
              <th>teacher</th>
              <th>period</th>
              <th>reason</th>
              <th>parent email</th>
              <th>review notes</th>
              <th>action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.studentId}
                  <br />
                  <span style={{ color: "#64748b" }}>
                    {studentName(p.studentId)}
                  </span>
                </td>
                <td>{p.requestedAt}</td>
                <td>{p.referringTeacherName || "-"}</td>
                <td>{p.period ?? "-"}</td>
                <td style={{ maxWidth: "16rem" }}>
                  {p.editedReason ?? p.reason}
                </td>
                <td>
                  {p.parentEmailStatus
                    ? `${p.parentEmailStatus}${p.parentEmailTo ? ` → ${p.parentEmailTo}` : ""}`
                    : "-"}
                </td>
                <td>
                  <textarea
                    rows={2}
                    style={{ width: "14rem" }}
                    placeholder="Optional notes"
                    value={notes[p.id] ?? ""}
                    onChange={(e) =>
                      setNotes((prev) => ({
                        ...prev,
                        [p.id]: e.target.value,
                      }))
                    }
                    disabled={busyId === p.id}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    disabled={busyId === p.id}
                    onClick={() => review(p)}
                  >
                    {busyId === p.id ? "…" : "Mark Reviewed"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StudentPulloutsTab({ studentId }: { studentId: string }) {
  const [rows, setRows] = useState<PulloutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const r = await fetch(
          `/api/pullouts/by-student/${encodeURIComponent(studentId)}`,
        );
        if (!r.ok) {
          if (!cancelled) setErr("Could not load pullouts.");
        } else {
          const data = (await r.json()) as PulloutRow[];
          if (!cancelled) setRows(data);
        }
      } catch {
        if (!cancelled) setErr("Network error.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  if (loading) return <p>Loading pullouts…</p>;
  if (err) return <p style={{ color: "crimson" }}>{err}</p>;
  if (rows.length === 0)
    return <p>No pullouts on file for this student.</p>;

  return (
    <>
      <h3>Pullouts ({rows.length})</h3>
      <table
        border={1}
        cellPadding={6}
        style={{ borderCollapse: "collapse" }}
      >
        <thead>
          <tr>
            <th>requestedAt</th>
            <th>referringTeacher</th>
            <th>period</th>
            <th>reason</th>
            <th>status</th>
            <th>verifiedBy</th>
            <th>arrivedAt</th>
            <th>parentEmail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.requestedAt}</td>
              <td>{p.referringTeacherName || "-"}</td>
              <td>{p.period ?? "-"}</td>
              <td>{p.editedReason ?? p.reason}</td>
              <td>{p.status}</td>
              <td>{p.verifiedByName ?? "-"}</td>
              <td>{p.arrivedAt ?? "-"}</td>
              <td>
                {p.parentEmailStatus
                  ? `${p.parentEmailStatus}${p.parentEmailTo ? ` → ${p.parentEmailTo}` : ""}`
                  : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

type PulloutReportBucket = {
  total: number;
  pending: number;
  verified: number;
  arrived: number;
  returned: number;
  closed: number;
  rejected: number;
};
type PulloutReportData = {
  windowDays: number;
  sinceIso: string;
  total: number;
  byStudent: (PulloutReportBucket & { studentId: string })[];
  byTeacher: (PulloutReportBucket & { referringTeacherName: string })[];
  byReason: (PulloutReportBucket & { reason: string })[];
};

function PulloutReportSection({ students }: { students: Student[] }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<PulloutReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const studentName = (id: string) => {
    const s = students.find((x) => x.studentId === id);
    return s ? `${s.firstName} ${s.lastName}` : `Student ${id}`;
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/pullouts/report?days=${days}`);
        if (!r.ok) {
          if (!cancelled) setErr("Could not load report.");
        } else {
          const j = (await r.json()) as PulloutReportData;
          if (!cancelled) setData(j);
        }
      } catch {
        if (!cancelled) setErr("Network error.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const renderBucket = (
    title: string,
    rows: (PulloutReportBucket & Record<string, string>)[],
    keyName: string,
    label: (v: string) => string,
  ) => (
    <div style={{ marginTop: "0.75rem" }}>
      <h4 style={{ margin: "0.25rem 0" }}>{title}</h4>
      {rows.length === 0 ? (
        <p style={{ color: "#666" }}>None.</p>
      ) : (
        <table
          border={1}
          cellPadding={4}
          style={{ borderCollapse: "collapse", fontSize: "0.9em" }}
        >
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>{keyName}</th>
              <th>total</th>
              <th>pending</th>
              <th>verified</th>
              <th>arrived</th>
              <th>returned</th>
              <th>closed</th>
              <th>rejected</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 15).map((r) => (
              <tr key={r[keyName]}>
                <td>{label(r[keyName])}</td>
                <td style={{ textAlign: "right" }}>{r.total}</td>
                <td style={{ textAlign: "right" }}>{r.pending}</td>
                <td style={{ textAlign: "right" }}>{r.verified}</td>
                <td style={{ textAlign: "right" }}>{r.arrived}</td>
                <td style={{ textAlign: "right" }}>{r.returned}</td>
                <td style={{ textAlign: "right" }}>{r.closed}</td>
                <td style={{ textAlign: "right" }}>{r.rejected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <section
      className="card"
      style={{ marginBottom: "1rem", background: "#f6f8fb" }}
    >
      <h3 style={{ marginTop: 0 }}>Pullout Report</h3>
      <div style={{ marginBottom: "0.5rem" }}>
        Window:{" "}
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 365 days</option>
        </select>
      </div>
      {loading && <p>Loading…</p>}
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {data && (
        <>
          <div>
            <strong>{data.total}</strong> pullouts in the last{" "}
            {data.windowDays} days.
          </div>
          {renderBucket(
            "Top students",
            data.byStudent as (PulloutReportBucket &
              Record<string, string>)[],
            "studentId",
            (id) => `${id} - ${studentName(id)}`,
          )}
          {renderBucket(
            "Top referring teachers",
            data.byTeacher as (PulloutReportBucket &
              Record<string, string>)[],
            "referringTeacherName",
            (n) => n,
          )}
          {renderBucket(
            "Top reasons",
            data.byReason as (PulloutReportBucket &
              Record<string, string>)[],
            "reason",
            (n) => n,
          )}
        </>
      )}
    </section>
  );
}

type StaffAdminRow = {
  id: number;
  email: string;
  displayName: string;
  active: boolean;
  isAdmin: boolean;
  isEseCoordinator: boolean;
  isPbisCoordinator: boolean;
  isBehaviorSpecialist: boolean;
  isIssTeacher: boolean;
  isDean: boolean;
  isMtssCoordinator: boolean;
};

const STAFF_ROLE_FIELDS: {
  key: keyof Omit<
    StaffAdminRow,
    "id" | "email" | "displayName" | "active"
  >;
  label: string;
}[] = [
  { key: "isAdmin", label: "Admin" },
  { key: "isDean", label: "Dean" },
  { key: "isMtssCoordinator", label: "MTSS Coord." },
  { key: "isBehaviorSpecialist", label: "Behavior Spec." },
  { key: "isIssTeacher", label: "ISS Teacher" },
  { key: "isPbisCoordinator", label: "PBIS Coord." },
  { key: "isEseCoordinator", label: "ESE Coord." },
];

function StaffRolesAdmin({ currentStaffId }: { currentStaffId: number | null }) {
  const [rows, setRows] = useState<StaffAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/staff");
      if (!r.ok) {
        setMsg({ ok: false, text: "Could not load staff." });
        setRows([]);
      } else {
        setRows(await r.json());
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.displayName.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q),
    );
  }, [rows, filter]);

  const toggle = async (
    row: StaffAdminRow,
    field: keyof StaffAdminRow,
    next: boolean,
  ) => {
    setBusyId(row.id);
    setMsg(null);
    try {
      const r = await fetch(`/api/admin/staff/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error ?? "Could not update." });
      } else {
        setRows((prev) => prev.map((x) => (x.id === row.id ? data : x)));
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h2>Staff & Roles</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Toggle which staff can verify pullouts (Admin / Dean / MTSS), run the
        ISS Dashboard (ISS Teacher / Behavior Specialist), and review closed
        pullouts (Behavior Specialist). Admins can also deactivate accounts.
      </p>
      {msg && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
            background: msg.ok ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${msg.ok ? "#a7f3d0" : "#fecaca"}`,
            color: msg.ok ? "#065f46" : "#991b1b",
          }}
        >
          {msg.text}
        </div>
      )}
      <div style={{ marginBottom: "0.5rem" }}>
        <input
          type="text"
          placeholder="Filter by name or email…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: "100%", maxWidth: 360 }}
        />
      </div>
      {loading ? (
        <p>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>No staff match.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9rem",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ padding: "0.4rem 0.5rem" }}>Staff</th>
                {STAFF_ROLE_FIELDS.map((f) => (
                  <th
                    key={f.key}
                    style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}
                  >
                    {f.label}
                  </th>
                ))}
                <th style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}>
                  Active
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const isSelf = currentStaffId === row.id;
                const dim = !row.active;
                return (
                  <tr
                    key={row.id}
                    style={{
                      borderBottom: "1px solid #f1f5f9",
                      opacity: dim ? 0.5 : 1,
                    }}
                  >
                    <td style={{ padding: "0.4rem 0.5rem" }}>
                      <div style={{ fontWeight: 600 }}>
                        {row.displayName}
                        {isSelf && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: "0.75rem",
                              color: "var(--text-subtle)",
                            }}
                          >
                            (you)
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-subtle)",
                        }}
                      >
                        {row.email}
                      </div>
                    </td>
                    {STAFF_ROLE_FIELDS.map((f) => (
                      <td
                        key={f.key}
                        style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(row[f.key])}
                          disabled={
                            busyId === row.id ||
                            (isSelf && f.key === "isAdmin" && row.isAdmin)
                          }
                          title={
                            isSelf && f.key === "isAdmin"
                              ? "You cannot remove your own admin role."
                              : undefined
                          }
                          onChange={(e) =>
                            toggle(row, f.key, e.target.checked)
                          }
                        />
                      </td>
                    ))}
                    <td style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={row.active}
                        disabled={busyId === row.id || isSelf}
                        title={
                          isSelf
                            ? "You cannot deactivate your own account."
                            : undefined
                        }
                        onChange={(e) =>
                          toggle(row, "active", e.target.checked)
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function PolarityStudentPicker({
  label,
  students,
  search,
  setSearch,
  setSelected,
  isAdmin,
}: {
  label: string;
  students: Student[];
  search: string;
  setSearch: (v: string) => void;
  setSelected: (v: string) => void;
  isAdmin?: boolean;
}) {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? students.filter(
        (s) =>
          s.firstName.toLowerCase().includes(q) ||
          s.lastName.toLowerCase().includes(q) ||
          s.studentId.toLowerCase().includes(q),
      )
    : [];
  const matches = isAdmin ? filtered : filtered.slice(0, 8);
  // Detect when `search` already equals a fully-formatted picked label so we
  // don't keep showing the dropdown after a click.
  const looksPicked = /\(\s*S\d+\s*\)$/.test(search) || /^S\d+\s+-/.test(search);
  return (
    <label style={{ position: "relative" }}>
      <div style={{ fontSize: "0.85rem" }}>{label}</div>
      <input
        type="text"
        value={search}
        placeholder="Type name or ID"
        onChange={(e) => {
          setSearch(e.target.value);
          setSelected("");
        }}
        style={{ width: "100%" }}
      />
      {q && !looksPicked && (
        <ul
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 10,
            background: "var(--bg, #fff)",
            border: "1px solid #ccc",
            borderRadius: "0.25rem",
            margin: 0,
            padding: "0.25rem 0",
            listStyle: "none",
            maxHeight: "12rem",
            overflowY: "auto",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          {matches.length === 0 && (
            <li style={{ padding: "0.25rem 0.5rem", color: "#666" }}>
              No matches
            </li>
          )}
          {matches.map((s) => (
            <li key={s.studentId}>
              <button
                type="button"
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "0.25rem 0.5rem",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setSelected(s.studentId);
                  setSearch(`${s.firstName} ${s.lastName} (${s.studentId})`);
                }}
              >
                {s.firstName} {s.lastName} ({s.studentId})
              </button>
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}

function StudentCombobox({
  students,
  value,
  onChange,
  placeholder = "Type name or ID…",
  minWidth = 280,
  isAdmin,
}: {
  students: Student[];
  value: string;
  onChange: (studentId: string) => void;
  placeholder?: string;
  minWidth?: number;
  isAdmin?: boolean;
}) {
  const selected = students.find((s) => s.studentId === value);
  const labelOf = (s: Student) =>
    `${s.firstName} ${s.lastName} (${s.studentId})`;
  const [query, setQuery] = useState(selected ? labelOf(selected) : "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setQuery(selected ? labelOf(selected) : "");
  }, [value, students]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const matches = (() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? students.filter((s) => {
          return (
            s.firstName.toLowerCase().includes(q) ||
            s.lastName.toLowerCase().includes(q) ||
            s.studentId.toLowerCase().includes(q) ||
            labelOf(s).toLowerCase().includes(q)
          );
        })
      : students;
    return isAdmin ? base : base.slice(0, 50);
  })();

  const commit = (s: Student) => {
    onChange(s.studentId);
    setQuery(labelOf(s));
    setOpen(false);
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-block", minWidth }}
    >
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setHighlight(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
          if (e.target.value.trim() === "") onChange("");
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            setOpen(true);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            if (open && matches[highlight]) {
              e.preventDefault();
              commit(matches[highlight]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        style={{ width: "100%", padding: "0.4rem 0.55rem" }}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            setQuery("");
            setOpen(false);
          }}
          aria-label="Clear"
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            background: "transparent",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            fontSize: "1.1rem",
            lineHeight: 1,
            padding: "0 0.25rem",
          }}
        >
          ×
        </button>
      )}
      {open && matches.length > 0 && (
        <ul
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 50,
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            margin: 0,
            padding: "0.25rem 0",
            listStyle: "none",
            background: "#fff",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            boxShadow: "0 6px 18px rgba(15,23,42,0.12)",
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          {matches.map((s, i) => (
            <li
              key={s.studentId}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: "0.4rem 0.6rem",
                cursor: "pointer",
                background: i === highlight ? "#e0f2fe" : "transparent",
                fontSize: "0.92rem",
              }}
            >
              <strong>
                {s.firstName} {s.lastName}
              </strong>{" "}
              <span style={{ color: "#64748b" }}>
                · {s.studentId} · Gr {s.grade}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && matches.length === 0 && query.trim() !== "" && (
        <div
          style={{
            position: "absolute",
            zIndex: 50,
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            background: "#fff",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            padding: "0.5rem 0.6rem",
            color: "#64748b",
            fontSize: "0.9rem",
          }}
        >
          No matches.
        </div>
      )}
    </div>
  );
}

function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [hallPasses, setHallPasses] = useState<HallPass[]>([]);
  const [createPassOpen, setCreatePassOpen] = useState(false);
  const [teacherAllowlistMap, setTeacherAllowlistMap] = useState<
    Record<string, string[]>
  >({});
  const [editingPassId, setEditingPassId] = useState<number | null>(null);
  const [editEndedAt, setEditEndedAt] = useState<string>("");
  const [editCreatedAt, setEditCreatedAt] = useState<string>("");
  const [tardies, setTardies] = useState<Tardy[]>([]);

  const [selectedTeacher, setSelectedTeacher] = useState(teachers[0]);
  const [authUser, setAuthUser] = useState<{
    id: number;
    email: string;
    displayName: string;
    isSuperUser?: boolean;
    isAdmin: boolean;
    isEseCoordinator: boolean;
    isPbisCoordinator: boolean;
    isBehaviorSpecialist: boolean;
    isIssTeacher: boolean;
    isDean: boolean;
    isMtssCoordinator: boolean;
    isCounselor?: boolean;
    isSocialWorker?: boolean;
    capStaffRoles?: boolean;
    capManageRoles?: boolean;
  } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const currentStaffUser = authUser?.displayName ?? "";
  const [showChangePw, setShowChangePw] = useState(false);
  const [changePwCurrent, setChangePwCurrent] = useState("");
  const [changePwNew, setChangePwNew] = useState("");
  const [changePwBusy, setChangePwBusy] = useState(false);
  const [changePwError, setChangePwError] = useState("");
  const [changePwOk, setChangePwOk] = useState(false);
  const [dateFilter, setDateFilter] = useState<"today" | "all">("all");
  const [staffFilter, setStaffFilter] = useState<"all" | "mine">("all");
  const [passFilter, setPassFilter] = useState<"all" | "mine">("all");

  // Hall pass top-level view: overview (current default) vs reports (admin/ESE).
  const [hpView, setHpView] = useState<"overview" | "reports">("overview");
  const [passListView, setPassListView] = useState<"active" | "log">("active");
  // Hall pass reports state.
  const [hpReportDate, setHpReportDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  interface HpReportData {
    date: string;
    asOf: string;
    totalPasses: number;
    totalLostMinutes: number;
    activePassCount: number;
    topStudentTakers: Array<{
      studentId: string;
      studentName: string;
      count: number;
    }>;
    topStudentLostMinutes: Array<{
      studentId: string;
      studentName: string;
      minutes: number;
    }>;
    topTeacherGranters: Array<{ teacherName: string; count: number }>;
    topDestinations: Array<{ destination: string; count: number }>;
  }
  const [hpReportData, setHpReportData] = useState<HpReportData | null>(null);
  const [hpReportLoading, setHpReportLoading] = useState(false);
  const [hpReportError, setHpReportError] = useState("");
  const [activeSection, setActiveSection] = useState<
    | "hallPasses"
    | "tardies"
    | "student"
    | "pbis"
    | "accommodations"
    | "ese"
    | "pbisLists"
    | "interventions"
    | "logIntervention"
    | "requestPullout"
    | "verifyPullouts"
    | "issDashboard"
    | "behaviorReview"
    | "behaviorSpecialist"
    | "hallPassMgmt"
    | "settings"
    | "staffRoles"
  >("hallPasses");
  const [schoolSettings, setSchoolSettings] = useState<{
    schoolName: string;
    fromName: string;
    emailSignature: string;
    periodCount: number;
    hallPassMaxMinutes: number;
    hallPassDefaultMinutes: number;
    globalDailyHallPassLimit: number | null;
  }>({
    schoolName: "",
    fromName: "",
    emailSignature: "",
    periodCount: 7,
    hallPassMaxMinutes: 30,
    hallPassDefaultMinutes: 5,
    globalDailyHallPassLimit: null,
  });
  const [settingsStatus, setSettingsStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [settingsError, setSettingsError] = useState("");
  const [activeKiosks, setActiveKiosks] = useState<
    Array<{
      id: number;
      room: string;
      activatedByName: string | null;
      activatedAt: string;
      expiresAt: string;
      deviceLabel: string | null;
    }>
  >([]);
  const [adminNotifications, setAdminNotifications] = useState<
    Array<{
      id: number;
      type: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }>
  >([]);
  const [activityStudentId, setActivityStudentId] = useState("");
  const [activityStudentSearch, setActivityStudentSearch] = useState("");
  const [studentTab, setStudentTab] = useState<
    | "summary"
    | "hallPasses"
    | "tardy"
    | "pbis"
    | "supportNotes"
    | "contact"
    | "pullouts"
  >("summary");
  const [accView, setAccView] = useState<
    "classView" | "student" | "roster" | "daily" | "reports"
  >("classView");
  const [accStudentId, setAccStudentId] = useState("");
  const [classViewPeriod, setClassViewPeriod] = useState<number | null>(null);
  const [classViewHoverId, setClassViewHoverId] = useState<string | null>(null);
  const [classViewTeacherId, setClassViewTeacherId] = useState<number | null>(
    null,
  );
  interface AllSection {
    id: number;
    period: number;
    courseName: string;
    isPlanning: boolean;
    teacherStaffId: number;
    teacherName: string;
    studentIds: string[];
  }
  const [allSections, setAllSections] = useState<AllSection[]>([]);
  useEffect(() => {
    if (!authUser?.isAdmin && !authUser?.isEseCoordinator) {
      setAllSections([]);
      return;
    }
    fetch("/api/schedule?all=1", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { sections: [] }))
      .then((data: { sections?: AllSection[] }) =>
        setAllSections(Array.isArray(data.sections) ? data.sections : []),
      )
      .catch(() => setAllSections([]));
  }, [authUser?.id, authUser?.isAdmin, authUser?.isEseCoordinator]);
  type SchoolAccommodation = {
    id: number;
    name: string;
    category: "IEP" | "504" | "ELL" | "Strategy";
  };
  const [schoolAccommodations, setSchoolAccommodations] = useState<
    SchoolAccommodation[]
  >([]);
  useEffect(() => {
    fetch("/api/school-accommodations", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: SchoolAccommodation[]) =>
        setSchoolAccommodations(Array.isArray(rows) ? rows : []),
      )
      .catch(() => {});
  }, []);
  const accCategoryByName = useMemo(() => {
    const m = new Map<string, SchoolAccommodation["category"]>();
    for (const a of schoolAccommodations) m.set(a.name, a.category);
    return m;
  }, [schoolAccommodations]);
  interface MySection {
    id: number;
    period: number;
    courseName: string;
    isPlanning: boolean;
    studentIds: string[];
  }
  const [mySections, setMySections] = useState<MySection[]>([]);
  const periodRoster: Record<string, string[]> = Object.fromEntries(
    mySections.map((s) => [String(s.period), s.studentIds]),
  );
  const myPeriods: number[] = mySections
    .filter((s) => !s.isPlanning)
    .map((s) => s.period)
    .sort((a, b) => a - b);
  // Daily Class Log state
  const [dailyPeriod, setDailyPeriod] = useState<string>("");
  const [dailyAbsent, setDailyAbsent] = useState<Set<string>>(new Set());
  const [dailyAbsentConfirmed, setDailyAbsentConfirmed] = useState(false);
  const [dailySelectedAccs, setDailySelectedAccs] = useState<Set<number>>(
    new Set(),
  );
  const [dailySubmitMsg, setDailySubmitMsg] = useState("");
  const [dailyApplyPulse, setDailyApplyPulse] = useState(false);
  // Reports sub-tab state
  type ReportRange = "today" | "7d" | "30d" | "custom";
  const [reportRange, setReportRange] = useState<ReportRange>("7d");
  const [reportCustomFrom, setReportCustomFrom] = useState("");
  const [reportCustomTo, setReportCustomTo] = useState("");
  const [reportTeacherId, setReportTeacherId] = useState<number | "">("");
  const [reportPeriod, setReportPeriod] = useState<string>("");
  const [reportTeachers, setReportTeachers] = useState<
    Array<{ id: number; displayName: string }>
  >([]);
  interface ReportData {
    teacher: { id: number; displayName: string };
    range: { from: string; to: string; days: number };
    periodFilter: number | null;
    sections: Array<{
      id: number;
      period: number;
      courseName: string;
      isPlanning: boolean;
      rosterCount: number;
      accommodatedRosterCount: number;
    }>;
    daily: Array<{
      date: string;
      period: number;
      sectionId: number | null;
      submitted: boolean;
      providedCount: number;
      refusedCount: number;
      coverage: { logged: number; eligible: number };
    }>;
    totals: {
      providedCount: number;
      refusedCount: number;
      daysWithActivity: number;
      avgCoveragePct: number | null;
    };
    recent: Array<{
      id: number;
      createdAt: string;
      period: number | null;
      studentId: string;
      studentName: string;
      accommodation: string;
      status: string;
    }>;
  }
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  // ESE coordinator state
  const [schoolAccs, setSchoolAccs] = useState<
    Array<{
      id: number;
      name: string;
      category: string;
      active: boolean;
      inUseCount: number;
    }>
  >([]);
  const [eseTab, setEseTab] = useState<"students" | "master">("students");
  const [eseStudentSearch, setEseStudentSearch] = useState("");
  const [eseStudentId, setEseStudentId] = useState("");
  const [eseStudentAccs, setEseStudentAccs] = useState<
    Array<{
      id: number;
      accommodationId: number;
      name: string;
      category: string;
      assignedAt: string;
      assignedByStaffId: number | null;
      removedAt: string | null;
      removedByStaffId: number | null;
    }>
  >([]);
  const [eseAddSelected, setEseAddSelected] = useState<Set<number>>(new Set());

  // PBIS Reasons master list (managed by admin or PBIS coordinator)
  type PbisReason = {
    id: number;
    name: string;
    category: string;
    defaultPoints: number;
    active: boolean;
  };
  const [pbisReasonsList, setPbisReasonsList] = useState<PbisReason[]>([]);
  const [pbisListMsg, setPbisListMsg] = useState("");
  const [newPbisReasonName, setNewPbisReasonName] = useState("");
  const [newPbisReasonCategory, setNewPbisReasonCategory] = useState("Character");
  const [newPbisReasonPoints, setNewPbisReasonPoints] = useState<number>(1);

  // Classroom Intervention Types master list (managed by admin or behavior specialist)
  type InterventionType = {
    id: number;
    name: string;
    category: string;
    requiresNote: boolean;
    active: boolean;
  };
  const [interventionList, setInterventionList] = useState<InterventionType[]>([]);
  // Polarity (keep-apart) pairs: students who must not both be on a hall pass
  // at the same time. Managed in the Interventions tab.
  type PolarityPair = {
    id: number;
    studentIdA: string;
    studentAFirstName: string | null;
    studentALastName: string | null;
    studentIdB: string;
    studentBFirstName: string | null;
    studentBLastName: string | null;
    note: string | null;
    createdAt: string;
  };
  const [polarityPairs, setPolarityPairs] = useState<PolarityPair[]>([]);
  const [polaritySearchA, setPolaritySearchA] = useState("");
  const [polaritySelectedA, setPolaritySelectedA] = useState("");
  const [polaritySearchB, setPolaritySearchB] = useState("");
  const [polaritySelectedB, setPolaritySelectedB] = useState("");
  const [polarityNote, setPolarityNote] = useState("");
  const [polarityMsg, setPolarityMsg] = useState("");

  // ---- Hall Pass Daily Limits ----
  type StudentHallPassLimit = {
    id: number;
    studentId: string;
    dailyLimit: number;
    note: string | null;
    parentApproved: boolean;
    active: boolean;
    createdByName: string | null;
    createdAt: string;
    firstName: string | null;
    lastName: string | null;
  };
  const [hpLimits, setHpLimits] = useState<StudentHallPassLimit[]>([]);
  const [hpLimitMsg, setHpLimitMsg] = useState("");
  const [hpLimitSearch, setHpLimitSearch] = useState("");
  const [hpLimitSelected, setHpLimitSelected] = useState("");
  const [hpLimitValue, setHpLimitValue] = useState<number>(3);
  const [hpLimitNote, setHpLimitNote] = useState("");
  const [hpLimitParentOk, setHpLimitParentOk] = useState(false);
  const [hpGlobalLimitDraft, setHpGlobalLimitDraft] = useState<string>("");
  const [hpGlobalLimitMsg, setHpGlobalLimitMsg] = useState("");
  const [intervListMsg, setIntervListMsg] = useState("");
  const [newIntervName, setNewIntervName] = useState("");
  const [newIntervCategory, setNewIntervCategory] = useState("Classroom");
  const [newIntervRequiresNote, setNewIntervRequiresNote] = useState(false);

  // Pullout Reasons master list (managed by admin or behavior specialist)
  type PulloutReason = {
    id: number;
    name: string;
    category: string;
    active: boolean;
  };
  const [pulloutReasonList, setPulloutReasonList] = useState<PulloutReason[]>(
    [],
  );
  const [pulloutReasonMsg, setPulloutReasonMsg] = useState("");
  const [newPulloutReasonName, setNewPulloutReasonName] = useState("");
  const [newPulloutReasonCategory, setNewPulloutReasonCategory] =
    useState("Behavior");
  const [eseNewName, setEseNewName] = useState("");
  const [eseNewCategory, setEseNewCategory] = useState("Strategy");
  // Inline editing of a master accommodation row
  const [eseEditingId, setEseEditingId] = useState<number | null>(null);
  const [eseEditName, setEseEditName] = useState("");
  const [eseEditCategory, setEseEditCategory] = useState("Strategy");
  // Student Assignments sub-category tab + matrix state
  const [eseAssignCategory, setEseAssignCategory] = useState<
    "IEP" | "504" | "ELL"
  >("IEP");
  type CategoryMatrix = {
    category: string;
    accommodations: { id: number; name: string }[];
    students: {
      studentId: string;
      firstName: string;
      lastName: string;
      grade: number;
      assignments: Record<number, number>;
    }[];
  };
  const [eseMatrix, setEseMatrix] = useState<CategoryMatrix | null>(null);
  const [eseMatrixLoading, setEseMatrixLoading] = useState(false);
  const [eseMatrixMsg, setEseMatrixMsg] = useState("");
  // Frontend-only "newly added" students whose row is shown but who don't yet
  // have any assignment in the active category.
  const [eseExtraStudentIds, setEseExtraStudentIds] = useState<
    Record<string, string[]>
  >({ IEP: [], "504": [], ELL: [] });
  const [accommodationLogs, setAccommodationLogs] = useState<
    {
      id: number;
      studentId: string;
      accommodation: string;
      period: number | null;
      staffName: string;
      createdAt: string;
    }[]
  >([]);
  const [emailStatus, setEmailStatus] = useState("");
  const [emailOverride, setEmailOverride] = useState("");
  const [emailMessageType, setEmailMessageType] = useState<
    "positive" | "pbis" | "attendance" | "checkInOut"
  >("positive");
  const [emailSubjectDraft, setEmailSubjectDraft] = useState("");
  const [emailBodyDraft, setEmailBodyDraft] = useState("");
  const [emailSending, setEmailSending] = useState(false);

  const [pbisEntries, setPbisEntries] = useState<PbisEntry[]>([]);
  const [supportNotes, setSupportNotes] = useState<SupportNote[]>([]);
  const [supportNoteType, setSupportNoteType] = useState(supportNoteTypes[0]);
  const [supportNoteText, setSupportNoteText] = useState("");
  const [pbisStudentId, setPbisStudentId] = useState("");
  const [pbisStudentSearch, setPbisStudentSearch] = useState("");
  const [pbisOptionIndex, setPbisOptionIndex] = useState(0);
  const [pbisReasonId, setPbisReasonId] = useState<number | "">("");

  // PBIS report panel state
  type PbisReportRow = {
    id: number;
    createdAt: string;
    studentId: string;
    studentName: string;
    reason: string;
    points: number;
    staffName: string;
  };
  type PbisReport = {
    range: { from: string; to: string; days: number };
    scope: "school" | "self";
    appliedFilters: {
      teacherName: string | null;
      reason: string | null;
      studentId: string | null;
    };
    totals: {
      count: number;
      totalPoints: number;
      distinctStudents: number;
      truncated: boolean;
    };
    byReason: Array<{ reason: string; count: number; points: number }>;
    byTeacher: Array<{ teacherName: string; count: number; points: number }>;
    rows: PbisReportRow[];
  };
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const sevenDaysAgoIso = () => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  };
  const [pbisReportFrom, setPbisReportFrom] = useState(sevenDaysAgoIso());
  const [pbisReportTo, setPbisReportTo] = useState(todayIso());
  const [pbisReportTeacher, setPbisReportTeacher] = useState("");
  const [pbisReportReason, setPbisReportReason] = useState("");
  const [pbisReportStudent, setPbisReportStudent] = useState("");
  const [pbisReport, setPbisReport] = useState<PbisReport | null>(null);
  const [pbisReportMsg, setPbisReportMsg] = useState("");
  const [pbisReportBusy, setPbisReportBusy] = useState(false);

  // PBIS milestones (parent-email triggers)
  type PbisMilestone = {
    id: number;
    points: number;
    active: boolean;
    createdAt: string;
  };
  type MilestoneResult = {
    milestonePoints: number;
    status: "sent" | "skipped" | "error";
    emailTo: string | null;
    errorMsg: string | null;
  };
  type PbisMilestoneEmailRow = {
    id: number;
    studentId: string;
    milestonePoints: number;
    sentAt: string;
    emailTo: string | null;
    status: string;
    errorMsg: string | null;
  };
  const [pbisMilestones, setPbisMilestones] = useState<PbisMilestone[]>([]);
  const [newMilestonePoints, setNewMilestonePoints] = useState<number>(25);
  const [milestoneListMsg, setMilestoneListMsg] = useState("");
  const [milestoneEmailLog, setMilestoneEmailLog] = useState<
    PbisMilestoneEmailRow[]
  >([]);
  const [recentMilestoneToasts, setRecentMilestoneToasts] = useState<
    { id: string; text: string; tone: "ok" | "warn" | "err" }[]
  >([]);

  const loadPbisMilestones = async () => {
    try {
      const res = await fetch("/api/pbis-milestones");
      if (!res.ok) return;
      const data = (await res.json()) as PbisMilestone[];
      setPbisMilestones(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    }
  };
  const loadMilestoneEmails = async () => {
    try {
      const res = await fetch("/api/pbis-milestone-emails");
      if (!res.ok) return;
      const data = (await res.json()) as PbisMilestoneEmailRow[];
      setMilestoneEmailLog(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    }
  };
  const addMilestone = async () => {
    setMilestoneListMsg("");
    try {
      const res = await fetch("/api/pbis-milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: newMilestonePoints }),
      });
      const j = (await res.json().catch(() => ({}))) as
        | PbisMilestone
        | { error?: string };
      if (!res.ok) {
        setMilestoneListMsg(
          ("error" in j && j.error) || `Couldn't add (HTTP ${res.status}).`,
        );
        return;
      }
      setPbisMilestones((prev) =>
        [...prev, j as PbisMilestone].sort((a, b) => a.points - b.points),
      );
      setNewMilestonePoints(25);
    } catch (e) {
      setMilestoneListMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const toggleMilestone = async (m: PbisMilestone) => {
    setMilestoneListMsg("");
    try {
      const res = await fetch(`/api/pbis-milestones/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !m.active }),
      });
      const j = (await res.json().catch(() => ({}))) as
        | PbisMilestone
        | { error?: string };
      if (!res.ok) {
        setMilestoneListMsg(
          ("error" in j && j.error) || `Couldn't save (HTTP ${res.status}).`,
        );
        return;
      }
      setPbisMilestones((prev) =>
        prev.map((x) => (x.id === m.id ? (j as PbisMilestone) : x)),
      );
    } catch (e) {
      setMilestoneListMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const announceMilestoneResults = (
    studentLabel: string,
    results: MilestoneResult[] | undefined,
  ) => {
    if (!results || results.length === 0) return;
    const toasts = results.map((r) => {
      if (r.status === "sent") {
        return {
          id: `${studentLabel}-${r.milestonePoints}-${Date.now()}-${Math.random()}`,
          text: `📧 Sent ${r.milestonePoints}-pt milestone email for ${studentLabel} to ${r.emailTo}`,
          tone: "ok" as const,
        };
      }
      if (r.status === "skipped") {
        return {
          id: `${studentLabel}-${r.milestonePoints}-${Date.now()}-${Math.random()}`,
          text: `⚠️ Skipped ${r.milestonePoints}-pt email for ${studentLabel}: ${r.errorMsg ?? "skipped"}`,
          tone: "warn" as const,
        };
      }
      return {
        id: `${studentLabel}-${r.milestonePoints}-${Date.now()}-${Math.random()}`,
        text: `❌ ${r.milestonePoints}-pt email for ${studentLabel} failed: ${r.errorMsg ?? "error"}`,
        tone: "err" as const,
      };
    });
    setRecentMilestoneToasts((prev) => [...toasts, ...prev].slice(0, 6));
  };

  // PBIS leaderboard state
  type LeaderboardPeriod = "week" | "month" | "quarter" | "all";
  type LeaderboardData = {
    period: string;
    from: string | null;
    until: string;
    students: { studentId: string; total: number; count: number }[];
    staff: { staffId: number; staffName: string; total: number; count: number }[];
  };
  const [leaderboardPeriod, setLeaderboardPeriod] =
    useState<LeaderboardPeriod>("week");
  const [leaderboard, setLeaderboard] = useState<LeaderboardData | null>(null);
  const [leaderboardMsg, setLeaderboardMsg] = useState("");
  const [leaderboardBusy, setLeaderboardBusy] = useState(false);

  const loadLeaderboard = async (p: LeaderboardPeriod = leaderboardPeriod) => {
    setLeaderboardBusy(true);
    setLeaderboardMsg("");
    try {
      const res = await fetch(
        `/api/pbis/leaderboard?period=${encodeURIComponent(p)}&limit=10`,
      );
      const j = (await res.json().catch(() => ({}))) as LeaderboardData & {
        error?: string;
      };
      if (!res.ok) {
        setLeaderboardMsg(j.error || `Couldn't load (HTTP ${res.status}).`);
        setLeaderboard(null);
        return;
      }
      setLeaderboard(j);
    } catch (e) {
      setLeaderboardMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLeaderboardBusy(false);
    }
  };

  // PBIS bulk award state
  const [bulkSource, setBulkSource] = useState<"section" | "ids">("section");
  const [bulkSectionId, setBulkSectionId] = useState<number | "">("");
  const [bulkIdsText, setBulkIdsText] = useState("");
  const [bulkReasonId, setBulkReasonId] = useState<number | "">("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    createdCount: number;
    errors: { studentId: string; error: string }[];
  } | null>(null);
  const [bulkMsg, setBulkMsg] = useState("");

  const loadMySections = async () => {
    if (!authUser?.id) {
      setMySections([]);
      return;
    }
    try {
      const res = await fetch(`/api/schedule?staffId=${authUser.id}`, {
        credentials: "include",
      });
      if (!res.ok) {
        setMySections([]);
        return;
      }
      const data = (await res.json()) as { sections?: MySection[] };
      setMySections(Array.isArray(data.sections) ? data.sections : []);
    } catch {
      setMySections([]);
    }
  };

  const bulkSelectedIds = (): string[] => {
    if (bulkSource === "section") {
      const sec = mySections.find((s) => s.id === bulkSectionId);
      return sec ? sec.studentIds.slice() : [];
    }
    return Array.from(
      new Set(
        bulkIdsText
          .split(/[\s,;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
  };

  const submitBulkAward = async () => {
    setBulkMsg("");
    setBulkResult(null);
    const ids = bulkSelectedIds();
    if (ids.length === 0) {
      setBulkMsg("Pick a section or enter at least one student ID.");
      return;
    }
    if (typeof bulkReasonId !== "number") {
      setBulkMsg("Pick a reason.");
      return;
    }
    const reason = pbisReasonsList.find((r) => r.id === bulkReasonId);
    if (!reason) {
      setBulkMsg("Reason no longer exists. Refresh and try again.");
      return;
    }
    if (
      !window.confirm(
        `Award "${reason.name}" (${reason.defaultPoints} ${
          reason.defaultPoints === 1 ? "point" : "points"
        }) to ${ids.length} student${ids.length === 1 ? "" : "s"}?`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    try {
      const res = await fetch("/api/pbis/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentIds: ids,
          reason: reason.name,
          points: reason.defaultPoints,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        createdCount?: number;
        errors?: { studentId: string; error: string }[];
        entries?: PbisEntry[];
        milestoneProcessing?: string;
      };
      if (!res.ok) {
        setBulkMsg(j.error || `Couldn't award (HTTP ${res.status}).`);
        return;
      }
      setBulkResult({
        createdCount: j.createdCount ?? 0,
        errors: j.errors ?? [],
      });
      if (j.entries && j.entries.length) {
        setPbisEntries((prev) => [...prev, ...(j.entries as PbisEntry[])]);
      }
      if (j.milestoneProcessing === "queued") {
        setRecentMilestoneToasts((prev) =>
          [
            {
              id: `bulk-queued-${Date.now()}`,
              text: "📧 Milestone parent emails are processing in the background. See PBIS Lists › Recent milestone emails.",
              tone: "ok" as const,
            },
            ...prev,
          ].slice(0, 6),
        );
      }
    } catch (e) {
      setBulkMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  // PBIS goals state
  type PbisGoal = {
    id: number;
    studentId: string;
    reason: string | null;
    targetPoints: number;
    periodType: "week" | "month" | "quarter" | "all";
    createdById: number | null;
    createdByName: string;
    createdAt: string;
    archivedAt: string | null;
  };
  const [pbisGoals, setPbisGoals] = useState<PbisGoal[]>([]);
  const [goalReason, setGoalReason] = useState<string>("");
  const [goalTarget, setGoalTarget] = useState<number>(10);
  const [goalPeriod, setGoalPeriod] = useState<
    "week" | "month" | "quarter" | "all"
  >("week");
  const [goalMsg, setGoalMsg] = useState("");
  const [goalBusy, setGoalBusy] = useState(false);

  const loadPbisGoals = async () => {
    try {
      const res = await fetch("/api/pbis-goals");
      if (!res.ok) {
        setPbisGoals([]);
        return;
      }
      const data = (await res.json()) as PbisGoal[];
      setPbisGoals(Array.isArray(data) ? data : []);
    } catch {
      setPbisGoals([]);
    }
  };

  const periodWindow = (
    period: "week" | "month" | "quarter" | "all",
  ): { startIso: string | null; label: string } => {
    const now = new Date();
    if (period === "all") return { startIso: null, label: "All time" };
    if (period === "week") {
      // Monday 00:00 local
      const d = new Date(now);
      const day = d.getDay(); // 0=Sun..6=Sat
      const diff = (day === 0 ? -6 : 1 - day);
      d.setDate(d.getDate() + diff);
      d.setHours(0, 0, 0, 0);
      return { startIso: d.toISOString(), label: "This week" };
    }
    if (period === "month") {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startIso: d.toISOString(), label: "This month" };
    }
    // quarter
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    const d = new Date(now.getFullYear(), qStartMonth, 1);
    return { startIso: d.toISOString(), label: "This quarter" };
  };

  const computeGoalProgress = (goal: PbisGoal): number => {
    const { startIso } = periodWindow(goal.periodType);
    return pbisEntries
      .filter((e) => e.studentId === goal.studentId && !e.voidedAt)
      .filter((e) => (startIso ? e.createdAt >= startIso : true))
      .filter((e) => (goal.reason ? e.reason === goal.reason : true))
      .reduce((sum, e) => sum + (e.points || 0), 0);
  };

  const addPbisGoal = async (studentId: string) => {
    setGoalMsg("");
    if (!studentId) {
      setGoalMsg("Pick a student first.");
      return;
    }
    if (!Number.isInteger(goalTarget) || goalTarget < 1) {
      setGoalMsg("Target must be a positive whole number.");
      return;
    }
    setGoalBusy(true);
    try {
      const res = await fetch("/api/pbis-goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          reason: goalReason.trim() || undefined,
          targetPoints: goalTarget,
          periodType: goalPeriod,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setGoalMsg(j.error || `Couldn't add goal (HTTP ${res.status}).`);
        return;
      }
      setGoalReason("");
      setGoalTarget(10);
      setGoalPeriod("week");
      await loadPbisGoals();
    } catch (e) {
      setGoalMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setGoalBusy(false);
    }
  };

  const archivePbisGoal = async (id: number) => {
    if (!window.confirm("Archive this goal?")) return;
    try {
      const res = await fetch(`/api/pbis-goals/${id}/archive`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setGoalMsg(j.error || `Couldn't archive (HTTP ${res.status}).`);
        return;
      }
      await loadPbisGoals();
    } catch (e) {
      setGoalMsg(e instanceof Error ? e.message : String(e));
    }
  };

  // PBIS edit/void inline state
  const [pbisEditId, setPbisEditId] = useState<number | null>(null);
  const [pbisEditReason, setPbisEditReason] = useState("");
  const [pbisEditPoints, setPbisEditPoints] = useState<number>(1);
  const [pbisRowMsg, setPbisRowMsg] = useState<{
    id: number;
    msg: string;
  } | null>(null);

  const beginEditPbis = (e: PbisEntry) => {
    setPbisEditId(e.id);
    setPbisEditReason(e.reason);
    setPbisEditPoints(e.points);
    setPbisRowMsg(null);
  };
  const cancelEditPbis = () => {
    setPbisEditId(null);
    setPbisRowMsg(null);
  };
  const saveEditPbis = async (id: number) => {
    setPbisRowMsg(null);
    try {
      const res = await fetch(`/api/pbis/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: pbisEditReason.trim(),
          points: pbisEditPoints,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<PbisEntry>;
      if (!res.ok) {
        setPbisRowMsg({
          id,
          msg: j.error || `Couldn't save (HTTP ${res.status}).`,
        });
        return;
      }
      setPbisEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, ...(j as PbisEntry) } : e)),
      );
      setPbisEditId(null);
    } catch (err) {
      setPbisRowMsg({
        id,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const voidPbisEntry = async (id: number) => {
    const reason = window.prompt(
      "Why are you voiding this PBIS entry? (required)",
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setPbisRowMsg({ id, msg: "Void reason is required." });
      return;
    }
    setPbisRowMsg(null);
    try {
      const res = await fetch(`/api/pbis/${id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<PbisEntry>;
      if (!res.ok) {
        setPbisRowMsg({
          id,
          msg: j.error || `Couldn't void (HTTP ${res.status}).`,
        });
        return;
      }
      setPbisEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, ...(j as PbisEntry) } : e)),
      );
    } catch (err) {
      setPbisRowMsg({
        id,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Log Intervention (teacher form) state
  type InterventionEntry = {
    id: number;
    studentId: string;
    interventionType: string;
    note: string | null;
    staffId: number | null;
    staffName: string;
    createdAt: string;
  };
  const [interventionEntries, setInterventionEntries] = useState<
    InterventionEntry[]
  >([]);
  const [logIntervStudentId, setLogIntervStudentId] = useState("");
  const [logIntervStudentSearch, setLogIntervStudentSearch] = useState("");
  const [logIntervTypeId, setLogIntervTypeId] = useState<number | "">("");
  const [logIntervNote, setLogIntervNote] = useState("");
  const [logIntervMsg, setLogIntervMsg] = useState("");
  const [logIntervBusy, setLogIntervBusy] = useState(false);

  const loadInterventionEntries = async () => {
    try {
      const res = await fetch("/api/interventions");
      if (!res.ok) {
        setInterventionEntries([]);
        return;
      }
      const data = (await res.json()) as InterventionEntry[];
      setInterventionEntries(Array.isArray(data) ? data : []);
    } catch {
      setInterventionEntries([]);
    }
  };

  const submitIntervention = async () => {
    setLogIntervMsg("");
    const sid = logIntervStudentId.trim();
    if (!sid) {
      setLogIntervMsg("Pick a student first.");
      return;
    }
    if (typeof logIntervTypeId !== "number") {
      setLogIntervMsg("Pick an intervention.");
      return;
    }
    setLogIntervBusy(true);
    try {
      const res = await fetch("/api/interventions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: sid,
          interventionTypeId: logIntervTypeId,
          note: logIntervNote.trim() || undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setLogIntervMsg(j.error || `Couldn't save (HTTP ${res.status}).`);
        return;
      }
      setLogIntervMsg("Saved.");
      setLogIntervNote("");
      await loadInterventionEntries();
    } catch (e) {
      setLogIntervMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLogIntervBusy(false);
    }
  };

  const runPbisReport = async () => {
    setPbisReportMsg("");
    setPbisReportBusy(true);
    try {
      const params = new URLSearchParams({
        from: pbisReportFrom,
        to: pbisReportTo,
      });
      if (pbisReportTeacher.trim())
        params.set("teacherName", pbisReportTeacher.trim());
      if (pbisReportReason.trim())
        params.set("reason", pbisReportReason.trim());
      if (pbisReportStudent.trim())
        params.set("studentId", pbisReportStudent.trim());
      const res = await fetch(`/api/reports/pbis?${params.toString()}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setPbisReport(null);
        setPbisReportMsg(
          res.status === 401
            ? "Your session expired. Please sign in again."
            : j.error || `Couldn't run report (HTTP ${res.status}).`,
        );
        return;
      }
      setPbisReport((await res.json()) as PbisReport);
    } catch (e) {
      setPbisReport(null);
      setPbisReportMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPbisReportBusy(false);
    }
  };
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [destination, setDestination] = useState("");
  const [originRoom, setOriginRoom] = useState("");
  const [destinationTeacher, setDestinationTeacher] = useState("");
  const [contactedAck, setContactedAck] = useState(false);
  const [staffDefaults, setStaffDefaults] = useState<Record<string, string>>(
    {},
  );
  const [apiDestinationMap, setApiDestinationMap] = useState<
    Record<string, string[]>
  >({});
  const [copiedRoom, setCopiedRoom] = useState<string | null>(null);

  useEffect(() => {
    const def = staffDefaults[currentStaffUser];
    if (def) setOriginRoom(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStaffUser, staffDefaults]);

  const [tardyEntryType, setTardyEntryType] = useState<
    "tardy" | "checkin" | "checkout"
  >("tardy");
  const [tardyNotes, setTardyNotes] = useState("");
  const [tardyCreateReturnPass, setTardyCreateReturnPass] = useState(false);
  const [tardyReturnPassTeacher, setTardyReturnPassTeacher] = useState(
    teachers[0],
  );
  const [tardyStudentId, setTardyStudentId] = useState("");
  const [tardyStudentSearch, setTardyStudentSearch] = useState("");
  const [tardyPeriod, setTardyPeriod] = useState("");
  const [tardyReason, setTardyReason] = useState("");
  const [tardyCheckInWith, setTardyCheckInWith] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const systemEndingRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const SYSTEM_END_MS = 15 * 60 * 1000;
    for (const p of hallPasses) {
      if (p.status !== "active") continue;
      if (systemEndingRef.current.has(p.id)) continue;
      const elapsed = now - new Date(p.createdAt).getTime();
      if (elapsed >= SYSTEM_END_MS) {
        systemEndingRef.current.add(p.id);
        fetch(`/api/hall-passes/${p.id}/end`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system: true }),
        })
          .then((res) => {
            if (!res.ok) {
              systemEndingRef.current.delete(p.id);
              return;
            }
            loadHallPasses();
          })
          .catch(() => {
            systemEndingRef.current.delete(p.id);
          });
      }
    }
  }, [now, hallPasses]);

  const loadAdminNotifications = () => {
    if (!authUser?.isAdmin) return;
    fetch("/api/admin/notifications")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAdminNotifications(data))
      .catch(() => setAdminNotifications([]));
  };

  const loadActiveKiosks = () => {
    if (!authUser?.isAdmin) return;
    fetch("/api/kiosk/activations?status=active")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setActiveKiosks(data))
      .catch(() => setActiveKiosks([]));
  };

  const resolveAdminNotification = async (id: number) => {
    const res = await fetch(`/api/admin/notifications/${id}/resolve`, {
      method: "POST",
    });
    if (res.ok) loadAdminNotifications();
  };

  const forceDeactivateKiosk = async (id: number, room: string) => {
    if (
      !window.confirm(
        `Force-deactivate the kiosk in ${room}? The next person who walks up will need to re-activate it.`,
      )
    ) {
      return;
    }
    const res = await fetch(`/api/kiosk/activations/${id}/deactivate`, {
      method: "POST",
    });
    if (res.ok) loadActiveKiosks();
  };

  useEffect(() => {
    loadAdminNotifications();
    loadActiveKiosks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.isAdmin]);

  const loadHallPasses = () => {
    fetch("/api/hall-passes")
      .then((res) => res.json())
      .then((data: HallPass[]) => setHallPasses(data))
      .catch((err) => console.error("Failed to load hall passes:", err));
  };

  useEffect(() => {
    import("./lib/authToken").then(({ authFetch, setAuthToken }) => {
      authFetch("/api/auth/me")
        .then((res) => (res.ok ? res.json() : null))
        .then(
          (user: (typeof authUser & { authToken?: string }) | null) => {
            if (user?.authToken) setAuthToken(user.authToken);
            setAuthUser(user);
          },
        )
        .catch(() => setAuthUser(null))
        .finally(() => setAuthLoading(false));
    });
  }, []);

  useEffect(() => {
    if (!authUser) return;
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("Health check response:", data))
      .catch((err) => console.error("Health check failed:", err));

    loadStudents();

    fetch("/api/location-allowed-destinations")
      .then((res) => res.json())
      .then(
        (
          data: { originName: string; destinationName: string }[],
        ) => {
          const map: Record<string, string[]> = {};
          for (const row of data) {
            if (!map[row.originName]) map[row.originName] = [];
            map[row.originName].push(row.destinationName);
          }
          for (const k of Object.keys(map)) {
            map[k].sort((a, b) => a.localeCompare(b));
          }
          setApiDestinationMap(map);
        },
      )
      .catch((err) =>
        console.error("Failed to load location destinations:", err),
      );

    fetch("/api/teacher-allowlist")
      .then((res) => (res.ok ? res.json() : []))
      .then(
        (
          data: { staffName: string; destinationName: string }[],
        ) => {
          const map: Record<string, string[]> = {};
          for (const row of Array.isArray(data) ? data : []) {
            if (!map[row.staffName]) map[row.staffName] = [];
            map[row.staffName].push(row.destinationName);
          }
          for (const k of Object.keys(map)) {
            map[k].sort((a, b) => a.localeCompare(b));
          }
          setTeacherAllowlistMap(map);
        },
      )
      .catch((err) =>
        console.error("Failed to load teacher allowlist:", err),
      );

    fetch("/api/staff-defaults")
      .then((res) => res.json())
      .then(
        (data: { staffName: string; defaultLocationName: string | null }[]) => {
          const map: Record<string, string> = {};
          for (const row of data) {
            if (row.defaultLocationName) {
              map[row.staffName] = row.defaultLocationName;
            }
          }
          setStaffDefaults(map);
        },
      )
      .catch((err) => console.error("Failed to load staff defaults:", err));

    loadAccommodationLogs();

    fetch(`/api/schedule?staffId=${authUser.id}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { sections: [] }))
      .then((data: { sections: MySection[] }) =>
        setMySections(data.sections ?? []),
      )
      .catch((err) => console.error("Failed to load schedule:", err));

    loadSchoolAccommodations();

    loadHallPasses();

    loadTardies();
    loadPbis();
    loadPbisReasons();
    loadSupportNotes();
    loadSchoolSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  // ---- Reports tab ----
  const loadReportTeachers = () => {
    fetch("/api/reports/teachers")
      .then((res) => (res.ok ? res.json() : { teachers: [] }))
      .then((data) =>
        setReportTeachers(Array.isArray(data.teachers) ? data.teachers : []),
      )
      .catch(() => setReportTeachers([]));
  };

  const computeReportRange = (): { from: string; to: string } | null => {
    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);
    const dayMs = 86400000;
    if (reportRange === "today") return { from: isoToday, to: isoToday };
    if (reportRange === "7d") {
      const from = new Date(today.getTime() - 6 * dayMs)
        .toISOString()
        .slice(0, 10);
      return { from, to: isoToday };
    }
    if (reportRange === "30d") {
      const from = new Date(today.getTime() - 29 * dayMs)
        .toISOString()
        .slice(0, 10);
      return { from, to: isoToday };
    }
    // custom
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(reportCustomFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(reportCustomTo)
    ) {
      return null;
    }
    if (reportCustomTo < reportCustomFrom) return null;
    return { from: reportCustomFrom, to: reportCustomTo };
  };

  const hpReportReqIdRef = useRef(0);
  const loadHpReport = async () => {
    if (!authUser || (!authUser.isAdmin && !authUser.isEseCoordinator)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hpReportDate)) {
      setHpReportError("Pick a valid date.");
      setHpReportData(null);
      return;
    }
    const myReqId = ++hpReportReqIdRef.current;
    setHpReportLoading(true);
    setHpReportError("");
    try {
      const res = await fetch(
        `/api/reports/hall-passes?date=${encodeURIComponent(hpReportDate)}`,
      );
      if (myReqId !== hpReportReqIdRef.current) return;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as HpReportData;
      if (myReqId !== hpReportReqIdRef.current) return;
      setHpReportData(data);
    } catch (err) {
      if (myReqId !== hpReportReqIdRef.current) return;
      setHpReportError(err instanceof Error ? err.message : String(err));
      setHpReportData(null);
    } finally {
      if (myReqId === hpReportReqIdRef.current) setHpReportLoading(false);
    }
  };

  // Auto-reload hall pass report when its tab is open and the date changes.
  useEffect(() => {
    if (
      activeSection === "hallPasses" &&
      hpView === "reports" &&
      authUser &&
      (authUser.isAdmin || authUser.isEseCoordinator)
    ) {
      loadHpReport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, hpView, hpReportDate, authUser?.id]);

  // Force hpView back to "overview" if the current user lacks admin/ESE access
  // (e.g., after sign-out/sign-in within same SPA session).
  useEffect(() => {
    if (
      authUser &&
      !authUser.isAdmin &&
      !authUser.isEseCoordinator &&
      hpView !== "overview"
    ) {
      setHpView("overview");
    }
  }, [authUser?.id, authUser?.isAdmin, authUser?.isEseCoordinator, hpView]);

  // On sign-in, default the Hall Passes scope to "mine" for teachers and
  // "all" for admins. Users can still flip the toggle either way after.
  useEffect(() => {
    if (!authUser) return;
    setPassFilter(authUser.isAdmin ? "all" : "mine");
  }, [authUser?.id, authUser?.isAdmin]);

  const reportReqIdRef = useRef(0);
  const loadReport = async () => {
    if (!reportTeacherId) {
      setReportData(null);
      setReportError("");
      return;
    }
    const range = computeReportRange();
    if (!range) {
      setReportError("Please pick a valid From / To date.");
      setReportData(null);
      return;
    }
    const myReqId = ++reportReqIdRef.current;
    setReportLoading(true);
    setReportError("");
    try {
      const params = new URLSearchParams({
        mode: "teacher",
        teacherId: String(reportTeacherId),
        from: range.from,
        to: range.to,
      });
      if (reportPeriod) params.set("period", reportPeriod);
      const res = await fetch(`/api/reports/accommodations?${params}`);
      if (myReqId !== reportReqIdRef.current) return;
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error(
            "Your session has expired. Please refresh the page and sign in again.",
          );
        }
        const text = await res.text().catch(() => "");
        let msg = text;
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j && typeof j.error === "string") msg = j.error;
        } catch {
          // text wasn't JSON — keep as-is
        }
        throw new Error(msg || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ReportData;
      if (myReqId !== reportReqIdRef.current) return;
      setReportData(data);
    } catch (err) {
      if (myReqId !== reportReqIdRef.current) return;
      setReportError(err instanceof Error ? err.message : String(err));
      setReportData(null);
    } finally {
      if (myReqId === reportReqIdRef.current) setReportLoading(false);
    }
  };

  // Load teachers list once for admin/ESE
  useEffect(() => {
    if (authUser && (authUser.isAdmin || authUser.isEseCoordinator)) {
      loadReportTeachers();
    }
    // Default selected teacher to the signed-in user when entering the tab
    if (authUser && reportTeacherId === "") {
      setReportTeacherId(authUser.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  // Reload when filters change AND we're on the reports view
  useEffect(() => {
    if (
      activeSection === "accommodations" &&
      accView === "reports" &&
      reportTeacherId !== ""
    ) {
      loadReport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSection,
    accView,
    reportTeacherId,
    reportPeriod,
    reportRange,
    reportCustomFrom,
    reportCustomTo,
  ]);

  const loadSchoolSettings = () => {
    fetch("/api/school-settings")
      .then((res) => res.json())
      .then((data) =>
        setSchoolSettings({
          schoolName: data.schoolName ?? "",
          fromName: data.fromName ?? "",
          emailSignature: data.emailSignature ?? "",
          periodCount:
            typeof data.periodCount === "number" ? data.periodCount : 7,
          hallPassMaxMinutes:
            typeof data.hallPassMaxMinutes === "number"
              ? data.hallPassMaxMinutes
              : 30,
          hallPassDefaultMinutes:
            typeof data.hallPassDefaultMinutes === "number"
              ? data.hallPassDefaultMinutes
              : 5,
          globalDailyHallPassLimit:
            typeof data.globalDailyHallPassLimit === "number"
              ? data.globalDailyHallPassLimit
              : null,
        }),
      )
      .catch((err) => console.error("Failed to load school settings:", err));
  };

  const saveSchoolSettings = async () => {
    setSettingsStatus("saving");
    setSettingsError("");
    try {
      const res = await fetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schoolSettings),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSchoolSettings({
        schoolName: data.schoolName ?? "",
        fromName: data.fromName ?? "",
        emailSignature: data.emailSignature ?? "",
        periodCount:
          typeof data.periodCount === "number" ? data.periodCount : 7,
        hallPassMaxMinutes:
          typeof data.hallPassMaxMinutes === "number"
            ? data.hallPassMaxMinutes
            : 30,
        hallPassDefaultMinutes:
          typeof data.hallPassDefaultMinutes === "number"
            ? data.hallPassDefaultMinutes
            : 5,
        globalDailyHallPassLimit:
          typeof data.globalDailyHallPassLimit === "number"
            ? data.globalDailyHallPassLimit
            : null,
      });
      setSettingsStatus("saved");
      setTimeout(() => setSettingsStatus("idle"), 2000);
    } catch (err) {
      setSettingsStatus("error");
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadTardies = () => {
    fetch("/api/tardies")
      .then((res) => res.json())
      .then((data: Tardy[]) => setTardies(data))
      .catch((err) => console.error("Failed to load tardies:", err));
  };

  const loadPbis = () => {
    fetch("/api/pbis")
      .then((res) => res.json())
      .then((data: PbisEntry[]) => setPbisEntries(data))
      .catch((err) => console.error("Failed to load pbis:", err));
  };

  const loadAccommodationLogs = () => {
    fetch("/api/accommodation-logs")
      .then((res) => res.json())
      .then((data) => setAccommodationLogs(data))
      .catch((err) =>
        console.error("Failed to load accommodation logs:", err),
      );
  };

  const loadStudents = () => {
    fetch("/api/students")
      .then((res) => res.json())
      .then((data: Student[]) => setStudents(data))
      .catch((err) => console.error("Failed to load students:", err));
  };

  const loadSchoolAccommodations = () => {
    fetch("/api/school-accommodations")
      .then((res) => res.json())
      .then((data) => setSchoolAccs(data))
      .catch((err) =>
        console.error("Failed to load school accommodations:", err),
      );
  };

  const loadPbisReasons = async () => {
    setPbisListMsg("");
    try {
      const res = await fetch("/api/pbis-reasons");
      if (res.status === 401) {
        // Swallow transient 401s on initial load — the user may not be signed
        // in yet, or the session cookie hasn't been attached to this request.
        // The Add helper will surface a clear message if it's actually broken.
        setPbisReasonsList([]);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setPbisReasonsList([]);
        setPbisListMsg(
          j.error || `Couldn't load reasons (HTTP ${res.status}).`,
        );
        return;
      }
      const data = (await res.json()) as PbisReason[];
      setPbisReasonsList(Array.isArray(data) ? data : []);
    } catch (e) {
      setPbisReasonsList([]);
      setPbisListMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const loadInterventionTypes = async () => {
    setIntervListMsg("");
    try {
      const res = await fetch("/api/intervention-types");
      if (res.status === 401) {
        // Swallow transient 401s on initial load (see loadPbisReasons note).
        setInterventionList([]);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setInterventionList([]);
        setIntervListMsg(
          j.error || `Couldn't load interventions (HTTP ${res.status}).`,
        );
        return;
      }
      const data = (await res.json()) as InterventionType[];
      setInterventionList(Array.isArray(data) ? data : []);
    } catch (e) {
      setInterventionList([]);
      setIntervListMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const loadPolarityPairs = async () => {
    setPolarityMsg("");
    try {
      const res = await fetch("/api/polarity-pairs");
      if (res.status === 401) {
        setPolarityPairs([]);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setPolarityPairs([]);
        setPolarityMsg(
          j.error || `Couldn't load keep-apart pairs (HTTP ${res.status}).`,
        );
        return;
      }
      const data = (await res.json()) as PolarityPair[];
      setPolarityPairs(Array.isArray(data) ? data : []);
    } catch (e) {
      setPolarityPairs([]);
      setPolarityMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const addPolarityPair = async () => {
    setPolarityMsg("");
    const a = polaritySelectedA.trim();
    const b = polaritySelectedB.trim();
    if (!a || !b) {
      setPolarityMsg("Pick both students from the dropdown.");
      return;
    }
    if (a === b) {
      setPolarityMsg("Pick two different students.");
      return;
    }
    try {
      const res = await fetch("/api/polarity-pairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentIdA: a,
          studentIdB: b,
          note: polarityNote.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setPolarityMsg(j.error || `Add failed (HTTP ${res.status}).`);
        return;
      }
      setPolaritySearchA("");
      setPolaritySelectedA("");
      setPolaritySearchB("");
      setPolaritySelectedB("");
      setPolarityNote("");
      await loadPolarityPairs();
    } catch (e) {
      setPolarityMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const deletePolarityPair = async (id: number) => {
    if (!confirm("Remove this keep-apart pair?")) return;
    setPolarityMsg("");
    try {
      const res = await fetch(`/api/polarity-pairs/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setPolarityMsg(j.error || `Delete failed (HTTP ${res.status}).`);
        return;
      }
      await loadPolarityPairs();
    } catch (e) {
      setPolarityMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const loadHpLimits = async () => {
    if (!authUser) return;
    try {
      const sid = `?staffId=${authUser.id}`;
      const res = await fetch(`/api/student-hall-pass-limits${sid}`, {
        credentials: "include",
      });
      if (!res.ok) {
        setHpLimits([]);
        return;
      }
      const data = (await res.json()) as StudentHallPassLimit[];
      setHpLimits(Array.isArray(data) ? data : []);
    } catch {
      setHpLimits([]);
    }
  };

  const addHpLimit = async () => {
    setHpLimitMsg("");
    const studentId = hpLimitSelected.trim();
    if (!studentId) {
      setHpLimitMsg("Pick a student.");
      return;
    }
    if (
      !Number.isInteger(hpLimitValue) ||
      hpLimitValue < 1 ||
      hpLimitValue > 100
    ) {
      setHpLimitMsg("Daily limit must be a whole number between 1 and 100.");
      return;
    }
    if (!hpLimitParentOk) {
      setHpLimitMsg(
        "Parent approval is required before saving a per-student pass limit.",
      );
      return;
    }
    try {
      const sid = `?staffId=${authUser?.id ?? ""}`;
      const res = await fetch(`/api/student-hall-pass-limits${sid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          studentId,
          dailyLimit: hpLimitValue,
          note: hpLimitNote.trim() || undefined,
          parentApproved: hpLimitParentOk,
          staffId: authUser?.id,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setHpLimitMsg(j.error || `Save failed (HTTP ${res.status}).`);
        return;
      }
      setHpLimitSearch("");
      setHpLimitSelected("");
      setHpLimitNote("");
      setHpLimitParentOk(false);
      setHpLimitValue(3);
      await loadHpLimits();
    } catch (e) {
      setHpLimitMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const removeHpLimit = async (id: number) => {
    if (!confirm("Remove this student's daily hall-pass limit?")) return;
    try {
      const sid = `?staffId=${authUser?.id ?? ""}`;
      const res = await fetch(`/api/student-hall-pass-limits/${id}${sid}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setHpLimitMsg(j.error || `Remove failed (HTTP ${res.status}).`);
        return;
      }
      await loadHpLimits();
    } catch (e) {
      setHpLimitMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const saveGlobalHpLimit = async () => {
    setHpGlobalLimitMsg("");
    const trimmed = hpGlobalLimitDraft.trim();
    let value: number | null = null;
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        setHpGlobalLimitMsg(
          "Global limit must be empty (no cap) or a whole number 1–100.",
        );
        return;
      }
      value = n;
    }
    try {
      const res = await fetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ globalDailyHallPassLimit: value }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setHpGlobalLimitMsg(
          j.error || `Save failed (HTTP ${res.status}).`,
        );
        return;
      }
      const updated = (await res.json()) as {
        globalDailyHallPassLimit: number | null;
      };
      setSchoolSettings((s) => ({
        ...s,
        ...(updated as Partial<typeof s>),
      }));
      setHpGlobalLimitMsg("Saved.");
      setTimeout(() => setHpGlobalLimitMsg(""), 1800);
    } catch (e) {
      setHpGlobalLimitMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const addPbisReason = async () => {
    const name = newPbisReasonName.trim();
    if (!name) {
      setPbisListMsg("Name is required.");
      return;
    }
    setPbisListMsg("");
    try {
      const res = await fetch("/api/pbis-reasons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category: newPbisReasonCategory.trim() || "General",
          defaultPoints: Number(newPbisReasonPoints) || 1,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNewPbisReasonName("");
      setNewPbisReasonPoints(1);
      loadPbisReasons();
    } catch (e) {
      setPbisListMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const togglePbisReasonActive = async (id: number, active: boolean) => {
    setPbisListMsg("");
    try {
      const res = await fetch(`/api/pbis-reasons/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      loadPbisReasons();
    } catch (e) {
      setPbisListMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const addInterventionType = async () => {
    const name = newIntervName.trim();
    if (!name) {
      setIntervListMsg("Name is required.");
      return;
    }
    setIntervListMsg("");
    try {
      const res = await fetch("/api/intervention-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category: newIntervCategory.trim() || "Classroom",
          requiresNote: newIntervRequiresNote,
        }),
      });
      if (res.status === 401) {
        throw new Error(
          "Your session expired. Please refresh the page (or open it in a new tab) and sign in again.",
        );
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNewIntervName("");
      setNewIntervRequiresNote(false);
      loadInterventionTypes();
    } catch (e) {
      setIntervListMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleInterventionActive = async (id: number, active: boolean) => {
    setIntervListMsg("");
    try {
      const res = await fetch(`/api/intervention-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      loadInterventionTypes();
    } catch (e) {
      setIntervListMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteInterventionType = async (id: number, name: string) => {
    if (
      !window.confirm(
        `Delete intervention "${name}"? This permanently removes it from the picker. Existing logged entries keep the name as a snapshot and are not affected.`,
      )
    ) {
      return;
    }
    setIntervListMsg("");
    try {
      const res = await fetch(`/api/intervention-types/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      loadInterventionTypes();
    } catch (e) {
      setIntervListMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const loadPulloutReasons = async () => {
    setPulloutReasonMsg("");
    try {
      const res = await fetch("/api/pullout-reasons");
      if (res.status === 401) {
        // Session not ready yet (startup race or just-signed-out). The card
        // itself is gated to signed-in users, so swallow this silently and
        // wait for the next navigation/refresh to retry.
        setPulloutReasonList([]);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setPulloutReasonList([]);
        setPulloutReasonMsg(
          j.error || `Couldn't load reasons (HTTP ${res.status}).`,
        );
        return;
      }
      const data = (await res.json()) as PulloutReason[];
      setPulloutReasonList(Array.isArray(data) ? data : []);
    } catch (e) {
      setPulloutReasonList([]);
      setPulloutReasonMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const addPulloutReason = async () => {
    const name = newPulloutReasonName.trim();
    if (!name) {
      setPulloutReasonMsg("Name is required.");
      return;
    }
    setPulloutReasonMsg("");
    try {
      const res = await fetch("/api/pullout-reasons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category: newPulloutReasonCategory.trim() || "General",
        }),
      });
      if (res.status === 401) {
        throw new Error(
          "Your session expired. Please refresh the page (or open it in a new tab) and sign in again.",
        );
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNewPulloutReasonName("");
      loadPulloutReasons();
    } catch (e) {
      setPulloutReasonMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const togglePulloutReasonActive = async (id: number, active: boolean) => {
    setPulloutReasonMsg("");
    try {
      const res = await fetch(`/api/pullout-reasons/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      loadPulloutReasons();
    } catch (e) {
      setPulloutReasonMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const deletePulloutReason = async (id: number, name: string) => {
    if (
      !window.confirm(
        `Delete the pullout reason "${name}"? Past pullouts using it stay intact.`,
      )
    ) {
      return;
    }
    setPulloutReasonMsg("");
    try {
      const res = await fetch(`/api/pullout-reasons/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      loadPulloutReasons();
    } catch (e) {
      setPulloutReasonMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const loadEseStudentAccs = (studentId: string) => {
    if (!studentId) {
      setEseStudentAccs([]);
      return;
    }
    const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
    fetch(`/api/students/${studentId}/accommodations${sid}`, {
      credentials: "include",
    })
      .then((res) => res.json())
      .then((data) => setEseStudentAccs(data))
      .catch((err) =>
        console.error("Failed to load student accommodations:", err),
      );
  };

  const playEkgBeep = () => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      // Two short sine pulses — a classic ECG monitor "blip-blip"
      const blip = (start: number, freq: number, dur: number, peak: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.02);
      };
      blip(now, 880, 0.12, 0.18);
      blip(now + 0.16, 660, 0.18, 0.14);
      window.setTimeout(() => ctx.close().catch(() => {}), 600);
    } catch {
      // Audio is a nice-to-have; ignore if blocked.
    }
  };

  const submitDailyLog = async () => {
    if (!dailyPeriod) {
      setDailySubmitMsg("Pick a period first.");
      return;
    }
    if (dailySelectedAccs.size === 0) {
      setDailySubmitMsg("Select at least one accommodation.");
      return;
    }
    const periodNum = Number(dailyPeriod);
    const allInPeriod = periodRoster[dailyPeriod] ?? [];
    // Only send students who (a) are in the period, (b) are not absent, and
    // (c) actually have at least one IEP/504/ELL accommodation. Sending the
    // whole roster makes the server's "skipped not on student's plan" count
    // huge and confusing.
    const eligibleCats = new Set(["IEP", "504", "ELL"]);
    const studentHasTrackedAcc = (id: string) => {
      const st = students.find((s) => s.studentId === id);
      if (!st) return false;
      for (const name of st.accommodations ?? []) {
        const cat = accCategoryByName.get(name);
        if (cat && eligibleCats.has(cat)) return true;
      }
      return false;
    };
    const present = allInPeriod.filter(
      (id) => !dailyAbsent.has(id) && studentHasTrackedAcc(id),
    );
    if (present.length === 0) {
      setDailySubmitMsg("No present students with accommodations to log.");
      return;
    }
    setDailySubmitMsg("Submitting...");
    try {
      const url = authUser?.id
        ? `/api/accommodation-logs/bulk?staffId=${authUser.id}`
        : "/api/accommodation-logs/bulk";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          period: periodNum,
          presentStudentIds: present,
          accommodationIds: Array.from(dailySelectedAccs),
          staffId: authUser?.id,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const studentCount = present.length;
      const recordsWord =
        data.inserted === 1 ? "record" : "records";
      const studentsWord =
        studentCount === 1 ? "student" : "students";
      let msg = `${data.inserted} ${recordsWord} logged for ${studentCount} present ${studentsWord}.`;
      if (data.skippedDuplicate) {
        msg += ` (${data.skippedDuplicate} already logged earlier today.)`;
      }
      setDailySubmitMsg(msg);
      setDailySelectedAccs(new Set());
      setDailyApplyPulse(true);
      window.setTimeout(() => setDailyApplyPulse(false), 1500);
      playEkgBeep();
      loadAccommodationLogs();
    } catch (err) {
      setDailySubmitMsg(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const eseAssignSelected = async () => {
    if (!eseStudentId || eseAddSelected.size === 0) return;
    try {
      const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
      const res = await fetch(
        `/api/students/${eseStudentId}/accommodations${sid}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            accommodationIds: Array.from(eseAddSelected),
            staffId: authUser?.id,
          }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      setEseAddSelected(new Set());
      loadEseStudentAccs(eseStudentId);
      loadStudents();
      loadSchoolAccommodations();
    } catch (err) {
      console.error("ESE assign failed:", err);
      window.alert(
        "Failed to assign: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const eseRemoveAssignment = async (assignmentId: number) => {
    if (!eseStudentId) return;
    if (
      !window.confirm(
        "Remove this accommodation? Removal date will be recorded; the assignment will appear in this student's history.",
      )
    )
      return;
    try {
      const res = await fetch(
        `/api/students/${eseStudentId}/accommodations/${assignmentId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) throw new Error(await res.text());
      loadEseStudentAccs(eseStudentId);
      loadStudents();
      loadSchoolAccommodations();
    } catch (err) {
      console.error("ESE remove failed:", err);
      window.alert(
        "Failed to remove: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const eseAddNewMaster = async () => {
    if (!eseNewName.trim()) return;
    try {
      const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
      const res = await fetch(`/api/school-accommodations${sid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: eseNewName.trim(),
          category: eseNewCategory,
          staffId: authUser?.id,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEseNewName("");
      loadSchoolAccommodations();
    } catch (err) {
      window.alert(
        "Failed to add: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const eseToggleMasterActive = async (
    id: number,
    nextActive: boolean,
  ) => {
    try {
      const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
      const res = await fetch(`/api/school-accommodations/${id}${sid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ active: nextActive, staffId: authUser?.id }),
      });
      if (!res.ok) throw new Error(await res.text());
      loadSchoolAccommodations();
    } catch (err) {
      window.alert(
        "Failed: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const eseStartEditMaster = (a: { id: number; name: string; category: string }) => {
    setEseEditingId(a.id);
    setEseEditName(a.name);
    setEseEditCategory(a.category);
  };

  const eseCancelEditMaster = () => {
    setEseEditingId(null);
    setEseEditName("");
  };

  const eseSaveEditMaster = async () => {
    if (eseEditingId == null || !eseEditName.trim()) return;
    try {
      const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
      const res = await fetch(
        `/api/school-accommodations/${eseEditingId}${sid}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            name: eseEditName.trim(),
            category: eseEditCategory,
            staffId: authUser?.id,
          }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      eseCancelEditMaster();
      loadSchoolAccommodations();
    } catch (err) {
      window.alert(
        "Failed: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const eseDeleteMaster = async (a: {
    id: number;
    name: string;
    inUseCount: number;
    active: boolean;
  }) => {
    if (a.inUseCount > 0) {
      const ok = window.confirm(
        `"${a.name}" has ${a.inUseCount} active assignment${
          a.inUseCount === 1 ? "" : "s"
        } and cannot be deleted. Deactivate it instead?`,
      );
      if (!ok) return;
      eseToggleMasterActive(a.id, false);
      return;
    }
    if (!window.confirm(`Delete "${a.name}"? This cannot be undone.`)) return;
    try {
      const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
      const res = await fetch(`/api/school-accommodations/${a.id}${sid}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        window.alert(
          body.error ||
            "Cannot delete — this accommodation has assignment history. Deactivate instead.",
        );
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      loadSchoolAccommodations();
    } catch (err) {
      window.alert(
        "Failed: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const loadEseMatrix = async (category: "IEP" | "504" | "ELL") => {
    setEseMatrixLoading(true);
    setEseMatrixMsg("");
    try {
      const sid = authUser?.id ? `&staffId=${authUser.id}` : "";
      const res = await fetch(
        `/api/accommodation-category-matrix?category=${encodeURIComponent(
          category,
        )}${sid}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as CategoryMatrix;
      setEseMatrix(data);
    } catch (err) {
      setEseMatrixMsg(
        "Failed to load: " +
          (err instanceof Error ? err.message : String(err)),
      );
      setEseMatrix(null);
    } finally {
      setEseMatrixLoading(false);
    }
  };

  const eseMatrixToggle = async (
    studentId: string,
    accommodationId: number,
    currentlyAssigned: number | undefined,
  ) => {
    if (!eseMatrix) return;
    if (currentlyAssigned) {
      // Remove
      try {
        const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
        const res = await fetch(
          `/api/students/${studentId}/accommodations/${currentlyAssigned}${sid}`,
          { method: "DELETE", credentials: "include" },
        );
        if (!res.ok) throw new Error(await res.text());
        setEseMatrix((m) => {
          if (!m) return m;
          return {
            ...m,
            students: m.students.map((s) =>
              s.studentId !== studentId
                ? s
                : (() => {
                    const next = { ...s.assignments };
                    delete next[accommodationId];
                    return { ...s, assignments: next };
                  })(),
            ),
          };
        });
      } catch (err) {
        window.alert(
          "Failed: " + (err instanceof Error ? err.message : String(err)),
        );
      }
    } else {
      // Add
      try {
        const res = await fetch(`/api/students/${studentId}/accommodations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ accommodationIds: [accommodationId] }),
        });
        if (!res.ok) throw new Error(await res.text());
        // Reload matrix to capture the new assignmentId.
        loadEseMatrix(eseAssignCategory);
      } catch (err) {
        window.alert(
          "Failed: " + (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  };

  const logAccommodationProvided = async (
    studentId: string,
    accommodation: string,
    period: number | null,
  ) => {
    try {
      const res = await fetch("/api/accommodation-logs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          accommodation,
          period,
          staffName: currentStaffUser,
        }),
      });
      if (!res.ok) throw new Error("Failed to log");
      loadAccommodationLogs();
    } catch (err) {
      console.error("Failed to log accommodation:", err);
    }
  };

  const logAccommodationRefused = async (
    studentId: string,
    accommodation: string,
    period: number | null,
  ) => {
    try {
      const res = await fetch("/api/accommodation-logs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          accommodation,
          period,
          status: "refused",
          staffName: currentStaffUser,
        }),
      });
      if (!res.ok) throw new Error("Failed to log");
      loadAccommodationLogs();
    } catch (err) {
      console.error("Failed to log refused accommodation:", err);
    }
  };

  const loadSupportNotes = () => {
    fetch("/api/support-notes")
      .then((res) => res.json())
      .then((data: SupportNote[]) => setSupportNotes(data))
      .catch((err) => console.error("Failed to load support notes:", err));
  };

  const handleSupportNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activityStudentId || !supportNoteText.trim()) return;
    try {
      const res = await fetch("/api/support-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: activityStudentId,
          noteType: supportNoteType,
          noteText: supportNoteText.trim(),
          staffName: currentStaffUser,
        }),
      });
      if (!res.ok) throw new Error("Failed to save support note");
      loadSupportNotes();
      setSupportNoteText("");
      setSupportNoteType(supportNoteTypes[0]);
    } catch (err) {
      console.error(err);
    }
  };

  const handlePbisSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pbisStudentId) return;
    const reason = pbisReasonsList.find(
      (r) => r.id === pbisReasonId && r.active,
    );
    if (!reason) return;
    try {
      const res = await fetch("/api/pbis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: pbisStudentId,
          reason: reason.name,
          points: reason.defaultPoints,
          staffName: currentStaffUser,
        }),
      });
      if (!res.ok) throw new Error("Failed to save PBIS entry");
      const j = (await res.json().catch(() => ({}))) as {
        milestoneResults?: MilestoneResult[];
      };
      announceMilestoneResults(
        studentName(pbisStudentId) || pbisStudentId,
        j.milestoneResults,
      );
      loadPbis();
      setPbisStudentId("");
      setPbisStudentSearch("");
      setPbisReasonId("");
    } catch (err) {
      console.error(err);
    }
  };

  const handleTardySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tardyStudentId || !tardyPeriod) return;
    if (
      (tardyEntryType === "checkin" || tardyEntryType === "checkout") &&
      !tardyCheckInWith
    )
      return;
    try {
      const res = await fetch("/api/tardies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: tardyStudentId,
          teacherName: currentStaffUser,
          period: tardyPeriod,
          reason: tardyEntryType === "tardy" ? tardyReason : "",
          entryType: tardyEntryType,
          checkInWith:
            tardyEntryType === "checkin" || tardyEntryType === "checkout"
              ? tardyCheckInWith
              : null,
          notes: tardyNotes,
        }),
      });
      if (!res.ok) {
        console.error("Failed to create tardy:", await res.text());
        return;
      }
      setTardyStudentId("");
      setTardyStudentSearch("");
      setTardyPeriod("");
      setTardyReason("");
      setTardyCheckInWith("");
      setTardyNotes("");

      if (tardyEntryType === "tardy" && tardyCreateReturnPass) {
        try {
          const passRes = await fetch("/api/hall-passes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentId: tardyStudentId,
              destination: "Return to Class",
              originRoom: "Front Office",
              teacherName: tardyReturnPassTeacher,
            }),
          });
          if (!passRes.ok) {
            console.error(
              "Failed to create return pass:",
              await passRes.text(),
            );
          } else {
            loadHallPasses();
          }
        } catch (err) {
          console.error("Failed to create return pass:", err);
        }
      }

      setTardyCreateReturnPass(false);
      setTardyReturnPassTeacher(teachers[0]);
      loadTardies();
    } catch (err) {
      console.error("Failed to create tardy:", err);
    }
  };

  const handleEndPass = async (id: number) => {
    try {
      const res = await fetch(`/api/hall-passes/${id}/end`, {
        method: "PATCH",
      });
      if (!res.ok) {
        console.error("Failed to end hall pass:", await res.text());
        return;
      }
      loadHallPasses();
    } catch (err) {
      console.error("Failed to end hall pass:", err);
    }
  };

  const handleSavePassEdit = async (id: number) => {
    try {
      const endedAtIso = editEndedAt
        ? new Date(editEndedAt).toISOString()
        : null;
      const createdAtIso = editCreatedAt
        ? new Date(editCreatedAt).toISOString()
        : null;
      if (!createdAtIso) {
        alert("Started date is required.");
        return;
      }
      if (
        endedAtIso &&
        new Date(endedAtIso).getTime() <= new Date(createdAtIso).getTime()
      ) {
        alert("Started time must be before Ended time.");
        return;
      }
      const res = await fetch(`/api/hall-passes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endedAt: endedAtIso,
          createdAt: createdAtIso,
          editedBy: currentStaffUser,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error("Failed to edit hall pass:", text);
        alert("Failed to edit hall pass: " + text);
        return;
      }
      setEditingPassId(null);
      setEditEndedAt("");
      setEditCreatedAt("");
      loadHallPasses();
    } catch (err) {
      console.error("Failed to edit hall pass:", err);
    }
  };

  const effectiveDestinationsByRoom: Record<string, string[]> =
    Object.keys(apiDestinationMap).length > 0
      ? apiDestinationMap
      : destinationsByRoom;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStudentId || !destination || !originRoom) return;

    try {
      const res = await fetch("/api/hall-passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: selectedStudentId,
          destination,
          originRoom,
          teacherName: currentStaffUser,
          destinationTeacher: destinationTeacher || null,
          contactedAcknowledged: destinationTeacher ? contactedAck : false,
        }),
      });
      if (!res.ok) {
        console.error("Failed to create hall pass:", await res.text());
        return;
      }
      setDestination("");
      setOriginRoom("");
      setSelectedStudentId("");
      setStudentSearch("");
      setDestinationTeacher("");
      setContactedAck(false);
      loadHallPasses();
    } catch (err) {
      console.error("Failed to create hall pass:", err);
    }
  };

  const IconDoor = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 21h14" />
      <path d="M7 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17" />
      <circle cx="14.5" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
  const IconClock = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
  const IconUser = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
    </svg>
  );
  const IconStar = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.7 5.5 6 .9-4.4 4.3 1 6L12 17l-5.4 2.8 1-6L3.3 9.4l6-.9L12 3z" />
    </svg>
  );
  const IconClipboard = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4h6v3H9z" />
      <path d="M9 11h6M9 15h6" />
    </svg>
  );

  const IconSettings = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );

  const studentName = (id: string): string => {
    const s = students.find((x) => x.studentId === id);
    return s ? `${s.firstName} ${s.lastName}` : id;
  };

  const isAdmin = authUser?.isAdmin === true;
  const isEseCoord = authUser?.isEseCoordinator === true || isAdmin;
  const isPbisCoord = authUser?.isPbisCoordinator === true || isAdmin;
  const isBehaviorSpec = authUser?.isBehaviorSpecialist === true || isAdmin;
  const canManageBehaviorLists =
    isAdmin ||
    isBehaviorSpec ||
    authUser?.isMtssCoordinator === true ||
    authUser?.isDean === true;
  const isIssTeacher = authUser?.isIssTeacher === true || isAdmin;
  const isDean = authUser?.isDean === true || isAdmin;
  const isMtss = authUser?.isMtssCoordinator === true || isAdmin;
  const canVerifyPullouts = isAdmin || isDean || isMtss;
  const canViewIssDashboard =
    isAdmin || isIssTeacher || isBehaviorSpec || isDean || isMtss;

  // Pending pullout count for the verifier badge.
  const [pendingPulloutCount, setPendingPulloutCount] = useState<number>(0);
  const [pendingPulloutsTick, setPendingPulloutsTick] = useState(0);
  useEffect(() => {
    if (!canVerifyPullouts) {
      setPendingPulloutCount(0);
      return;
    }
    let cancelled = false;
    fetch("/api/pullouts?scope=pending")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled) return;
        if (Array.isArray(rows)) setPendingPulloutCount(rows.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canVerifyPullouts, pendingPulloutsTick]);

  // Unreviewed pullout count for the behavior-review badge.
  const canReviewPullouts = isAdmin || isBehaviorSpec;
  const [unreviewedPulloutCount, setUnreviewedPulloutCount] =
    useState<number>(0);
  const [unreviewedPulloutsTick, setUnreviewedPulloutsTick] = useState(0);
  useEffect(() => {
    if (!canReviewPullouts) {
      setUnreviewedPulloutCount(0);
      return;
    }
    let cancelled = false;
    fetch("/api/pullouts?scope=unreviewed")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled) return;
        if (Array.isArray(rows)) setUnreviewedPulloutCount(rows.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canReviewPullouts, unreviewedPulloutsTick]);

  useEffect(() => {
    if (!isAdmin && activeSection === "settings") {
      setActiveSection("hallPasses");
    }
    if (!canManageStaffRoles && activeSection === "staffRoles") {
      setActiveSection("hallPasses");
    }
    if (!isEseCoord && activeSection === "ese") {
      setActiveSection("hallPasses");
    }
    if (!isPbisCoord && activeSection === "pbisLists") {
      setActiveSection("hallPasses");
    }
    if (!canManageBehaviorLists && activeSection === "interventions") {
      setActiveSection("hallPasses");
    }
  }, [
    isAdmin,
    isEseCoord,
    isPbisCoord,
    isBehaviorSpec,
    canManageBehaviorLists,
    activeSection,
  ]);

  useEffect(() => {
    if (activeSection === "pbisLists" && isPbisCoord) {
      loadPbisReasons();
      loadPbisMilestones();
      loadMilestoneEmails();
    }
    if (activeSection === "pbis") {
      loadPbisGoals();
      loadMySections();
      loadLeaderboard();
    }
    if (activeSection === "interventions" && canManageBehaviorLists) {
      loadInterventionTypes();
      loadPulloutReasons();
    }
    if (activeSection === "hallPassMgmt" && canManageBehaviorLists) {
      loadPolarityPairs();
      loadHpLimits();
      setHpGlobalLimitDraft(
        schoolSettings.globalDailyHallPassLimit != null
          ? String(schoolSettings.globalDailyHallPassLimit)
          : "",
      );
    }
    if (activeSection === "requestPullout") {
      loadPulloutReasons();
      loadInterventionTypes();
    }
    if (activeSection === "logIntervention") {
      loadInterventionTypes();
      loadInterventionEntries();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, isPbisCoord, isBehaviorSpec, canManageBehaviorLists]);

  type NavSection = {
    key: typeof activeSection;
    label: string;
    icon: React.ReactNode;
  };
  const baseNavSections: NavSection[] = [
    { key: "hallPasses", label: "Hall Passes", icon: IconDoor },
    { key: "tardies", label: "Tardy / Check-Ins", icon: IconClock },
    { key: "student", label: "Student Activity", icon: IconUser },
    { key: "pbis", label: "PBIS Points", icon: IconStar },
    { key: "accommodations", label: "Accommodations", icon: IconClipboard },
    { key: "logIntervention", label: "Log Intervention", icon: IconClipboard },
    { key: "requestPullout", label: "Request Pullout", icon: IconClipboard },
  ];
  const eseNavSections: NavSection[] = [
    { key: "ese", label: "ESE Coordinator", icon: IconClipboard },
  ];
  const pbisListsNavSections: NavSection[] = [
    { key: "pbisLists", label: "PBIS Lists", icon: IconStar },
  ];
  const interventionsNavSections: NavSection[] = [
    { key: "interventions", label: "Interventions", icon: IconClipboard },
  ];
  const behaviorSpecNavSections: NavSection[] = [
    { key: "behaviorSpecialist", label: "Behavior Specialist", icon: IconClipboard },
  ];
  const adminNavSections: NavSection[] = [
    { key: "staffRoles", label: "Staff & Roles", icon: IconUser },
    { key: "settings", label: "Settings", icon: IconSettings },
  ];
  const canManageStaffRoles =
    Boolean(authUser?.isSuperUser) ||
    Boolean(authUser?.isAdmin) ||
    Boolean(authUser?.capStaffRoles);
  const navBadge = (key: typeof activeSection) => {
    const badgeStyle: React.CSSProperties = {
      marginLeft: 6,
      background: "#dc2626",
      color: "white",
      borderRadius: 999,
      padding: "0 7px",
      fontSize: "0.72rem",
      fontWeight: 700,
      lineHeight: "18px",
      display: "inline-block",
    };
    if (key === "verifyPullouts" && pendingPulloutCount > 0) {
      return <span style={badgeStyle}>{pendingPulloutCount}</span>;
    }
    if (key === "behaviorReview" && unreviewedPulloutCount > 0) {
      return <span style={badgeStyle}>{unreviewedPulloutCount}</span>;
    }
    return null;
  };
  const renderNavItem = (s: NavSection) => (
    <button
      key={s.key}
      type="button"
      className={"nav-item" + (activeSection === s.key ? " active" : "")}
      onClick={() => setActiveSection(s.key)}
    >
      <span className="nav-icon">{s.icon}</span>
      {s.label}
      {navBadge(s.key)}
    </button>
  );
  const userInitials = currentStaffUser
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (authLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-subtle, #64748b)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Loading…
      </div>
    );
  }

  if (!authUser) {
    return <Login onLogin={(u) => setAuthUser(u)} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand" aria-label="PulseED">
          <svg
            className="ekg-layer ekg-bg"
            viewBox="0 0 220 40"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              className="ekg-track"
              d="M0 20 H140 L146 16 L150 24 L154 5 L158 35 L162 16 L166 20 H220"
            />
          </svg>
          <span className="wordmark">
            Pulse<span className="accent">ED</span>
          </span>
          <svg
            className="ekg-layer ekg-fg"
            viewBox="0 0 220 40"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              className="ekg-pulse"
              d="M0 20 H140 L146 16 L150 24 L154 5 L158 35 L162 16 L166 20 H220"
            />
          </svg>
        </div>
        <div className="header-controls">
          <label>
            Show
            <select
              value={dateFilter}
              onChange={(e) =>
                setDateFilter(e.target.value as "today" | "all")
              }
            >
              <option value="all">All Records</option>
              <option value="today">Today Only</option>
            </select>
          </label>
          <label>
            Staff
            <select
              value={staffFilter}
              onChange={(e) =>
                setStaffFilter(e.target.value as "all" | "mine")
              }
            >
              <option value="all">All Staff</option>
              <option value="mine">My Records Only</option>
            </select>
          </label>
          <span className="user-pill">
            <span className="avatar">{userInitials || "?"}</span>
            <span style={{ padding: "0 0.5rem", whiteSpace: "nowrap" }}>
              {currentStaffUser}
            </span>
            <button
              type="button"
              onClick={() => {
                setChangePwCurrent("");
                setChangePwNew("");
                setChangePwError("");
                setChangePwOk(false);
                setShowChangePw(true);
              }}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "inherit",
                borderRadius: 6,
                padding: "0.25rem 0.6rem",
                cursor: "pointer",
                fontSize: "0.85rem",
                marginRight: 4,
              }}
            >
              Change password
            </button>
            <button
              type="button"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                setAuthUser(null);
              }}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "inherit",
                borderRadius: 6,
                padding: "0.25rem 0.6rem",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              Sign out
            </button>
          </span>
        </div>
      </header>

      {showChangePw && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => !changePwBusy && setShowChangePw(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              padding: 16,
              borderRadius: 8,
              minWidth: 320,
              maxWidth: "90vw",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Change your password</h3>
            <label style={{ display: "block", marginBottom: 8 }}>
              <div style={{ fontSize: 12 }}>Current password</div>
              <input
                type="password"
                autoFocus
                value={changePwCurrent}
                onChange={(e) => setChangePwCurrent(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", fontSize: 14 }}
              />
            </label>
            <label style={{ display: "block", marginBottom: 8 }}>
              <div style={{ fontSize: 12 }}>New password (min 8 chars)</div>
              <input
                type="password"
                value={changePwNew}
                onChange={(e) => setChangePwNew(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", fontSize: 14 }}
              />
            </label>
            {changePwError && (
              <div
                role="alert"
                style={{
                  background: "#fee2e2",
                  color: "#991b1b",
                  padding: 8,
                  borderRadius: 6,
                  fontSize: 13,
                  marginBottom: 8,
                }}
              >
                {changePwError}
              </div>
            )}
            {changePwOk && (
              <div
                style={{
                  background: "#dcfce7",
                  color: "#166534",
                  padding: 8,
                  borderRadius: 6,
                  fontSize: 13,
                  marginBottom: 8,
                }}
              >
                Password updated.
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                disabled={changePwBusy}
                onClick={() => setShowChangePw(false)}
              >
                {changePwOk ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                disabled={
                  changePwBusy ||
                  !changePwCurrent ||
                  changePwNew.length < 8 ||
                  changePwOk
                }
                onClick={async () => {
                  setChangePwBusy(true);
                  setChangePwError("");
                  try {
                    const { authFetch } = await import("./lib/authToken");
                    const res = await authFetch("/api/auth/change-password", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        currentPassword: changePwCurrent,
                        newPassword: changePwNew,
                      }),
                    });
                    if (!res.ok) {
                      const j = await res.json().catch(() => ({}));
                      throw new Error(
                        j.error || `Update failed (${res.status})`,
                      );
                    }
                    setChangePwOk(true);
                    setChangePwCurrent("");
                    setChangePwNew("");
                  } catch (e) {
                    setChangePwError(
                      e instanceof Error ? e.message : String(e),
                    );
                  } finally {
                    setChangePwBusy(false);
                  }
                }}
              >
                {changePwBusy ? "Saving…" : "Update password"}
              </button>
            </div>
          </div>
        </div>
      )}

      {(() => {
        const hasBelowEkg =
          isEseCoord ||
          isPbisCoord ||
          isBehaviorSpec ||
          canManageBehaviorLists ||
          canVerifyPullouts ||
          canViewIssDashboard ||
          canReviewPullouts ||
          isAdmin ||
          canManageStaffRoles;
        return (
          <aside className="sidebar">
            <div className="section-label">Workspace</div>
            {baseNavSections.map(renderNavItem)}
            {hasBelowEkg && (
              <>
                <div className="nav-admin-divider" aria-hidden="true">
                  <svg
                    className="nav-admin-ekg"
                    viewBox="0 0 220 12"
                    preserveAspectRatio="none"
                  >
                    <path
                      className="nav-admin-ekg-track"
                      d="M0 6 H80 L86 3 L90 9 L94 1 L98 11 L102 3 L106 6 H220"
                    />
                  </svg>
                </div>
                <div className="section-label nav-admin-label">Tools</div>
                {isEseCoord && eseNavSections.map(renderNavItem)}
                {isPbisCoord && pbisListsNavSections.map(renderNavItem)}
                {isBehaviorSpec && behaviorSpecNavSections.map(renderNavItem)}
                {canManageBehaviorLists && !isBehaviorSpec &&
                  interventionsNavSections.map(renderNavItem)}
                {canVerifyPullouts &&
                  renderNavItem({
                    key: "verifyPullouts",
                    label: "Verify Pullouts",
                    icon: IconClipboard,
                  })}
                {canViewIssDashboard &&
                  renderNavItem({
                    key: "issDashboard",
                    label: "ISS Dashboard",
                    icon: IconClipboard,
                  })}
                {canReviewPullouts && !isBehaviorSpec &&
                  renderNavItem({
                    key: "behaviorReview",
                    label: "Behavior Review",
                    icon: IconClipboard,
                  })}
                {isAdmin
                  ? adminNavSections.map(renderNavItem)
                  : canManageStaffRoles &&
                    renderNavItem(adminNavSections[0])}
              </>
            )}
          </aside>
        );
      })()}

      <main className="app-main">

      {activeSection === "hallPasses" && (<>
      {(authUser?.isAdmin || authUser?.isEseCoordinator) && (
        <div className="card no-print" style={{ paddingTop: "0.75rem", paddingBottom: "0.75rem" }}>
          <button
            type="button"
            onClick={() => setHpView("overview")}
            disabled={hpView === "overview"}
            style={{ marginRight: "0.25rem" }}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setHpView("reports")}
            disabled={hpView === "reports"}
          >
            Reports
          </button>
        </div>
      )}
      {hpView === "overview" && (<>
      {(() => {
        let active = 0;
        let overdue = 0;
        let ended = 0;
        for (const p of hallPasses) {
          if (p.status !== "active") {
            ended++;
          } else if (p.status === "active") {
            const expiresAt =
              new Date(p.createdAt).getTime() +
              p.maxDurationMinutes * 60 * 1000;
            if (now >= expiresAt) overdue++;
            else active++;
          }
        }
        return (
          <div className="card">
            <h2>Hall Pass Summary</h2>
            <div className="stat-grid">
              <div className="stat-card stat-active">
                <span className="stat-label">Active Passes</span>
                <span className="stat-value">{active}</span>
              </div>
              <div className="stat-card stat-overdue">
                <span className="stat-label">Overdue Passes</span>
                <span className="stat-value">{overdue}</span>
              </div>
              <div className="stat-card stat-ended">
                <span className="stat-label">Ended Passes</span>
                <span className="stat-value">{ended}</span>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="card cp-cta-card">
        <div className="cp-cta-text">Student Going Somewhere?</div>
        <button
          type="button"
          className="cp-cta-button"
          onClick={() => setCreatePassOpen(true)}
        >
          + Create Pass
        </button>
      </div>

      <CreatePassModal
        open={createPassOpen}
        onClose={() => setCreatePassOpen(false)}
        students={students}
        destinationsByRoom={effectiveDestinationsByRoom}
        defaultOriginRoom={originRoom || (staffDefaults[currentStaffUser] ?? "")}
        currentStaffUser={currentStaffUser}
        staffUsers={staffUsers}
        staffDefaults={staffDefaults}
        canChangeTeacher={Boolean(authUser?.isAdmin)}
        nearDestinations={teacherAllowlistMap[currentStaffUser] ?? []}
        bypassContactAck={Boolean(authUser?.isAdmin)}
        maxMinutes={schoolSettings.hallPassMaxMinutes}
        defaultMinutes={schoolSettings.hallPassDefaultMinutes}
        onCreate={async (payload) => {
          const res = await fetch("/api/hall-passes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentId: payload.studentId,
              destination: payload.destination,
              originRoom: payload.originRoom,
              teacherName: payload.fromTeacher || currentStaffUser,
              destinationTeacher: payload.destinationTeacher,
              contactedAcknowledged: payload.contactedAcknowledged,
              maxDurationMinutes: payload.maxDurationMinutes,
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || "Failed to create pass.");
          }
          loadHallPasses();
        }}
      />

      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>
              {passListView === "active" ? "Out Right Now" : "Pass Log"}
            </h2>
            <div
              style={{
                display: "inline-flex",
                border: "1px solid var(--border)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <button
                type="button"
                onClick={() => setPassListView("active")}
                disabled={passListView === "active"}
                style={{ border: "none", padding: "0.25rem 0.6rem" }}
              >
                Active now
              </button>
              <button
                type="button"
                onClick={() => setPassListView("log")}
                disabled={passListView === "log"}
                style={{ border: "none", padding: "0.25rem 0.6rem" }}
              >
                Full log
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
              Show:
            </span>
            <button
              type="button"
              onClick={() => setPassFilter("mine")}
              disabled={passFilter === "mine"}
            >
              Mine
            </button>
            <button
              type="button"
              onClick={() => setPassFilter("all")}
              disabled={passFilter === "all"}
            >
              All staff
            </button>
          </div>
        </div>

        {passListView === "active" ? (
          (() => {
            const visible = hallPasses
              .filter((p) => p.status === "active")
              .filter((p) =>
                passFilter === "mine"
                  ? p.teacherName === currentStaffUser
                  : true,
              )
              .sort(
                (a, b) =>
                  new Date(a.createdAt).getTime() -
                  new Date(b.createdAt).getTime(),
              );
            if (visible.length === 0) {
              return (
                <div
                  style={{
                    color: "var(--text-subtle)",
                    padding: "0.75rem 0",
                  }}
                >
                  No active passes right now.
                </div>
              );
            }
            return (
              <div style={{ display: "grid", gap: "0.5rem" }}>
                {visible.map((p) => {
                  const bg = getTimeStatusColor(p, now);
                  const status = formatTimeStatus(p, now);
                  const overdue = status === "Overdue";
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "minmax(180px,1.2fr) minmax(180px,1.4fr) minmax(110px,auto) auto",
                        alignItems: "center",
                        gap: "0.75rem",
                        padding: "0.6rem 0.75rem",
                        borderRadius: 8,
                        background: bg,
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {studentName(p.studentId)}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-subtle)",
                          }}
                        >
                          {p.studentId} · from {p.originRoom}
                        </div>
                      </div>
                      <div>
                        <div>→ {p.destination}</div>
                        {p.destinationTeacher && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-subtle)",
                            }}
                          >
                            with {p.destinationTeacher}
                          </div>
                        )}
                        {passFilter === "all" && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-subtle)",
                            }}
                          >
                            issued by {p.teacherName}
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          fontWeight: overdue ? 700 : 500,
                          color: overdue ? "var(--accent)" : undefined,
                        }}
                      >
                        {status}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleEndPass(p.id)}
                      >
                        End Pass
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })()
        ) : (
          <table
            border={1}
            cellPadding={6}
            style={{ borderCollapse: "collapse", width: "100%" }}
          >
            <thead>
              <tr>
                <th>Student</th>
                <th>Teacher</th>
                <th>Destination</th>
                <th>Origin</th>
                <th>Status</th>
                <th>Dur.</th>
                <th>Started</th>
                <th>Ended</th>
                <th>Time</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hallPasses
                .filter((p) =>
                  dateFilter === "today"
                    ? isCreatedToday(p.createdAt)
                    : true,
                )
                .filter((p) =>
                  passFilter === "mine"
                    ? p.teacherName === currentStaffUser
                    : true,
                )
                .map((p) => {
                  const isAdmin = authUser?.isAdmin === true;
                  const isEditing = editingPassId === p.id;
                  const statusClass =
                    p.status === "active"
                      ? "badge badge-active"
                      : p.status === "system_ended"
                        ? "badge badge-overdue"
                        : "badge badge-ended";
                  const statusLabel =
                    p.status === "system_ended" ? "System Ended" : p.status;
                  return (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {studentName(p.studentId)}
                        </div>
                        <div
                          style={{ fontSize: 11, color: "var(--text-subtle)" }}
                        >
                          {p.studentId}
                        </div>
                      </td>
                      <td>{p.teacherName}</td>
                      <td>
                        <div>{p.destination}</div>
                        {p.destinationTeacher && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-subtle)",
                            }}
                          >
                            → {p.destinationTeacher}
                          </div>
                        )}
                      </td>
                      <td>{p.originRoom}</td>
                      <td>
                        <span className={statusClass}>{statusLabel}</span>
                      </td>
                      <td>
                        {(() => {
                          const start = new Date(p.createdAt).getTime();
                          const end = p.endedAt
                            ? new Date(p.endedAt).getTime()
                            : now;
                          const mins = Math.max(
                            0,
                            Math.round((end - start) / 60000),
                          );
                          return p.status === "active" ? (
                            <span
                              style={{
                                fontStyle: "italic",
                                color: "var(--text-muted)",
                              }}
                            >
                              {mins}m
                            </span>
                          ) : (
                            <span>{mins}m</span>
                          );
                        })()}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="datetime-local"
                            value={editCreatedAt}
                            onChange={(e) => setEditCreatedAt(e.target.value)}
                          />
                        ) : (
                          fmtTime(p.createdAt)
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="datetime-local"
                            value={editEndedAt}
                            onChange={(e) => setEditEndedAt(e.target.value)}
                          />
                        ) : (
                          fmtTime(p.endedAt)
                        )}
                      </td>
                      <td
                        style={{ backgroundColor: getTimeStatusColor(p, now) }}
                      >
                        {formatTimeStatus(p, now)}
                      </td>
                      <td>
                        {isEditing ? (
                          <>
                            <button onClick={() => handleSavePassEdit(p.id)}>
                              Save
                            </button>{" "}
                            <button
                              onClick={() => {
                                setEditingPassId(null);
                                setEditEndedAt("");
                                setEditCreatedAt("");
                              }}
                            >
                              Cancel
                            </button>{" "}
                            <button onClick={() => setEditEndedAt("")}>
                              Clear (reopen)
                            </button>
                          </>
                        ) : (
                          <>
                            {p.status === "active" ? (
                              <button onClick={() => handleEndPass(p.id)}>
                                End Pass
                              </button>
                            ) : (
                              "-"
                            )}
                            {isAdmin && (
                              <>
                                {" "}
                                <button
                                  onClick={() => {
                                    setEditingPassId(p.id);
                                    setEditEndedAt(
                                      p.endedAt
                                        ? new Date(p.endedAt)
                                            .toISOString()
                                            .slice(0, 16)
                                        : "",
                                    );
                                    setEditCreatedAt(
                                      p.createdAt
                                        ? new Date(p.createdAt)
                                            .toISOString()
                                            .slice(0, 16)
                                        : "",
                                    );
                                  }}
                                >
                                  Edit
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>

      </>)}
      {hpView === "reports" && (authUser?.isAdmin || authUser?.isEseCoordinator) && (
        <div className="card">
          <h2>
            Hall Pass Reports
            <button
              type="button"
              className="no-print"
              onClick={() => window.print()}
              style={{ marginLeft: "0.75rem", fontSize: "0.85rem" }}
            >
              Print
            </button>
          </h2>
          <div
            className="no-print"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.75rem",
              flexWrap: "wrap",
            }}
          >
            <label>
              Date:{" "}
              <input
                type="date"
                value={hpReportDate}
                onChange={(e) => setHpReportDate(e.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                setHpReportDate(new Date().toISOString().slice(0, 10))
              }
            >
              Today
            </button>
            <button type="button" onClick={() => loadHpReport()}>
              Refresh
            </button>
            {hpReportLoading && <span style={{ color: "#666" }}>Loading…</span>}
            {hpReportError && (
              <span style={{ color: "#a00" }}>{hpReportError}</span>
            )}
          </div>
          {!hpReportData ? (
            hpReportLoading ? null : <div>No data.</div>
          ) : (
            <>
              <div style={{ marginBottom: "0.5rem", fontSize: "0.85rem", color: "#555" }}>
                Reporting on {hpReportData.date} (as of{" "}
                {new Date(hpReportData.asOf).toLocaleString()})
              </div>
              <div className="stat-grid" style={{ marginBottom: "1rem" }}>
                <div className="stat-card">
                  <span className="stat-label">Total Lost Instructional Minutes</span>
                  <span className="stat-value">
                    {hpReportData.totalLostMinutes}
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Total Passes</span>
                  <span className="stat-value">{hpReportData.totalPasses}</span>
                </div>
                <div className="stat-card stat-active">
                  <span className="stat-label">Currently Active</span>
                  <span className="stat-value">
                    {hpReportData.activePassCount}
                  </span>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: "1rem",
                }}
              >
                {/* Top student pass takers */}
                <div>
                  <h3 style={{ marginTop: 0 }}>Top 10 Student Pass Takers</h3>
                  {hpReportData.topStudentTakers.length === 0 ? (
                    <div className="muted">No passes today.</div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Student</th>
                          <th style={{ textAlign: "right" }}>Passes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hpReportData.topStudentTakers.map((r, i) => (
                          <tr key={r.studentId}>
                            <td>{i + 1}</td>
                            <td>
                              {r.studentName}{" "}
                              <span className="muted">({r.studentId})</span>
                            </td>
                            <td style={{ textAlign: "right" }}>{r.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Top student lost instruction */}
                <div>
                  <h3 style={{ marginTop: 0 }}>Top 10 Students by Lost Instruction</h3>
                  {hpReportData.topStudentLostMinutes.length === 0 ? (
                    <div className="muted">No passes today.</div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Student</th>
                          <th style={{ textAlign: "right" }}>Minutes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hpReportData.topStudentLostMinutes.map((r, i) => (
                          <tr key={r.studentId}>
                            <td>{i + 1}</td>
                            <td>
                              {r.studentName}{" "}
                              <span className="muted">({r.studentId})</span>
                            </td>
                            <td style={{ textAlign: "right" }}>{r.minutes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Top teacher granters */}
                <div>
                  <h3 style={{ marginTop: 0 }}>Top 10 Teacher Pass Granters</h3>
                  {hpReportData.topTeacherGranters.length === 0 ? (
                    <div className="muted">No passes today.</div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Teacher</th>
                          <th style={{ textAlign: "right" }}>Passes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hpReportData.topTeacherGranters.map((r, i) => (
                          <tr key={r.teacherName}>
                            <td>{i + 1}</td>
                            <td>{r.teacherName}</td>
                            <td style={{ textAlign: "right" }}>{r.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Top destinations */}
                <div>
                  <h3 style={{ marginTop: 0 }}>Top 10 Pass-To Locations</h3>
                  {hpReportData.topDestinations.length === 0 ? (
                    <div className="muted">No passes today.</div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Destination</th>
                          <th style={{ textAlign: "right" }}>Passes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hpReportData.topDestinations.map((r, i) => (
                          <tr key={r.destination}>
                            <td>{i + 1}</td>
                            <td>{r.destination}</td>
                            <td style={{ textAlign: "right" }}>{r.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
      </>)}

      {activeSection === "tardies" && (<>
      <div className="card">
      <h2>Log Tardy / Check-In</h2>
      <form onSubmit={handleTardySubmit} style={{ marginBottom: "1rem" }}>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Entry Type:{" "}
            <select
              value={tardyEntryType}
              onChange={(e) =>
                setTardyEntryType(
                  e.target.value as "tardy" | "checkin" | "checkout",
                )
              }
            >
              <option value="tardy">Tardy</option>
              <option value="checkin">Check-In</option>
              <option value="checkout">Check-Out</option>
            </select>
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Student:{" "}
            <input
              type="text"
              placeholder="Search by name or ID"
              value={tardyStudentSearch}
              onChange={(e) => {
                setTardyStudentSearch(e.target.value);
                setTardyStudentId("");
              }}
            />
          </label>
          {tardyStudentId ? (
            <div style={{ marginTop: "0.25rem" }}>
              Selected: <strong>{tardyStudentId}</strong>{" "}
              {(() => {
                const s = students.find(
                  (s) => s.studentId === tardyStudentId,
                );
                return s ? `- ${s.firstName} ${s.lastName}` : "";
              })()}{" "}
              <button
                type="button"
                onClick={() => {
                  setTardyStudentId("");
                  setTardyStudentSearch("");
                }}
              >
                Clear
              </button>
            </div>
          ) : (
            tardyStudentSearch && (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0.25rem 0",
                  border: "1px solid #ccc",
                  maxWidth: "20rem",
                }}
              >
                {students
                  .filter((s) => {
                    const q = tardyStudentSearch.toLowerCase();
                    return (
                      s.firstName.toLowerCase().includes(q) ||
                      s.lastName.toLowerCase().includes(q) ||
                      s.studentId.toLowerCase().includes(q)
                    );
                  })
                  .map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "0.25rem 0.5rem",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          setTardyStudentId(s.studentId);
                          setTardyStudentSearch(
                            `${s.studentId} - ${s.firstName} ${s.lastName}`,
                          );
                        }}
                      >
                        {s.studentId} - {s.firstName} {s.lastName}
                      </button>
                    </li>
                  ))}
                {students.filter((s) => {
                  const q = tardyStudentSearch.toLowerCase();
                  return (
                    s.firstName.toLowerCase().includes(q) ||
                    s.lastName.toLowerCase().includes(q) ||
                    s.studentId.toLowerCase().includes(q)
                  );
                }).length === 0 && (
                  <li style={{ padding: "0.25rem 0.5rem", color: "#666" }}>
                    No matches
                  </li>
                )}
              </ul>
            )
          )}
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Period:{" "}
            <select
              value={tardyPeriod}
              onChange={(e) => setTardyPeriod(e.target.value)}
              required
            >
              <option value="">-- select a period --</option>
              {["1", "2", "3", "4", "5", "6", "7"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        {tardyEntryType === "tardy" && (
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              Reason:{" "}
              <input
                type="text"
                value={tardyReason}
                onChange={(e) => setTardyReason(e.target.value)}
              />
            </label>
          </div>
        )}
        {tardyEntryType === "tardy" && (
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              <input
                type="checkbox"
                checked={tardyCreateReturnPass}
                onChange={(e) => setTardyCreateReturnPass(e.target.checked)}
              />{" "}
              Create return pass to class
            </label>
            {tardyCreateReturnPass && (
              <div style={{ marginTop: "0.25rem" }}>
                <label>
                  Receiving Teacher:{" "}
                  <select
                    value={tardyReturnPassTeacher}
                    onChange={(e) => setTardyReturnPassTeacher(e.target.value)}
                  >
                    {teachers.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
        )}
        {(tardyEntryType === "checkin" || tardyEntryType === "checkout") && (
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              {tardyEntryType === "checkin" ? "Check-In With:" : "Check-Out With:"}{" "}
              <select
                value={tardyCheckInWith}
                onChange={(e) => setTardyCheckInWith(e.target.value)}
                required
              >
                <option value="">-- select --</option>
                {checkInWithOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Notes (optional):{" "}
            <input
              type="text"
              value={tardyNotes}
              onChange={(e) => setTardyNotes(e.target.value)}
            />
          </label>
        </div>
        <button type="submit">
          {tardyEntryType === "tardy"
            ? "Log Tardy"
            : tardyEntryType === "checkin"
              ? "Log Check-In"
              : "Log Check-Out"}
        </button>
      </form>
      </div>

      <div className="card">
      <h2>Tardy / Check-Ins</h2>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>Student</th>
            <th>Teacher</th>
            <th>Type</th>
            <th>Period</th>
            <th>Reason</th>
            <th>Check-In With</th>
            <th>Notes</th>
            <th>Logged</th>
          </tr>
        </thead>
        <tbody>
          {tardies
            .filter((t) =>
              dateFilter === "today" ? isCreatedToday(t.createdAt) : true,
            )
            .filter((t) =>
              staffFilter === "mine" ? t.teacherName === currentStaffUser : true,
            )
            .map((t) => (
            <tr key={t.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{studentName(t.studentId)}</div>
                <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                  {t.studentId}
                </div>
              </td>
              <td>{t.teacherName}</td>
              <td>{t.entryType}</td>
              <td>{t.period}</td>
              <td>{t.reason}</td>
              <td>{t.checkInWith ?? "-"}</td>
              <td>{t.notes}</td>
              <td>{fmtTime(t.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      </>)}

      {activeSection === "student" && (
        <section className="card">
          <h2>Student Activity</h2>
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              Student:{" "}
              <input
                type="text"
                placeholder="Search by name or ID"
                value={activityStudentSearch}
                onChange={(e) => {
                  setActivityStudentSearch(e.target.value);
                  setActivityStudentId("");
                }}
              />
            </label>
            {activityStudentId ? (
              <div style={{ marginTop: "0.25rem" }}>
                Selected: <strong>{activityStudentId}</strong>{" "}
                {(() => {
                  const s = students.find(
                    (s) => s.studentId === activityStudentId,
                  );
                  return s ? `- ${s.firstName} ${s.lastName}` : "";
                })()}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setActivityStudentId("");
                    setActivityStudentSearch("");
                  }}
                >
                  Clear
                </button>
              </div>
            ) : (
              activityStudentSearch && (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0.25rem 0",
                    border: "1px solid #ccc",
                    maxWidth: "20rem",
                  }}
                >
                  {students
                    .filter((s) => {
                      const q = activityStudentSearch.toLowerCase();
                      return (
                        s.firstName.toLowerCase().includes(q) ||
                        s.lastName.toLowerCase().includes(q) ||
                        s.studentId.toLowerCase().includes(q)
                      );
                    })
                    .map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "0.25rem 0.5rem",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            setActivityStudentId(s.studentId);
                            setActivityStudentSearch(
                              `${s.studentId} - ${s.firstName} ${s.lastName}`,
                            );
                          }}
                        >
                          {s.studentId} - {s.firstName} {s.lastName}
                        </button>
                      </li>
                    ))}
                  {students.filter((s) => {
                    const q = activityStudentSearch.toLowerCase();
                    return (
                      s.firstName.toLowerCase().includes(q) ||
                      s.lastName.toLowerCase().includes(q) ||
                      s.studentId.toLowerCase().includes(q)
                    );
                  }).length === 0 && (
                    <li style={{ padding: "0.25rem 0.5rem", color: "#666" }}>
                      No matches
                    </li>
                  )}
                </ul>
              )
            )}
          </div>

          {activityStudentId && (
            <>
              <div style={{ marginBottom: "1rem" }}>
                {(
                  [
                    ["summary", "Summary"],
                    ["hallPasses", "Hall Passes"],
                    ["tardy", "Tardy / Support Logs"],
                    ["pbis", "PBIS"],
                    ["supportNotes", "Support Notes"],
                    ["contact", "Contact / Communication"],
                    ["pullouts", "Pullouts"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStudentTab(key)}
                    disabled={studentTab === key}
                    style={{ marginRight: "0.25rem" }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div style={{ marginBottom: "0.75rem" }}>
                <strong>Quick Actions:</strong>{" "}
                <button type="button" onClick={() => setStudentTab("pbis")}>
                  Add PBIS
                </button>{" "}
                <button
                  type="button"
                  onClick={() => setStudentTab("supportNotes")}
                >
                  Add Support Note
                </button>{" "}
                <button type="button" onClick={() => setStudentTab("contact")}>
                  Send Email
                </button>
              </div>

              {studentTab === "summary" && (() => {
                const student = students.find(
                  (s) => s.studentId === activityStudentId,
                );
                const studentName = student
                  ? `${student.firstName} ${student.lastName}`
                  : activityStudentId;
                const inRange = (createdAt: string) =>
                  dateFilter === "today" ? isCreatedToday(createdAt) : true;
                const sPasses = hallPasses.filter(
                  (p) => p.studentId === activityStudentId && inRange(p.createdAt),
                );
                const sTardies = tardies.filter(
                  (t) => t.studentId === activityStudentId && inRange(t.createdAt),
                );
                const sPbis = pbisEntries.filter(
                  (e) => e.studentId === activityStudentId && inRange(e.createdAt),
                );
                const tardyCount = sTardies.filter(
                  (t) => t.entryType === "tardy",
                ).length;
                const checkInCount = sTardies.filter(
                  (t) => t.entryType === "checkin",
                ).length;
                const checkOutCount = sTardies.filter(
                  (t) => t.entryType === "checkout",
                ).length;
                const pbisPoints = sPbis.reduce((sum, e) => sum + e.points, 0);
                const lostMinutes = Math.round(
                  sPasses
                    .filter((p) => p.status !== "active" && p.endedAt)
                    .reduce((sum, p) => {
                      const start = new Date(p.createdAt).getTime();
                      const end = new Date(p.endedAt as string).getTime();
                      return sum + Math.max(0, (end - start) / 60000);
                    }, 0),
                );
                const label =
                  dateFilter === "today" ? "Today" : "(All Records)";
                return (
                  <section
                    style={{
                      border: "1px solid #ccc",
                      padding: "0.75rem",
                      marginBottom: "1rem",
                    }}
                  >
                    <h3 style={{ marginTop: 0 }}>
                      Student Daily Summary
                      <button
                        type="button"
                        className="no-print"
                        onClick={() => window.print()}
                        style={{ marginLeft: "0.75rem", fontSize: "0.85rem" }}
                      >
                        Print
                      </button>
                    </h3>
                    <ul style={{ margin: 0 }}>
                      <li>Student Name: {studentName}</li>
                      <li>Hall Passes {label}: {sPasses.length}</li>
                      <li>Tardies {label}: {tardyCount}</li>
                      <li>Check-Ins {label}: {checkInCount}</li>
                      <li>Check-Outs {label}: {checkOutCount}</li>
                      <li>PBIS Entries {label}: {sPbis.length}</li>
                      <li>PBIS Points {label}: {pbisPoints}</li>
                      <li>Lost Instructional Time {label}: {lostMinutes} min</li>
                    </ul>
                    {(() => {
                      const sLogs = (
                        accommodationLogs as Array<
                          (typeof accommodationLogs)[number] & {
                            status?: string;
                          }
                        >
                      )
                        .filter(
                          (l) =>
                            l.studentId === activityStudentId &&
                            inRange(l.createdAt),
                        )
                        .slice()
                        .sort((a, b) =>
                          b.createdAt.localeCompare(a.createdAt),
                        );
                      const providedCount = sLogs.filter(
                        (l) => (l.status ?? "provided") === "provided",
                      ).length;
                      const refusedCount = sLogs.filter(
                        (l) => l.status === "refused",
                      ).length;
                      return (
                        <div style={{ marginTop: "0.75rem" }}>
                          <h4 style={{ margin: "0 0 0.25rem 0" }}>
                            Accommodations {label}:{" "}
                            <span style={{ color: "#0a7a3b" }}>
                              {providedCount} provided
                            </span>
                            {" / "}
                            <span style={{ color: "#b00020" }}>
                              {refusedCount} refused
                            </span>
                          </h4>
                          {sLogs.length === 0 ? (
                            <div>No accommodation records.</div>
                          ) : (
                            <ul
                              style={{
                                margin: 0,
                                listStyle: "none",
                                padding: 0,
                              }}
                            >
                              {sLogs.map((l) => {
                                const refused = l.status === "refused";
                                const dt = new Date(l.createdAt);
                                const dateStr = dt.toLocaleDateString();
                                const timeStr = dt.toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                });
                                return (
                                  <li
                                    key={l.id}
                                    style={{
                                      padding: "0.35rem 0.5rem",
                                      marginBottom: "0.25rem",
                                      borderLeft: `4px solid ${
                                        refused ? "#b00020" : "#0a7a3b"
                                      }`,
                                      background: refused
                                        ? "#fde2e2"
                                        : "#e6f4ea",
                                    }}
                                  >
                                    <strong
                                      style={{
                                        color: refused
                                          ? "#b00020"
                                          : "#0a7a3b",
                                      }}
                                    >
                                      {refused ? "Refused" : "Provided"}
                                    </strong>
                                    {": "}
                                    {l.accommodation}
                                    {l.period != null
                                      ? ` | Period ${l.period}`
                                      : ""}
                                    {" | "}
                                    {dateStr} {timeStr}
                                    {" | "}
                                    {l.staffName || "(unknown)"}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      );
                    })()}
                  </section>
                );
              })()}

              {studentTab === "contact" && (() => {
                const s = students.find(
                  (st) => st.studentId === activityStudentId,
                );
                return (
                  <section
                    style={{
                      border: "1px solid #ccc",
                      padding: "0.75rem",
                      marginBottom: "1rem",
                    }}
                  >
                    <h3 style={{ marginTop: 0 }}>Parent Contact Info</h3>
                    <ul style={{ margin: 0 }}>
                      <li>
                        Parent Name:{" "}
                        {s?.parentName ? s.parentName : "No parent name on file"}
                      </li>
                      <li>
                        Parent Email:{" "}
                        {s?.parentEmail
                          ? s.parentEmail
                          : "No parent email on file"}
                      </li>
                      <li>
                        Parent Phone:{" "}
                        {s?.parentPhone
                          ? s.parentPhone
                          : "No parent phone on file"}
                      </li>
                    </ul>
                  </section>
                );
              })()}

              {studentTab === "pullouts" && (
                <StudentPulloutsTab studentId={activityStudentId} />
              )}

              {studentTab === "hallPasses" && (<>
              <h3>Hall Passes</h3>
              <table
                border={1}
                cellPadding={6}
                style={{ borderCollapse: "collapse" }}
              >
                <thead>
                  <tr>
                    <th>teacher</th>
                    <th>destination</th>
                    <th>originRoom</th>
                    <th>status</th>
                    <th>createdAt</th>
                    <th>endedAt</th>
                  </tr>
                </thead>
                <tbody>
                  {hallPasses
                    .filter((p) => p.studentId === activityStudentId)
                    .filter((p) =>
                      dateFilter === "today"
                        ? isCreatedToday(p.createdAt)
                        : true,
                    )
                    .map((p) => (
                      <tr key={p.id}>
                        <td>{p.teacherName}</td>
                        <td>{p.destination}</td>
                        <td>{p.originRoom}</td>
                        <td>{p.status === "system_ended" ? "System Ended" : p.status}</td>
                        <td>{p.createdAt}</td>
                        <td>{p.endedAt ?? "-"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              </>)}

              {studentTab === "tardy" && (<>
              <h3>Tardy / Support Logs</h3>
              <table
                border={1}
                cellPadding={6}
                style={{ borderCollapse: "collapse" }}
              >
                <thead>
                  <tr>
                    <th>entryType</th>
                    <th>teacherName</th>
                    <th>period</th>
                    <th>reason</th>
                    <th>checkInWith</th>
                    <th>notes</th>
                    <th>createdAt</th>
                  </tr>
                </thead>
                <tbody>
                  {tardies
                    .filter((t) => t.studentId === activityStudentId)
                    .filter((t) =>
                      dateFilter === "today"
                        ? isCreatedToday(t.createdAt)
                        : true,
                    )
                    .filter((t) =>
                      staffFilter === "mine"
                        ? t.teacherName === currentStaffUser
                        : true,
                    )
                    .map((t) => (
                      <tr key={t.id}>
                        <td>{t.entryType}</td>
                        <td>{t.teacherName}</td>
                        <td>{t.period}</td>
                        <td>{t.reason}</td>
                        <td>{t.checkInWith ?? "-"}</td>
                        <td>{t.notes}</td>
                        <td>{t.createdAt}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              </>)}

              {studentTab === "summary" && (() => {
                const completedPasses = hallPasses
                  .filter((p) => p.studentId === activityStudentId)
                  .filter((p) => p.status !== "active" && p.endedAt)
                  .filter((p) =>
                    dateFilter === "today"
                      ? isCreatedToday(p.createdAt)
                      : true,
                  );
                const hallPassMinutes = completedPasses.reduce((sum, p) => {
                  const start = new Date(p.createdAt).getTime();
                  const end = new Date(p.endedAt as string).getTime();
                  const mins = Math.max(0, (end - start) / 60000);
                  return sum + mins;
                }, 0);
                const hallPassMinutesRounded = Math.round(hallPassMinutes);
                const totalMinutes = hallPassMinutesRounded;
                return (
                  <section style={{ marginBottom: "1rem" }}>
                    <h3>Lost Instructional Time</h3>
                    <ul>
                      <li>Hall Pass Minutes: {hallPassMinutesRounded}</li>
                      <li>
                        Total Lost Instructional Time: {totalMinutes}
                      </li>
                    </ul>
                  </section>
                );
              })()}

              {studentTab === "contact" && (() => {
                const student = students.find(
                  (s) => s.studentId === activityStudentId,
                );
                const studentName = student
                  ? `${student.firstName} ${student.lastName}`
                  : activityStudentId;
                const studentPbis = pbisEntries.filter(
                  (e) => e.studentId === activityStudentId,
                );
                const totalPoints = studentPbis.reduce(
                  (sum, e) => sum + e.points,
                  0,
                );
                const studentPasses = hallPasses.filter(
                  (p) => p.studentId === activityStudentId,
                );
                const studentTardies = tardies.filter(
                  (t) => t.studentId === activityStudentId,
                );
                const recentPbis = studentPbis
                  .slice()
                  .reverse()
                  .slice(0, 3)
                  .map(
                    (e) =>
                      `  - ${e.reason} (${e.points} pts) on ${e.createdAt}`,
                  )
                  .join("\n");
                const tardyOnly = studentTardies.filter(
                  (t) => t.entryType === "tardy",
                );
                const checkIns = studentTardies.filter(
                  (t) => t.entryType === "checkin",
                );
                const checkOuts = studentTardies.filter(
                  (t) => t.entryType === "checkout",
                );
                const recentTardies = tardyOnly
                  .slice()
                  .reverse()
                  .slice(0, 3)
                  .map(
                    (t) =>
                      `  - Period ${t.period}${t.reason ? ` (${t.reason})` : ""} on ${t.createdAt}`,
                  )
                  .join("\n");
                const recentCheckInOut = [...checkIns, ...checkOuts]
                  .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
                  .slice(0, 3)
                  .map(
                    (t) =>
                      `  - ${t.entryType === "checkin" ? "Check-In" : "Check-Out"} with ${t.checkInWith ?? "-"} on ${t.createdAt}`,
                  )
                  .join("\n");

                const signature =
                  schoolSettings.emailSignature || "Thank you,\nPulseED";
                let templateSubject = "Student Activity Update";
                let templateBody = "";
                if (emailMessageType === "positive") {
                  templateSubject = `Positive Update for ${studentName}`;
                  templateBody =
                    `Hello,\n\n` +
                    `We wanted to share a positive update about ${studentName}.\n\n` +
                    `PBIS Points: ${totalPoints}\n` +
                    `PBIS Entries: ${studentPbis.length}\n` +
                    (recentPbis
                      ? `\nRecent recognitions:\n${recentPbis}\n`
                      : "") +
                    `\n${signature}`;
                } else if (emailMessageType === "pbis") {
                  templateSubject = `PBIS Recognition for ${studentName}`;
                  templateBody =
                    `Hello,\n\n` +
                    `${studentName} has been recognized for positive behavior.\n\n` +
                    `Total PBIS Points: ${totalPoints}\n` +
                    `Total PBIS Entries: ${studentPbis.length}\n` +
                    (recentPbis
                      ? `\nRecent PBIS recognitions:\n${recentPbis}\n`
                      : "\nNo PBIS entries yet.\n") +
                    `\n${signature}`;
                } else if (emailMessageType === "attendance") {
                  templateSubject = `Attendance / Tardy Concern for ${studentName}`;
                  templateBody =
                    `Hello,\n\n` +
                    `We are reaching out regarding ${studentName}'s attendance.\n\n` +
                    `Total Tardies: ${tardyOnly.length}\n` +
                    `Total Support Logs: ${studentTardies.length}\n` +
                    (recentTardies
                      ? `\nRecent tardies:\n${recentTardies}\n`
                      : "\nNo recent tardies on record.\n") +
                    `\nPlease reach out if you have any questions.\n\n` +
                    `${signature}`;
                } else {
                  templateSubject = `Check-In / Check-Out Notice for ${studentName}`;
                  templateBody =
                    `Hello,\n\n` +
                    `This is a notice regarding ${studentName}'s check-in / check-out activity.\n\n` +
                    `Check-Ins: ${checkIns.length}\n` +
                    `Check-Outs: ${checkOuts.length}\n` +
                    (recentCheckInOut
                      ? `\nRecent activity:\n${recentCheckInOut}\n`
                      : "\nNo recent check-in/check-out activity on record.\n") +
                    `\n${signature}`;
                }
                const parentEmailOnFile = (student?.parentEmail ?? "").trim();
                const recipientToUse = (emailOverride || parentEmailOnFile).trim();
                const subjectToSend = (emailSubjectDraft || templateSubject).trim();
                const bodyToSend = emailBodyDraft || templateBody;
                const applyTemplate = () => {
                  setEmailSubjectDraft(templateSubject);
                  setEmailBodyDraft(templateBody);
                  setEmailStatus("");
                };
                const sendEmail = async () => {
                  if (emailSending) return;
                  setEmailSending(true);
                  setEmailStatus("Sending...");
                  try {
                    const res = await fetch("/api/parent-email/send", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        studentId: activityStudentId,
                        recipient: recipientToUse,
                        subject: subjectToSend,
                        body: bodyToSend,
                      }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                      const detail =
                        (data && (data.detail || data.error)) ||
                        `HTTP ${res.status}`;
                      throw new Error(detail);
                    }
                    setEmailStatus(
                      `Sent to ${data.to || recipientToUse}. Logged to support notes.`,
                    );
                    fetch(
                      `/api/support-notes?studentId=${encodeURIComponent(activityStudentId)}`,
                    )
                      .then((r) => (r.ok ? r.json() : []))
                      .then((rows) => {
                        if (Array.isArray(rows)) {
                          setSupportNotes((prev) => {
                            const others = prev.filter(
                              (n) => n.studentId !== activityStudentId,
                            );
                            return [...others, ...rows];
                          });
                        }
                      })
                      .catch(() => {});
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(err);
                    setEmailStatus(`Error: ${msg}`);
                  } finally {
                    setEmailSending(false);
                  }
                };
                return (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <div style={{ marginBottom: "0.25rem" }}>
                      <label>
                        Template:{" "}
                        <select
                          value={emailMessageType}
                          onChange={(e) =>
                            setEmailMessageType(
                              e.target.value as typeof emailMessageType,
                            )
                          }
                        >
                          <option value="positive">Positive Update</option>
                          <option value="pbis">PBIS Recognition</option>
                          <option value="attendance">
                            Attendance / Tardy Concern
                          </option>
                          <option value="checkInOut">
                            Check-In / Check-Out Notice
                          </option>
                        </select>
                      </label>{" "}
                      <button type="button" onClick={applyTemplate}>
                        Apply Template
                      </button>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          marginTop: 4,
                        }}
                      >
                        Pick a template and click Apply, then edit the subject
                        and message below before sending.
                      </div>
                    </div>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <label style={{ display: "block" }}>
                        Send to:{" "}
                        <input
                          type="email"
                          value={emailOverride}
                          onChange={(e) => setEmailOverride(e.target.value)}
                          placeholder={
                            parentEmailOnFile ||
                            "parent@example.com (or your test email)"
                          }
                          style={{ width: "20rem" }}
                        />
                      </label>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          marginTop: 4,
                        }}
                      >
                        {parentEmailOnFile
                          ? `On file: ${parentEmailOnFile}. Type a different address above to override.`
                          : "No parent email on file. Type any address above (use your own for testing)."}
                      </div>
                    </div>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <label style={{ display: "block" }}>
                        Subject:{" "}
                        <input
                          type="text"
                          value={emailSubjectDraft}
                          onChange={(e) => setEmailSubjectDraft(e.target.value)}
                          placeholder={templateSubject}
                          style={{ width: "30rem", maxWidth: "100%" }}
                        />
                      </label>
                    </div>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <label style={{ display: "block" }}>
                        Message:
                        <textarea
                          value={emailBodyDraft}
                          onChange={(e) => setEmailBodyDraft(e.target.value)}
                          placeholder={
                            templateBody ||
                            "Type your message to the parent here..."
                          }
                          rows={10}
                          style={{
                            width: "100%",
                            maxWidth: "40rem",
                            display: "block",
                            marginTop: 4,
                            fontFamily: "inherit",
                          }}
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={sendEmail}
                      disabled={
                        !activityStudentId ||
                        !recipientToUse ||
                        !subjectToSend ||
                        !bodyToSend.trim() ||
                        emailSending
                      }
                    >
                      Send Parent Email
                    </button>
                    {emailStatus && (
                      <span style={{ marginLeft: "0.5rem" }}>
                        {emailStatus}
                      </span>
                    )}
                  </div>
                );
              })()}

              {studentTab === "pbis" && (<>
              <h3>PBIS Summary</h3>
              {(() => {
                const studentPbis = pbisEntries.filter(
                  (e) => e.studentId === activityStudentId,
                );
                const totalPoints = studentPbis.reduce(
                  (sum, e) => sum + e.points,
                  0,
                );
                return (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <div>PBIS Entries: {studentPbis.length}</div>
                    <div>PBIS Points: {totalPoints}</div>
                  </div>
                );
              })()}
              </>)}

              {studentTab === "supportNotes" && (() => {
                const studentNotes = supportNotes
                  .filter((n) => n.studentId === activityStudentId)
                  .slice()
                  .reverse();
                return (
                  <>
                    <h3>
                      Support Notes
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontWeight: 400,
                          marginLeft: 8,
                        }}
                      >
                        — {studentName(activityStudentId)}
                      </span>
                    </h3>
                    <form
                      onSubmit={handleSupportNoteSubmit}
                      style={{ marginBottom: "1rem" }}
                    >
                      <div>
                        <label>
                          Note Type:{" "}
                          <select
                            value={supportNoteType}
                            onChange={(e) =>
                              setSupportNoteType(e.target.value)
                            }
                          >
                            {supportNoteTypes.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div>
                        <label style={{ display: "block" }}>
                          Note:
                        </label>
                        <textarea
                          value={supportNoteText}
                          onChange={(e) => setSupportNoteText(e.target.value)}
                          placeholder="Enter support note here..."
                          rows={4}
                          style={{
                            display: "block",
                            width: "100%",
                            maxWidth: "36rem",
                            marginTop: 4,
                          }}
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={!supportNoteText.trim()}
                      >
                        Add Support Note
                      </button>
                    </form>
                    {studentNotes.length === 0 ? (
                      <div
                        style={{
                          padding: "1rem",
                          color: "var(--text-muted)",
                          background: "var(--surface-2)",
                          borderRadius: "var(--radius)",
                          textAlign: "center",
                          fontSize: 13,
                        }}
                      >
                        No support notes yet for this student.
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.625rem",
                        }}
                      >
                        {studentNotes.map((n) => (
                          <div
                            key={n.id}
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius)",
                              padding: "0.75rem 0.875rem",
                              background: "var(--surface)",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                marginBottom: "0.4rem",
                                gap: "0.5rem",
                                flexWrap: "wrap",
                              }}
                            >
                              <span className="badge badge-warning">
                                {n.noteType}
                              </span>
                              <span
                                style={{
                                  fontSize: 12,
                                  color: "var(--text-muted)",
                                }}
                              >
                                {n.staffName || "Unknown"} ·{" "}
                                {fmtTime(n.createdAt)}
                              </span>
                            </div>
                            <div
                              style={{
                                whiteSpace: "pre-wrap",
                                color: "var(--text)",
                                fontSize: 14,
                                lineHeight: 1.5,
                              }}
                            >
                              {n.noteText}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}

              {studentTab === "pbis" && (<>
              <h3>PBIS Entries</h3>
              <ul>
                {pbisEntries
                  .filter((e) => e.studentId === activityStudentId)
                  .filter((e) =>
                    dateFilter === "today"
                      ? isCreatedToday(e.createdAt)
                      : true,
                  )
                  .filter((e) =>
                    staffFilter === "mine"
                      ? e.staffName === currentStaffUser
                      : true,
                  )
                  .map((e) => (
                    <li key={e.id}>
                      {e.reason} - {e.points} pts - by {e.staffName || "-"} -{" "}
                      {e.createdAt}
                    </li>
                  ))}
              </ul>
              </>)}

            </>
          )}
        </section>
      )}

      {activeSection === "accommodations" && (<>
        <section className="card">
          <h2>Accommodations</h2>
          {(() => {
            const s = students.find(
              (st) => st.studentId === accStudentId,
            );
            const accs = s?.accommodations ?? [];
            return (
              <section
                style={{
                  border: "1px solid #ccc",
                  padding: "0.75rem",
                  marginBottom: "1rem",
                }}
              >
                <div className="no-print" style={{ marginBottom: "0.75rem" }}>
                  <button
                    type="button"
                    onClick={() => setAccView("classView")}
                    disabled={accView === "classView"}
                    style={{ marginRight: "0.25rem" }}
                  >
                    Class View
                  </button>
                  <button
                    type="button"
                    onClick={() => setAccView("student")}
                    disabled={accView === "student"}
                    style={{ marginRight: "0.25rem" }}
                  >
                    By Student
                  </button>
                  <button
                    type="button"
                    onClick={() => setAccView("daily")}
                    disabled={accView === "daily"}
                    style={{ marginRight: "0.25rem" }}
                  >
                    Class Log
                  </button>
                  <button
                    type="button"
                    onClick={() => setAccView("reports")}
                    disabled={accView === "reports"}
                  >
                    Reports
                  </button>
                </div>
                {accView === "classView" ? (
                  (() => {
                    const isEseCoord =
                      authUser?.isEseCoordinator === true ||
                      authUser?.isAdmin === true;
                    // Admin/ESE coordinator can browse any teacher's roster.
                    // Teachers see their own sections.
                    const teacherOptions = isEseCoord
                      ? Array.from(
                          new Map(
                            allSections.map(
                              (s) =>
                                [
                                  s.teacherStaffId,
                                  s.teacherName,
                                ] as const,
                            ),
                          ).entries(),
                        )
                          .map(([id, name]) => ({ id, name }))
                          .sort((a, b) => a.name.localeCompare(b.name))
                      : [];
                    const sourceSections: Array<{
                      id: number;
                      period: number;
                      courseName: string;
                      isPlanning: boolean;
                      studentIds: string[];
                    }> = isEseCoord
                      ? classViewTeacherId == null
                        ? []
                        : allSections.filter(
                            (s) => s.teacherStaffId === classViewTeacherId,
                          )
                      : mySections;
                    const teachingPeriods = sourceSections
                      .filter((s) => !s.isPlanning)
                      .map((s) => s.period)
                      .sort((a, b) => a - b);
                    const planningPeriods = sourceSections
                      .filter((s) => s.isPlanning)
                      .map((s) => s.period);
                    const effectivePeriod =
                      classViewPeriod &&
                      teachingPeriods.includes(classViewPeriod)
                        ? classViewPeriod
                        : (teachingPeriods[0] ?? null);
                    const section = sourceSections.find(
                      (s) => s.period === effectivePeriod && !s.isPlanning,
                    );
                    const roster = section
                      ? students
                          .filter((st) =>
                            section.studentIds.includes(st.studentId),
                          )
                          .sort((a, b) =>
                            (a.lastName + a.firstName).localeCompare(
                              b.lastName + b.firstName,
                            ),
                          )
                      : [];
                    const catColor: Record<string, string> = {
                      IEP: "#0e7490",
                      "504": "#7c3aed",
                      ELL: "#0891b2",
                      Strategy: "#64748b",
                    };
                    const renderChip = (
                      label: string,
                      bg: string,
                      title?: string,
                    ) => (
                      <span
                        key={label}
                        title={title}
                        style={{
                          display: "inline-block",
                          padding: "1px 7px",
                          marginRight: 4,
                          borderRadius: 999,
                          background: bg,
                          color: "white",
                          fontSize: 11,
                          fontWeight: 600,
                          lineHeight: "16px",
                        }}
                      >
                        {label}
                      </span>
                    );
                    return (
                      <>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "0.75rem",
                            flexWrap: "wrap",
                            gap: "0.5rem",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              gap: "0.75rem",
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <h3 style={{ margin: 0 }}>Class View</h3>
                            <div
                              style={{
                                display: "inline-flex",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                overflow: "hidden",
                              }}
                            >
                              {[1, 2, 3, 4, 5, 6, 7].map((p) => {
                                const isPlanning = planningPeriods.includes(p);
                                const hasSection =
                                  teachingPeriods.includes(p);
                                const isActive = effectivePeriod === p;
                                const disabled = !hasSection;
                                return (
                                  <button
                                    key={p}
                                    type="button"
                                    onClick={() => {
                                      if (disabled) return;
                                      setClassViewPeriod(p);
                                      setClassViewHoverId(null);
                                    }}
                                    disabled={disabled}
                                    title={
                                      isPlanning
                                        ? "Planning period"
                                        : !hasSection
                                          ? isEseCoord && !classViewTeacherId
                                            ? "Pick a teacher first"
                                            : "Not assigned this period"
                                          : ""
                                    }
                                    style={{
                                      border: "none",
                                      borderRight:
                                        p < 7
                                          ? "1px solid var(--border)"
                                          : "none",
                                      padding: "0.25rem 0.7rem",
                                      background: isActive
                                        ? "var(--primary)"
                                        : "transparent",
                                      color: isActive ? "white" : undefined,
                                      cursor: disabled
                                        ? "not-allowed"
                                        : "pointer",
                                    }}
                                  >
                                    P{p}
                                    {isPlanning ? " (Plan)" : ""}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          {isEseCoord && (
                            <div
                              style={{
                                display: "flex",
                                gap: "0.4rem",
                                alignItems: "center",
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 12,
                                  color: "var(--text-subtle)",
                                }}
                              >
                                Teacher:
                              </span>
                              <input
                                type="text"
                                list="acc-teacher-options"
                                placeholder="Type teacher name…"
                                defaultValue={
                                  teacherOptions.find(
                                    (t) => t.id === classViewTeacherId,
                                  )?.name ?? ""
                                }
                                onChange={(e) => {
                                  const v = e.target.value.trim();
                                  if (v === "") {
                                    setClassViewTeacherId(null);
                                    setClassViewPeriod(null);
                                    setClassViewHoverId(null);
                                    return;
                                  }
                                  const match = teacherOptions.find(
                                    (t) =>
                                      t.name.toLowerCase() === v.toLowerCase(),
                                  );
                                  if (match) {
                                    setClassViewTeacherId(match.id);
                                    setClassViewPeriod(null);
                                    setClassViewHoverId(null);
                                  }
                                }}
                                style={{ minWidth: 200 }}
                              />
                              <datalist id="acc-teacher-options">
                                {teacherOptions.map((t) => (
                                  <option key={t.id} value={t.name} />
                                ))}
                              </datalist>
                            </div>
                          )}
                        </div>

                        {isEseCoord && classViewTeacherId == null ? (
                          <div
                            style={{
                              color: "var(--text-subtle)",
                              padding: "0.75rem 0",
                            }}
                          >
                            Choose a teacher to view their class roster.
                          </div>
                        ) : !section ? (
                          <div
                            style={{
                              color: "var(--text-subtle)",
                              padding: "0.75rem 0",
                            }}
                          >
                            {sourceSections.length === 0
                              ? "No classes assigned to this teacher."
                              : "No class for this period."}
                          </div>
                        ) : roster.length === 0 ? (
                          <div
                            style={{
                              color: "var(--text-subtle)",
                              padding: "0.75rem 0",
                            }}
                          >
                            No students enrolled in this section.
                          </div>
                        ) : (
                          <>
                            <div
                              style={{
                                fontSize: 12,
                                color: "var(--text-subtle)",
                                marginBottom: 6,
                              }}
                            >
                              {section.courseName} · {roster.length} students ·{" "}
                              {
                                roster.filter(
                                  (s) => (s.accommodations ?? []).length > 0,
                                ).length
                              }{" "}
                              with accommodations
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gap: 4,
                              }}
                            >
                              {roster.map((s) => {
                                const accs = s.accommodations ?? [];
                                const byCat = new Map<
                                  string,
                                  string[]
                                >();
                                for (const name of accs) {
                                  const cat =
                                    accCategoryByName.get(name) ?? "Strategy";
                                  const list = byCat.get(cat) ?? [];
                                  list.push(name);
                                  byCat.set(cat, list);
                                }
                                const isHover =
                                  classViewHoverId === s.studentId;
                                return (
                                  <div
                                    key={s.studentId}
                                    onMouseEnter={() =>
                                      setClassViewHoverId(s.studentId)
                                    }
                                    onMouseLeave={() =>
                                      setClassViewHoverId((cur) =>
                                        cur === s.studentId ? null : cur,
                                      )
                                    }
                                    onClick={() =>
                                      setClassViewHoverId((cur) =>
                                        cur === s.studentId
                                          ? null
                                          : s.studentId,
                                      )
                                    }
                                    style={{
                                      position: "relative",
                                      display: "grid",
                                      gridTemplateColumns:
                                        "minmax(200px, 1.4fr) minmax(160px, 1fr) auto",
                                      gap: "0.75rem",
                                      alignItems: "center",
                                      padding: "0.45rem 0.6rem",
                                      borderRadius: 6,
                                      border: "1px solid var(--border)",
                                      background:
                                        accs.length > 0
                                          ? "rgba(14,116,144,0.04)"
                                          : "transparent",
                                      cursor: accs.length > 0
                                        ? "pointer"
                                        : "default",
                                    }}
                                  >
                                    <div>
                                      <div style={{ fontWeight: 600 }}>
                                        {s.lastName}, {s.firstName}
                                      </div>
                                      <div
                                        style={{
                                          fontSize: 11,
                                          color: "var(--text-subtle)",
                                        }}
                                      >
                                        {s.studentId} · Gr. {s.grade}
                                      </div>
                                    </div>
                                    <div>
                                      {accs.length === 0 ? (
                                        <span
                                          style={{
                                            fontSize: 11,
                                            color: "var(--text-subtle)",
                                          }}
                                        >
                                          —
                                        </span>
                                      ) : (
                                        Array.from(byCat.entries()).map(
                                          ([cat, names]) =>
                                            renderChip(
                                              names.length > 1
                                                ? `${cat} · ${names.length}`
                                                : cat,
                                              catColor[cat] ?? "#475569",
                                              names.join(", "),
                                            ),
                                        )
                                      )}
                                    </div>
                                    <div>
                                      {isEseCoord && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setAccStudentId(s.studentId);
                                            setAccView("student");
                                          }}
                                        >
                                          Edit
                                        </button>
                                      )}
                                    </div>
                                    {isHover && accs.length > 0 && (
                                      <div
                                        style={{
                                          position: "absolute",
                                          top: "100%",
                                          left: 8,
                                          marginTop: 4,
                                          zIndex: 5,
                                          background: "white",
                                          border: "1px solid var(--border)",
                                          borderRadius: 6,
                                          padding: "0.5rem 0.7rem",
                                          boxShadow:
                                            "0 4px 14px rgba(0,0,0,0.12)",
                                          minWidth: 240,
                                          maxWidth: 360,
                                          color: "var(--text)",
                                        }}
                                      >
                                        <div
                                          style={{
                                            fontSize: 11,
                                            color: "var(--text-subtle)",
                                            marginBottom: 4,
                                          }}
                                        >
                                          Accommodations
                                        </div>
                                        {Array.from(byCat.entries()).map(
                                          ([cat, names]) => (
                                            <div
                                              key={cat}
                                              style={{ marginBottom: 4 }}
                                            >
                                              <div
                                                style={{
                                                  fontSize: 10,
                                                  fontWeight: 700,
                                                  color:
                                                    catColor[cat] ?? "#475569",
                                                  textTransform: "uppercase",
                                                  letterSpacing: 0.5,
                                                }}
                                              >
                                                {cat}
                                              </div>
                                              <ul
                                                style={{
                                                  margin: "2px 0 0 0",
                                                  paddingLeft: 16,
                                                  fontSize: 12,
                                                }}
                                              >
                                                {names.map((n) => (
                                                  <li key={n}>{n}</li>
                                                ))}
                                              </ul>
                                            </div>
                                          ),
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </>
                    );
                  })()
                ) : accView === "student" ? (
                  <>
                    <h3 style={{ marginTop: 0 }}>Student Accommodations</h3>
                    <div
                      style={{
                        marginBottom: "0.5rem",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <label
                        style={{ fontWeight: 600 }}
                        htmlFor="acc-student-combobox"
                      >
                        Student:
                      </label>
                      <StudentCombobox
                        students={students}
                        value={accStudentId}
                        onChange={setAccStudentId}
                        isAdmin={Boolean(
                          authUser?.isAdmin || authUser?.isSuperUser,
                        )}
                      />
                    </div>
                    {!accStudentId ? (
                      <div>Please select a student.</div>
                    ) : accs.length === 0 ? (
                      <div>No accommodations on file</div>
                    ) : (
                      <ul style={{ margin: 0 }}>
                        {accs.map((a) => (
                          <li key={a} style={{ marginBottom: "0.25rem" }}>
                            {a}{" "}
                            <button
                              type="button"
                              onClick={() =>
                                logAccommodationProvided(accStudentId, a, null)
                              }
                            >
                              Log Provided
                            </button>{" "}
                            <button
                              type="button"
                              onClick={() =>
                                logAccommodationRefused(accStudentId, a, null)
                              }
                              style={{ background: "#fde2e2" }}
                              title="Mark that the student refused this accommodation today"
                            >
                              Refused today
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : accView === "daily" ? (
                  (() => {
                    const allInPeriod = dailyPeriod
                      ? periodRoster[dailyPeriod] ?? []
                      : [];
                    const presentIds = allInPeriod.filter(
                      (id) => !dailyAbsent.has(id),
                    );
                    const presentStudents = presentIds
                      .map((id) =>
                        students.find((st) => st.studentId === id),
                      )
                      .filter(
                        (s): s is (typeof students)[number] => s !== undefined,
                      );
                    const accUnion = Array.from(
                      new Set(
                        presentStudents.flatMap(
                          (s) => s.accommodations ?? [],
                        ),
                      ),
                    );
                    const accUnionWithIds = schoolAccs
                      .filter((sa) => accUnion.includes(sa.name))
                      .sort((a, b) =>
                        a.category === b.category
                          ? a.name.localeCompare(b.name)
                          : a.category.localeCompare(b.category),
                      );
                    const trackedCats = new Set<
                      SchoolAccommodation["category"]
                    >(["IEP", "504", "ELL"]);
                    const studentTrackedCats = (
                      st: (typeof students)[number],
                    ): SchoolAccommodation["category"][] => {
                      const seen = new Set<SchoolAccommodation["category"]>();
                      for (const name of st.accommodations ?? []) {
                        const cat = accCategoryByName.get(name);
                        if (cat && trackedCats.has(cat)) seen.add(cat);
                      }
                      return ["IEP", "504", "ELL"].filter((c) =>
                        seen.has(c as SchoolAccommodation["category"]),
                      ) as SchoolAccommodation["category"][];
                    };
                    const allInPeriodStudents = allInPeriod
                      .map((id) =>
                        students.find((st) => st.studentId === id),
                      )
                      .filter(
                        (s): s is (typeof students)[number] => s !== undefined,
                      )
                      .filter((st) => studentTrackedCats(st).length > 0);
                    const presentEligibleCount = allInPeriodStudents.filter(
                      (st) => !dailyAbsent.has(st.studentId),
                    ).length;
                    const catColor = (
                      c: SchoolAccommodation["category"],
                    ): string =>
                      c === "IEP"
                        ? "#0e7490"
                        : c === "504"
                          ? "#7c3aed"
                          : c === "ELL"
                            ? "#0891b2"
                            : "#64748b";
                    return (
                      <>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "0.75rem",
                            marginTop: 0,
                            marginBottom: "0.6rem",
                          }}
                        >
                          <h3
                            style={{
                              margin: 0,
                              display: "flex",
                              alignItems: "center",
                            }}
                          >
                            Class Log
                            <svg
                              className="classlog-ekg no-print"
                              viewBox="0 0 220 36"
                              preserveAspectRatio="none"
                              aria-hidden="true"
                            >
                              <path
                                className="track"
                                d="M0 18 H40 L48 18 L54 6 L62 30 L70 12 L78 22 L86 18 H110 L118 18 L124 8 L132 28 L140 14 L148 22 L156 18 H220"
                              />
                              <path
                                className="pulse"
                                d="M0 18 H40 L48 18 L54 6 L62 30 L70 12 L78 22 L86 18 H110 L118 18 L124 8 L132 28 L140 14 L148 22 L156 18 H220"
                              />
                            </svg>
                          </h3>
                          <button
                            type="button"
                            className="no-print"
                            onClick={() => window.print()}
                            style={{
                              background: "#7c3aed",
                              color: "#fff",
                              border: "1px solid #6d28d9",
                              padding: "0.35rem 0.95rem",
                              fontSize: "0.85rem",
                              fontWeight: 600,
                              borderRadius: 999,
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.35rem",
                              boxShadow: "0 1px 2px rgba(124,58,237,0.25)",
                            }}
                            title="Print this view"
                          >
                            <span aria-hidden="true">🖨</span>
                            Print
                          </button>
                        </div>
                        <div style={{ marginBottom: "0.75rem" }}>
                          <label>
                            Period:{" "}
                            <select
                              value={dailyPeriod}
                              onChange={(e) => {
                                setDailyPeriod(e.target.value);
                                setDailyAbsent(new Set());
                                setDailyAbsentConfirmed(false);
                                setDailySelectedAccs(new Set());
                                setDailySubmitMsg("");
                              }}
                            >
                              <option value="">-- Select period --</option>
                              {myPeriods.map((p) => (
                                <option key={p} value={String(p)}>
                                  Period {p}
                                </option>
                              ))}
                            </select>
                          </label>
                          {myPeriods.length === 0 && (
                            <span
                              style={{ marginLeft: "0.5rem", color: "#666" }}
                            >
                              No teaching periods assigned to you.
                            </span>
                          )}
                        </div>
                        {!dailyPeriod ? (
                          <div>Pick a period to start.</div>
                        ) : (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                              gap: "1rem",
                            }}
                          >
                            <div>
                              <h4 style={{ margin: "0 0 0.5rem" }}>
                                Students with accommodations (
                                {allInPeriodStudents.length}) — check absentees
                              </h4>
                              <div
                                style={{
                                  marginBottom: "0.5rem",
                                  padding: "0.5rem 0.75rem",
                                  background: dailyAbsentConfirmed
                                    ? "rgba(13, 148, 136, 0.08)"
                                    : "rgba(234, 179, 8, 0.08)",
                                  border: `1px solid ${
                                    dailyAbsentConfirmed
                                      ? "rgba(13, 148, 136, 0.4)"
                                      : "rgba(234, 179, 8, 0.4)"
                                  }`,
                                  borderRadius: 6,
                                }}
                              >
                                <label
                                  style={{
                                    display: "flex",
                                    gap: "0.5rem",
                                    alignItems: "center",
                                    cursor: "pointer",
                                    fontSize: 14,
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={dailyAbsentConfirmed}
                                    onChange={(e) =>
                                      setDailyAbsentConfirmed(
                                        e.target.checked,
                                      )
                                    }
                                    disabled={
                                      allInPeriodStudents.length === 0
                                    }
                                  />
                                  <span>
                                    I've indicated all absent students by
                                    checking the box
                                    {dailyAbsent.size > 0 && (
                                      <em
                                        style={{
                                          color: "#666",
                                          display: "block",
                                          marginTop: 2,
                                        }}
                                      >
                                        ({dailyAbsent.size} marked absent)
                                      </em>
                                    )}
                                  </span>
                                </label>
                              </div>
                              {allInPeriodStudents.length === 0 ? (
                                <div>
                                  No students in this period have an IEP, 504,
                                  or ELL accommodation on file.
                                </div>
                              ) : (
                                <ul
                                  style={{
                                    listStyle: "none",
                                    padding: 0,
                                    margin: 0,
                                    maxHeight: "20rem",
                                    overflowY: "auto",
                                    border: "1px solid #ddd",
                                  }}
                                >
                                  {allInPeriodStudents
                                    .sort((a, b) =>
                                      a.lastName.localeCompare(b.lastName),
                                    )
                                    .map((st) => (
                                      <li
                                        key={st.studentId}
                                        style={{
                                          padding: "0.25rem 0.5rem",
                                          borderBottom: "1px solid #eee",
                                        }}
                                      >
                                        <label
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "0.4rem",
                                            opacity: dailyAbsent.has(
                                              st.studentId,
                                            )
                                              ? 0.55
                                              : 1,
                                          }}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={dailyAbsent.has(
                                              st.studentId,
                                            )}
                                            onChange={(e) => {
                                              const next = new Set(
                                                dailyAbsent,
                                              );
                                              if (e.target.checked)
                                                next.add(st.studentId);
                                              else next.delete(st.studentId);
                                              setDailyAbsent(next);
                                              setDailyAbsentConfirmed(false);
                                            }}
                                          />
                                          <span
                                            style={{
                                              flex: 1,
                                              textDecoration: dailyAbsent.has(
                                                st.studentId,
                                              )
                                                ? "line-through"
                                                : "none",
                                            }}
                                          >
                                            {st.lastName}, {st.firstName}{" "}
                                            <span style={{ color: "#888" }}>
                                              ({st.studentId})
                                            </span>
                                          </span>
                                          {studentTrackedCats(st).map((c) => (
                                            <span
                                              key={c}
                                              style={{
                                                background: catColor(c),
                                                color: "#fff",
                                                borderRadius: 4,
                                                padding: "1px 5px",
                                                fontSize: "0.7em",
                                                fontWeight: 600,
                                                letterSpacing: "0.02em",
                                              }}
                                            >
                                              {c}
                                            </span>
                                          ))}
                                        </label>
                                      </li>
                                    ))}
                                </ul>
                              )}
                              <div
                                style={{
                                  marginTop: "0.5rem",
                                  fontSize: "0.9em",
                                  color: "#555",
                                }}
                              >
                                Present with accommodations:{" "}
                                <strong>{presentEligibleCount}</strong> /
                                Absent: <strong>{dailyAbsent.size}</strong>
                              </div>
                            </div>
                            <div>
                              {!dailyAbsentConfirmed &&
                                allInPeriodStudents.length > 0 && (
                                  <div
                                    style={{
                                      marginBottom: "0.5rem",
                                      fontSize: "0.95em",
                                      fontWeight: 700,
                                      color: "#b91c1c",
                                    }}
                                  >
                                    Mark Absent students on the left, then
                                    confirm to enable APPLY.
                                  </div>
                                )}
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "0.75rem",
                                  marginBottom: "0.5rem",
                                  flexWrap: "wrap",
                                }}
                              >
                                <h4 style={{ margin: 0 }}>
                                  Accommodations
                                </h4>
                                <button
                                  type="button"
                                  onClick={submitDailyLog}
                                  disabled={
                                    !dailyAbsentConfirmed ||
                                    dailySelectedAccs.size === 0 ||
                                    presentEligibleCount === 0
                                  }
                                  className={
                                    "apply-ekg-btn" +
                                    (dailyApplyPulse ? " pulse-active" : "")
                                  }
                                  style={{
                                    background: "#0d9488",
                                    color: "#fff",
                                    border: "1px solid #0f766e",
                                    padding: "0.6rem 1.1rem",
                                    fontSize: "1rem",
                                    fontWeight: 600,
                                    borderRadius: 6,
                                    cursor: !dailyAbsentConfirmed ||
                                      dailySelectedAccs.size === 0 ||
                                      presentEligibleCount === 0
                                      ? "not-allowed"
                                      : "pointer",
                                    opacity: !dailyAbsentConfirmed ||
                                      dailySelectedAccs.size === 0 ||
                                      presentEligibleCount === 0
                                      ? 0.55
                                      : 1,
                                  }}
                                  title={
                                    !dailyAbsentConfirmed
                                      ? "Mark absences and confirm first"
                                      : dailySelectedAccs.size === 0
                                        ? "Select at least one accommodation"
                                        : presentEligibleCount === 0
                                          ? "No present students with accommodations"
                                          : undefined
                                  }
                                >
                                  <span style={{ position: "relative", zIndex: 1 }}>
                                    Apply {dailySelectedAccs.size}{" "}
                                    accommodation
                                    {dailySelectedAccs.size === 1 ? "" : "s"} to{" "}
                                    {presentEligibleCount} student
                                    {presentEligibleCount === 1 ? "" : "s"}
                                  </span>
                                  <svg
                                    className="apply-ekg-overlay"
                                    viewBox="0 0 600 40"
                                    preserveAspectRatio="none"
                                    aria-hidden="true"
                                  >
                                    <path
                                      className="track"
                                      d="M0 20 H100 L110 20 L118 6 L128 34 L138 12 L148 26 L158 20 H260 L270 20 L278 8 L288 32 L298 14 L308 26 L318 20 H420 L430 20 L438 6 L448 34 L458 12 L468 26 L478 20 H600"
                                    />
                                    <path
                                      className="pulse"
                                      d="M0 20 H100 L110 20 L118 6 L128 34 L138 12 L148 26 L158 20 H260 L270 20 L278 8 L288 32 L298 14 L308 26 L318 20 H420 L430 20 L438 6 L448 34 L458 12 L468 26 L478 20 H600"
                                    />
                                  </svg>
                                </button>
                              </div>
                              {accUnionWithIds.length === 0 ? (
                                <div>
                                  No accommodations apply to the present
                                  students.
                                </div>
                              ) : (
                                <>
                                  <div style={{ marginBottom: "0.5rem" }}>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setDailySelectedAccs(
                                          new Set(
                                            accUnionWithIds.map((a) => a.id),
                                          ),
                                        )
                                      }
                                      style={{ marginRight: "0.25rem" }}
                                    >
                                      Select all
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setDailySelectedAccs(new Set())
                                      }
                                    >
                                      Clear
                                    </button>
                                  </div>
                                  <ul
                                    style={{
                                      listStyle: "none",
                                      padding: 0,
                                      margin: 0,
                                      maxHeight: "20rem",
                                      overflowY: "auto",
                                      border: "1px solid #ddd",
                                    }}
                                  >
                                    {accUnionWithIds.map((a) => (
                                      <li
                                        key={a.id}
                                        style={{
                                          padding: "0.25rem 0.5rem",
                                          borderBottom: "1px solid #eee",
                                        }}
                                      >
                                        <label>
                                          <input
                                            type="checkbox"
                                            checked={dailySelectedAccs.has(
                                              a.id,
                                            )}
                                            onChange={(e) => {
                                              const next = new Set(
                                                dailySelectedAccs,
                                              );
                                              if (e.target.checked)
                                                next.add(a.id);
                                              else next.delete(a.id);
                                              setDailySelectedAccs(next);
                                            }}
                                          />{" "}
                                          <span
                                            style={{
                                              color: "#666",
                                              fontSize: "0.85em",
                                            }}
                                          >
                                            [{a.category}]
                                          </span>{" "}
                                          {a.name}
                                        </label>
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                              <div style={{ marginTop: "0.75rem" }}>
                                {dailySubmitMsg && (
                                  <div
                                    style={{
                                      marginTop: "0.5rem",
                                      color: dailySubmitMsg.startsWith(
                                        "Failed",
                                      )
                                        ? "#a00"
                                        : "#080",
                                    }}
                                  >
                                    {dailySubmitMsg}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()
                ) : (
                  // ----- Reports view -----
                  (() => {
                    const isPrivileged =
                      authUser?.isAdmin === true ||
                      authUser?.isEseCoordinator === true;
                    const periodOptions: number[] = (() => {
                      // Use teacher's own teaching periods if any; else 1..periodCount.
                      if (
                        myPeriods.length > 0 &&
                        (!isPrivileged ||
                          reportTeacherId === authUser?.id)
                      ) {
                        return myPeriods;
                      }
                      const max =
                        schoolSettings.periodCount > 0
                          ? schoolSettings.periodCount
                          : 7;
                      return Array.from({ length: max }, (_, i) => i + 1);
                    })();
                    const cellBg = (cell: ReportData["daily"][number]) => {
                      if (!cell.submitted) return "#f6f6f6";
                      const { logged, eligible } = cell.coverage;
                      if (eligible === 0) return "#e6f4ea";
                      const pct = logged / eligible;
                      if (pct >= 0.9) return "#cdebd6";
                      if (pct >= 0.5) return "#fff4cc";
                      return "#fde2e2";
                    };
                    return (
                      <>
                        <h3 style={{ marginTop: 0 }}>
                          Accommodation Reports
                          <button
                            type="button"
                            className="no-print"
                            onClick={() => window.print()}
                            style={{ marginLeft: "0.75rem", fontSize: "0.85rem" }}
                          >
                            Print
                          </button>
                        </h3>

                        {/* ---- Filter bar ---- */}
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "0.75rem",
                            alignItems: "center",
                            marginBottom: "0.75rem",
                          }}
                        >
                          {/* Date range */}
                          <div
                            style={{
                              display: "flex",
                              gap: "0.25rem",
                              alignItems: "center",
                            }}
                          >
                            <span style={{ fontSize: "0.9rem" }}>Range:</span>
                            {(["today", "7d", "30d", "custom"] as const).map(
                              (r) => (
                                <button
                                  key={r}
                                  type="button"
                                  onClick={() => setReportRange(r)}
                                  disabled={reportRange === r}
                                  style={{ padding: "0.15rem 0.5rem" }}
                                >
                                  {r === "today"
                                    ? "Today"
                                    : r === "7d"
                                      ? "7d"
                                      : r === "30d"
                                        ? "30d"
                                        : "Custom"}
                                </button>
                              ),
                            )}
                          </div>
                          {reportRange === "custom" && (
                            <div
                              style={{
                                display: "flex",
                                gap: "0.25rem",
                                alignItems: "center",
                              }}
                            >
                              <input
                                type="date"
                                value={reportCustomFrom}
                                onChange={(e) =>
                                  setReportCustomFrom(e.target.value)
                                }
                              />
                              <span>to</span>
                              <input
                                type="date"
                                value={reportCustomTo}
                                onChange={(e) =>
                                  setReportCustomTo(e.target.value)
                                }
                              />
                            </div>
                          )}

                          {/* Teacher picker (privileged only) */}
                          {isPrivileged ? (
                            <label>
                              Teacher:{" "}
                              <select
                                value={
                                  reportTeacherId === ""
                                    ? ""
                                    : String(reportTeacherId)
                                }
                                onChange={(e) =>
                                  setReportTeacherId(
                                    e.target.value === ""
                                      ? ""
                                      : Number(e.target.value),
                                  )
                                }
                              >
                                <option value="">-- Select teacher --</option>
                                {reportTeachers.map((t) => (
                                  <option key={t.id} value={String(t.id)}>
                                    {t.displayName}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <span style={{ fontSize: "0.9rem", color: "#555" }}>
                              Teacher: <strong>{authUser?.displayName}</strong>
                            </span>
                          )}

                          {/* Period filter */}
                          <label>
                            Period:{" "}
                            <select
                              value={reportPeriod}
                              onChange={(e) => setReportPeriod(e.target.value)}
                            >
                              <option value="">All</option>
                              {periodOptions.map((p) => (
                                <option key={p} value={String(p)}>
                                  P{p}
                                </option>
                              ))}
                            </select>
                          </label>

                          {reportLoading && (
                            <span style={{ color: "#666" }}>Loading…</span>
                          )}
                          {reportError && (
                            <span style={{ color: "#a00" }}>
                              {reportError}
                            </span>
                          )}
                        </div>

                        {/* ---- Body ---- */}
                        {!reportTeacherId ? (
                          <div>Pick a teacher to view their report.</div>
                        ) : !reportData ? (
                          reportLoading ? null : (
                            <div>No data.</div>
                          )
                        ) : (
                          <>
                            {/* Summary cards */}
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns:
                                  "repeat(auto-fit, minmax(140px, 1fr))",
                                gap: "0.5rem",
                                marginBottom: "0.75rem",
                              }}
                            >
                              <div
                                style={{
                                  border: "1px solid #ccc",
                                  padding: "0.5rem",
                                }}
                              >
                                <div style={{ fontSize: "0.8rem" }}>
                                  Provided
                                </div>
                                <div
                                  style={{
                                    fontSize: "1.4rem",
                                    color: "#0a7a3b",
                                  }}
                                >
                                  {reportData.totals.providedCount}
                                </div>
                              </div>
                              <div
                                style={{
                                  border: "1px solid #ccc",
                                  padding: "0.5rem",
                                }}
                              >
                                <div style={{ fontSize: "0.8rem" }}>
                                  Refused
                                </div>
                                <div
                                  style={{
                                    fontSize: "1.4rem",
                                    color: "#b00020",
                                  }}
                                >
                                  {reportData.totals.refusedCount}
                                </div>
                              </div>
                              <div
                                style={{
                                  border: "1px solid #ccc",
                                  padding: "0.5rem",
                                }}
                              >
                                <div style={{ fontSize: "0.8rem" }}>
                                  Days w/ activity
                                </div>
                                <div style={{ fontSize: "1.4rem" }}>
                                  {reportData.totals.daysWithActivity} /{" "}
                                  {reportData.range.days}
                                </div>
                              </div>
                              <div
                                style={{
                                  border: "1px solid #ccc",
                                  padding: "0.5rem",
                                }}
                              >
                                <div style={{ fontSize: "0.8rem" }}>
                                  Avg coverage
                                </div>
                                <div style={{ fontSize: "1.4rem" }}>
                                  {reportData.totals.avgCoveragePct == null
                                    ? "—"
                                    : `${reportData.totals.avgCoveragePct}%`}
                                </div>
                              </div>
                            </div>

                            {/* Sections */}
                            <h4 style={{ margin: "0.5rem 0 0.25rem 0" }}>
                              Sections
                            </h4>
                            {reportData.sections.length === 0 ? (
                              <div>No sections for this teacher.</div>
                            ) : (
                              <table
                                style={{
                                  borderCollapse: "collapse",
                                  width: "100%",
                                  marginBottom: "0.75rem",
                                }}
                              >
                                <thead>
                                  <tr>
                                    <th
                                      style={{
                                        textAlign: "left",
                                        borderBottom: "1px solid #ccc",
                                        padding: "0.25rem",
                                      }}
                                    >
                                      Period
                                    </th>
                                    <th
                                      style={{
                                        textAlign: "left",
                                        borderBottom: "1px solid #ccc",
                                        padding: "0.25rem",
                                      }}
                                    >
                                      Course
                                    </th>
                                    <th
                                      style={{
                                        textAlign: "right",
                                        borderBottom: "1px solid #ccc",
                                        padding: "0.25rem",
                                      }}
                                    >
                                      Roster
                                    </th>
                                    <th
                                      style={{
                                        textAlign: "right",
                                        borderBottom: "1px solid #ccc",
                                        padding: "0.25rem",
                                      }}
                                    >
                                      W/ accommodations
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {reportData.sections
                                    .slice()
                                    .sort((a, b) => a.period - b.period)
                                    .map((s) => (
                                      <tr key={s.id}>
                                        <td style={{ padding: "0.25rem" }}>
                                          P{s.period}
                                        </td>
                                        <td style={{ padding: "0.25rem" }}>
                                          {s.courseName}
                                          {s.isPlanning ? " (planning)" : ""}
                                        </td>
                                        <td
                                          style={{
                                            padding: "0.25rem",
                                            textAlign: "right",
                                          }}
                                        >
                                          {s.rosterCount}
                                        </td>
                                        <td
                                          style={{
                                            padding: "0.25rem",
                                            textAlign: "right",
                                          }}
                                        >
                                          {s.accommodatedRosterCount}
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            )}

                            {/* Daily x period grid */}
                            <h4 style={{ margin: "0.5rem 0 0.25rem 0" }}>
                              Daily Coverage
                            </h4>
                            {reportData.daily.length === 0 ? (
                              <div>
                                No teaching periods in range. Pick a different
                                range or remove the period filter.
                              </div>
                            ) : (() => {
                              const periodsInGrid = Array.from(
                                new Set(
                                  reportData.daily.map((c) => c.period),
                                ),
                              ).sort((a, b) => a - b);
                              const datesInGrid = Array.from(
                                new Set(reportData.daily.map((c) => c.date)),
                              ).sort();
                              const cellByKey = new Map(
                                reportData.daily.map((c) => [
                                  `${c.date}|${c.period}`,
                                  c,
                                ]),
                              );
                              return (
                                <div style={{ overflowX: "auto" }}>
                                  <table
                                    style={{
                                      borderCollapse: "collapse",
                                      fontSize: "0.85rem",
                                    }}
                                  >
                                    <thead>
                                      <tr>
                                        <th
                                          style={{
                                            border: "1px solid #ccc",
                                            padding: "0.25rem",
                                            background: "#f3f3f3",
                                          }}
                                        >
                                          Date
                                        </th>
                                        {periodsInGrid.map((p) => (
                                          <th
                                            key={p}
                                            style={{
                                              border: "1px solid #ccc",
                                              padding: "0.25rem",
                                              background: "#f3f3f3",
                                            }}
                                          >
                                            P{p}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {datesInGrid.map((d) => (
                                        <tr key={d}>
                                          <td
                                            style={{
                                              border: "1px solid #ccc",
                                              padding: "0.25rem",
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            {d}
                                          </td>
                                          {periodsInGrid.map((p) => {
                                            const cell = cellByKey.get(
                                              `${d}|${p}`,
                                            );
                                            if (!cell) {
                                              return (
                                                <td
                                                  key={p}
                                                  style={{
                                                    border: "1px solid #ccc",
                                                    padding: "0.25rem",
                                                    background: "#f6f6f6",
                                                    color: "#999",
                                                    textAlign: "center",
                                                  }}
                                                >
                                                  —
                                                </td>
                                              );
                                            }
                                            const title = cell.submitted
                                              ? `${cell.coverage.logged} of ${cell.coverage.eligible} accommodated students logged | ${cell.providedCount} provided | ${cell.refusedCount} refused`
                                              : "No log submitted";
                                            return (
                                              <td
                                                key={p}
                                                title={title}
                                                style={{
                                                  border: "1px solid #ccc",
                                                  padding: "0.25rem",
                                                  textAlign: "center",
                                                  background: cellBg(cell),
                                                  minWidth: "3rem",
                                                }}
                                              >
                                                {cell.submitted
                                                  ? `${cell.coverage.logged}/${cell.coverage.eligible}`
                                                  : "·"}
                                              </td>
                                            );
                                          })}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  <div
                                    style={{
                                      marginTop: "0.25rem",
                                      fontSize: "0.75rem",
                                      color: "#555",
                                    }}
                                  >
                                    Cells show <em>logged / eligible</em>{" "}
                                    students. Green ≥90%, yellow ≥50%, red
                                    &lt;50%, gray = no submit.
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Recent feed */}
                            <h4 style={{ margin: "0.75rem 0 0.25rem 0" }}>
                              Recent activity (last 20)
                            </h4>
                            {reportData.recent.length === 0 ? (
                              <div>No recent log entries.</div>
                            ) : (
                              <ul
                                style={{
                                  margin: 0,
                                  padding: 0,
                                  listStyle: "none",
                                }}
                              >
                                {reportData.recent.map((r) => {
                                  const refused = r.status === "refused";
                                  return (
                                    <li
                                      key={r.id}
                                      style={{
                                        padding: "0.25rem 0.5rem",
                                        marginBottom: "0.15rem",
                                        borderLeft: `4px solid ${
                                          refused ? "#b00020" : "#0a7a3b"
                                        }`,
                                        background: refused
                                          ? "#fde2e2"
                                          : "#e6f4ea",
                                      }}
                                    >
                                      <strong
                                        style={{
                                          color: refused
                                            ? "#b00020"
                                            : "#0a7a3b",
                                        }}
                                      >
                                        {refused ? "Refused" : "Provided"}
                                      </strong>
                                      {": "}
                                      {r.accommodation}
                                      {" | "}
                                      {r.studentName}
                                      {r.period != null
                                        ? ` | P${r.period}`
                                        : ""}
                                      {" | "}
                                      {new Date(r.createdAt).toLocaleString()}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </>
                        )}
                      </>
                    );
                  })()
                )}
              </section>
            );
          })()}
        </section>
      </>)}

      {activeSection === "pbis" && (<>
        <section className="card">
          <h2>PBIS Points</h2>
          {recentMilestoneToasts.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginBottom: "0.75rem" }}>
              {recentMilestoneToasts.map((t) => (
                <div
                  key={t.id}
                  style={{
                    padding: "0.4rem 0.6rem",
                    borderRadius: "0.35rem",
                    fontSize: "0.85rem",
                    background:
                      t.tone === "ok"
                        ? "#dcfce7"
                        : t.tone === "warn"
                          ? "#fef3c7"
                          : "#fee2e2",
                    color:
                      t.tone === "ok"
                        ? "#166534"
                        : t.tone === "warn"
                          ? "#92400e"
                          : "#991b1b",
                  }}
                >
                  {t.text}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setRecentMilestoneToasts([])}
                style={{ alignSelf: "flex-start", fontSize: "0.8rem" }}
              >
                Dismiss
              </button>
            </div>
          )}
          <form onSubmit={handlePbisSubmit} style={{ marginBottom: "1rem" }}>
            <div style={{ marginBottom: "0.5rem" }}>
              <label>
                Student:{" "}
                <input
                  type="text"
                  placeholder="Search by name or ID"
                  value={pbisStudentSearch}
                  onChange={(e) => {
                    setPbisStudentSearch(e.target.value);
                    setPbisStudentId("");
                  }}
                />
              </label>
              {pbisStudentId ? (
                <div style={{ marginTop: "0.25rem" }}>
                  Selected: <strong>{pbisStudentId}</strong>{" "}
                  {(() => {
                    const s = students.find(
                      (s) => s.studentId === pbisStudentId,
                    );
                    return s ? `- ${s.firstName} ${s.lastName}` : "";
                  })()}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setPbisStudentId("");
                      setPbisStudentSearch("");
                    }}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                pbisStudentSearch && (
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "0.25rem 0",
                      border: "1px solid #ccc",
                      maxWidth: "20rem",
                    }}
                  >
                    {students
                      .filter((s) => {
                        const q = pbisStudentSearch.toLowerCase();
                        return (
                          s.firstName.toLowerCase().includes(q) ||
                          s.lastName.toLowerCase().includes(q) ||
                          s.studentId.toLowerCase().includes(q)
                        );
                      })
                      .map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            style={{
                              width: "100%",
                              textAlign: "left",
                              padding: "0.25rem 0.5rem",
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                            }}
                            onClick={() => {
                              setPbisStudentId(s.studentId);
                              setPbisStudentSearch(
                                `${s.studentId} - ${s.firstName} ${s.lastName}`,
                              );
                            }}
                          >
                            {s.studentId} - {s.firstName} {s.lastName}
                          </button>
                        </li>
                      ))}
                  </ul>
                )
              )}
            </div>
            {pbisStudentId &&
              (() => {
                const forStudent = pbisEntries
                  .filter((e) => e.studentId === pbisStudentId && !e.voidedAt)
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                const total = forStudent.reduce(
                  (sum, e) => sum + (e.points || 0),
                  0,
                );
                const recent = forStudent.slice(0, 5);
                return (
                  <div
                    style={{
                      margin: "0.5rem 0 0.75rem 0",
                      padding: "0.5rem 0.75rem",
                      background: "var(--surface-soft, #f6f8fb)",
                      border: "1px solid var(--border, #e2e8f0)",
                      borderRadius: 6,
                      maxWidth: "32rem",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                      Running total: {total}{" "}
                      {total === 1 ? "point" : "points"}{" "}
                      <span
                        style={{
                          fontWeight: 400,
                          color: "var(--muted, #64748b)",
                        }}
                      >
                        ({forStudent.length}{" "}
                        {forStudent.length === 1 ? "entry" : "entries"})
                      </span>
                    </div>
                    {recent.length === 0 ? (
                      <div
                        style={{
                          fontSize: "0.85rem",
                          color: "var(--muted, #64748b)",
                        }}
                      >
                        No PBIS entries yet for this student.
                      </div>
                    ) : (
                      <ul
                        style={{
                          margin: 0,
                          paddingLeft: "1.1rem",
                          fontSize: "0.85rem",
                        }}
                      >
                        {recent.map((e) => (
                          <li key={e.id}>
                            <strong>{e.reason}</strong> · {e.points}{" "}
                            {e.points === 1 ? "pt" : "pts"} ·{" "}
                            {new Date(e.createdAt).toLocaleString()} ·{" "}
                            {e.staffName || "—"}
                          </li>
                        ))}
                      </ul>
                    )}
                    {(() => {
                      const goals = pbisGoals.filter(
                        (g) =>
                          g.studentId === pbisStudentId && !g.archivedAt,
                      );
                      return (
                        <div style={{ marginTop: "0.6rem" }}>
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: "0.85rem",
                              marginBottom: "0.3rem",
                            }}
                          >
                            Goals
                          </div>
                          {goals.length === 0 ? (
                            <div
                              style={{
                                fontSize: "0.8rem",
                                color: "var(--muted, #64748b)",
                                marginBottom: "0.4rem",
                              }}
                            >
                              No active goals.
                            </div>
                          ) : (
                            <ul
                              style={{
                                listStyle: "none",
                                padding: 0,
                                margin: "0 0 0.4rem",
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                              }}
                            >
                              {goals.map((g) => {
                                const earned = computeGoalProgress(g);
                                const pct = Math.min(
                                  100,
                                  Math.round(
                                    (earned / g.targetPoints) * 100,
                                  ),
                                );
                                const reached = earned >= g.targetPoints;
                                const { label } = periodWindow(g.periodType);
                                const canArchive =
                                  isAdmin ||
                                  isPbisCoord ||
                                  (g.createdById !== null &&
                                    g.createdById === authUser?.id);
                                return (
                                  <li
                                    key={g.id}
                                    style={{
                                      fontSize: "0.8rem",
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 2,
                                    }}
                                  >
                                    <div
                                      style={{
                                        display: "flex",
                                        gap: 6,
                                        alignItems: "center",
                                        flexWrap: "wrap",
                                      }}
                                    >
                                      {reached && (
                                        <span
                                          title="Goal reached"
                                          style={{
                                            background: "#15803d",
                                            color: "white",
                                            padding: "0 6px",
                                            borderRadius: 999,
                                            fontSize: "0.7rem",
                                          }}
                                        >
                                          ★ Reached
                                        </span>
                                      )}
                                      <strong>
                                        {g.reason || "Any reason"}
                                      </strong>
                                      <span style={{ color: "#64748b" }}>
                                        · {label} · {earned}/{g.targetPoints}{" "}
                                        pts
                                      </span>
                                      {canArchive && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            archivePbisGoal(g.id)
                                          }
                                          style={{
                                            marginLeft: "auto",
                                            fontSize: "0.7rem",
                                          }}
                                        >
                                          Archive
                                        </button>
                                      )}
                                    </div>
                                    <div
                                      style={{
                                        height: 6,
                                        background: "#e2e8f0",
                                        borderRadius: 3,
                                        overflow: "hidden",
                                      }}
                                    >
                                      <div
                                        style={{
                                          width: `${pct}%`,
                                          height: "100%",
                                          background: reached
                                            ? "#15803d"
                                            : "#3b82f6",
                                        }}
                                      />
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          <details>
                            <summary
                              style={{
                                cursor: "pointer",
                                fontSize: "0.8rem",
                                color: "#3b82f6",
                              }}
                            >
                              + Add goal
                            </summary>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns:
                                  "auto auto auto auto",
                                gap: 6,
                                alignItems: "end",
                                marginTop: "0.4rem",
                                fontSize: "0.8rem",
                              }}
                            >
                              <label>
                                <div>Reason</div>
                                <select
                                  value={goalReason}
                                  onChange={(e) =>
                                    setGoalReason(e.target.value)
                                  }
                                >
                                  <option value="">Any reason</option>
                                  {pbisReasonsList
                                    .slice()
                                    .sort((a, b) =>
                                      a.name.localeCompare(b.name),
                                    )
                                    .map((r) => (
                                      <option key={r.id} value={r.name}>
                                        {r.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <label>
                                <div>Target</div>
                                <input
                                  type="number"
                                  min={1}
                                  value={goalTarget}
                                  onChange={(e) =>
                                    setGoalTarget(Number(e.target.value))
                                  }
                                  style={{ width: "5rem" }}
                                />
                              </label>
                              <label>
                                <div>Period</div>
                                <select
                                  value={goalPeriod}
                                  onChange={(e) =>
                                    setGoalPeriod(
                                      e.target.value as
                                        | "week"
                                        | "month"
                                        | "quarter"
                                        | "all",
                                    )
                                  }
                                >
                                  <option value="week">Week</option>
                                  <option value="month">Month</option>
                                  <option value="quarter">Quarter</option>
                                  <option value="all">All-time</option>
                                </select>
                              </label>
                              <button
                                type="button"
                                disabled={goalBusy}
                                onClick={() => addPbisGoal(pbisStudentId)}
                              >
                                {goalBusy ? "Adding…" : "Add"}
                              </button>
                            </div>
                            {goalMsg && (
                              <div
                                style={{
                                  fontSize: "0.75rem",
                                  color: "#b91c1c",
                                  marginTop: 4,
                                }}
                              >
                                {goalMsg}
                              </div>
                            )}
                          </details>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}
            <div style={{ marginBottom: "0.5rem" }}>
              <label>
                PBIS Recognition:{" "}
                <select
                  value={pbisReasonId === "" ? "" : String(pbisReasonId)}
                  onChange={(e) =>
                    setPbisReasonId(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                >
                  <option value="">— Select a reason —</option>
                  {pbisReasonsList
                    .filter((r) => r.active)
                    .slice()
                    .sort((a, b) =>
                      a.category === b.category
                        ? a.name.localeCompare(b.name)
                        : a.category.localeCompare(b.category),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.defaultPoints}{" "}
                        {r.defaultPoints === 1 ? "point" : "points"})
                      </option>
                    ))}
                </select>
              </label>
              {pbisReasonsList.filter((r) => r.active).length === 0 && (
                <div style={{ fontSize: "0.85rem", color: "var(--muted, #666)" }}>
                  No active PBIS reasons yet. Ask your PBIS coordinator or
                  admin to add some.
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={!pbisStudentId || pbisReasonId === ""}
            >
              Save PBIS Entry
            </button>
          </form>

          <h3>Recent PBIS Entries</h3>
          <table
            border={1}
            cellPadding={6}
            style={{ borderCollapse: "collapse" }}
          >
            <thead>
              <tr>
                <th>student</th>
                <th>reason</th>
                <th>points</th>
                <th>staff</th>
                <th>createdAt</th>
                <th>actions</th>
              </tr>
            </thead>
            <tbody>
              {[...pbisEntries]
                .reverse()
                .filter((entry) =>
                  dateFilter === "today"
                    ? isCreatedToday(entry.createdAt)
                    : true,
                )
                .filter((entry) =>
                  staffFilter === "mine"
                    ? entry.staffName === currentStaffUser
                    : true,
                )
                .map((entry) => {
                  const isVoided = !!entry.voidedAt;
                  const isEditing = pbisEditId === entry.id;
                  const canManage =
                    isAdmin ||
                    isPbisCoord ||
                    (entry.staffId !== null &&
                      entry.staffId === authUser?.id);
                  const rowMsg =
                    pbisRowMsg && pbisRowMsg.id === entry.id
                      ? pbisRowMsg.msg
                      : "";
                  const cellStyle: React.CSSProperties = isVoided
                    ? { textDecoration: "line-through", color: "#94a3b8" }
                    : {};
                  return (
                    <tr key={entry.id}>
                      <td style={cellStyle}>
                        <div style={{ fontWeight: 600 }}>
                          {studentName(entry.studentId)}
                        </div>
                        <div
                          style={{ fontSize: 11, color: "var(--text-subtle)" }}
                        >
                          {entry.studentId}
                        </div>
                      </td>
                      <td style={cellStyle}>
                        {isEditing ? (
                          <input
                            type="text"
                            value={pbisEditReason}
                            onChange={(e) =>
                              setPbisEditReason(e.target.value)
                            }
                            style={{ width: "12rem" }}
                          />
                        ) : (
                          entry.reason
                        )}
                      </td>
                      <td style={cellStyle}>
                        {isEditing ? (
                          <input
                            type="number"
                            value={pbisEditPoints}
                            onChange={(e) =>
                              setPbisEditPoints(Number(e.target.value))
                            }
                            style={{ width: "5rem" }}
                          />
                        ) : (
                          entry.points
                        )}
                      </td>
                      <td style={cellStyle}>{entry.staffName || "-"}</td>
                      <td style={cellStyle}>{fmtTime(entry.createdAt)}</td>
                      <td>
                        {isVoided ? (
                          <span
                            style={{ fontSize: 11, color: "#b91c1c" }}
                            title={entry.voidReason || ""}
                          >
                            Voided by {entry.voidedByName || "?"}
                            {entry.voidReason ? `: ${entry.voidReason}` : ""}
                          </span>
                        ) : isEditing ? (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => saveEditPbis(entry.id)}
                            >
                              Save
                            </button>
                            <button type="button" onClick={cancelEditPbis}>
                              Cancel
                            </button>
                          </span>
                        ) : canManage ? (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => beginEditPbis(entry)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => voidPbisEntry(entry.id)}
                            >
                              Void
                            </button>
                          </span>
                        ) : null}
                        {rowMsg && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "#b91c1c",
                              marginTop: 2,
                            }}
                          >
                            {rowMsg}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>

          <h3 style={{ marginTop: "1.5rem" }}>Leaderboard</h3>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.8rem" }}>Period</span>
              <select
                value={leaderboardPeriod}
                onChange={(e) => {
                  const p = e.target.value as LeaderboardPeriod;
                  setLeaderboardPeriod(p);
                  loadLeaderboard(p);
                }}
              >
                <option value="week">This week (Mon–Sun)</option>
                <option value="month">This month</option>
                <option value="quarter">This quarter</option>
                <option value="all">All time</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => loadLeaderboard()}
              disabled={leaderboardBusy}
            >
              {leaderboardBusy ? "Loading…" : "Refresh"}
            </button>
            {leaderboardMsg && (
              <span style={{ color: "#b91c1c", fontSize: "0.85rem" }}>
                {leaderboardMsg}
              </span>
            )}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "1rem",
              marginTop: "0.5rem",
            }}
          >
            <div>
              <h4 style={{ margin: "0 0 0.25rem" }}>Top Students</h4>
              {leaderboard && leaderboard.students.length === 0 ? (
                <div style={{ color: "var(--muted, #64748b)", fontSize: "0.85rem" }}>
                  No points awarded in this period yet.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Student</th>
                      <th>Points</th>
                      <th>Awards</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard?.students.map((s, idx) => (
                      <tr key={s.studentId}>
                        <td>{idx + 1}</td>
                        <td>
                          {studentName(s.studentId)}{" "}
                          <span style={{ color: "var(--muted, #64748b)", fontSize: "0.8rem" }}>
                            {s.studentId}
                          </span>
                        </td>
                        <td>{s.total}</td>
                        <td>{s.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h4 style={{ margin: "0 0 0.25rem" }}>Top Awarders</h4>
              {leaderboard && leaderboard.staff.length === 0 ? (
                <div style={{ color: "var(--muted, #64748b)", fontSize: "0.85rem" }}>
                  No staff awards in this period yet.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Staff</th>
                      <th>Points</th>
                      <th>Awards</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard?.staff.map((s, idx) => (
                      <tr key={s.staffId}>
                        <td>{idx + 1}</td>
                        <td>{s.staffName}</td>
                        <td>{s.total}</td>
                        <td>{s.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <h3 style={{ marginTop: "1.5rem" }}>Bulk Award</h3>
          <p style={{ marginTop: 0, color: "var(--muted, #64748b)", fontSize: "0.85rem" }}>
            Award the same reason to a class section or a list of student IDs at once.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              alignItems: "flex-end",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.8rem" }}>Source</span>
              <select
                value={bulkSource}
                onChange={(e) => {
                  setBulkSource(e.target.value as "section" | "ids");
                  setBulkResult(null);
                  setBulkMsg("");
                }}
              >
                <option value="section">Class section</option>
                <option value="ids">List of student IDs</option>
              </select>
            </label>
            {bulkSource === "section" ? (
              <label style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "0.8rem" }}>Section</span>
                <select
                  value={bulkSectionId}
                  onChange={(e) =>
                    setBulkSectionId(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                >
                  <option value="">— pick —</option>
                  {mySections
                    .filter((s) => !s.isPlanning)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        P{s.period} · {s.courseName} ({s.studentIds.length})
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <label style={{ display: "flex", flexDirection: "column", flex: "1 1 240px" }}>
                <span style={{ fontSize: "0.8rem" }}>Student IDs (comma, space, or newline separated)</span>
                <textarea
                  value={bulkIdsText}
                  onChange={(e) => setBulkIdsText(e.target.value)}
                  rows={2}
                  placeholder="e.g. S001, S002, S003"
                />
              </label>
            )}
            <label style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.8rem" }}>Reason</span>
              <select
                value={bulkReasonId}
                onChange={(e) =>
                  setBulkReasonId(
                    e.target.value === "" ? "" : Number(e.target.value),
                  )
                }
              >
                <option value="">— pick —</option>
                {pbisReasonsList
                  .filter((r) => r.active)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.defaultPoints})
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              onClick={submitBulkAward}
              disabled={bulkBusy}
            >
              {bulkBusy
                ? "Awarding…"
                : `Award to ${bulkSelectedIds().length} student${bulkSelectedIds().length === 1 ? "" : "s"}`}
            </button>
          </div>
          {bulkMsg && (
            <div style={{ color: "#b91c1c", marginTop: "0.4rem", fontSize: "0.85rem" }}>
              {bulkMsg}
            </div>
          )}
          {bulkResult && (
            <div style={{ marginTop: "0.4rem", fontSize: "0.85rem" }}>
              <div style={{ color: "#15803d" }}>
                Awarded to {bulkResult.createdCount} student
                {bulkResult.createdCount === 1 ? "" : "s"}.
              </div>
              {bulkResult.errors.length > 0 && (
                <details style={{ marginTop: "0.25rem" }}>
                  <summary style={{ color: "#b91c1c", cursor: "pointer" }}>
                    {bulkResult.errors.length} error
                    {bulkResult.errors.length === 1 ? "" : "s"}
                  </summary>
                  <ul style={{ margin: "0.25rem 0 0 1rem" }}>
                    {bulkResult.errors.map((e) => (
                      <li key={e.studentId}>
                        <code>{e.studentId}</code>: {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <h3 style={{ marginTop: "1.5rem" }}>PBIS Report</h3>
          <p style={{ marginTop: 0, color: "var(--muted, #64748b)", fontSize: "0.85rem" }}>
            {isPbisCoord || isAdmin || isEseCoord
              ? "School-wide. Leave a filter blank to ignore it."
              : "Showing only PBIS points you awarded."}
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(10rem, 1fr)) auto",
              gap: "0.5rem",
              alignItems: "end",
              marginBottom: "0.75rem",
              maxWidth: "60rem",
            }}
          >
            <label>
              <div style={{ fontSize: "0.85rem" }}>From</div>
              <input
                type="date"
                value={pbisReportFrom}
                onChange={(e) => setPbisReportFrom(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>To</div>
              <input
                type="date"
                value={pbisReportTo}
                onChange={(e) => setPbisReportTo(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
            {(isPbisCoord || isAdmin || isEseCoord) && (
              <label>
                <div style={{ fontSize: "0.85rem" }}>Teacher (display name)</div>
                <input
                  type="text"
                  value={pbisReportTeacher}
                  onChange={(e) => setPbisReportTeacher(e.target.value)}
                  placeholder="Any"
                  style={{ width: "100%" }}
                />
              </label>
            )}
            <label>
              <div style={{ fontSize: "0.85rem" }}>Reason</div>
              <select
                value={pbisReportReason}
                onChange={(e) => setPbisReportReason(e.target.value)}
                style={{ width: "100%" }}
              >
                <option value="">Any</option>
                {pbisReasonsList
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((r) => (
                    <option key={r.id} value={r.name}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>Student ID</div>
              <input
                type="text"
                value={pbisReportStudent}
                onChange={(e) => setPbisReportStudent(e.target.value)}
                placeholder="Any"
                style={{ width: "100%" }}
              />
            </label>
            <button
              type="button"
              onClick={runPbisReport}
              disabled={pbisReportBusy}
            >
              {pbisReportBusy ? "Running…" : "Run report"}
            </button>
          </div>
          {pbisReportMsg && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
              {pbisReportMsg}
            </div>
          )}

          {pbisReport && (
            <div style={{ maxWidth: "60rem" }}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "1rem",
                  marginBottom: "0.75rem",
                  fontSize: "0.9rem",
                }}
              >
                <div>
                  <strong>{pbisReport.totals.totalPoints}</strong> points
                </div>
                <div>
                  <strong>{pbisReport.totals.count}</strong>{" "}
                  {pbisReport.totals.count === 1 ? "entry" : "entries"}
                </div>
                <div>
                  <strong>{pbisReport.totals.distinctStudents}</strong>{" "}
                  {pbisReport.totals.distinctStudents === 1
                    ? "student"
                    : "students"}
                </div>
                <div style={{ color: "var(--muted, #64748b)" }}>
                  {pbisReport.range.from} → {pbisReport.range.to} (
                  {pbisReport.range.days}d, {pbisReport.scope})
                </div>
                {pbisReport.totals.truncated && (
                  <div style={{ color: "crimson" }}>
                    Showing first 500 rows — narrow your filters.
                  </div>
                )}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                  marginBottom: "0.75rem",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                    By reason
                  </div>
                  {pbisReport.byReason.length === 0 ? (
                    <div style={{ fontSize: "0.85rem", color: "var(--muted, #64748b)" }}>
                      —
                    </div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                          <th style={{ padding: "0.25rem" }}>Reason</th>
                          <th style={{ padding: "0.25rem" }}>Pts</th>
                          <th style={{ padding: "0.25rem" }}>#</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pbisReport.byReason.map((r) => (
                          <tr key={r.reason} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "0.25rem" }}>{r.reason}</td>
                            <td style={{ padding: "0.25rem" }}>{r.points}</td>
                            <td style={{ padding: "0.25rem" }}>{r.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                    By teacher
                  </div>
                  {pbisReport.byTeacher.length === 0 ? (
                    <div style={{ fontSize: "0.85rem", color: "var(--muted, #64748b)" }}>
                      —
                    </div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                          <th style={{ padding: "0.25rem" }}>Teacher</th>
                          <th style={{ padding: "0.25rem" }}>Pts</th>
                          <th style={{ padding: "0.25rem" }}>#</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pbisReport.byTeacher.map((t) => (
                          <tr key={t.teacherName} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "0.25rem" }}>{t.teacherName}</td>
                            <td style={{ padding: "0.25rem" }}>{t.points}</td>
                            <td style={{ padding: "0.25rem" }}>{t.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                Entries
              </div>
              {pbisReport.rows.length === 0 ? (
                <div style={{ fontSize: "0.85rem", color: "var(--muted, #64748b)" }}>
                  No entries match these filters.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                      <th style={{ padding: "0.25rem" }}>When</th>
                      <th style={{ padding: "0.25rem" }}>Student</th>
                      <th style={{ padding: "0.25rem" }}>Reason</th>
                      <th style={{ padding: "0.25rem" }}>Pts</th>
                      <th style={{ padding: "0.25rem" }}>Teacher</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pbisReport.rows.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: "0.25rem" }}>
                          {new Date(r.createdAt).toLocaleString()}
                        </td>
                        <td style={{ padding: "0.25rem" }}>
                          {r.studentName}
                          <div style={{ fontSize: 11, color: "var(--text-subtle, #94a3b8)" }}>
                            {r.studentId}
                          </div>
                        </td>
                        <td style={{ padding: "0.25rem" }}>{r.reason}</td>
                        <td style={{ padding: "0.25rem" }}>{r.points}</td>
                        <td style={{ padding: "0.25rem" }}>{r.staffName || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      </>)}

      {activeSection === "requestPullout" && (
        <RequestPulloutSection
          students={students}
          isAdmin={Boolean(authUser?.isAdmin || authUser?.isSuperUser)}
          interventionTypes={interventionList}
          reasonOptions={pulloutReasonList}
        />
      )}

      {activeSection === "verifyPullouts" && canVerifyPullouts && (
        <VerifyPulloutsSection
          students={students}
          onChange={() => setPendingPulloutsTick((t) => t + 1)}
        />
      )}

      {activeSection === "issDashboard" && canViewIssDashboard && (
        <>
          <PulloutReportSection students={students} />
          <IssDashboardSection students={students} />
        </>
      )}

      {activeSection === "behaviorReview" && canReviewPullouts && (
        <BehaviorReviewSection
          students={students}
          onChange={() => setUnreviewedPulloutsTick((t) => t + 1)}
        />
      )}

      {activeSection === "behaviorSpecialist" && isBehaviorSpec && (() => {
        type HubKey =
          | "issDashboard"
          | "behaviorReview"
          | "interventions"
          | "hallPassMgmt"
          | "logIntervention"
          | "verifyPullouts";
        type HubTool = {
          key: HubKey;
          label: string;
          desc: string;
          color: string;
          show: boolean;
          badge?: number;
        };
        const tools: HubTool[] = [
          {
            key: "issDashboard",
            label: "ISS Dashboard",
            desc: "In-school suspension roster and pullout history.",
            color: "#0f766e",
            show: canViewIssDashboard,
          },
          {
            key: "behaviorReview",
            label: "Behavior Review",
            desc: "Review and close out unreviewed pullouts.",
            color: "#dc2626",
            show: canReviewPullouts,
            badge: unreviewedPulloutCount,
          },
          {
            key: "interventions",
            label: "Interventions",
            desc: "Manage intervention types and pullout reasons.",
            color: "#7c3aed",
            show: canManageBehaviorLists,
          },
          {
            key: "hallPassMgmt",
            label: "Hall Pass Management",
            desc: "Keep-Apart pairs and other hall-pass safeguards.",
            color: "#0d9488",
            show: canManageBehaviorLists,
          },
          {
            key: "logIntervention",
            label: "Log Intervention",
            desc: "Record an intervention you delivered.",
            color: "#0e7490",
            show: true,
          },
          {
            key: "verifyPullouts",
            label: "Verify Pullouts",
            desc: "Approve or reject pending pullout requests.",
            color: "#b45309",
            show: canVerifyPullouts,
            badge: pendingPulloutCount,
          },
        ];
        return (
          <>
            <div
              className="card no-print"
              style={{
                background:
                  "linear-gradient(135deg, #0f766e 0%, #0e7490 60%, #7c3aed 100%)",
                color: "white",
                padding: "1.25rem 1.5rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "1rem",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <h2 style={{ margin: 0, color: "white" }}>
                    Behavior Specialist
                  </h2>
                  <div style={{ opacity: 0.9, fontSize: "0.9rem", marginTop: 4 }}>
                    Your hub for intervention oversight, pullout review, and
                    classroom support tools.
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {tools
                    .filter((t) => t.show)
                    .map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setActiveSection(t.key)}
                        style={{
                          background: "rgba(255,255,255,0.15)",
                          border: "1px solid rgba(255,255,255,0.4)",
                          color: "white",
                          padding: "0.4rem 0.8rem",
                          borderRadius: 999,
                          fontSize: "0.85rem",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {t.label}
                        {t.badge && t.badge > 0 ? (
                          <span
                            style={{
                              background: "#dc2626",
                              color: "white",
                              borderRadius: 999,
                              padding: "0 6px",
                              fontSize: "0.75rem",
                              fontWeight: 700,
                            }}
                          >
                            {t.badge}
                          </span>
                        ) : null}
                      </button>
                    ))}
                </div>
              </div>
            </div>

            <div
              className="card no-print"
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(240px, 1fr))",
                gap: "0.75rem",
              }}
            >
              {tools
                .filter((t) => t.show)
                .map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setActiveSection(t.key)}
                    style={{
                      textAlign: "left",
                      background: "white",
                      border: `1px solid ${t.color}33`,
                      borderLeft: `4px solid ${t.color}`,
                      borderRadius: 8,
                      padding: "0.85rem 1rem",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ fontWeight: 600, color: t.color }}>
                        {t.label}
                      </span>
                      {t.badge && t.badge > 0 ? (
                        <span
                          style={{
                            background: "#dc2626",
                            color: "white",
                            borderRadius: 999,
                            padding: "0 7px",
                            fontSize: "0.75rem",
                            fontWeight: 700,
                          }}
                        >
                          {t.badge}
                        </span>
                      ) : null}
                    </div>
                    <span style={{ color: "#475569", fontSize: "0.85rem" }}>
                      {t.desc}
                    </span>
                  </button>
                ))}
            </div>
          </>
        );
      })()}

      {activeSection === "logIntervention" && (
        <section className="card">
          <h2>Log Intervention</h2>
          <p style={{ color: "var(--text-subtle, #64748b)", marginTop: 0 }}>
            Record a classroom intervention you tried with a student. Your
            behavior specialist will see school-wide history; everyone else
            sees only their own entries.
          </p>
          {intervListMsg && (
            <div
              style={{
                margin: "0.5rem 0 1rem",
                padding: "0.5rem 0.75rem",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                borderRadius: 6,
              }}
            >
              {intervListMsg}
            </div>
          )}
          {interventionList.filter((t) => t.active).length === 0 &&
            !intervListMsg && (
              <div
                style={{
                  margin: "0.5rem 0 1rem",
                  padding: "0.5rem 0.75rem",
                  background: "#fff7ed",
                  border: "1px solid #fed7aa",
                  color: "#9a3412",
                  borderRadius: 6,
                }}
              >
                No active intervention types are configured yet. Ask your
                behavior specialist to add some on the Interventions page.
              </div>
            )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitIntervention();
            }}
            style={{ marginBottom: "1rem" }}
          >
            <div style={{ marginBottom: "0.5rem" }}>
              <label>
                Student:{" "}
                <input
                  type="text"
                  placeholder="Search by name or ID"
                  value={logIntervStudentSearch}
                  onChange={(e) => {
                    setLogIntervStudentSearch(e.target.value);
                    setLogIntervStudentId("");
                  }}
                />
              </label>
              {logIntervStudentId ? (
                <div style={{ marginTop: "0.25rem" }}>
                  Selected: <strong>{logIntervStudentId}</strong>{" "}
                  {(() => {
                    const s = students.find(
                      (s) => s.studentId === logIntervStudentId,
                    );
                    return s ? `- ${s.firstName} ${s.lastName}` : "";
                  })()}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setLogIntervStudentId("");
                      setLogIntervStudentSearch("");
                    }}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                logIntervStudentSearch && (
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "0.25rem 0",
                      border: "1px solid #ccc",
                      maxWidth: "20rem",
                    }}
                  >
                    {(() => {
                      const filtered = students.filter((s) => {
                        const q = logIntervStudentSearch.toLowerCase();
                        return (
                          s.firstName.toLowerCase().includes(q) ||
                          s.lastName.toLowerCase().includes(q) ||
                          s.studentId.toLowerCase().includes(q)
                        );
                      });
                      const canSeeAll =
                        authUser?.isAdmin || authUser?.isSuperUser;
                      return (canSeeAll ? filtered : filtered.slice(0, 25));
                    })()
                      .map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            style={{
                              width: "100%",
                              textAlign: "left",
                              padding: "0.25rem 0.5rem",
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                            }}
                            onClick={() => {
                              setLogIntervStudentId(s.studentId);
                              setLogIntervStudentSearch(
                                `${s.studentId} - ${s.firstName} ${s.lastName}`,
                              );
                            }}
                          >
                            {s.studentId} - {s.firstName} {s.lastName}
                          </button>
                        </li>
                      ))}
                  </ul>
                )
              )}
            </div>
            <div style={{ marginBottom: "0.5rem" }}>
              <label>
                Intervention:{" "}
                <select
                  value={logIntervTypeId}
                  onChange={(e) =>
                    setLogIntervTypeId(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                >
                  <option value="">— pick one —</option>
                  {interventionList
                    .filter((t) => t.active)
                    .slice()
                    .sort(
                      (a, b) =>
                        a.category.localeCompare(b.category) ||
                        a.name.localeCompare(b.name),
                    )
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        [{t.category}] {t.name}
                        {t.requiresNote ? " (note required)" : ""}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {(() => {
              const picked =
                typeof logIntervTypeId === "number"
                  ? interventionList.find((t) => t.id === logIntervTypeId)
                  : null;
              const required = !!picked?.requiresNote;
              return (
                <div style={{ marginBottom: "0.5rem" }}>
                  <label style={{ display: "block" }}>
                    Note{required ? " (required)" : " (optional)"}:
                    <textarea
                      value={logIntervNote}
                      onChange={(e) => setLogIntervNote(e.target.value)}
                      rows={2}
                      style={{
                        display: "block",
                        width: "100%",
                        maxWidth: "32rem",
                        marginTop: "0.25rem",
                      }}
                      placeholder={
                        required
                          ? "Briefly describe what happened…"
                          : "Add context (optional)"
                      }
                    />
                  </label>
                </div>
              );
            })()}
            <button
              type="submit"
              disabled={
                logIntervBusy ||
                !logIntervStudentId ||
                typeof logIntervTypeId !== "number"
              }
            >
              {logIntervBusy ? "Saving…" : "Save intervention"}
            </button>
            {logIntervMsg && (
              <div
                style={{
                  marginTop: "0.5rem",
                  color:
                    logIntervMsg === "Saved." ? "#15803d" : "#b91c1c",
                }}
              >
                {logIntervMsg}
              </div>
            )}
          </form>

          <h3 style={{ marginTop: "1.25rem" }}>Recent interventions</h3>
          {interventionEntries.length === 0 ? (
            <p style={{ color: "var(--text-subtle, #64748b)" }}>
              No interventions logged yet.
            </p>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                  <th style={{ padding: "0.4rem 0.5rem" }}>When</th>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Student</th>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Intervention</th>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Note</th>
                  <th style={{ padding: "0.4rem 0.5rem" }}>Staff</th>
                </tr>
              </thead>
              <tbody>
                {interventionEntries.slice(0, 50).map((e) => {
                  const s = students.find((s) => s.studentId === e.studentId);
                  return (
                    <tr key={e.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        {new Date(e.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        {e.studentId}
                        {s ? ` — ${s.firstName} ${s.lastName}` : ""}
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        {e.interventionType}
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        {e.note || ""}
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem" }}>
                        {e.staffName}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeSection === "ese" && isEseCoord && (
        <section className="card">
          <h2>ESE Coordinator</h2>
          <div className="no-print" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              onClick={() => setEseTab("students")}
              disabled={eseTab === "students"}
              style={{ marginRight: "0.25rem" }}
            >
              Student Assignments
            </button>
            <button
              type="button"
              onClick={() => setEseTab("master")}
              disabled={eseTab === "master"}
            >
              Master Accommodations List
            </button>
          </div>

          {/* Note: nav buttons above are hidden in print via .no-print on parent */}
          {eseTab === "students" ? (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  marginBottom: "0.6rem",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontWeight: 600, marginRight: "0.25rem" }}>
                  Category:
                </span>
                {(["IEP", "504", "ELL"] as const).map((c) => {
                  const active = eseAssignCategory === c;
                  const colorBg =
                    c === "IEP" ? "#0e7490" : c === "504" ? "#7c3aed" : "#0891b2";
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setEseAssignCategory(c);
                        loadEseMatrix(c);
                      }}
                      style={{
                        background: active ? colorBg : "#fff",
                        color: active ? "#fff" : colorBg,
                        border: `1.5px solid ${colorBg}`,
                        padding: "0.35rem 0.95rem",
                        fontWeight: 600,
                        fontSize: "0.9rem",
                        borderRadius: 999,
                        cursor: "pointer",
                      }}
                    >
                      {c === "IEP" ? "ESE / IEP" : c}
                    </button>
                  );
                })}
                <span
                  style={{
                    marginLeft: "auto",
                    fontStyle: "italic",
                    color: "#64748b",
                    fontSize: "0.82rem",
                  }}
                >
                  Will sync from SIS once available.
                </span>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.6rem",
                  padding: "0.5rem 0.6rem",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                }}
              >
                <label style={{ fontWeight: 600 }}>
                  Add new {eseAssignCategory === "IEP" ? "ESE" : eseAssignCategory}{" "}
                  student:
                </label>
                <StudentCombobox
                  students={students.filter(
                    (s) =>
                      !eseMatrix?.students.some(
                        (m) => m.studentId === s.studentId,
                      ) &&
                      !(
                        eseExtraStudentIds[eseAssignCategory] || []
                      ).includes(s.studentId),
                  )}
                  isAdmin={Boolean(
                    authUser?.isAdmin || authUser?.isSuperUser,
                  )}
                  value=""
                  onChange={(sid) => {
                    if (!sid) return;
                    setEseExtraStudentIds((prev) => ({
                      ...prev,
                      [eseAssignCategory]: [
                        sid,
                        ...(prev[eseAssignCategory] || []),
                      ],
                    }));
                  }}
                  placeholder="Type name or ID then check accommodations…"
                  minWidth={320}
                />
              </div>

              {eseMatrixMsg && (
                <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
                  {eseMatrixMsg}
                </div>
              )}
              {eseMatrixLoading && !eseMatrix ? (
                <div>Loading…</div>
              ) : !eseMatrix ? (
                <div style={{ color: "#64748b" }}>
                  Pick a category to view assignments.
                </div>
              ) : eseMatrix.accommodations.length === 0 ? (
                <div style={{ color: "#64748b" }}>
                  No active master accommodations in this category. Add one in
                  the Master Accommodations List tab.
                </div>
              ) : (
                (() => {
                  const extras = (
                    eseExtraStudentIds[eseAssignCategory] || []
                  )
                    .map((sid) => {
                      const s = students.find((x) => x.studentId === sid);
                      if (!s) return null;
                      return {
                        studentId: s.studentId,
                        firstName: s.firstName,
                        lastName: s.lastName,
                        grade: s.grade,
                        assignments: {} as Record<number, number>,
                      };
                    })
                    .filter(
                      (
                        x,
                      ): x is {
                        studentId: string;
                        firstName: string;
                        lastName: string;
                        grade: number;
                        assignments: Record<number, number>;
                      } => x !== null,
                    );
                  const allRows = [...extras, ...eseMatrix.students].sort(
                    (a, b) => {
                      const ln = a.lastName.localeCompare(b.lastName);
                      return ln !== 0
                        ? ln
                        : a.firstName.localeCompare(b.firstName);
                    },
                  );
                  return (
                    <div style={{ overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: "0.88rem",
                        }}
                      >
                        <thead>
                          <tr style={{ background: "#f0f0f0" }}>
                            <th
                              style={{
                                textAlign: "left",
                                padding: "0.4rem",
                                position: "sticky",
                                left: 0,
                                background: "#f0f0f0",
                                minWidth: 200,
                              }}
                            >
                              Student
                            </th>
                            {eseMatrix.accommodations.map((a) => (
                              <th
                                key={a.id}
                                style={{
                                  textAlign: "center",
                                  padding: "0.4rem 0.3rem",
                                  fontWeight: 600,
                                  borderLeft: "1px solid #e2e8f0",
                                  minWidth: 90,
                                  verticalAlign: "bottom",
                                }}
                              >
                                <div
                                  style={{
                                    writingMode: "vertical-rl",
                                    transform: "rotate(180deg)",
                                    whiteSpace: "nowrap",
                                    margin: "0 auto",
                                  }}
                                >
                                  {a.name}
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {allRows.length === 0 ? (
                            <tr>
                              <td
                                colSpan={eseMatrix.accommodations.length + 1}
                                style={{
                                  padding: "0.6rem",
                                  color: "#64748b",
                                  fontStyle: "italic",
                                }}
                              >
                                No students yet. Use “Add new …” above to
                                start.
                              </td>
                            </tr>
                          ) : (
                            allRows.map((s, idx) => {
                              const isExtra = (
                                eseExtraStudentIds[eseAssignCategory] || []
                              ).includes(s.studentId);
                              const hasNoAssignments =
                                Object.keys(s.assignments).length === 0;
                              return (
                              <tr
                                key={s.studentId}
                                style={{
                                  borderBottom: "1px solid #eee",
                                  background:
                                    idx % 2 === 0 ? "#fff" : "#fafafa",
                                }}
                              >
                                <td
                                  style={{
                                    padding: "0.4rem",
                                    position: "sticky",
                                    left: 0,
                                    background:
                                      idx % 2 === 0 ? "#fff" : "#fafafa",
                                  }}
                                >
                                  <strong>
                                    {s.lastName}, {s.firstName}
                                  </strong>{" "}
                                  <span style={{ color: "#64748b" }}>
                                    · {s.studentId} · Gr {s.grade}
                                  </span>
                                  {isExtra && hasNoAssignments && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEseExtraStudentIds((prev) => ({
                                          ...prev,
                                          [eseAssignCategory]: (
                                            prev[eseAssignCategory] || []
                                          ).filter(
                                            (id) => id !== s.studentId,
                                          ),
                                        }))
                                      }
                                      title="Remove from view (no assignments to delete)"
                                      style={{
                                        marginLeft: "0.4rem",
                                        background: "transparent",
                                        border: "none",
                                        color: "#94a3b8",
                                        cursor: "pointer",
                                        fontSize: "1rem",
                                        padding: 0,
                                      }}
                                    >
                                      ×
                                    </button>
                                  )}
                                </td>
                                {eseMatrix.accommodations.map((a) => {
                                  const assigned = s.assignments[a.id];
                                  return (
                                    <td
                                      key={a.id}
                                      style={{
                                        textAlign: "center",
                                        padding: "0.3rem",
                                        borderLeft: "1px solid #e2e8f0",
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={!!assigned}
                                        onChange={() =>
                                          eseMatrixToggle(
                                            s.studentId,
                                            a.id,
                                            assigned,
                                          )
                                        }
                                        style={{
                                          width: 18,
                                          height: 18,
                                          cursor: "pointer",
                                          accentColor:
                                            eseAssignCategory === "IEP"
                                              ? "#0e7490"
                                              : eseAssignCategory === "504"
                                                ? "#7c3aed"
                                                : "#0891b2",
                                        }}
                                      />
                                    </td>
                                  );
                                })}
                              </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
              )}

              <details style={{ marginTop: "1rem" }}>
                <summary
                  style={{ cursor: "pointer", color: "#0e7490" }}
                >
                  Search a single student (legacy view)
                </summary>
                <div style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
                  <input
                    type="text"
                    placeholder="Search student by name or ID"
                    value={eseStudentSearch}
                    onChange={(e) => setEseStudentSearch(e.target.value)}
                    style={{ width: "20rem" }}
                  />
                </div>
              {eseStudentSearch && !eseStudentId && (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0.25rem 0",
                    border: "1px solid #ccc",
                    maxWidth: "30rem",
                    maxHeight: "12rem",
                    overflowY: "auto",
                  }}
                >
                  {(() => {
                    const filtered = students.filter((s) => {
                      const q = eseStudentSearch.toLowerCase();
                      return (
                        s.firstName.toLowerCase().includes(q) ||
                        s.lastName.toLowerCase().includes(q) ||
                        s.studentId.toLowerCase().includes(q)
                      );
                    });
                    const canSeeAll =
                      authUser?.isAdmin || authUser?.isSuperUser;
                    return (canSeeAll ? filtered : filtered.slice(0, 50));
                  })()
                    .map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "0.25rem 0.5rem",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            setEseStudentId(s.studentId);
                            setEseStudentSearch(
                              `${s.studentId} - ${s.firstName} ${s.lastName}`,
                            );
                            setEseAddSelected(new Set());
                            loadEseStudentAccs(s.studentId);
                          }}
                        >
                          {s.studentId} — {s.firstName} {s.lastName}
                        </button>
                      </li>
                    ))}
                </ul>
              )}
              {eseStudentId && (
                <div>
                  <div style={{ marginBottom: "0.5rem" }}>
                    Selected: <strong>{eseStudentSearch}</strong>{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setEseStudentId("");
                        setEseStudentSearch("");
                        setEseStudentAccs([]);
                        setEseAddSelected(new Set());
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "1rem",
                    }}
                  >
                    <div>
                      <h4 style={{ margin: "0 0 0.5rem" }}>
                        Current & Past Assignments
                      </h4>
                      {eseStudentAccs.length === 0 ? (
                        <div>None on file.</div>
                      ) : (
                        <ul
                          style={{
                            listStyle: "none",
                            padding: 0,
                            margin: 0,
                            border: "1px solid #ddd",
                            maxHeight: "20rem",
                            overflowY: "auto",
                          }}
                        >
                          {eseStudentAccs.map((a) => (
                            <li
                              key={a.id}
                              style={{
                                padding: "0.4rem 0.5rem",
                                borderBottom: "1px solid #eee",
                                background: a.removedAt ? "#f5f5f5" : "white",
                                color: a.removedAt ? "#888" : "inherit",
                              }}
                            >
                              <div>
                                <span
                                  style={{
                                    color: "#666",
                                    fontSize: "0.85em",
                                  }}
                                >
                                  [{a.category}]
                                </span>{" "}
                                <strong>{a.name}</strong>
                                {a.removedAt && (
                                  <span
                                    style={{
                                      marginLeft: "0.5rem",
                                      fontStyle: "italic",
                                    }}
                                  >
                                    (removed{" "}
                                    {new Date(
                                      a.removedAt,
                                    ).toLocaleDateString()}
                                    )
                                  </span>
                                )}
                              </div>
                              <div
                                style={{
                                  fontSize: "0.8em",
                                  color: "#777",
                                }}
                              >
                                Assigned{" "}
                                {new Date(a.assignedAt).toLocaleDateString()}
                              </div>
                              {!a.removedAt && (
                                <div style={{ marginTop: "0.25rem" }}>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      eseRemoveAssignment(a.id)
                                    }
                                  >
                                    Remove
                                  </button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h4 style={{ margin: "0 0 0.5rem" }}>
                        Add Accommodations
                      </h4>
                      <ul
                        style={{
                          listStyle: "none",
                          padding: 0,
                          margin: 0,
                          border: "1px solid #ddd",
                          maxHeight: "20rem",
                          overflowY: "auto",
                        }}
                      >
                        {schoolAccs
                          .filter((sa) => sa.active)
                          .filter(
                            (sa) =>
                              !eseStudentAccs.some(
                                (e) =>
                                  e.accommodationId === sa.id && !e.removedAt,
                              ),
                          )
                          .sort((a, b) =>
                            a.category === b.category
                              ? a.name.localeCompare(b.name)
                              : a.category.localeCompare(b.category),
                          )
                          .map((sa) => (
                            <li
                              key={sa.id}
                              style={{
                                padding: "0.25rem 0.5rem",
                                borderBottom: "1px solid #eee",
                              }}
                            >
                              <label>
                                <input
                                  type="checkbox"
                                  checked={eseAddSelected.has(sa.id)}
                                  onChange={(e) => {
                                    const next = new Set(eseAddSelected);
                                    if (e.target.checked) next.add(sa.id);
                                    else next.delete(sa.id);
                                    setEseAddSelected(next);
                                  }}
                                />{" "}
                                <span
                                  style={{
                                    color: "#666",
                                    fontSize: "0.85em",
                                  }}
                                >
                                  [{sa.category}]
                                </span>{" "}
                                {sa.name}
                              </label>
                            </li>
                          ))}
                      </ul>
                      <div style={{ marginTop: "0.5rem" }}>
                        <button
                          type="button"
                          onClick={eseAssignSelected}
                          disabled={eseAddSelected.size === 0}
                        >
                          Assign {eseAddSelected.size} accommodation
                          {eseAddSelected.size === 1 ? "" : "s"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              </details>
            </div>
          ) : (
            <div>
              <h3 style={{ marginTop: 0 }}>
                Master Accommodations
                <button
                  type="button"
                  className="no-print"
                  onClick={() => window.print()}
                  style={{ marginLeft: "0.75rem", fontSize: "0.85rem" }}
                >
                  Print
                </button>
              </h3>
              <div
                style={{
                  marginBottom: "0.75rem",
                  padding: "0.5rem",
                  border: "1px solid #ddd",
                }}
              >
                <strong>Add new:</strong>{" "}
                <input
                  type="text"
                  placeholder="Name"
                  value={eseNewName}
                  onChange={(e) => setEseNewName(e.target.value)}
                />{" "}
                <select
                  value={eseNewCategory}
                  onChange={(e) => setEseNewCategory(e.target.value)}
                >
                  <option value="IEP">IEP</option>
                  <option value="504">504</option>
                  <option value="ELL">ELL</option>
                  <option value="Strategy">Strategy</option>
                </select>{" "}
                <button
                  type="button"
                  onClick={eseAddNewMaster}
                  disabled={!eseNewName.trim()}
                >
                  Add
                </button>
              </div>
              <table
                style={{ width: "100%", borderCollapse: "collapse" }}
              >
                <thead>
                  <tr style={{ background: "#f0f0f0" }}>
                    <th style={{ textAlign: "left", padding: "0.4rem" }}>
                      Category
                    </th>
                    <th style={{ textAlign: "left", padding: "0.4rem" }}>
                      Name
                    </th>
                    <th style={{ textAlign: "left", padding: "0.4rem" }}>
                      Active
                    </th>
                    <th style={{ textAlign: "left", padding: "0.4rem" }}>
                      In Use
                    </th>
                    <th style={{ textAlign: "left", padding: "0.4rem" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {schoolAccs
                    .slice()
                    .sort((a, b) =>
                      a.category === b.category
                        ? a.name.localeCompare(b.name)
                        : a.category.localeCompare(b.category),
                    )
                    .map((a) => {
                      const editing = eseEditingId === a.id;
                      return (
                        <tr
                          key={a.id}
                          style={{ borderBottom: "1px solid #eee" }}
                        >
                          <td style={{ padding: "0.4rem" }}>
                            {editing ? (
                              <select
                                value={eseEditCategory}
                                onChange={(e) =>
                                  setEseEditCategory(e.target.value)
                                }
                              >
                                <option value="IEP">IEP</option>
                                <option value="504">504</option>
                                <option value="ELL">ELL</option>
                                <option value="Strategy">Strategy</option>
                              </select>
                            ) : (
                              a.category
                            )}
                          </td>
                          <td style={{ padding: "0.4rem" }}>
                            {editing ? (
                              <input
                                type="text"
                                value={eseEditName}
                                onChange={(e) =>
                                  setEseEditName(e.target.value)
                                }
                                style={{ width: "100%" }}
                              />
                            ) : (
                              a.name
                            )}
                          </td>
                          <td style={{ padding: "0.4rem" }}>
                            {a.active ? "Yes" : "No"}
                          </td>
                          <td style={{ padding: "0.4rem" }}>{a.inUseCount}</td>
                          <td
                            style={{
                              padding: "0.4rem",
                              display: "flex",
                              gap: "0.35rem",
                              flexWrap: "wrap",
                            }}
                          >
                            {editing ? (
                              <>
                                <button
                                  type="button"
                                  onClick={eseSaveEditMaster}
                                  disabled={!eseEditName.trim()}
                                  style={{
                                    background: "#0d9488",
                                    color: "#fff",
                                    border: "1px solid #0f766e",
                                    padding: "0.25rem 0.7rem",
                                    borderRadius: 4,
                                    cursor: eseEditName.trim()
                                      ? "pointer"
                                      : "not-allowed",
                                  }}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={eseCancelEditMaster}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => eseStartEditMaster(a)}
                                  title="Edit name and category"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    eseToggleMasterActive(a.id, !a.active)
                                  }
                                  title={
                                    a.active
                                      ? "Hide from teachers (keeps history)"
                                      : "Make available again"
                                  }
                                >
                                  {a.active ? "Deactivate" : "Activate"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => eseDeleteMaster(a)}
                                  style={{
                                    background: "#dc2626",
                                    color: "#fff",
                                    border: "1px solid #b91c1c",
                                    padding: "0.25rem 0.7rem",
                                    borderRadius: 4,
                                    cursor: "pointer",
                                  }}
                                  title={
                                    a.inUseCount > 0
                                      ? "In use — will offer to deactivate"
                                      : "Permanently delete"
                                  }
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeSection === "pbisLists" && isPbisCoord && (
        <section className="card">
          <h2>PBIS Reasons</h2>
          <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
            Manage the positive-behavior reasons teachers can pick when awarding
            PBIS points. Inactive reasons are hidden from teachers but kept for
            historical reports.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 6rem auto",
              gap: "0.5rem",
              alignItems: "end",
              marginBottom: "0.75rem",
              maxWidth: "48rem",
            }}
          >
            <label>
              <div style={{ fontSize: "0.85rem" }}>Name</div>
              <input
                type="text"
                value={newPbisReasonName}
                onChange={(e) => setNewPbisReasonName(e.target.value)}
                placeholder="e.g. Cleaned up workspace"
                style={{ width: "100%" }}
              />
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>Category</div>
              <input
                type="text"
                value={newPbisReasonCategory}
                onChange={(e) => setNewPbisReasonCategory(e.target.value)}
                placeholder="Character"
                style={{ width: "100%" }}
              />
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>Points</div>
              <input
                type="number"
                value={newPbisReasonPoints}
                onChange={(e) =>
                  setNewPbisReasonPoints(Number(e.target.value) || 0)
                }
                style={{ width: "100%" }}
              />
            </label>
            <button type="button" onClick={addPbisReason}>
              Add Reason
            </button>
          </div>
          {pbisListMsg && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
              {pbisListMsg}
            </div>
          )}

          {pbisReasonsList.length === 0 ? (
            <div style={{ color: "var(--muted, #666)" }}>No reasons yet.</div>
          ) : (
            <table
              style={{ width: "100%", borderCollapse: "collapse", maxWidth: "48rem" }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>Category</th>
                  <th style={{ padding: "0.4rem" }}>Reason</th>
                  <th style={{ padding: "0.4rem" }}>Points</th>
                  <th style={{ padding: "0.4rem" }}>Active</th>
                  <th style={{ padding: "0.4rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {pbisReasonsList
                  .slice()
                  .sort((a, b) =>
                    a.category === b.category
                      ? a.name.localeCompare(b.name)
                      : a.category.localeCompare(b.category),
                  )
                  .map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "0.4rem" }}>{r.category}</td>
                      <td style={{ padding: "0.4rem" }}>{r.name}</td>
                      <td style={{ padding: "0.4rem" }}>{r.defaultPoints}</td>
                      <td style={{ padding: "0.4rem" }}>
                        {r.active ? "Yes" : "No"}
                      </td>
                      <td style={{ padding: "0.4rem" }}>
                        <button
                          type="button"
                          onClick={() =>
                            togglePbisReasonActive(r.id, !r.active)
                          }
                        >
                          {r.active ? "Deactivate" : "Activate"}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeSection === "pbisLists" && isPbisCoord && (
        <section className="card" style={{ marginTop: "1rem" }}>
          <h2>Milestone Parent Emails</h2>
          <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
            When a student's <em>all-time, non-voided</em> PBIS total reaches a
            milestone for the first time, a positive note is automatically sent
            to the parent email on file. Each milestone fires at most once per
            student.
          </p>
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "end",
              marginBottom: "0.75rem",
              flexWrap: "wrap",
            }}
          >
            <label>
              <div style={{ fontSize: "0.85rem" }}>Points threshold</div>
              <input
                type="number"
                min={1}
                value={newMilestonePoints}
                onChange={(e) =>
                  setNewMilestonePoints(Number(e.target.value) || 0)
                }
                style={{ width: "8rem" }}
              />
            </label>
            <button type="button" onClick={addMilestone}>
              Add milestone
            </button>
          </div>
          {milestoneListMsg && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
              {milestoneListMsg}
            </div>
          )}
          {pbisMilestones.length === 0 ? (
            <div style={{ color: "var(--muted, #666)" }}>
              No milestones configured yet. (Suggestion: 25, 50, 100.)
            </div>
          ) : (
            <table style={{ borderCollapse: "collapse", maxWidth: "32rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>Points</th>
                  <th style={{ padding: "0.4rem" }}>Active</th>
                  <th style={{ padding: "0.4rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {pbisMilestones.map((m) => (
                  <tr key={m.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.4rem" }}>{m.points}</td>
                    <td style={{ padding: "0.4rem" }}>
                      {m.active ? "Yes" : "No"}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      <button type="button" onClick={() => toggleMilestone(m)}>
                        {m.active ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 style={{ marginTop: "1.25rem" }}>Recent milestone emails</h3>
          <button
            type="button"
            onClick={loadMilestoneEmails}
            style={{ marginBottom: "0.5rem" }}
          >
            Refresh
          </button>
          {milestoneEmailLog.length === 0 ? (
            <div style={{ color: "var(--muted, #666)" }}>None yet.</div>
          ) : (
            <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: "56rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>When</th>
                  <th style={{ padding: "0.4rem" }}>Student</th>
                  <th style={{ padding: "0.4rem" }}>Milestone</th>
                  <th style={{ padding: "0.4rem" }}>Status</th>
                  <th style={{ padding: "0.4rem" }}>To / note</th>
                </tr>
              </thead>
              <tbody>
                {milestoneEmailLog.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.4rem", whiteSpace: "nowrap" }}>
                      {new Date(r.sentAt).toLocaleString()}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {studentName(r.studentId) || r.studentId}{" "}
                      <span style={{ color: "var(--muted, #64748b)", fontSize: "0.8rem" }}>
                        {r.studentId}
                      </span>
                    </td>
                    <td style={{ padding: "0.4rem" }}>{r.milestonePoints} pts</td>
                    <td style={{ padding: "0.4rem" }}>{r.status}</td>
                    <td style={{ padding: "0.4rem" }}>
                      {r.emailTo ?? ""}
                      {r.errorMsg ? (
                        <div style={{ color: "#b91c1c", fontSize: "0.8rem" }}>
                          {r.errorMsg}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeSection === "interventions" && canManageBehaviorLists && (
        <section className="card">
          <h2>Classroom Interventions</h2>
          <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
            Manage the intervention types teachers can pick when logging a
            classroom intervention. Mark <em>requires note</em> if a written
            explanation should always accompany the entry.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto auto",
              gap: "0.5rem",
              alignItems: "end",
              marginBottom: "0.75rem",
              maxWidth: "48rem",
            }}
          >
            <label>
              <div style={{ fontSize: "0.85rem" }}>Name</div>
              <input
                type="text"
                value={newIntervName}
                onChange={(e) => setNewIntervName(e.target.value)}
                placeholder="e.g. Loud during instruction"
                style={{ width: "100%" }}
              />
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>Category</div>
              <input
                type="text"
                value={newIntervCategory}
                onChange={(e) => setNewIntervCategory(e.target.value)}
                placeholder="Classroom"
                style={{ width: "100%" }}
              />
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
            >
              <input
                type="checkbox"
                checked={newIntervRequiresNote}
                onChange={(e) => setNewIntervRequiresNote(e.target.checked)}
              />
              <span style={{ fontSize: "0.85rem" }}>Requires note</span>
            </label>
            <button type="button" onClick={addInterventionType}>
              Add Intervention
            </button>
          </div>
          {intervListMsg && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
              {intervListMsg}
            </div>
          )}

          {interventionList.length === 0 ? (
            <div style={{ color: "var(--muted, #666)" }}>
              No interventions yet.
            </div>
          ) : (
            <table
              style={{ width: "100%", borderCollapse: "collapse", maxWidth: "48rem" }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>Category</th>
                  <th style={{ padding: "0.4rem" }}>Intervention</th>
                  <th style={{ padding: "0.4rem" }}>Note req.</th>
                  <th style={{ padding: "0.4rem" }}>Active</th>
                  <th style={{ padding: "0.4rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {interventionList
                  .slice()
                  .sort((a, b) =>
                    a.category === b.category
                      ? a.name.localeCompare(b.name)
                      : a.category.localeCompare(b.category),
                  )
                  .map((i) => (
                    <tr key={i.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "0.4rem" }}>{i.category}</td>
                      <td style={{ padding: "0.4rem" }}>{i.name}</td>
                      <td style={{ padding: "0.4rem" }}>
                        {i.requiresNote ? "Yes" : "No"}
                      </td>
                      <td style={{ padding: "0.4rem" }}>
                        {i.active ? "Yes" : "No"}
                      </td>
                      <td style={{ padding: "0.4rem" }}>
                        <button
                          type="button"
                          onClick={() =>
                            toggleInterventionActive(i.id, !i.active)
                          }
                        >
                          {i.active ? "Deactivate" : "Activate"}
                        </button>{" "}
                        <button
                          type="button"
                          onClick={() => deleteInterventionType(i.id, i.name)}
                          style={{
                            color: "crimson",
                            borderColor: "crimson",
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeSection === "hallPassMgmt" && canManageBehaviorLists && (
        <section className="card">
          <h2>Global Daily Pass Limit</h2>
          <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
            School-wide cap on how many hall passes any one student can take
            in a single day. Leave blank to allow unlimited (per-student
            limits below still apply). Range: 1–100.
          </p>
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "end",
              flexWrap: "wrap",
            }}
          >
            <label>
              <div style={{ fontSize: "0.85rem" }}>Passes per day</div>
              <input
                type="number"
                min={1}
                max={100}
                value={hpGlobalLimitDraft}
                onChange={(e) => setHpGlobalLimitDraft(e.target.value)}
                placeholder="No cap"
                style={{ width: "8rem" }}
              />
            </label>
            <button type="button" onClick={saveGlobalHpLimit}>
              Save
            </button>
            {schoolSettings.globalDailyHallPassLimit != null && (
              <span style={{ color: "#0f766e", fontSize: "0.85rem" }}>
                Current cap: {schoolSettings.globalDailyHallPassLimit} per
                day
              </span>
            )}
            {hpGlobalLimitMsg && (
              <span
                style={{
                  color: hpGlobalLimitMsg === "Saved." ? "#0f766e" : "crimson",
                  fontSize: "0.85rem",
                }}
              >
                {hpGlobalLimitMsg}
              </span>
            )}
          </div>
        </section>
      )}

      {activeSection === "hallPassMgmt" && canManageBehaviorLists && (
        <hr
          style={{
            border: 0,
            borderTop: "2px dashed #cbd5e1",
            margin: "0.25rem 0 0.5rem",
          }}
        />
      )}

      {activeSection === "hallPassMgmt" && canManageBehaviorLists && (
        <section className="card">
          <h2>Per-Student Daily Pass Limits</h2>
          <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
            Cap a specific student's daily hall passes — typically at parental
            request. Once a student hits the cap, additional passes from
            teachers and kiosks will be blocked. Per-student limits override
            the global cap.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 8rem 1fr auto auto",
              gap: "0.5rem",
              alignItems: "end",
              marginBottom: "0.75rem",
              maxWidth: "70rem",
            }}
          >
            <label>
              <div style={{ fontSize: "0.85rem" }}>Student</div>
              <StudentCombobox
                students={students}
                value={hpLimitSelected}
                onChange={(id) => setHpLimitSelected(id)}
                placeholder="Type or pick a student"
                minWidth={240}
                isAdmin={Boolean(
                  authUser?.isAdmin || authUser?.isSuperUser,
                )}
              />
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>Passes per day</div>
              <input
                type="number"
                min={1}
                max={100}
                value={hpLimitValue}
                onChange={(e) => setHpLimitValue(Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>
                Note (who requested / why)
              </div>
              <input
                type="text"
                value={hpLimitNote}
                onChange={(e) => setHpLimitNote(e.target.value)}
                placeholder="e.g. Parent request 4/21 — Mrs. Lee"
                style={{ width: "100%" }}
              />
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                whiteSpace: "nowrap",
              }}
            >
              <input
                type="checkbox"
                checked={hpLimitParentOk}
                onChange={(e) => setHpLimitParentOk(e.target.checked)}
              />
              <span style={{ fontSize: "0.85rem" }}>Parent approved</span>
            </label>
            <button
              type="button"
              onClick={addHpLimit}
              disabled={!hpLimitParentOk}
              title={
                hpLimitParentOk
                  ? undefined
                  : "Confirm parent approval before saving."
              }
            >
              Save Limit
            </button>
          </div>
          {hpLimitMsg && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
              {hpLimitMsg}
            </div>
          )}

          {hpLimits.length === 0 ? (
            <div style={{ color: "var(--muted, #666)" }}>
              No per-student limits set.
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                maxWidth: "70rem",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>Student</th>
                  <th style={{ padding: "0.4rem" }}>Limit/day</th>
                  <th style={{ padding: "0.4rem" }}>Parent</th>
                  <th style={{ padding: "0.4rem" }}>Note</th>
                  <th style={{ padding: "0.4rem" }}>Set by</th>
                  <th style={{ padding: "0.4rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {hpLimits.map((l) => {
                  const name =
                    l.firstName && l.lastName
                      ? `${l.firstName} ${l.lastName} (${l.studentId})`
                      : l.studentId;
                  return (
                    <tr key={l.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "0.4rem" }}>{name}</td>
                      <td style={{ padding: "0.4rem" }}>{l.dailyLimit}</td>
                      <td style={{ padding: "0.4rem" }}>
                        {l.parentApproved ? (
                          <span style={{ color: "#0f766e", fontWeight: 600 }}>
                            ✓ Approved
                          </span>
                        ) : (
                          <span style={{ color: "#92400e" }}>Pending</span>
                        )}
                      </td>
                      <td style={{ padding: "0.4rem" }}>{l.note ?? ""}</td>
                      <td
                        style={{
                          padding: "0.4rem",
                          color: "var(--muted, #666)",
                          fontSize: "0.85rem",
                        }}
                      >
                        {l.createdByName ?? ""}
                        {l.createdAt
                          ? ` · ${new Date(l.createdAt).toLocaleDateString()}`
                          : ""}
                      </td>
                      <td style={{ padding: "0.4rem" }}>
                        <button
                          type="button"
                          onClick={() => removeHpLimit(l.id)}
                          style={{
                            color: "crimson",
                            borderColor: "crimson",
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeSection === "hallPassMgmt" && canManageBehaviorLists && (
        <hr
          style={{
            border: 0,
            borderTop: "2px dashed #cbd5e1",
            margin: "0.25rem 0 0.5rem",
          }}
        />
      )}

      {activeSection === "hallPassMgmt" && canManageBehaviorLists && (
        <section className="card">
          <h2>Keep-Apart Pairs</h2>
          <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
            Two students who must <strong>not</strong> both be out on a hall
            pass at the same time (e.g. recently in a fight, or otherwise need
            separation). When one student in a pair is on an active pass,
            attempts to issue a pass to the other student — from a teacher
            screen or a kiosk — will be blocked with an explanation.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr auto",
              gap: "0.5rem",
              alignItems: "end",
              marginBottom: "0.75rem",
              maxWidth: "60rem",
            }}
          >
            <PolarityStudentPicker
              label="Student A"
              students={students}
              search={polaritySearchA}
              setSearch={setPolaritySearchA}
              setSelected={setPolaritySelectedA}
              isAdmin={Boolean(authUser?.isAdmin || authUser?.isSuperUser)}
            />
            <PolarityStudentPicker
              label="Student B"
              students={students}
              search={polaritySearchB}
              setSearch={setPolaritySearchB}
              setSelected={setPolaritySelectedB}
              isAdmin={Boolean(authUser?.isAdmin || authUser?.isSuperUser)}
            />
            <label>
              <div style={{ fontSize: "0.85rem" }}>Note (optional)</div>
              <input
                type="text"
                value={polarityNote}
                onChange={(e) => setPolarityNote(e.target.value)}
                placeholder="Why are they paired?"
                style={{ width: "100%" }}
              />
            </label>
            <button type="button" onClick={addPolarityPair}>
              Add Pair
            </button>
          </div>
          {polarityMsg && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
              {polarityMsg}
            </div>
          )}

          {polarityPairs.length === 0 ? (
            <div style={{ color: "var(--muted, #666)" }}>
              No keep-apart pairs yet.
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                maxWidth: "60rem",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>Student A</th>
                  <th style={{ padding: "0.4rem" }}>Student B</th>
                  <th style={{ padding: "0.4rem" }}>Note</th>
                  <th style={{ padding: "0.4rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {polarityPairs.map((p) => {
                  const nameA =
                    p.studentAFirstName && p.studentALastName
                      ? `${p.studentAFirstName} ${p.studentALastName} (${p.studentIdA})`
                      : p.studentIdA;
                  const nameB =
                    p.studentBFirstName && p.studentBLastName
                      ? `${p.studentBFirstName} ${p.studentBLastName} (${p.studentIdB})`
                      : p.studentIdB;
                  return (
                    <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "0.4rem" }}>{nameA}</td>
                      <td style={{ padding: "0.4rem" }}>{nameB}</td>
                      <td style={{ padding: "0.4rem" }}>{p.note ?? ""}</td>
                      <td style={{ padding: "0.4rem" }}>
                        <button
                          type="button"
                          onClick={() => deletePolarityPair(p.id)}
                          style={{
                            color: "crimson",
                            borderColor: "crimson",
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeSection === "interventions" && canManageBehaviorLists && (
        <section className="card">
          <h2>Pullout Reasons</h2>
          <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
            Manage the quick-pick reasons teachers see when requesting a
            behavior-specialist pullout. Deactivate reasons to hide them from
            the form without losing past records.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto",
              gap: "0.5rem",
              alignItems: "end",
              marginBottom: "0.75rem",
              maxWidth: "48rem",
            }}
          >
            <label>
              <div style={{ fontSize: "0.85rem" }}>Name</div>
              <input
                type="text"
                value={newPulloutReasonName}
                onChange={(e) => setNewPulloutReasonName(e.target.value)}
                placeholder="e.g. Threats"
                style={{ width: "100%" }}
              />
            </label>
            <label>
              <div style={{ fontSize: "0.85rem" }}>Category</div>
              <input
                type="text"
                value={newPulloutReasonCategory}
                onChange={(e) => setNewPulloutReasonCategory(e.target.value)}
                placeholder="Behavior"
                style={{ width: "100%" }}
              />
            </label>
            <button type="button" onClick={addPulloutReason}>
              Add Reason
            </button>
          </div>
          {pulloutReasonMsg && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>
              {pulloutReasonMsg}
            </div>
          )}

          {pulloutReasonList.length === 0 ? (
            <div style={{ color: "var(--muted, #666)" }}>
              No reasons yet.
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                maxWidth: "48rem",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>Category</th>
                  <th style={{ padding: "0.4rem" }}>Reason</th>
                  <th style={{ padding: "0.4rem" }}>Active</th>
                  <th style={{ padding: "0.4rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {pulloutReasonList
                  .slice()
                  .sort((a, b) =>
                    a.category === b.category
                      ? a.name.localeCompare(b.name)
                      : a.category.localeCompare(b.category),
                  )
                  .map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "0.4rem" }}>{r.category}</td>
                      <td style={{ padding: "0.4rem" }}>{r.name}</td>
                      <td style={{ padding: "0.4rem" }}>
                        {r.active ? "Yes" : "No"}
                      </td>
                      <td
                        style={{
                          padding: "0.4rem",
                          display: "flex",
                          gap: "0.4rem",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            togglePulloutReasonActive(r.id, !r.active)
                          }
                        >
                          {r.active ? "Deactivate" : "Activate"}
                        </button>
                        <button
                          type="button"
                          onClick={() => deletePulloutReason(r.id, r.name)}
                          style={{
                            background: "#fee2e2",
                            color: "#991b1b",
                            border: "1px solid #fecaca",
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeSection === "staffRoles" && canManageStaffRoles && authUser && (
        <StaffRolesMatrix currentUser={authUser} />
      )}

      {activeSection === "settings" && isAdmin && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2>
            Admin Notifications
            {adminNotifications.length > 0 && (
              <span
                style={{
                  marginLeft: "0.5rem",
                  background: "#f59e0b",
                  color: "#1f2937",
                  borderRadius: "999px",
                  padding: "0.1rem 0.55rem",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  verticalAlign: "middle",
                }}
              >
                {adminNotifications.length}
              </span>
            )}
          </h2>
          {adminNotifications.length === 0 ? (
            <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
              No pending notifications.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {adminNotifications.map((n) => {
                const p = n.payload as Record<string, string>;
                let body: React.ReactNode;
                if (n.type === "kiosk_default_room_missing") {
                  body = (
                    <>
                      <strong>{p.staffDisplayName}</strong> activated a kiosk
                      in <strong>{p.chosenRoom}</strong> but has no default
                      room set in Staff Defaults. Update their default so they
                      don't have to pick on every activation.
                    </>
                  );
                } else {
                  body = (
                    <code style={{ fontSize: "0.85rem" }}>
                      {n.type}: {JSON.stringify(n.payload)}
                    </code>
                  );
                }
                return (
                  <li
                    key={n.id}
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "flex-start",
                      borderTop: "1px solid var(--border)",
                      padding: "0.75rem 0",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div>{body}</div>
                      <div
                        style={{
                          color: "var(--text-subtle)",
                          fontSize: "0.8rem",
                          marginTop: "0.25rem",
                        }}
                      >
                        {new Date(n.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => resolveAdminNotification(n.id)}
                    >
                      Mark resolved
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {activeSection === "settings" && isAdmin && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <h2 style={{ margin: 0 }}>
              Active Kiosks{" "}
              <span style={{ color: "var(--text-subtle)", fontWeight: 400 }}>
                ({activeKiosks.length})
              </span>
            </h2>
            <button type="button" onClick={loadActiveKiosks}>
              Refresh
            </button>
          </div>
          <p style={{ color: "var(--text-subtle)", marginTop: "0.5rem" }}>
            Devices currently in kiosk mode. Force-deactivating logs the
            device out immediately — students at that kiosk will see the
            activation screen on their next interaction.
          </p>
          {activeKiosks.length === 0 ? (
            <p style={{ color: "var(--text-subtle)" }}>
              No kiosks are currently active.
            </p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>
                    Room
                  </th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>
                    Activated by
                  </th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>
                    Started
                  </th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>
                    Expires
                  </th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>
                    Device
                  </th>
                  <th style={{ padding: "0.5rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {activeKiosks.map((k) => (
                  <tr
                    key={k.id}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {k.room}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {k.activatedByName ?? "—"}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {new Date(k.activatedAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      {new Date(k.expiresAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td
                      style={{
                        padding: "0.5rem",
                        color: "var(--text-subtle)",
                        fontSize: "0.85rem",
                      }}
                    >
                      {k.deviceLabel ?? "Unknown"}
                    </td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => forceDeactivateKiosk(k.id, k.room)}
                      >
                        Force deactivate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeSection === "settings" && isAdmin && (() => {
        const kioskUrl = `${window.location.origin}${import.meta.env.BASE_URL}kiosk`;
        return (
          <div className="card" style={{ marginBottom: "1rem" }}>
            <h2>Kiosk URL</h2>
            <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
              Open this on a classroom Chromebook (full-screen). The teacher
              in the room signs in once to activate the device — the room is
              picked up from their default location, or from a one-time
              picker if they don't have one set yet.
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <code
                style={{
                  fontSize: "0.9rem",
                  wordBreak: "break-all",
                  background: "var(--surface-subtle, rgba(0,0,0,0.04))",
                  padding: "0.5rem 0.75rem",
                  borderRadius: 6,
                  flex: "1 1 320px",
                }}
              >
                {kioskUrl}
              </code>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(kioskUrl);
                    setCopiedRoom("__kiosk__");
                    setTimeout(() => setCopiedRoom(null), 1500);
                  } catch {
                    setCopiedRoom(null);
                  }
                }}
              >
                {copiedRoom === "__kiosk__" ? "Copied!" : "Copy"}
              </button>
              <a href={kioskUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
          </div>
        );
      })()}

      {activeSection === "settings" && isAdmin && (
        <>
        <StaffRolesAdmin currentStaffId={authUser?.id ?? null} />
        <TeacherAllowlistAdmin
          staffUsers={staffUsers}
          allDestinations={(() => {
            const set = new Set<string>();
            for (const arr of Object.values(effectiveDestinationsByRoom)) {
              for (const d of arr) set.add(d);
            }
            return Array.from(set).sort((a, b) => a.localeCompare(b));
          })()}
          allowlistMap={teacherAllowlistMap}
          onChange={setTeacherAllowlistMap}
        />
        <StaffDefaultsAdmin
          originLocations={Object.keys(effectiveDestinationsByRoom).sort((a, b) =>
            a.localeCompare(b),
          )}
          onSaved={() => {
            fetch("/api/staff-defaults")
              .then((r) => r.json())
              .then((rows: Array<{ staffName: string; defaultLocationName: string | null }>) => {
                const map: Record<string, string> = {};
                for (const r of rows) {
                  if (r.defaultLocationName) map[r.staffName] = r.defaultLocationName;
                }
                setStaffDefaults(map);
              })
              .catch(() => {});
          }}
        />
        <div className="card" style={{ marginTop: "1rem" }}>
          <h2>School Settings</h2>
          <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
            These values appear in parent emails and other school-branded
            messages.
          </p>
          <div style={{ display: "grid", gap: "0.75rem", maxWidth: 520 }}>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span>School Name</span>
              <input
                type="text"
                value={schoolSettings.schoolName}
                onChange={(e) =>
                  setSchoolSettings({
                    ...schoolSettings,
                    schoolName: e.target.value,
                  })
                }
              />
            </label>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span>From Name (sender shown in parent inbox)</span>
              <input
                type="text"
                value={schoolSettings.fromName}
                onChange={(e) =>
                  setSchoolSettings({
                    ...schoolSettings,
                    fromName: e.target.value,
                  })
                }
              />
            </label>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span>
                Number of Periods in the School Day
                <span
                  style={{
                    color: "var(--text-subtle, #64748b)",
                    fontWeight: "normal",
                    marginLeft: "0.5rem",
                  }}
                >
                  (1–12; controls period dropdowns app-wide)
                </span>
              </span>
              <input
                type="number"
                min={1}
                max={12}
                step={1}
                value={schoolSettings.periodCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setSchoolSettings({
                    ...schoolSettings,
                    periodCount: Number.isFinite(n)
                      ? Math.max(1, Math.min(12, Math.trunc(n)))
                      : schoolSettings.periodCount,
                  });
                }}
                style={{ width: "6rem" }}
              />
            </label>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <span>
                Hall Pass Time Limit
                <span
                  style={{
                    color: "var(--text-subtle, #64748b)",
                    fontWeight: "normal",
                    marginLeft: "0.5rem",
                  }}
                >
                  (caps the slider in the Create Pass modal)
                </span>
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                }}
              >
                <input
                  type="range"
                  min={1}
                  max={240}
                  step={1}
                  value={schoolSettings.hallPassMaxMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const next = Number.isFinite(n)
                      ? Math.max(1, Math.min(240, Math.trunc(n)))
                      : schoolSettings.hallPassMaxMinutes;
                    setSchoolSettings({
                      ...schoolSettings,
                      hallPassMaxMinutes: next,
                      hallPassDefaultMinutes: Math.min(
                        schoolSettings.hallPassDefaultMinutes,
                        next,
                      ),
                    });
                  }}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  min={1}
                  max={240}
                  step={1}
                  value={schoolSettings.hallPassMaxMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const next = Number.isFinite(n)
                      ? Math.max(1, Math.min(240, Math.trunc(n)))
                      : schoolSettings.hallPassMaxMinutes;
                    setSchoolSettings({
                      ...schoolSettings,
                      hallPassMaxMinutes: next,
                      hallPassDefaultMinutes: Math.min(
                        schoolSettings.hallPassDefaultMinutes,
                        next,
                      ),
                    });
                  }}
                  style={{ width: "5rem" }}
                />
                <span style={{ color: "var(--text-subtle, #64748b)" }}>
                  min
                </span>
              </div>
              <span style={{ fontSize: "0.85rem" }}>
                Default starting value
                <span
                  style={{
                    color: "var(--text-subtle, #64748b)",
                    fontWeight: "normal",
                    marginLeft: "0.5rem",
                  }}
                >
                  (where the slider opens — must be ≤ time limit)
                </span>
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                }}
              >
                <input
                  type="range"
                  min={1}
                  max={schoolSettings.hallPassMaxMinutes}
                  step={1}
                  value={schoolSettings.hallPassDefaultMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setSchoolSettings({
                      ...schoolSettings,
                      hallPassDefaultMinutes: Number.isFinite(n)
                        ? Math.max(
                            1,
                            Math.min(
                              schoolSettings.hallPassMaxMinutes,
                              Math.trunc(n),
                            ),
                          )
                        : schoolSettings.hallPassDefaultMinutes,
                    });
                  }}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  min={1}
                  max={schoolSettings.hallPassMaxMinutes}
                  step={1}
                  value={schoolSettings.hallPassDefaultMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setSchoolSettings({
                      ...schoolSettings,
                      hallPassDefaultMinutes: Number.isFinite(n)
                        ? Math.max(
                            1,
                            Math.min(
                              schoolSettings.hallPassMaxMinutes,
                              Math.trunc(n),
                            ),
                          )
                        : schoolSettings.hallPassDefaultMinutes,
                    });
                  }}
                  style={{ width: "5rem" }}
                />
                <span style={{ color: "var(--text-subtle, #64748b)" }}>
                  min
                </span>
              </div>
            </div>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span>Email Signature</span>
              <textarea
                rows={4}
                value={schoolSettings.emailSignature}
                onChange={(e) =>
                  setSchoolSettings({
                    ...schoolSettings,
                    emailSignature: e.target.value,
                  })
                }
              />
            </label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <button
                type="button"
                onClick={saveSchoolSettings}
                disabled={settingsStatus === "saving"}
              >
                {settingsStatus === "saving" ? "Saving…" : "Save Settings"}
              </button>
              {settingsStatus === "saved" && (
                <span style={{ color: "var(--ok, #0a7a3b)" }}>Saved</span>
              )}
              {settingsStatus === "error" && (
                <span style={{ color: "var(--danger, #b00020)" }}>
                  {settingsError || "Save failed"}
                </span>
              )}
            </div>
          </div>
        </div>
        </>
      )}
      </main>
    </div>
  );
}

export default App;
