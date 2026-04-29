import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Login from "./Login";
import CreatePassModal from "./components/CreatePassModal";
import LogTardyModal from "./components/LogTardyModal";
import CheckInOutModal from "./components/CheckInOutModal";
import TrustedAdultInterventionsAdmin from "./components/TrustedAdultInterventionsAdmin";
import MtssPlansAdmin from "./components/MtssPlansAdmin";
import TeacherRosterPage from "./components/TeacherRosterPage";
import SignageLauncherView from "./components/SignageLauncherView";
import PbisHomePanel from "./components/PbisHomePanel";
import PbisNeedsAttention from "./components/PbisNeedsAttention";
import PbisPointsHub, {
  SchoolWidePbisAdminView,
  SchoolStoreView,
} from "./components/PbisPointsHub";
import TenancyPanel from "./components/TenancyPanel";
import ParentAccess from "./components/ParentAccess";
import HeartbeatSectionsAdmin from "./components/HeartbeatSectionsAdmin";
import TeacherAllowlistAdmin from "./components/TeacherAllowlistAdmin";
import StaffDefaultsAdmin from "./components/StaffDefaultsAdmin";
import LocationsAdmin from "./components/LocationsAdmin";
import StaffRolesMatrix from "./components/StaffRolesMatrix";
import BellScheduleSection from "./components/BellScheduleSection";
import Displays from "./components/Displays";
import DisplayShow, { HallPassDisplay } from "./components/DisplayShow";
import InsightsHub, { type InsightsTile } from "./components/InsightsHub";
import InsightsWatchlist from "./components/InsightsWatchlist";
import MyWatchList from "./components/MyWatchList";
import EngagementDashboard from "./components/EngagementDashboard";
import BehaviorDashboard from "./components/BehaviorDashboard";
import AcademicsDashboard from "./components/AcademicsDashboard";
import AcademicsTrajectory from "./components/AcademicsTrajectory";
import AttendanceDashboard from "./components/AttendanceDashboard";
import SebSelDashboard from "./components/SebSelDashboard";
import EquityDashboard from "./components/EquityDashboard";
import EarlyWarningDashboard from "./components/EarlyWarningDashboard";
import StudentProfile from "./components/StudentProfile";
import TrustedAdultsAdmin from "./components/TrustedAdultsAdmin";
import SettingsHub, {
  SettingsBackBar,
  type SettingsTile,
  type SettingsTileId,
} from "./components/SettingsHub";
import DataImports from "./components/DataImports";
import SchoolSwitcher from "./components/SchoolSwitcher";
import SchoolBrandingPanel from "./components/SchoolBrandingPanel";
import { useSchoolBranding } from "./lib/branding";
import { authFetch } from "./lib/authToken";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  Cell,
  Legend,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

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
  isTardyReturn?: boolean;
}

const teachers = ["Ms. Rivera", "Mr. Johnson", "Coach Lee"];


// (staffPeriods removed; replaced by mySections derived from /api/schedule)

interface Tardy {
  id: number;
  studentId: string;
  teacherName: string;
  period: string;
  reason: string;
  entryType: "tardy" | "checkin" | "checkout" | "intervention";
  checkInWith: string | null;
  notes: string;
  createdBy: string | null;
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
    authFetch(
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
      const r = await authFetch("/api/pullouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          reason: reason.trim(),
          period: null,
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
      <div className="section-header-bar-teal" />
      <div className="section-header-band-hub">
        <h2
          style={{
            margin: 0,
            color: "white",
            fontSize: "1.5rem",
            fontWeight: 700,
          }}
        >
          Request Pullout
        </h2>
      </div>
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
            list="request-pullout-student-options"
            placeholder="Type name or ID…"
            value={studentSearch}
            onChange={(e) => {
              const v = e.target.value;
              setStudentSearch(v);
              const match = sortedStudents.find(
                (s) =>
                  `${s.firstName} ${s.lastName} (${s.studentId})` === v ||
                  s.studentId === v.trim(),
              );
              setStudentId(match ? match.studentId : "");
            }}
          />
          <datalist id="request-pullout-student-options">
            {sortedStudents.map((s) => (
              <option
                key={s.id}
                value={`${s.firstName} ${s.lastName} (${s.studentId})`}
              />
            ))}
          </datalist>
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
      const r = await authFetch("/api/pullouts?scope=pending");
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
      const r = await authFetch(`/api/pullouts/${p.id}/verify`, {
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
      const r = await authFetch(`/api/pullouts/${p.id}/reject`, {
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
      <h2
        style={{
          margin: "0 0 0.5rem",
          fontSize: "1.5rem",
          fontWeight: 700,
          color: "#7c3aed",
        }}
      >
        Verify Pullouts
      </h2>
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

type IssRosterEntry = {
  id: number;
  studentId: string;
  source: "manual" | "pullout";
  pulloutId: number | null;
  period: number | null;
  notes: string | null;
  addedById: number | null;
  addedByName: string | null;
  createdAt: string;
};

type IssAttendanceRow = {
  id: number;
  studentId: string;
  day: string;
  source: "manual" | "pullout";
  pulloutId: number | null;
  dispatchedByName: string | null;
  verifiedByName: string | null;
  presentPeriods: number[];
  notes: string | null;
  addedByName: string | null;
};

type BellPeriod = {
  id: number;
  periodNumber: number;
  name: string;
  startTime: string;
  endTime: string;
};

type BellSchedule = {
  id: number;
  name: string;
  kind: string;
  isDefault: boolean;
  active: boolean;
  periods: BellPeriod[];
};

function IssDashboardSection({ students }: { students: Student[] }) {
  const [rows, setRows] = useState<PulloutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [roster, setRoster] = useState<IssRosterEntry[]>([]);
  const [rosterBusyId, setRosterBusyId] = useState<number | null>(null);
  const [confirmRosterDeleteId, setConfirmRosterDeleteId] = useState<
    number | null
  >(null);
  const [addStudentSearch, setAddStudentSearch] = useState("");
  const [addStudentId, setAddStudentId] = useState("");
  const [addPeriod, setAddPeriod] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [addingRoster, setAddingRoster] = useState(false);
  const [editingRosterId, setEditingRosterId] = useState<number | null>(null);
  const [editPeriod, setEditPeriod] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [attendance, setAttendance] = useState<IssAttendanceRow[]>([]);
  const [bellPeriods, setBellPeriods] = useState<BellPeriod[]>([]);
  const [attendanceBusyId, setAttendanceBusyId] = useState<number | null>(null);
  type IssView = "hub" | "onTheWay" | "arrived" | "roster" | "attendance";
  const [view, setView] = useState<IssView>("hub");

  const studentName = (id: string) => {
    const s = students.find((x) => x.studentId === id);
    return s ? `${s.firstName} ${s.lastName}` : `Student ${id}`;
  };

  const refresh = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const [pr, rr, ar, br] = await Promise.all([
        authFetch("/api/pullouts?scope=active"),
        authFetch("/api/iss-roster"),
        authFetch("/api/iss-attendance"),
        authFetch("/api/iss-attendance/today-periods"),
      ]);
      if (!pr.ok) {
        setMsg({ ok: false, text: "Could not load ISS dashboard." });
        setRows([]);
      } else {
        setRows(await pr.json());
      }
      if (rr.ok) setRoster(await rr.json());
      if (ar.ok) {
        const data = await ar.json();
        setAttendance(Array.isArray(data?.rows) ? data.rows : []);
      }
      if (br.ok) {
        const data = await br.json();
        const periods: BellPeriod[] = Array.isArray(data?.periods)
          ? data.periods
          : [];
        setBellPeriods(
          [...periods].sort((a, b) => a.periodNumber - b.periodNumber),
        );
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setLoading(false);
    }
  };

  const refreshRoster = async () => {
    try {
      const rr = await authFetch("/api/iss-roster");
      if (rr.ok) setRoster(await rr.json());
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      refresh();
    }, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const studentByStudentId = useMemo(() => {
    const m = new Map<string, Student>();
    for (const s of students) m.set(s.studentId, s);
    return m;
  }, [students]);

  const sortedStudents = useMemo(() => {
    const q = addStudentSearch.trim().toLowerCase();
    const list = q
      ? students.filter(
          (s) =>
            s.firstName.toLowerCase().includes(q) ||
            s.lastName.toLowerCase().includes(q) ||
            s.studentId.toLowerCase().includes(q),
        )
      : students;
    return list.slice(0, 50);
  }, [students, addStudentSearch]);

  const sortedRoster = useMemo(() => {
    return [...roster].sort((a, b) => {
      const sa = studentByStudentId.get(a.studentId);
      const sb = studentByStudentId.get(b.studentId);
      const la = (sa?.lastName ?? "").toLowerCase();
      const lb = (sb?.lastName ?? "").toLowerCase();
      if (la !== lb) return la.localeCompare(lb);
      const fa = (sa?.firstName ?? "").toLowerCase();
      const fb = (sb?.firstName ?? "").toLowerCase();
      return fa.localeCompare(fb);
    });
  }, [roster, studentByStudentId]);

  const addToRoster = async () => {
    if (!addStudentId.trim()) {
      setMsg({ ok: false, text: "Pick a student to add." });
      return;
    }
    setAddingRoster(true);
    setMsg(null);
    try {
      const r = await authFetch("/api/iss-roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: addStudentId.trim(),
          period: addPeriod ? Number(addPeriod) : null,
          notes: addNotes.trim() || null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || "Could not add to roster." });
      } else {
        setAddStudentId("");
        setAddStudentSearch("");
        setAddPeriod("");
        setAddNotes("");
        await refreshRoster();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setAddingRoster(false);
    }
  };

  const beginEditRoster = (entry: IssRosterEntry) => {
    setEditingRosterId(entry.id);
    setEditPeriod(entry.period == null ? "" : String(entry.period));
    setEditNotes(entry.notes ?? "");
  };

  const saveEditRoster = async (id: number) => {
    setRosterBusyId(id);
    setMsg(null);
    try {
      const r = await authFetch(`/api/iss-roster/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: editPeriod ? Number(editPeriod) : null,
          notes: editNotes.trim() || null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || "Could not save." });
      } else {
        setEditingRosterId(null);
        await refreshRoster();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setRosterBusyId(null);
    }
  };

  const deleteRosterEntry = async (id: number) => {
    setRosterBusyId(id);
    setMsg(null);
    try {
      const r = await authFetch(`/api/iss-roster/${id}`, { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || "Could not remove." });
      } else {
        // Parent email status is intentionally not surfaced; failures are
        // logged on the server and will be addressed later.
        setMsg({ ok: true, text: "Removed from roster." });
        setConfirmRosterDeleteId(null);
        await refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setRosterBusyId(null);
    }
  };

  const act = async (
    p: PulloutRow,
    action: "arrived" | "returned" | "closed",
  ) => {
    setBusyId(p.id);
    setMsg(null);
    try {
      const r = await authFetch(`/api/pullouts/${p.id}/${action}`, {
        method: "PATCH",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: data?.error || `Could not ${action}.` });
      } else if (action === "arrived") {
        // Email status intentionally suppressed; failures logged server-side.
        setMsg({ ok: true, text: "Marked arrived." });
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
      {p.status === "arrived" && (
        <div
          style={{ marginTop: 4, fontSize: "0.85rem", color: "#475569" }}
        >
          Arrived {new Date(p.arrivedAt!).toLocaleTimeString()}
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
        className="section-header-bar-teal"
        style={{ width: "100%", margin: 0 }}
      />
      <div
        className="section-header-band-hub"
        style={{ width: "100%", margin: 0 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
          }}
        >
          <h2 style={{ margin: 0, color: "#ffffff", fontWeight: 700 }}>
            ISS Dashboard
          </h2>
          <button
            type="button"
            onClick={refresh}
            style={{
              background: "rgba(255,255,255,0.85)",
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
      </div>
      <p style={{ color: "var(--text-subtle, #64748b)", marginTop: "0.75rem" }}>
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
          {view === "hub" && (() => {
            type IssTile = {
              key: Exclude<IssView, "hub">;
              label: string;
              desc: string;
              count: number;
              color: string;
              emoji: string;
            };
            const tiles: IssTile[] = [
              {
                key: "attendance",
                label: "Today's ISS Attendance",
                desc: "Mark which periods each student was present.",
                count: attendance.length,
                color: "#0d9488",
                emoji: "🗓️",
              },
              {
                key: "onTheWay",
                label: "On the way",
                desc: "Verified pullouts en route to ISS.",
                count: onTheWay.length,
                color: "#0e7490",
                emoji: "🚶",
              },
              {
                key: "arrived",
                label: "Arrived",
                desc: "Students currently in the room.",
                count: arrived.length,
                color: "#16a34a",
                emoji: "✅",
              },
              {
                key: "roster",
                label: "ISS Daily Roster",
                desc: "All students assigned to ISS today.",
                count: sortedRoster.length,
                color: "#7c3aed",
                emoji: "📋",
              },
            ];
            return (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(240px, 1fr))",
                  gap: "0.85rem",
                  marginTop: "1rem",
                }}
              >
                {tiles.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setView(t.key)}
                    style={{
                      textAlign: "left",
                      background: "white",
                      border: `1px solid ${t.color}33`,
                      borderLeft: `4px solid ${t.color}`,
                      borderRadius: 10,
                      padding: "1rem 1.1rem",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      boxShadow: "0 1px 2px rgba(15,23,42,0.06)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 700,
                          color: t.color,
                          fontSize: "1rem",
                        }}
                      >
                        {t.label}
                      </span>
                      <span style={{ fontSize: "1.4rem" }} aria-hidden>
                        {t.emoji}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: "1.75rem",
                        fontWeight: 800,
                        color: "#1e293b",
                        lineHeight: 1,
                      }}
                    >
                      {t.count}
                    </div>
                    <span
                      style={{ color: "#475569", fontSize: "0.85rem" }}
                    >
                      {t.desc}
                    </span>
                  </button>
                ))}
              </div>
            );
          })()}
          {view !== "hub" && (
            <button
              type="button"
              onClick={() => setView("hub")}
              className="back-button-purple"
              style={{ marginTop: "1rem", marginBottom: 0 }}
            >
              ← Back to ISS Hub
            </button>
          )}
          {view === "onTheWay" && (
          <>
          <h3
            style={{
              marginTop: "1.25rem",
              marginBottom: "0.6rem",
              padding: "0.6rem 0.95rem",
              background:
                "var(--brand-header-bg)",
              color: "#ffffff",
              fontSize: "1.05rem",
              fontWeight: 700,
              borderRadius: 6,
              boxShadow: "0 1px 2px rgba(15,23,42,0.12)",
            }}
          >
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
          </>
          )}
          {view === "roster" && (
          <>
          <h3
            style={{
              marginTop: "1.75rem",
              marginBottom: "0.6rem",
              padding: "0.6rem 0.95rem",
              background:
                "var(--brand-header-bg)",
              color: "#ffffff",
              fontSize: "1.05rem",
              fontWeight: 700,
              borderRadius: 6,
              boxShadow: "0 1px 2px rgba(15,23,42,0.12)",
            }}
          >
            ISS Daily Roster ({sortedRoster.length})
          </h3>
          <div
            style={{
              border: "1px solid var(--border, #e2e8f0)",
              borderRadius: 8,
              padding: "0.75rem 0.9rem",
              marginBottom: "0.75rem",
              background: "var(--surface, #f8fafc)",
              display: "grid",
              gap: "0.5rem",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
              Add student to roster
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(200px, 2fr) 110px 1fr auto",
                gap: "0.5rem",
                alignItems: "end",
              }}
            >
              <label style={{ display: "grid", gap: 2 }}>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Student
                </span>
                <input
                  type="text"
                  list="iss-roster-add-student-options"
                  placeholder="Type name or ID…"
                  value={addStudentSearch}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAddStudentSearch(v);
                    const m = sortedStudents.find(
                      (s) =>
                        `${s.firstName} ${s.lastName} (${s.studentId})` ===
                          v || s.studentId === v.trim(),
                    );
                    setAddStudentId(m ? m.studentId : "");
                  }}
                />
                <datalist id="iss-roster-add-student-options">
                  {sortedStudents.map((s) => (
                    <option
                      key={s.id}
                      value={`${s.firstName} ${s.lastName} (${s.studentId})`}
                    />
                  ))}
                </datalist>
              </label>
              <label style={{ display: "grid", gap: 2 }}>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Period
                </span>
                <select
                  value={addPeriod}
                  onChange={(e) => setAddPeriod(e.target.value)}
                >
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "grid", gap: 2 }}>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Notes (optional)
                </span>
                <input
                  type="text"
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  placeholder="e.g. half-day"
                />
              </label>
              <button
                type="button"
                className="btn-primary"
                disabled={addingRoster || !addStudentId}
                onClick={addToRoster}
              >
                {addingRoster ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
          {sortedRoster.length === 0 ? (
            <div style={{ color: "var(--text-subtle, #64748b)" }}>
              Roster is empty.
            </div>
          ) : (
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {sortedRoster.map((entry) => {
                const accent =
                  entry.source === "manual" ? "#22c55e" : "#7c3aed";
                const accentBg =
                  entry.source === "manual" ? "#f0fdf4" : "#f5f3ff";
                const isEditing = editingRosterId === entry.id;
                const isConfirming = confirmRosterDeleteId === entry.id;
                return (
                  <div
                    key={entry.id}
                    style={{
                      border: `1px solid ${accent}`,
                      borderLeft: `5px solid ${accent}`,
                      borderRadius: 8,
                      padding: "0.6rem 0.85rem",
                      background: accentBg,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <strong>{studentName(entry.studentId)}</strong>{" "}
                        <span style={{ color: "#64748b" }}>
                          (#{entry.studentId})
                        </span>
                        {entry.period != null && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: "0.85rem",
                              color: "#475569",
                            }}
                          >
                            · period {entry.period}
                          </span>
                        )}
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: "0.72rem",
                            background: accent,
                            color: "white",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontWeight: 600,
                          }}
                        >
                          {entry.source === "manual" ? "Manual" : "Pullout"}
                        </span>
                      </div>
                      {!isEditing && !isConfirming && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            disabled={rosterBusyId === entry.id}
                            onClick={() => beginEditRoster(entry)}
                            style={{
                              background: "transparent",
                              border: "1px solid #cbd5e1",
                              borderRadius: 6,
                              padding: "0.3rem 0.65rem",
                              cursor: "pointer",
                              font: "inherit",
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={rosterBusyId === entry.id}
                            onClick={() => setConfirmRosterDeleteId(entry.id)}
                            style={{
                              background: "#fee2e2",
                              color: "#b91c1c",
                              border: "1px solid #fecaca",
                              borderRadius: 6,
                              padding: "0.3rem 0.65rem",
                              cursor: "pointer",
                              font: "inherit",
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                      {isConfirming && (
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "0.85rem",
                              color: "#b91c1c",
                              fontWeight: 600,
                            }}
                          >
                            {entry.source === "pullout"
                              ? "Mark returned & remove?"
                              : "Remove?"}
                          </span>
                          <button
                            type="button"
                            disabled={rosterBusyId === entry.id}
                            onClick={() => deleteRosterEntry(entry.id)}
                            style={{
                              background: "#dc2626",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "0.3rem 0.65rem",
                              cursor: "pointer",
                              font: "inherit",
                              fontWeight: 600,
                            }}
                          >
                            {rosterBusyId === entry.id
                              ? "…"
                              : entry.source === "pullout"
                                ? "Yes, return"
                                : "Yes, remove"}
                          </button>
                          <button
                            type="button"
                            disabled={rosterBusyId === entry.id}
                            onClick={() => setConfirmRosterDeleteId(null)}
                            style={{
                              background: "transparent",
                              border: "1px solid #cbd5e1",
                              borderRadius: 6,
                              padding: "0.3rem 0.65rem",
                              cursor: "pointer",
                              font: "inherit",
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                    {entry.notes && !isEditing && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: "0.88rem",
                          color: "#475569",
                        }}
                      >
                        {entry.notes}
                      </div>
                    )}
                    {isEditing && (
                      <div
                        style={{
                          marginTop: 8,
                          display: "grid",
                          gridTemplateColumns: "110px 1fr auto auto",
                          gap: 8,
                          alignItems: "end",
                        }}
                      >
                        <label style={{ display: "grid", gap: 2 }}>
                          <span
                            style={{ fontSize: "0.8rem", color: "#64748b" }}
                          >
                            Period
                          </span>
                          <select
                            value={editPeriod}
                            onChange={(e) => setEditPeriod(e.target.value)}
                          >
                            <option value="">—</option>
                            {[1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ display: "grid", gap: 2 }}>
                          <span
                            style={{ fontSize: "0.8rem", color: "#64748b" }}
                          >
                            Notes
                          </span>
                          <input
                            type="text"
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={rosterBusyId === entry.id}
                          onClick={() => saveEditRoster(entry.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          disabled={rosterBusyId === entry.id}
                          onClick={() => setEditingRosterId(null)}
                          style={{
                            background: "transparent",
                            border: "1px solid #cbd5e1",
                            borderRadius: 6,
                            padding: "0.35rem 0.75rem",
                            cursor: "pointer",
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          </>
          )}
          {view === "arrived" && (
          <>
          <h3
            style={{
              marginTop: "1.75rem",
              marginBottom: "0.6rem",
              padding: "0.6rem 0.95rem",
              background:
                "var(--brand-header-bg)",
              color: "#ffffff",
              fontSize: "1.05rem",
              fontWeight: 700,
              borderRadius: 6,
              boxShadow: "0 1px 2px rgba(15,23,42,0.12)",
            }}
          >
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
          {view === "attendance" && (() => {
            const sortedAttendance = [...attendance].sort((a, b) => {
              const sa = studentByStudentId.get(a.studentId);
              const sb = studentByStudentId.get(b.studentId);
              const la = (sa?.lastName ?? "").toLowerCase();
              const lb = (sb?.lastName ?? "").toLowerCase();
              if (la !== lb) return la.localeCompare(lb);
              const fa = (sa?.firstName ?? "").toLowerCase();
              const fb = (sb?.firstName ?? "").toLowerCase();
              return fa.localeCompare(fb);
            });
            const periods =
              bellPeriods.length > 0
                ? bellPeriods
                : [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
                    id: -n,
                    periodNumber: n,
                    name: `P${n}`,
                    startTime: "",
                    endTime: "",
                  }));
            const togglePeriod = async (
              row: IssAttendanceRow,
              periodNumber: number,
            ) => {
              const current = new Set(row.presentPeriods ?? []);
              if (current.has(periodNumber)) current.delete(periodNumber);
              else current.add(periodNumber);
              const next = Array.from(current).sort((a, b) => a - b);
              setAttendance((prev) =>
                prev.map((r) =>
                  r.id === row.id ? { ...r, presentPeriods: next } : r,
                ),
              );
              setAttendanceBusyId(row.id);
              const recover = async () => {
                try {
                  const ar = await authFetch("/api/iss-attendance");
                  if (ar.ok) {
                    const data = await ar.json();
                    setAttendance(
                      Array.isArray(data?.rows) ? data.rows : [],
                    );
                  }
                } catch {
                  // ignore
                }
              };
              try {
                const r = await authFetch(`/api/iss-attendance/${row.id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ presentPeriods: next }),
                });
                if (!r.ok) {
                  setMsg({ ok: false, text: "Could not save attendance." });
                  await recover();
                }
              } catch {
                setMsg({ ok: false, text: "Network error saving attendance." });
                await recover();
              } finally {
                setAttendanceBusyId(null);
              }
            };
            return (
              <>
                <h3
                  style={{
                    marginTop: "1.75rem",
                    marginBottom: "0.6rem",
                    padding: "0.6rem 0.95rem",
                    background:
                      "var(--brand-header-bg)",
                    color: "#ffffff",
                    fontSize: "1.05rem",
                    fontWeight: 700,
                    borderRadius: 6,
                    boxShadow: "0 1px 2px rgba(15,23,42,0.12)",
                  }}
                >
                  Today's ISS Attendance ({sortedAttendance.length})
                </h3>
                <div
                  style={{
                    fontSize: "0.85rem",
                    color: "#64748b",
                    marginBottom: "0.5rem",
                  }}
                >
                  Check off each period the student was actually present in
                  ISS. Includes everyone on today's roster, even after they
                  returned.
                </div>
                {sortedAttendance.length === 0 ? (
                  <div style={{ color: "var(--text-subtle, #64748b)" }}>
                    No ISS attendance recorded today yet.
                  </div>
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
                        <tr
                          style={{
                            background: "#f1f5f9",
                            textAlign: "left",
                          }}
                        >
                          <th
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #cbd5e1",
                            }}
                          >
                            Student
                          </th>
                          <th
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #cbd5e1",
                            }}
                          >
                            ID
                          </th>
                          {periods.map((p) => (
                            <th
                              key={p.periodNumber}
                              style={{
                                padding: "0.5rem 0.4rem",
                                borderBottom: "1px solid #cbd5e1",
                                textAlign: "center",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                p.startTime && p.endTime
                                  ? `${p.startTime}–${p.endTime}`
                                  : undefined
                              }
                            >
                              {p.name || `P${p.periodNumber}`}
                            </th>
                          ))}
                          <th
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #cbd5e1",
                            }}
                          >
                            Source
                          </th>
                          <th
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #cbd5e1",
                            }}
                          >
                            From
                          </th>
                          <th
                            style={{
                              padding: "0.5rem 0.6rem",
                              borderBottom: "1px solid #cbd5e1",
                            }}
                          >
                            Verified by
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedAttendance.map((row) => {
                          const accent =
                            row.source === "manual" ? "#22c55e" : "#7c3aed";
                          const present = new Set(row.presentPeriods ?? []);
                          return (
                            <tr
                              key={row.id}
                              style={{ borderBottom: "1px solid #e2e8f0" }}
                            >
                              <td
                                style={{
                                  padding: "0.45rem 0.6rem",
                                  borderLeft: `4px solid ${accent}`,
                                }}
                              >
                                <strong>{studentName(row.studentId)}</strong>
                              </td>
                              <td
                                style={{
                                  padding: "0.45rem 0.6rem",
                                  color: "#475569",
                                }}
                              >
                                {row.studentId}
                              </td>
                              {periods.map((p) => (
                                <td
                                  key={p.periodNumber}
                                  style={{
                                    padding: "0.45rem 0.4rem",
                                    textAlign: "center",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={present.has(p.periodNumber)}
                                    disabled={attendanceBusyId === row.id}
                                    onChange={() =>
                                      togglePeriod(row, p.periodNumber)
                                    }
                                    aria-label={`${studentName(row.studentId)} period ${p.periodNumber}`}
                                  />
                                </td>
                              ))}
                              <td
                                style={{
                                  padding: "0.45rem 0.6rem",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: "0.72rem",
                                    background: accent,
                                    color: "white",
                                    padding: "2px 8px",
                                    borderRadius: 999,
                                    fontWeight: 600,
                                  }}
                                >
                                  {row.source === "manual"
                                    ? "Manual (ODR)"
                                    : "Pullout"}
                                </span>
                              </td>
                              <td
                                style={{
                                  padding: "0.45rem 0.6rem",
                                  color: "#475569",
                                }}
                              >
                                {row.source === "pullout"
                                  ? row.dispatchedByName || "—"
                                  : row.addedByName || "—"}
                              </td>
                              <td
                                style={{
                                  padding: "0.45rem 0.6rem",
                                  color: "#475569",
                                }}
                              >
                                {row.source === "pullout"
                                  ? row.verifiedByName || "—"
                                  : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}
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
      const r = await authFetch("/api/pullouts?scope=unreviewed");
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
      const r = await authFetch(`/api/pullouts/${p.id}/review`, {
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
      <h2
        style={{
          margin: "0 0 0.5rem",
          fontSize: "1.5rem",
          fontWeight: 700,
          color: "#7c3aed",
        }}
      >
        Behavior Review
      </h2>
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
        const r = await authFetch(
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
        const r = await authFetch(`/api/pullouts/report?days=${days}`);
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
      <h4
        style={{
          margin: "0.25rem 0",
          fontSize: "1.5rem",
          fontWeight: 700,
          color: "#7c3aed",
        }}
      >
        {title}
      </h4>
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
      <h3
        style={{
          marginTop: 0,
          fontSize: "1.5rem",
          fontWeight: 700,
          color: "#7c3aed",
        }}
      >
        Pullout Report
      </h3>
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

// Phase 1E placeholder copy for the SuperUser Home + District Overview
// landing pages. Each card maps to a future capability scheduled in the
// 5-phase roadmap on the canvas; the `phase` chip lets the viewer see the
// release order at a glance. Lives at module scope so the JSX render
// branches stay tidy and so we can extend or reorder without touching
// the App component body.
type LandingCard = { title: string; body: string; phase: string };

const SUPER_USER_HOME_CARDS: LandingCard[] = [
  {
    title: "District Switcher",
    body: "Hop between every district you administer. Today: switch school within district from Settings → Tenancy.",
    phase: "Phase 5",
  },
  {
    title: "Cross-District Reports",
    body: "Roll up Insights, PBIS, and intervention metrics across every district you operate.",
    phase: "Phase 5",
  },
  {
    title: "Onboard a District",
    body: "Stand up a new district + first school + first SuperUser without a SQL session.",
    phase: "Phase 3",
  },
  {
    title: "Global Feature Flags",
    body: "Flip a feature on for one district, a school, or the whole platform.",
    phase: "Phase 5",
  },
  {
    title: "Audit & Health",
    body: "See login activity, error rates, and tenant health for every district.",
    phase: "Phase 4",
  },
];

const DISTRICT_ADMIN_CARDS: LandingCard[] = [
  {
    title: "District Roster Import",
    body: "Upload one CSV with school_code per row; we route students to the right schools.",
    phase: "Phase 3",
  },
  {
    title: "District Assessments Import",
    body: "Push iReady, FAST, or your district benchmark data to every school in one import.",
    phase: "Phase 3",
  },
  {
    title: "District Insights Dashboards",
    body: "Academics, Attendance, Behavior, SEB, Engagement, and Equity rolled up across schools.",
    phase: "Phase 4",
  },
  {
    title: "Early Warning Rules",
    body: "Configure at-risk thresholds once for the district; schools see the flagged students.",
    phase: "Phase 4",
  },
  {
    title: "Intervention Effectiveness",
    body: "Compare intervention outcomes across every school in the district, exportable as PDF.",
    phase: "Phase 5",
  },
  {
    title: "Manage District Staff",
    body: "Add, deactivate, and assign roles for any staff member in any of your schools.",
    phase: "Today",
  },
];

// Phase 2 — Insights tile config. Two tiles ("Plans" and "Interventions")
// are launchers that route to the existing fully-functional pages
// (mtssPlans + logIntervention). The other seven are placeholder shells
// that will become full dashboards in Phase 4. Phase chip on each tile
// makes the roadmap visible to admins so they don't have to ask "is this
// real or coming?".
const INSIGHTS_TILES: InsightsTile[] = [
  {
    id: "academics",
    icon: "📘",
    title: "Academics",
    subtitle:
      "FAST PM1→PM2→PM3 progression — top growers, L1 students, % at proficient, and bottom-quartile risk.",
    phase: "Today",
    group: "domains",
    targetSection: "academicsDashboard",
  },
  {
    id: "academicsTrajectory",
    icon: "📈",
    title: "Academic Trajectories",
    subtitle:
      "FAST PM1 → PM3 by journey type — climbed, held the line, slipped, stuck, untested. Drill into each archetype for actionable sub-groups.",
    phase: "Today",
    group: "domains",
    targetSection: "academicsTrajectory",
  },
  {
    id: "attendance",
    icon: "📅",
    title: "Attendance",
    subtitle:
      "Daily, period, and chronic-absence views with at-risk thresholds and parent-contact triggers.",
    phase: "Today",
    group: "domains",
    targetSection: "attendanceDashboard",
  },
  {
    id: "behavior",
    icon: "🛡️",
    title: "Behavior",
    subtitle:
      "PBIS positives and negatives — who's getting recognized, who needs support, and which behaviors are trending.",
    phase: "Today",
    group: "domains",
    targetSection: "behaviorDashboard",
  },
  {
    id: "seb",
    icon: "💚",
    title: "SEB / SEL",
    subtitle:
      "MTSS plan coverage, IEP/504/ELL flags, and where risk is stacking up — including kids slipping without a plan.",
    phase: "Today",
    group: "domains",
    targetSection: "sebSelDashboard",
  },
  {
    id: "engagement",
    icon: "✨",
    title: "Engagement",
    subtitle:
      "Hall passes, tardies, ISS days, pullouts — what's pulling students out of instruction.",
    phase: "Today",
    group: "domains",
    targetSection: "engagementDashboard",
  },
  {
    id: "equity",
    icon: "⚖️",
    title: "Equity",
    subtitle:
      "Risk ratios across ELL, IEP, 504, and gender — surfaces where outcomes diverge from peer rates.",
    phase: "Today",
    group: "domains",
    targetSection: "equityDashboard",
  },
  {
    id: "plans",
    icon: "📋",
    title: "Plans",
    subtitle:
      "MTSS plans, IEP/504 cross-references, plan-review meetings. Live today.",
    phase: "Today",
    group: "actions",
    targetSection: "mtssPlans",
  },
  {
    id: "interventions",
    icon: "🎯",
    title: "Interventions",
    subtitle:
      "Log interventions, view recent deliveries, manage the intervention catalog. Live today.",
    phase: "Today",
    group: "actions",
    targetSection: "logIntervention",
  },
  {
    id: "earlyWarning",
    icon: "🚨",
    title: "Early Warning",
    subtitle:
      "One 0-100 composite per student rolling up academics, behavior, engagement, and supports — sorted leaderboard so the team knows who to touch first.",
    phase: "Today",
    group: "monitoring",
    targetSection: "earlyWarningDashboard",
  },
];

// Phase 2 polish — sidebar group ownership map for the accordion behavior.
// When the current activeSection is in a group's ownership list, that
// group is force-expanded regardless of the user's saved preference; this
// prevents the "where am I?" UX of being on a page whose nav item is
// hidden behind a collapsed group. Sub-keys like pbisHub/pbisRecent/
// pbisReports etc. all live under Recognition because that's where their
// nav items render. Keep this in sync with the sidebar JSX below.
const NAV_GROUP_OWNERSHIP: Record<string, readonly string[]> = {
  administration: ["superUserHome", "districtAdmin"],
  insights: ["insights", "insightsWatchlist", "myWatchList", "studentProfile"],
  recognition: [
    "pbis",
    "schoolStore",
    "schoolStoreManage",
    "pbisHub",
    "pbisRecent",
    "pbisReports",
    "pbisReasons",
    "pbisMilestoneEmails",
    "pbisLists",
  ],
  behaviorSupport: [
    "logIntervention",
    "requestPullout",
    "behaviorSpecialist",
    "interventions",
    "trustedAdultInterventions",
    "verifyPullouts",
    "issDashboard",
    "behaviorReview",
  ],
  specialPrograms: ["accommodations", "ese"],
  family: ["student", "parentAccess"],
  people: ["teacherRoster", "staffRoles"],
  // hallPassMgmt is reached via the Hall Passes admin tools; it has no
  // dedicated nav item so we anchor it to School Admin so the sidebar
  // gives the user *some* group context when they're on that page.
  schoolAdmin: ["bellSchedule", "activeKiosks", "settings", "hallPassMgmt"],
};
// Insights launches mtssPlans/mtssCoordinator/mtssTemplates as sub-pages
// (via tile launchers in InsightsHub); they have no direct sidebar item,
// so they belong to the Insights group for force-expand purposes.
NAV_GROUP_OWNERSHIP.insights = [
  "insights",
  "insightsWatchlist",
  "myWatchList",
  "studentProfile",
  "mtssPlans",
  "mtssCoordinator",
  "mtssTemplates",
  "academicsTrajectory",
];
// Trusted Adults admin lives in the School Admin nav group alongside
// Staff & Roles + Bell Schedule, since it's a per-school admin tool
// gated to the same core-team predicate.
NAV_GROUP_OWNERSHIP.schoolAdmin = [
  "bellSchedule",
  "activeKiosks",
  "settings",
  "hallPassMgmt",
  "trustedAdultsAdmin",
  "displays",
];

function groupContainsActive(groupId: string, activeSection: string): boolean {
  return NAV_GROUP_OWNERSHIP[groupId]?.includes(activeSection) ?? false;
}

// Sidebar themed-group wrapper. Click the header to expand/collapse the
// items underneath; per-user preference persisted in localStorage so it
// survives reload. If the active page belongs to this group, the group
// is force-expanded (saved-closed preference is overridden) — otherwise
// the user couldn't see which page they were on.
function NavGroup({
  id,
  label,
  containsActive,
  userId,
  children,
}: {
  id: string;
  label: string;
  containsActive: boolean;
  // Prefixed into the localStorage key so two staff sharing the same
  // browser/iPad don't inherit each other's collapse preferences. Falls
  // back to "anon" if the user object hasn't loaded yet.
  userId: string;
  children: React.ReactNode;
}) {
  const storageKey = `pulseedu.navgroup.${userId}.${id}`;
  const [userOpen, setUserOpen] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? null : v === "true";
    } catch {
      return null;
    }
  });
  // On mobile the sidebar is a horizontal scroll strip — accordion
  // collapse/expand would make the strip jump and is awkward to tap.
  // Force every group open on mobile so all nav items are reachable
  // by horizontal swipe; the toggle button itself is made
  // pointer-events:none in the mobile media query so taps are ignored.
  //
  // IMPORTANT: this 800px breakpoint must stay in lockstep with the
  // `@media (max-width: 800px)` rule in index.css that converts the
  // sidebar to a horizontal strip and applies pointer-events:none to
  // the toggle. If they drift apart there's a viewport range where CSS
  // disables the toggle but JS doesn't force it open, locking the user
  // out of every collapsed group. The shared `useIsMobile` hook uses
  // 768px for the shadcn sidebar and is intentionally not reused here.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 800px)");
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  // Resolution order: mobile forces open, else contains-active wins,
  // else user preference, else default-closed. Default-closed gives the
  // compact sidebar the user asked for; the active group is always visible.
  const open = isMobile || containsActive || userOpen === true;
  const toggle = () => {
    const next = !open;
    setUserOpen(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* ignore quota / private-mode failures */
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="section-label nav-admin-label nav-group-toggle"
      >
        <span>{label}</span>
        <span
          className="nav-group-chevron"
          aria-hidden="true"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
      </button>
      {open && children}
    </>
  );
}

function PlaceholderCard({
  title,
  body,
  phase,
}: {
  title: string;
  body: string;
  phase: string;
}) {
  // "Today" → ready now, render in green; everything else is roadmap copy.
  const isReady = phase === "Today";
  // Accordion: collapsed by default so the landing page stays a short
  // skimmable list. Each row toggles independently — opening one doesn't
  // close another, since users may want to compare two roadmap items.
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: "var(--radius-sm, 8px)",
        background: "var(--surface, #fff)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "0.6rem 0.75rem",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          color: "inherit",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 10,
              transition: "transform 120ms ease",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              color: "var(--text-subtle)",
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            ▶
          </span>
          <span style={{ fontWeight: 600 }}>{title}</span>
        </div>
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 6px",
            borderRadius: 999,
            background: isReady ? "#dcfce7" : "#f1f5f9",
            color: isReady ? "#166534" : "#475569",
            border: isReady ? "1px solid #86efac" : "1px solid #cbd5e1",
            whiteSpace: "nowrap",
          }}
        >
          {phase}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: "0 0.75rem 0.75rem 2rem",
            fontSize: 13,
            color: "var(--text-subtle)",
            lineHeight: 1.45,
          }}
        >
          {body}
        </div>
      )}
    </div>
  );
}

function App() {
  // Apply per-school branding (header gradient, logo) to the document root
  // so any component reading var(--brand-header-bg) retints automatically.
  useSchoolBranding();
  const [students, setStudents] = useState<Student[]>([]);
  const [hallPasses, setHallPasses] = useState<HallPass[]>([]);
  const [createPassOpen, setCreatePassOpen] = useState(false);
  const [logTardyOpen, setLogTardyOpen] = useState(false);
  const [checkInOutOpen, setCheckInOutOpen] = useState(false);
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
    isDistrictAdmin?: boolean;
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
    capManageDisplays?: boolean;
    defaultRoom?: string | null;
  } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [staffUsers, setStaffUsers] = useState<string[]>([]);
  const [settingsTile, setSettingsTile] = useState<SettingsTileId | null>(null);
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
  const [hpReportSection, setHpReportSection] = useState<"hub" | "overview" | "byDay" | "ytd" | "research">("hub");
  const [researchStart, setResearchStart] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-01-01`;
  });
  const [researchEnd, setResearchEnd] = useState<string>(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });
  const [researchStudent, setResearchStudent] = useState<string>("");
  const [researchOrigin, setResearchOrigin] = useState<string>("");
  const [researchDest, setResearchDest] = useState<string>("");
  const [hpOverviewDate, setHpOverviewDate] = useState<string>(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });
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
    | "pbisRecent"
    | "pbisReports"
    | "pbisReasons"
    | "pbisMilestoneEmails"
    | "pbisHub"
    | "schoolStore"
    | "schoolStoreManage"
    | "accommodations"
    | "ese"
    | "pbisLists"
    | "interventions"
    | "trustedAdultInterventions"
    | "logIntervention"
    | "requestPullout"
    | "verifyPullouts"
    | "issDashboard"
    | "behaviorReview"
    | "behaviorSpecialist"
    | "hallPassMgmt"
    | "mtssCoordinator"
    | "mtssTemplates"
    | "mtssPlans"
    | "teacherRoster"
    | "settings"
    | "staffRoles"
    | "bellSchedule"
    | "activeKiosks"
    | "parentAccess"
    | "superUserHome"
    | "districtAdmin"
    | "insights"
    | "insightsWatchlist"
    | "myWatchList"
    | "studentProfile"
    | "attendanceDashboard"
    | "academicsTrajectory"
    | "trustedAdultsAdmin"
    | "displays"
  >("hallPasses");
  // Selected student for the Insights → StudentProfile drill-in. Set by
  // a row click in InsightsWatchlist OR the Spider pill on the Teacher
  // Roster. Cleared on Back. If the activeSection switches to
  // "studentProfile" with no id set we bounce back to the watchlist
  // (handled in the guard effect below).
  const [selectedInsightsStudentId, setSelectedInsightsStudentId] = useState<
    string | null
  >(null);
  // Where to return when the user clicks Back on the StudentProfile.
  // Tracks which surface launched the drill-in so we don't always dump
  // them on the Watchlist. Defaults to "insightsWatchlist" for legacy
  // callers; the Teacher Roster Spider pill sets it to "teacherRoster"
  // before navigating.
  const [studentProfileReturnTo, setStudentProfileReturnTo] = useState<
    | "insightsWatchlist"
    | "myWatchList"
    | "teacherRoster"
    | "engagementDashboard"
    | "behaviorDashboard"
    | "academicsDashboard"
    | "academicsTrajectory"
    | "attendanceDashboard"
    | "sebSelDashboard"
    | "equityDashboard"
    | "earlyWarningDashboard"
  >("insightsWatchlist");
  const [schoolSettings, setSchoolSettings] = useState<{
    schoolName: string;
    fromName: string;
    emailSignature: string;
    periodCount: number;
    hallPassMaxMinutes: number;
    hallPassDefaultMinutes: number;
    globalDailyHallPassLimit: number | null;
    pbisQuietTeacherDays: number;
    pbisInvisibleStudentDays: number;
    pbisReasonImbalancePct: number;
    pbisColdPeriodMultiple: number;
    // Two-tier feature flags. Defaults are TRUE so the optimistic UI
    // matches what the server returns for any school that has not yet
    // flipped anything off.
    featureFamilyComm: boolean;
    featurePbis: boolean;
    featureSchoolStore: boolean;
    featureAccommodations: boolean;
    featureLogIntervention: boolean;
    featureRequestPullout: boolean;
    superFeatureFamilyComm: boolean;
    superFeaturePbis: boolean;
    superFeatureSchoolStore: boolean;
    superFeatureAccommodations: boolean;
    superFeatureLogIntervention: boolean;
    superFeatureRequestPullout: boolean;
  }>({
    schoolName: "",
    fromName: "",
    emailSignature: "",
    periodCount: 7,
    hallPassMaxMinutes: 30,
    hallPassDefaultMinutes: 5,
    globalDailyHallPassLimit: null,
    pbisQuietTeacherDays: 5,
    pbisInvisibleStudentDays: 10,
    pbisReasonImbalancePct: 60,
    pbisColdPeriodMultiple: 5,
    featureFamilyComm: true,
    featurePbis: true,
    featureSchoolStore: true,
    featureAccommodations: true,
    featureLogIntervention: true,
    featureRequestPullout: true,
    superFeatureFamilyComm: true,
    superFeaturePbis: true,
    superFeatureSchoolStore: true,
    superFeatureAccommodations: true,
    superFeatureLogIntervention: true,
    superFeatureRequestPullout: true,
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
  const [summaryChecks, setSummaryChecks] = useState<Record<string, boolean>>({});
  type MtssTemplate = { id: string; name: string; subject: string; body: string };
  const MTSS_TEMPLATES_KEY = "pulseed.mtssTemplates.v1";
  const defaultMtssTemplates: MtssTemplate[] = [
    {
      id: "tpl-positive",
      name: "Positive Update",
      subject: "Positive Update for {{studentName}}",
      body:
        "Hello {{parentName}},\n\nI wanted to share a positive update about {{studentName}}. " +
        "They have earned {{pbisPoints}} PBIS points recently and are showing great effort.\n\nThank you for your support.",
    },
    {
      id: "tpl-pbis",
      name: "PBIS Recognition",
      subject: "PBIS Recognition for {{studentName}}",
      body:
        "Hello {{parentName}},\n\n{{studentName}} has earned {{pbisPoints}} PBIS points " +
        "across {{pbisCount}} entries. Please join us in recognizing their effort.",
    },
    {
      id: "tpl-tardy",
      name: "Attendance / Tardy Concern",
      subject: "Attendance / Tardy Concern for {{studentName}}",
      body:
        "Hello {{parentName}},\n\nWe wanted to make you aware that {{studentName}} has " +
        "{{tardyCount}} tardies and {{hallPassCount}} hall passes on record. " +
        "Please reach out so we can support attendance.",
    },
    {
      id: "tpl-checkin",
      name: "Check-In / Check-Out Notice",
      subject: "Check-In / Check-Out Notice for {{studentName}}",
      body:
        "Hello {{parentName}},\n\nThis is a notice that {{studentName}} had " +
        "{{checkInCount}} check-ins and {{checkOutCount}} check-outs recorded.",
    },
  ];
  const [mtssTemplates, setMtssTemplates] = useState<MtssTemplate[]>(() => {
    try {
      const raw = localStorage.getItem(MTSS_TEMPLATES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MtssTemplate[];
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch {}
    return defaultMtssTemplates;
  });
  useEffect(() => {
    try {
      localStorage.setItem(MTSS_TEMPLATES_KEY, JSON.stringify(mtssTemplates));
    } catch {}
  }, [mtssTemplates]);
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
    if (!authUser?.isAdmin && !authUser?.isSuperUser && !authUser?.isEseCoordinator) {
      setAllSections([]);
      return;
    }
    authFetch("/api/schedule?all=1", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { sections: [] }))
      .then((data: { sections?: AllSection[] }) =>
        setAllSections(Array.isArray(data.sections) ? data.sections : []),
      )
      .catch(() => setAllSections([]));
  }, [
    authUser?.id,
    authUser?.isAdmin,
    authUser?.isSuperUser,
    authUser?.isEseCoordinator,
  ]);
  type SchoolAccommodation = {
    id: number;
    name: string;
    category: "IEP" | "504" | "ELL" | "Strategy";
  };
  const [schoolAccommodations, setSchoolAccommodations] = useState<
    SchoolAccommodation[]
  >([]);
  useEffect(() => {
    if (!authUser?.id) {
      setSchoolAccommodations([]);
      return;
    }
    authFetch("/api/school-accommodations", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: SchoolAccommodation[]) =>
        setSchoolAccommodations(Array.isArray(rows) ? rows : []),
      )
      .catch(() => {});
  }, [authUser?.id]);
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
  // Daily Class Log state.
  // The Class Log was redesigned to log per-student-per-accommodation
  // status (provided/refused) for any chosen date + period instead of the
  // older "select all + confirm absent + apply" flow. The new state shape:
  //   - dailyDate          chosen YYYY-MM-DD (defaults to today)
  //   - dailyExpandedSid   which student card is currently open in the roster
  //   - dailyEntries       per-student per-acc status; absent students simply
  //                        have no entries (so absence is implicit, no
  //                        attendance checkbox required).
  // `bellPeriods` is fetched once for the school's default bell schedule and
  // is used to autoselect the period currently in session.
  const [dailyPeriod, setDailyPeriod] = useState<string>("");
  const [dailyTeacherId, setDailyTeacherId] = useState<number | null>(null);
  const [dailyDate, setDailyDate] = useState<string>(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  });
  const [dailyExpandedSid, setDailyExpandedSid] = useState<string | null>(null);
  type DailyStatus = "provided" | "refused";
  const [dailyEntries, setDailyEntries] = useState<
    Record<string, Record<number, DailyStatus>>
  >({});
  const [dailySubmitMsg, setDailySubmitMsg] = useState("");
  const [bellPeriods, setBellPeriods] = useState<
    { periodNumber: number; name: string; startTime: string; endTime: string }[]
  >([]);
  const [bellPeriodsLoaded, setBellPeriodsLoaded] = useState(false);
  const [autoPeriodApplied, setAutoPeriodApplied] = useState(false);
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
      const res = await authFetch("/api/pbis-milestones");
      if (!res.ok) return;
      const data = (await res.json()) as PbisMilestone[];
      setPbisMilestones(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    }
  };
  const loadMilestoneEmails = async () => {
    try {
      const res = await authFetch("/api/pbis-milestone-emails");
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
      const res = await authFetch("/api/pbis-milestones", {
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
      const res = await authFetch(`/api/pbis-milestones/${m.id}`, {
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
      const res = await authFetch(
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
      const res = await authFetch(`/api/schedule`, {
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
      const res = await authFetch("/api/pbis/bulk", {
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
      const res = await authFetch("/api/pbis-goals");
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
      const res = await authFetch("/api/pbis-goals", {
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
      const res = await authFetch(`/api/pbis-goals/${id}/archive`, {
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
      const res = await authFetch(`/api/pbis/${id}`, {
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
      const res = await authFetch(`/api/pbis/${id}/void`, {
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
  const [intervNotePopoverId, setIntervNotePopoverId] = useState<string | null>(
    null,
  );

  const loadInterventionEntries = async () => {
    try {
      const res = await authFetch("/api/interventions", {
        cache: "no-store",
      });
      if (res.status === 304) {
        // Not modified: keep current entries rather than wiping them.
        return;
      }
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
      const res = await authFetch("/api/interventions", {
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
      const res = await authFetch(`/api/reports/pbis?${params.toString()}`);
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
    // Prefer the per-staff defaultRoom stored on the user record (the new
    // editable field in Staff & Roles); fall back to the older staffDefaults
    // map keyed by display name for backward compatibility.
    const def = authUser?.defaultRoom?.trim()
      ? authUser.defaultRoom.trim()
      : staffDefaults[currentStaffUser];
    if (def) setOriginRoom(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStaffUser, staffDefaults, authUser?.defaultRoom]);

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
        authFetch(`/api/hall-passes/${p.id}/end`, {
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
    if (!authUser?.isAdmin && !authUser?.isSuperUser) return;
    authFetch("/api/admin/notifications")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAdminNotifications(data))
      .catch(() => setAdminNotifications([]));
  };

  const loadActiveKiosks = () => {
    if (!authUser?.isAdmin && !authUser?.isSuperUser) return;
    authFetch("/api/kiosk/activations?status=active")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setActiveKiosks(data))
      .catch(() => setActiveKiosks([]));
  };

  const resolveAdminNotification = async (id: number) => {
    const res = await authFetch(`/api/admin/notifications/${id}/resolve`, {
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
    const res = await authFetch(`/api/kiosk/activations/${id}/deactivate`, {
      method: "POST",
    });
    if (res.ok) loadActiveKiosks();
  };

  useEffect(() => {
    loadAdminNotifications();
    loadActiveKiosks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.isAdmin, authUser?.isSuperUser]);

  useEffect(() => {
    if (activeSection !== "settings") {
      if (settingsTile !== null) setSettingsTile(null);
    } else if (
      settingsTile === null &&
      (authUser?.isAdmin || authUser?.isSuperUser)
    ) {
      loadAdminNotifications();
      loadActiveKiosks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, settingsTile]);

  useEffect(() => {
    if (!authUser) {
      setStaffUsers([]);
      return;
    }
    authFetch("/api/admin/staff")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ displayName: string; active: boolean }>) => {
        const names = Array.from(
          new Set(
            rows
              .filter((r) => r.active && r.displayName)
              .map((r) => r.displayName),
          ),
        ).sort((a, b) => a.localeCompare(b));
        setStaffUsers(names);
      })
      .catch(() => setStaffUsers([]));
  }, [authUser?.id]);

  const loadHallPasses = () => {
    authFetch("/api/hall-passes")
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
    authFetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("Health check response:", data))
      .catch((err) => console.error("Health check failed:", err));

    loadStudents();

    authFetch("/api/location-allowed-destinations")
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

    authFetch("/api/teacher-allowlist")
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

    authFetch("/api/staff-defaults")
      .then((res) => (res.ok ? res.json() : []))
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

    authFetch(`/api/schedule`, { credentials: "include" })
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
    authFetch("/api/reports/teachers")
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
    if (!authUser || (!authUser.isAdmin && !authUser.isSuperUser && !authUser.isEseCoordinator)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hpReportDate)) {
      setHpReportError("Pick a valid date.");
      setHpReportData(null);
      return;
    }
    const myReqId = ++hpReportReqIdRef.current;
    setHpReportLoading(true);
    setHpReportError("");
    try {
      const res = await authFetch(
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
      (authUser.isAdmin || authUser.isSuperUser || authUser.isEseCoordinator)
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
      !authUser.isSuperUser &&
      !authUser.isEseCoordinator &&
      hpView !== "overview"
    ) {
      setHpView("overview");
    }
  }, [
    authUser?.id,
    authUser?.isAdmin,
    authUser?.isSuperUser,
    authUser?.isEseCoordinator,
    hpView,
  ]);

  // On sign-in, default the Hall Passes scope to "mine" for teachers and
  // "all" for admins. Users can still flip the toggle either way after.
  useEffect(() => {
    if (!authUser) return;
    setPassFilter(
      authUser.isAdmin || authUser.isSuperUser ? "all" : "mine",
    );
  }, [authUser?.id, authUser?.isAdmin, authUser?.isSuperUser]);

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
      const res = await authFetch(`/api/reports/accommodations?${params}`);
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
    if (authUser && (authUser.isAdmin || authUser.isSuperUser || authUser.isEseCoordinator)) {
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

  // Helper: pull a boolean off the wire defaulting to true. New
  // feature-flag columns default true server-side; legacy schools that
  // pre-date the columns also see true via the ALTER … DEFAULT TRUE.
  const boolOrTrue = (v: unknown): boolean => (typeof v === "boolean" ? v : true);

  const loadSchoolSettings = () => {
    authFetch("/api/school-settings")
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
          pbisQuietTeacherDays:
            typeof data.pbisQuietTeacherDays === "number"
              ? data.pbisQuietTeacherDays
              : 5,
          pbisInvisibleStudentDays:
            typeof data.pbisInvisibleStudentDays === "number"
              ? data.pbisInvisibleStudentDays
              : 10,
          pbisReasonImbalancePct:
            typeof data.pbisReasonImbalancePct === "number"
              ? data.pbisReasonImbalancePct
              : 60,
          pbisColdPeriodMultiple:
            typeof data.pbisColdPeriodMultiple === "number"
              ? data.pbisColdPeriodMultiple
              : 5,
          featureFamilyComm: boolOrTrue(data.featureFamilyComm),
          featurePbis: boolOrTrue(data.featurePbis),
          featureSchoolStore: boolOrTrue(data.featureSchoolStore),
          featureAccommodations: boolOrTrue(data.featureAccommodations),
          featureLogIntervention: boolOrTrue(data.featureLogIntervention),
          featureRequestPullout: boolOrTrue(data.featureRequestPullout),
          superFeatureFamilyComm: boolOrTrue(data.superFeatureFamilyComm),
          superFeaturePbis: boolOrTrue(data.superFeaturePbis),
          superFeatureSchoolStore: boolOrTrue(data.superFeatureSchoolStore),
          superFeatureAccommodations: boolOrTrue(
            data.superFeatureAccommodations,
          ),
          superFeatureLogIntervention: boolOrTrue(
            data.superFeatureLogIntervention,
          ),
          superFeatureRequestPullout: boolOrTrue(
            data.superFeatureRequestPullout,
          ),
        }),
      )
      .catch((err) => console.error("Failed to load school settings:", err));
  };

  const saveSchoolSettings = async () => {
    setSettingsStatus("saving");
    setSettingsError("");
    try {
      const res = await authFetch("/api/school-settings", {
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
        pbisQuietTeacherDays:
          typeof data.pbisQuietTeacherDays === "number"
            ? data.pbisQuietTeacherDays
            : 5,
        pbisInvisibleStudentDays:
          typeof data.pbisInvisibleStudentDays === "number"
            ? data.pbisInvisibleStudentDays
            : 10,
        pbisReasonImbalancePct:
          typeof data.pbisReasonImbalancePct === "number"
            ? data.pbisReasonImbalancePct
            : 60,
        pbisColdPeriodMultiple:
          typeof data.pbisColdPeriodMultiple === "number"
            ? data.pbisColdPeriodMultiple
            : 5,
        featureFamilyComm: boolOrTrue(data.featureFamilyComm),
        featurePbis: boolOrTrue(data.featurePbis),
        featureSchoolStore: boolOrTrue(data.featureSchoolStore),
        featureAccommodations: boolOrTrue(data.featureAccommodations),
        featureLogIntervention: boolOrTrue(data.featureLogIntervention),
        featureRequestPullout: boolOrTrue(data.featureRequestPullout),
        superFeatureFamilyComm: boolOrTrue(data.superFeatureFamilyComm),
        superFeaturePbis: boolOrTrue(data.superFeaturePbis),
        superFeatureSchoolStore: boolOrTrue(data.superFeatureSchoolStore),
        superFeatureAccommodations: boolOrTrue(data.superFeatureAccommodations),
        superFeatureLogIntervention: boolOrTrue(
          data.superFeatureLogIntervention,
        ),
        superFeatureRequestPullout: boolOrTrue(data.superFeatureRequestPullout),
      });
      setSettingsStatus("saved");
      setTimeout(() => setSettingsStatus("idle"), 2000);
    } catch (err) {
      setSettingsStatus("error");
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadTardies = () => {
    authFetch("/api/tardies")
      .then((res) => res.json())
      .then((data: Tardy[]) => setTardies(data))
      .catch((err) => console.error("Failed to load tardies:", err));
  };

  const loadPbis = () => {
    authFetch("/api/pbis")
      .then((res) => res.json())
      .then((data: PbisEntry[]) => setPbisEntries(data))
      .catch((err) => console.error("Failed to load pbis:", err));
  };

  const loadAccommodationLogs = () => {
    authFetch("/api/accommodation-logs")
      .then((res) => res.json())
      .then((data) => setAccommodationLogs(data))
      .catch((err) =>
        console.error("Failed to load accommodation logs:", err),
      );
  };

  const loadStudents = () => {
    authFetch("/api/students")
      .then((res) => res.json())
      .then((data: Student[]) => setStudents(data))
      .catch((err) => console.error("Failed to load students:", err));
  };

  const loadSchoolAccommodations = () => {
    authFetch("/api/school-accommodations")
      .then((res) => res.json())
      .then((data) => setSchoolAccs(data))
      .catch((err) =>
        console.error("Failed to load school accommodations:", err),
      );
  };

  const loadPbisReasons = async () => {
    setPbisListMsg("");
    try {
      const res = await authFetch("/api/pbis-reasons");
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
      const res = await authFetch("/api/intervention-types");
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
      const res = await authFetch("/api/polarity-pairs");
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
      const res = await authFetch("/api/polarity-pairs", {
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
      const res = await authFetch(`/api/polarity-pairs/${id}`, {
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
      const res = await authFetch(`/api/student-hall-pass-limits${sid}`, {
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
      const res = await authFetch(`/api/student-hall-pass-limits${sid}`, {
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
      const res = await authFetch(`/api/student-hall-pass-limits/${id}${sid}`, {
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
      const res = await authFetch("/api/school-settings", {
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
      const res = await authFetch("/api/pbis-reasons", {
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
      const res = await authFetch(`/api/pbis-reasons/${id}`, {
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
      const res = await authFetch("/api/intervention-types", {
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
      const res = await authFetch(`/api/intervention-types/${id}`, {
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
      const res = await authFetch(`/api/intervention-types/${id}`, {
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
      const res = await authFetch("/api/pullout-reasons");
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
      const res = await authFetch("/api/pullout-reasons", {
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
      const res = await authFetch(`/api/pullout-reasons/${id}`, {
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
      const res = await authFetch(`/api/pullout-reasons/${id}`, {
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
    authFetch(`/api/students/${studentId}/accommodations${sid}`, {
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

  // Submit the new per-student Class Log: builds an `entries` array from
  // `dailyEntries`, posts to /accommodation-logs/bulk-per-student, and
  // surfaces the server's inserted/skipped counts.
  const submitDailyLog = async () => {
    if (!dailyPeriod) {
      setDailySubmitMsg("Pick a period first.");
      return;
    }
    const entries: {
      studentId: string;
      accommodationId: number;
      status: DailyStatus;
    }[] = [];
    let studentsTouched = 0;
    for (const [sid, perAcc] of Object.entries(dailyEntries)) {
      const accIds = Object.keys(perAcc);
      if (accIds.length === 0) continue;
      studentsTouched++;
      for (const accIdStr of accIds) {
        const accId = Number(accIdStr);
        if (!Number.isFinite(accId)) continue;
        entries.push({
          studentId: sid,
          accommodationId: accId,
          status: perAcc[accId],
        });
      }
    }
    if (entries.length === 0) {
      setDailySubmitMsg(
        "Open at least one student and mark Provided or Refused.",
      );
      return;
    }
    const periodNum = Number(dailyPeriod);
    const isElevated =
      authUser?.isAdmin === true ||
      authUser?.isSuperUser === true ||
      authUser?.isEseCoordinator === true ||
      authUser?.isMtssCoordinator === true ||
      authUser?.isBehaviorSpecialist === true;
    // For elevated users logging on behalf of a specific teacher, send
    // `actingAsStaffId` so the server attributes the section to that
    // teacher (not the elevated principal). The server validates the
    // delegation against the principal's role + same-school membership.
    const actingAsStaffId =
      isElevated && dailyTeacherId != null && dailyTeacherId !== authUser?.id
        ? dailyTeacherId
        : null;
    setDailySubmitMsg("Submitting...");
    try {
      const res = await authFetch(
        "/api/accommodation-logs/bulk-per-student",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            period: periodNum,
            date: dailyDate,
            entries,
            ...(actingAsStaffId != null
              ? { actingAsStaffId }
              : {}),
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const recordsWord = data.inserted === 1 ? "record" : "records";
      const studentsWord = studentsTouched === 1 ? "student" : "students";
      let msg = `${data.inserted} ${recordsWord} logged for ${studentsTouched} ${studentsWord} on ${data.date}.`;
      if (data.skippedDuplicate) {
        msg += ` (${data.skippedDuplicate} already logged for that day.)`;
      }
      if (data.skippedNotEntitled) {
        msg += ` (${data.skippedNotEntitled} skipped — not on student's plan.)`;
      }
      if (data.skippedNotRostered) {
        msg += ` (${data.skippedNotRostered} skipped — not on roster.)`;
      }
      setDailySubmitMsg(msg);
      setDailyEntries({});
      setDailyExpandedSid(null);
      playEkgBeep();
      loadAccommodationLogs();
    } catch (err) {
      setDailySubmitMsg(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Fetch the school's active bell schedule once on mount so the Class Log
  // can autoselect "the period currently in session". Teachers can still
  // override the period dropdown afterwards.
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/bell-schedules/active", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { periods: [] }))
      .then(
        (data: {
          periods?: {
            periodNumber: number;
            name: string;
            startTime: string;
            endTime: string;
          }[];
        }) => {
          if (cancelled) return;
          setBellPeriods(Array.isArray(data?.periods) ? data.periods : []);
          setBellPeriodsLoaded(true);
        },
      )
      .catch(() => {
        if (cancelled) return;
        setBellPeriods([]);
        setBellPeriodsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Compute the period that's currently in session by matching today's
  // local clock-time to a bell-schedule window. Returns null when no
  // schedule is available, the user is outside any window, or the user
  // teaches no period today.
  const currentBellPeriod = (() => {
    if (!bellPeriodsLoaded || bellPeriods.length === 0) return null;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const clock = `${hh}:${mm}`;
    for (const p of bellPeriods) {
      if (clock >= p.startTime && clock <= p.endTime) return p.periodNumber;
    }
    return null;
  })();

  // Auto-fill the period dropdown the first time the teacher opens the
  // Class Log on a date where we can identify a "current" period that they
  // actually teach (or, for elevated users, that the chosen teacher
  // teaches). Only runs once per session/date so manual changes stick.
  useEffect(() => {
    if (autoPeriodApplied) return;
    if (activeSection !== "accommodations") return;
    if (accView !== "daily") return;
    if (!bellPeriodsLoaded) return;
    if (dailyPeriod) return;
    const isElevated =
      authUser?.isAdmin === true ||
      authUser?.isSuperUser === true ||
      authUser?.isEseCoordinator === true ||
      authUser?.isMtssCoordinator === true ||
      authUser?.isBehaviorSpecialist === true;
    const sourceSections =
      isElevated && dailyTeacherId != null
        ? allSections.filter((s) => s.teacherStaffId === dailyTeacherId)
        : mySections;
    const taughtPeriods = sourceSections
      .filter((s) => !s.isPlanning)
      .map((s) => s.period);
    if (taughtPeriods.length === 0) return;
    if (
      currentBellPeriod != null &&
      taughtPeriods.includes(currentBellPeriod)
    ) {
      setDailyPeriod(String(currentBellPeriod));
      setAutoPeriodApplied(true);
    }
  }, [
    activeSection,
    accView,
    bellPeriodsLoaded,
    dailyPeriod,
    dailyTeacherId,
    currentBellPeriod,
    autoPeriodApplied,
    allSections,
    mySections,
    authUser,
  ]);

  const eseAssignSelected = async () => {
    if (!eseStudentId || eseAddSelected.size === 0) return;
    try {
      const sid = authUser?.id ? `?staffId=${authUser.id}` : "";
      const res = await authFetch(
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
      const res = await authFetch(
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
      const res = await authFetch(`/api/school-accommodations${sid}`, {
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
      const res = await authFetch(`/api/school-accommodations/${id}${sid}`, {
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
      const res = await authFetch(
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
      const res = await authFetch(`/api/school-accommodations/${a.id}${sid}`, {
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
      const res = await authFetch(
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
        const res = await authFetch(
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
        const res = await authFetch(`/api/students/${studentId}/accommodations`, {
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
      const res = await authFetch("/api/accommodation-logs", {
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
      const res = await authFetch("/api/accommodation-logs", {
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
    authFetch("/api/support-notes")
      .then((res) => res.json())
      .then((data: SupportNote[]) => setSupportNotes(data))
      .catch((err) => console.error("Failed to load support notes:", err));
  };

  const handleSupportNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activityStudentId || !supportNoteText.trim()) return;
    try {
      const res = await authFetch("/api/support-notes", {
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
      const res = await authFetch("/api/pbis", {
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
      const res = await authFetch("/api/tardies", {
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
          const passRes = await authFetch("/api/hall-passes", {
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
      const res = await authFetch(`/api/hall-passes/${id}/end`, {
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
      const res = await authFetch(`/api/hall-passes/${id}`, {
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
      const res = await authFetch("/api/hall-passes", {
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
  // Hallway TV / kiosk icon used for the Signage launcher.
  const IconMonitor = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
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

  // SuperUser is a strict superset of Admin — anyone with the
  // SuperUser flag should pass every Admin gate in the UI. Folding the
  // bypass into `isAdmin` here means every derived flag below
  // (`canManageBehaviorLists`, `canEditSchoolStore`, …) automatically
  // grants SuperUser without dozens of separate edits at each call site.
  const isAdmin =
    authUser?.isAdmin === true || authUser?.isSuperUser === true;
  // District Admin counts as a "settings manager" because school-level
  // settings (kiosk, locations, branding, bell schedule, data imports)
  // all fall under their remit when they're acting as a school in their
  // district via the tenancy switcher. School Admin and SuperUser
  // already qualify; DA is added here so the Settings entry point and
  // every tile inside it (including Data Imports) is reachable.
  // Read flags directly off authUser instead of the hoisted isDistrictAdmin
  // / isSuperUser bindings — those are declared further down (next to the
  // sidebar-group arrays) and would put us in the temporal dead zone here.
  const canManageSettings =
    isAdmin ||
    authUser?.isDistrictAdmin === true ||
    authUser?.isSuperUser === true;
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
  const canAccessPbisHub =
    Boolean(authUser?.isSuperUser) ||
    isAdmin ||
    isBehaviorSpec ||
    isMtss ||
    isPbisCoord;
  // MTSS Plans edit/read access — kept in sync with the server's
  // requireCoreTeam gate in routes/mtssPlans.ts. Read access is gated
  // the same as write because plans contain protected intervention
  // notes meant only for the support team.
  const canManageMtssPlans =
    Boolean(authUser?.isSuperUser) ||
    isAdmin ||
    isBehaviorSpec ||
    isMtss ||
    isPbisCoord;
  // School Store edit access — kept in sync with the server's
  // requireWriteAccess gate in routes/schoolStore.ts. SuperUser is
  // included so a SuperUser entering the BS or MTSS hub (both of which
  // already admit SuperUsers) can edit the catalog from the tile rather
  // than landing on a silent read-only view.
  const canEditSchoolStore =
    Boolean(authUser?.isSuperUser) ||
    isAdmin ||
    isBehaviorSpec ||
    isMtss ||
    isPbisCoord;
  const isSuperUser = authUser?.isSuperUser === true;
  // District Admin tier (Phase 1D). Mirrors the server-side
  // `canActAsDistrict` predicate in artifacts/api-server/src/lib/scope.ts —
  // SuperUser ⊇ DistrictAdmin so any UI surface gated on "may act at the
  // district level" must include both. Centralized here so individual
  // sidebar/section gates don't accidentally check `isDistrictAdmin` alone
  // and exclude the SuperUser.
  const isDistrictAdmin = authUser?.isDistrictAdmin === true;
  const canActAsDistrict = isSuperUser || isDistrictAdmin;
  // Hoisted above the bounce-back useEffect because that effect's dep
  // array references both of these. They were originally declared further
  // down (next to the nav-section arrays) which put them in the temporal
  // dead zone at dep-array construction time and crashed the App with
  // "Cannot access X before initialization." Moving the declarations up
  // is the lowest-risk fix; the duplicates below are removed.
  const canAccessMtssHub =
    Boolean(authUser?.isSuperUser) ||
    isAdmin ||
    isMtss ||
    isBehaviorSpec;
  const canManageStaffRoles =
    Boolean(authUser?.isSuperUser) ||
    Boolean(authUser?.isAdmin) ||
    Boolean(authUser?.capStaffRoles);
  const canViewIssDashboard =
    isSuperUser ||
    isAdmin ||
    isIssTeacher ||
    isBehaviorSpec ||
    isDean ||
    isMtss;

  // Pending pullout count for the verifier badge.
  const [pendingPulloutCount, setPendingPulloutCount] = useState<number>(0);
  const [pendingPulloutsTick, setPendingPulloutsTick] = useState(0);
  useEffect(() => {
    if (!canVerifyPullouts) {
      setPendingPulloutCount(0);
      return;
    }
    let cancelled = false;
    const fetchCount = () => {
      authFetch("/api/pullouts?scope=pending")
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: unknown) => {
          if (cancelled) return;
          if (Array.isArray(rows)) setPendingPulloutCount(rows.length);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [canVerifyPullouts, pendingPulloutsTick]);

  // Active pullout count for the ISS Dashboard badge (verified/enroute/arrived).
  const [activePulloutCount, setActivePulloutCount] = useState<number>(0);
  useEffect(() => {
    if (!canViewIssDashboard) {
      setActivePulloutCount(0);
      return;
    }
    let cancelled = false;
    const fetchCount = () => {
      authFetch("/api/pullouts?scope=active")
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: unknown) => {
          if (cancelled) return;
          if (Array.isArray(rows)) setActivePulloutCount(rows.length);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [canViewIssDashboard]);

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
    authFetch("/api/pullouts?scope=unreviewed")
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
    if (!canManageSettings && activeSection === "settings") {
      setActiveSection("hallPasses");
    }
    if (!canManageStaffRoles && activeSection === "staffRoles") {
      setActiveSection("hallPasses");
    }
    if (!isEseCoord && activeSection === "ese") {
      setActiveSection("hallPasses");
    }
    if (activeSection === "pbisLists") {
      setActiveSection(canAccessPbisHub ? "pbisHub" : "hallPasses");
    }
    if (!canAccessPbisHub && activeSection === "pbisHub") {
      setActiveSection("hallPasses");
    }
    if (
      !canAccessPbisHub &&
      (activeSection === "pbisRecent" || activeSection === "pbisReports")
    ) {
      setActiveSection("hallPasses");
    }
    if (!isPbisCoord && activeSection === "pbisReasons") {
      setActiveSection("pbisHub");
    }
    if (!isPbisCoord && activeSection === "pbisMilestoneEmails") {
      setActiveSection("pbisHub");
    }
    if (!canManageBehaviorLists && activeSection === "interventions") {
      setActiveSection("hallPasses");
    }
    // Phase 1E bounce-backs. If a SuperUser is demoted to plain DA mid-session
    // they shouldn't keep staring at the SU Home page; same for a DA who loses
    // the flag entirely. Mirrors the JSX gate (SU-only / canActAsDistrict)
    // exactly so the two never disagree.
    if (!isSuperUser && activeSection === "superUserHome") {
      setActiveSection("hallPasses");
    }
    if (!canActAsDistrict && activeSection === "districtAdmin") {
      setActiveSection("hallPasses");
    }
    // Phase 2: Insights gated on the same canAccessMtssHub predicate that
    // already governs the legacy MTSS pages. Once district CSV imports
    // ship in Phase 3 we'll broaden this to anyone who should see the
    // domain dashboards.
    if (!canAccessMtssHub && activeSection === "insights") {
      setActiveSection("insightsWatchlist");
    }
    // Trusted Adults admin is core-team only — bounce anyone who lost
    // access while sitting on it.
    if (!canAccessMtssHub && activeSection === "trustedAdultsAdmin") {
      setActiveSection("hallPasses");
    }
    // StudentProfile requires a selected student. If we land on it
    // without one (e.g. direct URL hack, or the previously-selected
    // student went out of scope), fall back to the watchlist.
    if (activeSection === "studentProfile" && !selectedInsightsStudentId) {
      setActiveSection("insightsWatchlist");
    }
    // Demote a user who lost edit access while sitting on the editable
    // School Store. Bounce them to the read-only sidebar view rather than
    // hallPasses so they don't lose their place in the catalog.
    if (!canEditSchoolStore && activeSection === "schoolStoreManage") {
      setActiveSection("schoolStore");
    }
    // MTSS Plans is core-team only — bounce anyone who lost access while
    // sitting on it.
    if (!canManageMtssPlans && activeSection === "mtssPlans") {
      setActiveSection("hallPasses");
    }
  }, [
    isAdmin,
    isEseCoord,
    isPbisCoord,
    isBehaviorSpec,
    canAccessPbisHub,
    canManageBehaviorLists,
    canEditSchoolStore,
    canManageMtssPlans,
    activeSection,
    // Phase 1E + Phase 2 bounce-backs added in this same effect body
    // need their gating predicates in the dep array, otherwise the
    // bounce only fires when an unrelated dep changes (which is the
    // classic "stuck on a now-forbidden page" bug).
    canManageSettings,
    canManageStaffRoles,
    canAccessMtssHub,
    isSuperUser,
    canActAsDistrict,
  ]);

  useEffect(() => {
    if (
      (activeSection === "pbisLists" ||
        activeSection === "pbisReasons" ||
        activeSection === "pbisMilestoneEmails") &&
      isPbisCoord
    ) {
      loadPbisReasons();
      loadPbisMilestones();
      loadMilestoneEmails();
    }
    if (activeSection === "pbis" || activeSection === "pbisRecent") {
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
  // Effective feature map (super && admin per feature). Used to gate
  // sidebar entries and hub tiles. Built off `schoolSettings` so it
  // updates instantly when an admin toggles something.
  const effectiveFeatures = {
    FamilyComm:
      schoolSettings.featureFamilyComm && schoolSettings.superFeatureFamilyComm,
    Pbis: schoolSettings.featurePbis && schoolSettings.superFeaturePbis,
    SchoolStore:
      schoolSettings.featureSchoolStore && schoolSettings.superFeatureSchoolStore,
    Accommodations:
      schoolSettings.featureAccommodations &&
      schoolSettings.superFeatureAccommodations,
    LogIntervention:
      schoolSettings.featureLogIntervention &&
      schoolSettings.superFeatureLogIntervention,
    RequestPullout:
      schoolSettings.featureRequestPullout &&
      schoolSettings.superFeatureRequestPullout,
  };
  const allBaseNavSections: NavSection[] = [
    { key: "hallPasses", label: "Hall Passes", icon: IconDoor },
    { key: "tardies", label: "Tardy Pass", icon: IconClock },
    { key: "student", label: "Family Communication", icon: IconUser },
    // Teacher Roster moved to Quick Access (rendered directly in the
    // sidebar above the accordions) — kept out of this list to avoid
    // any chance of duplication if the legacy `baseNavSections` filter
    // ever gets re-consumed.
    { key: "pbis", label: "PBIS Points", icon: IconStar },
    // Read-only school-wide rewards catalog. Visible to every signed-in
    // staffer so teachers can browse what students can redeem. The
    // editable version lives inside the PBIS / BS / MTSS hubs.
    { key: "schoolStore", label: "School Store", icon: IconStar },
    { key: "accommodations", label: "Accommodations", icon: IconClipboard },
    { key: "logIntervention", label: "Log Intervention", icon: IconClipboard },
    { key: "requestPullout", label: "Request Pullout", icon: IconClipboard },
  ];
  // Sidebar entries that map to a per-school feature flag. Anything not
  // in this map (Hall Passes, Tardy Pass, Teacher Roster) is always on.
  const navKeyFeatureMap: Partial<Record<typeof allBaseNavSections[number]["key"], keyof typeof effectiveFeatures>> = {
    student: "FamilyComm",
    pbis: "Pbis",
    schoolStore: "SchoolStore",
    accommodations: "Accommodations",
    logIntervention: "LogIntervention",
    requestPullout: "RequestPullout",
  };
  const baseNavSections: NavSection[] = allBaseNavSections.filter((s) => {
    const featureKey = navKeyFeatureMap[s.key];
    if (!featureKey) return true;
    return effectiveFeatures[featureKey];
  });
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
  const mtssCoordNavSections: NavSection[] = [
    { key: "mtssCoordinator", label: "MTSS Coordinator", icon: IconClipboard },
  ];
  // canAccessMtssHub hoisted above the bounce-back useEffect — see note there.
  const pbisHubNavSections: NavSection[] = [
    { key: "pbisHub", label: "PBIS Hub", icon: IconStar },
  ];
  const adminNavSections: NavSection[] = [
    { key: "staffRoles", label: "Staff & Roles", icon: IconUser },
    { key: "settings", label: "Settings", icon: IconSettings },
  ];
  const bellScheduleNavSections: NavSection[] = [
    { key: "bellSchedule", label: "Bell Schedule", icon: IconClock },
  ];
  // Reuses IconStar so we don't import a new icon — the displays
  // page is conceptually adjacent to PBIS (signage / morale) so a
  // star reads fine as a generic "school-wide" icon.
  const displaysNavSections: NavSection[] = [
    { key: "displays", label: "Displays", icon: IconStar },
  ];
  const canManageBellSchedules =
    Boolean(authUser?.isSuperUser) ||
    isAdmin ||
    isMtss ||
    isBehaviorSpec;
  // Displays = digital-signage feature. Core team always has access;
  // teachers must be granted the per-staff capability flag by an admin
  // (cap_manage_displays). This mirrors the server's displays.ts gate.
  const canManageDisplays =
    Boolean(authUser?.isSuperUser) ||
    isAdmin ||
    isMtss ||
    isBehaviorSpec ||
    Boolean(authUser?.isDean) ||
    Boolean(authUser?.capManageDisplays);
  // canManageStaffRoles hoisted above the bounce-back useEffect — see note there.
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
    if (key === "issDashboard" && activePulloutCount > 0) {
      return <span style={badgeStyle}>{activePulloutCount}</span>;
    }
    if (key === "behaviorReview" && unreviewedPulloutCount > 0) {
      return <span style={badgeStyle}>{unreviewedPulloutCount}</span>;
    }
    if (key === "activeKiosks" && activeKiosks.length > 0) {
      return <span style={badgeStyle}>{activeKiosks.length}</span>;
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

  // Public, no-auth digital-signage routes. Smart TVs / hallway
  // kiosks open these URLs directly; we short-circuit BEFORE the
  // auth-redirect below so they never see a login screen.
  //   /display/<id>                → playlist cycler
  //   /display/passes/<schoolId>   → standalone active hall passes
  if (typeof window !== "undefined") {
    const path = window.location.pathname;
    const passesMatch = path.match(/^\/display\/passes\/(\d+)\/?$/);
    if (passesMatch) {
      return <HallPassDisplay schoolId={Number.parseInt(passesMatch[1], 10)} />;
    }
    const playlistMatch = path.match(/^\/display\/(\d+)\/?$/);
    if (playlistMatch) {
      return (
        <DisplayShow playlistId={Number.parseInt(playlistMatch[1], 10)} />
      );
    }
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
            Pulse<span className="accent">EDU</span>
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
          <SchoolSwitcher />
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
                await authFetch("/api/auth/logout", { method: "POST" });
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
        // Phase 1A nav restructure — Hall Pass + Tardy Pass are LOCKED at
        // the very top (muscle-memory items). Everything else is grouped
        // into themed sections (Recognition / Behavior Support / MTSS /
        // Special Programs / Family / People / School Admin). Each group
        // only renders if at least one item inside is visible to the
        // current user — no empty headers. activeSection keys are
        // unchanged, this is a cosmetic regrouping only.
        const showRecognition =
          effectiveFeatures.Pbis ||
          effectiveFeatures.SchoolStore ||
          canAccessPbisHub;
        const showBehaviorSupport =
          effectiveFeatures.LogIntervention ||
          effectiveFeatures.RequestPullout ||
          isBehaviorSpec ||
          canVerifyPullouts ||
          canViewIssDashboard ||
          canReviewPullouts ||
          (canManageBehaviorLists && !isBehaviorSpec);
        const showSpecialPrograms =
          effectiveFeatures.Accommodations || isEseCoord;
        const showSchoolAdmin = canManageBellSchedules || isAdmin;
        // Phase 2 polish — per-user namespace for the NavGroup accordion
        // localStorage so two staff sharing the same browser don't inherit
        // each other's collapse preferences. "anon" keeps unauthenticated
        // surfaces from blowing up the storage key.
        const sidebarUserId = String(authUser?.id ?? "anon");
        // People (Teacher Roster) is always rendered below the divider, so
        // the EKG always has content beneath it — render unconditionally.
        return (
          <aside className="sidebar">
            {/* Locked top — Hall Pass + Tardy Pass anchor the sidebar.
                Request Pullout and PBIS Points were promoted here per
                user request — they're high-frequency teacher actions
                so we surface them above the themed accordions. */}
            <div className="section-label">Quick Access</div>
            {renderNavItem({
              key: "hallPasses",
              label: "Hall Passes",
              icon: IconDoor,
            })}
            {renderNavItem({
              key: "tardies",
              label: "Tardy Pass",
              icon: IconClock,
            })}
            {/* Teacher Roster promoted to Quick Access — every teacher's
                daily landing for their students. Always visible (no
                feature flag); cross-teacher access still gated server-side. */}
            {renderNavItem({
              key: "teacherRoster",
              label: "Teacher Roster",
              icon: IconUser,
            })}
            {effectiveFeatures.RequestPullout &&
              renderNavItem({
                key: "requestPullout",
                label: "Request Pullout",
                icon: IconClipboard,
              })}
            {effectiveFeatures.Pbis &&
              renderNavItem({
                key: "pbis",
                label: "PBIS Points",
                icon: IconStar,
              })}
            {effectiveFeatures.Accommodations &&
              renderNavItem({
                key: "accommodations",
                label: "Accommodations",
                icon: IconClipboard,
              })}
            {/* Verify Pullout — surfaces in Quick Access ONLY when there's
                pending work (pendingPulloutCount > 0). When the queue is
                empty it retreats to its quiet home in Behavior Support.
                Without this promotion the badge sits inside a collapsed
                accordion and verifiers never see it. The Behavior Support
                copy is hidden when count > 0 so the item never duplicates. */}
            {canVerifyPullouts && pendingPulloutCount > 0 &&
              renderNavItem({
                key: "verifyPullouts",
                label: "Verify Pullout",
                icon: IconClipboard,
              })}
            {/* Active Kiosks moved out of Quick Access into School Admin
                (admin-only operational monitoring lives with the other
                admin tools — Bell Schedule, Settings). */}
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
            {canActAsDistrict && (
              <NavGroup
                key={`${sidebarUserId}-administration`}
                id="administration"
                label="Administration"
                userId={sidebarUserId}
                containsActive={groupContainsActive(
                  "administration",
                  activeSection,
                )}
              >
                {isSuperUser &&
                  renderNavItem({
                    key: "superUserHome",
                    label: "SuperUser Home",
                    icon: IconClipboard,
                  })}
                {renderNavItem({
                  key: "districtAdmin",
                  label: "District Overview",
                  icon: IconClipboard,
                })}
              </NavGroup>
            )}
            {/* Insights group is visible to anyone signed in — Watchlist
                is the universal default landing. The legacy InsightsHub
                (rule-builder + MTSS launcher tiles) stays gated to
                core-team via canAccessMtssHub. */}
            <NavGroup
              key={`${sidebarUserId}-insights`}
              id="insights"
              label="Insights"
              userId={sidebarUserId}
              containsActive={groupContainsActive("insights", activeSection)}
            >
              {renderNavItem({
                key: "insightsWatchlist",
                label: "Watch List",
                icon: IconClipboard,
              })}
              {/* Personal "kids on my mind" list — separate from the
                  data-driven system Watch List above. Visible to anyone
                  who can see the system list (same student-visibility
                  scope governs both); the server scopes entries to the
                  caller. */}
              {renderNavItem({
                key: "myWatchList",
                label: "My Watch List",
                icon: IconClipboard,
              })}
              {canAccessMtssHub &&
                renderNavItem({
                  key: "insights",
                  label: "Insights Hub",
                  icon: IconClipboard,
                })}
            </NavGroup>
            {showRecognition && (
              <NavGroup
                key={`${sidebarUserId}-recognition`}
                id="recognition"
                label="Recognition"
                userId={sidebarUserId}
                containsActive={groupContainsActive("recognition", activeSection)}
              >
                {/* PBIS Points was promoted to Quick Access — kept out
                    of Recognition to avoid duplication. */}
                {effectiveFeatures.SchoolStore &&
                  renderNavItem({
                    key: "schoolStore",
                    label: "School Store",
                    icon: IconStar,
                  })}
                {canAccessPbisHub && pbisHubNavSections.map(renderNavItem)}
              </NavGroup>
            )}
            {showBehaviorSupport && (
              <NavGroup
                key={`${sidebarUserId}-behaviorSupport`}
                id="behaviorSupport"
                label="Behavior Support"
                userId={sidebarUserId}
                containsActive={groupContainsActive(
                  "behaviorSupport",
                  activeSection,
                )}
              >
                {effectiveFeatures.LogIntervention &&
                  renderNavItem({
                    key: "logIntervention",
                    label: "Log Intervention",
                    icon: IconClipboard,
                  })}
                {/* Request Pullout was promoted to Quick Access — kept
                    out of Behavior Support to avoid duplication. */}
                {isBehaviorSpec &&
                  behaviorSpecNavSections.map(renderNavItem)}
                {canManageBehaviorLists && !isBehaviorSpec &&
                  interventionsNavSections.map(renderNavItem)}
                {/* Hidden here when there's pending work because Verify
                    Pullout gets promoted to Quick Access in that case
                    (avoiding a duplicate nav item). Still visible here
                    when the queue is empty, for spot-checks. */}
                {canVerifyPullouts && pendingPulloutCount === 0 &&
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
              </NavGroup>
            )}
            {/* Phase 2: legacy "MTSS & Plans" sidebar group retired —
                Plans now lives under Insights → Plans. The mtssCoordinator
                page itself is still reachable as a target of the Insights
                Plans tile (via the mtssPlans render branch), so existing
                deep links keep working. */}
            {showSpecialPrograms && (
              <NavGroup
                key={`${sidebarUserId}-specialPrograms`}
                id="specialPrograms"
                label="Special Programs"
                userId={sidebarUserId}
                containsActive={groupContainsActive(
                  "specialPrograms",
                  activeSection,
                )}
              >
                {/* Accommodations was promoted to Quick Access — kept
                    out of Special Programs to avoid duplication. */}
                {isEseCoord && eseNavSections.map(renderNavItem)}
              </NavGroup>
            )}
            {(effectiveFeatures.FamilyComm || canManageSettings) && (
              <NavGroup
                key={`${sidebarUserId}-family`}
                id="family"
                label="Family"
                userId={sidebarUserId}
                containsActive={groupContainsActive("family", activeSection)}
              >
                {effectiveFeatures.FamilyComm &&
                  renderNavItem({
                    key: "student",
                    label: "Family Communication",
                    icon: IconUser,
                  })}
                {canManageSettings &&
                  renderNavItem({
                    key: "parentAccess",
                    label: "Parent Access",
                    icon: IconUser,
                  })}
              </NavGroup>
            )}
            {/* People accordion removed — Teacher Roster lives in
                Quick Access and Staff & Roles moved into School Admin
                below (next to the other admin tools). */}
            {showSchoolAdmin && (
              <NavGroup
                key={`${sidebarUserId}-schoolAdmin`}
                id="schoolAdmin"
                label="School Admin"
                userId={sidebarUserId}
                containsActive={groupContainsActive(
                  "schoolAdmin",
                  activeSection,
                )}
              >
                {(isAdmin || canManageStaffRoles) &&
                  renderNavItem(adminNavSections[0])}
                {canManageBellSchedules &&
                  bellScheduleNavSections.map(renderNavItem)}
                {canManageDisplays && displaysNavSections.map(renderNavItem)}
                {canAccessMtssHub &&
                  renderNavItem({
                    key: "trustedAdultsAdmin",
                    label: "Trusted Adults",
                    icon: IconUser,
                  })}
                {canManageSettings &&
                  renderNavItem({
                    key: "activeKiosks",
                    label: "Active Kiosks",
                    icon: IconClipboard,
                  })}
                {isAdmin && renderNavItem(adminNavSections[1])}
              </NavGroup>
            )}
          </aside>
        );
      })()}

      <main className="app-main">

      {activeSection === "hallPasses" && (<>
      {(authUser?.isAdmin || authUser?.isSuperUser || authUser?.isEseCoordinator) && (
        <div className="card no-print" style={{ paddingTop: "0.75rem", paddingBottom: "0.75rem" }}>
          <button
            type="button"
            onClick={() => setHpView("overview")}
            disabled={hpView === "overview"}
            style={{ marginRight: "0.25rem" }}
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => {
              setHpView("reports");
              setHpReportSection("hub");
            }}
            disabled={hpView === "reports"}
          >
            Reports
          </button>
        </div>
      )}
      {hpView === "overview" && (<>
      {/* Create Pass CTA pinned to the top of the overview so it's
          reachable on mobile without scrolling past the stats grid.
          Previously sat below the stats — fine on desktop, awkward on
          a narrow viewport where the stats stack into a tall column. */}
      <div className="card cp-cta-card">
        <div className="cp-cta-text">Need to Create a Pass?</div>
        <button
          type="button"
          className="cp-cta-button cp-cta-button--blue"
          onClick={() => setCreatePassOpen(true)}
        >
          <svg viewBox="0 0 170 120" fill="currentColor" aria-hidden="true">
            <path d="M5,85 C5,108 38,113 60,107 C75,103 80,100 80,85 C80,68 73,65 58,62 C36,57 5,62 5,85 Z" />
            <circle cx="90" cy="68" r="9" />
            <circle cx="98" cy="78" r="7.5" />
            <circle cx="100" cy="88" r="6.5" />
            <circle cx="97" cy="97" r="5.5" />
            <circle cx="90" cy="105" r="4.5" />
            <path d="M75,35 C75,58 108,63 130,57 C145,53 150,50 150,35 C150,18 143,15 128,12 C106,7 75,12 75,35 Z" />
            <circle cx="160" cy="18" r="9" />
            <circle cx="168" cy="28" r="7.5" />
            <circle cx="170" cy="38" r="6.5" />
            <circle cx="167" cy="47" r="5.5" />
            <circle cx="160" cy="55" r="4.5" />
          </svg>
          Create Pass
        </button>
      </div>
      {(() => {
        let active = 0;
        let overdue = 0;
        let ended = 0;
        const today = new Date();
        for (const p of hallPasses) {
          const created = new Date(p.createdAt);
          const isToday =
            created.getFullYear() === today.getFullYear() &&
            created.getMonth() === today.getMonth() &&
            created.getDate() === today.getDate();
          if (!isToday) continue;
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
          <>
            <div
              style={{
                borderTopLeftRadius: "var(--radius-lg, 8px)",
                borderTopRightRadius: "var(--radius-lg, 8px)",
                overflow: "hidden",
                marginBottom: "-1px",
              }}
            >
              <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
              <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }} />
            </div>
          <div className="card">
            <h2
              style={{
                margin: 0,
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "#7c3aed",
              }}
            >
              Hall Pass Summary
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr 1fr",
                gap: "1rem",
                alignItems: "stretch",
              }}
            >
              <div
                style={{
                  background: "white",
                  border: "1px solid #e2e8f0",
                  borderRadius: 16,
                  padding: "1.25rem 1.5rem",
                  boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  minHeight: 200,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "1rem",
                  }}
                >
                  <div
                    style={{
                      fontSize: "1.5rem",
                      fontWeight: 800,
                      color: "#1e1b4b",
                      lineHeight: 1.15,
                    }}
                  >
                    Active Hall Passes
                  </div>
                  <div style={{ fontSize: "1.75rem" }} aria-hidden>
                    🚶
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "1rem",
                    marginTop: "1rem",
                  }}
                >
                  <div
                    style={{
                      fontSize: "3.25rem",
                      fontWeight: 700,
                      color: "#94a3b8",
                      lineHeight: 1,
                    }}
                  >
                    {active}
                  </div>
                  <button
                    type="button"
                    onClick={() => window.print()}
                    style={{
                      flex: 1,
                      background: "#10b981",
                      border: "none",
                      borderRadius: 12,
                      color: "white",
                      fontWeight: 600,
                      fontSize: "1rem",
                      padding: "0.85rem 1rem",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "0.5rem",
                    }}
                  >
                    <span aria-hidden>🖨️</span>
                    Report of Students
                  </button>
                </div>
              </div>
              <div className="stat-card stat-overdue">
                <span
                  className="stat-label"
                  style={{
                    fontSize: "1.5rem",
                    fontWeight: 800,
                    color: "#1e1b4b",
                    lineHeight: 1.15,
                  }}
                >
                  Overdue Passes
                </span>
                <span className="stat-value">{overdue}</span>
              </div>
              <div className="stat-card stat-ended">
                <span
                  className="stat-label"
                  style={{
                    fontSize: "1.5rem",
                    fontWeight: 800,
                    color: "#1e1b4b",
                    lineHeight: 1.15,
                  }}
                >
                  Ended Passes
                </span>
                <span className="stat-value">{ended}</span>
              </div>
            </div>
          </div>
          </>
        );
      })()}

      {/* Create Pass CTA was here — moved to the top of the overview
          so it's tappable on mobile without scrolling past the stats. */}

      <CreatePassModal
        open={createPassOpen}
        onClose={() => setCreatePassOpen(false)}
        students={students}
        destinationsByRoom={effectiveDestinationsByRoom}
        defaultOriginRoom={originRoom || (staffDefaults[currentStaffUser] ?? "")}
        currentStaffUser={currentStaffUser}
        staffUsers={staffUsers}
        staffDefaults={staffDefaults}
        canChangeTeacher={Boolean(authUser?.isAdmin || authUser?.isSuperUser)}
        nearDestinations={teacherAllowlistMap[currentStaffUser] ?? []}
        bypassContactAck={Boolean(authUser?.isAdmin || authUser?.isSuperUser)}
        maxMinutes={schoolSettings.hallPassMaxMinutes}
        defaultMinutes={schoolSettings.hallPassDefaultMinutes}
        onCreate={async (payload) => {
          const res = await authFetch("/api/hall-passes", {
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
                  const bg = p.isTardyReturn
                    ? "#ede9fe"
                    : getTimeStatusColor(p, now);
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
                        border: p.isTardyReturn
                          ? "1px solid #c4b5fd"
                          : "1px solid var(--border)",
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
                          {p.isTardyReturn && (
                            <span
                              style={{
                                marginLeft: 6,
                                padding: "1px 6px",
                                borderRadius: 4,
                                background: "#a78bfa",
                                color: "white",
                                fontWeight: 700,
                                fontSize: 10,
                                letterSpacing: 0.5,
                              }}
                            >
                              TARDY
                            </span>
                          )}
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
                  const isAdmin =
                    authUser?.isAdmin === true ||
                    authUser?.isSuperUser === true;
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
      {hpView === "reports" && (authUser?.isAdmin || authUser?.isSuperUser || authUser?.isEseCoordinator) && hpReportSection === "hub" && (() => {
        type ReportTool = {
          key: "overview" | "byDay";
          label: string;
          desc: string;
          color: string;
        };
        const reports: ReportTool[] = [
          {
            key: "overview",
            label: "Overview",
            desc: "School-wide hall pass metrics at a glance.",
            color: "#0d9488",
          },
          {
            key: "byDay",
            label: "Daily Hall Pass Report",
            desc: "Lost instructional minutes, totals, and per-student breakdown for a single day.",
            color: "#1d4ed8",
          },
          {
            key: "ytd",
            label: "Year to Date Summary",
            desc: "Daily pass volume since January 1, broken down by grade.",
            color: "#a855f7",
          },
          {
            key: "research",
            label: "Research",
            desc: "Filterable list of every pass with student, origin, destination, time and duration.",
            color: "#0ea5e9",
          },
        ];
        return (
          <>
            <div
              style={{
                borderTopLeftRadius: "var(--radius-lg, 8px)",
                borderTopRightRadius: "var(--radius-lg, 8px)",
                overflow: "hidden",
                marginBottom: "-1px",
              }}
            >
              <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
              <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
                <h2
                  style={{
                    margin: 0,
                    color: "white",
                    fontSize: "1.5rem",
                    fontWeight: 700,
                  }}
                >
                  Hall Pass Reports
                </h2>
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
              {reports.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setHpReportSection(r.key)}
                  style={{
                    textAlign: "left",
                    background: "white",
                    border: `1px solid ${r.color}33`,
                    borderLeft: `4px solid ${r.color}`,
                    borderRadius: 8,
                    padding: "0.85rem 1rem",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <span style={{ fontWeight: 600, color: r.color }}>
                    {r.label}
                  </span>
                  <span style={{ color: "#475569", fontSize: "0.85rem" }}>
                    {r.desc}
                  </span>
                </button>
              ))}
            </div>
          </>
        );
      })()}

      {hpView === "reports" && (authUser?.isAdmin || authUser?.isSuperUser || authUser?.isEseCoordinator) && hpReportSection === "overview" && (() => {
        // Build a time series of concurrently-active passes for the selected day,
        // every 15 minutes from 7:00 AM to 4:00 PM local time.
        const [yy, mm, dd] = hpOverviewDate.split("-").map((n) => parseInt(n, 10));
        const today = new Date(yy, (mm || 1) - 1, dd || 1);
        const dayStr = hpOverviewDate;
        const isSameLocalDay = (iso: string) => {
          const d = new Date(iso);
          return (
            d.getFullYear() === today.getFullYear() &&
            d.getMonth() === today.getMonth() &&
            d.getDate() === today.getDate()
          );
        };
        const todaysPasses = hallPasses.filter((p) => isSameLocalDay(p.createdAt));
        const buckets: { label: string; t: number; count: number }[] = [];
        const base = new Date(today);
        base.setHours(7, 0, 0, 0);
        const end = new Date(today);
        end.setHours(16, 0, 0, 0);
        for (let t = base.getTime(); t <= end.getTime(); t += 15 * 60 * 1000) {
          const d = new Date(t);
          const hr = d.getHours();
          const mn = d.getMinutes();
          const h12 = ((hr + 11) % 12) + 1;
          const ampm = hr < 12 ? "AM" : "PM";
          const label = mn === 0 ? `${h12}:00 ${ampm}` : "";
          let count = 0;
          for (const p of todaysPasses) {
            const start = new Date(p.createdAt).getTime();
            const stop = p.endedAt ? new Date(p.endedAt).getTime() : Date.now();
            if (start <= t && t < stop) count++;
          }
          buckets.push({ label, t, count });
        }
        const peak = buckets.reduce((m, b) => Math.max(m, b.count), 0);
        return (
          <>
            <div
              style={{
                borderTopLeftRadius: "var(--radius-lg, 8px)",
                borderTopRightRadius: "var(--radius-lg, 8px)",
                overflow: "hidden",
                marginBottom: "-1px",
              }}
            >
              <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
              <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
                <button
                  type="button"
                  className="back-button-purple"
                  style={{ marginBottom: 0 }}
                  onClick={() => setHpReportSection("hub")}
                >
                  ← Back
                </button>
              </div>
            </div>
            <div className="card">
              <h2
                style={{
                  margin: 0,
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: "#7c3aed",
                }}
              >
                Overview
                <input
                  type="date"
                  value={hpOverviewDate}
                  onChange={(e) => setHpOverviewDate(e.target.value)}
                  style={{
                    marginLeft: "0.75rem",
                    fontSize: "0.85rem",
                    fontWeight: 400,
                    padding: "0.25rem 0.5rem",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    color: "#334155",
                  }}
                />
              </h2>
            </div>

            <div className="card">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "0.75rem",
                }}
              >
                <h3 style={{ margin: 0 }}>Pass Usage</h3>
                <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                  Peak concurrent: <strong>{peak}</strong>
                </div>
              </div>
              {todaysPasses.length === 0 ? (
                <div style={{ color: "#64748b", padding: "1rem 0" }}>
                  No passes recorded today.
                </div>
              ) : (
                <div style={{ width: "100%", height: 320 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={buckets}
                      margin={{ top: 10, right: 20, left: 10, bottom: 30 }}
                    >
                      <defs>
                        <linearGradient id="passUsageFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity={0.55} />
                          <stop offset="100%" stopColor="#22c55e" stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        interval={0}
                        tick={{ fontSize: 11, fill: "#64748b" }}
                        angle={-35}
                        textAnchor="end"
                        height={50}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 11, fill: "#64748b" }}
                        label={{
                          value: "Number of active passes",
                          angle: -90,
                          position: "insideLeft",
                          style: { fill: "#1d4ed8", fontSize: 12 },
                        }}
                      />
                      <Tooltip
                        labelFormatter={(_, payload) => {
                          const p = payload && payload[0]?.payload;
                          if (!p) return "";
                          const d = new Date(p.t);
                          return d.toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          });
                        }}
                        formatter={(v: number) => [v, "Active passes"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="count"
                        stroke="#16a34a"
                        strokeWidth={3}
                        fill="url(#passUsageFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                  <div
                    style={{
                      textAlign: "center",
                      color: "#1d4ed8",
                      fontSize: "0.9rem",
                      marginTop: "-0.25rem",
                    }}
                  >
                    Time
                  </div>
                </div>
              )}
            </div>

            {(() => {
              const counts = new Map<string, number>();
              let totalMs = 0;
              let endedCount = 0;
              for (const p of hallPasses) {
                if (p.destination) {
                  counts.set(p.destination, (counts.get(p.destination) || 0) + 1);
                }
                if (p.endedAt && p.createdAt) {
                  const dur =
                    new Date(p.endedAt).getTime() - new Date(p.createdAt).getTime();
                  if (dur > 0) {
                    totalMs += dur;
                    endedCount++;
                  }
                }
              }
              const top = Array.from(counts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5);
              const avgMin = endedCount > 0 ? totalMs / endedCount / 60000 : 0;
              return (
                <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                <div
                  className="card"
                  style={{ width: "33%", minWidth: 280, marginBottom: 0 }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      marginBottom: "0.5rem",
                      gap: "0.5rem",
                    }}
                  >
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>
                      Most Frequent Room Destinations
                    </h3>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        color: "#64748b",
                        letterSpacing: "0.08em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      ALL TIME
                    </span>
                  </div>
                  {top.length === 0 ? (
                    <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                      No pass destinations yet.
                    </div>
                  ) : (
                    <ol
                      style={{
                        margin: 0,
                        padding: 0,
                        listStyle: "none",
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: "0.35rem 1rem",
                        fontSize: "0.9rem",
                        color: "#475569",
                      }}
                    >
                      {top.map(([name, n], i) => (
                        <li key={name}>
                          {i + 1}. {name}{" "}
                          <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>
                            ({n})
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>

                <div
                  className="card"
                  style={{ width: "33%", minWidth: 280, marginBottom: 0 }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      marginBottom: "0.5rem",
                      gap: "0.5rem",
                    }}
                  >
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>
                      Average Pass Time
                    </h3>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        color: "#64748b",
                        letterSpacing: "0.08em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      ALL TIME
                    </span>
                  </div>
                  {endedCount === 0 ? (
                    <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                      No completed passes yet.
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: "1.75rem",
                        color: "#94a3b8",
                        fontWeight: 500,
                      }}
                    >
                      {avgMin.toFixed(1)} minutes
                    </div>
                  )}
                </div>

                {(() => {
                  const overdueByStudent = new Map<string, number>();
                  for (const p of todaysPasses) {
                    if (!p.endedAt || !p.createdAt) continue;
                    const dur =
                      (new Date(p.endedAt).getTime() -
                        new Date(p.createdAt).getTime()) /
                      60000;
                    if (dur > p.maxDurationMinutes) {
                      overdueByStudent.set(
                        p.studentId,
                        (overdueByStudent.get(p.studentId) || 0) + 1,
                      );
                    }
                  }
                  const reported = Array.from(overdueByStudent.entries()).sort(
                    (a, b) => b[1] - a[1],
                  );
                  return (
                    <div
                      className="card"
                      style={{ width: "33%", minWidth: 280, marginBottom: 0 }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "0.5rem",
                          gap: "0.5rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                          }}
                        >
                          <span style={{ fontSize: "1.1rem" }}>🚩</span>
                          <h3 style={{ margin: 0, fontSize: "1rem" }}>
                            Reported Students
                          </h3>
                        </div>
                        <span style={{ fontSize: "1rem", color: "#1e3a8a" }}>
                          🏴
                        </span>
                      </div>
                      {reported.length === 0 ? (
                        <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>
                          No Reported Students Today.
                        </div>
                      ) : (
                        <ol
                          style={{
                            margin: 0,
                            paddingLeft: "1.1rem",
                            fontSize: "0.9rem",
                            color: "#475569",
                            display: "grid",
                            gap: "0.25rem",
                            maxHeight: 160,
                            overflowY: "auto",
                          }}
                        >
                          {reported.map(([sid, n]) => (
                            <li key={sid}>
                              {studentName(sid)}{" "}
                              <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>
                                ({n} overdue)
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  );
                })()}
                </div>
              );
            })()}

          </>
        );
      })()}

      {hpView === "reports" && (authUser?.isAdmin || authUser?.isSuperUser || authUser?.isEseCoordinator) && hpReportSection === "ytd" && (() => {
        const today = new Date();
        const studentGrade = new Map<string, number>();
        for (const s of students) studentGrade.set(s.studentId, s.grade);
        const grades = Array.from(new Set(students.map((s) => s.grade))).sort(
          (a, b) => a - b,
        );
        const gradeColors = ["#0f766e", "#0e7490", "#6366f1", "#7c3aed", "#0ea5e9", "#a855f7"];

        const yearStart = new Date(today.getFullYear(), 0, 1);
        const dayMs = 24 * 60 * 60 * 1000;
        const days: { key: string; label: string; t: number }[] = [];
        for (let t = yearStart.getTime(); t <= today.getTime(); t += dayMs) {
          const d = new Date(t);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const label = d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
          days.push({ key, label, t });
        }

        const series = days.map((d) => {
          const row: Record<string, number | string> = { date: d.label };
          for (const g of grades) row[`G${g}`] = 0;
          return row;
        });
        const indexByKey = new Map(days.map((d, i) => [d.key, i]));

        let totalYtd = 0;
        for (const p of hallPasses) {
          const dt = new Date(p.createdAt);
          if (dt.getFullYear() !== today.getFullYear()) continue;
          if (dt.getTime() > today.getTime() + dayMs) continue;
          const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
          const idx = indexByKey.get(key);
          if (idx == null) continue;
          const g = studentGrade.get(p.studentId);
          if (g == null) continue;
          series[idx][`G${g}`] = (series[idx][`G${g}`] as number) + 1;
          totalYtd++;
        }

        return (
          <>
            <div
              style={{
                borderTopLeftRadius: "var(--radius-lg, 8px)",
                borderTopRightRadius: "var(--radius-lg, 8px)",
                overflow: "hidden",
                marginBottom: "-1px",
              }}
            >
              <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
              <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
                <button
                  type="button"
                  className="back-button-purple"
                  style={{ marginBottom: 0 }}
                  onClick={() => setHpReportSection("hub")}
                >
                  ← Back
                </button>
              </div>
            </div>
            <div className="card">
              <h2
                style={{
                  margin: 0,
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: "#7c3aed",
                }}
              >
                Year to Date Summary
                <span style={{ marginLeft: "0.75rem", fontSize: "0.85rem", color: "#64748b", fontWeight: 400 }}>
                  {today.getFullYear()}
                </span>
              </h2>
            </div>

            <div className="card">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "0.75rem",
                }}
              >
                <h3 style={{ margin: 0 }}>Daily Passes</h3>
                <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                  Total passes YTD: <strong>{totalYtd.toLocaleString()}</strong>
                </div>
              </div>
              {totalYtd === 0 ? (
                <div style={{ color: "#64748b", padding: "1rem 0" }}>
                  No passes recorded this year yet.
                </div>
              ) : (
                <div style={{ width: "100%", height: 340 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={series}
                      margin={{ top: 10, right: 20, left: 10, bottom: 40 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11, fill: "#64748b" }}
                        interval={Math.max(0, Math.floor(series.length / 20))}
                        angle={-35}
                        textAnchor="end"
                        height={60}
                      />
                      <YAxis tick={{ fontSize: 11, fill: "#64748b" }} allowDecimals={false} />
                      <Tooltip />
                      <Legend />
                      {grades.map((g, i) => (
                        <Line
                          key={g}
                          type="monotone"
                          dataKey={`G${g}`}
                          name={`Grade ${String(g).padStart(2, "0")}`}
                          stroke={gradeColors[i % gradeColors.length]}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {(() => {
              const studentInfo = new Map<
                string,
                { name: string; grade: number }
              >();
              for (const s of students) {
                studentInfo.set(s.studentId, {
                  name: `${s.firstName} ${s.lastName}`,
                  grade: s.grade,
                });
              }

              const byGrade = new Map<number, number>();
              const byStudent = new Map<string, number>();
              for (const p of hallPasses) {
                const dt = new Date(p.createdAt);
                if (dt.getFullYear() !== today.getFullYear()) continue;
                const info = studentInfo.get(p.studentId);
                if (!info) continue;
                byGrade.set(info.grade, (byGrade.get(info.grade) || 0) + 1);
                byStudent.set(p.studentId, (byStudent.get(p.studentId) || 0) + 1);
              }

              const gradeBars = grades.map((g) => ({
                name: `Grade ${String(g).padStart(2, "0")}`,
                grade: g,
                total: byGrade.get(g) || 0,
              }));

              type ScatterPoint = {
                x: number;
                y: number;
                grade: number;
                name: string;
              };
              const scatterByGrade = new Map<number, ScatterPoint[]>();
              for (const g of grades) scatterByGrade.set(g, []);
              const stableJitter = (key: string) => {
                let h = 2166136261;
                for (let i = 0; i < key.length; i++) {
                  h ^= key.charCodeAt(i);
                  h = Math.imul(h, 16777619);
                }
                return (((h >>> 0) % 1000) / 1000 - 0.5) * 0.8;
              };
              for (const [sid, count] of byStudent.entries()) {
                const info = studentInfo.get(sid);
                if (!info) continue;
                const arr = scatterByGrade.get(info.grade);
                if (!arr) continue;
                arr.push({
                  x: info.grade + stableJitter(sid),
                  y: count,
                  grade: info.grade,
                  name: info.name,
                });
              }

              const ScatterTooltip = ({ active, payload }: any) => {
                if (!active || !payload || !payload.length) return null;
                const items = payload
                  .map((p: any) => p && p.payload)
                  .filter(Boolean) as ScatterPoint[];
                const seen = new Set<string>();
                const unique = items.filter((p) => {
                  if (seen.has(p.name)) return false;
                  seen.add(p.name);
                  return true;
                });
                return (
                  <div
                    style={{
                      background: "white",
                      border: "1px solid #cbd5e1",
                      borderRadius: 6,
                      padding: "0.5rem 0.75rem",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                      fontSize: "0.85rem",
                      color: "#1e293b",
                    }}
                  >
                    {unique.map((p) => (
                      <div key={p.name}>
                        <strong>{p.name}</strong>: {p.y} passes
                      </div>
                    ))}
                  </div>
                );
              };

              return (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "1rem",
                  }}
                >
                  <div className="card" style={{ marginBottom: 0 }}>
                    <h3 style={{ margin: "0 0 0.75rem 0" }}>
                      Total Passes by Grade
                    </h3>
                    <div style={{ width: "100%", height: 320 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={gradeBars}
                          margin={{ top: 10, right: 20, left: 10, bottom: 20 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis
                            dataKey="name"
                            tick={{ fontSize: 12, fill: "#64748b" }}
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: "#64748b" }}
                            allowDecimals={false}
                          />
                          <Tooltip />
                          <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                            {gradeBars.map((entry, i) => (
                              <Cell
                                key={entry.grade}
                                fill={gradeColors[grades.indexOf(entry.grade) % gradeColors.length] || gradeColors[i % gradeColors.length]}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="card" style={{ marginBottom: 0 }}>
                    <h3 style={{ margin: "0 0 0.75rem 0" }}>
                      Total Passes by Student
                    </h3>
                    <div style={{ width: "100%", height: 320 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart
                          margin={{ top: 10, right: 20, left: 10, bottom: 20 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis
                            type="number"
                            dataKey="x"
                            domain={[
                              Math.min(...grades) - 0.5,
                              Math.max(...grades) + 0.5,
                            ]}
                            ticks={grades}
                            tickFormatter={(v) => String(v).padStart(2, "0")}
                            tick={{ fontSize: 12, fill: "#64748b" }}
                          />
                          <YAxis
                            type="number"
                            dataKey="y"
                            tick={{ fontSize: 11, fill: "#64748b" }}
                            label={{
                              value: "Total Passes",
                              angle: -90,
                              position: "insideLeft",
                              style: { fontSize: 11, fill: "#64748b" },
                            }}
                          />
                          <ZAxis range={[60, 60]} />
                          <Tooltip
                            cursor={{ strokeDasharray: "3 3" }}
                            content={<ScatterTooltip />}
                          />
                          {grades.map((g, i) => (
                            <Scatter
                              key={g}
                              name={`Grade ${String(g).padStart(2, "0")}`}
                              data={scatterByGrade.get(g) || []}
                              fill={gradeColors[i % gradeColors.length]}
                            />
                          ))}
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              );
            })()}

            {(() => {
              const studentInfo = new Map<
                string,
                { first: string; last: string; grade: number }
              >();
              for (const s of students) {
                studentInfo.set(s.studentId, {
                  first: s.firstName,
                  last: s.lastName,
                  grade: s.grade,
                });
              }
              const stats = new Map<
                string,
                { passes: number; autoEnded: number; lostMin: number }
              >();
              for (const p of hallPasses) {
                const dt = new Date(p.createdAt);
                if (dt.getFullYear() !== today.getFullYear()) continue;
                if (!studentInfo.has(p.studentId)) continue;
                const cur = stats.get(p.studentId) || {
                  passes: 0,
                  autoEnded: 0,
                  lostMin: 0,
                };
                cur.passes++;
                if (p.endedAt) {
                  const durMin =
                    (new Date(p.endedAt).getTime() -
                      new Date(p.createdAt).getTime()) /
                    60000;
                  if (durMin >= p.maxDurationMinutes) cur.autoEnded++;
                  if (durMin > 0) cur.lostMin += durMin;
                }
                stats.set(p.studentId, cur);
              }
              const rows = Array.from(stats.entries())
                .map(([sid, v]) => {
                  const info = studentInfo.get(sid)!;
                  return {
                    sid,
                    first: info.first,
                    last: info.last,
                    grade: info.grade,
                    passes: v.passes,
                    autoEnded: v.autoEnded,
                    lostMin: Math.round(v.lostMin),
                  };
                })
                .sort((a, b) => b.passes - a.passes);

              return (
                <>
                  <svg
                    className="ekg-separator"
                    viewBox="0 0 600 28"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path
                      className="track"
                      d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
                    />
                  </svg>
                <div className="card">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <h3 style={{ margin: 0 }}>All Frequent Flyers</h3>
                    <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                      {rows.length.toLocaleString()} students with passes YTD
                    </div>
                  </div>
                  {rows.length === 0 ? (
                    <div style={{ color: "#64748b", padding: "1rem 0" }}>
                      No passes recorded this year yet.
                    </div>
                  ) : (
                    <div style={{ maxHeight: 480, overflow: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: "0.9rem",
                        }}
                      >
                        <thead
                          style={{
                            position: "sticky",
                            top: 0,
                            background: "#f1f5f9",
                            color: "#64748b",
                            textAlign: "left",
                          }}
                        >
                          <tr>
                            <th style={{ padding: "0.6rem 0.75rem" }}>First Name</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Last Name</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Grade</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Student ID</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Passes</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Passes Auto Ended</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Lost Instructional Min</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr
                              key={r.sid}
                              style={{ borderTop: "1px solid #e2e8f0" }}
                            >
                              <td style={{ padding: "0.55rem 0.75rem" }}>{r.first}</td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>{r.last}</td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>
                                {String(r.grade).padStart(2, "0")}
                              </td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>{r.sid}</td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>{r.passes}</td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>{r.autoEnded}</td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>
                                {r.lostMin.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                </>
              );
            })()}

            {(() => {
              const fromCounts = new Map<string, number>();
              const toCounts = new Map<string, number>();
              for (const p of hallPasses) {
                const dt = new Date(p.createdAt);
                if (dt.getFullYear() !== today.getFullYear()) continue;
                if (p.originRoom) {
                  fromCounts.set(
                    p.originRoom,
                    (fromCounts.get(p.originRoom) || 0) + 1,
                  );
                }
                if (p.destination) {
                  toCounts.set(
                    p.destination,
                    (toCounts.get(p.destination) || 0) + 1,
                  );
                }
              }
              const allNames = new Set<string>([
                ...fromCounts.keys(),
                ...toCounts.keys(),
              ]);
              const rows = Array.from(allNames)
                .map((name) => ({
                  name,
                  from: fromCounts.get(name) || 0,
                  to: toCounts.get(name) || 0,
                }))
                .sort((a, b) => b.from + b.to - (a.from + a.to));

              return (
                <>
                  <svg
                    className="ekg-separator"
                    viewBox="0 0 600 28"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path
                      className="track"
                      d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
                    />
                  </svg>
                <div className="card">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <h3 style={{ margin: 0 }}>Room Usage</h3>
                    <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                      {rows.length} rooms
                    </div>
                  </div>
                  {rows.length === 0 ? (
                    <div style={{ color: "#64748b", padding: "1rem 0" }}>
                      No room activity this year yet.
                    </div>
                  ) : (
                    <div style={{ maxHeight: 480, overflow: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: "0.9rem",
                        }}
                      >
                        <thead
                          style={{
                            position: "sticky",
                            top: 0,
                            background: "#f1f5f9",
                            color: "#64748b",
                            textAlign: "left",
                          }}
                        >
                          <tr>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Room Name</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>
                              Passes From This Room
                            </th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>
                              Passes To This Room
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr
                              key={r.name}
                              style={{ borderTop: "1px solid #e2e8f0" }}
                            >
                              <td style={{ padding: "0.55rem 0.75rem" }}>
                                {r.name}
                              </td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>
                                {r.from.toLocaleString()}
                              </td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>
                                {r.to.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                </>
              );
            })()}

            {(() => {
              const fromCounts = new Map<string, number>();
              const toCounts = new Map<string, number>();
              for (const p of hallPasses) {
                const dt = new Date(p.createdAt);
                if (dt.getFullYear() !== today.getFullYear()) continue;
                if (p.teacherName) {
                  fromCounts.set(
                    p.teacherName,
                    (fromCounts.get(p.teacherName) || 0) + 1,
                  );
                }
                if (p.destinationTeacher) {
                  toCounts.set(
                    p.destinationTeacher,
                    (toCounts.get(p.destinationTeacher) || 0) + 1,
                  );
                }
              }
              const splitName = (full: string) => {
                const parts = full.trim().split(/\s+/);
                if (parts.length === 1) return { first: parts[0], last: "" };
                return {
                  first: parts[0],
                  last: parts.slice(1).join(" "),
                };
              };
              const allNames = new Set<string>([
                ...fromCounts.keys(),
                ...toCounts.keys(),
              ]);
              const rows = Array.from(allNames)
                .map((name) => {
                  const { first, last } = splitName(name);
                  return {
                    name,
                    first,
                    last,
                    fromRoom: fromCounts.get(name) || 0,
                    toRoom: toCounts.get(name) || 0,
                  };
                })
                .sort((a, b) => b.fromRoom + b.toRoom - (a.fromRoom + a.toRoom));

              return (
                <>
                  <svg
                    className="ekg-separator"
                    viewBox="0 0 600 28"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path
                      className="track"
                      d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
                    />
                  </svg>
                <div className="card">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <h3 style={{ margin: 0 }}>Staff Usage</h3>
                    <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                      {rows.length} staff
                    </div>
                  </div>
                  {rows.length === 0 ? (
                    <div style={{ color: "#64748b", padding: "1rem 0" }}>
                      No staff activity this year yet.
                    </div>
                  ) : (
                    <div style={{ maxHeight: 480, overflow: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: "0.9rem",
                        }}
                      >
                        <thead
                          style={{
                            position: "sticky",
                            top: 0,
                            background: "#f1f5f9",
                            color: "#64748b",
                            textAlign: "left",
                          }}
                        >
                          <tr>
                            <th style={{ padding: "0.6rem 0.75rem" }}>First Name</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>Last Name</th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>
                              Total Passes From this Room
                            </th>
                            <th style={{ padding: "0.6rem 0.75rem" }}>
                              Pass to this Room
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr
                              key={r.name}
                              style={{ borderTop: "1px solid #e2e8f0" }}
                            >
                              <td style={{ padding: "0.55rem 0.75rem" }}>{r.first}</td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>{r.last}</td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>
                                {r.fromRoom.toLocaleString()}
                              </td>
                              <td style={{ padding: "0.55rem 0.75rem" }}>
                                {r.toRoom.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                </>
              );
            })()}
          </>
        );
      })()}

      {hpView === "reports" && (authUser?.isAdmin || authUser?.isSuperUser || authUser?.isEseCoordinator) && hpReportSection === "research" && (() => {
        const studentInfo = new Map<
          string,
          { name: string; grade: number }
        >();
        for (const s of students) {
          studentInfo.set(s.studentId, {
            name: `${s.firstName} ${s.lastName}`,
            grade: s.grade,
          });
        }
        const startMs = new Date(`${researchStart}T00:00:00`).getTime();
        const endMs = new Date(`${researchEnd}T23:59:59`).getTime();
        const studentQ = researchStudent.trim().toLowerCase();
        const originQ = researchOrigin.trim().toLowerCase();
        const destQ = researchDest.trim().toLowerCase();

        const filtered = hallPasses
          .filter((p) => {
            const t = new Date(p.createdAt).getTime();
            if (t < startMs || t > endMs) return false;
            if (originQ && !p.originRoom?.toLowerCase().includes(originQ)) return false;
            if (destQ && !p.destination?.toLowerCase().includes(destQ)) return false;
            if (studentQ) {
              const info = studentInfo.get(p.studentId);
              const hay = `${info?.name || ""} ${p.studentId}`.toLowerCase();
              if (!hay.includes(studentQ)) return false;
            }
            return true;
          })
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );

        const fmtDateTime = (iso: string) => {
          const d = new Date(iso);
          const m = d.getMonth() + 1;
          const day = d.getDate();
          let h = d.getHours();
          const mn = String(d.getMinutes()).padStart(2, "0");
          const ampm = h < 12 ? "AM" : "PM";
          h = ((h + 11) % 12) + 1;
          return `${m}/${day} ${h}:${mn} ${ampm}`;
        };
        const durMin = (p: typeof hallPasses[number]) => {
          if (!p.endedAt) return null;
          const m =
            (new Date(p.endedAt).getTime() - new Date(p.createdAt).getTime()) /
            60000;
          return Math.max(0, Math.round(m * 100) / 100);
        };
        const statusColor = (p: typeof hallPasses[number]) => {
          if (p.status === "active") return "#3b82f6";
          const d = durMin(p);
          if (d != null && d > p.maxDurationMinutes) return "#f59e0b";
          return "#22c55e";
        };

        return (
          <>
            <div
              style={{
                borderTopLeftRadius: "var(--radius-lg, 8px)",
                borderTopRightRadius: "var(--radius-lg, 8px)",
                overflow: "hidden",
                marginBottom: "-1px",
              }}
            >
              <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
              <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
                <button
                  type="button"
                  className="back-button-purple"
                  style={{ marginBottom: 0 }}
                  onClick={() => setHpReportSection("hub")}
                >
                  ← Back
                </button>
              </div>
            </div>
            <div className="card">
              <h2
                style={{
                  margin: 0,
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: "#7c3aed",
                }}
              >
                Research
                <span style={{ marginLeft: "0.75rem", fontSize: "0.85rem", color: "#64748b", fontWeight: 400 }}>
                  {filtered.length.toLocaleString()} passes
                </span>
              </h2>
            </div>

            <div className="card">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.75rem",
                  alignItems: "flex-end",
                  marginBottom: "1rem",
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end", width: "100%" }}>
                  <label style={{ display: "flex", flexDirection: "column", fontSize: "0.8rem", color: "#64748b" }}>
                    From
                    <input
                      type="date"
                      value={researchStart}
                      onChange={(e) => setResearchStart(e.target.value)}
                      style={{ padding: "0.35rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.9rem" }}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", fontSize: "0.8rem", color: "#64748b" }}>
                    To
                    <input
                      type="date"
                      value={researchEnd}
                      onChange={(e) => setResearchEnd(e.target.value)}
                      style={{ padding: "0.35rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.9rem" }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setResearchStudent("");
                      setResearchOrigin("");
                      setResearchDest("");
                    }}
                    style={{ padding: "0.45rem 0.9rem", fontSize: "0.85rem" }}
                  >
                    Clear filters
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end", width: "100%" }}>
                  <label style={{ display: "flex", flexDirection: "column", fontSize: "0.8rem", color: "#64748b" }}>
                    Student
                    <input
                      type="text"
                      list="research-students"
                      value={researchStudent}
                      onChange={(e) => setResearchStudent(e.target.value)}
                      placeholder="Name or ID"
                      style={{ padding: "0.4rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.9rem", minWidth: 220 }}
                    />
                    <datalist id="research-students">
                      {students
                        .slice()
                        .sort((a, b) =>
                          `${a.lastName} ${a.firstName}`.localeCompare(
                            `${b.lastName} ${b.firstName}`,
                          ),
                        )
                        .map((s) => (
                          <option key={s.id} value={`${s.firstName} ${s.lastName}`}>
                            {s.studentId}
                          </option>
                        ))}
                    </datalist>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", fontSize: "0.8rem", color: "#64748b" }}>
                    Origin
                    <input
                      type="text"
                      list="research-origins"
                      value={researchOrigin}
                      onChange={(e) => setResearchOrigin(e.target.value)}
                      placeholder="Any room"
                      style={{ padding: "0.4rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.9rem", minWidth: 200 }}
                    />
                    <datalist id="research-origins">
                      {Array.from(
                        new Set(
                          hallPasses
                            .map((p) => p.originRoom)
                            .filter((v): v is string => !!v),
                        ),
                      )
                        .sort((a, b) => a.localeCompare(b))
                        .map((r) => (
                          <option key={r} value={r} />
                        ))}
                    </datalist>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", fontSize: "0.8rem", color: "#64748b" }}>
                    Destination
                    <input
                      type="text"
                      list="research-destinations"
                      value={researchDest}
                      onChange={(e) => setResearchDest(e.target.value)}
                      placeholder="Any destination"
                      style={{ padding: "0.4rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.9rem", minWidth: 200 }}
                    />
                    <datalist id="research-destinations">
                      {Array.from(
                        new Set(
                          hallPasses
                            .map((p) => p.destination)
                            .filter((v): v is string => !!v),
                        ),
                      )
                        .sort((a, b) => a.localeCompare(b))
                        .map((d) => (
                          <option key={d} value={d} />
                        ))}
                    </datalist>
                  </label>
                </div>
              </div>

              {filtered.length === 0 ? (
                <div style={{ color: "#64748b", padding: "1rem 0" }}>
                  No passes match the current filters.
                </div>
              ) : (
                <div style={{ maxHeight: 600, overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                    <thead
                      style={{
                        position: "sticky",
                        top: 0,
                        background: "#f1f5f9",
                        color: "#64748b",
                        textAlign: "left",
                      }}
                    >
                      <tr>
                        <th style={{ padding: "0.6rem 0.75rem", width: 60 }}>Pass</th>
                        <th style={{ padding: "0.6rem 0.75rem" }}>Student Name</th>
                        <th style={{ padding: "0.6rem 0.75rem" }}>Origin</th>
                        <th style={{ padding: "0.6rem 0.75rem" }}>Destination</th>
                        <th style={{ padding: "0.6rem 0.75rem" }}>Grade</th>
                        <th style={{ padding: "0.6rem 0.75rem" }}>ID</th>
                        <th style={{ padding: "0.6rem 0.75rem" }}>Pass start time</th>
                        <th style={{ padding: "0.6rem 0.75rem" }}>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 500).map((p) => {
                        const info = studentInfo.get(p.studentId);
                        const d = durMin(p);
                        return (
                          <tr
                            key={p.id}
                            style={{
                              borderTop: "1px solid #e2e8f0",
                              background: p.isTardyReturn ? "#ede9fe" : undefined,
                            }}
                          >
                            <td style={{ padding: "0.5rem 0.75rem" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  width: 36,
                                  height: 18,
                                  borderRadius: 4,
                                  background: statusColor(p),
                                }}
                              />
                            </td>
                            <td style={{ padding: "0.5rem 0.75rem" }}>{info?.name || "—"}</td>
                            <td style={{ padding: "0.5rem 0.75rem" }}>
                              {p.originRoom}
                              {p.isTardyReturn && (
                                <span
                                  style={{
                                    marginLeft: 6,
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    background: "#a78bfa",
                                    color: "white",
                                    fontWeight: 700,
                                    fontSize: 10,
                                    letterSpacing: 0.5,
                                  }}
                                >
                                  TARDY
                                </span>
                              )}
                            </td>
                            <td style={{ padding: "0.5rem 0.75rem" }}>{p.destination}</td>
                            <td style={{ padding: "0.5rem 0.75rem" }}>
                              {info ? String(info.grade).padStart(2, "0") : "—"}
                            </td>
                            <td style={{ padding: "0.5rem 0.75rem" }}>{p.studentId}</td>
                            <td style={{ padding: "0.5rem 0.75rem" }}>{fmtDateTime(p.createdAt)}</td>
                            <td style={{ padding: "0.5rem 0.75rem" }}>
                              {d == null ? "active" : `${d.toFixed(2)} min`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filtered.length > 500 && (
                    <div style={{ padding: "0.75rem", fontSize: "0.8rem", color: "#64748b" }}>
                      Showing first 500 of {filtered.length.toLocaleString()} matching passes. Narrow your filters to see more.
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        );
      })()}

      {hpView === "reports" && (authUser?.isAdmin || authUser?.isSuperUser || authUser?.isEseCoordinator) && hpReportSection === "byDay" && (<>
        <div
          style={{
            borderTopLeftRadius: "var(--radius-lg, 8px)",
            borderTopRightRadius: "var(--radius-lg, 8px)",
            overflow: "hidden",
            marginBottom: "-1px",
          }}
        >
          <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
          <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
            <button
              type="button"
              className="back-button-purple"
              style={{ marginBottom: 0 }}
              onClick={() => setHpReportSection("hub")}
            >
              ← Back
            </button>
          </div>
        </div>
        <div className="card">
          <h2
            style={{
              margin: 0,
              fontSize: "1.5rem",
              fontWeight: 700,
              color: "#7c3aed",
            }}
          >
            Daily Hall Pass Report
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
                  borderTopLeftRadius: "var(--radius-lg, 8px)",
                  borderTopRightRadius: "var(--radius-lg, 8px)",
                  overflow: "hidden",
                  marginBottom: "0.75rem",
                }}
              >
                <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
                <div
                  className="section-header-band-hub"
                  style={{
                    width: "100%",
                    margin: 0,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                    gap: "1rem",
                    padding: "0.6rem 1rem",
                  }}
                >
                  <h3 style={{ margin: 0, color: "white", fontSize: "1rem", fontWeight: 700 }}>
                    Top 10 Student Pass Takers
                  </h3>
                  <h3 style={{ margin: 0, color: "white", fontSize: "1rem", fontWeight: 700 }}>
                    Top 10 Students by Lost Instruction
                  </h3>
                  <h3 style={{ margin: 0, color: "white", fontSize: "1rem", fontWeight: 700 }}>
                    Top 10 Teacher Pass Granters
                  </h3>
                  <h3 style={{ margin: 0, color: "white", fontSize: "1rem", fontWeight: 700 }}>
                    Top 10 Pass-To Locations
                  </h3>
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
                  <h3 style={{ display: "none" }}>Top 10 Student Pass Takers</h3>
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
                  <h3 style={{ display: "none" }}>Top 10 Students by Lost Instruction</h3>
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
                  <h3 style={{ display: "none" }}>Top 10 Teacher Pass Granters</h3>
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
                  <h3 style={{ display: "none" }}>Top 10 Pass-To Locations</h3>
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
      </>)}

      </>)}

      {activeSection === "tardies" && (<>
      <div className="card cp-cta-card">
        <div className="cp-cta-text">Student Arriving Late?</div>
        <button
          type="button"
          className="cp-cta-button cp-cta-button--blue"
          onClick={() => setLogTardyOpen(true)}
        >
          <svg viewBox="0 0 170 120" fill="currentColor" aria-hidden="true">
            <path d="M5,85 C5,108 38,113 60,107 C75,103 80,100 80,85 C80,68 73,65 58,62 C36,57 5,62 5,85 Z" />
            <circle cx="90" cy="68" r="9" />
            <circle cx="98" cy="78" r="7.5" />
            <circle cx="100" cy="88" r="6.5" />
            <circle cx="97" cy="97" r="5.5" />
            <circle cx="90" cy="105" r="4.5" />
            <path d="M75,35 C75,58 108,63 130,57 C145,53 150,50 150,35 C150,18 143,15 128,12 C106,7 75,12 75,35 Z" />
            <circle cx="160" cy="18" r="9" />
            <circle cx="168" cy="28" r="7.5" />
            <circle cx="170" cy="38" r="6.5" />
            <circle cx="167" cy="47" r="5.5" />
            <circle cx="160" cy="55" r="4.5" />
          </svg>
          Log Tardy
        </button>
      </div>
      <div className="card" style={{ display: "none" }}>
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
            <th>Created By</th>
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
              <td>{t.createdBy ?? "-"}</td>
              <td>{fmtTime(t.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      </>)}

      {activeSection === "student" && (
        <>
          <div
            style={{
              borderTopLeftRadius: "var(--radius-lg, 8px)",
              borderTopRightRadius: "var(--radius-lg, 8px)",
              overflow: "hidden",
              marginBottom: "-1px",
            }}
          >
            <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
            <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }} />
          </div>
          <section className="card" style={{ overflow: "visible", minHeight: "24rem" }}>
            <h2
              style={{
                margin: "0 0 0.5rem",
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "#7c3aed",
              }}
            >
              Family Communication
            </h2>
          <div style={{ marginBottom: "0.5rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 480 }}>
              <span style={{ whiteSpace: "nowrap" }}>Student:</span>
              <div style={{ flex: 1 }}>
                <StudentCombobox
                  students={students}
                  value={activityStudentId}
                  onChange={(id) => {
                    setActivityStudentId(id);
                    const s = students.find((x) => x.studentId === id);
                    setActivityStudentSearch(
                      s ? `${s.firstName} ${s.lastName} (${s.studentId})` : "",
                    );
                  }}
                  minWidth={400}
                  isAdmin={Boolean(authUser?.isAdmin || authUser?.isSuperUser)}
                />
              </div>
            </label>
            {false && activityStudentId ? (
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
              activityStudentSearch && false && (
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
                {(() => {
                  const tabs = [
                    ["hallPasses", "Hall Passes"],
                    ["tardy", "Tardy / Support Logs"],
                    ["pbis", "PBIS"],
                    ["supportNotes", "Support Notes"],
                    ["contact", "Contact / Communication"],
                    ["pullouts", "Pullouts"],
                  ] as const;
                  const allChecked = tabs.every(
                    ([k]) => summaryChecks[k as string],
                  );
                  return (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const next: Record<string, boolean> = {};
                          tabs.forEach(([k]) => {
                            next[k] = !allChecked;
                          });
                          setSummaryChecks(next);
                          setStudentTab("summary");
                        }}
                        style={{
                          marginRight: "0.5rem",
                          background: "#7c3aed",
                          color: "#fff",
                          border: "none",
                          padding: "0.35rem 0.75rem",
                          borderRadius: 6,
                          cursor: "pointer",
                          fontWeight: 600,
                        }}
                      >
                        {allChecked ? "Uncheck All" : "Check All"}
                      </button>
                      {tabs.map(([key, label]) => (
                        <span
                          key={key}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            marginRight: "0.5rem",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(summaryChecks[key])}
                            onChange={(e) =>
                              setSummaryChecks((prev) => ({
                                ...prev,
                                [key]: e.target.checked,
                              }))
                            }
                            aria-label={`Include ${label} in summary`}
                          />
                          <button
                            type="button"
                            onClick={() => setStudentTab(key)}
                            disabled={studentTab === key}
                          >
                            {label}
                          </button>
                        </span>
                      ))}
                    </>
                  );
                })()}
              </div>

              <div style={{ marginBottom: "0.75rem" }}>
                <strong>Quick Actions:</strong>{" "}
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
                    const res = await authFetch("/api/parent-email/send", {
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
                    authFetch(
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
        </>
      )}

      {activeSection === "accommodations" && (<>
        <section className="card">
          <div className="section-header-bar-teal" />
          <div className="section-header-band-hub">
            <h2
              style={{
                margin: 0,
                color: "white",
                fontSize: "1.5rem",
                fontWeight: 700,
              }}
            >
              Accommodations
            </h2>
          </div>
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
                      authUser?.isAdmin === true ||
                      authUser?.isSuperUser === true ||
                      authUser?.isBehaviorSpecialist === true ||
                      authUser?.isMtssCoordinator === true;
                    // Admin / SuperUser / ESE / Behavior Specialist /
                    // MTSS Coordinator can browse any teacher's roster.
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
                                      borderRadius: 0,
                                      padding: "0.25rem 0.7rem",
                                      background: isActive
                                        ? "var(--accent)"
                                        : "transparent",
                                      color: isActive
                                        ? "white"
                                        : disabled
                                          ? "var(--text-subtle)"
                                          : undefined,
                                      opacity: disabled && !isActive ? 0.55 : 1,
                                      boxShadow: isActive
                                        ? "inset 3px 0 0 var(--accent)"
                                        : "none",
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
                              <select
                                value={
                                  classViewTeacherId == null
                                    ? ""
                                    : String(classViewTeacherId)
                                }
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "") {
                                    setClassViewTeacherId(null);
                                    setClassViewPeriod(null);
                                    setClassViewHoverId(null);
                                    return;
                                  }
                                  setClassViewTeacherId(Number(v));
                                  setClassViewPeriod(null);
                                  setClassViewHoverId(null);
                                }}
                                style={{ minWidth: 220 }}
                              >
                                <option value="">Select teacher…</option>
                                {teacherOptions.map((t) => (
                                  <option key={t.id} value={String(t.id)}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
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
                ) : accView === "daily" ? (
                  (() => {
                    // ----- Class Log (per-student redesign) -----
                    // Roster on the left; click a student to open an inline
                    // dropdown of THAT student's tracked plan accommodations
                    // with Provided/Refused toggle buttons. Period dropdown
                    // auto-fills with the bell-schedule's current period;
                    // date defaults to today but is freely backdatable.
                    const isElevated =
                      authUser?.isAdmin === true ||
                      authUser?.isSuperUser === true ||
                      authUser?.isEseCoordinator === true ||
                      authUser?.isMtssCoordinator === true ||
                      authUser?.isBehaviorSpecialist === true;
                    const teacherOptions = isElevated
                      ? Array.from(
                          new Map(
                            allSections.map(
                              (s) =>
                                [s.teacherStaffId, s.teacherName] as const,
                            ),
                          ).entries(),
                        )
                          .map(([id, name]) => ({ id, name }))
                          .sort((a, b) => a.name.localeCompare(b.name))
                      : [];
                    const effectiveSections =
                      isElevated && dailyTeacherId != null
                        ? allSections.filter(
                            (s) => s.teacherStaffId === dailyTeacherId,
                          )
                        : mySections;
                    const effectivePeriodRoster: Record<string, string[]> =
                      Object.fromEntries(
                        effectiveSections.map((s) => [
                          String(s.period),
                          s.studentIds,
                        ]),
                      );
                    const effectivePeriods: number[] = effectiveSections
                      .filter((s) => !s.isPlanning)
                      .map((s) => s.period)
                      .sort((a, b) => a - b);
                    const allInPeriod = dailyPeriod
                      ? effectivePeriodRoster[dailyPeriod] ?? []
                      : [];
                    const trackedCats = new Set<
                      SchoolAccommodation["category"]
                    >(["IEP", "504", "ELL"]);
                    type StudentTrackedAcc = {
                      id: number;
                      name: string;
                      category: SchoolAccommodation["category"];
                    };
                    const trackedAccsForStudent = (
                      st: (typeof students)[number],
                    ): StudentTrackedAcc[] => {
                      const out: StudentTrackedAcc[] = [];
                      const seen = new Set<number>();
                      for (const name of st.accommodations ?? []) {
                        const cat = accCategoryByName.get(name);
                        if (!cat || !trackedCats.has(cat)) continue;
                        const sa = schoolAccommodations.find(
                          (a) => a.name === name,
                        );
                        if (!sa) continue;
                        if (seen.has(sa.id)) continue;
                        seen.add(sa.id);
                        out.push({ id: sa.id, name: sa.name, category: cat });
                      }
                      return out.sort((a, b) =>
                        a.category === b.category
                          ? a.name.localeCompare(b.name)
                          : a.category.localeCompare(b.category),
                      );
                    };
                    const rosterStudents = allInPeriod
                      .map((id) =>
                        students.find((st) => st.studentId === id),
                      )
                      .filter(
                        (s): s is (typeof students)[number] => s !== undefined,
                      )
                      .map((st) => ({
                        student: st,
                        accs: trackedAccsForStudent(st),
                      }))
                      .filter((row) => row.accs.length > 0)
                      .sort((a, b) =>
                        a.student.lastName.localeCompare(b.student.lastName) ||
                        a.student.firstName.localeCompare(b.student.firstName),
                      );
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
                    const setEntry = (
                      sid: string,
                      accId: number,
                      next: DailyStatus | null,
                    ) => {
                      setDailyEntries((prev) => {
                        const existing = prev[sid] ?? {};
                        // Toggle off if same value clicked again.
                        if (next === null || existing[accId] === next) {
                          const { [accId]: _drop, ...rest } = existing;
                          if (Object.keys(rest).length === 0) {
                            const { [sid]: _dropSid, ...withoutSid } = prev;
                            return withoutSid;
                          }
                          return { ...prev, [sid]: rest };
                        }
                        return {
                          ...prev,
                          [sid]: { ...existing, [accId]: next },
                        };
                      });
                    };
                    const studentsTouched = Object.keys(dailyEntries).filter(
                      (sid) =>
                        Object.keys(dailyEntries[sid] ?? {}).length > 0,
                    ).length;
                    const todayKey = (() => {
                      const n = new Date();
                      const y = n.getFullYear();
                      const m = String(n.getMonth() + 1).padStart(2, "0");
                      const d = String(n.getDate()).padStart(2, "0");
                      return `${y}-${m}-${d}`;
                    })();
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
                            className="back-button-purple no-print"
                            onClick={() => window.print()}
                            style={{
                              marginBottom: 0,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.35rem",
                            }}
                            title="Print this view"
                          >
                            <span aria-hidden="true">🖨</span>
                            Print
                          </button>
                        </div>
                        {isElevated && (
                          <div style={{ marginBottom: "0.5rem" }}>
                            <label>
                              Teacher:{" "}
                              <select
                                value={
                                  dailyTeacherId == null
                                    ? ""
                                    : String(dailyTeacherId)
                                }
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setDailyTeacherId(
                                    v === "" ? null : Number(v),
                                  );
                                  setDailyPeriod("");
                                  setDailyEntries({});
                                  setDailyExpandedSid(null);
                                  setDailySubmitMsg("");
                                  setAutoPeriodApplied(false);
                                }}
                                style={{ minWidth: 220 }}
                              >
                                <option value="">Select teacher…</option>
                                {teacherOptions.map((t) => (
                                  <option key={t.id} value={String(t.id)}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        )}
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "0.75rem",
                            alignItems: "center",
                            marginBottom: "0.75rem",
                          }}
                        >
                          <label>
                            Date:{" "}
                            <input
                              type="date"
                              value={dailyDate}
                              max={todayKey}
                              onChange={(e) => {
                                setDailyDate(e.target.value || todayKey);
                                setDailySubmitMsg("");
                              }}
                            />
                          </label>
                          <label>
                            Period:{" "}
                            <select
                              value={dailyPeriod}
                              onChange={(e) => {
                                setDailyPeriod(e.target.value);
                                setDailyEntries({});
                                setDailyExpandedSid(null);
                                setDailySubmitMsg("");
                                setAutoPeriodApplied(true);
                              }}
                              disabled={
                                isElevated && dailyTeacherId == null
                              }
                            >
                              <option value="">-- Select period --</option>
                              {effectivePeriods.map((p) => (
                                <option key={p} value={String(p)}>
                                  Period {p}
                                  {currentBellPeriod === p
                                    ? " (current)"
                                    : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          {currentBellPeriod != null &&
                            dailyPeriod &&
                            Number(dailyPeriod) !== currentBellPeriod && (
                              <span
                                style={{ color: "#666", fontSize: "0.85rem" }}
                              >
                                Logging Period {dailyPeriod} — current period
                                is {currentBellPeriod}.
                              </span>
                            )}
                          {isElevated && dailyTeacherId == null ? (
                            <span style={{ color: "#666" }}>
                              Pick a teacher first.
                            </span>
                          ) : effectivePeriods.length === 0 ? (
                            <span style={{ color: "#666" }}>
                              {isElevated && dailyTeacherId != null
                                ? "No teaching periods for this teacher."
                                : "No teaching periods assigned to you."}
                            </span>
                          ) : null}
                        </div>
                        {!dailyPeriod ? (
                          <div>Pick a period to start.</div>
                        ) : rosterStudents.length === 0 ? (
                          <div>
                            No students in this period have IEP/504/ELL
                            accommodations.
                          </div>
                        ) : (
                          <>
                            <div
                              style={{
                                marginBottom: "0.5rem",
                                color: "#475569",
                                fontSize: "0.9rem",
                              }}
                            >
                              {rosterStudents.length} student
                              {rosterStudents.length === 1 ? "" : "s"} with
                              accommodations. Click a name to log Provided or
                              Refused for that student. Skipped students are
                              treated as absent and not logged.
                            </div>
                            <ul
                              style={{
                                listStyle: "none",
                                padding: 0,
                                margin: 0,
                                border: "1px solid #e2e8f0",
                                borderRadius: 6,
                              }}
                            >
                              {rosterStudents.map(({ student: st, accs }) => {
                                const sid = st.studentId;
                                const isOpen = dailyExpandedSid === sid;
                                const perAcc = dailyEntries[sid] ?? {};
                                const providedCount = Object.values(
                                  perAcc,
                                ).filter((v) => v === "provided").length;
                                const refusedCount = Object.values(
                                  perAcc,
                                ).filter((v) => v === "refused").length;
                                const touched =
                                  providedCount + refusedCount > 0;
                                return (
                                  <li
                                    key={sid}
                                    style={{
                                      borderBottom: "1px solid #e2e8f0",
                                    }}
                                  >
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setDailyExpandedSid(
                                          isOpen ? null : sid,
                                        )
                                      }
                                      style={{
                                        all: "unset",
                                        cursor: "pointer",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "0.5rem",
                                        padding: "0.6rem 0.75rem",
                                        width: "100%",
                                        boxSizing: "border-box",
                                        background: touched
                                          ? "rgba(13, 148, 136, 0.06)"
                                          : "transparent",
                                      }}
                                    >
                                      <span
                                        aria-hidden="true"
                                        style={{
                                          display: "inline-block",
                                          width: 12,
                                          textAlign: "center",
                                          color: "#475569",
                                        }}
                                      >
                                        {isOpen ? "▾" : "▸"}
                                      </span>
                                      <span style={{ fontWeight: 600 }}>
                                        {st.lastName}, {st.firstName}
                                      </span>
                                      <span
                                        style={{
                                          color: "#64748b",
                                          fontSize: "0.85rem",
                                        }}
                                      >
                                        ({accs.length} acc
                                        {accs.length === 1 ? "" : "s"})
                                      </span>
                                      {touched && (
                                        <span
                                          style={{
                                            marginLeft: "auto",
                                            fontSize: "0.8rem",
                                            color: "#0f766e",
                                          }}
                                        >
                                          {providedCount > 0 &&
                                            `${providedCount} provided`}
                                          {providedCount > 0 &&
                                            refusedCount > 0 &&
                                            " · "}
                                          {refusedCount > 0 &&
                                            `${refusedCount} refused`}
                                        </span>
                                      )}
                                    </button>
                                    {isOpen && (
                                      <div
                                        style={{
                                          padding: "0.5rem 1rem 0.75rem 2rem",
                                          background: "#f8fafc",
                                        }}
                                      >
                                        <ul
                                          style={{
                                            listStyle: "none",
                                            padding: 0,
                                            margin: 0,
                                          }}
                                        >
                                          {accs.map((a) => {
                                            const cur = perAcc[a.id] ?? null;
                                            return (
                                              <li
                                                key={a.id}
                                                style={{
                                                  display: "flex",
                                                  alignItems: "center",
                                                  gap: "0.5rem",
                                                  padding: "0.3rem 0",
                                                }}
                                              >
                                                <span
                                                  style={{
                                                    background: catColor(
                                                      a.category,
                                                    ),
                                                    color: "white",
                                                    fontSize: "0.7rem",
                                                    padding: "1px 6px",
                                                    borderRadius: 4,
                                                    minWidth: 36,
                                                    textAlign: "center",
                                                  }}
                                                >
                                                  {a.category}
                                                </span>
                                                <span
                                                  style={{ flex: 1 }}
                                                >
                                                  {a.name}
                                                </span>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setEntry(
                                                      sid,
                                                      a.id,
                                                      "provided",
                                                    )
                                                  }
                                                  style={{
                                                    padding: "0.2rem 0.6rem",
                                                    background:
                                                      cur === "provided"
                                                        ? "#0f766e"
                                                        : "#e2e8f0",
                                                    color:
                                                      cur === "provided"
                                                        ? "white"
                                                        : "#0f172a",
                                                    border: "none",
                                                    borderRadius: 4,
                                                    cursor: "pointer",
                                                    fontWeight:
                                                      cur === "provided"
                                                        ? 700
                                                        : 500,
                                                  }}
                                                >
                                                  Provided
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setEntry(
                                                      sid,
                                                      a.id,
                                                      "refused",
                                                    )
                                                  }
                                                  style={{
                                                    padding: "0.2rem 0.6rem",
                                                    background:
                                                      cur === "refused"
                                                        ? "#b91c1c"
                                                        : "#fde2e2",
                                                    color:
                                                      cur === "refused"
                                                        ? "white"
                                                        : "#7f1d1d",
                                                    border: "none",
                                                    borderRadius: 4,
                                                    cursor: "pointer",
                                                    fontWeight:
                                                      cur === "refused"
                                                        ? 700
                                                        : 500,
                                                  }}
                                                >
                                                  Refused
                                                </button>
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      </div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            <div
                              style={{
                                marginTop: "1rem",
                                display: "flex",
                                alignItems: "center",
                                gap: "0.75rem",
                                flexWrap: "wrap",
                              }}
                            >
                              <button
                                type="button"
                                onClick={submitDailyLog}
                                disabled={studentsTouched === 0}
                                style={{
                                  padding: "0.5rem 1rem",
                                  background:
                                    studentsTouched === 0
                                      ? "#cbd5e1"
                                      : "#0f766e",
                                  color: "white",
                                  border: "none",
                                  borderRadius: 6,
                                  fontWeight: 700,
                                  cursor:
                                    studentsTouched === 0
                                      ? "not-allowed"
                                      : "pointer",
                                }}
                              >
                                Submit log for Period {dailyPeriod} on{" "}
                                {dailyDate}
                              </button>
                              <span style={{ color: "#475569" }}>
                                {studentsTouched} student
                                {studentsTouched === 1 ? "" : "s"} marked.
                              </span>
                              {dailySubmitMsg && (
                                <span
                                  style={{
                                    color: dailySubmitMsg.startsWith("Failed")
                                      ? "#a00"
                                      : "#080",
                                  }}
                                >
                                  {dailySubmitMsg}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </>
                    );
                  })()
                ) : (
                  // ----- Reports view -----
                  (() => {
                    const isPrivileged =
                      authUser?.isAdmin === true ||
                      authUser?.isSuperUser === true ||
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
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "0.75rem",
                            marginBottom: "0.5rem",
                          }}
                        >
                          <h3 style={{ margin: 0 }}>Accommodation Reports</h3>
                          <button
                            type="button"
                            className="back-button-purple no-print"
                            onClick={() => window.print()}
                            style={{
                              marginBottom: 0,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.35rem",
                            }}
                            title="Print this view"
                          >
                            <span aria-hidden="true">🖨</span>
                            Print
                          </button>
                        </div>

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

      {activeSection === "pbis" && <PbisPointsHub />}

      {/* Read-only School Store catalog — sidebar entry visible to every
          signed-in staffer. Always renders with canEdit=false so even
          admins/BS/MTSS/PBIS coords browsing here don't get edit
          controls. The editable surface lives in the PBIS / BS / MTSS
          hubs. */}
      {activeSection === "schoolStore" && <SchoolStoreView canEdit={false} />}

      {/* Editable School Store — opened from the BS hub or MTSS hub
          tile. canEditSchoolStore mirrors the server's requireWriteAccess
          gate; if a non-eligible user ever lands here we still render
          read-only rather than crash, but the UI only links to this
          section from a tile that's already gated. */}
      {activeSection === "schoolStoreManage" && (
        <SchoolStoreView canEdit={canEditSchoolStore} />
      )}

      {(activeSection === "pbisRecent" || activeSection === "pbisReports") && (<>
        <section className="card">
          {/* Legacy "PBIS Points" awarding form. Replaced by <PbisPointsHub />
              above. Kept here (dead-coded) so we can quickly cherry-pick any
              behavior that needs to be migrated into the new hub — remove
              once the hub's Settings + Reports tabs are live. */}
          {false && (<>
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
          </>)}

          {activeSection === "pbisRecent" && (<>
          <h3 style={{ marginTop: 0 }}>Recent PBIS Entries</h3>
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
          </>)}

          {activeSection === "pbisReports" && (<>
          {/* Site-based gradient header: matches the PBIS Hub palette
              (purple → teal → green) so the Reports page reads as a
              sub-page of the hub instead of a bare table view. */}
          <div
            className="no-print"
            style={{
              background:
                "var(--brand-header-bg)",
              color: "white",
              padding: "1.25rem 1.5rem",
              borderRadius: 8,
              marginBottom: "1rem",
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
                <div
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    opacity: 0.85,
                  }}
                >
                  PBIS Hub
                </div>
                <h2 style={{ margin: "0.15rem 0 0", color: "white" }}>
                  PBIS Report
                </h2>
                <div
                  style={{
                    opacity: 0.9,
                    fontSize: "0.9rem",
                    marginTop: 4,
                    maxWidth: "48rem",
                  }}
                >
                  {isPbisCoord || isAdmin || isEseCoord
                    ? "School-wide. Filter by date range, teacher, reason, or student. Leave any filter blank to ignore it."
                    : "Showing only PBIS points you awarded. Filter by date range, reason, or student."}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection("pbisHub")}
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
                ← Back to PBIS Hub
              </button>
            </div>
          </div>
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
          </>)}
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
        <>
          <div
            style={{
              borderTopLeftRadius: "var(--radius-lg, 8px)",
              borderTopRightRadius: "var(--radius-lg, 8px)",
              overflow: "hidden",
              marginBottom: "-1px",
            }}
          >
            <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
            <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
              <button
                type="button"
                className="back-button-purple"
                style={{ marginBottom: 0 }}
                onClick={() => setActiveSection("behaviorSpecialist")}
              >
                ← Back
              </button>
            </div>
          </div>
          <VerifyPulloutsSection
            students={students}
            onChange={() => setPendingPulloutsTick((t) => t + 1)}
          />
        </>
      )}

      {activeSection === "issDashboard" && canViewIssDashboard && (
        <IssDashboardSection students={students} />
      )}

      {activeSection === "issReporting" && canViewIssDashboard && (
        <>
          <div
            style={{
              borderTopLeftRadius: "var(--radius-lg, 8px)",
              borderTopRightRadius: "var(--radius-lg, 8px)",
              overflow: "hidden",
              marginBottom: "-1px",
            }}
          >
            <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
            <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
              <button
                type="button"
                className="back-button-purple"
                style={{ marginBottom: 0 }}
                onClick={() => setActiveSection("behaviorSpecialist")}
              >
                ← Back
              </button>
            </div>
          </div>
          <PulloutReportSection students={students} />
        </>
      )}

      {activeSection === "behaviorReview" && canReviewPullouts && (
        <>
          <div
            style={{
              borderTopLeftRadius: "var(--radius-lg, 8px)",
              borderTopRightRadius: "var(--radius-lg, 8px)",
              overflow: "hidden",
              marginBottom: "-1px",
            }}
          >
            <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
            <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
              <button
                type="button"
                className="back-button-purple"
                style={{ marginBottom: 0 }}
                onClick={() => setActiveSection("behaviorSpecialist")}
              >
                ← Back
              </button>
            </div>
          </div>
          <div style={{ marginTop: 0 }} className="bs-attached-card-wrapper">
            <BehaviorReviewSection
              students={students}
              onChange={() => setUnreviewedPulloutsTick((t) => t + 1)}
            />
          </div>
        </>
      )}

      {activeSection === "behaviorSpecialist" && isBehaviorSpec && (() => {
        type HubKey =
          | "issDashboard"
          | "issReporting"
          | "behaviorReview"
          | "interventions"
          | "trustedAdultInterventions"
          | "hallPassMgmt"
          | "logIntervention"
          | "verifyPullouts"
          | "schoolWidePbis"
          | "schoolStoreManage"
          | "mtssPlans"
          | "teacherRoster";
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
            key: "verifyPullouts",
            label: "Verify Pullouts",
            desc: "Approve or reject pending pullout requests.",
            color: "#b45309",
            show: canVerifyPullouts,
            badge: pendingPulloutCount,
          },
          {
            key: "issDashboard",
            label: "ISS Dashboard",
            desc: "In-school suspension roster and pullout history.",
            color: "#0f766e",
            show: canViewIssDashboard,
          },
          {
            key: "issReporting",
            label: "ISS Reporting",
            desc: "Top students, referring teachers, and pullout reasons.",
            color: "#0e7490",
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
            label: "Edit Log Intervention",
            desc: "Edit the list of interventions offered to students.",
            color: "#7c3aed",
            show: canManageBehaviorLists,
          },
          {
            key: "trustedAdultInterventions",
            label: "Trusted Adult Interventions",
            desc: "Edit the interventions a trusted adult can deliver during check-ins.",
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
            show: effectiveFeatures.LogIntervention,
          },
          {
            key: "schoolWidePbis",
            label: "School-wide PBIS",
            desc: "Manage the rubric and note templates every teacher uses.",
            color: "#1e3a8a",
            show: true,
          },
          {
            // Manage version of the school-wide rewards catalog. The
            // sidebar's "School Store" entry is read-only; this tile opens
            // the same view with edit/add/delete enabled.
            key: "schoolStoreManage",
            label: "School Store",
            desc: "Add, edit, and remove school-wide rewards students can redeem.",
            color: "#6d28d9",
            show: canEditSchoolStore && effectiveFeatures.SchoolStore,
          },
          {
            key: "mtssPlans",
            label: "MTSS Plans",
            desc: "Open and manage student intervention plans (Tier 1/2/3).",
            color: "#0d9488",
            show: canManageMtssPlans,
          },
          {
            key: "teacherRoster",
            label: "Teacher Roster",
            desc: "Browse any teacher's roster with FAST PM scores and BQ flags.",
            color: "#1e40af",
            show: true,
          },
        ];
        return (
          <>
            <div
              className="card no-print"
              style={{
                background:
                  "var(--brand-header-bg)",
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

            {(() => {
              const siteMgmtKeys = new Set<HubKey>([
                "hallPassMgmt",
                "interventions",
                "trustedAdultInterventions",
              ]);
              const behaviorReportingKeys = new Set<HubKey>([
                "behaviorReview",
              ]);
              const renderTile = (t: HubTool) => (
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
              );
              const bsTools = tools.filter(
                (t) =>
                  t.show &&
                  !siteMgmtKeys.has(t.key) &&
                  !behaviorReportingKeys.has(t.key),
              );
              const reportingTools = tools.filter(
                (t) => t.show && behaviorReportingKeys.has(t.key),
              );
              const siteTools = tools.filter(
                (t) => t.show && siteMgmtKeys.has(t.key),
              );
              return (
                <>
                  {bsTools.length > 0 && (
                    <div
                      className="card no-print"
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fill, minmax(240px, 1fr))",
                        gap: "0.75rem",
                      }}
                    >
                      {bsTools.map(renderTile)}
                    </div>
                  )}

                  {reportingTools.length > 0 && (
                    <>
                      <svg
                        className="ekg-separator"
                        viewBox="0 0 600 28"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <path
                          className="track"
                          d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
                        />
                      </svg>

                      <div
                        style={{
                          borderTopLeftRadius: "var(--radius-lg, 8px)",
                          borderTopRightRadius: "var(--radius-lg, 8px)",
                          overflow: "hidden",
                          marginBottom: "-1px",
                        }}
                      >
                        <div
                          className="section-header-bar-teal"
                          style={{ width: "100%", margin: 0 }}
                        />
                        <div
                          className="section-header-band-hub"
                          style={{ width: "100%", margin: 0 }}
                        >
                          <h2
                            style={{
                              margin: 0,
                              color: "white",
                              fontSize: "1.5rem",
                              fontWeight: 700,
                            }}
                          >
                            Behavior Reporting
                          </h2>
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
                        {reportingTools.map(renderTile)}
                      </div>
                    </>
                  )}

                  {siteTools.length > 0 && (
                    <>
                      <svg
                        className="ekg-separator"
                        viewBox="0 0 600 28"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <path
                          className="track"
                          d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
                        />
                      </svg>

                      <div
                        style={{
                          borderTopLeftRadius: "var(--radius-lg, 8px)",
                          borderTopRightRadius: "var(--radius-lg, 8px)",
                          overflow: "hidden",
                          marginBottom: "-1px",
                        }}
                      >
                        <div
                          className="section-header-bar-teal"
                          style={{ width: "100%", margin: 0 }}
                        />
                        <div
                          className="section-header-band-hub"
                          style={{ width: "100%", margin: 0 }}
                        >
                          <h2
                            style={{
                              margin: 0,
                              color: "white",
                              fontSize: "1.5rem",
                              fontWeight: 700,
                            }}
                          >
                            Site Management
                          </h2>
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
                        {siteTools.map(renderTile)}
                      </div>
                    </>
                  )}
                </>
              );
            })()}
          </>
        );
      })()}

      {activeSection === "pbisHub" && canAccessPbisHub && (() => {
        type PbisHubKey =
          | "pbis"
          | "pbisRecent"
          | "pbisReports"
          | "pbisReasons"
          | "pbisMilestoneEmails"
          | "schoolStoreManage";
        type PbisTool = {
          key: PbisHubKey;
          label: string;
          desc: string;
          color: string;
          show: boolean;
        };
        const tools: PbisTool[] = [
          {
            key: "pbis",
            label: "PBIS Points",
            desc: "Award PBIS points to students.",
            color: "#7c3aed",
            show: true,
          },
          {
            key: "pbisRecent",
            label: "Recent PBIS Entries",
            desc: "Browse, edit, or void recent PBIS point entries.",
            color: "#0e7490",
            show: true,
          },
          {
            key: "pbisReports",
            label: "PBIS Reports",
            desc: "Filter and analyze PBIS point activity.",
            color: "#0d9488",
            show: true,
          },
          {
            key: "pbisReasons",
            label: "PBIS Reasons",
            desc: "Edit the positive-behavior reasons teachers can pick.",
            color: "#7c3aed",
            show: isPbisCoord,
          },
          {
            key: "pbisMilestoneEmails",
            label: "Milestone Parent Emails",
            desc: "Configure milestone thresholds and parent email templates.",
            color: "#7c3aed",
            show: isPbisCoord,
          },
          {
            // Same destination as the BS / MTSS hub "School Store" tile —
            // opens the editable SchoolStoreView. The previous "PBIS Store"
            // placeholder was retired in favor of this unified store; the
            // user-facing label stays "School Store" because the rewards
            // catalog is shared school-wide, not PBIS-only.
            key: "schoolStoreManage",
            label: "School Store",
            desc: "Add, edit, and remove school-wide rewards students can redeem.",
            color: "#b45309",
            show: canEditSchoolStore && effectiveFeatures.SchoolStore,
          },
        ];
        return (
          <>
            <div
              className="card no-print"
              style={{
                background:
                  "var(--brand-header-bg)",
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
                  <h2 style={{ margin: 0, color: "white" }}>PBIS Hub</h2>
                  <div style={{ opacity: 0.9, fontSize: "0.9rem", marginTop: 4 }}>
                    Your hub for awarding points, reviewing entries, and
                    managing PBIS rewards.
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
                      </button>
                    ))}
                </div>
              </div>
            </div>

            <PbisHomePanel />
            <PbisNeedsAttention />

            {(() => {
              const siteMgmtKeys = new Set<PbisHubKey>([
                "pbisReasons",
                "pbisMilestoneEmails",
              ]);
              const reportingKeys = new Set<PbisHubKey>([
                "pbisRecent",
                "pbisReports",
              ]);
              const renderTile = (t: PbisTool) => (
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
                  </div>
                  <span style={{ color: "#475569", fontSize: "0.85rem" }}>
                    {t.desc}
                  </span>
                </button>
              );
              const mainTools = tools.filter(
                (t) =>
                  t.show &&
                  !siteMgmtKeys.has(t.key) &&
                  !reportingKeys.has(t.key),
              );
              const reportingTools = tools.filter(
                (t) => t.show && reportingKeys.has(t.key),
              );
              const siteTools = tools.filter(
                (t) => t.show && siteMgmtKeys.has(t.key),
              );
              return (
                <>
                  {mainTools.length > 0 && (
                    <div
                      className="card no-print"
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fill, minmax(240px, 1fr))",
                        gap: "0.75rem",
                      }}
                    >
                      {mainTools.map(renderTile)}
                    </div>
                  )}

                  {reportingTools.length > 0 && (
                    <>
                      <svg
                        className="ekg-separator"
                        viewBox="0 0 600 28"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <path
                          className="track"
                          d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
                        />
                      </svg>

                      <div
                        style={{
                          borderTopLeftRadius: "var(--radius-lg, 8px)",
                          borderTopRightRadius: "var(--radius-lg, 8px)",
                          overflow: "hidden",
                          marginBottom: "-1px",
                        }}
                      >
                        <div
                          className="section-header-bar-teal"
                          style={{ width: "100%", margin: 0 }}
                        />
                        <div
                          className="section-header-band-hub"
                          style={{ width: "100%", margin: 0 }}
                        >
                          <h2
                            style={{
                              margin: 0,
                              color: "white",
                              fontSize: "1.5rem",
                              fontWeight: 700,
                            }}
                          >
                            PBIS Reporting
                          </h2>
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
                        {reportingTools.map(renderTile)}
                      </div>
                    </>
                  )}

                  {siteTools.length > 0 && (
                    <>
                      <svg
                        className="ekg-separator"
                        viewBox="0 0 600 28"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <path
                          className="track"
                          d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
                        />
                      </svg>

                      <div
                        style={{
                          borderTopLeftRadius: "var(--radius-lg, 8px)",
                          borderTopRightRadius: "var(--radius-lg, 8px)",
                          overflow: "hidden",
                          marginBottom: "-1px",
                        }}
                      >
                        <div
                          className="section-header-bar-teal"
                          style={{ width: "100%", margin: 0 }}
                        />
                        <div
                          className="section-header-band-hub"
                          style={{ width: "100%", margin: 0 }}
                        >
                          <h2
                            style={{
                              margin: 0,
                              color: "white",
                              fontSize: "1.5rem",
                              fontWeight: 700,
                            }}
                          >
                            Site Management
                          </h2>
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
                        {siteTools.map(renderTile)}
                      </div>
                    </>
                  )}
                </>
              );
            })()}
          </>
        );
      })()}

      {activeSection === "mtssPlans" && canManageMtssPlans && (
        <MtssPlansAdmin
          canManage={canManageMtssPlans}
          onBack={() =>
            setActiveSection(
              isMtss ? "mtssCoordinator" : "behaviorSpecialist",
            )
          }
        />
      )}

      {activeSection === "teacherRoster" && (
        <TeacherRosterPage
          isCoreTeam={
            Boolean(authUser?.isSuperUser) ||
            isAdmin ||
            Boolean(authUser?.isEseCoordinator) ||
            isBehaviorSpec ||
            isMtss
          }
          defaultTeacherId={authUser?.id ?? null}
          onBack={() => setActiveSection("hallPasses")}
          onOpenSpider={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            setStudentProfileReturnTo("teacherRoster");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "mtssCoordinator" && canAccessMtssHub && (() => {
        type MtssHubKey =
          | "mtssTemplates"
          | "schoolWidePbis"
          | "schoolStoreManage"
          | "mtssPlans"
          | "teacherRoster";
        type MtssTool = {
          key: MtssHubKey;
          label: string;
          desc: string;
          color: string;
          // Optional visibility gate. Defaults to "show" when omitted so
          // existing tiles keep working. Used by per-school feature
          // flags (e.g. SchoolStore) to hide a tile entirely.
          show?: boolean;
        };
        const tools: MtssTool[] = [
          {
            key: "mtssPlans",
            label: "MTSS Plans",
            desc: "Open and manage student intervention plans (Tier 1/2/3).",
            color: "#0d9488",
          },
          {
            key: "mtssTemplates",
            label: "Templates",
            desc: "Create, edit, and save parent communication templates.",
            color: "#7c3aed",
          },
          {
            key: "schoolWidePbis",
            label: "School-wide PBIS",
            desc: "Manage the rubric and note templates every teacher uses.",
            color: "#1e3a8a",
          },
          {
            // Same edit-enabled view that the BS hub exposes. Anyone who
            // can reach the MTSS hub also has write access (admins, MTSS
            // coords, BS), so no extra gating needed here apart from the
            // per-school feature flag.
            key: "schoolStoreManage",
            label: "School Store",
            desc: "Add, edit, and remove school-wide rewards students can redeem.",
            color: "#6d28d9",
            show: effectiveFeatures.SchoolStore,
          },
          {
            key: "teacherRoster",
            label: "Teacher Roster",
            desc: "Browse any teacher's roster with FAST PM scores and BQ flags.",
            color: "#1e40af",
          },
        ];
        return (
          <>
            <div
              className="card no-print"
              style={{
                background:
                  "var(--brand-header-bg)",
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
                  <h2 style={{ margin: 0, color: "white" }}>MTSS Coordinator</h2>
                  <div style={{ opacity: 0.9, fontSize: "0.9rem", marginTop: 4 }}>
                    Hub for MTSS workflows, communication templates, and student
                    support tooling.
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {tools.filter((t) => t.show !== false).map((t) => (
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
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div
              style={{
                borderTopLeftRadius: "var(--radius-lg, 8px)",
                borderTopRightRadius: "var(--radius-lg, 8px)",
                overflow: "hidden",
                marginBottom: "-1px",
              }}
            >
              <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
              <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
                <h2
                  style={{
                    margin: 0,
                    color: "white",
                    fontSize: "1.5rem",
                    fontWeight: 700,
                  }}
                >
                  Templates
                </h2>
              </div>
            </div>
            <div
              className="card no-print"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: "0.75rem",
              }}
            >
              {tools.filter((t) => t.show !== false).map((t) => (
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
                  <span style={{ fontWeight: 600, color: t.color }}>
                    {t.label}
                  </span>
                  <span style={{ color: "#475569", fontSize: "0.85rem" }}>
                    {t.desc}
                  </span>
                </button>
              ))}
            </div>
          </>
        );
      })()}

      {activeSection === "mtssTemplates" && canAccessMtssHub && (() => {
        const mergeTokens: Array<{ token: string; label: string }> = [
          { token: "studentName", label: "Student Name" },
          { token: "studentId", label: "Student ID" },
          { token: "parentName", label: "Parent Name" },
          { token: "parentEmail", label: "Parent Email" },
          { token: "hallPassCount", label: "Hall Pass Count" },
          { token: "tardyCount", label: "Tardy Count" },
          { token: "checkInCount", label: "Check-In Count" },
          { token: "checkOutCount", label: "Check-Out Count" },
          { token: "pbisCount", label: "PBIS Entries Count" },
          { token: "pbisPoints", label: "PBIS Points Total" },
          { token: "lostMinutes", label: "Lost Instructional Minutes" },
          { token: "supportNotesCount", label: "Support Notes Count" },
          { token: "pulloutsCount", label: "Pullouts Count" },
        ];
        return (
          <>
            <div
              style={{
                borderTopLeftRadius: "var(--radius-lg, 8px)",
                borderTopRightRadius: "var(--radius-lg, 8px)",
                overflow: "hidden",
                marginBottom: "-1px",
              }}
            >
              <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
              <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
                <button
                  type="button"
                  className="back-button-purple"
                  style={{ marginBottom: 0 }}
                  onClick={() => setActiveSection("mtssCoordinator")}
                >
                  ← Back
                </button>
              </div>
            </div>
            <section className="card" style={{ overflow: "visible" }}>
              <h2
                style={{
                  margin: "0 0 0.75rem",
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: "#7c3aed",
                }}
              >
                Templates
              </h2>
              <p style={{ color: "#475569", marginTop: 0 }}>
                Create and edit parent communication templates. Use the{" "}
                <strong>Insert</strong> buttons to add Student Activity merge
                fields like <code>{"{{studentName}}"}</code> or{" "}
                <code>{"{{pbisPoints}}"}</code>. They are filled in
                automatically when you send from the Student Activity page.
              </p>

              <div style={{ marginBottom: "1rem" }}>
                <button
                  type="button"
                  onClick={() => {
                    const id = `tpl-${Date.now()}`;
                    setMtssTemplates((prev) => [
                      ...prev,
                      {
                        id,
                        name: "New Template",
                        subject: "",
                        body: "",
                      },
                    ]);
                  }}
                  style={{
                    background: "#7c3aed",
                    color: "#fff",
                    border: "none",
                    padding: "0.45rem 0.9rem",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  + New Template
                </button>
              </div>

              {mtssTemplates.length === 0 && (
                <div style={{ color: "#64748b" }}>No templates yet.</div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {mtssTemplates.map((tpl, idx) => (
                  <div
                    key={tpl.id}
                    style={{
                      border: "1px solid #cbd5e1",
                      borderRadius: 8,
                      padding: "0.85rem 1rem",
                      background: "#fafafa",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                        marginBottom: "0.5rem",
                      }}
                    >
                      <input
                        type="text"
                        value={tpl.name}
                        onChange={(e) =>
                          setMtssTemplates((prev) =>
                            prev.map((t, i) =>
                              i === idx ? { ...t, name: e.target.value } : t,
                            ),
                          )
                        }
                        placeholder="Template name"
                        style={{
                          flex: 1,
                          padding: "0.35rem 0.5rem",
                          fontWeight: 600,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete template "${tpl.name}"?`,
                            )
                          ) {
                            setMtssTemplates((prev) =>
                              prev.filter((_, i) => i !== idx),
                            );
                          }
                        }}
                        style={{
                          background: "#fee2e2",
                          color: "#b91c1c",
                          border: "1px solid #fecaca",
                          borderRadius: 6,
                          padding: "0.35rem 0.6rem",
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    </div>

                    <label
                      style={{
                        display: "block",
                        marginBottom: "0.5rem",
                        fontSize: "0.85rem",
                      }}
                    >
                      <div style={{ marginBottom: 2 }}>Subject:</div>
                      <input
                        type="text"
                        value={tpl.subject}
                        onChange={(e) =>
                          setMtssTemplates((prev) =>
                            prev.map((t, i) =>
                              i === idx
                                ? { ...t, subject: e.target.value }
                                : t,
                            ),
                          )
                        }
                        style={{ width: "100%", padding: "0.35rem 0.5rem" }}
                      />
                    </label>

                    <label
                      style={{
                        display: "block",
                        marginBottom: "0.5rem",
                        fontSize: "0.85rem",
                      }}
                    >
                      <div style={{ marginBottom: 2 }}>Body:</div>
                      <textarea
                        value={tpl.body}
                        onChange={(e) =>
                          setMtssTemplates((prev) =>
                            prev.map((t, i) =>
                              i === idx ? { ...t, body: e.target.value } : t,
                            ),
                          )
                        }
                        rows={6}
                        style={{
                          width: "100%",
                          padding: "0.4rem 0.5rem",
                          fontFamily: "inherit",
                        }}
                      />
                    </label>

                    <div style={{ marginTop: "0.5rem" }}>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "#475569",
                          marginBottom: 4,
                        }}
                      >
                        Insert Student Activity field:
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.35rem",
                        }}
                      >
                        {mergeTokens.map((m) => (
                          <button
                            key={m.token}
                            type="button"
                            onClick={() => {
                              const insert = `{{${m.token}}}`;
                              setMtssTemplates((prev) =>
                                prev.map((t, i) =>
                                  i === idx
                                    ? {
                                        ...t,
                                        body: t.body
                                          ? t.body + " " + insert
                                          : insert,
                                      }
                                    : t,
                                ),
                              );
                            }}
                            style={{
                              background: "#ede9fe",
                              color: "#5b21b6",
                              border: "1px solid #ddd6fe",
                              borderRadius: 999,
                              padding: "0.2rem 0.6rem",
                              fontSize: "0.78rem",
                              cursor: "pointer",
                            }}
                            title={`Insert {{${m.token}}}`}
                          >
                            + {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div
                style={{
                  marginTop: "1rem",
                  fontSize: "0.8rem",
                  color: "#64748b",
                }}
              >
                Templates save automatically.
              </div>
            </section>
          </>
        );
      })()}

      {activeSection === "logIntervention" && (
        <>
          <div
            style={{
              borderTopLeftRadius: "var(--radius-lg, 8px)",
              borderTopRightRadius: "var(--radius-lg, 8px)",
              overflow: "hidden",
              marginBottom: "-1px",
            }}
          >
            <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
            <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }}>
              <button
                type="button"
                className="back-button-purple"
                style={{ marginBottom: 0 }}
                onClick={() =>
                  setActiveSection(
                    isAdmin || isBehaviorSpec || authUser?.isSuperUser
                      ? "behaviorSpecialist"
                      : "hallPasses",
                  )
                }
              >
                ← Back
              </button>
            </div>
          </div>
          <section className="card">
            <h2
              style={{
                margin: "0 0 0.5rem",
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "#7c3aed",
              }}
            >
              Log Intervention
            </h2>
          <p style={{ color: "var(--text-subtle, #64748b)", marginTop: 0 }}>
            Record a classroom intervention you tried with a student. Your
            behavior specialist will see school-wide history; everyone else
            sees only their own entries.
          </p>
          <div className="card cp-cta-card">
            <div className="cp-cta-text">Need to Log an Intervention?</div>
            <button
              type="button"
              className="cp-cta-button"
              onClick={() => setCheckInOutOpen(true)}
            >
              + Log Intervention
            </button>
          </div>
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
          <h3 style={{ marginTop: "1.25rem" }}>Recent interventions</h3>
          {(() => {
            type CombinedRow = {
              key: string;
              createdAt: string;
              studentId: string;
              typeLabel: string;
              staffName: string;
              note: string | null;
              source: "intervention" | "checkInOut";
            };
            const combined: CombinedRow[] = [
              ...interventionEntries.map((e) => ({
                key: `i-${e.id}`,
                createdAt: e.createdAt,
                studentId: e.studentId,
                typeLabel: e.interventionType,
                staffName: e.staffName,
                note: e.note,
                source: "intervention" as const,
              })),
              ...tardies
                .filter(
                  (t) =>
                    t.entryType === "checkin" ||
                    t.entryType === "checkout" ||
                    t.entryType === "intervention",
                )
                .map((t) => ({
                  key: `t-${t.id}`,
                  createdAt: t.createdAt,
                  studentId: t.studentId,
                  typeLabel:
                    t.entryType === "intervention"
                      ? t.checkInWith || "Intervention"
                      : t.entryType === "checkin"
                        ? "Check-In"
                        : "Check-Out",
                  staffName:
                    t.createdBy ||
                    (t.entryType === "intervention"
                      ? t.teacherName
                      : t.checkInWith || t.teacherName),
                  note: (t.notes && t.notes.trim()) || null,
                  source: "checkInOut" as const,
                })),
            ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            const rows = combined.slice(0, 50);
            if (rows.length === 0) {
              return (
                <p style={{ color: "var(--text-subtle, #64748b)" }}>
                  No interventions logged yet.
                </p>
              );
            }
            return (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr
                  style={{
                    textAlign: "left",
                    borderBottom: "2px solid #cbd5e1",
                    background: "#f8fafc",
                  }}
                >
                  <th style={{ padding: "0.5rem 0.5rem", fontSize: "0.78rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Date / Time</th>
                  <th style={{ padding: "0.5rem 0.5rem", fontSize: "0.78rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Student ID</th>
                  <th style={{ padding: "0.5rem 0.5rem", fontSize: "0.78rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Student Name</th>
                  <th style={{ padding: "0.5rem 0.5rem", fontSize: "0.78rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Grade</th>
                  <th style={{ padding: "0.5rem 0.5rem", fontSize: "0.78rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Intervention</th>
                  <th style={{ padding: "0.5rem 0.5rem", fontSize: "0.78rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Logged By</th>
                  <th style={{ padding: "0.5rem 0.5rem", fontSize: "0.78rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const s = students.find((s) => s.studentId === row.studentId);
                  const hasNote = !!(row.note && row.note.trim());
                  const canViewNote =
                    Boolean(authUser?.isAdmin || authUser?.isSuperUser) ||
                    isBehaviorSpec;
                  const popoverActive = intervNotePopoverId === row.key;
                  return (
                    <tr key={row.key} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "0.5rem 0.5rem", whiteSpace: "nowrap" }}>
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: "0.5rem 0.5rem", fontFamily: "monospace" }}>
                        {row.studentId}
                      </td>
                      <td style={{ padding: "0.5rem 0.5rem" }}>
                        {s ? `${s.firstName} ${s.lastName}` : "—"}
                      </td>
                      <td style={{ padding: "0.5rem 0.5rem" }}>
                        {s ? String(s.grade).padStart(2, "0") : "—"}
                      </td>
                      <td style={{ padding: "0.5rem 0.5rem" }}>
                        {row.typeLabel}
                      </td>
                      <td style={{ padding: "0.5rem 0.5rem" }}>
                        {row.staffName}
                      </td>
                      <td style={{ padding: "0.5rem 0.5rem", position: "relative" }}>
                        {hasNote ? (
                          canViewNote ? (
                            <button
                              type="button"
                              onClick={() =>
                                setIntervNotePopoverId(
                                  popoverActive ? null : numericId,
                                )
                              }
                              style={{
                                padding: "2px 10px",
                                borderRadius: 999,
                                background: "#ede9fe",
                                color: "#5b21b6",
                                border: "1px solid #c4b5fd",
                                fontWeight: 600,
                                fontSize: "0.75rem",
                                cursor: "pointer",
                              }}
                              aria-label="View note"
                            >
                              Notes
                            </button>
                          ) : (
                            <span
                              style={{
                                padding: "2px 10px",
                                borderRadius: 999,
                                background: "#f1f5f9",
                                color: "#64748b",
                                border: "1px solid #e2e8f0",
                                fontWeight: 600,
                                fontSize: "0.75rem",
                              }}
                            >
                              Notes
                            </span>
                          )
                        ) : (
                          <span style={{ color: "#cbd5e1" }}>—</span>
                        )}
                        {popoverActive && hasNote && canViewNote && (
                          <div
                            style={{
                              position: "absolute",
                              top: "calc(100% + 4px)",
                              right: 0,
                              zIndex: 20,
                              width: 320,
                              background: "white",
                              border: "1px solid #c4b5fd",
                              borderRadius: 8,
                              boxShadow: "0 8px 24px rgba(15,23,42,0.15)",
                              padding: "0.75rem",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: "0.4rem",
                              }}
                            >
                              <strong style={{ fontSize: "0.8rem", color: "#475569" }}>
                                Note from {row.staffName}
                              </strong>
                              <button
                                type="button"
                                onClick={() => setIntervNotePopoverId(null)}
                                style={{
                                  background: "none",
                                  border: "none",
                                  fontSize: "1.1rem",
                                  cursor: "pointer",
                                  color: "#64748b",
                                  lineHeight: 1,
                                }}
                                aria-label="Close note"
                              >
                                ×
                              </button>
                            </div>
                            <div
                              style={{
                                fontSize: "0.85rem",
                                color: "#0f172a",
                                whiteSpace: "pre-wrap",
                                marginBottom: "0.4rem",
                              }}
                            >
                              {row.note}
                            </div>
                            <div
                              style={{
                                fontSize: "0.7rem",
                                color: "#94a3b8",
                              }}
                            >
                              {new Date(row.createdAt).toLocaleString()}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            );
          })()}
        </section>
        </>
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

      {activeSection === "pbisReasons" && isPbisCoord && (
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

      {activeSection === "pbisMilestoneEmails" && isPbisCoord && (
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

      {activeSection === "schoolWidePbis" && (isBehaviorSpec || canAccessMtssHub || isAdmin) && (
        <section>
          <div style={{ marginBottom: "0.75rem" }}>
            <button
              type="button"
              className="back-button-purple"
              onClick={() =>
                setActiveSection(
                  isBehaviorSpec ? "behaviorSpecialist" : "mtssCoordinator",
                )
              }
            >
              ← Back
            </button>
          </div>
          <SchoolWidePbisAdminView />
        </section>
      )}

      {activeSection === "interventions" && canManageBehaviorLists && (
        <section className="card">
          <div className="section-header-bar-teal" />
          <div className="section-header-band-hub">
            <button
              type="button"
              className="back-button-purple"
              style={{ marginBottom: 0 }}
              onClick={() => setActiveSection("behaviorSpecialist")}
            >
              ← Back
            </button>
          </div>
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
          <div className="section-header-bar-teal" />
          <div className="section-header-band-hub">
            <button
              type="button"
              className="back-button-purple"
              style={{ marginBottom: 0 }}
              onClick={() => setActiveSection("behaviorSpecialist")}
            >
              ← Back
            </button>
          </div>
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
        <svg
          className="ekg-separator"
          viewBox="0 0 600 28"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            className="track"
            d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
          />
        </svg>
      )}

      {activeSection === "hallPassMgmt" && canManageBehaviorLists && (
        <section className="card">
          <div className="section-header-bar-teal" />
          <div className="section-header-band-hub" />
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
        <svg
          className="ekg-separator"
          viewBox="0 0 600 28"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            className="track"
            d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
          />
        </svg>
      )}

      {activeSection === "hallPassMgmt" && canManageBehaviorLists && (
        <section className="card">
          <div className="section-header-bar-teal" />
          <div className="section-header-band-hub" />
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
        <svg
          className="ekg-separator"
          viewBox="0 0 600 28"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            className="track"
            d="M0 14 H140 L150 14 L155 6 L162 22 L168 8 L175 14 H300 L310 14 L315 6 L322 22 L328 8 L335 14 H460 L470 14 L475 6 L482 22 L488 8 L495 14 H600"
          />
        </svg>
      )}

      {activeSection === "interventions" && canManageBehaviorLists && (
        <section className="card">
          <div className="section-header-bar-teal" />
          <div className="section-header-band-hub" />
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

      {activeSection === "trustedAdultInterventions" && canManageBehaviorLists && (
        <TrustedAdultInterventionsAdmin />
      )}

      {activeSection === "staffRoles" && canManageStaffRoles && authUser && (
        <StaffRolesMatrix currentUser={authUser} />
      )}

      {activeSection === "bellSchedule" && canManageBellSchedules && (
        <BellScheduleSection />
      )}

      {activeSection === "displays" && canManageDisplays && <Displays />}

      {activeSection === "settings" && canManageSettings && settingsTile === null && (
        <SettingsHub
          tiles={(() => {
            const allowlistCount = Object.keys(teacherAllowlistMap).length;
            const locationsCount = Object.keys(effectiveDestinationsByRoom).length;
            const staffDefaultsCount = Object.keys(staffDefaults).length;
            const tiles: SettingsTile[] = [
              {
                id: "notifications",
                icon: "🔔",
                title: "Admin Notifications",
                subtitle: "Pending alerts that need a response.",
                badge: adminNotifications.length,
                group: "admin-tenancy",
              },
              {
                id: "kiosk-setup",
                icon: "🔗",
                title: "Kiosk Setup",
                subtitle: "URL, PIN, and QR code for kiosk activation.",
                group: "hall-pass-ops",
              },
              {
                id: "allowlist",
                icon: "🚪",
                title: "Allowed Locations per Teacher",
                subtitle: `Per-teacher pass destination overrides${allowlistCount ? ` · ${allowlistCount} teachers configured` : ""}.`,
                group: "hall-pass-ops",
              },
              {
                id: "locations",
                icon: "📍",
                title: "Locations",
                subtitle: `Rooms, destinations, and pairings${locationsCount ? ` · ${locationsCount} origin rooms` : ""}.`,
                group: "hall-pass-ops",
              },
              {
                id: "school",
                icon: "🏫",
                title: "School Settings",
                subtitle: "Branding, sender name, periods, and bell schedule.",
                group: "school-identity",
              },
              {
                id: "bell-schedule",
                icon: "🔔",
                title: "School Bell Schedule",
                subtitle:
                  "Manage Regular, Activity, and Early Release bell schedules.",
                group: "school-identity",
              },
              {
                id: "pbis-thresholds",
                icon: "🎯",
                title: "PBIS Thresholds",
                subtitle:
                  "Tune the alerts shown in the PBIS Hub Needs Attention panel.",
                group: "feature-config",
              },
              {
                id: "staff-defaults",
                icon: "📋",
                title: "Staff Defaults",
                subtitle: `Default rooms by name${staffDefaultsCount ? ` · ${staffDefaultsCount} configured` : ""}. Replaced by per-staff Default Room.`,
                legacy: true,
                group: "feature-config",
              },
            ];
            // School Features — admin + SuperUser. Lets the admin
            // turn off features for their school (within whatever the
            // SuperUser has allowed). Counts how many of the six are
            // currently effective so the tile shows an at-a-glance
            // badge.
            const featureKeys = [
              "FamilyComm",
              "Pbis",
              "SchoolStore",
              "Accommodations",
              "LogIntervention",
              "RequestPullout",
            ] as const;
            const liveCount = featureKeys.reduce((n, k) => {
              const ssRec = schoolSettings as Record<string, unknown>;
              const adminOn = ssRec[`feature${k}`] !== false;
              const superOn = ssRec[`superFeature${k}`] !== false;
              return n + (adminOn && superOn ? 1 : 0);
            }, 0);
            tiles.push({
              id: "schoolFeatures",
              icon: "🧩",
              title: "School Features",
              subtitle: `Turn major features on or off for this school · ${liveCount}/${featureKeys.length} live.`,
              group: "feature-config",
            });
            tiles.push({
              id: "branding",
              icon: "🎨",
              title: "Branding",
              subtitle:
                "Header gradient, logo, and school colors for printouts, parent snapshot, and Kiosk.",
              group: "school-identity",
            });
            // Signage launcher — kiosk URLs for the three Pulse hallway-TV
            // screens (Heartbeat, Houses, Student Timeline). One-click open
            // and copy-link helpers live inside the tile.
            tiles.push({
              id: "signage",
              icon: "📺",
              title: "Signage",
              subtitle:
                "Hallway-TV kiosk URLs · Today's Heartbeat, PBIS House Cup, and Student Timeline.",
              group: "family-signage",
            });
            // Parent portal sections — admin/SuperUser only. Controls
            // which HeartBEAT sections this school's parents are allowed
            // to see in their snapshot. Sensitive sections start off.
            if (isAdmin || isSuperUser) {
              tiles.push({
                id: "parent-portal-sections",
                icon: "👪",
                title: "Parent portal sections",
                subtitle:
                  "Choose which HeartBEAT sections parents can see · sensitive sections off by default.",
                group: "family-signage",
              });
            }
            if (isSuperUser) {
              tiles.push({
                id: "tenancy",
                icon: "🏛️",
                title: "Tenancy",
                subtitle:
                  "Districts, schools, and per-school data assignment. SuperUser only.",
                group: "admin-tenancy",
              });
            }
            // Data Imports — gated on isAdmin (which includes SuperUser
            // + District Admin via the role flags). The route layer
            // re-checks via canImportSchoolData; this is just visibility.
            if (isAdmin || isDistrictAdmin || isSuperUser) {
              tiles.push({
                id: "data-imports",
                icon: "📥",
                title: "Data Imports",
                subtitle:
                  "Upload assessment CSVs (FAST, iReady, MAP, …) with auto-mapping, preview, and one-click rollback.",
                group: "admin-tenancy",
              });
            }
            return tiles;
          })()}
          onSelect={setSettingsTile}
        />
      )}

      {activeSection === "settings" && canManageSettings && settingsTile !== null && (
        <SettingsBackBar onBack={() => setSettingsTile(null)} />
      )}

      {activeSection === "settings" && canManageSettings && settingsTile === "tenancy" && isSuperUser && (
        <TenancyPanel />
      )}

      {activeSection === "settings" && canManageSettings && settingsTile === "data-imports" && (
        <DataImports canActAsDistrict={canActAsDistrict} />
      )}

      {activeSection === "settings" && canManageSettings && settingsTile === "parent-portal-sections" && (isAdmin || isSuperUser) && (
        <HeartbeatSectionsAdmin />
      )}

      {activeSection === "parentAccess" && canManageSettings && (
        <ParentAccess />
      )}

      {activeSection === "superUserHome" && isSuperUser && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>SuperUser Home</h2>
          <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
            Cross-district control surface. The full toolset lands in
            Phases 3–5; this page lists what's coming so you have a single
            place to bookmark.
          </p>
          <div
            style={{
              display: "grid",
              gap: "0.75rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              marginTop: "1rem",
            }}
          >
            {SUPER_USER_HOME_CARDS.map((c) => (
              <PlaceholderCard key={c.title} title={c.title} body={c.body} phase={c.phase} />
            ))}
          </div>
        </div>
      )}

      {activeSection === "insights" && canAccessMtssHub && (
        <InsightsHub
          tiles={INSIGHTS_TILES}
          onNavigate={(target) => setActiveSection(target as typeof activeSection)}
        />
      )}

      {activeSection === "insightsWatchlist" && (
        <InsightsWatchlist
          onOpenStudent={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // Always pin the back-target on launch so we never inherit a
            // stale value (e.g. "teacherRoster") from an earlier flow
            // where the user navigated away without clicking Back on the
            // profile.
            setStudentProfileReturnTo("insightsWatchlist");
            setActiveSection("studentProfile");
          }}
          onOpenSpider={(studentId) => {
            // Same target as the row click, but exposed as an explicit
            // affordance next to the student name. Pin the back-target
            // for symmetry with the row click above.
            setSelectedInsightsStudentId(studentId);
            setStudentProfileReturnTo("insightsWatchlist");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "myWatchList" && (
        <MyWatchList
          // Pass the signed-in user so MyWatchList can show the
          // "Add to whose watch list?" picker for core-team roles
          // (admin / MTSS coord / behavior specialist / PBIS coord /
          // SuperUser). Plain teachers just see the standard
          // self-add flow.
          currentUser={authUser}
          onOpenStudent={(studentId) => {
            // Mirror the InsightsWatchlist drill-in pattern: pin the
            // back-target so the profile's Back button returns here,
            // not to the system Watch List.
            setSelectedInsightsStudentId(studentId);
            setStudentProfileReturnTo("myWatchList");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "engagementDashboard" && canAccessMtssHub && (
        <EngagementDashboard
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // Pin the back-target so the profile's Back button returns
            // to the engagement dashboard (not the watchlist or
            // wherever the user was before).
            setStudentProfileReturnTo("engagementDashboard");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "behaviorDashboard" && canAccessMtssHub && (
        <BehaviorDashboard
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // Pin the back-target so the profile's Back button returns
            // to the behavior dashboard.
            setStudentProfileReturnTo("behaviorDashboard");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "academicsDashboard" && canAccessMtssHub && (
        <AcademicsDashboard
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // Pin the back-target so the profile's Back button returns
            // to the academics dashboard.
            setStudentProfileReturnTo("academicsDashboard");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "academicsTrajectory" && canAccessMtssHub && (
        <AcademicsTrajectory
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // Pin the back-target so the profile's Back button returns
            // to the trajectory dashboard.
            setStudentProfileReturnTo("academicsTrajectory");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "attendanceDashboard" && canAccessMtssHub && (
        <AttendanceDashboard
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // Pin the back-target so the profile's Back button returns
            // to the attendance dashboard.
            setStudentProfileReturnTo("attendanceDashboard");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "sebSelDashboard" && canAccessMtssHub && (
        <SebSelDashboard
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // Pin the back-target so the profile's Back button returns
            // to the SEB/SEL dashboard.
            setStudentProfileReturnTo("sebSelDashboard");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "equityDashboard" && canAccessMtssHub && (
        <EquityDashboard
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            // V1 equity view is aggregate-only (no per-student lists yet),
            // but we wire the return-to anyway so a future drill-in can
            // navigate back to this dashboard cleanly.
            setStudentProfileReturnTo("equityDashboard");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "earlyWarningDashboard" && canAccessMtssHub && (
        <EarlyWarningDashboard
          onOpenProfile={(studentId) => {
            setSelectedInsightsStudentId(studentId);
            setStudentProfileReturnTo("earlyWarningDashboard");
            setActiveSection("studentProfile");
          }}
        />
      )}

      {activeSection === "studentProfile" && selectedInsightsStudentId && (
        <StudentProfile
          studentId={selectedInsightsStudentId}
          // Mirror the server-side requireCoreTeam gate in
          // routes/studentFlags.ts (SU/Admin/Behavior Specialist/MTSS
          // Coordinator/PBIS Coordinator). canAccessMtssHub omits PBIS
          // Coordinator and would hide the affordance for an
          // authorized actor; canManageMtssPlans matches the server.
          canManage={canManageMtssPlans}
          onBack={() => {
            const target = studentProfileReturnTo;
            setSelectedInsightsStudentId(null);
            setStudentProfileReturnTo("insightsWatchlist");
            setActiveSection(target);
          }}
        />
      )}

      {activeSection === "trustedAdultsAdmin" && canAccessMtssHub && (
        <TrustedAdultsAdmin canManage={canAccessMtssHub} />
      )}

      {activeSection === "districtAdmin" && canActAsDistrict && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>District Overview</h2>
          <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
            District Admin landing. Tools that act on every school in your
            district will live here. Today this is a roadmap; the imports
            and dashboards land in Phases 3–4.
          </p>
          <div
            style={{
              display: "grid",
              gap: "0.75rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              marginTop: "1rem",
            }}
          >
            {DISTRICT_ADMIN_CARDS.map((c) => (
              <PlaceholderCard key={c.title} title={c.title} body={c.body} phase={c.phase} />
            ))}
          </div>
        </div>
      )}

      {activeSection === "settings" && canManageSettings && settingsTile === "signage" && (
        <SignageLauncherView authUser={authUser} />
      )}

      {activeSection === "settings" && canManageSettings && settingsTile === "branding" && (
        <SchoolBrandingPanel />
      )}

      {activeSection === "settings" && canManageSettings && settingsTile === "notifications" && (
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

      {activeSection === "activeKiosks" && canManageSettings && (
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

      {activeSection === "settings" && canManageSettings && settingsTile === "kiosk-setup" && (() => {
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

      {activeSection === "settings" && canManageSettings && settingsTile === "bell-schedule" && (
        <BellScheduleSection />
      )}

      {activeSection === "settings" && canManageSettings && settingsTile === "pbis-thresholds" && (() => {
        const ranges = [
          {
            field: "pbisQuietTeacherDays" as const,
            label: "Quiet Teacher window (school days)",
            help: 'Teachers with no points in this many school days appear in "quiet teachers" alert.',
            min: 1,
            max: 60,
            unit: "days",
          },
          {
            field: "pbisInvisibleStudentDays" as const,
            label: "Invisible Student window (school days)",
            help: 'Students with 0 points in this many school days appear in "invisible students" alert.',
            min: 1,
            max: 180,
            unit: "days",
          },
          {
            field: "pbisReasonImbalancePct" as const,
            label: "Reason Imbalance threshold (%)",
            help: "Alerts fire when a single reason exceeds this share of weekly points.",
            min: 10,
            max: 100,
            unit: "%",
          },
          {
            field: "pbisColdPeriodMultiple" as const,
            label: "Cold Period multiple (×)",
            help: "Alerts fire for periods running this many times below the weekly average.",
            min: 2,
            max: 20,
            unit: "×",
          },
        ];
        return (
          <div className="card" style={{ marginTop: "1rem" }}>
            <h2>PBIS Thresholds</h2>
            <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
              These tunings drive the Needs Attention panel on the PBIS Hub.
              Changes save when you click "Save School Settings" below.
            </p>
            <div style={{ display: "grid", gap: "1rem", maxWidth: 560 }}>
              {ranges.map((r) => (
                <label
                  key={r.field}
                  style={{ display: "grid", gap: "0.25rem" }}
                >
                  <span>
                    {r.label}
                    <span
                      style={{
                        color: "var(--text-subtle, #64748b)",
                        fontWeight: "normal",
                        marginLeft: "0.5rem",
                        fontSize: "0.85rem",
                      }}
                    >
                      ({r.min}–{r.max} {r.unit})
                    </span>
                  </span>
                  <span
                    style={{
                      color: "var(--text-subtle, #64748b)",
                      fontSize: "0.82rem",
                    }}
                  >
                    {r.help}
                  </span>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                    }}
                  >
                    <input
                      type="number"
                      min={r.min}
                      max={r.max}
                      step={1}
                      value={schoolSettings[r.field]}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        const next = Number.isFinite(n)
                          ? Math.max(r.min, Math.min(r.max, Math.trunc(n)))
                          : schoolSettings[r.field];
                        setSchoolSettings({
                          ...schoolSettings,
                          [r.field]: next,
                        });
                      }}
                      style={{ width: "6rem" }}
                    />
                    <span style={{ color: "var(--text-subtle, #64748b)" }}>
                      {r.unit}
                    </span>
                  </div>
                </label>
              ))}
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  marginTop: "0.5rem",
                }}
              >
                <button
                  type="button"
                  onClick={() => void saveSchoolSettings()}
                  disabled={settingsStatus === "saving"}
                >
                  {settingsStatus === "saving"
                    ? "Saving…"
                    : "Save School Settings"}
                </button>
                {settingsStatus === "saved" && (
                  <span style={{ color: "#15803d" }}>Saved.</span>
                )}
                {settingsStatus === "error" && (
                  <span style={{ color: "#b91c1c" }}>{settingsError}</span>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {activeSection === "settings" && canManageSettings && settingsTile === "schoolFeatures" && (() => {
        // Two-tier feature toggles. Each row has both the SuperUser
        // gate (super_feature_*) and the admin switch (feature_*).
        // Effective = both ON. The admin checkbox locks itself when
        // SuperUser has the feature turned off — and the API enforces
        // the same rule in case anyone bypasses the UI.
        const features: ReadonlyArray<{
          key:
            | "FamilyComm"
            | "Pbis"
            | "SchoolStore"
            | "Accommodations"
            | "LogIntervention"
            | "RequestPullout";
          label: string;
          help: string;
        }> = [
          {
            key: "FamilyComm",
            label: "Family Communication",
            help: "Parent emails / messaging hub in the sidebar.",
          },
          {
            key: "Pbis",
            label: "PBIS Points",
            help: "Award and review PBIS points school-wide.",
          },
          {
            key: "SchoolStore",
            label: "School Store",
            help: "Read-only catalog in sidebar plus the admin store-management tile in the BS / MTSS / PBIS hubs.",
          },
          {
            key: "Accommodations",
            label: "Accommodations",
            help: "Per-student accommodations workspace.",
          },
          {
            key: "LogIntervention",
            label: "Log Interventions",
            help: "Sidebar entry for logging Tier 2/3 interventions, plus the BS-hub tile.",
          },
          {
            key: "RequestPullout",
            label: "Request Pullouts",
            help: "Teachers request behavior pullouts from class.",
          },
        ];
        const ssRec = schoolSettings as Record<string, unknown>;
        const adminVal = (k: string): boolean => ssRec[`feature${k}`] !== false;
        const superVal = (k: string): boolean =>
          ssRec[`superFeature${k}`] !== false;
        return (
          <div className="card" style={{ marginTop: "1rem" }}>
            <h2 style={{ marginTop: 0 }}>School Features</h2>
            <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
              Turn major features on or off for this school. A feature is
              live only when both the district SuperUser allows it and the
              school admin enables it.
              {!isSuperUser && (
                <>
                  {" "}
                  Greyed-out rows are disabled by your district SuperUser
                  and can&rsquo;t be turned back on here.
                </>
              )}
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isSuperUser
                  ? "1.6fr auto auto"
                  : "1.6fr auto",
                gap: "0.5rem 1.25rem",
                alignItems: "center",
                maxWidth: 720,
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--text-subtle)" }}>
                Feature
              </div>
              {isSuperUser && (
                <div
                  style={{
                    fontWeight: 600,
                    color: "var(--text-subtle)",
                    fontSize: 12,
                  }}
                  title="Allowed by district / SuperUser. Acts as the billing or availability gate."
                >
                  Allowed
                </div>
              )}
              <div
                style={{
                  fontWeight: 600,
                  color: "var(--text-subtle)",
                  fontSize: 12,
                }}
                title="Enabled by the school admin within whatever the SuperUser allowed."
              >
                Enabled
              </div>
              {features.map((f) => {
                const sup = superVal(f.key);
                const adm = adminVal(f.key);
                const adminLocked = !sup; // SuperUser-off forces the admin checkbox off.
                return (
                  <Fragment key={f.key}>
                    <div>
                      <div style={{ fontWeight: 500 }}>{f.label}</div>
                      <div
                        style={{ fontSize: 12, color: "var(--text-subtle)" }}
                      >
                        {f.help}
                      </div>
                    </div>
                    {isSuperUser && (
                      <input
                        type="checkbox"
                        checked={sup}
                        onChange={(e) =>
                          setSchoolSettings({
                            ...schoolSettings,
                            [`superFeature${f.key}`]: e.target.checked,
                          } as typeof schoolSettings)
                        }
                        title="SuperUser: allow this feature for this school."
                      />
                    )}
                    <input
                      type="checkbox"
                      checked={adm && sup}
                      disabled={adminLocked}
                      onChange={(e) =>
                        setSchoolSettings({
                          ...schoolSettings,
                          [`feature${f.key}`]: e.target.checked,
                        } as typeof schoolSettings)
                      }
                      title={
                        adminLocked
                          ? "Disabled by your district SuperUser."
                          : "Admin: turn this feature on or off for the school."
                      }
                      style={adminLocked ? { opacity: 0.4 } : undefined}
                    />
                  </Fragment>
                );
              })}
            </div>
            <div
              style={{
                marginTop: "1rem",
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
              }}
            >
              <button
                type="button"
                onClick={() => void saveSchoolSettings()}
                disabled={settingsStatus === "saving"}
              >
                {settingsStatus === "saving" ? "Saving…" : "Save Features"}
              </button>
              {settingsStatus === "saved" && (
                <span style={{ color: "#15803d" }}>Saved.</span>
              )}
              {settingsStatus === "error" && (
                <span style={{ color: "#b91c1c" }}>{settingsError}</span>
              )}
            </div>
          </div>
        );
      })()}

      {activeSection === "settings" && canManageSettings && (settingsTile === "allowlist" || settingsTile === "locations" || settingsTile === "staff-defaults" || settingsTile === "school") && (
        <>
        {settingsTile === "allowlist" && (
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
        )}
        {settingsTile === "locations" && (
        <LocationsAdmin
          onChanged={() => {
            authFetch("/api/location-allowed-destinations")
              .then((r) => r.json())
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
              .catch(() => {});
          }}
        />
        )}
        {settingsTile === "staff-defaults" && (
        <StaffDefaultsAdmin
          originLocations={Object.keys(effectiveDestinationsByRoom).sort((a, b) =>
            a.localeCompare(b),
          )}
          onSaved={() => {
            authFetch("/api/staff-defaults")
              .then((r) => (r.ok ? r.json() : []))
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
        )}
        {settingsTile === "school" && (
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
        )}
        </>
      )}

      <LogTardyModal
        open={logTardyOpen}
        onClose={() => setLogTardyOpen(false)}
        students={students}
        onSubmit={async (payload) => {
          const res = await authFetch("/api/tardies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentId: payload.studentId,
              teacherName: currentStaffUser,
              period: payload.period,
              reason: "",
              entryType: "tardy",
              checkInWith: null,
              notes: "",
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || "Failed to log tardy.");
          }
          if (payload.createReturnPass) {
            const lookupRes = await authFetch(
              `/api/section-lookup?studentId=${encodeURIComponent(payload.studentId)}&period=${encodeURIComponent(payload.period)}`,
            );
            if (!lookupRes.ok) {
              loadTardies();
              const text = await lookupRes.text();
              throw new Error(
                text ||
                  `No teacher found for student ${payload.studentId} in period ${payload.period}.`,
              );
            }
            const info = await lookupRes.json();
            const passRes = await authFetch("/api/hall-passes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                studentId: payload.studentId,
                destination: info.teacherName,
                originRoom: "Front Office",
                teacherName: currentStaffUser,
                destinationTeacher: info.teacherName,
                contactedAcknowledged: true,
                isTardyReturn: true,
              }),
            });
            if (!passRes.ok) {
              loadTardies();
              const text = await passRes.text();
              throw new Error(text || "Failed to create return pass.");
            }
            loadHallPasses();
          }
          loadTardies();
        }}
      />

      <CheckInOutModal
        open={checkInOutOpen}
        onClose={() => setCheckInOutOpen(false)}
        students={students}
        currentUser={currentStaffUser}
        onSubmit={async (payload) => {
          const res = await authFetch("/api/tardies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentId: payload.studentId,
              teacherName: currentStaffUser,
              period: "",
              reason: "",
              entryType: payload.entryType,
              checkInWith: payload.checkInWith,
              notes:
                payload.entryType === "intervention" && payload.checkInWith
                  ? `[Intervention: ${payload.checkInWith}]${payload.notes ? " " + payload.notes : ""}`
                  : payload.notes,
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || "Failed to log entry.");
          }
          loadTardies();
        }}
      />
      </main>
    </div>
  );
}

export default App;
