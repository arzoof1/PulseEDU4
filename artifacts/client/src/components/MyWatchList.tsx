// "My Watch List" — teacher-personal hand-curated bookmark list.
//
// Each teacher's own private "kids on my mind" view. Distinct from the
// system Watch List (which is data-driven and shows everyone in the
// caller's visibility scope). This is the teacher's working notes:
// sticky-note style cards with self-tagged groups, free-text "why I'm
// watching" notes, optional follow-up reminders, and a quick-action
// touch log.
//
// All CRUD goes through /api/insights/my-watchlist (see
// routes/myWatchlist.ts). Visibility scope mirrors the system watch
// list — teachers can only bookmark students they can already see.
//
// Hardcoded v1 group set: reading / behavior / family / shine. Custom
// groups are a planned follow-up; the schema already accepts any
// string so the UI can grow into custom groups without a migration.

import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  howtoListStyle,
} from "./HowToUseHelp";

interface Entry {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
  groupKey: string;
  note: string;
  followupText: string | null;
  followupDue: string | null; // YYYY-MM-DD
  addedAt: string;
  // Set by the server when a core-team member (admin / MTSS coord /
  // behavior specialist / PBIS coord / SuperUser) added the entry on
  // this teacher's behalf. Null for self-added entries.
  addedBy: { id: number; displayName: string } | null;
  lastTouchBy: string | null;
  lastTouchWhat: string | null;
  lastTouchAt: string | null;
}

interface StudentLookup {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | string | null;
}

interface StaffLookup {
  id: number;
  displayName: string;
}

// Subset of authUser the picker needs. App.tsx passes its own authUser
// state through; we only read what's actually used here so the prop
// stays decoupled from any future auth shape changes.
interface CurrentUser {
  id: number;
  displayName: string;
  isSuperUser?: boolean;
  isAdmin?: boolean;
  isBehaviorSpecialist?: boolean;
  isMtssCoordinator?: boolean;
  isPbisCoordinator?: boolean;
}

function isCoreTeamUser(u: CurrentUser | null | undefined): boolean {
  if (!u) return false;
  return Boolean(
    u.isSuperUser ||
      u.isAdmin ||
      u.isBehaviorSpecialist ||
      u.isMtssCoordinator ||
      u.isPbisCoordinator,
  );
}

// Group definitions — visual + microcopy contract. Keys must be
// lowercased to match what the server stores. Extend by adding to this
// list (custom groups are a planned follow-up).
const GROUPS: Array<{
  key: string;
  label: string;
  emoji: string;
  hint: string;
  bg: string;
  border: string;
  fg: string;
  noteBg: string;
}> = [
  {
    key: "reading",
    label: "Reading concerns",
    emoji: "📖",
    hint: "Kids you're keeping a close read on — not always on the official watch list yet.",
    bg: "#eff6ff",
    border: "#bfdbfe",
    fg: "#1e40af",
    noteBg: "#fffceb",
  },
  {
    key: "behavior",
    label: "Behavior watch",
    emoji: "🛡️",
    hint: "Student you're holding extra grace and structure for this season.",
    bg: "#fef2f2",
    border: "#fecaca",
    fg: "#991b1b",
    noteBg: "#fff5f5",
  },
  {
    key: "family",
    label: "Family things to know",
    emoji: "🏠",
    hint: "Context that doesn't belong in a formal note but you don't want to forget.",
    bg: "#f5f3ff",
    border: "#ddd6fe",
    fg: "#5b21b6",
    noteBg: "#fdf4ff",
  },
  {
    key: "shine",
    label: "Quiet kids to lift up",
    emoji: "✨",
    hint: "Students who do everything right and rarely get the spotlight.",
    bg: "#ecfdf5",
    border: "#a7f3d0",
    fg: "#065f46",
    noteBg: "#f0fdf4",
  },
];

const QUICK_ACTIONS = [
  { what: "Touched base", emoji: "👋" },
  { what: "Called home", emoji: "📞" },
  { what: "Pulled aside", emoji: "🤝" },
] as const;

function groupDef(key: string) {
  return GROUPS.find((g) => g.key === key) ?? GROUPS[0];
}

// "3 days ago" — short, human, never longer than ~6 chars.
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const ms = Date.now() - then;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days <= 0) {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours <= 0) return "just now";
    if (hours === 1) return "1 hour ago";
    return `${hours} hours ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "1 week ago";
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

interface Props {
  onOpenStudent: (studentId: string) => void;
  // The signed-in user. When this is a core-team role, the Add modal
  // exposes an "Add to whose watch list?" picker so admins / MTSS
  // coords / behavior specialists can seed entries on a teacher's
  // behalf instead of just on their own list.
  currentUser?: CurrentUser | null;
}

export default function MyWatchList({ onOpenStudent, currentUser }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeGroup, setActiveGroup] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<Entry | null>(null);
  const [studentDirectory, setStudentDirectory] = useState<StudentLookup[]>([]);
  const [staffDirectory, setStaffDirectory] = useState<StaffLookup[]>([]);
  const isCore = isCoreTeamUser(currentUser);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const r = await authFetch("/api/insights/my-watchlist");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  // Pull the student directory once for the add modal.
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/students")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: StudentLookup[]) => {
        if (cancelled) return;
        setStudentDirectory(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull the staff directory only when the caller is core team — the
  // server returns 403 otherwise, so there's no point asking. Used to
  // power the "Add to whose watch list?" picker in the Add modal.
  useEffect(() => {
    if (!isCore) return;
    let cancelled = false;
    authFetch("/api/insights/my-watchlist/staff-directory")
      .then((r) => (r.ok ? r.json() : { staff: [] }))
      .then((data: { staff?: StaffLookup[] }) => {
        if (cancelled) return;
        setStaffDirectory(Array.isArray(data?.staff) ? data.staff : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isCore]);

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { all: entries.length };
    for (const g of GROUPS) counts[g.key] = 0;
    for (const e of entries) {
      counts[e.groupKey] = (counts[e.groupKey] ?? 0) + 1;
    }
    return counts;
  }, [entries]);

  const visibleEntries = useMemo(
    () =>
      activeGroup === "all"
        ? entries
        : entries.filter((e) => e.groupKey === activeGroup),
    [entries, activeGroup],
  );

  // Bucket the visible entries by group so we can render section
  // headers in "all" view. In single-group view there's just one
  // bucket.
  const grouped = useMemo(() => {
    const buckets: Record<string, Entry[]> = {};
    for (const e of visibleEntries) {
      if (!buckets[e.groupKey]) buckets[e.groupKey] = [];
      buckets[e.groupKey].push(e);
    }
    return GROUPS.map((g) => ({ group: g, entries: buckets[g.key] ?? [] }))
      .filter((b) => b.entries.length > 0);
  }, [visibleEntries]);

  async function handleQuickTouch(entry: Entry, what: string) {
    try {
      const r = await authFetch(
        `/api/insights/my-watchlist/${entry.id}/touch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ what }),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log touch");
    }
  }

  async function handleRemove(entry: Entry) {
    if (
      !window.confirm(
        `Remove ${entry.firstName} ${entry.lastName} from your watch list?`,
      )
    )
      return;
    try {
      const r = await authFetch(`/api/insights/my-watchlist/${entry.id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    }
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.25rem",
        }}
      >
        <h2 style={{ margin: 0 }}>My Watch List</h2>
        <span
          style={{
            background: "#fef3c7",
            color: "#92400e",
            border: "1px solid #fcd34d",
            borderRadius: 999,
            padding: "0.1rem 0.5rem",
            fontSize: "0.7rem",
            fontWeight: 600,
          }}
        >
          🔒 Private to you
        </span>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          style={{
            marginLeft: "auto",
            background: "#0d9488",
            color: "white",
            border: "1px solid #0d9488",
            borderRadius: 6,
            padding: "0.4rem 0.8rem",
            cursor: "pointer",
            fontSize: "0.85rem",
            fontWeight: 600,
          }}
        >
          + Add a student
        </button>
      </div>
      <p
        style={{
          color: "var(--text-subtle)",
          marginTop: "0.25rem",
          marginBottom: "0.5rem",
          fontSize: "0.85rem",
        }}
      >
        Your personal "kids on my mind" list — separate from the system
        Watch List. Notes, groups, and follow-ups are visible only to
        you. Use it to keep track of students you're holding extra
        attention for, regardless of whether they've tripped a system
        flag.
      </p>

      <HowToUseHelp title="How to use My Watch List">
        <HowToSection title="What this is">
          A private space for students you're personally keeping an eye
          on. Unlike the system Watch List (which is data-driven and
          shared), this list is hand-curated and visible only to you.
          A student stays here until you remove them — they don't drop
          off because of a data refresh.
        </HowToSection>
        <HowToSection title="Adding a student">
          <ul style={howtoListStyle}>
            <li>
              Click <strong>+ Add a student</strong> in the top-right.
            </li>
            <li>
              Search by name or student ID — you can only add students
              you already have access to (your roster + any kids you're
              a trusted adult for; core team can add any student at the
              school).
            </li>
            <li>
              Pick a <strong>group</strong> — Reading, Behavior, Family,
              or Shine — and add a short note. Notes can be anything:
              "watch progress monitoring", "mom asked for weekly update",
              etc.
            </li>
            <li>
              Optionally add a <strong>follow-up</strong> — a short
              reminder text plus a date. Cards with a follow-up due
              today or earlier float to the top of their group.
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="Working the list day-to-day">
          <ul style={howtoListStyle}>
            <li>
              Use the <strong>group tabs</strong> at the top to focus
              on one bucket at a time, or "All" to see everything.
            </li>
            <li>
              Each card shows the student's name + grade, your note,
              any follow-up, and when you last touched base.
            </li>
            <li>
              The <strong>quick-action buttons</strong> on every card —
              "Touched base", "Called home", "Pulled aside" — log a
              touch instantly and timestamp it. Use these instead of
              editing the note when you're just recording an
              interaction.
            </li>
            <li>
              Click <strong>Edit</strong> on a card to update the note,
              change the group, or set / clear a follow-up.
            </li>
            <li>
              Cards you haven't touched in <strong>14 days</strong>
              show a small nudge so nothing slips through. The student
              isn't removed automatically — that's still your call.
            </li>
            <li>
              Click the student's name to open their full Student
              Profile, then Back to return here.
            </li>
            <li>
              Done with a student? Click <strong>Remove</strong> on the
              card. (It's a hard delete — re-add them later if you
              change your mind.)
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="Privacy">
          Entries on this list are private to you. Other staff —
          including admins — don't see what you've added, what notes
          you've written, or what touches you've logged. If a student
          you've bookmarked moves out of your visibility scope (loses
          you as their teacher / trusted adult), they stop showing on
          your list automatically.
        </HowToSection>
      </HowToUseHelp>

      {/* Group tabs */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.4rem",
          marginBottom: "0.75rem",
          paddingBottom: "0.75rem",
          borderBottom: "1px solid #e5e7eb",
        }}
        aria-label="Group filter"
      >
        <button
          type="button"
          onClick={() => setActiveGroup("all")}
          style={{
            padding: "0.3rem 0.7rem",
            background: activeGroup === "all" ? "#0d9488" : "#f3f4f6",
            color: activeGroup === "all" ? "white" : "#374151",
            border: `1px solid ${
              activeGroup === "all" ? "#0d9488" : "#d1d5db"
            }`,
            borderRadius: 999,
            fontSize: "0.78rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          All ({groupCounts.all})
        </button>
        {GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => setActiveGroup(g.key)}
            style={{
              padding: "0.3rem 0.7rem",
              background: activeGroup === g.key ? g.fg : g.bg,
              color: activeGroup === g.key ? "white" : g.fg,
              border: `1px solid ${activeGroup === g.key ? g.fg : g.border}`,
              borderRadius: 999,
              fontSize: "0.78rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <span aria-hidden="true" style={{ marginRight: 4 }}>
              {g.emoji}
            </span>
            {g.label} ({groupCounts[g.key] ?? 0})
          </button>
        ))}
      </div>

      {error && (
        <div
          style={{
            background: "#fee2e2",
            color: "#991b1b",
            padding: "0.5rem",
            borderRadius: 6,
            marginBottom: "0.5rem",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      ) : entries.length === 0 ? (
        <div
          style={{
            background: "#f9fafb",
            border: "1px dashed #d1d5db",
            borderRadius: 8,
            padding: "1.25rem",
            textAlign: "center",
            color: "#6b7280",
          }}
        >
          <div
            style={{
              fontSize: "1.25rem",
              marginBottom: "0.4rem",
            }}
            aria-hidden="true"
          >
            📝
          </div>
          <div style={{ fontWeight: 600, color: "#374151" }}>
            Your watch list is empty
          </div>
          <p style={{ margin: "0.4rem 0 0.75rem", fontSize: "0.85rem" }}>
            Add a student you want to keep extra eyes on. Notes are
            private to you and don't show up on the official watch list.
          </p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            style={{
              background: "#0d9488",
              color: "white",
              border: "1px solid #0d9488",
              borderRadius: 6,
              padding: "0.4rem 0.9rem",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            + Add your first student
          </button>
        </div>
      ) : visibleEntries.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          No students in this group yet.
        </p>
      ) : (
        grouped.map(({ group, entries: groupEntries }) => (
          <div key={group.key} style={{ marginBottom: "1rem" }}>
            {/* Group header — only visible in "All" view */}
            {activeGroup === "all" && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  margin: "0.25rem 0 0.5rem",
                  paddingBottom: 4,
                  borderBottom: `1px dashed ${group.border}`,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ fontSize: "1.1rem" }}
                >
                  {group.emoji}
                </span>
                <span
                  style={{
                    fontWeight: 600,
                    color: group.fg,
                    fontSize: "0.9rem",
                  }}
                >
                  {group.label}
                </span>
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "#6b7280",
                  }}
                >
                  {groupEntries.length} student
                  {groupEntries.length === 1 ? "" : "s"}
                </span>
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(320px, 1fr))",
                gap: "0.75rem",
              }}
            >
              {groupEntries.map((e) => (
                <NoteCard
                  key={e.id}
                  entry={e}
                  group={group}
                  onOpen={() => onOpenStudent(e.studentId)}
                  onTouch={(what) => handleQuickTouch(e, what)}
                  onEdit={() => setEditEntry(e)}
                  onRemove={() => handleRemove(e)}
                />
              ))}
            </div>
          </div>
        ))
      )}

      {addOpen && (
        <EntryModal
          mode="add"
          studentDirectory={studentDirectory}
          staffDirectory={staffDirectory}
          allowTargetPicker={isCore}
          currentUserId={currentUser?.id ?? null}
          onClose={() => setAddOpen(false)}
          onSaved={async () => {
            setAddOpen(false);
            await reload();
          }}
        />
      )}
      {editEntry && (
        <EntryModal
          mode="edit"
          entry={editEntry}
          studentDirectory={studentDirectory}
          staffDirectory={staffDirectory}
          allowTargetPicker={false}
          currentUserId={currentUser?.id ?? null}
          onClose={() => setEditEntry(null)}
          onSaved={async () => {
            setEditEntry(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ---- NoteCard ---------------------------------------------------------

function NoteCard({
  entry,
  group,
  onOpen,
  onTouch,
  onEdit,
  onRemove,
}: {
  entry: Entry;
  group: ReturnType<typeof groupDef>;
  onOpen: () => void;
  onTouch: (what: string) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const lastTouchAgo = timeAgo(entry.lastTouchAt);
  const staleTouch =
    entry.lastTouchAt &&
    Date.now() - new Date(entry.lastTouchAt).getTime() >
      14 * 24 * 60 * 60 * 1000;
  const noTouch = !entry.lastTouchAt;

  return (
    <div
      style={{
        background: group.noteBg,
        border: `1px solid ${group.border}`,
        borderRadius: 10,
        padding: "0.7rem 0.8rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      }}
    >
      {/* Header row: name (clickable), grade, group emoji */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: "1.05rem" }}>
          {group.emoji}
        </span>
        <button
          type="button"
          onClick={onOpen}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            fontSize: "0.95rem",
            fontWeight: 600,
            color: "#111827",
            textAlign: "left",
            textDecoration: "underline",
            textDecorationColor: "rgba(0,0,0,0.15)",
            textUnderlineOffset: 3,
          }}
          aria-label={`Open profile for ${entry.firstName} ${entry.lastName}`}
        >
          {entry.firstName} {entry.lastName}
        </button>
        <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
          Grade {entry.grade}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${entry.firstName} ${entry.lastName} from list`}
          title="Remove from list"
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            color: "#9ca3af",
            cursor: "pointer",
            fontSize: "1rem",
            padding: "0 4px",
          }}
        >
          ✕
        </button>
      </div>

      {/* "Added by X" badge — only present when a core-team member
          seeded the entry on this teacher's behalf. Self-added entries
          omit this row entirely so the card stays uncluttered. */}
      {entry.addedBy && (
        <div
          style={{
            display: "inline-flex",
            alignSelf: "flex-start",
            alignItems: "center",
            gap: 4,
            padding: "0.15rem 0.45rem",
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            borderRadius: 999,
            fontSize: "0.7rem",
            color: "#92400e",
            fontWeight: 600,
          }}
          title={`Added by ${entry.addedBy.displayName}`}
        >
          <span aria-hidden="true">＋</span>
          Added by {entry.addedBy.displayName}
        </div>
      )}

      {/* The sticky-note "Why I'm watching" body. The label header
          mirrors the original mockup so cards read as "here's why this
          kid is on my list" at a glance, instead of just an unlabeled
          paragraph. */}
      {entry.note ? (
        <div>
          <div
            style={{
              fontSize: "0.65rem",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "#92400e",
              marginBottom: "0.25rem",
            }}
          >
            Why I'm watching
          </div>
          <div
            style={{
              fontSize: "0.85rem",
              color: "#374151",
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {entry.note}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onEdit}
          style={{
            background: "transparent",
            border: "none",
            color: "#9ca3af",
            cursor: "pointer",
            fontSize: "0.8rem",
            fontStyle: "italic",
            textAlign: "left",
            padding: 0,
          }}
        >
          + Add a note about why you're watching…
        </button>
      )}

      {/* Follow-up nudge */}
      {entry.followupText && (
        <div
          style={{
            background: "white",
            border: `1px dashed ${group.border}`,
            borderRadius: 6,
            padding: "0.35rem 0.5rem",
            fontSize: "0.78rem",
            color: "#374151",
          }}
        >
          <span style={{ fontWeight: 600, color: group.fg }}>
            Follow-up:
          </span>{" "}
          {entry.followupText}
          {entry.followupDue && (
            <span style={{ color: "#6b7280" }}>
              {" "}
              · by {entry.followupDue}
            </span>
          )}
        </div>
      )}

      {/* Last touch / nudge */}
      <div
        style={{
          fontSize: "0.75rem",
          color: noTouch || staleTouch ? "#92400e" : "#4b5563",
          background: noTouch || staleTouch ? "#fffbeb" : "transparent",
          border:
            noTouch || staleTouch ? "1px solid #fde68a" : "1px solid transparent",
          borderRadius: 6,
          padding: noTouch || staleTouch ? "0.3rem 0.5rem" : "0",
        }}
      >
        {entry.lastTouchAt ? (
          <>
            <span style={{ fontWeight: 600 }}>
              {entry.lastTouchWhat ?? "Touch"}
            </span>{" "}
            · {lastTouchAgo}
            {entry.lastTouchBy && (
              <span style={{ color: "#9ca3af" }}>
                {" "}
                · by {entry.lastTouchBy}
              </span>
            )}
            {staleTouch && (
              <span style={{ marginLeft: 6, fontWeight: 600 }}>
                — touch base soon?
              </span>
            )}
          </>
        ) : (
          <>No touch logged yet — consider a quick check-in.</>
        )}
      </div>

      {/* Quick action buttons */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.what}
            type="button"
            onClick={() => onTouch(a.what)}
            title={`Log: ${a.what}`}
            style={{
              padding: "0.2rem 0.5rem",
              background: "white",
              border: `1px solid ${group.border}`,
              borderRadius: 999,
              fontSize: "0.72rem",
              fontWeight: 600,
              color: group.fg,
              cursor: "pointer",
            }}
          >
            <span aria-hidden="true" style={{ marginRight: 3 }}>
              {a.emoji}
            </span>
            {a.what}
          </button>
        ))}
        <button
          type="button"
          onClick={onEdit}
          style={{
            padding: "0.2rem 0.5rem",
            background: "transparent",
            border: "1px dashed #9ca3af",
            borderRadius: 999,
            fontSize: "0.72rem",
            fontWeight: 600,
            color: "#374151",
            cursor: "pointer",
            marginLeft: "auto",
          }}
        >
          ✎ Edit
        </button>
      </div>
    </div>
  );
}

// ---- Add / Edit modal ------------------------------------------------

function EntryModal({
  mode,
  entry,
  studentDirectory,
  staffDirectory,
  allowTargetPicker,
  currentUserId,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  entry?: Entry;
  studentDirectory: StudentLookup[];
  staffDirectory: StaffLookup[];
  // True only when caller is core team AND mode === "add". Edit mode
  // never re-targets — that would silently move a row off the wrong
  // teacher's list.
  allowTargetPicker: boolean;
  currentUserId: number | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [studentId, setStudentId] = useState(entry?.studentId ?? "");
  const [studentLabel, setStudentLabel] = useState(
    entry ? `${entry.lastName}, ${entry.firstName} (Grade ${entry.grade})` : "",
  );
  const [studentQuery, setStudentQuery] = useState("");
  const [studentDropdownOpen, setStudentDropdownOpen] = useState(false);
  const [groupKey, setGroupKey] = useState(entry?.groupKey ?? GROUPS[0].key);
  const [note, setNote] = useState(entry?.note ?? "");
  const [followupText, setFollowupText] = useState(entry?.followupText ?? "");
  const [followupDue, setFollowupDue] = useState(entry?.followupDue ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  // Target staff for the new entry. "" = self (the caller's own list).
  // Only meaningful in add mode when allowTargetPicker is true.
  const [targetStaffId, setTargetStaffId] = useState<string>("");
  const studentBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!studentDropdownOpen) return;
    function onDoc(e: MouseEvent) {
      if (
        studentBoxRef.current &&
        !studentBoxRef.current.contains(e.target as Node)
      ) {
        setStudentDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [studentDropdownOpen]);

  const matches = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return studentDirectory.slice(0, 12);
    return studentDirectory
      .filter((s) => {
        const name = `${s.firstName} ${s.lastName}`.toLowerCase();
        return (
          name.includes(q) || (s.studentId ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, 12);
  }, [studentQuery, studentDirectory]);

  async function handleSave() {
    setSaving(true);
    setErr("");
    try {
      if (mode === "add") {
        if (!studentId) {
          setErr("Pick a student first.");
          setSaving(false);
          return;
        }
        const r = await authFetch("/api/insights/my-watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId,
            groupKey,
            note,
            followupText: followupText.trim() || null,
            followupDue: followupDue || null,
            // Only include when the picker selected a non-default
            // value. Empty string = "my list" = omit so the server's
            // default (caller's id) takes over without ambiguity.
            ...(allowTargetPicker && targetStaffId
              ? { targetStaffId: Number(targetStaffId) }
              : {}),
          }),
        });
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error ?? `HTTP ${r.status}`);
        }
      } else if (entry) {
        const r = await authFetch(
          `/api/insights/my-watchlist/${entry.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              groupKey,
              note,
              followupText: followupText.trim() || null,
              followupDue: followupDue || null,
            }),
          },
        );
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error ?? `HTTP ${r.status}`);
        }
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === "add" ? "Add a student to your watch list" : "Edit watch list entry"}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17,24,39,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 12,
          padding: "1rem 1.1rem",
          maxWidth: 460,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>
          {mode === "add" ? "Add a student" : "Edit watch entry"}
        </h3>

        {/* "Add to whose watch list?" picker — core team only, add
            mode only. Defaults to "" (= self / the caller's own list).
            Plain teachers never see this and just add to themselves
            implicitly. */}
        {mode === "add" && allowTargetPicker && staffDirectory.length > 0 && (
          <div style={{ marginBottom: "0.75rem" }}>
            <label
              htmlFor="mywatchlist-target-staff"
              style={{
                display: "block",
                fontSize: "0.78rem",
                fontWeight: 600,
                marginBottom: 4,
                color: "#374151",
              }}
            >
              Add to whose watch list?
            </label>
            <select
              id="mywatchlist-target-staff"
              value={targetStaffId}
              onChange={(e) => setTargetStaffId(e.target.value)}
              style={{
                width: "100%",
                padding: "0.4rem 0.5rem",
                border: "1px solid #d1d5db",
                borderRadius: 6,
                fontSize: "0.9rem",
                background: "white",
              }}
            >
              <option value="">My list (default)</option>
              {staffDirectory
                .filter((s) => s.id !== currentUserId)
                .map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.displayName}
                  </option>
                ))}
            </select>
            {targetStaffId && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: "0.72rem",
                  color: "#92400e",
                  fontStyle: "italic",
                }}
              >
                This will appear on their My Watch List with an
                "Added by you" badge. They can edit or remove it
                themselves.
              </div>
            )}
          </div>
        )}

        {mode === "add" ? (
          <div ref={studentBoxRef} style={{ position: "relative", marginBottom: "0.75rem" }}>
            <label
              htmlFor="mywatchlist-student"
              style={{
                display: "block",
                fontSize: "0.78rem",
                fontWeight: 600,
                marginBottom: 4,
                color: "#374151",
              }}
            >
              Student
            </label>
            {studentId ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.4rem 0.6rem",
                  background: "#f0fdfa",
                  border: "1px solid #99f6e4",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                  color: "#065f46",
                }}
              >
                <span style={{ fontWeight: 600 }}>{studentLabel}</span>
                <button
                  type="button"
                  onClick={() => {
                    setStudentId("");
                    setStudentLabel("");
                    setStudentQuery("");
                  }}
                  style={{
                    marginLeft: "auto",
                    background: "transparent",
                    border: "none",
                    color: "#0d9488",
                    cursor: "pointer",
                    fontSize: "0.78rem",
                    fontWeight: 600,
                  }}
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  id="mywatchlist-student"
                  type="text"
                  value={studentQuery}
                  onChange={(e) => {
                    setStudentQuery(e.target.value);
                    setStudentDropdownOpen(true);
                  }}
                  onFocus={() => setStudentDropdownOpen(true)}
                  placeholder="Search by name or ID…"
                  aria-label="Search students by name or ID"
                  style={{
                    width: "100%",
                    padding: "0.4rem 0.55rem",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    fontSize: "0.9rem",
                  }}
                />
                {studentDropdownOpen && matches.length > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      background: "white",
                      border: "1px solid #d1d5db",
                      borderRadius: 6,
                      marginTop: 2,
                      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                      maxHeight: 220,
                      overflowY: "auto",
                      zIndex: 30,
                    }}
                  >
                    {matches.map((s) => (
                      <button
                        key={s.studentId}
                        type="button"
                        onClick={() => {
                          setStudentId(s.studentId);
                          setStudentLabel(
                            `${s.lastName}, ${s.firstName}${
                              s.grade !== null && s.grade !== undefined && s.grade !== ""
                                ? ` (Grade ${s.grade})`
                                : ""
                            }`,
                          );
                          setStudentQuery("");
                          setStudentDropdownOpen(false);
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "0.4rem 0.6rem",
                          background: "white",
                          border: "none",
                          borderBottom: "1px solid #f3f4f6",
                          cursor: "pointer",
                          fontSize: "0.85rem",
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        <div style={{ fontWeight: 600 }}>
                          {s.lastName}, {s.firstName}
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>
                          {s.studentId}
                          {s.grade !== null && s.grade !== undefined && s.grade !== ""
                            ? ` · Grade ${s.grade}`
                            : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div
            style={{
              marginBottom: "0.75rem",
              padding: "0.4rem 0.6rem",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              fontSize: "0.85rem",
              color: "#374151",
            }}
          >
            <strong>{studentLabel}</strong>
          </div>
        )}

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            htmlFor="mywatchlist-group"
            style={{
              display: "block",
              fontSize: "0.78rem",
              fontWeight: 600,
              marginBottom: 4,
              color: "#374151",
            }}
          >
            Group
          </label>
          <select
            id="mywatchlist-group"
            value={groupKey}
            onChange={(e) => setGroupKey(e.target.value)}
            style={{
              width: "100%",
              padding: "0.4rem 0.55rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.9rem",
              background: "white",
            }}
          >
            {GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.emoji} {g.label}
              </option>
            ))}
          </select>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.72rem",
              color: "#6b7280",
            }}
          >
            {groupDef(groupKey).hint}
          </p>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            htmlFor="mywatchlist-note"
            style={{
              display: "block",
              fontSize: "0.78rem",
              fontWeight: 600,
              marginBottom: 4,
              color: "#374151",
            }}
          >
            Why you're watching
          </label>
          <textarea
            id="mywatchlist-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g., Mom's working nights — Tomás has been sleepy in 1st period."
            style={{
              width: "100%",
              padding: "0.4rem 0.55rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.85rem",
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label
            htmlFor="mywatchlist-followup"
            style={{
              display: "block",
              fontSize: "0.78rem",
              fontWeight: 600,
              marginBottom: 4,
              color: "#374151",
            }}
          >
            Follow-up reminder (optional)
          </label>
          <input
            id="mywatchlist-followup"
            type="text"
            value={followupText}
            onChange={(e) => setFollowupText(e.target.value)}
            placeholder="e.g., Call home Friday"
            style={{
              width: "100%",
              padding: "0.4rem 0.55rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.85rem",
              marginBottom: 4,
            }}
          />
          <input
            id="mywatchlist-followup-due"
            type="date"
            value={followupDue}
            onChange={(e) => setFollowupDue(e.target.value)}
            aria-label="Follow-up due date"
            style={{
              padding: "0.3rem 0.4rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          />
        </div>

        {err && (
          <div
            style={{
              background: "#fee2e2",
              color: "#991b1b",
              padding: "0.4rem 0.6rem",
              borderRadius: 6,
              marginBottom: "0.5rem",
              fontSize: "0.8rem",
            }}
          >
            {err}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "0.45rem 0.8rem",
              background: "white",
              color: "#374151",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              cursor: saving ? "default" : "pointer",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || (mode === "add" && !studentId)}
            style={{
              padding: "0.45rem 0.9rem",
              background:
                saving || (mode === "add" && !studentId)
                  ? "#9ca3af"
                  : "#0d9488",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor:
                saving || (mode === "add" && !studentId)
                  ? "default"
                  : "pointer",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            {saving ? "Saving…" : mode === "add" ? "Add to list" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
