import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { authFetch } from "../lib/authToken";
import { searchStudents } from "../lib/students";

// =============================================================================
// PickupTagsPanel — the single Parent Pickup hub
//
// One screen for the whole pickup-number lifecycle: school-wide assign,
// print (alphabetical / by teacher / by student), and per-tag manage
// (issue, restrict, deactivate, reprint). This replaces the older split
// where setup lived on the `/pickup/admin` URL and printing lived here.
//
// Path B numbering: one pickup number per SIS emergency contact per
// student — each number releases EXACTLY ONE child, no sibling matching.
// The school-wide "Assign pickup numbers" button is idempotent: a re-run
// after a roster import only fills the gaps.
//
// Server gate is `canManagePickup` in lib/coreTeam.ts (admin / Core
// Team / counselor / front-office secretary / confidential secretary).
// The client-side gate (canManagePickupClient in App.tsx) mirrors that
// boolean exactly so the nav item disappears for teachers.
// =============================================================================

type AuthRow = {
  id: number;
  studentId: number;
  parentId: number | null;
  guardianLabel: string;
  pickupNumber: string;
  restrictedFrom: boolean;
  active: boolean;
  contactSlot: number | null;
  parentDisplayName: string | null;
  // Manual-override metadata. `source` is 'sis' | 'portal' | 'manual'; a row is
  // office-owned (and protected from the RosterOne sync) when source==='manual'
  // OR it carries an overrideReason. expiresAt non-null = temporary override.
  source?: string | null;
  overrideReason?: string | null;
  overrideAt?: string | null;
  expiresAt?: string | null;
};

// One active office override, from GET /pickup/overrides/reconciliation.
type OverrideRow = {
  id: number;
  studentDbId: number;
  localSisId: string | null;
  studentName: string;
  grade: number | null;
  pickupNumber: string;
  guardianLabel: string;
  restricted: boolean;
  source: string;
  reason: string | null;
  overrideByName: string | null;
  overrideAt: string | null;
  expiresAt: string | null;
  temporary: boolean;
  expired: boolean;
  sisMayHaveContact: boolean;
};

// The /api/students search returns the full student row. We only read
// the safe identifiers here — localSisId is the school-facing SIS id.
// NEVER surface `studentId` (the state FLEID / district code) in the UI.
type StudentHit = {
  id: number;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade?: number | null;
};

type TeacherOption = {
  id: number;
  displayName: string;
};

const wrap: CSSProperties = {
  padding: "1.25rem 1.5rem",
  maxWidth: 960,
};

const card: CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 10,
  background: "var(--surface, #fff)",
  marginBottom: "1rem",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-subtle, #6b7280)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border, #d1d5db)",
  fontSize: 14,
  minWidth: 180,
};

// Override chips shown next to a guardian label / in the reconciliation tile.
const officeBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  padding: "1px 6px",
  borderRadius: 999,
  background: "#eef2ff",
  color: "#3730a3",
  border: "1px solid #c7d2fe",
  maxWidth: 220,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const tempChip: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 6px",
  borderRadius: 999,
  background: "#fef3c7",
  color: "#92400e",
  border: "1px solid #fde68a",
};
const expiredChip: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 6px",
  borderRadius: 999,
  background: "#fee2e2",
  color: "#991b1b",
  border: "1px solid #fecaca",
};
const disagreeChip: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  padding: "1px 6px",
  borderRadius: 999,
  background: "#fff7ed",
  color: "#9a3412",
  border: "1px solid #fed7aa",
};

const primaryBtn: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "var(--brand, #2563eb)",
  color: "#fff",
  border: "none",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtn: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "var(--surface, #fff)",
  color: "var(--text, #111827)",
  border: "1px solid var(--border, #d1d5db)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const smallBtn: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  background: "var(--surface, #fff)",
  color: "var(--text, #111827)",
  border: "1px solid var(--border, #d1d5db)",
  fontSize: 13,
  cursor: "pointer",
};

// Two-step danger confirmation overlay. We deliberately do NOT use
// window.confirm here: the Replit preview iframe silently suppresses native
// dialogs, so a confirm() would no-op and the destructive action would fire
// with no warning at all. These inline modals always render.
const modalOverlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const modalCard: CSSProperties = {
  background: "var(--surface, #fff)",
  color: "var(--text, #111827)",
  borderRadius: 12,
  padding: 20,
  maxWidth: 520,
  width: "100%",
  boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
  maxHeight: "90vh",
  overflowY: "auto",
};

const dangerBtn: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "#dc2626",
  color: "#fff",
  border: "none",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const ackRow: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  fontSize: 14,
  margin: "12px 0",
  color: "var(--text, #111827)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
  color: "var(--text-subtle, #6b7280)",
  fontWeight: 600,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const td: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-soft, #f3f4f6)",
};

const infoBox: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--surface-soft, #f3f4f6)",
  fontSize: 13,
  marginTop: 8,
};

export default function PickupTagsPanel() {
  const [studentDbIdInput, setStudentDbIdInput] = useState("");
  const [studentDbId, setStudentDbId] = useState<number | null>(null);
  const [studentLabel, setStudentLabel] = useState<string>("");
  const [auths, setAuths] = useState<AuthRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // School-wide assign (Path B). Idempotent on the server, but we still
  // confirm before firing because it can mint thousands of numbers.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  // Two-step gate for the school-wide assign (the high-blast-radius action):
  // an "I understand" checkbox AND a typed-word confirmation must both pass
  // before the destructive button enables.
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkAck, setBulkAck] = useState(false);
  const [bulkType, setBulkType] = useState("");

  // Two-step gate for the per-tag reprint/reissue (invalidates a family's
  // distributed card): an "I understand" checkbox plus an explicit confirm.
  const [confirmReissue, setConfirmReissue] = useState<AuthRow | null>(null);
  const [reissueAck, setReissueAck] = useState(false);

  // Manual issue form (for the looked-up student) — covers the edge case
  // of a student with no SIS contact who still needs an extra number.
  const [issueGuardian, setIssueGuardian] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [issueRestricted, setIssueRestricted] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  // Issue-form override fields. A hand-issued tag is always a manual override,
  // so the reason is required by the server. Temporary = expiry set.
  const [issueReason, setIssueReason] = useState("");
  const [issueTemporary, setIssueTemporary] = useState(false);
  const [issueExpiresAt, setIssueExpiresAt] = useState("");

  // Reason modal for restrict / unrestrict / deactivate / set-expiry actions.
  // Inline reason capture — the preview iframe blocks window.prompt, so we
  // never use a native dialog.
  const [reasonModal, setReasonModal] = useState<{
    auth: AuthRow;
    action: "restrict" | "unrestrict" | "deactivate";
    patch: { restrictedFrom?: boolean; active?: boolean };
    title: string;
  } | null>(null);
  const [reasonText, setReasonText] = useState("");

  // Reconciliation tile (active office overrides + SIS-agreement hints).
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [overridesCounts, setOverridesCounts] = useState<{
    total: number;
    restricted: number;
    temporary: number;
    sisDisagrees: number;
  } | null>(null);
  const [overridesBusy, setOverridesBusy] = useState(false);

  // Per-row in-flight guard (reissue / restrict / deactivate).
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);

  // Name typeahead. Debounced /api/students?q= against the same search
  // the Admin Hub discipline modal uses — prefix-matches first/last
  // name and SIS id, school-scoped server-side. Picking a hit populates
  // studentDbId (numeric PK), which the load path consumes; we keep the
  // manual DB-id input as an escape hatch for tickets citing an id.
  const [nameQ, setNameQ] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showHits, setShowHits] = useState(false);
  const searchSeq = useRef(0);

  // Teacher picker. Loaded once from /api/teacher-roster/teachers
  // (Core Team sees every active teacher with a non-planning section;
  // teachers themselves see only themselves — but they're gated out
  // of this panel entirely so the dropdown effectively serves admins
  // and office staff). Local filter on displayName is plenty for
  // typical school sizes (<200 teachers); no debounce needed.
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [teacherQ, setTeacherQ] = useState("");
  const [showTeacherHits, setShowTeacherHits] = useState(false);
  const [teacherBusy, setTeacherBusy] = useState(false);
  // Resolved teacher + tag-id set. Selecting a teacher only LOADS the
  // ids (count is shown to the user), then explicit Download/View
  // buttons trigger the PDF — the prior "click name → instant
  // download" surprised users who wanted to confirm the count first.
  const [selectedTeacher, setSelectedTeacher] =
    useState<TeacherOption | null>(null);
  const [teacherAuthIds, setTeacherAuthIds] = useState<number[]>([]);
  const [teacherStudentCount, setTeacherStudentCount] = useState(0);

  const refresh = useCallback(async (sid: number) => {
    setLoading(true);
    try {
      const res = await authFetch(
        `/api/pickup/authorizations?studentDbId=${sid}`,
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `Load failed (${res.status})`);
        setAuths([]);
        return;
      }
      const data = (await res.json()) as { authorizations: AuthRow[] };
      setAuths(data.authorizations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (studentDbId !== null) void refresh(studentDbId);
  }, [studentDbId, refresh]);

  const loadStudent = () => {
    const n = Number(studentDbIdInput);
    if (!Number.isInteger(n) || n <= 0) {
      setMsg("Enter a numeric student database id");
      return;
    }
    setMsg(null);
    setStudentLabel(`Student #${n}`);
    setStudentDbId(n);
  };

  // Debounced name search. Aborts stale responses with searchSeq so a
  // slow earlier request can't overwrite a faster later one.
  useEffect(() => {
    const q = nameQ.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const mySeq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await searchStudents<StudentHit>(q, 12);
        if (mySeq !== searchSeq.current) return;
        setHits(data);
      } finally {
        if (mySeq === searchSeq.current) setSearching(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [nameQ]);

  // One-shot teacher load on mount. Quiet failure: the by-teacher
  // card simply stays empty if the endpoint is unreachable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`/api/teacher-roster/teachers`);
        if (!res.ok) return;
        const data = (await res.json()) as { teachers: TeacherOption[] };
        if (cancelled) return;
        setTeachers(data.teachers ?? []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTeachers = (() => {
    const q = teacherQ.trim().toLowerCase();
    if (!q) return teachers.slice(0, 12);
    return teachers
      .filter((t) => (t.displayName ?? "").toLowerCase().includes(q))
      .slice(0, 12);
  })();

  // School-wide assign — Path B (one number per emergency contact).
  const openBulkConfirm = () => {
    setBulkAck(false);
    setBulkType("");
    setBulkResult(null);
    setConfirmBulk(true);
  };

  const runBulkAssign = async () => {
    setConfirmBulk(false);
    setBulkBusy(true);
    setBulkResult(null);
    setMsg(null);
    try {
      const res = await authFetch(`/api/pickup/authorizations/bulk-assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const b = (await res.json().catch(() => ({}))) as {
        assigned?: number;
        upgraded?: number;
        studentsTouched?: number;
        cappedStudents?: number;
        error?: string;
      };
      if (!res.ok) {
        setBulkResult(b.error ?? `Assign failed (${res.status})`);
        return;
      }
      const assigned = b.assigned ?? 0;
      const upgraded = b.upgraded ?? 0;
      const touched = b.studentsTouched ?? 0;
      const capped = b.cappedStudents ?? 0;
      const cappedNote =
        capped > 0
          ? ` ${capped} student(s) hit the 8-adult cap — extra contacts ` +
            "were skipped."
          : "";
      const upgradedNote =
        upgraded > 0
          ? ` Upgraded ${upgraded} older code(s) to add a letter (e.g. 1026 → ` +
            "1026A) — reprint those tags."
          : "";
      setBulkResult(
        assigned === 0 && upgraded === 0
          ? "All students are already assigned — nothing to do." + cappedNote
          : assigned === 0
            ? "No new codes needed." + upgradedNote + cappedNote
            : `Issued ${assigned} new code(s) across ${touched} student(s).` +
              upgradedNote +
              cappedNote,
      );
      if (studentDbId !== null) void refresh(studentDbId);
    } catch (err) {
      setBulkResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  };

  // Load (but don't print) the tag-id set for a teacher. Surface the
  // count so the user can sanity-check before downloading 47 pages.
  const loadTagsForTeacher = async (t: TeacherOption) => {
    setMsg(null);
    setTeacherBusy(true);
    setSelectedTeacher(t);
    setTeacherAuthIds([]);
    setTeacherStudentCount(0);
    try {
      const res = await authFetch(
        `/api/pickup/authorizations/by-teacher?teacherId=${t.id}`,
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `Lookup failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        authorizationIds: number[];
        studentCount: number;
        rosterSize?: number;
      };
      setTeacherAuthIds(data.authorizationIds);
      setTeacherStudentCount(data.studentCount);
      if (data.authorizationIds.length === 0) {
        setMsg(
          `No active pickup tags on ${t.displayName}'s roster ` +
            `(${data.rosterSize ?? 0} students).`,
        );
      }
    } finally {
      setTeacherBusy(false);
      setShowTeacherHits(false);
    }
  };

  const teacherFilenameSlug = (t: TeacherOption | null) =>
    t ? t.displayName.replace(/[^a-z0-9]+/gi, "-") : "teacher";

  const downloadTeacherPdf = () => {
    if (!selectedTeacher || teacherAuthIds.length === 0) return;
    return downloadPdf(
      `/api/pickup/tags.pdf?ids=${teacherAuthIds.join(",")}`,
      `pickup-tags-${teacherFilenameSlug(selectedTeacher)}.pdf`,
    );
  };

  const viewTeacherPdf = () => {
    if (!selectedTeacher || teacherAuthIds.length === 0) return;
    return viewPdf(`/api/pickup/tags.pdf?ids=${teacherAuthIds.join(",")}`);
  };

  const studentHitLabel = (s: StudentHit) => {
    const sis = s.localSisId ? ` (SIS ${s.localSisId})` : "";
    const grade =
      s.grade !== null && s.grade !== undefined ? ` · grade ${s.grade}` : "";
    return `${s.lastName}, ${s.firstName}${sis}${grade}`;
  };

  const pickStudent = (s: StudentHit) => {
    setStudentDbIdInput(String(s.id));
    setStudentLabel(studentHitLabel(s));
    setNameQ(`${s.firstName} ${s.lastName}`);
    setShowHits(false);
    setMsg(null);
    setStudentDbId(s.id);
  };

  // Fetch a tag-PDF response via authFetch (so the school-scoped
  // session cookie rides along — window.open() to the URL directly
  // would skip the cookie inside the Replit iframe and 401), then
  // hand back a same-origin blob: URL the caller can use for a
  // download anchor or a `_blank` window.open.
  const fetchPdfBlobUrl = async (url: string): Promise<string | null> => {
    setMsg(null);
    try {
      const res = await authFetch(url);
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `PDF failed (${res.status})`);
        return null;
      }
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const downloadPdf = async (url: string, filename: string) => {
    const objectUrl = await fetchPdfBlobUrl(url);
    if (!objectUrl) return;
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  };

  // Open the PDF inline in a new tab so the user can preview before
  // printing. blob: URLs don't need cookies, so this works inside the
  // Replit iframe even though a direct window.open(url) would 401.
  const viewPdf = async (url: string) => {
    const objectUrl = await fetchPdfBlobUrl(url);
    if (!objectUrl) return;
    const w = window.open(objectUrl, "_blank", "noopener,noreferrer");
    if (!w) {
      setMsg(
        "Pop-up blocked — allow pop-ups for this site to view the PDF inline, or use Download instead.",
      );
    }
    // Revoke later than download because the new tab needs the URL
    // alive while the user is reading the PDF.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5 * 60_000);
  };

  const printOne = (a: AuthRow) =>
    downloadPdf(
      `/api/pickup/authorizations/${a.id}/tag.pdf`,
      `pickup-tag-${a.pickupNumber}.pdf`,
    );

  const viewOne = (a: AuthRow) =>
    viewPdf(`/api/pickup/authorizations/${a.id}/tag.pdf`);

  // Reprint = reissue: deactivate the old number (curb keypad rejects it
  // immediately) and mint a fresh one, then download the new tag. This
  // is the "lost tag" flow — the family's old card stops working.
  const openReissueConfirm = (a: AuthRow) => {
    setReissueAck(false);
    setConfirmReissue(a);
  };

  const reissueAndPrint = async (a: AuthRow) => {
    setConfirmReissue(null);
    setRowBusyId(a.id);
    setMsg(null);
    try {
      const res = await authFetch(
        `/api/pickup/authorizations/${a.id}/reissue`,
        { method: "POST" },
      );
      const b = (await res.json().catch(() => ({}))) as {
        authorization?: { id: number; pickupNumber: string };
        error?: string;
      };
      if (!res.ok || !b.authorization) {
        setMsg(b.error ?? `Reissue failed (${res.status})`);
        return;
      }
      if (studentDbId !== null) await refresh(studentDbId);
      await downloadPdf(
        `/api/pickup/authorizations/${b.authorization.id}/tag.pdf`,
        `pickup-tag-${b.authorization.pickupNumber}.pdf`,
      );
    } finally {
      setRowBusyId(null);
    }
  };

  const patchAuth = async (
    a: AuthRow,
    patch: {
      restrictedFrom?: boolean;
      active?: boolean;
      expiresAt?: string | null;
    },
    overrideReason: string,
  ) => {
    setRowBusyId(a.id);
    setMsg(null);
    try {
      const res = await authFetch(`/api/pickup/authorizations/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, overrideReason }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `Update failed (${res.status})`);
        return false;
      }
      if (studentDbId !== null) await refresh(studentDbId);
      void fetchOverrides();
      return true;
    } finally {
      setRowBusyId(null);
    }
  };

  // Open the inline reason modal for an action that needs a justification.
  const openReasonModal = (
    auth: AuthRow,
    action: "restrict" | "unrestrict" | "deactivate",
  ) => {
    setReasonText("");
    const patch =
      action === "deactivate"
        ? { active: false }
        : { restrictedFrom: action === "restrict" };
    const title =
      action === "deactivate"
        ? `Deactivate tag ${auth.pickupNumber}`
        : action === "restrict"
          ? `Restrict ${auth.guardianLabel}`
          : `Unrestrict ${auth.guardianLabel}`;
    setReasonModal({ auth, action, patch, title });
  };

  const submitReasonModal = async () => {
    if (!reasonModal) return;
    const reason = reasonText.trim();
    if (reason.length < 5) {
      setMsg("Enter a reason of at least 5 characters.");
      return;
    }
    const ok = await patchAuth(reasonModal.auth, reasonModal.patch, reason);
    if (ok) setReasonModal(null);
  };

  // Load the active office overrides + SIS-agreement hints for the tile.
  const fetchOverrides = useCallback(async () => {
    setOverridesBusy(true);
    try {
      const res = await authFetch(`/api/pickup/overrides/reconciliation`);
      if (!res.ok) return;
      const b = (await res.json().catch(() => ({}))) as {
        overrides?: OverrideRow[];
        counts?: {
          total: number;
          restricted: number;
          temporary: number;
          sisDisagrees: number;
        };
      };
      setOverrides(b.overrides ?? []);
      setOverridesCounts(b.counts ?? null);
    } finally {
      setOverridesBusy(false);
    }
  }, []);

  useEffect(() => {
    void fetchOverrides();
  }, [fetchOverrides]);

  const issueForStudent = async () => {
    if (studentDbId === null) return;
    const label = issueGuardian.trim();
    if (!label) {
      setMsg("Enter a guardian label (e.g. Mom, Dad, Grandma).");
      return;
    }
    const reason = issueReason.trim();
    if (reason.length < 5) {
      setMsg(
        "A reason of at least 5 characters is required to hand-issue a pickup tag.",
      );
      return;
    }
    if (issueTemporary && !issueExpiresAt) {
      setMsg("Pick an expiry date/time for a temporary tag, or turn off Temporary.");
      return;
    }
    setIssueBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        studentDbId,
        guardianLabel: label,
        restrictedFrom: issueRestricted,
        overrideReason: reason,
      };
      const num = issueNumber.trim();
      if (num) body.pickupNumber = num;
      if (issueTemporary && issueExpiresAt) {
        // datetime-local is wall-clock; send a real instant (UTC ISO).
        body.expiresAt = new Date(issueExpiresAt).toISOString();
      }
      const res = await authFetch(`/api/pickup/authorizations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `Issue failed (${res.status})`);
        return;
      }
      setIssueGuardian("");
      setIssueNumber("");
      setIssueRestricted(false);
      setIssueReason("");
      setIssueTemporary(false);
      setIssueExpiresAt("");
      await refresh(studentDbId);
      void fetchOverrides();
    } finally {
      setIssueBusy(false);
    }
  };

  const activeIdsForStudent = () =>
    auths.filter((a) => a.active).map((a) => a.id);

  const printActiveForStudent = () => {
    const ids = activeIdsForStudent();
    if (ids.length === 0) {
      setMsg("No active authorizations to print for this student.");
      return;
    }
    return downloadPdf(
      `/api/pickup/tags.pdf?ids=${ids.join(",")}`,
      `pickup-tags-student-${studentDbId}.pdf`,
    );
  };

  const viewActiveForStudent = () => {
    const ids = activeIdsForStudent();
    if (ids.length === 0) {
      setMsg("No active authorizations to view for this student.");
      return;
    }
    return viewPdf(`/api/pickup/tags.pdf?ids=${ids.join(",")}`);
  };

  const printAllActive = () =>
    downloadPdf(
      `/api/pickup/tags.pdf`,
      `pickup-tags-all-${new Date().toISOString().slice(0, 10)}.pdf`,
    );

  const viewAllActive = () => viewPdf(`/api/pickup/tags.pdf`);

  // Per-family OFFICE REFERENCE STRIP — one row per student listing the base
  // number + every authorized adult's letter/label, for the front desk.
  const printOfficeStrip = () =>
    downloadPdf(
      `/api/pickup/office-strip.pdf`,
      `pickup-office-reference-${new Date().toISOString().slice(0, 10)}.pdf`,
    );

  const viewOfficeStrip = () => viewPdf(`/api/pickup/office-strip.pdf`);

  const bulkReady = bulkAck && bulkType.trim().toUpperCase() === "ASSIGN";

  return (
    <div style={wrap}>
      {confirmBulk && (
        <div style={modalOverlay} role="dialog" aria-modal="true">
          <div style={modalCard}>
            <div
              style={{
                fontWeight: 800,
                fontSize: 18,
                color: "#b91c1c",
                marginBottom: 8,
              }}
            >
              ⚠️ Assign pickup numbers school-wide
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.5, marginTop: 0 }}>
              This runs across the <strong>entire school</strong>. It fills in
              any missing numbers and <strong>upgrades older letterless codes</strong>{" "}
              (e.g. <code>1026</code> → <code>1026A</code>). Any tag whose number
              changes <strong>must be reprinted and redistributed</strong> — the
              old printed card will stop working at the curb.
            </p>
            <p style={{ fontSize: 14, lineHeight: 1.5 }}>
              Students who already have lettered codes are left unchanged. This
              is a front-office action — curb monitors do not have it.
            </p>
            <label style={ackRow}>
              <input
                type="checkbox"
                checked={bulkAck}
                onChange={(e) => setBulkAck(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                I understand this can change existing pickup numbers and require
                reprinting tags that families already have.
              </span>
            </label>
            <label style={labelStyle}>Type ASSIGN to confirm</label>
            <input
              value={bulkType}
              onChange={(e) => setBulkType(e.target.value)}
              placeholder="ASSIGN"
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
            />
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 16,
              }}
            >
              <button
                style={secondaryBtn}
                onClick={() => setConfirmBulk(false)}
              >
                Cancel
              </button>
              <button
                style={{
                  ...dangerBtn,
                  opacity: bulkReady ? 1 : 0.5,
                  cursor: bulkReady ? "pointer" : "not-allowed",
                }}
                disabled={!bulkReady}
                onClick={runBulkAssign}
              >
                Assign numbers
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmReissue && (
        <div style={modalOverlay} role="dialog" aria-modal="true">
          <div style={modalCard}>
            <div
              style={{
                fontWeight: 800,
                fontSize: 18,
                color: "#b91c1c",
                marginBottom: 8,
              }}
            >
              ⚠️ Reprint tag {confirmReissue.pickupNumber}
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.5, marginTop: 0 }}>
              Reprinting issues a <strong>new number</strong> for{" "}
              <strong>{confirmReissue.guardianLabel}</strong> and{" "}
              <strong>immediately invalidates</strong> the current card
              (<code>{confirmReissue.pickupNumber}</code>). The family's existing
              printed card will stop working at the curb until they receive the
              new one.
            </p>
            <label style={ackRow}>
              <input
                type="checkbox"
                checked={reissueAck}
                onChange={(e) => setReissueAck(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                I understand the current card will stop working and a new tag
                must be given to the family.
              </span>
            </label>
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 16,
              }}
            >
              <button
                style={secondaryBtn}
                onClick={() => setConfirmReissue(null)}
              >
                Cancel
              </button>
              <button
                style={{
                  ...dangerBtn,
                  opacity: reissueAck ? 1 : 0.5,
                  cursor: reissueAck ? "pointer" : "not-allowed",
                }}
                disabled={!reissueAck}
                onClick={() => void reissueAndPrint(confirmReissue)}
              >
                Reprint &amp; download
              </button>
            </div>
          </div>
        </div>
      )}

      {reasonModal && (
        <div style={modalOverlay} role="dialog" aria-modal="true">
          <div style={modalCard}>
            <div
              style={{
                fontWeight: 800,
                fontSize: 18,
                marginBottom: 8,
              }}
            >
              {reasonModal.title}
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.5, marginTop: 0 }}>
              This is an <strong>office override</strong> of the RosterOne
              record. It stays in force until manually cleared. A reason is
              required and recorded in the audit log.
            </p>
            <label style={labelStyle}>
              Reason (required, min 5 characters)
              <textarea
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                style={{
                  ...inputStyle,
                  minWidth: "100%",
                  minHeight: 70,
                  resize: "vertical",
                }}
                placeholder="e.g. Court order on file — Dad not authorized for pickup"
                autoFocus
              />
            </label>
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 16,
              }}
            >
              <button style={secondaryBtn} onClick={() => setReasonModal(null)}>
                Cancel
              </button>
              <button
                style={{
                  ...dangerBtn,
                  opacity: reasonText.trim().length >= 5 ? 1 : 0.5,
                  cursor:
                    reasonText.trim().length >= 5 ? "pointer" : "not-allowed",
                }}
                disabled={
                  reasonText.trim().length < 5 ||
                  rowBusyId === reasonModal.auth.id
                }
                onClick={() => void submitReasonModal()}
              >
                {rowBusyId === reasonModal.auth.id ? "Saving…" : "Save override"}
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 style={{ marginTop: 0 }}>Parent Pickup</h2>
      <p style={{ color: "var(--text-subtle, #6b7280)", marginTop: 0 }}>
        Assign pickup numbers, print tags (alphabetical, by teacher, or by
        student), and manage individual tags — all from this screen. PDFs
        open as downloads.
      </p>

      {overridesCounts && overridesCounts.total > 0 && (
        <div
          style={{
            ...card,
            borderLeft: "4px solid #7c3aed",
            background: "#faf5ff",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 700 }}>
              Office overrides in force ({overridesCounts.total})
            </div>
            <button
              style={smallBtn}
              onClick={() => void fetchOverrides()}
              disabled={overridesBusy}
            >
              {overridesBusy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-subtle, #6b7280)",
              marginBottom: 10,
            }}
          >
            These pickup records were set manually by the front office and will
            stay in force until cleared — RosterOne syncs will not overwrite
            them. {overridesCounts.restricted} restricted ·{" "}
            {overridesCounts.temporary} temporary
            {overridesCounts.sisDisagrees > 0 && (
              <>
                {" "}
                ·{" "}
                <strong style={{ color: "#9a3412" }}>
                  {overridesCounts.sisDisagrees} where RosterOne disagrees
                </strong>
              </>
            )}
            .
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Student</th>
                  <th style={th}>SIS ID</th>
                  <th style={th}>#</th>
                  <th style={th}>Guardian</th>
                  <th style={th}>Reason</th>
                  <th style={th}>By</th>
                  <th style={th}>Expires</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id}>
                    <td style={td}>
                      <div
                        style={{
                          display: "flex",
                          gap: 4,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <span>{o.studentName}</span>
                        {o.restricted && (
                          <span style={expiredChip}>Restricted</span>
                        )}
                        {!o.sisMayHaveContact && (
                          <span
                            style={disagreeChip}
                            title="RosterOne does not appear to list this contact — the office override is keeping a manual value RosterOne disagrees with. Review."
                          >
                            RosterOne disagrees
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={td}>{o.localSisId ?? "—"}</td>
                    <td style={td}>{o.pickupNumber}</td>
                    <td style={td}>{o.guardianLabel}</td>
                    <td style={td}>{o.reason ?? "—"}</td>
                    <td style={td}>{o.overrideByName ?? "—"}</td>
                    <td style={td}>
                      {o.expiresAt ? (
                        <span style={o.expired ? expiredChip : tempChip}>
                          {o.expired
                            ? "Expired"
                            : new Date(o.expiresAt).toLocaleString()}
                        </span>
                      ) : (
                        "Permanent"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div
        style={{
          ...card,
          borderLeft: "4px solid var(--accent, #1d4ed8)",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          Step 1 · Assign pickup numbers school-wide
        </div>
        <div
          style={{
            color: "var(--text-subtle, #6b7280)",
            fontSize: 13,
            marginBottom: 10,
          }}
        >
          Issues one 4-digit number per emergency contact on file — each
          number releases exactly one child. Students with no contacts get a
          single "Family" number. Safe to re-run after a roster import; only
          missing numbers are filled.
        </div>
        <button
          onClick={openBulkConfirm}
          style={primaryBtn}
          disabled={bulkBusy}
        >
          {bulkBusy ? "Assigning…" : "Assign pickup numbers"}
        </button>
        {bulkResult && <div style={infoBox}>{bulkResult}</div>}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Print — school-wide (alphabetical by last name)
        </div>
        <div
          style={{
            color: "var(--text-subtle, #6b7280)",
            fontSize: 13,
            marginBottom: 8,
          }}
        >
          One PDF of every active pickup tag at this school, sorted A→Z by
          student last name.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={printAllActive}
            style={primaryBtn}
            title="Download one PDF containing every active pickup tag, A→Z by last name."
          >
            Download PDF (A→Z)
          </button>
          <button
            onClick={viewAllActive}
            style={secondaryBtn}
            title="Open the PDF in a new tab to preview before printing."
          >
            View PDF
          </button>
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#6b7280",
            margin: "14px 0 8px",
          }}
        >
          Office reference strip — one row per student showing the base number
          and every authorized adult's letter (1001 — A Mom · B Dad · C
          Grandma). Keep at the front desk; shows the local SIS ID only.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={printOfficeStrip}
            style={secondaryBtn}
            title="Download the per-family office reference list."
          >
            Download office reference
          </button>
          <button
            onClick={viewOfficeStrip}
            style={secondaryBtn}
            title="Open the office reference list in a new tab."
          >
            View office reference
          </button>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Print — by teacher
        </div>
        <div
          style={{
            color: "var(--text-subtle, #6b7280)",
            fontSize: 13,
            marginBottom: 8,
          }}
        >
          Prints active tags for every student on the teacher's
          non-planning roster. Useful for homeroom stacks at the start
          of the year.
        </div>
        <div style={{ position: "relative", display: "inline-block" }}>
          <input
            value={teacherQ}
            onChange={(e) => {
              setTeacherQ(e.target.value);
              setShowTeacherHits(true);
            }}
            onFocus={() => setShowTeacherHits(true)}
            onBlur={() => {
              setTimeout(() => setShowTeacherHits(false), 150);
            }}
            style={{ ...inputStyle, minWidth: 320 }}
            placeholder={
              teachers.length === 0
                ? "Loading teachers…"
                : "Type a teacher name…"
            }
            disabled={teacherBusy}
            autoComplete="off"
          />
          {showTeacherHits && teachers.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                marginTop: 4,
                background: "var(--surface, #fff)",
                border: "1px solid var(--border, #d1d5db)",
                borderRadius: 8,
                boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                maxHeight: 280,
                overflowY: "auto",
                zIndex: 20,
              }}
            >
              {filteredTeachers.length === 0 && (
                <div
                  style={{
                    padding: "8px 12px",
                    color: "var(--text-subtle, #6b7280)",
                    fontSize: 13,
                  }}
                >
                  No matches.
                </div>
              )}
              {filteredTeachers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setTeacherQ(t.displayName);
                    void loadTagsForTeacher(t);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px solid var(--border-soft, #f3f4f6)",
                    cursor: "pointer",
                    fontSize: 14,
                  }}
                >
                  {t.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
        {teacherBusy && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: "var(--text-subtle, #6b7280)",
            }}
          >
            Loading tag list…
          </div>
        )}
        {!teacherBusy &&
          selectedTeacher &&
          teacherAuthIds.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                background: "var(--surface-soft, #f3f4f6)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13 }}>
                Found{" "}
                <strong>{teacherAuthIds.length} tag(s)</strong> for{" "}
                <strong>{teacherStudentCount} student(s)</strong> on{" "}
                <strong>{selectedTeacher.displayName}</strong>'s roster.
              </div>
              <div
                style={{ display: "flex", gap: 8, marginLeft: "auto" }}
              >
                <button
                  onClick={downloadTeacherPdf}
                  style={primaryBtn}
                  title="Download the homeroom tag stack as a PDF."
                >
                  Download PDF
                </button>
                <button
                  onClick={viewTeacherPdf}
                  style={secondaryBtn}
                  title="Open the PDF in a new tab to preview before printing."
                >
                  View PDF
                </button>
              </div>
            </div>
          )}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Manage / print — by student
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ ...labelStyle, position: "relative" }}>
            Search by name or SIS id
            <input
              value={nameQ}
              onChange={(e) => {
                setNameQ(e.target.value);
                setShowHits(true);
              }}
              onFocus={() => setShowHits(true)}
              onBlur={() => {
                // Delay so an in-flight onMouseDown can fire before the
                // dropdown unmounts — otherwise the click is swallowed.
                setTimeout(() => setShowHits(false), 150);
              }}
              style={{ ...inputStyle, minWidth: 280 }}
              placeholder="Type at least 2 letters…"
              autoComplete="off"
            />
            {showHits && nameQ.trim().length >= 2 && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  marginTop: 4,
                  background: "var(--surface, #fff)",
                  border: "1px solid var(--border, #d1d5db)",
                  borderRadius: 8,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                  maxHeight: 280,
                  overflowY: "auto",
                  zIndex: 20,
                }}
              >
                {searching && (
                  <div style={{ padding: "8px 12px", color: "var(--text-subtle, #6b7280)", fontSize: 13 }}>
                    Searching…
                  </div>
                )}
                {!searching && hits.length === 0 && (
                  <div style={{ padding: "8px 12px", color: "var(--text-subtle, #6b7280)", fontSize: 13 }}>
                    No matches.
                  </div>
                )}
                {hits.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onMouseDown={(e) => {
                      // Fire on mousedown so the click lands before the
                      // input's onBlur tears the dropdown down.
                      e.preventDefault();
                      pickStudent(s);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 12px",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border-soft, #f3f4f6)",
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {s.lastName}, {s.firstName}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-subtle, #6b7280)" }}>
                      {s.localSisId ? `SIS ${s.localSisId}` : "No SIS id"}
                      {s.grade !== null && s.grade !== undefined
                        ? ` · grade ${s.grade}`
                        : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </label>
          <span style={{ alignSelf: "center", color: "var(--text-subtle, #6b7280)", fontSize: 12 }}>
            or
          </span>
          <label style={labelStyle}>
            Student DB id
            <input
              value={studentDbIdInput}
              onChange={(e) => setStudentDbIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadStudent();
              }}
              style={inputStyle}
              placeholder="e.g. 12345"
            />
          </label>
          <button onClick={loadStudent} style={primaryBtn}>
            Load
          </button>
        </div>
        {msg && <div style={infoBox}>{msg}</div>}
      </div>

      {studentDbId !== null && (
        <div style={card}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 600 }}>
              Authorizations for {studentLabel || `student #${studentDbId}`}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={printActiveForStudent}
                style={primaryBtn}
                title="Download all active tags for this student in one PDF."
                disabled={auths.filter((a) => a.active).length === 0}
              >
                Download all
              </button>
              <button
                onClick={viewActiveForStudent}
                style={secondaryBtn}
                title="Open the combined PDF in a new tab to preview."
                disabled={auths.filter((a) => a.active).length === 0}
              >
                View all
              </button>
            </div>
          </div>
          {loading ? (
            <div style={{ color: "var(--text-subtle, #6b7280)" }}>
              Loading…
            </div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Guardian</th>
                  <th style={th}>Parent</th>
                  <th style={th}>Restricted</th>
                  <th style={th}>Active</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {auths.map((a) => {
                  const busy = rowBusyId === a.id;
                  return (
                    <tr key={a.id}>
                      <td style={td}>{a.pickupNumber}</td>
                      <td style={td}>
                        <div
                          style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}
                        >
                          <span>{a.guardianLabel}</span>
                          {(a.source === "manual" || a.overrideReason) && (
                            <span
                              style={officeBadge}
                              title={a.overrideReason ?? "Office override"}
                            >
                              Office{a.overrideReason ? ` — ${a.overrideReason}` : ""}
                            </span>
                          )}
                          {a.expiresAt && (
                            <span
                              style={
                                new Date(a.expiresAt).getTime() < Date.now()
                                  ? expiredChip
                                  : tempChip
                              }
                              title={`Temporary override${
                                new Date(a.expiresAt).getTime() < Date.now()
                                  ? " (expired)"
                                  : ""
                              } — ${new Date(a.expiresAt).toLocaleString()}`}
                            >
                              {new Date(a.expiresAt).getTime() < Date.now()
                                ? "Expired"
                                : `Until ${new Date(a.expiresAt).toLocaleDateString()}`}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={td}>
                        {a.parentDisplayName ?? a.parentId ?? "—"}
                      </td>
                      <td style={td}>{a.restrictedFrom ? "yes" : "no"}</td>
                      <td style={td}>{a.active ? "yes" : "no"}</td>
                      <td style={td}>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <button
                            onClick={() => printOne(a)}
                            style={smallBtn}
                            title="Download a single-tag PDF (same number)."
                          >
                            Download
                          </button>
                          <button
                            onClick={() => viewOne(a)}
                            style={smallBtn}
                            title="Open the single-tag PDF in a new tab."
                          >
                            View
                          </button>
                          {a.active && (
                            <>
                              <button
                                onClick={() => openReissueConfirm(a)}
                                style={smallBtn}
                                disabled={busy}
                                title="Invalidate this number and print a fresh one (lost-tag reprint)."
                              >
                                {busy ? "…" : "Reprint (new #)"}
                              </button>
                              <button
                                onClick={() =>
                                  openReasonModal(
                                    a,
                                    a.restrictedFrom ? "unrestrict" : "restrict",
                                  )
                                }
                                style={smallBtn}
                                disabled={busy}
                                title="Toggle whether this guardian is blocked from picking up (reason required)."
                              >
                                {a.restrictedFrom ? "Unrestrict" : "Restrict"}
                              </button>
                              <button
                                onClick={() => openReasonModal(a, "deactivate")}
                                style={smallBtn}
                                disabled={busy}
                                title="Deactivate this number / clear the override (reason required)."
                              >
                                Deactivate
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {auths.length === 0 && (
                  <tr>
                    <td style={td} colSpan={6}>
                      No authorizations for this student.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: "1px solid var(--border-soft, #f3f4f6)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
              Issue another number for this student
            </div>
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "end",
                flexWrap: "wrap",
              }}
            >
              <label style={labelStyle}>
                Guardian label
                <input
                  value={issueGuardian}
                  onChange={(e) => setIssueGuardian(e.target.value)}
                  style={inputStyle}
                  placeholder="e.g. Mom, Grandma"
                />
              </label>
              <label style={labelStyle}>
                Number (optional)
                <input
                  value={issueNumber}
                  onChange={(e) => setIssueNumber(e.target.value)}
                  style={{ ...inputStyle, minWidth: 140 }}
                  placeholder="auto"
                />
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  paddingBottom: 8,
                }}
              >
                <input
                  type="checkbox"
                  checked={issueRestricted}
                  onChange={(e) => setIssueRestricted(e.target.checked)}
                />
                Restricted (blocked from pickup)
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  paddingBottom: 8,
                }}
              >
                <input
                  type="checkbox"
                  checked={issueTemporary}
                  onChange={(e) => {
                    setIssueTemporary(e.target.checked);
                    if (!e.target.checked) setIssueExpiresAt("");
                  }}
                />
                Temporary (expires)
              </label>
              {issueTemporary && (
                <label style={labelStyle}>
                  Expires
                  <input
                    type="datetime-local"
                    value={issueExpiresAt}
                    onChange={(e) => setIssueExpiresAt(e.target.value)}
                    style={{ ...inputStyle, minWidth: 200 }}
                  />
                </label>
              )}
              <label style={{ ...labelStyle, minWidth: 280, flex: 1 }}>
                Reason (required, min 5 characters)
                <input
                  value={issueReason}
                  onChange={(e) => setIssueReason(e.target.value)}
                  style={{ ...inputStyle, minWidth: "100%" }}
                  placeholder="Why is the office hand-issuing this tag?"
                />
              </label>
              <button
                onClick={() => void issueForStudent()}
                style={primaryBtn}
                disabled={issueBusy}
                title="Hand-issued tags are office overrides — RosterOne will not clobber them."
              >
                {issueBusy ? "Issuing…" : "Issue number"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
