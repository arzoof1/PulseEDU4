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
};

type DirectoryStaff = { id: number; displayName: string; email: string | null };

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
}: {
  entry: QueueEntry;
  student: QueueStudent;
  onSaved: () => void;
  onCancel: () => void;
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
      const r = await authFetch("/api/data-chats/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaignId: c.id,
          studentId: student.studentId,
          discussed: [...discussed],
          goal,
          privateNote,
        }),
      });
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
  const [teacherIds, setTeacherIds] = useState<Set<number>>(new Set());
  const [period, setPeriod] = useState(1);
  const [checked, setChecked] = useState<Set<string> | null>(null); // null = all
  const [share, setShare] = useState<boolean | null>(null); // null = template default
  const [directory, setDirectory] = useState<DirectoryStaff[]>([]);
  const [teacherFilter, setTeacherFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    if (tpl.kind !== "fast_data" && teacherIds.size === 0) {
      setErr("Pick at least one teacher.");
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
      if (tpl.kind === "fast_data") body.subject = subject;
      else {
        body.teacherIds = [...teacherIds];
        body.responsiblePeriod = period;
      }
      if (checked !== null) body.checklistItemIds = [...checked];
      if (share !== null) body.shareWithFamilies = share;
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

      {tpl?.kind === "fast_data" ? (
        <div style={{ marginBottom: "0.7rem" }}>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 4 }}>
            Subject — which teachers run the chats?
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
        </div>
      ) : tpl ? (
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
            {filteredDirectory.map((s) => (
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

export default function DataChatsAdminPage() {
  const [tab, setTab] = useState<"campaigns" | "templates">("campaigns");
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
                ? `FAST ${c.subject === "both" ? "ELA+Math" : (c.subject ?? "")}`
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
