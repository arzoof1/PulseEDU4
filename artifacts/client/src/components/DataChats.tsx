// Data Chat Campaigns — client surfaces.
//
// Four exports:
//   - DataChatReminderIcon   animated top-bar pill for teachers with chats
//                            still to log (any active campaign).
//   - DataChatDeadlineBanner persistent banner once a campaign is ≤7 days
//                            from its deadline and the teacher still has
//                            students remaining.
//   - DataChatQueueModal     the teacher worklist: per-campaign student
//                            queue with the log form (checklist + goal
//                            chips + private note; FAST pills for
//                            fast_data campaigns).
//   - DataChatsAdminPage     Core Team admin: templates CRUD, campaign
//                            launch, live compliance, topic coverage,
//                            CSV export (default export).
//
// All reads/writes go through plain authFetch (no orval hooks — matches
// the other staff-app panels). The server is the enforcement point for
// every rule (Core Team gating, queue membership, checklist validity);
// everything here is UX only.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  FastScorePill,
  PillViewContext,
  PillViewToggle,
  nextStopCaption,
  type PillView,
} from "./FastScorePill";
import {
  DEPARTMENT_ORDER,
  deptOf,
  tintFor,
} from "./teacherDepartments";

// ---------------------------------------------------------------------------
// Shared types (mirror routes/dataChats.ts response shapes)
// ---------------------------------------------------------------------------

type ReminderItem = {
  campaignId: number;
  name: string;
  deadline: string; // YYYY-MM-DD
  daysLeft: number;
  remaining: number;
  total: number;
};

type ChecklistItem = { id: string; label: string };

type Placement = {
  level: 1 | 2 | 3 | 4 | 5;
  subLevel: string;
  gap: number | null;
  nextStopLabel: string | null;
} | null;

type FastSet = {
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  levels: {
    priorYearScore: Placement;
    pm1: Placement;
    pm2: Placement;
    pm3: Placement;
  };
};

type QueueStudent = {
  studentId: string;
  name: string;
  lastFirst: string;
  localSisId: string | null;
  grade: number | null;
  subject: "ela" | "math" | null;
  fast: Partial<Record<"ela" | "math", FastSet>> | null;
  pastGoals: Array<{ campaignName: string; goal: string; date: string }>;
  logged: {
    discussed: string[];
    goal: string;
    privateNote: string;
    at: string;
  } | null;
};

type QueueEntry = {
  campaign: {
    id: number;
    name: string;
    kind: string;
    subject: string | null;
    deadline: string;
    daysLeft: number;
    shareWithFamilies: boolean;
    checklist: ChecklistItem[];
    goalChips: string[];
  };
  students: QueueStudent[];
};

type TemplateRow = {
  id: number;
  name: string;
  kind: string;
  builtIn: boolean;
  checklist: ChecklistItem[];
  goalChips: string[];
  shareWithFamilies: boolean;
};

type ScopeInfo = {
  type: "all" | "flags" | "df" | "handpicked";
  flags?: string[];
  studentCount?: number;
};

const SCOPE_FLAG_LABELS: Record<string, string> = {
  ese: "ESE",
  is504: "504",
  ell: "ELL",
};

function scopeLabel(scope: ScopeInfo | null | undefined): string | null {
  if (!scope || scope.type === "all") return null;
  if (scope.type === "flags") {
    const f = (scope.flags ?? []).map((x) => SCOPE_FLAG_LABELS[x] ?? x);
    return `Scope: ${f.join(" / ") || "support flags"}`;
  }
  if (scope.type === "df") return "Scope: D or F in class";
  return `Scope: hand-picked${
    scope.studentCount != null ? ` (${scope.studentCount})` : ""
  }`;
}

type CampaignRow = {
  id: number;
  name: string;
  kind: string;
  subject: string | null;
  assignmentMode: string;
  responsiblePeriod: number;
  shareWithFamilies: boolean;
  startDate: string;
  deadline: string;
  active: boolean;
  total: number;
  done: number;
  teacherCount: number;
  createdByName: string | null;
  scope?: ScopeInfo | null;
};

type CampaignDetail = {
  id: number;
  name: string;
  kind: string;
  subject: string | null;
  shareWithFamilies: boolean;
  startDate: string;
  deadline: string;
  active: boolean;
  checklist: ChecklistItem[];
  total: number;
  done: number;
  teachers: Array<{
    staffId: number;
    name: string;
    subjects: string[];
    total: number;
    done: number;
  }>;
  topicCoverage: Array<{
    id: string;
    label: string;
    count: number;
    loggedTotal: number;
  }>;
  scope?: ScopeInfo | null;
};

type DirectoryStaff = {
  id: number;
  displayName: string;
  email: string | null;
  department?: string | null;
};

// ---------------------------------------------------------------------------
// Reminder polling hook (icon + banner share the shape; each self-polls the
// same light endpoint, matching the other top-bar bells)
// ---------------------------------------------------------------------------

function useDataChatReminders(enabled: boolean): ReminderItem[] {
  const [items, setItems] = useState<ReminderItem[]>([]);
  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const r = await authFetch("/api/data-chats/reminder", {
          cache: "no-store",
        });
        if (!r.ok) return;
        const d = (await r.json()) as ReminderItem[];
        if (!cancelled && Array.isArray(d)) setItems(d);
      } catch {
        /* swallow — next poll retries */
      }
    }
    void poll();
    const t = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled]);
  return items;
}

// ---------------------------------------------------------------------------
// Top-bar reminder icon
// ---------------------------------------------------------------------------

const STYLE_ID = "data-chat-animations";
function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes dataChatWobble {
      0%, 100% { transform: rotate(0deg); }
      20%      { transform: rotate(-12deg); }
      60%      { transform: rotate(12deg); }
    }
    @keyframes dataChatGlow {
      0%, 100% {
        box-shadow:
          0 0 0 0 rgba(139, 92, 246, 0.5),
          0 0 12px 2px rgba(139, 92, 246, 0.3);
      }
      50% {
        box-shadow:
          0 0 0 6px rgba(139, 92, 246, 0),
          0 0 20px 5px rgba(139, 92, 246, 0.6);
      }
    }
    .data-chat-bell { animation: dataChatGlow 2.4s ease-in-out infinite; }
    .data-chat-bell .data-chat-bell-icon {
      display: inline-block;
      transform-origin: 50% 50%;
      animation: dataChatWobble 2.6s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .data-chat-bell,
      .data-chat-bell .data-chat-bell-icon { animation: none !important; }
    }
  `;
  document.head.appendChild(style);
}

export function DataChatReminderIcon({
  visible,
  onOpen,
}: {
  visible: boolean;
  onOpen: () => void;
}) {
  const items = useDataChatReminders(visible);
  useEffect(() => {
    ensureStyles();
  }, []);
  const remaining = items.reduce((n, i) => n + i.remaining, 0);
  if (!visible || remaining <= 0) return null;
  const title = `${remaining} data chat${remaining === 1 ? "" : "s"} still to log`;
  return (
    <button
      type="button"
      className="data-chat-bell"
      onClick={onOpen}
      title={title}
      aria-label={title}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(139, 92, 246, 0.12)",
        border: "1px solid rgba(139, 92, 246, 0.55)",
        cursor: "pointer",
        padding: "0.3rem 0.65rem",
        fontSize: "1rem",
        borderRadius: 999,
        marginRight: "0.25rem",
        lineHeight: 1,
        color: "#8b5cf6",
      }}
    >
      <span className="data-chat-bell-icon" aria-hidden>
        💬
      </span>
      <span style={{ fontSize: "0.78rem", fontWeight: 700 }}>
        Data chats
      </span>
      <span
        style={{
          minWidth: 18,
          height: 18,
          borderRadius: 999,
          background: "#8b5cf6",
          color: "#fff",
          fontSize: "0.7rem",
          fontWeight: 800,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 5px",
        }}
      >
        {remaining}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Deadline banner (persistent at ≤7 days)
// ---------------------------------------------------------------------------

export function DataChatDeadlineBanner({
  visible,
  onOpen,
}: {
  visible: boolean;
  onOpen: () => void;
}) {
  const items = useDataChatReminders(visible);
  const urgent = items.filter((i) => i.daysLeft <= 7);
  if (!visible || urgent.length === 0) return null;
  const worst = urgent.reduce((a, b) => (a.daysLeft <= b.daysLeft ? a : b));
  const remaining = urgent.reduce((n, i) => n + i.remaining, 0);
  const dayText =
    worst.daysLeft <= 0
      ? "due today"
      : worst.daysLeft === 1
        ? "due tomorrow"
        : `${worst.daysLeft} days left`;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        margin: "0 0 1rem 0",
        padding: "0.65rem 1rem",
        borderRadius: 12,
        border: "1px solid rgba(139, 92, 246, 0.5)",
        background:
          "linear-gradient(90deg, rgba(139,92,246,0.14), rgba(99,102,241,0.10))",
      }}
    >
      <span aria-hidden style={{ fontSize: "1.2rem" }}>
        💬
      </span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontWeight: 700, fontSize: "0.92rem" }}>
          Data chats {dayText} — {remaining} student
          {remaining === 1 ? "" : "s"} still to see
        </div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-subtle, #94a3b8)" }}>
          {urgent.map((u) => `${u.name} (${u.remaining} left)`).join(" · ")}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        style={{
          border: "none",
          borderRadius: 999,
          padding: "0.45rem 1rem",
          fontWeight: 700,
          fontSize: "0.85rem",
          cursor: "pointer",
          background: "#8b5cf6",
          color: "#fff",
        }}
      >
        Open my queue
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 12,
  background: "var(--surface, #fff)",
  padding: "1rem",
};

function ErrText({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      style={{
        color: "#b91c1c",
        background: "rgba(239,68,68,0.08)",
        border: "1px solid rgba(239,68,68,0.35)",
        borderRadius: 8,
        padding: "0.4rem 0.7rem",
        fontSize: "0.82rem",
        margin: "0.5rem 0",
      }}
    >
      {text}
    </div>
  );
}

function fmtDeadline(iso: string, daysLeft?: number): string {
  const d = new Date(`${iso}T12:00:00`);
  const s = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (daysLeft == null) return s;
  if (daysLeft < 0) return `${s} · past due`;
  if (daysLeft === 0) return `${s} · today`;
  return `${s} · ${daysLeft}d left`;
}

// ---------------------------------------------------------------------------
// FAST mini-panel inside the log form (fast_data campaigns only)
// ---------------------------------------------------------------------------

function FastMini({ student }: { student: QueueStudent }) {
  const [view, setView] = useState<PillView>("level");
  const subjects = useMemo(() => {
    const out: Array<["ela" | "math", FastSet]> = [];
    if (student.fast) {
      for (const s of ["ela", "math"] as const) {
        const f = student.fast[s];
        if (f) out.push([s, f]);
      }
    }
    return out;
  }, [student.fast]);
  if (subjects.length === 0) {
    return (
      <div style={{ fontSize: "0.8rem", color: "var(--text-subtle, #94a3b8)" }}>
        No FAST scores on file for this student.
      </div>
    );
  }
  return (
    <PillViewContext.Provider value={view}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <PillViewToggle value={view} onChange={setView} />
      </div>
      {subjects.map(([subj, f]) => {
        const latest =
          f.pm3 != null
            ? { placement: f.levels.pm3, score: f.pm3 }
            : f.pm2 != null
              ? { placement: f.levels.pm2, score: f.pm2 }
              : { placement: f.levels.pm1, score: f.pm1 };
        const caption = nextStopCaption(
          latest.placement?.gap,
          latest.placement?.nextStopLabel,
        );
        return (
          <div key={subj} style={{ marginTop: 8 }}>
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--text-subtle, #94a3b8)",
                marginBottom: 4,
              }}
            >
              FAST {subj === "ela" ? "ELA" : "Math"}
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              {(
                [
                  ["PM1", f.pm1, f.levels.pm1],
                  ["PM2", f.pm2, f.levels.pm2],
                  ["PM3", f.pm3, f.levels.pm3],
                ] as const
              ).map(([label, score, p]) => (
                <div key={label} style={{ textAlign: "center" }}>
                  <div
                    style={{
                      fontSize: "0.68rem",
                      color: "var(--text-subtle, #94a3b8)",
                      marginBottom: 2,
                    }}
                  >
                    {label}
                  </div>
                  <FastScorePill
                    score={score}
                    level={p?.level ?? null}
                    subLevel={p?.subLevel ?? null}
                    pmLabel={`${subj.toUpperCase()} ${label}`}
                  />
                </div>
              ))}
              {caption && (
                <div
                  style={{
                    alignSelf: "center",
                    fontSize: "0.78rem",
                    fontWeight: 700,
                    color: caption.color,
                  }}
                >
                  {caption.text}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </PillViewContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Log form (per student)
// ---------------------------------------------------------------------------

function LogForm({
  entry,
  student,
  onSaved,
  onCancel,
  selfServe = false,
}: {
  entry: QueueEntry;
  student: QueueStudent;
  onSaved: () => void;
  onCancel: () => void;
  // Teacher-initiated chat (no pending campaign): POST /self-log — appends a
  // NEW history row each time instead of upserting the campaign pair.
  selfServe?: boolean;
}) {
  const c = entry.campaign;
  const [discussed, setDiscussed] = useState<Set<string>>(
    () => new Set(student.logged?.discussed ?? []),
  );
  const [goal, setGoal] = useState(student.logged?.goal ?? "");
  const [privateNote, setPrivateNote] = useState(
    student.logged?.privateNote ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) => {
    setDiscussed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (discussed.size === 0) {
      setErr("Check at least one topic you discussed.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await authFetch(
        selfServe ? "/api/data-chats/self-log" : "/api/data-chats/logs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            selfServe
              ? {
                  studentId: student.studentId,
                  discussed: [...discussed],
                  goal,
                  privateNote,
                }
              : {
                  campaignId: c.id,
                  studentId: student.studentId,
                  discussed: [...discussed],
                  goal,
                  privateNote,
                },
          ),
        },
      );
      const d = (await r.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!r.ok || !d?.ok) {
        setErr(d?.error ?? "Couldn't save — try again.");
        return;
      }
      onSaved();
    } catch {
      setErr("Couldn't save — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...cardStyle, borderColor: "rgba(139,92,246,0.45)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 800, fontSize: "1rem" }}>
          {student.name}
          {student.grade != null && (
            <span
              style={{
                marginLeft: 8,
                fontSize: "0.75rem",
                fontWeight: 600,
                color: "var(--text-subtle, #94a3b8)",
              }}
            >
              Gr {student.grade}
            </span>
          )}
        </div>
        {student.logged && (
          <span style={{ fontSize: "0.75rem", color: "#16a34a", fontWeight: 700 }}>
            Logged {student.logged.at} — editing updates it
          </span>
        )}
      </div>

      {c.kind === "fast_data" && (
        <div style={{ margin: "0.6rem 0" }}>
          <FastMini student={student} />
        </div>
      )}

      {student.pastGoals.length > 0 && (
        <div
          style={{
            margin: "0.6rem 0",
            padding: "0.5rem 0.7rem",
            borderRadius: 8,
            background: "rgba(245, 158, 11, 0.08)",
            border: "1px solid rgba(245, 158, 11, 0.3)",
          }}
        >
          <div
            style={{
              fontSize: "0.72rem",
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "#b45309",
              marginBottom: 4,
            }}
          >
            Goals from earlier chats
          </div>
          {student.pastGoals.map((g, i) => (
            <div key={i} style={{ fontSize: "0.82rem", marginTop: 2 }}>
              <span style={{ fontWeight: 700 }}>{g.goal}</span>{" "}
              <span style={{ color: "var(--text-subtle, #94a3b8)" }}>
                — {g.campaignName}, {g.date}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: "0.6rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 6 }}>
          What did you talk about?
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {c.checklist.map((item) => (
            <label
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: "0.88rem",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={discussed.has(item.id)}
                onChange={() => toggle(item.id)}
              />
              {item.label}
            </label>
          ))}
        </div>
      </div>

      <div style={{ marginTop: "0.8rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 6 }}>
          Goal the student set{" "}
          {c.shareWithFamilies && (
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 600,
                color: "var(--text-subtle, #94a3b8)",
              }}
            >
              (shared with families on the HeartBEAT)
            </span>
          )}
        </div>
        {c.goalChips.length > 0 && (
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}
          >
            {c.goalChips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() =>
                  setGoal((g) => (g.trim() ? `${g.trim()} ${chip}` : chip))
                }
                style={{
                  border: "1px solid rgba(139,92,246,0.4)",
                  background: "rgba(139,92,246,0.08)",
                  color: "#7c3aed",
                  borderRadius: 999,
                  padding: "0.2rem 0.65rem",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {chip}
              </button>
            ))}
          </div>
        )}
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="e.g. Move up one sub-level by PM3 by practicing 20 minutes a week"
          style={{
            width: "100%",
            boxSizing: "border-box",
            borderRadius: 8,
            border: "1px solid var(--border, #cbd5e1)",
            padding: "0.5rem 0.7rem",
            fontSize: "0.88rem",
            resize: "vertical",
          }}
        />
      </div>

      <div style={{ marginTop: "0.8rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 6 }}>
          Private note{" "}
          <span
            style={{
              fontSize: "0.72rem",
              fontWeight: 600,
              color: "var(--text-subtle, #94a3b8)",
            }}
          >
            (staff only — never shared with families)
          </span>
        </div>
        <textarea
          value={privateNote}
          onChange={(e) => setPrivateNote(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Anything you want to remember about this conversation"
          style={{
            width: "100%",
            boxSizing: "border-box",
            borderRadius: 8,
            border: "1px solid var(--border, #cbd5e1)",
            padding: "0.5rem 0.7rem",
            fontSize: "0.88rem",
            resize: "vertical",
          }}
        />
      </div>

      <ErrText text={err} />

      <div style={{ display: "flex", gap: 8, marginTop: "0.8rem" }}>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            border: "none",
            borderRadius: 8,
            padding: "0.5rem 1.1rem",
            fontWeight: 700,
            fontSize: "0.88rem",
            cursor: saving ? "default" : "pointer",
            background: "#8b5cf6",
            color: "#fff",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : student.logged ? "Update chat" : "Log this chat"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: 8,
            padding: "0.5rem 1.1rem",
            fontWeight: 600,
            fontSize: "0.88rem",
            cursor: "pointer",
            background: "transparent",
            color: "var(--text, inherit)",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Teacher queue modal
// ---------------------------------------------------------------------------

export function DataChatQueueModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<QueueEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openStudent, setOpenStudent] = useState<{
    campaignId: number;
    studentId: string;
  } | null>(null);

  const load = async () => {
    try {
      const r = await authFetch("/api/data-chats/my-queue", {
        cache: "no-store",
      });
      if (!r.ok) {
        setErr("Couldn't load your data-chat queue.");
        return;
      }
      setEntries((await r.json()) as QueueEntry[]);
    } catch {
      setErr("Couldn't load your data-chat queue.");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="My data chats"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "3vh 12px",
        overflowY: "auto",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(760px, 100%)",
          background: "var(--surface, #fff)",
          color: "var(--text, #0f172a)",
          borderRadius: 14,
          padding: "1.1rem 1.2rem",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.6rem",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.15rem" }}>💬 My data chats</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              fontSize: "1.3rem",
              cursor: "pointer",
              color: "var(--text-subtle, #94a3b8)",
            }}
          >
            ✕
          </button>
        </div>

        <ErrText text={err} />
        {entries === null && !err && (
          <div style={{ color: "var(--text-subtle, #94a3b8)" }}>Loading…</div>
        )}
        {entries !== null && entries.length === 0 && (
          <div style={{ color: "var(--text-subtle, #94a3b8)" }}>
            No active data-chat campaigns include your students. 🎉
          </div>
        )}

        {(entries ?? []).map((entry) => {
          const c = entry.campaign;
          const done = entry.students.filter((s) => s.logged).length;
          return (
            <div key={c.id} style={{ ...cardStyle, marginBottom: "0.9rem" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "baseline",
                }}
              >
                <div style={{ fontWeight: 800 }}>{c.name}</div>
                <div
                  style={{
                    fontSize: "0.78rem",
                    fontWeight: 700,
                    color: c.daysLeft <= 3 ? "#dc2626" : "var(--text-subtle, #94a3b8)",
                  }}
                >
                  Due {fmtDeadline(c.deadline, c.daysLeft)} · {done}/
                  {entry.students.length} logged
                </div>
              </div>
              {c.shareWithFamilies && (
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-subtle, #94a3b8)",
                    marginTop: 2,
                  }}
                >
                  Topics + goals from this campaign are shared with families on
                  the HeartBEAT. Private notes never are.
                </div>
              )}
              <div style={{ marginTop: "0.6rem" }}>
                {entry.students.map((s) => {
                  const isOpen =
                    openStudent?.campaignId === c.id &&
                    openStudent?.studentId === s.studentId;
                  return (
                    <div key={s.studentId} style={{ marginBottom: 6 }}>
                      {isOpen ? (
                        <LogForm
                          entry={entry}
                          student={s}
                          onCancel={() => setOpenStudent(null)}
                          onSaved={() => {
                            setOpenStudent(null);
                            void load();
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setOpenStudent({
                              campaignId: c.id,
                              studentId: s.studentId,
                            })
                          }
                          style={{
                            width: "100%",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: 8,
                            padding: "0.45rem 0.75rem",
                            background: s.logged
                              ? "rgba(22, 163, 74, 0.07)"
                              : "transparent",
                            cursor: "pointer",
                            fontSize: "0.88rem",
                            color: "var(--text, inherit)",
                            textAlign: "left",
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>
                            {s.lastFirst}
                            {s.subject && (
                              <span
                                style={{
                                  marginLeft: 8,
                                  fontSize: "0.72rem",
                                  fontWeight: 700,
                                  color: "#7c3aed",
                                  textTransform: "uppercase",
                                }}
                              >
                                {s.subject}
                              </span>
                            )}
                          </span>
                          <span
                            style={{
                              fontSize: "0.78rem",
                              fontWeight: 700,
                              color: s.logged
                                ? "#16a34a"
                                : "var(--text-subtle, #94a3b8)",
                            }}
                          >
                            {s.logged ? `✓ ${s.logged.at}` : "Log chat →"}
                          </span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-serve chat modal (Teacher Roster inline icon). Fetches the per-student
// context — if the student is pending in one of this teacher's active
// campaigns, the log counts toward it (mode 'campaign'); otherwise the chat
// records against the school's self-serve bucket (mode 'self').
// ---------------------------------------------------------------------------

type SelfContext = {
  mode: "campaign" | "self";
  campaign: {
    id: number;
    name: string;
    deadline: string | null;
    daysLeft: number | null;
    shareWithFamilies: boolean;
    checklist: ChecklistItem[];
    goalChips: string[];
  };
  subject: "ela" | "math" | null;
  student: {
    studentId: string;
    name: string;
    grade: number | null;
    localSisId: string | null;
  };
  fast: Partial<Record<"ela" | "math", FastSet>> | null;
  pastGoals: Array<{ campaignName: string; goal: string; date: string }>;
  priorNotes: Array<{ note: string; date: string }>;
  followup: { id: number; dueDate: string; snoozeCount: number } | null;
};

// Teacher-private follow-up scheduler inside the chat modal. One pending
// follow-up per student — scheduling again replaces the date. Never
// family-facing: nothing here touches HeartBEAT or the student record.
function FollowupScheduler({
  studentId,
  initial,
}: {
  studentId: string;
  initial: { id: number; dueDate: string; snoozeCount: number } | null;
}) {
  const [current, setCurrent] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!date) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await authFetch("/api/data-chats/followups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, dueDate: date }),
      });
      const d = (await r.json().catch(() => null)) as
        | { ok?: boolean; id?: number; dueDate?: string; error?: string }
        | null;
      if (!r.ok || !d?.ok || !d.id || !d.dueDate) {
        setErr(d?.error ?? "Couldn't schedule the follow-up.");
        return;
      }
      setCurrent({ id: d.id, dueDate: d.dueDate, snoozeCount: 0 });
      setEditing(false);
      setDate("");
    } catch {
      setErr("Couldn't schedule the follow-up.");
    } finally {
      setSaving(false);
    }
  };

  const cancelFollowup = async () => {
    if (!current) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/data-chats/followups/${current.id}/cancel`,
        { method: "POST" },
      );
      if (!r.ok) {
        setErr("Couldn't cancel the follow-up.");
        return;
      }
      setCurrent(null);
    } catch {
      setErr("Couldn't cancel the follow-up.");
    } finally {
      setSaving(false);
    }
  };

  const fmtDate = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  };

  const btn: React.CSSProperties = {
    border: "1px solid var(--border, #cbd5e1)",
    borderRadius: 8,
    padding: "0.3rem 0.75rem",
    fontWeight: 700,
    fontSize: "0.78rem",
    cursor: "pointer",
    background: "transparent",
    color: "var(--text, inherit)",
  };

  const minDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString("en-CA");
  })();

  return (
    <div
      style={{
        marginTop: "0.8rem",
        padding: "0.7rem 0.85rem",
        borderRadius: 10,
        border: "1px dashed var(--border, #cbd5e1)",
        background: "var(--surface-2, rgba(148,163,184,0.08))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 800, fontSize: "0.85rem" }}>
          🔔 Follow-up
          {current && !editing && (
            <span style={{ fontWeight: 600, marginLeft: 8 }}>
              scheduled for {fmtDate(current.dueDate)}
              {current.snoozeCount > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: "0.72rem",
                    color: "#b45309",
                    fontWeight: 700,
                  }}
                >
                  (snoozed {current.snoozeCount}×)
                </span>
              )}
            </span>
          )}
          {!current && !editing && (
            <span
              style={{
                fontWeight: 500,
                marginLeft: 8,
                color: "var(--text-subtle, #94a3b8)",
                fontSize: "0.8rem",
              }}
            >
              private reminder to check back in — never visible to families
            </span>
          )}
        </div>
        {!editing ? (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              style={btn}
              disabled={saving}
              onClick={() => {
                setDate(current?.dueDate ?? "");
                setEditing(true);
              }}
            >
              {current ? "Reschedule" : "+ Schedule"}
            </button>
            {current && (
              <button
                type="button"
                style={{ ...btn, color: "#dc2626", borderColor: "#fca5a5" }}
                disabled={saving}
                onClick={() => void cancelFollowup()}
              >
                Cancel it
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="date"
              value={date}
              min={minDate}
              onChange={(e) => setDate(e.target.value)}
              style={{
                border: "1px solid var(--border, #cbd5e1)",
                borderRadius: 8,
                padding: "0.25rem 0.5rem",
                fontSize: "0.8rem",
                background: "var(--surface, #fff)",
                color: "var(--text, #0f172a)",
              }}
            />
            <button
              type="button"
              style={{
                ...btn,
                background: "#8b5cf6",
                color: "#fff",
                border: "none",
                opacity: !date || saving ? 0.6 : 1,
              }}
              disabled={!date || saving}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              style={btn}
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setErr(null);
              }}
            >
              Back
            </button>
          </div>
        )}
      </div>
      {editing && (
        <div
          style={{
            marginTop: 4,
            fontSize: "0.72rem",
            color: "var(--text-subtle, #94a3b8)",
          }}
        >
          Weekend dates roll to the next school day. Logging a chat with this
          student marks the follow-up done automatically.
        </div>
      )}
      {err && (
        <div style={{ marginTop: 4, color: "#dc2626", fontSize: "0.78rem" }}>
          {err}
        </div>
      )}
    </div>
  );
}

export function SelfDataChatModal({
  studentId,
  onClose,
  onLogged,
}: {
  studentId: string;
  onClose: () => void;
  onLogged?: () => void;
}) {
  const [ctx, setCtx] = useState<SelfContext | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    ensureStyles();
    let cancelled = false;
    authFetch(`/api/data-chats/self-context/${encodeURIComponent(studentId)}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as
          | (SelfContext & { error?: string })
          | null;
        if (cancelled) return;
        if (!r.ok || !d || d.error) {
          setErr(d?.error ?? "Couldn't load the chat form.");
          return;
        }
        setCtx(d);
      })
      .catch(() => {
        if (!cancelled) setErr("Couldn't load the chat form.");
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const entry: QueueEntry | null = ctx
    ? {
        campaign: {
          id: ctx.campaign.id,
          name: ctx.campaign.name,
          // Render the FAST mini-context whenever scores exist — the
          // built-in template is FAST-oriented either way.
          kind: ctx.fast && Object.keys(ctx.fast).length > 0 ? "fast_data" : "self_serve",
          subject: ctx.subject,
          deadline: ctx.campaign.deadline ?? "",
          daysLeft: ctx.campaign.daysLeft ?? 9999,
          shareWithFamilies: ctx.campaign.shareWithFamilies,
          checklist: ctx.campaign.checklist,
          goalChips: ctx.campaign.goalChips,
        },
        students: [],
      }
    : null;
  const student: QueueStudent | null = ctx
    ? {
        studentId: ctx.student.studentId,
        name: ctx.student.name,
        lastFirst: ctx.student.name,
        localSisId: ctx.student.localSisId,
        grade: ctx.student.grade,
        subject: ctx.subject,
        fast: ctx.fast,
        pastGoals: ctx.pastGoals,
        logged: null,
      }
    : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Data chat"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "3vh 12px",
        overflowY: "auto",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(680px, 100%)",
          background: "var(--surface, #fff)",
          color: "var(--text, #0f172a)",
          borderRadius: 14,
          padding: "1.1rem 1.2rem",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: "0.6rem",
          }}
        >
          <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>
            💬 Data chat
            {ctx && (
              <span
                style={{
                  marginLeft: 10,
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  color: ctx.mode === "campaign" ? "#7c3aed" : "#0891b2",
                  textTransform: "uppercase",
                }}
              >
                {ctx.mode === "campaign"
                  ? `Counts toward: ${ctx.campaign.name}`
                  : "Teacher check-in"}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: "1.2rem",
              color: "var(--text-subtle, #94a3b8)",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        {err && <ErrText text={err} />}
        {!err && (!ctx || !entry || !student) && (
          <div
            style={{ color: "var(--text-subtle, #94a3b8)", padding: "0.5rem 0" }}
          >
            Loading…
          </div>
        )}
        {ctx && ctx.priorNotes.length > 0 && (
          <div
            style={{
              marginBottom: "0.7rem",
              padding: "0.6rem 0.8rem",
              borderRadius: 10,
              background: "rgba(8, 145, 178, 0.08)",
              border: "1px solid rgba(8, 145, 178, 0.25)",
            }}
          >
            <div
              style={{
                fontWeight: 800,
                fontSize: "0.78rem",
                color: "#0e7490",
                marginBottom: 4,
              }}
            >
              🔒 Your private notes from last time (only you can see these)
            </div>
            {ctx.priorNotes.map((n, i) => (
              <div
                key={i}
                style={{
                  fontSize: "0.82rem",
                  marginTop: i === 0 ? 0 : 4,
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                }}
              >
                <span
                  style={{
                    color: "var(--text-subtle, #94a3b8)",
                    fontSize: "0.72rem",
                    whiteSpace: "nowrap",
                  }}
                >
                  {n.date}
                </span>
                <span style={{ whiteSpace: "pre-wrap" }}>{n.note}</span>
              </div>
            ))}
          </div>
        )}
        {ctx && entry && student && (
          <>
            <LogForm
              entry={entry}
              student={student}
              selfServe={ctx.mode === "self"}
              onSaved={() => {
                onLogged?.();
                onClose();
              }}
              onCancel={onClose}
            />
            <FollowupScheduler
              studentId={ctx.student.studentId}
              initial={ctx.followup}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Follow-up reminders (Teacher Roster banner)
// ---------------------------------------------------------------------------

type FollowupItem = {
  id: number;
  studentId: string;
  studentName: string;
  dueDate: string;
  snoozeCount: number;
  phase: "due" | "tomorrow" | "upcoming";
  loud: boolean;
  periodNumber: number | null;
};

// Persistent (not popup) reminder strip for the Teacher Roster:
//  - quiet line the school day BEFORE a follow-up is due
//  - loud pulsing banner on the due day, starting when the period the
//    teacher has that student begins (server decides `loud`)
// Polls so the banner appears mid-session without a refresh.
export function FollowupReminders({
  onOpenChat,
}: {
  onOpenChat: (studentId: string) => void;
}) {
  const [items, setItems] = useState<FollowupItem[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async () => {
    try {
      const r = await authFetch("/api/data-chats/followups/mine", {
        cache: "no-store",
      });
      if (!r.ok) return;
      const d = (await r.json().catch(() => null)) as
        | { followups?: FollowupItem[] }
        | null;
      if (d?.followups) setItems(d.followups);
    } catch {
      // silent — reminder strip is best-effort
    }
  };

  useEffect(() => {
    ensureStyles();
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (id: number, action: "snooze1" | "snooze3" | "cancel") => {
    setBusyId(id);
    try {
      const url =
        action === "cancel"
          ? `/api/data-chats/followups/${id}/cancel`
          : `/api/data-chats/followups/${id}/snooze`;
      const r = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          action === "cancel"
            ? undefined
            : JSON.stringify({ days: action === "snooze1" ? 1 : 3 }),
      });
      if (r.ok) await load();
    } catch {
      // best-effort
    } finally {
      setBusyId(null);
    }
  };

  const loud = items.filter((i) => i.phase === "due" && i.loud);
  const quietDue = items.filter((i) => i.phase === "due" && !i.loud);
  const tomorrow = items.filter((i) => i.phase === "tomorrow");
  if (loud.length === 0 && quietDue.length === 0 && tomorrow.length === 0) {
    return null;
  }

  const smallBtn: React.CSSProperties = {
    border: "1px solid rgba(255,255,255,0.5)",
    borderRadius: 7,
    padding: "0.2rem 0.55rem",
    fontWeight: 700,
    fontSize: "0.72rem",
    cursor: "pointer",
    background: "rgba(255,255,255,0.15)",
    color: "#fff",
  };

  return (
    <div style={{ display: "grid", gap: 6, margin: "0.5rem 0 0.8rem" }}>
      {loud.map((f) => (
        <div
          key={f.id}
          className="data-chat-bell"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "0.55rem 0.8rem",
            borderRadius: 10,
            background: "linear-gradient(90deg, #7c3aed, #8b5cf6)",
            color: "#fff",
          }}
        >
          <span className="data-chat-bell-icon" aria-hidden>
            🔔
          </span>
          <span style={{ fontWeight: 800, fontSize: "0.85rem" }}>
            Follow-up chat with {f.studentName} is due today
            {f.periodNumber !== null ? ` (period ${f.periodNumber})` : ""}
          </span>
          {f.snoozeCount >= 3 && (
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 700,
                background: "rgba(255,255,255,0.2)",
                borderRadius: 999,
                padding: "0.1rem 0.5rem",
              }}
            >
              snoozed {f.snoozeCount}× — maybe today's the day?
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{ ...smallBtn, background: "#fff", color: "#7c3aed", border: "none" }}
            disabled={busyId === f.id}
            onClick={() => onOpenChat(f.studentId)}
          >
            💬 Chat now
          </button>
          <button
            type="button"
            style={smallBtn}
            disabled={busyId === f.id}
            onClick={() => void act(f.id, "snooze1")}
          >
            Snooze 1 day
          </button>
          <button
            type="button"
            style={smallBtn}
            disabled={busyId === f.id}
            onClick={() => void act(f.id, "snooze3")}
          >
            3 days
          </button>
          <button
            type="button"
            style={{ ...smallBtn, opacity: 0.85 }}
            disabled={busyId === f.id}
            onClick={() => void act(f.id, "cancel")}
          >
            Cancel
          </button>
        </div>
      ))}
      {(quietDue.length > 0 || tomorrow.length > 0) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "0.4rem 0.7rem",
            borderRadius: 10,
            border: "1px solid var(--border, #cbd5e1)",
            background: "var(--surface-2, rgba(148,163,184,0.08))",
            fontSize: "0.8rem",
          }}
        >
          <span aria-hidden>🗓️</span>
          {quietDue.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onOpenChat(f.studentId)}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "#7c3aed",
                fontWeight: 700,
                fontSize: "0.8rem",
                padding: 0,
              }}
            >
              {f.studentName} — follow-up due today
            </button>
          ))}
          {tomorrow.map((f) => (
            <span key={f.id} style={{ color: "var(--text-subtle, #64748b)" }}>
              Heads-up: follow-up chat with{" "}
              <strong style={{ color: "var(--text, inherit)" }}>
                {f.studentName}
              </strong>{" "}
              tomorrow
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin page — templates + campaigns (Core Team; server re-enforces)
// ---------------------------------------------------------------------------

function TemplateEditor({
  tpl,
  onDone,
}: {
  tpl: TemplateRow | null; // null = create new
  onDone: (saved: boolean) => void;
}) {
  const [name, setName] = useState(tpl?.name ?? "");
  const [items, setItems] = useState<ChecklistItem[]>(
    tpl?.checklist ?? [{ id: `t${Date.now()}`, label: "" }],
  );
  const [chips, setChips] = useState<string[]>(tpl?.goalChips ?? []);
  const [chipDraft, setChipDraft] = useState("");
  const [share, setShare] = useState(tpl?.shareWithFamilies ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const checklist = items
      .map((i) => ({ id: i.id, label: i.label.trim() }))
      .filter((i) => i.label);
    if (checklist.length === 0) {
      setErr("Add at least one checklist topic.");
      return;
    }
    if (!tpl && !name.trim()) {
      setErr("Template name is required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        checklist,
        goalChips: chips,
        shareWithFamilies: share,
      };
      const r = await authFetch(
        tpl ? `/api/data-chats/templates/${tpl.id}` : "/api/data-chats/templates",
        {
          method: tpl ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const d = (await r.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!r.ok || !d?.ok) {
        setErr(d?.error ?? "Couldn't save the template.");
        return;
      }
      onDone(true);
    } catch {
      setErr("Couldn't save the template.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...cardStyle, borderColor: "rgba(139,92,246,0.45)" }}>
      <div style={{ fontWeight: 800, marginBottom: "0.6rem" }}>
        {tpl ? `Edit template: ${tpl.name}` : "New template"}
        {tpl?.builtIn && (
          <span
            style={{
              marginLeft: 8,
              fontSize: "0.72rem",
              fontWeight: 700,
              color: "#7c3aed",
            }}
          >
            built-in — name locked
          </span>
        )}
      </div>

      {(!tpl || !tpl.builtIn) && (
        <label style={{ display: "block", marginBottom: "0.7rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
            Name
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="e.g. Attendance Check-In"
            style={{
              width: "100%",
              boxSizing: "border-box",
              borderRadius: 8,
              border: "1px solid var(--border, #cbd5e1)",
              padding: "0.45rem 0.7rem",
              fontSize: "0.9rem",
            }}
          />
        </label>
      )}

      <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
        Checklist — what should teachers cover?
      </div>
      {items.map((item, idx) => (
        <div
          key={item.id}
          style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}
        >
          <input
            value={item.label}
            onChange={(e) =>
              setItems((prev) =>
                prev.map((p, i) =>
                  i === idx ? { ...p, label: e.target.value } : p,
                ),
              )
            }
            maxLength={160}
            placeholder="Topic to discuss"
            style={{
              flex: 1,
              borderRadius: 8,
              border: "1px solid var(--border, #cbd5e1)",
              padding: "0.4rem 0.7rem",
              fontSize: "0.88rem",
            }}
          />
          <button
            type="button"
            onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
            aria-label="Remove topic"
            style={{
              border: "1px solid var(--border, #cbd5e1)",
              borderRadius: 8,
              background: "transparent",
              cursor: "pointer",
              padding: "0.35rem 0.6rem",
              color: "var(--text-subtle, #94a3b8)",
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setItems((prev) => [
            ...prev,
            { id: `t${Date.now()}${prev.length}`, label: "" },
          ])
        }
        style={{
          border: "1px dashed var(--border, #cbd5e1)",
          borderRadius: 8,
          background: "transparent",
          cursor: "pointer",
          padding: "0.35rem 0.8rem",
          fontSize: "0.82rem",
          color: "var(--text-subtle, #94a3b8)",
          marginBottom: "0.8rem",
        }}
      >
        + Add topic
      </button>

      <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
        Goal chips — one-tap goal starters (optional)
      </div>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}
      >
        {chips.map((chip, idx) => (
          <span
            key={`${chip}-${idx}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              border: "1px solid rgba(139,92,246,0.4)",
              background: "rgba(139,92,246,0.08)",
              color: "#7c3aed",
              borderRadius: 999,
              padding: "0.2rem 0.6rem",
              fontSize: "0.78rem",
              fontWeight: 600,
            }}
          >
            {chip}
            <button
              type="button"
              onClick={() => setChips((prev) => prev.filter((_, i) => i !== idx))}
              aria-label={`Remove chip ${chip}`}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "#7c3aed",
                padding: 0,
                fontSize: "0.8rem",
              }}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: "0.8rem" }}>
        <input
          value={chipDraft}
          onChange={(e) => setChipDraft(e.target.value)}
          maxLength={80}
          placeholder="e.g. Raise my level by one step"
          onKeyDown={(e) => {
            if (e.key === "Enter" && chipDraft.trim()) {
              setChips((prev) => [...prev, chipDraft.trim()]);
              setChipDraft("");
            }
          }}
          style={{
            flex: 1,
            borderRadius: 8,
            border: "1px solid var(--border, #cbd5e1)",
            padding: "0.4rem 0.7rem",
            fontSize: "0.88rem",
          }}
        />
        <button
          type="button"
          onClick={() => {
            if (chipDraft.trim()) {
              setChips((prev) => [...prev, chipDraft.trim()]);
              setChipDraft("");
            }
          }}
          style={{
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: 8,
            background: "transparent",
            cursor: "pointer",
            padding: "0.35rem 0.8rem",
            fontSize: "0.82rem",
          }}
        >
          Add
        </button>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: "0.88rem",
          marginBottom: "0.8rem",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={share}
          onChange={(e) => setShare(e.target.checked)}
        />
        Share topics + goals with families by default (HeartBEAT)
      </label>

      <ErrText text={err} />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            border: "none",
            borderRadius: 8,
            padding: "0.5rem 1.1rem",
            fontWeight: 700,
            fontSize: "0.88rem",
            cursor: saving ? "default" : "pointer",
            background: "#8b5cf6",
            color: "#fff",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save template"}
        </button>
        <button
          type="button"
          onClick={() => onDone(false)}
          style={{
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: 8,
            padding: "0.5rem 1.1rem",
            fontWeight: 600,
            fontSize: "0.88rem",
            cursor: "pointer",
            background: "transparent",
            color: "var(--text, inherit)",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function LaunchForm({
  templates,
  onDone,
}: {
  templates: TemplateRow[];
  onDone: (launched: boolean) => void;
}) {
  const [templateId, setTemplateId] = useState<number | null>(
    templates[0]?.id ?? null,
  );
  const tpl = templates.find((t) => t.id === templateId) ?? null;
  const [name, setName] = useState("");
  const [deadline, setDeadline] = useState("");
  const [subject, setSubject] = useState<"ela" | "math" | "both">("both");
  // FAST templates: route to subject teachers-of-record (default) or to a
  // hand-picked teacher set (any department — science, CTE, electives…).
  const [fastAssign, setFastAssign] = useState<"subject" | "selected">(
    "subject",
  );
  const [teacherIds, setTeacherIds] = useState<Set<number>>(new Set());
  const [period, setPeriod] = useState(1);
  const [checked, setChecked] = useState<Set<string> | null>(null); // null = all
  const [share, setShare] = useState<boolean | null>(null); // null = template default
  const [directory, setDirectory] = useState<DirectoryStaff[]>([]);
  const [teacherFilter, setTeacherFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Student scope
  const [scopeType, setScopeType] = useState<ScopeInfo["type"]>("all");
  const [scopeFlags, setScopeFlags] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<
    Array<{ studentId: string; name: string; localSisId: string | null }>
  >([]);
  const [studentQuery, setStudentQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    Array<{
      studentId: string;
      firstName: string;
      lastName: string;
      grade: string;
      localSisId: string | null;
    }>
  >([]);
  const [preview, setPreview] = useState<{
    students: number;
    pairs: number;
    teachers: number;
    unmatchedStudentIds: string[];
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Typeahead for hand-picked students (debounced).
  useEffect(() => {
    if (scopeType !== "handpicked" || studentQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(() => {
      authFetch(
        `/api/student-lookup/search?q=${encodeURIComponent(studentQuery.trim())}`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.students) setSearchResults(d.students);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [scopeType, studentQuery]);

  // Any input change invalidates a previous preview.
  useEffect(() => {
    setPreview(null);
  }, [templateId, subject, fastAssign, teacherIds, period, scopeType, scopeFlags, picked]);

  const buildScopeBody = (): Record<string, unknown> | null => {
    if (scopeType === "all") return null;
    if (scopeType === "flags") return { type: "flags", flags: [...scopeFlags] };
    if (scopeType === "df") return { type: "df" };
    return { type: "handpicked", studentIds: picked.map((p) => p.studentId) };
  };

  const validateScope = (): string | null => {
    if (scopeType === "flags" && scopeFlags.size === 0)
      return "Pick at least one support flag.";
    if (scopeType === "handpicked" && picked.length === 0)
      return "Pick at least one student.";
    return null;
  };

  const runPreview = async () => {
    if (!tpl) return;
    const scopeErr = validateScope();
    if (scopeErr) {
      setErr(scopeErr);
      return;
    }
    setPreviewing(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { templateId: tpl.id };
      if (tpl.kind === "fast_data" && fastAssign === "subject") {
        body.subject = subject;
      } else {
        body.teacherIds = [...teacherIds];
        body.responsiblePeriod = period;
        if (tpl.kind === "fast_data") body.assignment = "selected";
      }
      const scope = buildScopeBody();
      if (scope) body.scope = scope;
      const r = await authFetch("/api/data-chats/campaigns/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => null)) as
        | (typeof preview & { error?: string })
        | null;
      if (!r.ok || !d) {
        setErr(d?.error ?? "Couldn't preview the scope.");
        return;
      }
      setPreview(d);
    } catch {
      setErr("Couldn't preview the scope.");
    } finally {
      setPreviewing(false);
    }
  };

  useEffect(() => {
    authFetch("/api/staff-directory")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.staff) setDirectory(d.staff as DirectoryStaff[]);
      })
      .catch(() => {});
  }, []);

  // Reset per-template state when the template changes.
  useEffect(() => {
    setChecked(null);
    setShare(null);
  }, [templateId]);

  const launch = async () => {
    if (!tpl) return;
    if (!deadline) {
      setErr("Pick a deadline.");
      return;
    }
    if (
      (tpl.kind !== "fast_data" || fastAssign === "selected") &&
      teacherIds.size === 0
    ) {
      setErr("Pick at least one teacher.");
      return;
    }
    const scopeErr = validateScope();
    if (scopeErr) {
      setErr(scopeErr);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        templateId: tpl.id,
        name: name.trim(),
        deadline,
      };
      if (tpl.kind === "fast_data" && fastAssign === "subject") {
        body.subject = subject;
      } else {
        body.teacherIds = [...teacherIds];
        body.responsiblePeriod = period;
        if (tpl.kind === "fast_data") body.assignment = "selected";
      }
      if (checked !== null) body.checklistItemIds = [...checked];
      if (share !== null) body.shareWithFamilies = share;
      const scope = buildScopeBody();
      if (scope) body.scope = scope;
      const r = await authFetch("/api/data-chats/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!r.ok || !d?.ok) {
        setErr(d?.error ?? "Couldn't launch the campaign.");
        return;
      }
      onDone(true);
    } catch {
      setErr("Couldn't launch the campaign.");
    } finally {
      setSaving(false);
    }
  };

  const filteredDirectory = directory.filter((s) =>
    s.displayName.toLowerCase().includes(teacherFilter.toLowerCase()),
  );

  // Department-grouped view of the filtered directory, canonical order +
  // alpha inside each group — same convention as the shared TeacherPicker
  // so every teacher chooser in the app sorts identically.
  const groupedDirectory = useMemo(() => {
    const g = new Map<string, DirectoryStaff[]>();
    for (const s of filteredDirectory) {
      const d = deptOf(s);
      const arr = g.get(d);
      if (arr) arr.push(s);
      else g.set(d, [s]);
    }
    for (const arr of g.values()) {
      arr.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return DEPARTMENT_ORDER.filter((d) => g.has(d)).map((d) => ({
      dept: d,
      teachers: g.get(d)!,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, teacherFilter]);

  const effShare = share ?? tpl?.shareWithFamilies ?? true;

  return (
    <div style={{ ...cardStyle, borderColor: "rgba(139,92,246,0.45)" }}>
      <div style={{ fontWeight: 800, marginBottom: "0.6rem" }}>
        Launch a data-chat campaign
      </div>

      <label style={{ display: "block", marginBottom: "0.7rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
          Template
        </div>
        <select
          value={templateId ?? ""}
          onChange={(e) => setTemplateId(Number(e.target.value))}
          style={{
            width: "100%",
            borderRadius: 8,
            border: "1px solid var(--border, #cbd5e1)",
            padding: "0.45rem 0.7rem",
            fontSize: "0.9rem",
          }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.kind === "fast_data" ? " (FAST)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "block", marginBottom: "0.7rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
          Campaign name{" "}
          <span
            style={{
              fontWeight: 600,
              fontSize: "0.75rem",
              color: "var(--text-subtle, #94a3b8)",
            }}
          >
            (blank = template name)
          </span>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={160}
          placeholder={tpl ? `e.g. ${tpl.name} — PM2` : ""}
          style={{
            width: "100%",
            boxSizing: "border-box",
            borderRadius: 8,
            border: "1px solid var(--border, #cbd5e1)",
            padding: "0.45rem 0.7rem",
            fontSize: "0.9rem",
          }}
        />
      </label>

      <label style={{ display: "block", marginBottom: "0.7rem" }}>
        <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
          Deadline
        </div>
        <input
          type="date"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          style={{
            borderRadius: 8,
            border: "1px solid var(--border, #cbd5e1)",
            padding: "0.45rem 0.7rem",
            fontSize: "0.9rem",
          }}
        />
      </label>

      {tpl?.kind === "fast_data" && (
        <div style={{ marginBottom: "0.7rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
            Who runs the chats?
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(
              [
                ["subject", "ELA / Math teachers of record"],
                [
                  "selected",
                  "Pick any teachers (science, electives, CTE…) + period",
                ],
              ] as const
            ).map(([v, label]) => (
              <label
                key={v}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: "0.88rem",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="dc-fast-assign"
                  checked={fastAssign === v}
                  onChange={() => setFastAssign(v)}
                />
                {label}
              </label>
            ))}
          </div>
          {fastAssign === "subject" && (
            <>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  margin: "10px 0 4px",
                }}
              >
                Subject
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                {(
                  [
                    ["both", "ELA + Math"],
                    ["ela", "ELA only"],
                    ["math", "Math only"],
                  ] as const
                ).map(([v, label]) => (
                  <label
                    key={v}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: "0.88rem",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="dc-subject"
                      checked={subject === v}
                      onChange={() => setSubject(v)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-subtle, #94a3b8)",
                  marginTop: 4,
                }}
              >
                Each student is assigned to their ELA / Math teacher of record.
              </div>
            </>
          )}
        </div>
      )}
      {tpl && (tpl.kind !== "fast_data" || fastAssign === "selected") ? (
        <div style={{ marginBottom: "0.7rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
            Teachers ({teacherIds.size} selected)
          </div>
          <input
            value={teacherFilter}
            onChange={(e) => setTeacherFilter(e.target.value)}
            placeholder="Search teachers…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              borderRadius: 8,
              border: "1px solid var(--border, #cbd5e1)",
              padding: "0.4rem 0.7rem",
              fontSize: "0.85rem",
              marginBottom: 6,
            }}
          />
          <div
            style={{
              maxHeight: 180,
              overflowY: "auto",
              border: "1px solid var(--border, #e2e8f0)",
              borderRadius: 8,
              padding: "0.4rem 0.6rem",
            }}
          >
            {groupedDirectory.map(({ dept, teachers }) => (
              <div key={dept}>
                <div
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "#334155",
                    backgroundColor: tintFor(dept),
                    borderRadius: 6,
                    padding: "0.15rem 0.5rem",
                    margin: "0.35rem 0 0.15rem",
                  }}
                >
                  {dept}
                </div>
                {teachers.map((s) => (
                  <label
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: "0.85rem",
                      padding: "0.15rem 0",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={teacherIds.has(s.id)}
                      onChange={() =>
                        setTeacherIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.id)) next.delete(s.id);
                          else next.add(s.id);
                          return next;
                        })
                      }
                    />
                    {s.displayName}
                  </label>
                ))}
              </div>
            ))}
            {filteredDirectory.length === 0 && (
              <div
                style={{ fontSize: "0.8rem", color: "var(--text-subtle, #94a3b8)" }}
              >
                No matching staff.
              </div>
            )}
          </div>
          <label style={{ display: "block", marginTop: 8 }}>
            <span style={{ fontWeight: 700, fontSize: "0.85rem", marginRight: 8 }}>
              Responsible period
            </span>
            <select
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
              style={{
                borderRadius: 8,
                border: "1px solid var(--border, #cbd5e1)",
                padding: "0.3rem 0.6rem",
                fontSize: "0.85rem",
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => (
                <option key={p} value={p}>
                  Period {p}
                </option>
              ))}
            </select>
            <span
              style={{
                marginLeft: 8,
                fontSize: "0.75rem",
                color: "var(--text-subtle, #94a3b8)",
              }}
            >
              Each teacher chats with their period-{period} roster.
            </span>
          </label>
        </div>
      ) : null}

      {tpl && (
        <div style={{ marginBottom: "0.7rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
            Which students?
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(
              [
                ["all", "All students on the assigned rosters"],
                ["flags", "Only students with support flags"],
                ["df", "Only students with a D or F in class"],
                ["handpicked", "Hand-pick students"],
              ] as const
            ).map(([v, label]) => (
              <label
                key={v}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: "0.88rem",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="dc-scope"
                  checked={scopeType === v}
                  onChange={() => setScopeType(v)}
                />
                {label}
              </label>
            ))}
          </div>
          {scopeType === "flags" && (
            <div style={{ display: "flex", gap: 14, margin: "6px 0 0 22px" }}>
              {(
                [
                  ["ese", "ESE"],
                  ["is504", "504"],
                  ["ell", "ELL"],
                ] as const
              ).map(([v, label]) => (
                <label
                  key={v}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={scopeFlags.has(v)}
                    onChange={() =>
                      setScopeFlags((prev) => {
                        const next = new Set(prev);
                        if (next.has(v)) next.delete(v);
                        else next.add(v);
                        return next;
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          {scopeType === "df" && (
            <div
              style={{
                margin: "4px 0 0 22px",
                fontSize: "0.75rem",
                color: "var(--text-subtle, #94a3b8)",
              }}
            >
              Current grade below 70 in the latest gradebook import. FAST
              campaigns match the failing course to that teacher&apos;s subject;
              custom campaigns count any failing course.
            </div>
          )}
          {scopeType === "handpicked" && (
            <div style={{ margin: "6px 0 0 22px" }}>
              <input
                value={studentQuery}
                onChange={(e) => setStudentQuery(e.target.value)}
                placeholder="Search students by name or ID…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  borderRadius: 8,
                  border: "1px solid var(--border, #cbd5e1)",
                  padding: "0.4rem 0.7rem",
                  fontSize: "0.85rem",
                }}
              />
              {searchResults.length > 0 && (
                <div
                  style={{
                    maxHeight: 160,
                    overflowY: "auto",
                    border: "1px solid var(--border, #e2e8f0)",
                    borderRadius: 8,
                    marginTop: 4,
                    padding: "0.3rem 0.5rem",
                  }}
                >
                  {searchResults
                    .filter(
                      (s) => !picked.some((p) => p.studentId === s.studentId),
                    )
                    .map((s) => (
                      <button
                        key={s.studentId}
                        type="button"
                        onClick={() => {
                          setPicked((prev) => [
                            ...prev,
                            {
                              studentId: s.studentId,
                              name: `${s.firstName} ${s.lastName}`,
                              localSisId: s.localSisId,
                            },
                          ]);
                          setStudentQuery("");
                          setSearchResults([]);
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          fontSize: "0.85rem",
                          padding: "0.18rem 0.2rem",
                          color: "var(--text, inherit)",
                        }}
                      >
                        + {s.firstName} {s.lastName}
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: "0.72rem",
                            color: "var(--text-subtle, #94a3b8)",
                          }}
                        >
                          Gr {s.grade}
                          {s.localSisId ? ` · ${s.localSisId}` : ""}
                        </span>
                      </button>
                    ))}
                </div>
              )}
              {picked.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    marginTop: 6,
                  }}
                >
                  {picked.map((p) => (
                    <span
                      key={p.studentId}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: "0.78rem",
                        fontWeight: 600,
                        borderRadius: 999,
                        padding: "0.15rem 0.55rem",
                        background: "rgba(139,92,246,0.12)",
                        color: "#7c3aed",
                      }}
                    >
                      {p.name}
                      <button
                        type="button"
                        onClick={() =>
                          setPicked((prev) =>
                            prev.filter((x) => x.studentId !== p.studentId),
                          )
                        }
                        aria-label={`Remove ${p.name}`}
                        style={{
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          color: "inherit",
                          fontWeight: 800,
                          padding: 0,
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 8,
            }}
          >
            <button
              type="button"
              onClick={runPreview}
              disabled={previewing}
              style={{
                border: "1px solid rgba(139,92,246,0.5)",
                borderRadius: 8,
                padding: "0.3rem 0.8rem",
                fontWeight: 700,
                fontSize: "0.8rem",
                cursor: previewing ? "default" : "pointer",
                background: "transparent",
                color: "#7c3aed",
                opacity: previewing ? 0.6 : 1,
              }}
            >
              {previewing ? "Counting…" : "Preview who's included"}
            </button>
            {preview && (
              <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                {preview.students} student{preview.students === 1 ? "" : "s"} ·{" "}
                {preview.pairs} chat{preview.pairs === 1 ? "" : "s"} ·{" "}
                {preview.teachers} teacher{preview.teachers === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {preview && preview.unmatchedStudentIds.length > 0 && (
            <div
              style={{
                marginTop: 6,
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "#b45309",
              }}
            >
              ⚠ {preview.unmatchedStudentIds.length} hand-picked student
              {preview.unmatchedStudentIds.length === 1 ? " isn't" : "s aren't"}{" "}
              on an assigned teacher&apos;s roster and won&apos;t get a chat:{" "}
              {preview.unmatchedStudentIds
                .map(
                  (id) =>
                    picked.find((p) => p.studentId === id)?.name ?? "Unknown",
                )
                .join(", ")}
            </div>
          )}
        </div>
      )}

      {tpl && (
        <div style={{ marginBottom: "0.7rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
            Topics for this campaign
          </div>
          {tpl.checklist.map((item) => {
            const isOn = checked === null || checked.has(item.id);
            return (
              <label
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "0.85rem",
                  padding: "0.12rem 0",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => {
                    setChecked((prev) => {
                      const base = new Set(
                        prev === null ? tpl.checklist.map((c) => c.id) : prev,
                      );
                      if (base.has(item.id)) base.delete(item.id);
                      else base.add(item.id);
                      return base;
                    });
                  }}
                />
                {item.label}
              </label>
            );
          })}
        </div>
      )}

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: "0.88rem",
          marginBottom: "0.8rem",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={effShare}
          onChange={(e) => setShare(e.target.checked)}
        />
        Share topics + goals with families (HeartBEAT)
      </label>

      <ErrText text={err} />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={launch}
          disabled={saving || !tpl}
          style={{
            border: "none",
            borderRadius: 8,
            padding: "0.5rem 1.1rem",
            fontWeight: 700,
            fontSize: "0.88rem",
            cursor: saving ? "default" : "pointer",
            background: "#8b5cf6",
            color: "#fff",
            opacity: saving || !tpl ? 0.6 : 1,
          }}
        >
          {saving ? "Launching…" : "Launch campaign"}
        </button>
        <button
          type="button"
          onClick={() => onDone(false)}
          style={{
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: 8,
            padding: "0.5rem 1.1rem",
            fontWeight: 600,
            fontSize: "0.88rem",
            cursor: "pointer",
            background: "transparent",
            color: "var(--text, inherit)",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CampaignDetailView({
  id,
  onChanged,
}: {
  id: number;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const load = async () => {
    try {
      const r = await authFetch(`/api/data-chats/campaigns/${id}`, {
        cache: "no-store",
      });
      if (!r.ok) {
        setErr("Couldn't load the campaign.");
        return;
      }
      setDetail((await r.json()) as CampaignDetail);
    } catch {
      setErr("Couldn't load the campaign.");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const exportCsv = async () => {
    try {
      const r = await authFetch(`/api/data-chats/campaigns/${id}/export.csv`);
      if (!r.ok) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `data-chats-${id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* swallow */
    }
  };

  const endCampaign = async () => {
    setEnding(true);
    try {
      const r = await authFetch(`/api/data-chats/campaigns/${id}/end`, {
        method: "POST",
      });
      if (r.ok) {
        setConfirmEnd(false);
        await load();
        onChanged();
      }
    } finally {
      setEnding(false);
    }
  };

  if (err) return <ErrText text={err} />;
  if (!detail)
    return (
      <div style={{ color: "var(--text-subtle, #94a3b8)", padding: "0.5rem 0" }}>
        Loading…
      </div>
    );

  return (
    <div style={{ marginTop: "0.7rem" }}>
      {scopeLabel(detail.scope) && (
        <div
          style={{
            fontSize: "0.78rem",
            fontWeight: 700,
            color: "#b45309",
            marginBottom: "0.5rem",
          }}
        >
          {scopeLabel(detail.scope)} — student list was snapshotted at launch.
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: "0.7rem",
        }}
      >
        <button
          type="button"
          onClick={exportCsv}
          style={{
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: 8,
            padding: "0.35rem 0.9rem",
            fontWeight: 600,
            fontSize: "0.82rem",
            cursor: "pointer",
            background: "transparent",
            color: "var(--text, inherit)",
          }}
        >
          ⬇ Export CSV
        </button>
        {detail.active &&
          (confirmEnd ? (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: "0.82rem", fontWeight: 700 }}>
                End this campaign?
              </span>
              <button
                type="button"
                onClick={endCampaign}
                disabled={ending}
                style={{
                  border: "none",
                  borderRadius: 8,
                  padding: "0.35rem 0.9rem",
                  fontWeight: 700,
                  fontSize: "0.82rem",
                  cursor: "pointer",
                  background: "#dc2626",
                  color: "#fff",
                }}
              >
                {ending ? "Ending…" : "Yes, end it"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmEnd(false)}
                style={{
                  border: "1px solid var(--border, #cbd5e1)",
                  borderRadius: 8,
                  padding: "0.35rem 0.9rem",
                  fontWeight: 600,
                  fontSize: "0.82rem",
                  cursor: "pointer",
                  background: "transparent",
                  color: "var(--text, inherit)",
                }}
              >
                Keep going
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmEnd(true)}
              style={{
                border: "1px solid rgba(220,38,38,0.5)",
                borderRadius: 8,
                padding: "0.35rem 0.9rem",
                fontWeight: 600,
                fontSize: "0.82rem",
                cursor: "pointer",
                background: "transparent",
                color: "#dc2626",
              }}
            >
              End campaign
            </button>
          ))}
      </div>

      <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
        Teacher compliance ({detail.done}/{detail.total} logged)
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-subtle, #94a3b8)" }}>
            <th style={{ padding: "0.3rem 0.4rem" }}>Teacher</th>
            <th style={{ padding: "0.3rem 0.4rem" }}>Subject</th>
            <th style={{ padding: "0.3rem 0.4rem" }}>Done</th>
            <th style={{ padding: "0.3rem 0.4rem", width: "40%" }}>Progress</th>
          </tr>
        </thead>
        <tbody>
          {detail.teachers.map((t) => {
            const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
            return (
              <tr key={t.staffId} style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}>
                <td style={{ padding: "0.35rem 0.4rem", fontWeight: 600 }}>
                  {t.name}
                </td>
                <td style={{ padding: "0.35rem 0.4rem", textTransform: "uppercase", fontSize: "0.75rem" }}>
                  {t.subjects.join(", ") || "—"}
                </td>
                <td style={{ padding: "0.35rem 0.4rem" }}>
                  {t.done}/{t.total}
                </td>
                <td style={{ padding: "0.35rem 0.4rem" }}>
                  <div
                    style={{
                      height: 8,
                      borderRadius: 999,
                      background: "var(--border, #e2e8f0)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        borderRadius: 999,
                        background:
                          pct >= 100 ? "#16a34a" : pct >= 50 ? "#8b5cf6" : "#f59e0b",
                      }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ fontWeight: 700, fontSize: "0.85rem", margin: "0.8rem 0 4px" }}>
        Topic coverage — % of logged chats that covered each topic
      </div>
      {detail.topicCoverage.map((t) => {
        const pct =
          t.loggedTotal > 0 ? Math.round((t.count / t.loggedTotal) * 100) : 0;
        return (
          <div key={t.id} style={{ marginBottom: 6 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "0.82rem",
              }}
            >
              <span>{t.label}</span>
              <span style={{ fontWeight: 700 }}>
                {t.loggedTotal > 0 ? `${pct}%` : "—"}
              </span>
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 999,
                background: "var(--border, #e2e8f0)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: "#8b5cf6",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Core Team consistency dashboard for follow-ups — recognition framing:
// this celebrates teachers keeping their check-in commitments, it is not a
// student-record surface (no per-student rows on purpose).
function FollowupStatsTab() {
  const [teachers, setTeachers] = useState<
    | Array<{
        teacherStaffId: number;
        teacherName: string;
        scheduled: number;
        done: number;
        cancelled: number;
        pending: number;
        snoozes: number;
      }>
    | null
  >(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/data-chats/followups/admin-stats", { cache: "no-store" })
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as
          | { teachers?: NonNullable<typeof teachers>; error?: string }
          | null;
        if (cancelled) return;
        if (!r.ok || !d?.teachers) {
          setErr(d?.error ?? "Couldn't load follow-up stats.");
          return;
        }
        setTeachers(d.teachers);
      })
      .catch(() => {
        if (!cancelled) setErr("Couldn't load follow-up stats.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const th: React.CSSProperties = {
    textAlign: "left",
    padding: "0.4rem 0.6rem",
    fontSize: "0.75rem",
    textTransform: "uppercase",
    color: "var(--text-subtle, #94a3b8)",
    borderBottom: "1px solid var(--border, #cbd5e1)",
  };
  const td: React.CSSProperties = {
    padding: "0.45rem 0.6rem",
    fontSize: "0.85rem",
    borderBottom: "1px solid var(--border, rgba(148,163,184,0.25))",
  };

  return (
    <div>
      <p
        style={{
          color: "var(--text-subtle, #94a3b8)",
          fontSize: "0.85rem",
          margin: "0 0 0.8rem",
        }}
      >
        Teachers can schedule private follow-up chats with individual students.
        This view celebrates that consistency — who's circling back and closing
        the loop. Follow-ups are teacher-private planning: they never appear on
        the HeartBEAT, parent portal, or any student record.
      </p>
      <ErrText text={err} />
      {teachers === null && !err && (
        <div style={{ color: "var(--text-subtle, #94a3b8)" }}>Loading…</div>
      )}
      {teachers !== null && teachers.length === 0 && (
        <div style={{ color: "var(--text-subtle, #94a3b8)", fontSize: "0.85rem" }}>
          No follow-ups scheduled yet. Teachers can schedule one from the chat
          window on their roster.
        </div>
      )}
      {teachers !== null && teachers.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={th}>Teacher</th>
              <th style={th}>Scheduled</th>
              <th style={th}>Completed</th>
              <th style={th}>Follow-through</th>
              <th style={th}>Open</th>
              <th style={th}>Cancelled</th>
              <th style={th}>Snoozes</th>
            </tr>
          </thead>
          <tbody>
            {teachers.map((t) => {
              const closed = t.done + t.cancelled;
              const rate =
                closed > 0 ? Math.round((t.done / closed) * 100) : null;
              return (
                <tr key={t.teacherStaffId}>
                  <td style={{ ...td, fontWeight: 700 }}>{t.teacherName}</td>
                  <td style={td}>{t.scheduled}</td>
                  <td style={td}>
                    {t.done}
                    {t.done > 0 && (
                      <span aria-hidden style={{ marginLeft: 4 }}>
                        🌟
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {rate === null ? (
                      <span style={{ color: "var(--text-subtle, #94a3b8)" }}>
                        —
                      </span>
                    ) : (
                      <span
                        style={{
                          fontWeight: 700,
                          color:
                            rate >= 80
                              ? "#16a34a"
                              : rate >= 50
                                ? "#b45309"
                                : "var(--text, inherit)",
                        }}
                      >
                        {rate}%
                      </span>
                    )}
                  </td>
                  <td style={td}>{t.pending}</td>
                  <td style={td}>{t.cancelled}</td>
                  <td style={td}>{t.snoozes}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function DataChatsAdminPage() {
  const [tab, setTab] = useState<"campaigns" | "templates" | "followups">(
    "campaigns",
  );
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TemplateRow | null | "new">(null);
  const [launching, setLaunching] = useState(false);
  const [openDetail, setOpenDetail] = useState<number | null>(null);

  const loadTemplates = async () => {
    try {
      const r = await authFetch("/api/data-chats/templates", {
        cache: "no-store",
      });
      if (!r.ok) {
        setErr(
          r.status === 403
            ? "Core Team access required."
            : "Couldn't load templates.",
        );
        return;
      }
      setTemplates((await r.json()) as TemplateRow[]);
    } catch {
      setErr("Couldn't load templates.");
    }
  };

  const loadCampaigns = async () => {
    try {
      const r = await authFetch("/api/data-chats/campaigns", {
        cache: "no-store",
      });
      if (!r.ok) return;
      setCampaigns((await r.json()) as CampaignRow[]);
    } catch {
      /* swallow */
    }
  };

  useEffect(() => {
    void loadTemplates();
    void loadCampaigns();
  }, []);

  const active = (campaigns ?? []).filter((c) => c.active);
  const past = (campaigns ?? []).filter((c) => !c.active);

  const archiveTemplate = async (t: TemplateRow) => {
    const r = await authFetch(`/api/data-chats/templates/${t.id}`, {
      method: "DELETE",
    });
    if (r.ok) void loadTemplates();
  };

  const renderCampaignRow = (c: CampaignRow) => {
    const pct = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0;
    const isOpen = openDetail === c.id;
    return (
      <div key={c.id} style={{ ...cardStyle, marginBottom: "0.7rem" }}>
        <button
          type="button"
          onClick={() => setOpenDetail(isOpen ? null : c.id)}
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            textAlign: "left",
            color: "var(--text, inherit)",
          }}
        >
          <span>
            <span style={{ fontWeight: 800, fontSize: "0.95rem" }}>{c.name}</span>
            <span
              style={{
                marginLeft: 8,
                fontSize: "0.72rem",
                fontWeight: 700,
                color: "#7c3aed",
                textTransform: "uppercase",
              }}
            >
              {c.kind === "fast_data"
                ? c.subject === null
                  ? `FAST · picked teachers · P${c.responsiblePeriod}`
                  : `FAST ${c.subject === "both" ? "ELA+Math" : c.subject}`
                : `custom · P${c.responsiblePeriod}`}
            </span>
            {c.shareWithFamilies && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  color: "#16a34a",
                }}
              >
                shared with families
              </span>
            )}
            {scopeLabel(c.scope) && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  color: "#b45309",
                }}
              >
                {scopeLabel(c.scope)}
              </span>
            )}
          </span>
          <span style={{ fontSize: "0.8rem", color: "var(--text-subtle, #94a3b8)" }}>
            {c.active ? `Due ${c.deadline}` : `Ended · was due ${c.deadline}`} ·{" "}
            {c.teacherCount} teacher{c.teacherCount === 1 ? "" : "s"} ·{" "}
            <span style={{ fontWeight: 700, color: pct >= 100 ? "#16a34a" : "inherit" }}>
              {c.done}/{c.total} ({pct}%)
            </span>{" "}
            {isOpen ? "▾" : "▸"}
          </span>
        </button>
        {isOpen && (
          <CampaignDetailView id={c.id} onChanged={() => void loadCampaigns()} />
        )}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 880 }}>
      <h1 style={{ fontSize: "1.35rem", margin: "0 0 0.25rem" }}>
        💬 Data Chats
      </h1>
      <p
        style={{
          margin: "0 0 1rem",
          fontSize: "0.88rem",
          color: "var(--text-subtle, #94a3b8)",
        }}
      >
        Push structured one-on-one check-in campaigns to teachers. Each teacher
        gets a queue, works through their students before the deadline, and
        families can see the topics + goal on the HeartBEAT when sharing is on.
        Private teacher notes never leave the staff side.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: "1rem" }}>
        {(
          [
            ["campaigns", "Campaigns"],
            ["templates", "Templates"],
            ["followups", "Follow-ups"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            style={{
              border: "1px solid var(--border, #cbd5e1)",
              borderRadius: 999,
              padding: "0.35rem 1rem",
              fontWeight: 700,
              fontSize: "0.85rem",
              cursor: "pointer",
              background: tab === key ? "#8b5cf6" : "transparent",
              color: tab === key ? "#fff" : "var(--text, inherit)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <ErrText text={err} />

      {tab === "campaigns" && (
        <>
          {launching ? (
            <LaunchForm
              templates={templates}
              onDone={(ok) => {
                setLaunching(false);
                if (ok) void loadCampaigns();
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setLaunching(true)}
              disabled={templates.length === 0}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "0.5rem 1.1rem",
                fontWeight: 700,
                fontSize: "0.88rem",
                cursor: "pointer",
                background: "#8b5cf6",
                color: "#fff",
                marginBottom: "1rem",
                opacity: templates.length === 0 ? 0.6 : 1,
              }}
            >
              + Launch campaign
            </button>
          )}

          <div style={{ fontWeight: 800, fontSize: "0.9rem", margin: "0.5rem 0" }}>
            Active
          </div>
          {campaigns === null ? (
            <div style={{ color: "var(--text-subtle, #94a3b8)" }}>Loading…</div>
          ) : active.length === 0 ? (
            <div style={{ color: "var(--text-subtle, #94a3b8)", fontSize: "0.85rem" }}>
              No active campaigns. Launch one to put a queue in front of
              teachers.
            </div>
          ) : (
            active.map(renderCampaignRow)
          )}

          {past.length > 0 && (
            <>
              <div
                style={{ fontWeight: 800, fontSize: "0.9rem", margin: "1rem 0 0.5rem" }}
              >
                History
              </div>
              {past.map(renderCampaignRow)}
            </>
          )}
        </>
      )}

      {tab === "followups" && <FollowupStatsTab />}

      {tab === "templates" && (
        <>
          {editing !== null ? (
            <TemplateEditor
              tpl={editing === "new" ? null : editing}
              onDone={(saved) => {
                setEditing(null);
                if (saved) void loadTemplates();
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing("new")}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "0.5rem 1.1rem",
                fontWeight: 700,
                fontSize: "0.88rem",
                cursor: "pointer",
                background: "#8b5cf6",
                color: "#fff",
                marginBottom: "1rem",
              }}
            >
              + New template
            </button>
          )}

          {templates.map((t) => (
            <div key={t.id} style={{ ...cardStyle, marginBottom: "0.7rem" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <span style={{ fontWeight: 800 }}>{t.name}</span>
                  {t.builtIn && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: "0.72rem",
                        fontWeight: 700,
                        color: "#7c3aed",
                      }}
                    >
                      built-in
                    </span>
                  )}
                  {t.shareWithFamilies && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: "0.72rem",
                        fontWeight: 600,
                        color: "#16a34a",
                      }}
                    >
                      shares with families
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setEditing(t)}
                    style={{
                      border: "1px solid var(--border, #cbd5e1)",
                      borderRadius: 8,
                      padding: "0.3rem 0.8rem",
                      fontWeight: 600,
                      fontSize: "0.8rem",
                      cursor: "pointer",
                      background: "transparent",
                      color: "var(--text, inherit)",
                    }}
                  >
                    Edit
                  </button>
                  {!t.builtIn && (
                    <button
                      type="button"
                      onClick={() => void archiveTemplate(t)}
                      style={{
                        border: "1px solid rgba(220,38,38,0.5)",
                        borderRadius: 8,
                        padding: "0.3rem 0.8rem",
                        fontWeight: 600,
                        fontSize: "0.8rem",
                        cursor: "pointer",
                        background: "transparent",
                        color: "#dc2626",
                      }}
                    >
                      Archive
                    </button>
                  )}
                </div>
              </div>
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-subtle, #94a3b8)",
                  marginTop: 4,
                }}
              >
                {t.checklist.length} topic{t.checklist.length === 1 ? "" : "s"}:{" "}
                {t.checklist.map((c) => c.label).join(" · ")}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
