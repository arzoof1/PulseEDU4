import { useEffect, useMemo, useState } from "react";
import type {
  PulseBrainLabLessonSummary,
  PulseBrainLabSession,
  PulseBrainLabGradeBand,
} from "@workspace/api-client-react";
import { fetchLessons, createSession } from "./data";
import {
  ModalShell,
  labelStyle,
  inputStyle,
  modalActionsStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from "./GroupsTab";

export default function CreateSessionModal({
  groupId,
  gradeBand,
  defaultDate,
  onClose,
  onCreated,
}: {
  groupId: number;
  gradeBand: PulseBrainLabGradeBand;
  defaultDate: string;
  onClose: () => void;
  onCreated: (session: PulseBrainLabSession) => void;
}) {
  const [lessons, setLessons] = useState<PulseBrainLabLessonSummary[]>([]);
  const [lessonKey, setLessonKey] = useState("");
  const [sessionDate, setSessionDate] = useState(defaultDate);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLessons(gradeBand)
      .then((rows) => {
        rows.sort((a, b) => a.week - b.week || a.session - b.session);
        setLessons(rows);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, [gradeBand]);

  const selectedLesson = useMemo(
    () => lessons.find((l) => l.lessonKey === lessonKey) ?? null,
    [lessons, lessonKey],
  );

  const submit = async () => {
    if (!lessonKey) {
      setError("Pick a lesson.");
      return;
    }
    if (!sessionDate) {
      setError("Pick a date.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(groupId, {
        lessonKey,
        sessionDate,
        notes: notes.trim() || undefined,
      });
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Assign a lesson" onClose={onClose}>
      <label style={labelStyle}>Lesson (grades {gradeBand})</label>
      {loading ? (
        <div style={{ color: "#64748b" }}>Loading lessons…</div>
      ) : (
        <select
          value={lessonKey}
          onChange={(e) => setLessonKey(e.target.value)}
          style={inputStyle}
        >
          <option value="">Select a lesson…</option>
          {lessons.map((l) => (
            <option key={l.lessonKey} value={l.lessonKey}>
              Wk {l.week} · S{l.session} — {l.title}
            </option>
          ))}
        </select>
      )}
      {selectedLesson && (
        <div
          style={{
            marginTop: "0.5rem",
            color: "#64748b",
            fontSize: "0.85rem",
          }}
        >
          {selectedLesson.skillArea} · {selectedLesson.brainModelTag}
        </div>
      )}

      <label style={labelStyle}>Session date</label>
      <input
        type="date"
        value={sessionDate}
        onChange={(e) => setSessionDate(e.target.value)}
        style={inputStyle}
      />

      <label style={labelStyle}>Notes (optional)</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        style={{ ...inputStyle, resize: "vertical" }}
      />

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
          {busy ? "Creating…" : "Create session"}
        </button>
      </div>
    </ModalShell>
  );
}
