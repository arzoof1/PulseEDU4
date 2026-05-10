import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Plus,
  Shield,
  StickyNote,
  Users,
} from "lucide-react";
import { authFetch } from "../lib/authToken";
import { formatCaseNumber } from "../lib/caseNumber";
import LogInteractionModal from "./watchlist/LogInteractionModal";
import VoiceTextarea from "./watchlist/VoiceTextarea";
import MentionTextarea from "./watchlist/MentionTextarea";
import VideoEvidencePanel from "./watchlist/VideoEvidencePanel";
import {
  ROLE_META,
  WL_COLORS as C,
  severityChipStyle,
  statusPillStyle,
  type Role,
} from "./watchlist/colors";
import {
  HowToUseHelp,
  HowToSection,
  howtoListStyle,
} from "./HowToUseHelp";

interface CaseRow {
  id: number;
  caseNumber: number;
  schoolYearLabel?: string;
  title: string;
  summary: string | null;
  status: string;
  leadStaffName: string | null;
  createdByName: string | null;
  openedAt: string;
  closedAt: string | null;
  leadStatementId: number | null;
}

interface Player {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  total: number;
  counts: Record<string, number>;
  caseImpact: number;
  caseImpactSet: boolean;
  caseImpactUpdatedBy: string;
  caseImpactUpdatedAt: string | null;
}

// Per-(case, student) impact rating labels + colors. This is the
// editorial "how central is this person to the whole case" axis,
// distinct from per-incident severity.
const IMPACT_META: Record<
  number,
  { label: string; bg: string; fg: string; hint: string }
> = {
  1: { label: "Minor", bg: "#E6F4EA", fg: "#1E6E3A", hint: "Background presence" },
  2: { label: "Contributing", bg: "#FEF3C7", fg: "#8A5A00", hint: "Active participant" },
  3: { label: "Significant", bg: "#FFE4D6", fg: "#A1390B", hint: "Repeated central role" },
  4: { label: "Driver", bg: "#9F1D1D", fg: "#FFFFFF", hint: "Drives the case arc" },
};
function impactMeta(n: number) {
  return IMPACT_META[n] ?? IMPACT_META[2];
}

interface IncidentParticipant {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  role: string;
  notes: string | null;
}

interface Incident {
  id: number;
  occurredAt: string;
  occurredDate: string;
  kind: string;
  severity: number;
  location: string | null;
  summary: string;
  detail: string | null;
  participants: IncidentParticipant[];
}

interface NoteRow {
  id: number;
  body: string;
  authorName: string | null;
  createdAt: string;
}

interface StatementRow {
  id: number;
  interactionId: number;
  studentId: string;
  status: string;
  body: string;
  requestedByName: string | null;
  requestedAt: string;
  remindCount: number;
  completedAt: string | null;
}

interface Resp {
  case: CaseRow;
  incidents: Incident[];
  players: Player[];
  notes: NoteRow[];
  statements: StatementRow[];
}

interface StudentHit {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
}

interface Props {
  caseId: number;
  onBack?: () => void;
  // Phase 2+ investigator-only surfaces (video evidence, AI consistency
  // check, Case Insights). Threaded down from the App.tsx call site so
  // the detail view never has to fetch /me itself. The flag is true
  // for the Case Investigator group: admin tier + Behavior Specialist
  // + MTSS Coordinator + Dean. Excludes School Psychologist and
  // School Counselor by design — they sit outside the discipline
  // investigation chain.
  isAdmin?: boolean;
  // Display name of the logged-in admin — used to pre-fill the
  // "Viewed by {name}" reason text on Confirmed video tags.
  viewerName?: string;
}

export default function WatchlistCaseDetail({
  caseId,
  onBack,
  isAdmin = false,
  viewerName = "",
}: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  // Split-button menu next to "+ Log new" — reveals the secondary
  // "Attach existing" action without giving it equal visual weight.
  const [showLogMenu, setShowLogMenu] = useState(false);
  // Inline severity editor: which incident's chip is currently open. The
  // server PATCH route already accepts severity changes and writes an audit
  // row, so this is a thin client affordance.
  const [editingSevId, setEditingSevId] = useState<number | null>(null);
  const [savingSevId, setSavingSevId] = useState<number | null>(null);
  const [editingImpactSid, setEditingImpactSid] = useState<string | null>(null);
  const [savingImpactSid, setSavingImpactSid] = useState<string | null>(null);
  const [detachingId, setDetachingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [stmtDrafts, setStmtDrafts] = useState<Record<string, string>>({});
  const [stmtBusy, setStmtBusy] = useState<string | null>(null);
  // Forward ref so the statement action helpers (defined above the
  // useCallback that owns reload()) can trigger a refresh without hitting
  // the temporal-dead-zone on the const.
  const reloadRef = useRef<(() => Promise<void>) | null>(null);

  const draftKey = (sid: string, iid: number) => `${sid}:${iid}`;

  const setDraft = (sid: string, iid: number, body: string) =>
    setStmtDrafts((p) => ({ ...p, [draftKey(sid, iid)]: body }));

  const saveStatementBody = async (statementId: number, body: string) => {
    setStmtBusy(`save:${statementId}`);
    try {
      const r = await authFetch(`/api/watchlist/statements/${statementId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error(await r.text());
      await reloadRef.current?.();
    } finally {
      setStmtBusy(null);
    }
  };

  const completeStatement = async (statementId: number, body: string) => {
    setStmtBusy(`complete:${statementId}`);
    try {
      const r = await authFetch(
        `/api/watchlist/statements/${statementId}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (!r.ok) throw new Error(await r.text());
      await reloadRef.current?.();
    } finally {
      setStmtBusy(null);
    }
  };

  const remindStatement = async (statementId: number) => {
    setStmtBusy(`remind:${statementId}`);
    try {
      const r = await authFetch(
        `/api/watchlist/statements/${statementId}/remind`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(await r.text());
      await reloadRef.current?.();
    } finally {
      setStmtBusy(null);
    }
  };

  const requestStatement = async (
    interactionId: number,
    studentId: string,
    body: string,
  ) => {
    setStmtBusy(`new:${interactionId}:${studentId}`);
    try {
      const r = await authFetch(
        `/api/watchlist/interactions/${interactionId}/statements`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentId, body }),
        },
      );
      if (!r.ok) throw new Error(await r.text());
      setStmtDrafts((p) => {
        const n = { ...p };
        delete n[draftKey(studentId, interactionId)];
        return n;
      });
      await reloadRef.current?.();
    } finally {
      setStmtBusy(null);
    }
  };

  const reload = useCallback(async () => {
    setError(null);
    const r = await authFetch(`/api/watchlist/cases/${caseId}`);
    if (!r.ok) {
      setError("Failed to load case");
      return;
    }
    const d = (await r.json()) as Resp;
    setData(d);
    setTitleDraft(d.case.title);
  }, [caseId]);

  useEffect(() => {
    reloadRef.current = reload;
    void reload();
  }, [reload]);

  const addNote = async () => {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await authFetch(`/api/watchlist/cases/${caseId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteText }),
      });
      setNoteText("");
      void reload();
    } finally {
      setSavingNote(false);
    }
  };

  const setStatus = async (status: string) => {
    await authFetch(`/api/watchlist/cases/${caseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    void reload();
  };

  const saveTitle = async () => {
    if (!titleDraft.trim() || titleDraft === data?.case.title) {
      setEditingTitle(false);
      return;
    }
    await authFetch(`/api/watchlist/cases/${caseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: titleDraft }),
    });
    setEditingTitle(false);
    void reload();
  };

  if (error) {
    return (
      <div className="min-h-screen p-8" style={{ background: C.bg, color: C.alert }}>
        {error}{" "}
        <button onClick={() => onBack?.()} className="underline">
          Back
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-screen p-8" style={{ background: C.bg, color: C.inkSoft }}>
        Loading…
      </div>
    );
  }
  const c = data.case;
  const sp = statusPillStyle(c.status);
  // Case-level severity is a derived rollup: the max severity across all
  // linked incidents. This is what propagates a per-incident change up to
  // the case header — no separate column to keep in sync, and audit history
  // lives on the incident PATCH that drove the change.
  const caseSeverity = data.incidents.reduce(
    (mx, inc) => Math.max(mx, inc.severity ?? 0),
    0,
  );
  const caseSevStyle = caseSeverity > 0 ? severityChipStyle(caseSeverity) : null;
  const caseSevDriverCount = data.incidents.filter(
    (inc) => inc.severity === caseSeverity,
  ).length;

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.ink }}>
      <div className="mx-auto max-w-[1320px] px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => onBack?.()}
              className="inline-flex items-center gap-1 text-[11px] font-semibold"
              style={{ color: C.brand }}
            >
              <ArrowLeft className="h-3 w-3" /> Back to Investigations
            </button>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div
                className="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
                style={{ borderColor: C.line, background: C.panel, color: C.brand }}
              >
                <Shield className="h-3.5 w-3.5" /> Case {formatCaseNumber(c)}
              </div>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ background: sp.bg, color: sp.fg }}
              >
                {sp.label}
              </span>
              {caseSevStyle && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: caseSevStyle.bg, color: caseSevStyle.fg }}
                  title={`Highest severity across ${data.incidents.length} incident${
                    data.incidents.length === 1 ? "" : "s"
                  } — driven by ${caseSevDriverCount} at this level. Updates automatically when any incident severity changes.`}
                >
                  Case severity: {caseSevStyle.label}
                  {caseSevDriverCount > 1 && (
                    <span className="opacity-70">· {caseSevDriverCount}×</span>
                  )}
                </span>
              )}
            </div>
            {editingTitle ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="w-full rounded-md border px-2 py-1 text-2xl font-bold"
                  style={{ borderColor: C.line, background: C.panel }}
                />
                <button
                  type="button"
                  onClick={saveTitle}
                  className="rounded-md px-3 py-1.5 text-sm font-semibold text-white"
                  style={{ background: C.brand, color: "#FFFFFF" }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingTitle(false);
                    setTitleDraft(c.title);
                  }}
                  className="rounded-md border px-3 py-1.5 text-sm font-semibold"
                  style={{ borderColor: C.line, color: C.ink }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <h1
                className="mt-2 cursor-pointer text-3xl font-bold tracking-tight"
                onClick={() => setEditingTitle(true)}
                title="Click to edit"
              >
                {c.title}
              </h1>
            )}
            <p className="mt-1 text-sm" style={{ color: C.inkSoft }}>
              Opened {new Date(c.openedAt).toLocaleDateString()}
              {c.createdByName ? ` by ${c.createdByName}` : ""}
              {c.leadStaffName ? ` · Lead: ${c.leadStaffName}` : ""}
            </p>

            <HowToUseHelp title="How to use the Case file">
              <HowToSection title="What this is">
                One case — every statement, note, and player tied to
                a single incident or pattern. The case is the durable
                container: incidents come and go, but the case
                remembers who's involved, who said what, and what
                the team has decided. Use it as the running record
                investigators (you) and admins refer back to.
              </HowToSection>
              <HowToSection title="Reading the page">
                <ul style={howtoListStyle}>
                  <li>
                    <strong>Header</strong> — case number, status,
                    and the case severity (auto-computed as the
                    highest severity across all linked statements).
                    Click the title to rename. Use the Status
                    dropdown to move it through Open → Monitoring →
                    Escalated → Closed.
                  </li>
                  <li>
                    <strong>Stats row</strong> — count of statements,
                    players, notes, and the date of the most recent
                    activity.
                  </li>
                  <li>
                    <strong>Players</strong> — students attached to
                    this case with their primary role. Color matches
                    the role (Direct, Target, Witness, Peripheral,
                    etc.).
                  </li>
                  <li>
                    <strong>Statements</strong> — every incident /
                    witness statement linked to the case in
                    chronological order. Severity, location,
                    submitter, and the participants for that
                    specific statement are shown inline.
                  </li>
                  <li>
                    <strong>Notes</strong> — internal timeline for
                    the investigators. Anything added here is
                    visible to the core team only.
                  </li>
                </ul>
              </HowToSection>
              <HowToSection title="Day-to-day actions">
                <ul style={howtoListStyle}>
                  <li>
                    <strong>+ Log new statement</strong> — record a
                    new incident or witness statement and
                    automatically link it to this case. Pick the
                    type, severity, location, and tag everyone
                    involved with their role.
                  </li>
                  <li>
                    <strong>Add player</strong> — attach a student
                    who's part of the case but isn't on a statement
                    yet. Search by name; the picker only shows
                    students at this school.
                  </li>
                  <li>
                    <strong>Add note</strong> — drop a quick update
                    or decision. Use the mic icon to dictate
                    instead of typing — useful right after a
                    conversation in the hallway.
                  </li>
                  <li>
                    <strong>Statement actions</strong> — open a
                    statement to view the full text, request a
                    follow-up from a witness, mark it complete, or
                    detach it from the case if it was linked by
                    mistake.
                  </li>
                </ul>
              </HowToSection>
              <HowToSection title="Status guide">
                <ul style={howtoListStyle}>
                  <li>
                    <strong>Open</strong> — actively being worked.
                    New statements are most likely.
                  </li>
                  <li>
                    <strong>Monitoring</strong> — investigation is
                    paused but the case is still alive (e.g. waiting
                    on a parent meeting or for a behavior plan to
                    take effect).
                  </li>
                  <li>
                    <strong>Escalated</strong> — admin or district
                    is involved. Used to flag for leadership
                    visibility.
                  </li>
                  <li>
                    <strong>Closed</strong> — resolved. Case stays
                    searchable but stops surfacing in alerts and
                    the Hub's open-case list.
                  </li>
                </ul>
              </HowToSection>
              <HowToSection title="Privacy">
                Case files are visible to the core team (admin,
                guidance, behavior specialist, MTSS coordinator).
                Teachers can see statements they personally filed
                from their own profile, but they don't see the case
                walls, notes, or other players' contributions.
              </HowToSection>
            </HowToUseHelp>
          </div>
          {/* Single status control. Four side-by-side buttons made
              status changes look like four primary actions; a labeled
              dropdown takes a fraction of the space and reads correctly
              as a single setting. The primary "+ Log new" lives in the
              Statements panel below — one place, one action. */}
          <div className="flex flex-wrap items-center gap-2">
            <label
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              Status
            </label>
            <select
              value={c.status}
              onChange={(e) =>
                setStatus(e.target.value as "open" | "monitoring" | "escalated" | "closed")
              }
              className="rounded-md border px-2.5 py-1 text-xs font-semibold capitalize"
              style={{ borderColor: C.line, background: C.panel, color: C.ink }}
            >
              {(["open", "monitoring", "escalated", "closed"] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: "Statements", value: data.incidents.length },
            { label: "Players", value: data.players.length },
            { label: "Notes", value: data.notes.length },
            {
              label: "Last activity",
              value: data.incidents[0]
                ? new Date(data.incidents[0].occurredAt).toLocaleDateString()
                : "—",
            },
          ].map((t) => (
            <div
              key={t.label}
              className="rounded-xl border p-4"
              style={{ borderColor: C.line, background: C.panel }}
            >
              <div
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                {t.label}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{t.value}</div>
            </div>
          ))}
        </div>

        {/* Two-column main */}
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          {/* Incidents + notes */}
          <div className="flex flex-col gap-4">
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: C.line, background: C.panel }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-lg font-bold tracking-tight">Statements on this case</h2>
                {/* Split button: primary action is "Log new" (the 95%
                    case); the small caret reveals "Attach existing" for
                    the rare case where a statement was logged without
                    a case and needs to be pulled in. */}
                <div className="relative flex items-center">
                  <button
                    type="button"
                    onClick={() => setShowLog(true)}
                    className="inline-flex items-center gap-1 rounded-l-md px-2 py-1 text-[11px] font-bold text-white"
                    style={{ background: C.brand, color: "#FFFFFF" }}
                  >
                    <Plus className="h-3 w-3" /> Log new
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowLogMenu((v) => !v)}
                    aria-label="More options"
                    className="inline-flex items-center rounded-r-md border-l border-white/20 px-1.5 py-1 text-[11px] font-bold text-white"
                    style={{ background: C.brand }}
                  >
                    ▾
                  </button>
                  {showLogMenu && (
                    <>
                      {/* Invisible backdrop so any outside click closes
                          the menu without needing a global listener. */}
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setShowLogMenu(false)}
                      />
                      <div
                        className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border py-1 shadow-lg"
                        style={{ borderColor: C.line, background: C.panel }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setShowLogMenu(false);
                            setShowAttach(true);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-[11px] font-semibold"
                          style={{ color: C.ink }}
                        >
                          Attach existing statement…
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-3 divide-y" style={{ borderColor: C.line }}>
                {data.incidents.length === 0 ? (
                  <div className="py-6 text-center text-sm" style={{ color: C.inkSoft }}>
                    No statements on this case yet. Log one above.
                  </div>
                ) : (
                  data.incidents.map((i) => {
                    const sev = severityChipStyle(i.severity);
                    const isEditingSev = editingSevId === i.id;
                    const updateSeverity = async (next: number) => {
                      if (next === i.severity) {
                        setEditingSevId(null);
                        return;
                      }
                      setSavingSevId(i.id);
                      try {
                        const r = await authFetch(
                          `/api/watchlist/interactions/${i.id}`,
                          {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ severity: next }),
                          },
                        );
                        if (r.ok) {
                          setEditingSevId(null);
                          await reload();
                        }
                      } finally {
                        setSavingSevId(null);
                      }
                    };
                    return (
                      <div key={i.id} className="py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="text-[11px] font-semibold uppercase tracking-wider"
                            style={{ color: C.inkSoft }}
                          >
                            {new Date(i.occurredAt).toLocaleString()}
                          </span>
                          <span className="text-sm font-semibold">{i.kind}</span>
                          {data.case.leadStatementId === i.id && (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
                              style={{ background: C.brand, color: "#FFFFFF" }}
                              title="This is the originating witness statement that opened the case."
                            >
                              Lead
                            </span>
                          )}
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() =>
                                setEditingSevId(isEditingSev ? null : i.id)
                              }
                              disabled={savingSevId === i.id}
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
                              style={{ background: sev.bg, color: sev.fg }}
                              title="Click to change severity as the investigation progresses"
                            >
                              {savingSevId === i.id ? "Saving…" : sev.label}
                              <span className="opacity-60">▾</span>
                            </button>
                            {isEditingSev && (
                              <div
                                className="absolute left-0 top-full z-20 mt-1 flex flex-col rounded-md border shadow-md"
                                style={{
                                  borderColor: C.line,
                                  background: C.panel,
                                  minWidth: 140,
                                }}
                              >
                                {[1, 2, 3, 4].map((lvl) => {
                                  const opt = severityChipStyle(lvl);
                                  const isCurrent = lvl === i.severity;
                                  return (
                                    <button
                                      key={lvl}
                                      type="button"
                                      onClick={() => void updateSeverity(lvl)}
                                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] font-semibold"
                                      style={{
                                        background: isCurrent ? C.bg : "transparent",
                                        color: C.ink,
                                      }}
                                    >
                                      <span
                                        className="inline-flex items-center rounded-full px-2 py-0.5"
                                        style={{
                                          background: opt.bg,
                                          color: opt.fg,
                                        }}
                                      >
                                        {opt.label}
                                      </span>
                                      {isCurrent && (
                                        <span style={{ color: C.inkSoft }}>
                                          current
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                                <div
                                  className="border-t px-2.5 py-1 text-[10px]"
                                  style={{ borderColor: C.line, color: C.inkSoft }}
                                >
                                  Change is audit-logged.
                                </div>
                              </div>
                            )}
                          </div>
                          {i.location && (
                            <span className="text-[11px]" style={{ color: C.inkSoft }}>
                              · {i.location}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = window.confirm(
                                "Return this incident to the unattached queue?\n\nIt stays in the system — only the link to this case is removed. The detach is audit-logged.",
                              );
                              if (!ok) return;
                              setDetachingId(i.id);
                              try {
                                const r = await authFetch(
                                  `/api/watchlist/interactions/${i.id}`,
                                  {
                                    method: "PATCH",
                                    headers: {
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({ caseId: null }),
                                  },
                                );
                                if (r.ok) await reload();
                              } finally {
                                setDetachingId(null);
                              }
                            }}
                            disabled={detachingId === i.id}
                            className="ml-auto text-[11px] font-semibold underline-offset-2 hover:underline disabled:opacity-50"
                            style={{ color: C.inkSoft }}
                            title="Sends the incident back to the unattached queue. The incident itself is preserved."
                          >
                            {detachingId === i.id ? "Detaching…" : "Detach"}
                          </button>
                        </div>
                        <div className="mt-0.5 text-sm" style={{ color: C.ink }}>
                          {i.summary}
                        </div>
                        {i.detail && (
                          <div className="mt-1 text-xs" style={{ color: C.inkSoft }}>
                            {i.detail}
                          </div>
                        )}
                        {i.participants.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {i.participants.map((p) => {
                              const meta =
                                ROLE_META[(p.role as Role) ?? "peripheral"] ?? ROLE_META.peripheral;
                              return (
                                <span
                                  key={p.id}
                                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                                  style={{
                                    background: meta.soft,
                                    color: meta.color,
                                    border: `1px solid ${meta.color}`,
                                  }}
                                >
                                  {p.firstName} {p.lastName.charAt(0)}.{" "}
                                  <span className="opacity-70">· {meta.label}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Video evidence (admin-only — Phase 2 of case enhancement suite) */}
            {isAdmin && data && (
              <VideoEvidencePanel
                caseId={caseId}
                casePlayers={data.players.map((p) => ({
                  studentId: p.studentId,
                  firstName: p.firstName,
                  lastName: p.lastName,
                }))}
                viewerName={viewerName || "admin"}
                brandColor={C.brand}
                panelBg={C.panel}
                pageBg={C.bg}
                lineColor={C.line}
                inkSoft={C.inkSoft}
              />
            )}

            {/* Notes timeline */}
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: C.line, background: C.panel }}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-bold tracking-tight">Case notes</h2>
                <span className="text-[11px]" style={{ color: C.inkSoft }}>
                  {data.notes.length} entries
                </span>
              </div>
              <div className="mt-3 flex items-start gap-2">
                <div className="flex-1">
                  <VoiceTextarea
                    value={noteText}
                    onChange={setNoteText}
                    rows={2}
                    placeholder="Add a note about a conversation, follow-up, or pattern… (tap mic to dictate)"
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                    style={{ borderColor: C.line, background: C.bg }}
                    brandColor={C.brand}
                  />
                </div>
                <button
                  type="button"
                  onClick={addNote}
                  disabled={savingNote || !noteText.trim()}
                  className="rounded-md px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                  style={{ background: C.brand, color: "#FFFFFF" }}
                >
                  {savingNote ? "…" : "Add"}
                </button>
              </div>
              <div className="mt-3 space-y-2">
                {data.notes.length === 0 ? (
                  <div className="text-sm" style={{ color: C.inkSoft }}>
                    No notes yet.
                  </div>
                ) : (
                  data.notes.map((n) => (
                    <div
                      key={n.id}
                      className="rounded-lg border p-3"
                      style={{ borderColor: C.line, background: C.bg }}
                    >
                      <div className="flex items-center gap-2 text-[11px]" style={{ color: C.inkSoft }}>
                        <StickyNote className="h-3 w-3" />
                        <span className="font-semibold">{n.authorName ?? "Staff"}</span>
                        <span>· {new Date(n.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-sm">{n.body}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Players rail */}
          <div className="flex flex-col gap-4">
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: C.line, background: C.panel }}
            >
              <div className="flex items-baseline justify-between">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4" style={{ color: C.brand }} />
                  <h2 className="text-lg font-bold tracking-tight">Players</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddPlayer(true)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
                  style={{ background: C.bg, color: C.ink }}
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {data.players.length === 0 ? (
                  <div className="text-sm" style={{ color: C.inkSoft }}>
                    No players linked yet.
                  </div>
                ) : (
                  data.players.map((p) => {
                    const dominantRole =
                      Object.entries(p.counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "peripheral";
                    const meta =
                      ROLE_META[(dominantRole as Role) ?? "peripheral"] ?? ROLE_META.peripheral;
                    const isOpen = expandedPlayer === p.studentId;
                    const playerIncidents = data.incidents.filter((inc) =>
                      inc.participants.some((part) => part.studentId === p.studentId),
                    );
                    const playerStatements = (data.statements ?? []).filter(
                      (s) => s.studentId === p.studentId,
                    );
                    return (
                      <div
                        key={p.studentId}
                        className="rounded-md border"
                        style={{ borderColor: C.line, background: C.bg }}
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setExpandedPlayer(isOpen ? null : p.studentId)
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setExpandedPlayer(isOpen ? null : p.studentId);
                            }
                          }}
                          className="flex w-full cursor-pointer items-center gap-3 p-2 text-left"
                          aria-expanded={isOpen}
                        >
                          {isOpen ? (
                            <ChevronDown
                              className="h-4 w-4 shrink-0"
                              style={{ color: C.inkSoft }}
                            />
                          ) : (
                            <ChevronRight
                              className="h-4 w-4 shrink-0"
                              style={{ color: C.inkSoft }}
                            />
                          )}
                          <div
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                            style={{
                              background: meta.soft,
                              color: meta.color,
                              border: `1.5px solid ${meta.color}`,
                            }}
                          >
                            {p.firstName.charAt(0)}
                            {p.lastName.charAt(0)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">
                              {p.firstName} {p.lastName}
                            </div>
                            <div
                              className="text-[11px]"
                              style={{ color: C.inkSoft }}
                            >
                              Gr {p.grade ?? "?"} · {p.total} appearance
                              {p.total === 1 ? "" : "s"} ·{" "}
                              {playerStatements.length} stmt
                            </div>
                          </div>
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                            style={{ background: meta.soft, color: meta.color }}
                          >
                            {meta.label}
                          </span>
                          {(() => {
                            const im = impactMeta(p.caseImpact);
                            const isEditingImpact =
                              editingImpactSid === p.studentId;
                            const setImpact = async (next: number) => {
                              if (next === p.caseImpact && p.caseImpactSet) {
                                setEditingImpactSid(null);
                                return;
                              }
                              setSavingImpactSid(p.studentId);
                              try {
                                const r = await authFetch(
                                  `/api/watchlist/cases/${caseId}/players/${encodeURIComponent(p.studentId)}/impact`,
                                  {
                                    method: "PUT",
                                    headers: {
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({ impact: next }),
                                  },
                                );
                                if (r.ok) {
                                  setEditingImpactSid(null);
                                  await reload();
                                }
                              } finally {
                                setSavingImpactSid(null);
                              }
                            };
                            return (
                              <span
                                className="relative inline-flex"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingImpactSid(
                                      isEditingImpact ? null : p.studentId,
                                    );
                                  }}
                                  disabled={savingImpactSid === p.studentId}
                                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold disabled:opacity-50"
                                  style={{
                                    background: im.bg,
                                    color: im.fg,
                                    opacity: p.caseImpactSet ? 1 : 0.7,
                                  }}
                                  title={`Case impact: ${im.label} — ${im.hint}. Click to change.`}
                                >
                                  {savingImpactSid === p.studentId
                                    ? "Saving…"
                                    : im.label}
                                  <span className="opacity-60">▾</span>
                                </button>
                                {isEditingImpact && (
                                  <div
                                    className="absolute right-0 top-full z-30 mt-1 flex flex-col rounded-md border shadow-md"
                                    style={{
                                      borderColor: C.line,
                                      background: C.panel,
                                      minWidth: 200,
                                    }}
                                  >
                                    <div
                                      className="border-b px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                                      style={{
                                        borderColor: C.line,
                                        color: C.inkSoft,
                                      }}
                                    >
                                      Case impact
                                    </div>
                                    {[1, 2, 3, 4].map((lvl) => {
                                      const opt = impactMeta(lvl);
                                      const isCurrent =
                                        lvl === p.caseImpact && p.caseImpactSet;
                                      return (
                                        <button
                                          key={lvl}
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void setImpact(lvl);
                                          }}
                                          className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-left"
                                          style={{
                                            background: isCurrent
                                              ? C.bg
                                              : "transparent",
                                          }}
                                        >
                                          <span
                                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold"
                                            style={{
                                              background: opt.bg,
                                              color: opt.fg,
                                            }}
                                          >
                                            {opt.label}
                                          </span>
                                          <span
                                            className="text-[10px]"
                                            style={{ color: C.inkSoft }}
                                          >
                                            {isCurrent ? "current" : opt.hint}
                                          </span>
                                        </button>
                                      );
                                    })}
                                    <div
                                      className="border-t px-2.5 py-1 text-[10px]"
                                      style={{
                                        borderColor: C.line,
                                        color: C.inkSoft,
                                      }}
                                    >
                                      {p.caseImpactSet && p.caseImpactUpdatedBy
                                        ? `Last set by ${p.caseImpactUpdatedBy}`
                                        : "Default until set"}{" "}
                                      · audit-logged
                                    </div>
                                  </div>
                                )}
                              </span>
                            );
                          })()}
                        </div>
                        {isOpen && (
                          <div
                            className="border-t px-3 py-3"
                            style={{ borderColor: C.line, background: C.panel }}
                          >
                            <PlayerDrawer
                              studentId={p.studentId}
                              firstName={p.firstName}
                              lastName={p.lastName}
                              incidents={playerIncidents}
                              statements={playerStatements}
                              stmtDrafts={stmtDrafts}
                              setDraft={setDraft}
                              draftKey={draftKey}
                              busy={stmtBusy}
                              onSave={saveStatementBody}
                              onComplete={completeStatement}
                              onRemind={remindStatement}
                              onRequest={requestStatement}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showLog && (
        <LogInteractionModal
          onClose={() => setShowLog(false)}
          onCreated={() => void reload()}
          initialCaseId={caseId}
        />
      )}
      {showAddPlayer && (
        <AddPlayerModal
          caseId={caseId}
          onClose={() => setShowAddPlayer(false)}
          onAdded={() => {
            setShowAddPlayer(false);
            void reload();
          }}
        />
      )}
      {showAttach && (
        <AttachExistingIncidentModal
          caseId={caseId}
          onClose={() => setShowAttach(false)}
          onAttached={() => {
            setShowAttach(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttachExistingIncidentModal
// ---------------------------------------------------------------------------
// Lists recent loose (caseId IS NULL) interactions and lets the user reassign
// one to this case via PATCH /watchlist/interactions/:id { caseId }. Useful
// when a Core Team member realizes a previously-logged loose incident
// actually belongs on a now-open case thread.

function AttachExistingIncidentModal({
  caseId,
  onClose,
  onAttached,
}: {
  caseId: number;
  onClose: () => void;
  onAttached: () => void;
}) {
  type LooseRow = {
    id: number;
    occurredDate: string;
    kind: string;
    severity: number;
    location: string | null;
    summary: string;
    caseId: number | null;
    participantCount?: number;
  };
  const [rows, setRows] = useState<LooseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        // Loose-only + wide window so older un-attached incidents are visible.
        // Server caps `limit` at 100; that's still the practical ceiling for
        // this picker (most schools won't have more loose incidents than that
        // sitting around at once). If a school does, we'll add pagination.
        const r = await authFetch(
          "/api/watchlist/interactions?loose=1&windowDays=3650&limit=100",
        );
        if (!alive || !r.ok) return;
        const d = (await r.json()) as { interactions: LooseRow[] };
        setRows(d.interactions);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = rows.filter((r) => {
    if (!q.trim()) return true;
    const needle = q.trim().toLowerCase();
    return (
      r.summary.toLowerCase().includes(needle) ||
      r.kind.toLowerCase().includes(needle) ||
      (r.location ?? "").toLowerCase().includes(needle)
    );
  });

  const attach = async (id: number) => {
    setBusyId(id);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/interactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
      });
      if (!r.ok) throw new Error(await r.text());
      onAttached();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to attach");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto p-4"
      style={{ background: "rgba(31,27,22,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl border shadow-xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <div>
            <h2 className="text-lg font-bold">Attach existing statement</h2>
            <div className="text-[11px]" style={{ color: C.inkSoft }}>
              Pick an unattached statement to add to this case.
            </div>
          </div>
          <button onClick={onClose} className="text-sm" style={{ color: C.inkSoft }}>
            Close
          </button>
        </div>
        <div className="space-y-3 p-5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by summary, kind, or location…"
            className="w-full rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: C.line, background: C.bg }}
          />
          {loading ? (
            <div className="text-sm" style={{ color: C.inkSoft }}>
              Loading unattached statements…
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-sm" style={{ color: C.inkSoft }}>
              No unattached statements to pull in.
            </div>
          ) : (
            <div
              className="max-h-[55vh] space-y-2 overflow-auto"
              style={{ background: C.bg }}
            >
              {filtered.map((r) => {
                const sev = severityChipStyle(r.severity);
                return (
                  <div
                    key={r.id}
                    className="rounded-md border p-2"
                    style={{ borderColor: C.line, background: C.panel }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                            style={{ background: sev.bg, color: sev.fg }}
                          >
                            sev {r.severity}
                          </span>
                          <span className="text-[11px] font-semibold">
                            {r.kind}
                          </span>
                          <span className="text-[11px]" style={{ color: C.inkSoft }}>
                            {r.occurredDate}
                            {r.location ? ` · ${r.location}` : ""}
                          </span>
                        </div>
                        <div className="mt-1 text-xs">{r.summary}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void attach(r.id)}
                        disabled={busyId === r.id}
                        className="shrink-0 rounded-md px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                        style={{ background: C.brand, color: "#FFFFFF" }}
                      >
                        {busyId === r.id ? "Attaching…" : "Attach"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {error && (
            <div
              className="rounded-md px-3 py-2 text-sm font-semibold"
              style={{ background: C.alert, color: "#FFFFFF" }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: C.line, background: C.bg }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: C.line, color: C.ink }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function AddPlayerModal({
  caseId,
  onClose,
  onAdded,
}: {
  caseId: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [picked, setPicked] = useState<StudentHit | null>(null);
  const [role, setRole] = useState<Role>("peripheral");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (search.trim().length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await authFetch(
        `/api/student-finder/search?q=${encodeURIComponent(search.trim())}`,
      );
      if (!alive || !r.ok) return;
      const d = (await r.json()) as { hits?: StudentHit[]; results?: StudentHit[] };
      setHits(d.hits ?? d.results ?? []);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search]);

  const submit = async () => {
    if (!picked) {
      setError("Pick a student first.");
      return;
    }
    setSaving(true);
    try {
      const r = await authFetch(`/api/watchlist/cases/${caseId}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: picked.studentId,
          role,
          summary: `Added to case as ${ROLE_META[role].label}`,
          notes,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `Failed (${r.status})`);
      }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add player");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto p-4"
      style={{ background: "rgba(31,27,22,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border shadow-xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <h2 className="text-lg font-bold">Add player to case</h2>
          <button onClick={onClose} className="text-sm" style={{ color: C.inkSoft }}>
            Close
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              Student
            </div>
            {picked ? (
              <div
                className="flex items-center justify-between rounded-md border px-2.5 py-1.5"
                style={{ borderColor: C.line, background: C.bg }}
              >
                <div className="text-sm font-semibold">
                  {picked.firstName} {picked.lastName}{" "}
                  <span className="text-[11px] font-normal" style={{ color: C.inkSoft }}>
                    · Gr {picked.grade ?? "?"} · {picked.studentId}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="text-[11px] font-semibold"
                  style={{ color: C.alert }}
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or ID…"
                  className="w-full rounded-md border px-2 py-1.5 text-sm"
                  style={{ borderColor: C.line, background: C.bg }}
                />
                {hits.length > 0 && (
                  <div
                    className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border shadow-md"
                    style={{ borderColor: C.line, background: C.panel }}
                  >
                    {hits.map((h) => (
                      <button
                        key={h.studentId}
                        type="button"
                        onClick={() => {
                          setPicked(h);
                          setSearch("");
                          setHits([]);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[--hov]"
                        style={
                          {
                            ["--hov" as never]: C.bg,
                            color: C.ink,
                          } as React.CSSProperties
                        }
                      >
                        {h.firstName} {h.lastName}{" "}
                        <span className="text-[11px]" style={{ color: C.inkSoft }}>
                          · Gr {h.grade ?? "?"} · {h.studentId}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              Role
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(ROLE_META) as Role[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    background: role === r ? ROLE_META[r].soft : "transparent",
                    border: `1px solid ${role === r ? ROLE_META[r].color : C.line}`,
                    color: role === r ? ROLE_META[r].color : C.inkSoft,
                  }}
                >
                  {ROLE_META[r].label}
                </button>
              ))}
            </div>
          </div>

          <label className="block text-sm">
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              Notes (optional)
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: C.line, background: C.bg }}
            />
          </label>

          {error && (
            <div
              className="rounded-md px-3 py-2 text-sm font-semibold"
              style={{ background: C.alert, color: "#FFFFFF" }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: C.line, background: C.bg }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: C.line, color: C.ink }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !picked}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: C.brand, color: "#FFFFFF" }}
          >
            {saving ? "Saving…" : "Add player"} <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlayerDrawer
// ---------------------------------------------------------------------------
// Renders the expanded panel beneath a player pill: a compact list of the
// case's incidents that involve this student, plus the witness statements
// already requested for them. Each statement body is editable via the
// VoiceTextarea (so a Core Team member can transcribe a verbal account live
// from the student) with Save (draft) / Mark complete / Remind buttons.
// Incidents without a statement for this student show an inline "Capture
// statement" form that creates one on Save.

function PlayerDrawer({
  studentId,
  firstName,
  lastName,
  incidents,
  statements,
  stmtDrafts,
  setDraft,
  draftKey,
  busy,
  onSave,
  onComplete,
  onRemind,
  onRequest,
}: {
  studentId: string;
  firstName: string;
  lastName: string;
  incidents: Incident[];
  statements: StatementRow[];
  stmtDrafts: Record<string, string>;
  setDraft: (sid: string, iid: number, body: string) => void;
  draftKey: (sid: string, iid: number) => string;
  busy: string | null;
  onSave: (statementId: number, body: string) => Promise<void>;
  onComplete: (statementId: number, body: string) => Promise<void>;
  onRemind: (statementId: number) => Promise<void>;
  onRequest: (
    interactionId: number,
    studentId: string,
    body: string,
  ) => Promise<void>;
}) {
  if (incidents.length === 0) {
    return (
      <div className="text-xs" style={{ color: C.inkSoft }}>
        No incidents in this case yet for {firstName} {lastName}.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {incidents.map((inc) => {
        const part = inc.participants.find((p) => p.studentId === studentId);
        const role = (part?.role as Role) ?? "peripheral";
        const meta = ROLE_META[role] ?? ROLE_META.peripheral;
        const stmt = statements.find((s) => s.interactionId === inc.id);
        const dKey = draftKey(studentId, inc.id);
        const draft = stmtDrafts[dKey] ?? stmt?.body ?? "";
        return (
          <div
            key={inc.id}
            className="rounded-md border p-2"
            style={{ borderColor: C.line, background: C.bg }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(() => {
                    const sev = severityChipStyle(inc.severity);
                    return (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                        style={{ background: sev.bg, color: sev.fg }}
                      >
                        sev {inc.severity}
                      </span>
                    );
                  })()}
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                    style={{ background: meta.soft, color: meta.color }}
                  >
                    {meta.label}
                  </span>
                  <span className="text-[11px]" style={{ color: C.inkSoft }}>
                    {inc.occurredDate}
                    {inc.location ? ` · ${inc.location}` : ""}
                  </span>
                </div>
                <div
                  className="mt-1 text-xs"
                  style={{ color: C.ink }}
                >
                  {inc.summary}
                </div>
              </div>
              {stmt &&
                (() => {
                  const sp = statusPillStyle(stmt.status);
                  return (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                      style={{ background: sp.bg, color: sp.fg }}
                    >
                      {sp.label}
                    </span>
                  );
                })()}
            </div>

            <div className="mt-2">
              <div
                className="mb-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                Witness statement{" "}
                <span className="font-normal normal-case opacity-70">
                  (mic to dictate)
                </span>
              </div>
              <MentionTextarea
                value={draft}
                onChange={(v) => setDraft(studentId, inc.id, v)}
                rows={3}
                placeholder={`What did ${firstName} see or do? Type @ or tap "+ Tag student" to name another student.`}
                className="w-full rounded-md border px-2 py-1.5 text-xs"
                style={{ borderColor: C.line, background: C.panel }}
                brandColor={C.brand}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {stmt ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void onSave(stmt.id, draft)}
                      disabled={busy?.startsWith("save:") || draft === stmt.body}
                      className="rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                      style={{ borderColor: C.line, color: C.ink }}
                    >
                      Save draft
                    </button>
                    {stmt.status !== "completed" && (
                      <button
                        type="button"
                        onClick={() => void onComplete(stmt.id, draft)}
                        disabled={
                          !draft.trim() || busy?.startsWith("complete:")
                        }
                        className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                        style={{ background: C.brand, color: "#FFFFFF" }}
                      >
                        Mark complete
                      </button>
                    )}
                    {stmt.status !== "completed" && (
                      <button
                        type="button"
                        onClick={() => void onRemind(stmt.id)}
                        disabled={busy?.startsWith("remind:")}
                        className="rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                        style={{ borderColor: C.line, color: C.inkSoft }}
                      >
                        Remind ({stmt.remindCount})
                      </button>
                    )}
                    <span className="text-[10px]" style={{ color: C.inkSoft }}>
                      Requested by {stmt.requestedByName ?? "—"}
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onRequest(inc.id, studentId, draft)}
                    disabled={busy?.startsWith(`new:${inc.id}:${studentId}`)}
                    className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                    style={{ background: C.brand, color: "#FFFFFF" }}
                  >
                    {draft.trim() ? "Save statement" : "Request statement"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
