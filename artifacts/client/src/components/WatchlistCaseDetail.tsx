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
import LogInteractionModal from "./watchlist/LogInteractionModal";
import VoiceTextarea from "./watchlist/VoiceTextarea";
import {
  ROLE_META,
  WL_COLORS as C,
  severityChipStyle,
  statusPillStyle,
  type Role,
} from "./watchlist/colors";

interface CaseRow {
  id: number;
  caseNumber: number;
  title: string;
  summary: string | null;
  status: string;
  leadStaffName: string | null;
  createdByName: string | null;
  openedAt: string;
  closedAt: string | null;
}

interface Player {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  total: number;
  counts: Record<string, number>;
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
}

export default function WatchlistCaseDetail({ caseId, onBack }: Props) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showAddPlayer, setShowAddPlayer] = useState(false);
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
              <ArrowLeft className="h-3 w-3" /> Back to Watchlist
            </button>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div
                className="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
                style={{ borderColor: C.line, background: C.panel, color: C.brand }}
              >
                <Shield className="h-3.5 w-3.5" /> Case #{c.caseNumber}
              </div>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ background: sp.bg, color: sp.fg }}
              >
                {sp.label}
              </span>
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
                  style={{ background: C.brand }}
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
                style={{ fontFamily: "'Playfair Display', serif" }}
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
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(["open", "monitoring", "escalated", "closed"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className="rounded-md border px-2.5 py-1 text-xs font-semibold capitalize"
                style={{
                  borderColor: c.status === s ? C.ink : C.line,
                  background: c.status === s ? C.ink : "transparent",
                  color: c.status === s ? "#fff" : C.ink,
                }}
              >
                {s}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowLog(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-bold shadow-sm"
              style={{ background: C.brand, color: "#FFFFFF" }}
            >
              <Plus className="h-4 w-4" /> Log incident in case
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: "Incidents", value: data.incidents.length },
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
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-bold tracking-tight">Incidents in this case</h2>
                <button
                  type="button"
                  onClick={() => setShowLog(true)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
                  style={{ background: C.bg, color: C.ink }}
                >
                  <Plus className="h-3 w-3" /> New
                </button>
              </div>
              <div className="mt-3 divide-y" style={{ borderColor: C.line }}>
                {data.incidents.length === 0 ? (
                  <div className="py-6 text-center text-sm" style={{ color: C.inkSoft }}>
                    No incidents linked yet. Log one above.
                  </div>
                ) : (
                  data.incidents.map((i) => {
                    const sev = severityChipStyle(i.severity);
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
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{ background: sev.bg, color: sev.fg }}
                          >
                            {sev.label}
                          </span>
                          {i.location && (
                            <span className="text-[11px]" style={{ color: C.inkSoft }}>
                              · {i.location}
                            </span>
                          )}
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
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedPlayer(isOpen ? null : p.studentId)
                          }
                          className="flex w-full items-center gap-3 p-2 text-left"
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
                        </button>
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
              style={{ background: C.alertSoft, color: C.alert }}
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
            style={{ background: C.brand }}
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
              <VoiceTextarea
                value={draft}
                onChange={(v) => setDraft(studentId, inc.id, v)}
                rows={3}
                placeholder={`What did ${firstName} see or do?`}
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
