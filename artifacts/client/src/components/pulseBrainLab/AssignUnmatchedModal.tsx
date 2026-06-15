import { useEffect, useState } from "react";
import type {
  PulseBrainLabGroup,
  PulseBrainLabSession,
  PulseBrainLabSessionDetail,
} from "@workspace/api-client-react";
import { fetchGroups, fetchSessions, fetchSession } from "./data";
import {
  ModalShell,
  labelStyle,
  inputStyle,
  modalActionsStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from "./GroupsTab";

// Pick group → session → student to resolve the (sessionId, studentId) an
// unmatched scan needs. Students come from the chosen session's attendance.
export default function AssignUnmatchedModal({
  onClose,
  onAssign,
}: {
  onClose: () => void;
  onAssign: (sessionId: number, studentId: string) => Promise<void>;
}) {
  const [groups, setGroups] = useState<PulseBrainLabGroup[]>([]);
  const [groupId, setGroupId] = useState<number | "">("");
  const [sessions, setSessions] = useState<PulseBrainLabSession[]>([]);
  const [sessionId, setSessionId] = useState<number | "">("");
  const [detail, setDetail] = useState<PulseBrainLabSessionDetail | null>(null);
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGroups()
      .then(setGroups)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  useEffect(() => {
    setSessions([]);
    setSessionId("");
    setDetail(null);
    setStudentId("");
    if (groupId === "") return;
    fetchSessions(groupId)
      .then(setSessions)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  }, [groupId]);

  useEffect(() => {
    setDetail(null);
    setStudentId("");
    if (sessionId === "") return;
    fetchSession(sessionId)
      .then(setDetail)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  }, [sessionId]);

  const submit = async () => {
    if (sessionId === "" || !studentId) {
      setError("Pick a session and a student.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAssign(sessionId, studentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Assign scan" onClose={onClose}>
      <label style={labelStyle}>Group</label>
      <select
        value={groupId}
        onChange={(e) =>
          setGroupId(e.target.value === "" ? "" : Number(e.target.value))
        }
        style={inputStyle}
      >
        <option value="">Select a group…</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name} (Grades {g.gradeBand})
          </option>
        ))}
      </select>

      <label style={labelStyle}>Session</label>
      <select
        value={sessionId}
        onChange={(e) =>
          setSessionId(e.target.value === "" ? "" : Number(e.target.value))
        }
        disabled={groupId === ""}
        style={inputStyle}
      >
        <option value="">Select a session…</option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.sessionDate} — {s.lessonTitle}
          </option>
        ))}
      </select>

      <label style={labelStyle}>Student</label>
      <select
        value={studentId}
        onChange={(e) => setStudentId(e.target.value)}
        disabled={!detail}
        style={inputStyle}
      >
        <option value="">Select a student…</option>
        {detail?.attendance.map((a) => (
          <option key={a.studentId} value={a.studentId}>
            {a.lastName}, {a.firstName} ({a.localSisId ?? "—"})
          </option>
        ))}
      </select>

      {error && (
        <div style={{ color: "#b91c1c", marginTop: "0.6rem" }}>{error}</div>
      )}

      <div style={modalActionsStyle}>
        <button type="button" onClick={onClose} style={secondaryBtnStyle}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{ ...primaryBtnStyle, opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Filing…" : "File to student"}
        </button>
      </div>
    </ModalShell>
  );
}
