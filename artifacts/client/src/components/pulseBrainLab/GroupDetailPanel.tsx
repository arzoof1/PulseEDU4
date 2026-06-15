import { useEffect, useState } from "react";
import type {
  PulseBrainLabGroupDetail,
  PulseBrainLabSession,
} from "@workspace/api-client-react";
import {
  fetchGroup,
  deleteGroup,
  addMembers,
  removeMember,
  fetchSessions,
  type StudentHit,
} from "./data";
import StudentSearchInput from "./StudentSearchInput";
import SessionDetailModal from "./SessionDetailModal";
import CreateSessionModal from "./CreateSessionModal";
import {
  ModalShell,
  primaryBtnStyle,
  removeBtnStyle,
} from "./GroupsTab";

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function GroupDetailPanel({
  groupId,
  onClose,
}: {
  groupId: number;
  onClose: () => void;
}) {
  const [group, setGroup] = useState<PulseBrainLabGroupDetail | null>(null);
  const [sessions, setSessions] = useState<PulseBrainLabSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [openSessionId, setOpenSessionId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    setLoading(true);
    Promise.all([fetchGroup(groupId), fetchSessions(groupId)])
      .then(([g, s]) => {
        setGroup(g);
        setSessions(s);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  };

  useEffect(reload, [groupId]);

  const onAddMember = async (hit: StudentHit) => {
    setBusy(true);
    try {
      const updated = await addMembers(groupId, [hit.studentId]);
      setGroup(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemoveMember = async (studentId: string) => {
    setBusy(true);
    try {
      const updated = await removeMember(groupId, studentId);
      setGroup(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteGroup = async () => {
    if (!group) return;
    if (sessions.length > 0) {
      setError(
        "Delete the group's sessions before removing the group.",
      );
      return;
    }
    setBusy(true);
    try {
      await deleteGroup(groupId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={group ? group.name : "Group"}
      onClose={onClose}
      onDelete={group ? onDeleteGroup : undefined}
    >
      {loading && <div style={{ color: "#64748b" }}>Loading…</div>}
      {error && (
        <div style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>{error}</div>
      )}

      {group && (
        <>
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            Grades {group.gradeBand} · {group.schoolYear}
          </div>

          <SectionLabel>Members ({group.members.length})</SectionLabel>
          <StudentSearchInput
            excludeIds={new Set(group.members.map((m) => m.studentId))}
            onPick={onAddMember}
            placeholder="Add a student…"
          />
          <div
            style={{ marginTop: "0.6rem", display: "grid", gap: "0.3rem" }}
          >
            {group.members.length === 0 && (
              <div style={{ color: "#94a3b8", fontSize: "0.88rem" }}>
                No members yet.
              </div>
            )}
            {group.members.map((m) => (
              <div
                key={m.studentId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  padding: "0.35rem 0.6rem",
                  fontSize: "0.88rem",
                }}
              >
                <span>
                  {m.lastName}, {m.firstName}{" "}
                  <span style={{ color: "#94a3b8" }}>
                    ({m.localSisId ?? "—"})
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemoveMember(m.studentId)}
                  style={removeBtnStyle}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "1.5rem",
            }}
          >
            <SectionLabel noMargin>Sessions ({sessions.length})</SectionLabel>
            <button
              type="button"
              onClick={() => setCreatingSession(true)}
              disabled={group.members.length === 0}
              title={
                group.members.length === 0
                  ? "Add members before scheduling a session"
                  : undefined
              }
              style={{
                ...primaryBtnStyle,
                padding: "0.4rem 0.75rem",
                fontSize: "0.85rem",
                opacity: group.members.length === 0 ? 0.5 : 1,
              }}
            >
              + Assign lesson
            </button>
          </div>
          <div
            style={{ marginTop: "0.6rem", display: "grid", gap: "0.4rem" }}
          >
            {sessions.length === 0 && (
              <div style={{ color: "#94a3b8", fontSize: "0.88rem" }}>
                No sessions scheduled.
              </div>
            )}
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setOpenSessionId(s.id)}
                style={{
                  textAlign: "left",
                  background: "white",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "0.6rem 0.8rem",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontWeight: 600, color: "#0f172a" }}>
                  {s.lessonTitle}
                </span>
                <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
                  {s.sessionDate}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {creatingSession && group && (
        <CreateSessionModal
          groupId={groupId}
          gradeBand={group.gradeBand}
          defaultDate={todayLocal()}
          onClose={() => setCreatingSession(false)}
          onCreated={(session) => {
            setCreatingSession(false);
            reload();
            setOpenSessionId(session.id);
          }}
        />
      )}

      {openSessionId !== null && (
        <SessionDetailModal
          sessionId={openSessionId}
          onClose={() => {
            setOpenSessionId(null);
            reload();
          }}
        />
      )}
    </ModalShell>
  );
}

function SectionLabel({
  children,
  noMargin,
}: {
  children: React.ReactNode;
  noMargin?: boolean;
}) {
  return (
    <h3
      style={{
        margin: noMargin ? 0 : "1.5rem 0 0.5rem",
        fontSize: "0.95rem",
        color: "#0f172a",
      }}
    >
      {children}
    </h3>
  );
}
