import { useEffect, useMemo, useState } from "react";
import type {
  PulseBrainLabSessionDetail,
  PulseBrainLabAttendanceStatus,
  PulseBrainLabWorkSample,
} from "@workspace/api-client-react";
import {
  fetchSession,
  setAttendance,
  deleteSession,
  publishSession,
  unpublishSession,
  fetchParentCard,
  downloadPdf,
  worksheetsPdfUrl,
  worksheetReprintUrl,
  fetchWorkSamples,
  deleteWorkSample,
  setWorkSampleShare,
  setSessionGrading,
  setWorkSampleGrade,
  fetchBenchmarks,
  fetchSessionHomeResponses,
  studentReportPdfUrl,
  workSampleImageUrl,
  fetchObjectUrl,
  type BenchmarkHit,
  type SessionHomeResponses,
  type HomeResponseRecord,
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

type Lang = "en" | "es";

const T: Record<
  Lang,
  {
    grading: string;
    notGraded: string;
    edit: string;
    done: string;
    gradeType: string;
    modeNone: string;
    modeScore: string;
    modeParticipation: string;
    outOf: string;
    benchmark: string;
    subjectEla: string;
    subjectMath: string;
    searchStandards: string;
    clearBenchmark: string;
    saveGrading: string;
    saving: string;
    grade: string;
    clear: string;
    check: string;
    cross: string;
    sharedNote: string;
    published: string;
    draft: string;
    publishedHint: string;
    draftHint: string;
    publish: string;
    unpublish: string;
    publishing: string;
    familyPreview: string;
    hidePreview: string;
    previewEmpty: string;
    previewLoading: string;
    homeFollowUp: string;
    familiesResponded: string;
    responsesWord: string;
    noResponses: string;
    promptLabel: string;
    printReport: string;
  }
> = {
  en: {
    grading: "Grading",
    notGraded: "Not graded",
    edit: "Edit",
    done: "Done",
    gradeType: "Grade type",
    modeNone: "No grade",
    modeScore: "Score",
    modeParticipation: "Participation (✓ / ✗)",
    outOf: "Out of",
    benchmark: "Florida benchmark (optional)",
    subjectEla: "ELA",
    subjectMath: "Math",
    searchStandards: "Search standards…",
    clearBenchmark: "Clear benchmark",
    saveGrading: "Save grading",
    saving: "Saving…",
    grade: "Grade",
    clear: "Clear",
    check: "✓ Met",
    cross: "✗ Not yet",
    sharedNote: "Grades show to families only on shared samples.",
    published: "Published to families",
    draft: "Draft — staff only",
    publishedHint:
      "Families in this group can see these cards on Reinforce at Home.",
    draftHint: "Not visible to families yet. Preview, then publish when ready.",
    publish: "Publish to families",
    unpublish: "Unpublish",
    publishing: "Working…",
    familyPreview: "Family preview",
    hidePreview: "Hide preview",
    previewEmpty: "No family card to preview for this lesson yet.",
    previewLoading: "Loading preview…",
    homeFollowUp: "Home Follow-Up from families",
    familiesResponded: "families responded",
    responsesWord: "responses",
    noResponses: "No family responses yet.",
    promptLabel: "Answer to",
    printReport: "Print intervention report",
  },
  es: {
    grading: "Calificación",
    notGraded: "Sin calificar",
    edit: "Editar",
    done: "Listo",
    gradeType: "Tipo de calificación",
    modeNone: "Sin calificación",
    modeScore: "Puntaje",
    modeParticipation: "Participación (✓ / ✗)",
    outOf: "Sobre",
    benchmark: "Estándar de Florida (opcional)",
    subjectEla: "Lectura (ELA)",
    subjectMath: "Matemáticas",
    searchStandards: "Buscar estándares…",
    clearBenchmark: "Quitar estándar",
    saveGrading: "Guardar calificación",
    saving: "Guardando…",
    grade: "Calificación",
    clear: "Borrar",
    check: "✓ Logrado",
    cross: "✗ Aún no",
    sharedNote:
      "Las calificaciones se muestran a las familias solo en muestras compartidas.",
    published: "Publicado para las familias",
    draft: "Borrador — solo personal",
    publishedHint:
      "Las familias de este grupo pueden ver estas tarjetas en Refuerzo en Casa.",
    draftHint:
      "Aún no es visible para las familias. Vea la vista previa y publique cuando esté listo.",
    publish: "Publicar para las familias",
    unpublish: "Despublicar",
    publishing: "Procesando…",
    familyPreview: "Vista previa para familias",
    hidePreview: "Ocultar vista previa",
    previewEmpty: "Aún no hay tarjeta para mostrar de esta lección.",
    previewLoading: "Cargando vista previa…",
    homeFollowUp: "Seguimiento en casa de las familias",
    familiesResponded: "familias respondieron",
    responsesWord: "respuestas",
    noResponses: "Aún no hay respuestas de las familias.",
    promptLabel: "Respuesta a",
    printReport: "Imprimir informe de intervención",
  },
};

// Collapse the flat per-(student,prompt) transcript list into ONE family card
// per student, with that family's answers ordered by prompt. Keeps the viewer
// reading as one Home Follow-Up activity instead of N separate rows.
function groupResponsesByStudent(records: HomeResponseRecord[]): {
  studentId: string;
  studentName: string | null;
  localSisId: string | null;
  answers: { promptIndex: number; transcript: string }[];
}[] {
  const byStudent = new Map<
    string,
    {
      studentId: string;
      studentName: string | null;
      localSisId: string | null;
      answers: { promptIndex: number; transcript: string }[];
    }
  >();
  for (const r of records) {
    let fam = byStudent.get(r.studentId);
    if (!fam) {
      fam = {
        studentId: r.studentId,
        studentName: r.studentName,
        localSisId: r.localSisId,
        answers: [],
      };
      byStudent.set(r.studentId, fam);
    }
    fam.answers.push({ promptIndex: r.promptIndex, transcript: r.transcript });
  }
  const out = [...byStudent.values()];
  for (const fam of out)
    fam.answers.sort((a, b) => a.promptIndex - b.promptIndex);
  return out;
}

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
  const [publishing, setPublishing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [responses, setResponses] = useState<SessionHomeResponses | null>(null);
  const [preview, setPreview] = useState<{
    objectUrl: string;
    contentType: string;
    name: string;
  } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const openSamplePreview = async (sampleId: number, name: string) => {
    setError(null);
    setPreviewBusy(true);
    try {
      const { objectUrl, contentType } = await fetchObjectUrl(
        workSampleImageUrl(sampleId),
      );
      setPreview({ objectUrl, contentType, name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const closeSamplePreview = () => {
    if (preview) URL.revokeObjectURL(preview.objectUrl);
    setPreview(null);
  };

  const reloadSamples = () => {
    fetchWorkSamples(sessionId)
      .then(setSamples)
      .catch(() => {
        /* non-fatal: attendance still usable without samples */
      });
  };

  const reloadResponses = () => {
    fetchSessionHomeResponses(sessionId)
      .then(setResponses)
      .catch(() => {
        /* non-fatal: the viewer just stays empty */
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
    reloadResponses();
    // Parents can record Home Follow-Up at any time while this modal is open;
    // poll so new transcripts surface without a manual refresh.
    const id = setInterval(reloadResponses, 15_000);
    return () => clearInterval(id);
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

  const togglePublish = async () => {
    if (!session) return;
    setPublishing(true);
    setError(null);
    try {
      const updated = session.publishedAt
        ? await unpublishSession(sessionId)
        : await publishSession(sessionId);
      setSession(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

  const togglePreview = async () => {
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    setShowPreview(true);
    if (!session) return;
    setPreviewLoading(true);
    try {
      const card = await fetchParentCard(session.lessonKey, lang);
      const parts: string[] = [];
      if (card.summary) parts.push(card.summary);
      if (card.askYourChild.length)
        parts.push("• " + card.askYourChild.join("\n• "));
      if (card.tryTogether) parts.push(card.tryTogether);
      if (card.whyThisWorks) parts.push(card.whyThisWorks);
      setPreviewHtml({
        title: card.lessonTitle,
        body: parts.join("\n\n"),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPreviewHtml(null);
    } finally {
      setPreviewLoading(false);
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
    <>
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

          {(() => {
            const isPub = !!session.publishedAt;
            return (
              <div
                style={{
                  marginTop: "0.85rem",
                  border: `1px solid ${isPub ? "#bbf7d0" : "#fed7aa"}`,
                  background: isPub ? "#f0fdf4" : "#fff7ed",
                  borderRadius: "0.6rem",
                  padding: "0.7rem 0.8rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.6rem",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: "0.9rem",
                        color: isPub ? "#15803d" : "#9a3412",
                      }}
                    >
                      {isPub ? `🟢 ${T[lang].published}` : `🟠 ${T[lang].draft}`}
                    </div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "#475569",
                        marginTop: "0.15rem",
                      }}
                    >
                      {isPub ? T[lang].publishedHint : T[lang].draftHint}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    <button
                      type="button"
                      onClick={togglePreview}
                      style={{
                        ...secondaryBtnStyle,
                        padding: "0.4rem 0.7rem",
                        fontSize: "0.82rem",
                      }}
                    >
                      {showPreview ? T[lang].hidePreview : T[lang].familyPreview}
                    </button>
                    <button
                      type="button"
                      onClick={togglePublish}
                      disabled={publishing}
                      style={{
                        ...(isPub ? secondaryBtnStyle : primaryBtnStyle),
                        padding: "0.4rem 0.8rem",
                        fontSize: "0.82rem",
                      }}
                    >
                      {publishing
                        ? T[lang].publishing
                        : isPub
                          ? T[lang].unpublish
                          : T[lang].publish}
                    </button>
                  </div>
                </div>

                {showPreview && (
                  <div
                    style={{
                      marginTop: "0.7rem",
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      borderRadius: "0.55rem",
                      padding: "0.75rem 0.85rem",
                    }}
                  >
                    {previewLoading ? (
                      <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                        {T[lang].previewLoading}
                      </div>
                    ) : previewHtml ? (
                      <>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: "0.92rem",
                            color: "#0f172a",
                            marginBottom: "0.4rem",
                          }}
                        >
                          {previewHtml.title}
                        </div>
                        <div
                          style={{
                            whiteSpace: "pre-wrap",
                            fontSize: "0.85rem",
                            color: "#334155",
                            lineHeight: 1.5,
                          }}
                        >
                          {previewHtml.body}
                        </div>
                      </>
                    ) : (
                      <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                        {T[lang].previewEmpty}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          <GradingSection
            session={session}
            lang={lang}
            onChange={(updated) => setSession(updated)}
            onError={setError}
          />

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
                    disabled={previewBusy}
                    onClick={() =>
                      openSamplePreview(
                        s.id,
                        s.lastName && s.firstName
                          ? `${s.lastName}, ${s.firstName}`
                          : "Work sample",
                      )
                    }
                    title="Preview the exact image families receive"
                    style={{
                      border: "1px solid #cbd5e1",
                      background: "#fff",
                      color: "#475569",
                      fontSize: "0.78rem",
                      borderRadius: 999,
                      padding: "0.2rem 0.6rem",
                      cursor: "pointer",
                      opacity: previewBusy ? 0.6 : 1,
                    }}
                  >
                    Preview
                  </button>
                  {session.gradeMode && (
                    <SampleGradeControl
                      sample={s}
                      mode={session.gradeMode}
                      maxScore={session.maxScore ?? null}
                      lang={lang}
                      onGraded={(updated) =>
                        setSamples((prev) =>
                          prev.map((x) => (x.id === updated.id ? updated : x)),
                        )
                      }
                      onError={setError}
                    />
                  )}
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
              alignItems: "baseline",
              gap: "0.6rem",
              flexWrap: "wrap",
              margin: "1.5rem 0 0.6rem",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "0.95rem" }}>
              {T[lang].homeFollowUp}
            </h3>
            {responses && (
              <span style={{ color: "#64748b", fontSize: "0.82rem" }}>
                {responses.respondedStudents} / {responses.totalGroupMembers}{" "}
                {T[lang].familiesResponded} · {responses.totalResponses}{" "}
                {T[lang].responsesWord}
              </span>
            )}
          </div>
          <div style={{ display: "grid", gap: "0.4rem" }}>
            {(!responses || responses.records.length === 0) && (
              <div style={{ color: "#94a3b8", fontSize: "0.88rem" }}>
                {T[lang].noResponses}
              </div>
            )}
            {groupResponsesByStudent(responses?.records ?? []).map((fam) => (
              <div
                key={fam.studentId}
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "0.5rem 0.65rem",
                  fontSize: "0.88rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}
                >
                  <span>
                    <strong>{fam.studentName || "Student"}</strong>{" "}
                    <span style={{ color: "#94a3b8" }}>
                      ({fam.localSisId ?? "—"})
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={pdfBusy}
                    onClick={async () => {
                      setError(null);
                      setPdfBusy(true);
                      try {
                        await downloadPdf(
                          studentReportPdfUrl(fam.studentId, lang),
                          `intervention-report-${fam.localSisId ?? "student"}.pdf`,
                        );
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      } finally {
                        setPdfBusy(false);
                      }
                    }}
                    style={{
                      ...secondaryBtnStyle,
                      fontSize: "0.76rem",
                      padding: "0.2rem 0.55rem",
                      opacity: pdfBusy ? 0.6 : 1,
                    }}
                  >
                    {T[lang].printReport}
                  </button>
                </div>
                <div style={{ display: "grid", gap: "0.35rem", marginTop: "0.4rem" }}>
                  {fam.answers.map((a) => (
                    <div key={a.promptIndex}>
                      <div
                        style={{
                          color: "#64748b",
                          fontSize: "0.76rem",
                        }}
                      >
                        {T[lang].promptLabel} #{a.promptIndex + 1}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{a.transcript}</div>
                    </div>
                  ))}
                </div>
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
    {preview && (
      <ModalShell title={preview.name} onClose={closeSamplePreview}>
        {preview.contentType === "application/pdf" ? (
          <iframe
            title={preview.name}
            src={preview.objectUrl}
            style={{
              width: "100%",
              height: "70vh",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
            }}
          />
        ) : preview.contentType.startsWith("image/") ? (
          <img
            alt={preview.name}
            src={preview.objectUrl}
            style={{
              maxWidth: "100%",
              maxHeight: "70vh",
              display: "block",
              margin: "0 auto",
              borderRadius: 8,
            }}
          />
        ) : (
          <div style={{ color: "#64748b" }}>
            This sample can't be previewed in the browser.
          </div>
        )}
      </ModalShell>
    )}
    </>
  );
}

// Per-assignment grading configuration: grade mode, max score, and an optional
// official Florida benchmark tag (subject toggle + searchable picker over the
// global Standards Book). The benchmark label is snapshotted server-side.
function GradingSection({
  session,
  lang,
  onChange,
  onError,
}: {
  session: PulseBrainLabSessionDetail;
  lang: Lang;
  onChange: (updated: PulseBrainLabSessionDetail) => void;
  onError: (msg: string | null) => void;
}) {
  const t = T[lang];
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"score" | "participation" | "none">(
    (session.gradeMode as "score" | "participation" | null) ?? "none",
  );
  const [maxScore, setMaxScore] = useState<string>(
    session.maxScore != null ? String(session.maxScore) : "10",
  );
  const [subject, setSubject] = useState<"ela" | "math">(
    (session.benchmarkSubject as "ela" | "math" | null) ?? "ela",
  );
  const [benchmarkCode, setBenchmarkCode] = useState<string | null>(
    session.benchmarkCode ?? null,
  );
  const [benchmarkLabel, setBenchmarkLabel] = useState<string | null>(
    session.benchmarkLabel ?? null,
  );
  const [search, setSearch] = useState("");
  const [benchmarks, setBenchmarks] = useState<BenchmarkHit[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    fetchBenchmarks(subject)
      .then(setBenchmarks)
      .catch(() => setBenchmarks([]));
  }, [editing, subject]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return benchmarks.slice(0, 30);
    return benchmarks
      .filter(
        (b) =>
          b.code.toLowerCase().includes(q) ||
          b.statement.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [benchmarks, search]);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      const updated = await setSessionGrading(session.id, {
        gradeMode: mode === "none" ? null : mode,
        maxScore: mode === "score" ? Number(maxScore) : null,
        benchmarkCode: mode === "none" ? null : benchmarkCode,
        benchmarkSubject: mode === "none" ? null : benchmarkCode ? subject : null,
      });
      onChange(updated);
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const modeLabel =
    session.gradeMode === "score"
      ? `${t.modeScore} · ${t.outOf} ${session.maxScore ?? "?"}`
      : session.gradeMode === "participation"
        ? t.modeParticipation
        : t.notGraded;

  return (
    <div
      style={{
        marginTop: "0.9rem",
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: "0.7rem 0.8rem",
        background: "#f8fafc",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <div>
          <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "#0f172a" }}>
            {t.grading}
          </div>
          <div style={{ fontSize: "0.82rem", color: "#475569" }}>
            {modeLabel}
            {session.benchmarkCode && (
              <span style={{ color: "#0e7490" }}>
                {" · "}
                {session.benchmarkCode}
              </span>
            )}
          </div>
          {session.benchmarkLabel && (
            <div
              style={{
                fontSize: "0.76rem",
                color: "#64748b",
                marginTop: "0.15rem",
                maxWidth: 420,
              }}
            >
              {session.benchmarkLabel}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          style={{
            ...secondaryBtnStyle,
            padding: "0.3rem 0.6rem",
            fontSize: "0.8rem",
          }}
        >
          {editing ? t.done : t.edit}
        </button>
      </div>

      {editing && (
        <div style={{ marginTop: "0.7rem", display: "grid", gap: "0.6rem" }}>
          <div>
            <div
              style={{
                fontSize: "0.76rem",
                fontWeight: 600,
                color: "#334155",
                marginBottom: "0.3rem",
              }}
            >
              {t.gradeType}
            </div>
            <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
              {(
                [
                  ["none", t.modeNone],
                  ["score", t.modeScore],
                  ["participation", t.modeParticipation],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  style={{
                    border:
                      mode === key
                        ? "1px solid #0e7490"
                        : "1px solid #cbd5e1",
                    background: mode === key ? "#0e7490" : "white",
                    color: mode === key ? "white" : "#334155",
                    borderRadius: 6,
                    padding: "0.25rem 0.55rem",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {mode === "score" && (
            <label
              style={{ fontSize: "0.8rem", color: "#334155", fontWeight: 600 }}
            >
              {t.outOf}{" "}
              <input
                type="number"
                min={1}
                max={1000}
                value={maxScore}
                onChange={(e) => setMaxScore(e.target.value)}
                style={{
                  width: 80,
                  marginLeft: "0.4rem",
                  padding: "0.25rem 0.4rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                }}
              />
            </label>
          )}

          {mode !== "none" && (
            <div>
              <div
                style={{
                  fontSize: "0.76rem",
                  fontWeight: 600,
                  color: "#334155",
                  marginBottom: "0.3rem",
                }}
              >
                {t.benchmark}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "0.3rem",
                  marginBottom: "0.4rem",
                }}
              >
                {(
                  [
                    ["ela", t.subjectEla],
                    ["math", t.subjectMath],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setSubject(key);
                      setBenchmarkCode(null);
                      setBenchmarkLabel(null);
                    }}
                    style={{
                      border:
                        subject === key
                          ? "1px solid #0e7490"
                          : "1px solid #cbd5e1",
                      background: subject === key ? "#e0f2fe" : "white",
                      color: "#0f172a",
                      borderRadius: 6,
                      padding: "0.2rem 0.5rem",
                      fontSize: "0.78rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {benchmarkCode && (
                <div
                  style={{
                    fontSize: "0.78rem",
                    color: "#0e7490",
                    marginBottom: "0.3rem",
                  }}
                >
                  <strong>{benchmarkCode}</strong>
                  {benchmarkLabel ? ` — ${benchmarkLabel}` : ""}
                  <button
                    type="button"
                    onClick={() => {
                      setBenchmarkCode(null);
                      setBenchmarkLabel(null);
                    }}
                    style={{
                      marginLeft: "0.5rem",
                      border: "none",
                      background: "none",
                      color: "#b91c1c",
                      fontSize: "0.76rem",
                      cursor: "pointer",
                    }}
                  >
                    {t.clearBenchmark}
                  </button>
                </div>
              )}
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.searchStandards}
                style={{
                  width: "100%",
                  padding: "0.3rem 0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  fontSize: "0.83rem",
                }}
              />
              <div
                style={{
                  maxHeight: 160,
                  overflowY: "auto",
                  marginTop: "0.3rem",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  background: "white",
                }}
              >
                {filtered.map((b) => (
                  <button
                    key={b.code}
                    type="button"
                    onClick={() => {
                      setBenchmarkCode(b.code);
                      setBenchmarkLabel(b.statement);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      borderBottom: "1px solid #f1f5f9",
                      background:
                        benchmarkCode === b.code ? "#e0f2fe" : "white",
                      padding: "0.35rem 0.5rem",
                      fontSize: "0.78rem",
                      cursor: "pointer",
                    }}
                  >
                    <strong style={{ color: "#0e7490" }}>{b.code}</strong>{" "}
                    <span style={{ color: "#475569" }}>{b.statement}</span>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div
                    style={{
                      padding: "0.5rem",
                      color: "#94a3b8",
                      fontSize: "0.8rem",
                    }}
                  >
                    —
                  </div>
                )}
              </div>
            </div>
          )}

          <div
            style={{
              fontSize: "0.74rem",
              color: "#94a3b8",
            }}
          >
            {t.sharedNote}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              style={{
                ...primaryBtnStyle,
                padding: "0.35rem 0.8rem",
                fontSize: "0.83rem",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? t.saving : t.saveGrading}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Per-work-sample grade entry. In score mode it's a number input (0..max)
// committed on blur/Enter; in participation mode it's a ✓ / ✗ toggle.
function SampleGradeControl({
  sample,
  mode,
  maxScore,
  lang,
  onGraded,
  onError,
}: {
  sample: PulseBrainLabWorkSample;
  mode: string;
  maxScore: number | null;
  lang: Lang;
  onGraded: (updated: PulseBrainLabWorkSample) => void;
  onError: (msg: string | null) => void;
}) {
  const t = T[lang];
  const [val, setVal] = useState<string>(
    sample.score != null ? String(sample.score) : "",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVal(sample.score != null ? String(sample.score) : "");
  }, [sample.score]);

  const commitScore = async () => {
    const trimmed = val.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    if (next === (sample.score ?? null)) return;
    setBusy(true);
    onError(null);
    try {
      const updated = await setWorkSampleGrade(sample.id, {
        score: next,
        participationMark: null,
      });
      onGraded(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setVal(sample.score != null ? String(sample.score) : "");
    } finally {
      setBusy(false);
    }
  };

  const setMark = async (mark: "check" | "x") => {
    const next = sample.participationMark === mark ? null : mark;
    setBusy(true);
    onError(null);
    try {
      const updated = await setWorkSampleGrade(sample.id, {
        score: null,
        participationMark: next,
      });
      onGraded(updated);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "score") {
    return (
      <span
        style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}
        title={t.grade}
      >
        <input
          type="number"
          min={0}
          max={maxScore ?? undefined}
          value={val}
          disabled={busy}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commitScore}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{
            width: 52,
            padding: "0.2rem 0.3rem",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            fontSize: "0.82rem",
            textAlign: "right",
          }}
        />
        <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>
          / {maxScore ?? "?"}
        </span>
      </span>
    );
  }

  // participation
  return (
    <span style={{ display: "flex", gap: "0.2rem" }} title={t.grade}>
      {(
        [
          ["check", t.check, "#16a34a", "#dcfce7", "#166534"],
          ["x", t.cross, "#b91c1c", "#fee2e2", "#991b1b"],
        ] as const
      ).map(([key, label, border, bg, fg]) => {
        const active = sample.participationMark === key;
        return (
          <button
            key={key}
            type="button"
            disabled={busy}
            onClick={() => setMark(key)}
            style={{
              border: `1px solid ${active ? border : "#cbd5e1"}`,
              background: active ? bg : "white",
              color: active ? fg : "#475569",
              borderRadius: 999,
              padding: "0.2rem 0.5rem",
              fontSize: "0.76rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </span>
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
