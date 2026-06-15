import { useEffect, useState } from "react";
import type {
  PulseBrainLabSessionDetail,
  PulseBrainLabAttendanceStatus,
  PulseBrainLabWorkSample,
} from "@workspace/api-client-react";
import {
  fetchSession,
  setAttendance,
  deleteSession,
  downloadPdf,
  worksheetsPdfUrl,
  worksheetReprintUrl,
  fetchWorkSamples,
  deleteWorkSample,
  setWorkSampleShare,
} from "./data";
import {
  ModalShell,
  primaryBtnStyle,
  secondaryBtnStyle,
} from "./GroupsTab";

const STATUSES: { key: PulseBrainLabAttendanceStatus; label: string }[] = [
  { key: "present", label: "Present" },
  { key: "absent", label: "Absent" },
  { key: "excused", label: "Excused" },
];

const STATUS_COLOR: Record<string, string> = {
  present: "#15803d",
  absent: "#b91c1c",
  excused: "#b45309",
};

export default function SessionDetailModal({
  sessionId,
  onClose,
}: {
  sessionId: number;
  onClose: () => void;
}) {
  const [session, setSession] = useState<PulseBrainLabSessionDetail | null>(
    null,
  );
  const [statuses, setStatuses] = useState<
    Record<string, PulseBrainLabAttendanceStatus>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [lang, setLang] = useState<"en" | "es">("en");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [samples, setSamples] = useState<PulseBrainLabWorkSample[]>([]);

  const reloadSamples = () => {
    fetchWorkSamples(sessionId)
      .then(setSamples)
      .catch(() => {
        /* non-fatal: attendance still usable without samples */
      });
  };

  useEffect(() => {
    fetchSession(sessionId)
      .then((s) => {
        setSession(s);
        const map: Record<string, PulseBrainLabAttendanceStatus> = {};
        for (const a of s.attendance) map[a.studentId] = a.status;
        setStatuses(map);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
    reloadSamples();
  }, [sessionId]);

  const saveAttendance = async () => {
    if (!session) return;
    setSaving(true);
    setError(null);
    try {
      const entries = session.attendance.map((a) => ({
        studentId: a.studentId,
        status: statuses[a.studentId] ?? a.status,
      }));
      const updated = await setAttendance(sessionId, entries);
      setSession(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDeleteSession = async () => {
    setSaving(true);
    try {
      await deleteSession(sessionId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const printAll = async () => {
    setPdfBusy(true);
    setError(null);
    try {
      await downloadPdf(
        worksheetsPdfUrl(sessionId, lang),
        `worksheets-${sessionId}-${lang}.pdf`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfBusy(false);
    }
  };

  const reprintOne = async (studentId: string) => {
    setError(null);
    try {
      await downloadPdf(
        worksheetReprintUrl(sessionId, studentId, lang),
        `worksheet-${sessionId}-${lang}.pdf`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ModalShell
      title={session ? session.lessonTitle : "Session"}
      onClose={onClose}
      onDelete={session ? onDeleteSession : undefined}
    >
      {loading && <div style={{ color: "#64748b" }}>Loading…</div>}
      {error && (
        <div style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>{error}</div>
      )}

      {session && (
        <>
          <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
            {session.sessionDate}
            {session.notes ? ` · ${session.notes}` : ""}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              margin: "1.25rem 0 0.6rem",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "0.95rem" }}>
              Attendance ({session.attendance.length})
            </h3>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <LangToggle lang={lang} setLang={setLang} />
              <button
                type="button"
                onClick={printAll}
                disabled={pdfBusy || session.attendance.length === 0}
                style={{
                  ...secondaryBtnStyle,
                  padding: "0.35rem 0.7rem",
                  fontSize: "0.82rem",
                }}
              >
                {pdfBusy ? "Preparing…" : "Print worksheets"}
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gap: "0.4rem" }}>
            {session.attendance.map((a) => (
              <div
                key={a.studentId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "0.45rem 0.6rem",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <span style={{ fontSize: "0.9rem" }}>
                  {a.lastName}, {a.firstName}{" "}
                  <span style={{ color: "#94a3b8" }}>
                    ({a.localSisId ?? "—"})
                  </span>
                </span>
                <span style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                  {STATUSES.map((s) => {
                    const active =
                      (statuses[a.studentId] ?? a.status) === s.key;
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() =>
                          setStatuses((prev) => ({
                            ...prev,
                            [a.studentId]: s.key,
                          }))
                        }
                        style={{
                          border: active
                            ? `1px solid ${STATUS_COLOR[s.key]}`
                            : "1px solid #cbd5e1",
                          background: active ? STATUS_COLOR[s.key] : "white",
                          color: active ? "white" : "#475569",
                          borderRadius: 6,
                          padding: "0.2rem 0.5rem",
                          fontSize: "0.78rem",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => reprintOne(a.studentId)}
                    title="Reprint this student's worksheet"
                    style={{
                      border: "1px solid #cbd5e1",
                      background: "white",
                      color: "#0e7490",
                      borderRadius: 6,
                      padding: "0.2rem 0.5rem",
                      fontSize: "0.78rem",
                      cursor: "pointer",
                    }}
                  >
                    Reprint
                  </button>
                </span>
              </div>
            ))}
            {session.attendance.length === 0 && (
              <div style={{ color: "#94a3b8", fontSize: "0.88rem" }}>
                No students on this session.
              </div>
            )}
          </div>

          <h3 style={{ margin: "1.5rem 0 0.6rem", fontSize: "0.95rem" }}>
            Work samples ({samples.length})
          </h3>
          <div style={{ display: "grid", gap: "0.4rem" }}>
            {samples.length === 0 && (
              <div style={{ color: "#94a3b8", fontSize: "0.88rem" }}>
                No worksheets filed yet. Use the Evidence tab to scan or upload.
              </div>
            )}
            {samples.map((s) => (
              <div
                key={s.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "0.45rem 0.6rem",
                  fontSize: "0.88rem",
                }}
              >
                <span>
                  {s.lastName && s.firstName
                    ? `${s.lastName}, ${s.firstName}`
                    : "Student"}{" "}
                  <span style={{ color: "#94a3b8" }}>
                    ({s.localSisId ?? "—"})
                  </span>
                  <span
                    style={{
                      color: "#94a3b8",
                      marginLeft: "0.4rem",
                      fontSize: "0.78rem",
                    }}
                  >
                    · {s.source}
                  </span>
                </span>
                <span
                  style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}
                >
                  <button
                    type="button"
                    onClick={async () => {
                      setError(null);
                      try {
                        await setWorkSampleShare(s.id, !s.shared);
                        reloadSamples();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    title={
                      s.shared
                        ? "Visible to family on Reinforce at Home"
                        : "Share with family on Reinforce at Home"
                    }
                    style={{
                      border: `1px solid ${s.shared ? "#16a34a" : "#cbd5e1"}`,
                      background: s.shared ? "#dcfce7" : "#fff",
                      color: s.shared ? "#166534" : "#475569",
                      fontSize: "0.78rem",
                      borderRadius: 999,
                      padding: "0.2rem 0.6rem",
                      cursor: "pointer",
                    }}
                  >
                    {s.shared ? "✓ Shared with family" : "Share with family"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setError(null);
                      try {
                        await deleteWorkSample(s.id);
                        reloadSamples();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    style={{
                      border: "none",
                      background: "none",
                      color: "#b91c1c",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                    }}
                  >
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: "0.75rem",
              marginTop: "1.25rem",
            }}
          >
            {savedAt && (
              <span style={{ color: "#15803d", fontSize: "0.85rem" }}>
                Saved
              </span>
            )}
            <button
              type="button"
              onClick={saveAttendance}
              disabled={saving || session.attendance.length === 0}
              style={{ ...primaryBtnStyle, opacity: saving ? 0.7 : 1 }}
            >
              {saving ? "Saving…" : "Save attendance"}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

function LangToggle({
  lang,
  setLang,
}: {
  lang: "en" | "es";
  setLang: (l: "en" | "es") => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.2rem" }}>
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          style={{
            border: lang === l ? "1px solid #0e7490" : "1px solid #cbd5e1",
            background: lang === l ? "#0e7490" : "white",
            color: lang === l ? "white" : "#334155",
            borderRadius: 6,
            padding: "0.2rem 0.5rem",
            fontSize: "0.78rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
