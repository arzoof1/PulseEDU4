import { useEffect, useRef, useState } from "react";
import Login from "./Login";

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

const staffPeriods: Record<string, number[]> = {
  "Ms. Rivera": [1, 3, 5],
  "Mr. Johnson": [2, 4, 6],
  "Coach Lee": [1, 2, 7],
  "Ms. Patel (Counselor)": [],
  "Mr. Davis (Admin)": [],
  "Ms. Garcia (Interventionist)": [3, 5, 7],
};

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
  staffName: string;
  createdAt: string;
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

function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [hallPasses, setHallPasses] = useState<HallPass[]>([]);
  const [editingPassId, setEditingPassId] = useState<number | null>(null);
  const [editEndedAt, setEditEndedAt] = useState<string>("");
  const [editCreatedAt, setEditCreatedAt] = useState<string>("");
  const [tardies, setTardies] = useState<Tardy[]>([]);

  const [selectedTeacher, setSelectedTeacher] = useState(teachers[0]);
  const [authUser, setAuthUser] = useState<{
    id: number;
    email: string;
    displayName: string;
    isAdmin: boolean;
  } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const currentStaffUser = authUser?.displayName ?? "";
  const [dateFilter, setDateFilter] = useState<"today" | "all">("all");
  const [staffFilter, setStaffFilter] = useState<"all" | "mine">("all");
  const [passFilter, setPassFilter] = useState<"all" | "mine">("all");
  const [activeSection, setActiveSection] = useState<
    "hallPasses" | "tardies" | "student" | "pbis" | "accommodations" | "settings"
  >("hallPasses");
  const [schoolSettings, setSchoolSettings] = useState<{
    schoolName: string;
    fromName: string;
    emailSignature: string;
  }>({ schoolName: "", fromName: "", emailSignature: "" });
  const [settingsStatus, setSettingsStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [settingsError, setSettingsError] = useState("");
  const [activityStudentId, setActivityStudentId] = useState("");
  const [activityStudentSearch, setActivityStudentSearch] = useState("");
  const [studentTab, setStudentTab] = useState<
    | "summary"
    | "hallPasses"
    | "tardy"
    | "pbis"
    | "supportNotes"
    | "contact"
  >("summary");
  const [accView, setAccView] = useState<"student" | "roster">("student");
  const [rosterAccommodation, setRosterAccommodation] = useState("");
  const [accStudentId, setAccStudentId] = useState("");
  const [rosterPeriod, setRosterPeriod] = useState("");
  const [periodRoster, setPeriodRoster] = useState<Record<string, string[]>>({});
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

  const [pbisEntries, setPbisEntries] = useState<PbisEntry[]>([]);
  const [supportNotes, setSupportNotes] = useState<SupportNote[]>([]);
  const [supportNoteType, setSupportNoteType] = useState(supportNoteTypes[0]);
  const [supportNoteText, setSupportNoteText] = useState("");
  const [pbisStudentId, setPbisStudentId] = useState("");
  const [pbisStudentSearch, setPbisStudentSearch] = useState("");
  const [pbisOptionIndex, setPbisOptionIndex] = useState(0);
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
  const [kioskOriginRooms, setKioskOriginRooms] = useState<string[]>([]);
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

  const loadHallPasses = () => {
    fetch("/api/hall-passes")
      .then((res) => res.json())
      .then((data: HallPass[]) => setHallPasses(data))
      .catch((err) => console.error("Failed to load hall passes:", err));
  };

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((user) => setAuthUser(user))
      .catch(() => setAuthUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!authUser) return;
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("Health check response:", data))
      .catch((err) => console.error("Health check failed:", err));

    fetch("/api/students")
      .then((res) => res.json())
      .then((data: Student[]) => setStudents(data))
      .catch((err) => console.error("Failed to load students:", err));

    fetch("/api/locations")
      .then((res) => res.json())
      .then(
        (
          data: {
            name: string;
            isOrigin: boolean;
            active: boolean;
          }[],
        ) => {
          setKioskOriginRooms(
            data
              .filter((l) => l.isOrigin && l.active)
              .map((l) => l.name)
              .sort((a, b) => a.localeCompare(b)),
          );
        },
      )
      .catch((err) => console.error("Failed to load locations:", err));

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

    fetch("/api/schedule")
      .then((res) => res.json())
      .then((data: { periodRoster: Record<string, string[]> }) =>
        setPeriodRoster(data.periodRoster),
      )
      .catch((err) => console.error("Failed to load schedule:", err));

    loadHallPasses();

    loadTardies();
    loadPbis();
    loadSupportNotes();
    loadSchoolSettings();
  }, []);

  const loadSchoolSettings = () => {
    fetch("/api/school-settings")
      .then((res) => res.json())
      .then((data) =>
        setSchoolSettings({
          schoolName: data.schoolName ?? "",
          fromName: data.fromName ?? "",
          emailSignature: data.emailSignature ?? "",
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

  const logAccommodationProvided = async (
    studentId: string,
    accommodation: string,
    period: number | null,
  ) => {
    try {
      const res = await fetch("/api/accommodation-logs", {
        method: "POST",
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
    const option = pbisOptions[pbisOptionIndex];
    if (!option) return;
    try {
      const res = await fetch("/api/pbis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: pbisStudentId,
          reason: option.reason,
          points: option.points,
          staffName: currentStaffUser,
        }),
      });
      if (!res.ok) throw new Error("Failed to save PBIS entry");
      loadPbis();
      setPbisStudentId("");
      setPbisStudentSearch("");
      setPbisOptionIndex(0);
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

  const isAdmin = currentStaffUser.includes("(Admin)");

  useEffect(() => {
    if (!isAdmin && activeSection === "settings") {
      setActiveSection("hallPasses");
    }
  }, [isAdmin, activeSection]);

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
  ];
  const adminNavSections: NavSection[] = [
    { key: "settings", label: "Settings", icon: IconSettings },
  ];
  const renderNavItem = (s: NavSection) => (
    <button
      key={s.key}
      type="button"
      className={"nav-item" + (activeSection === s.key ? " active" : "")}
      onClick={() => setActiveSection(s.key)}
    >
      <span className="nav-icon">{s.icon}</span>
      {s.label}
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

      <aside className="sidebar">
        <div className="section-label">Workspace</div>
        {baseNavSections.map(renderNavItem)}
        {isAdmin && (
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
            <div className="section-label nav-admin-label">Admin</div>
            {adminNavSections.map(renderNavItem)}
          </>
        )}
      </aside>

      <main className="app-main">

      {activeSection === "hallPasses" && (<>
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

      <div className="card">
      <h2>Create Hall Pass</h2>
      <form onSubmit={handleSubmit} style={{ marginBottom: "1rem" }}>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Student:{" "}
            <input
              type="text"
              placeholder="Search by name or ID"
              value={studentSearch}
              onChange={(e) => {
                setStudentSearch(e.target.value);
                setSelectedStudentId("");
              }}
            />
          </label>
          {selectedStudentId ? (
            <div style={{ marginTop: "0.25rem" }}>
              Selected: <strong>{selectedStudentId}</strong>{" "}
              {(() => {
                const s = students.find(
                  (s) => s.studentId === selectedStudentId,
                );
                return s ? `- ${s.firstName} ${s.lastName}` : "";
              })()}{" "}
              <button
                type="button"
                onClick={() => {
                  setSelectedStudentId("");
                  setStudentSearch("");
                }}
              >
                Clear
              </button>
            </div>
          ) : (
            studentSearch && (
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
                    const q = studentSearch.toLowerCase();
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
                          setSelectedStudentId(s.studentId);
                          setStudentSearch(
                            `${s.studentId} - ${s.firstName} ${s.lastName}`,
                          );
                        }}
                      >
                        {s.studentId} - {s.firstName} {s.lastName}
                      </button>
                    </li>
                  ))}
                {students.filter((s) => {
                  const q = studentSearch.toLowerCase();
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
        <div style={{ marginBottom: "0.5rem", color: "var(--text-subtle)" }}>
          <label style={{ color: "var(--text-subtle)" }}>
            Origin Room:{" "}
            <select
              value={originRoom}
              style={{ color: "var(--text-subtle)" }}
              onChange={(e) => {
                const newRoom = e.target.value;
                setOriginRoom(newRoom);
                const allowed = effectiveDestinationsByRoom[newRoom] ?? [];
                if (destination && !allowed.includes(destination)) {
                  setDestination("");
                }
              }}
              required
            >
              <option value="">-- select an origin room --</option>
              {Object.keys(effectiveDestinationsByRoom)
                .sort((a, b) => a.localeCompare(b))
                .map((room) => (
                <option key={room} value={room}>
                  {room}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Destination:{" "}
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              required
              disabled={!originRoom}
            >
              <option value="">-- select a destination --</option>
              {(effectiveDestinationsByRoom[originRoom] ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Destination Teacher (optional):{" "}
            <select
              value={destinationTeacher}
              onChange={(e) => {
                setDestinationTeacher(e.target.value);
                setContactedAck(false);
              }}
            >
              <option value="">-- none --</option>
              {staffUsers
                .filter((u) => u !== currentStaffUser)
                .map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {destinationTeacher && (
          <div style={{ marginBottom: "0.5rem" }}>
            <label>
              <input
                type="checkbox"
                checked={contactedAck}
                onChange={(e) => setContactedAck(e.target.checked)}
              />{" "}
              I've contacted {destinationTeacher}
            </label>
          </div>
        )}
        <button
          type="submit"
          disabled={Boolean(destinationTeacher) && !contactedAck}
          title={
            destinationTeacher && !contactedAck
              ? `Confirm you've contacted ${destinationTeacher} to enable.`
              : undefined
          }
        >
          Create
        </button>
      </form>
      </div>

      <div className="card">
      <h2>Hall Passes</h2>
      <div style={{ marginBottom: "0.5rem" }}>
        <button
          type="button"
          onClick={() => setPassFilter("all")}
          disabled={passFilter === "all"}
        >
          All Passes
        </button>{" "}
        <button
          type="button"
          onClick={() => setPassFilter("mine")}
          disabled={passFilter === "mine"}
        >
          My Passes
        </button>
      </div>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
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
              dateFilter === "today" ? isCreatedToday(p.createdAt) : true,
            )
            .filter((p) =>
              staffFilter === "mine" ? p.teacherName === currentStaffUser : true,
            )
            .filter((p) =>
              passFilter === "mine" ? p.teacherName === currentStaffUser : true,
            )
            .map((p) => {
            const isAdmin = currentStaffUser.includes("(Admin)");
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
                <div style={{ fontWeight: 600 }}>{studentName(p.studentId)}</div>
                <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                  {p.studentId}
                </div>
              </td>
              <td>{p.teacherName}</td>
              <td>
                <div>{p.destination}</div>
                {p.destinationTeacher && (
                  <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                    → {p.destinationTeacher}
                  </div>
                )}
              </td>
              <td>{p.originRoom}</td>
              <td><span className={statusClass}>{statusLabel}</span></td>
              <td>
                {(() => {
                  const start = new Date(p.createdAt).getTime();
                  const end = p.endedAt
                    ? new Date(p.endedAt).getTime()
                    : now;
                  const mins = Math.max(0, Math.round((end - start) / 60000));
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
              <td style={{ backgroundColor: getTimeStatusColor(p, now) }}>
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
      </div>
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
                    <h3 style={{ marginTop: 0 }}>Student Daily Summary</h3>
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
                      const sLogs = accommodationLogs
                        .filter(
                          (l) =>
                            l.studentId === activityStudentId &&
                            inRange(l.createdAt),
                        )
                        .slice()
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                      return (
                        <div style={{ marginTop: "0.75rem" }}>
                          <h4 style={{ margin: "0 0 0.25rem 0" }}>
                            Accommodations Provided {label}: {sLogs.length}
                          </h4>
                          {sLogs.length === 0 ? (
                            <div>No accommodation-provided records.</div>
                          ) : (
                            <ul style={{ margin: 0 }}>
                              {sLogs.map((l) => (
                                <li key={l.id}>
                                  Accommodation Provided: {l.accommodation}
                                  {l.period != null
                                    ? ` | Period: ${l.period}`
                                    : ""}
                                  {" | Staff: "}
                                  {l.staffName || "(unknown)"}
                                  {" | Time: "}
                                  {new Date(l.createdAt).toLocaleString()}
                                </li>
                              ))}
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
                let subject = "Student Activity Update";
                let body = "";
                if (emailMessageType === "positive") {
                  subject = `Positive Update for ${studentName}`;
                  body =
                    `Hello,\n\n` +
                    `We wanted to share a positive update about ${studentName}.\n\n` +
                    `PBIS Points: ${totalPoints}\n` +
                    `PBIS Entries: ${studentPbis.length}\n` +
                    (recentPbis
                      ? `\nRecent recognitions:\n${recentPbis}\n`
                      : "") +
                    `\n${signature}`;
                } else if (emailMessageType === "pbis") {
                  subject = `PBIS Recognition for ${studentName}`;
                  body =
                    `Hello,\n\n` +
                    `${studentName} has been recognized for positive behavior.\n\n` +
                    `Total PBIS Points: ${totalPoints}\n` +
                    `Total PBIS Entries: ${studentPbis.length}\n` +
                    (recentPbis
                      ? `\nRecent PBIS recognitions:\n${recentPbis}\n`
                      : "\nNo PBIS entries yet.\n") +
                    `\n${signature}`;
                } else if (emailMessageType === "attendance") {
                  subject = `Attendance / Tardy Concern for ${studentName}`;
                  body =
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
                  subject = `Check-In / Check-Out Notice for ${studentName}`;
                  body =
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
                const sendEmail = async () => {
                  setEmailStatus("Sending...");
                  try {
                    const res = await fetch("/api/send-test-parent-email", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        studentName,
                        subject,
                        body,
                        parentEmail: recipientToUse,
                      }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                      const detail =
                        (data && (data.detail || data.error)) ||
                        `HTTP ${res.status}`;
                      throw new Error(detail);
                    }
                    setEmailStatus(`Sent to ${data.to || recipientToUse}.`);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(err);
                    setEmailStatus(`Error: ${msg}`);
                  }
                };
                return (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <div style={{ marginBottom: "0.25rem" }}>
                      <label>
                        Message Type:{" "}
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
                      </label>
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
                    <button
                      type="button"
                      onClick={sendEmail}
                      disabled={!activityStudentId || !recipientToUse}
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
            const allAccs = Array.from(
              new Set(students.flatMap((st) => st.accommodations ?? [])),
            ).sort();
            const myPeriods = staffPeriods[currentStaffUser] ?? [];
            const periodIds = rosterPeriod
              ? new Set(periodRoster[rosterPeriod] ?? [])
              : myPeriods.length > 0
                ? new Set(
                    myPeriods.flatMap((p) => periodRoster[String(p)] ?? []),
                  )
                : null;
            const rosterStudents = rosterAccommodation
              ? students.filter(
                  (st) =>
                    (st.accommodations ?? []).includes(rosterAccommodation) &&
                    (!periodIds || periodIds.has(st.studentId)),
                )
              : [];
            return (
              <section
                style={{
                  border: "1px solid #ccc",
                  padding: "0.75rem",
                  marginBottom: "1rem",
                }}
              >
                <div style={{ marginBottom: "0.75rem" }}>
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
                    onClick={() => setAccView("roster")}
                    disabled={accView === "roster"}
                  >
                    By Accommodation Roster
                  </button>
                </div>
                {accView === "student" ? (
                  <>
                    <h3 style={{ marginTop: 0 }}>Student Accommodations</h3>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <label>
                        Student:{" "}
                        <select
                          value={accStudentId}
                          onChange={(e) => setAccStudentId(e.target.value)}
                        >
                          <option value="">-- Select --</option>
                          {students.map((st) => (
                            <option key={st.studentId} value={st.studentId}>
                              {st.firstName} {st.lastName} ({st.studentId})
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {!accStudentId ? (
                      <div>Please select a student.</div>
                    ) : accs.length === 0 ? (
                      <div>No accommodations on file</div>
                    ) : (
                      <ul style={{ margin: 0 }}>
                        {accs.map((a) => (
                          <li key={a}>
                            {a}{" "}
                            <button
                              type="button"
                              onClick={() =>
                                logAccommodationProvided(accStudentId, a, null)
                              }
                            >
                              Log Accommodation Provided
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <>
                    <h3 style={{ marginTop: 0 }}>Roster by Accommodation</h3>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <label>
                        Period:{" "}
                        <select
                          value={rosterPeriod}
                          onChange={(e) => setRosterPeriod(e.target.value)}
                        >
                          <option value="">All My Periods</option>
                          {(staffPeriods[currentStaffUser] ?? []).map((p) => (
                            <option key={p} value={String(p)}>
                              Period {p}
                            </option>
                          ))}
                        </select>
                        {(staffPeriods[currentStaffUser] ?? []).length === 0 && (
                          <span style={{ marginLeft: "0.5rem", color: "#666" }}>
                            No periods assigned to {currentStaffUser}
                          </span>
                        )}
                      </label>
                    </div>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <label>
                        Accommodation:{" "}
                        <select
                          value={rosterAccommodation}
                          onChange={(e) =>
                            setRosterAccommodation(e.target.value)
                          }
                        >
                          <option value="">-- Select --</option>
                          {allAccs.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {!rosterAccommodation ? null : rosterStudents.length === 0 ? (
                      <div>No students found for this accommodation</div>
                    ) : (
                      <>
                        <div style={{ marginBottom: "0.5rem" }}>
                          <button
                            type="button"
                            onClick={() => {
                              const ok = window.confirm(
                                `Are all students present? Log this accommodation as provided for all ${rosterStudents.length} listed students?`,
                              );
                              if (!ok) return;
                              const period = rosterPeriod
                                ? Number(rosterPeriod)
                                : null;
                              rosterStudents.forEach((st) =>
                                logAccommodationProvided(
                                  st.studentId,
                                  rosterAccommodation,
                                  period,
                                ),
                              );
                            }}
                          >
                            Log Provided for All Listed Students
                          </button>
                        </div>
                        <ul style={{ margin: 0 }}>
                          {rosterStudents.map((st) => (
                            <li key={st.studentId}>
                              {st.firstName} {st.lastName} ({st.studentId}){" "}
                              <button
                                type="button"
                                onClick={() =>
                                  logAccommodationProvided(
                                    st.studentId,
                                    rosterAccommodation,
                                    rosterPeriod ? Number(rosterPeriod) : null,
                                  )
                                }
                              >
                                Log Provided
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </section>
            );
          })()}
        </section>
      </>)}

      {activeSection === "pbis" && (<>
        <section className="card">
          <h2>PBIS Points</h2>
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
            <div style={{ marginBottom: "0.5rem" }}>
              <label>
                PBIS Recognition:{" "}
                <select
                  value={pbisOptionIndex}
                  onChange={(e) =>
                    setPbisOptionIndex(Number(e.target.value))
                  }
                >
                  {pbisOptions.map((opt, i) => (
                    <option key={opt.reason} value={i}>
                      {opt.reason} ({opt.points}{" "}
                      {opt.points === 1 ? "point" : "points"})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button type="submit" disabled={!pbisStudentId}>
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
                <th>studentId</th>
                <th>name</th>
                <th>reason</th>
                <th>points</th>
                <th>staff</th>
                <th>createdAt</th>
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
                return (
                  <tr key={entry.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {studentName(entry.studentId)}
                      </div>
                      <div
                        style={{ fontSize: 11, color: "var(--text-subtle)" }}
                      >
                        {entry.studentId}
                      </div>
                    </td>
                    <td>{entry.reason}</td>
                    <td>{entry.points}</td>
                    <td>{entry.staffName || "-"}</td>
                    <td>{fmtTime(entry.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </>)}

      {activeSection === "settings" && isAdmin && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2>Kiosk URLs</h2>
          <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
            Open one of these on a classroom Chromebook (full-screen) so
            students can request hall passes without a teacher device.
            Destinations are limited to those marked student-visible for that
            room.
          </p>
          {kioskOriginRooms.length === 0 ? (
            <p style={{ color: "var(--text-subtle)" }}>
              No origin rooms found.
            </p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>
                    Room
                  </th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>
                    Kiosk URL
                  </th>
                  <th style={{ padding: "0.5rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {kioskOriginRooms.map((room) => {
                  const url = `${window.location.origin}${import.meta.env.BASE_URL}kiosk?room=${encodeURIComponent(room)}`;
                  return (
                    <tr key={room} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                        {room}
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        <code
                          style={{
                            fontSize: "0.85rem",
                            wordBreak: "break-all",
                          }}
                        >
                          {url}
                        </code>
                      </td>
                      <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(url);
                              setCopiedRoom(room);
                              setTimeout(() => setCopiedRoom(null), 1500);
                            } catch {
                              setCopiedRoom(null);
                            }
                          }}
                          style={{ marginRight: "0.5rem" }}
                        >
                          {copiedRoom === room ? "Copied!" : "Copy"}
                        </button>
                        <a href={url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeSection === "settings" && isAdmin && (
        <div className="card">
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
      </main>
    </div>
  );
}

export default App;
