import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModalShell } from "../pulseBrainLab/GroupsTab";
import {
  fetchTeachers,
  fetchMySections,
  fetchSectionSamples,
  createSample,
  updateSample,
  publishSample,
  unpublishSample,
  deleteSample,
  uploadObject,
  fetchSampleImage,
  type TeacherOption,
  type TeacherSection,
  type SectionStudent,
  type WorkSample,
  type AcademicSubject,
  type AcademicSource,
} from "./data";

// "Partnering with Parents" — staff surface where any active teacher captures a
// student's formative-assessment work sample for one of their OWN class sections
// and shares it with the family on the parent "Learning at Home" surface.
//
// Teachers do NOT build groups: they SELECT students by PERIOD (class section)
// or by STUDENT (a search across their own rosters). Core Team may pick another
// teacher to assist (view / edit / capture / publish on their behalf).
//
// FLEID boundary: studentId (students.student_id) is the join key only — never
// rendered. The visible id is localSisId.

type Lang = "en" | "es";
type Mode = "period" | "student";

const C = {
  ink: "#0f172a",
  sub: "#64748b",
  line: "#e2e8f0",
  brand: "#4f46e5",
  brandSoft: "#eef2ff",
  card: "#ffffff",
  ok: "#047857",
  okSoft: "#ecfdf5",
  warn: "#b45309",
  danger: "#b91c1c",
};

function subjectLabel(s: AcademicSubject, lang: Lang): string {
  if (s === "ela") return lang === "en" ? "Reading / ELA" : "Lectura / ELA";
  if (s === "math") return lang === "en" ? "Math" : "Matemáticas";
  return lang === "en"
    ? "Behavior Intervention"
    : "Intervención de Conducta";
}

export default function PartneringWithParentsHub() {
  const [lang, setLang] = useState<Lang>("en");
  const t = useCallback(
    (en: string, es: string) => (lang === "en" ? en : es),
    [lang],
  );

  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [teacherId, setTeacherId] = useState<number | null>(null);
  const [sections, setSections] = useState<TeacherSection[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const [mode, setMode] = useState<Mode>("period");
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    null,
  );
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(
    null,
  );
  const [studentQuery, setStudentQuery] = useState("");

  // Samples cached per section id. Loaded lazily; refreshed after a mutation.
  const [samplesBySection, setSamplesBySection] = useState<
    Record<number, WorkSample[]>
  >({});

  const [addContext, setAddContext] = useState<{
    section: TeacherSection;
    student: SectionStudent;
  } | null>(null);
  const [previewSampleId, setPreviewSampleId] = useState<number | null>(null);

  // Load the teacher list once (self for a regular teacher; all teaching staff
  // for Core Team). The selector only renders when there's more than one.
  useEffect(() => {
    let alive = true;
    fetchTeachers()
      .then((list) => {
        if (!alive) return;
        setTeachers(list);
        setTeacherId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e) =>
        alive ? setLoadError(e instanceof Error ? e.message : String(e)) : null,
      );
    return () => {
      alive = false;
    };
  }, []);

  // Load the chosen teacher's sections whenever the target changes.
  useEffect(() => {
    if (teacherId == null) return;
    let alive = true;
    setSections(null);
    setLoadError("");
    setSelectedSectionId(null);
    setSelectedStudentId(null);
    setSamplesBySection({});
    fetchMySections(teacherId)
      .then((r) => {
        if (alive) setSections(r.sections);
      })
      .catch((e) =>
        alive ? setLoadError(e instanceof Error ? e.message : String(e)) : null,
      );
    return () => {
      alive = false;
    };
  }, [teacherId]);

  const loadSectionSamples = useCallback(async (sectionId: number) => {
    const list = await fetchSectionSamples(sectionId);
    setSamplesBySection((prev) => ({ ...prev, [sectionId]: list }));
    return list;
  }, []);

  // Lazily load samples for whichever sections are relevant to the current view.
  const relevantSectionIds = useMemo(() => {
    if (!sections) return [];
    if (mode === "period") {
      return selectedSectionId != null ? [selectedSectionId] : [];
    }
    if (selectedStudentId == null) return [];
    return sections
      .filter((s) => s.students.some((st) => st.studentId === selectedStudentId))
      .map((s) => s.id);
  }, [sections, mode, selectedSectionId, selectedStudentId]);

  useEffect(() => {
    for (const id of relevantSectionIds) {
      if (samplesBySection[id] === undefined) {
        void loadSectionSamples(id);
      }
    }
  }, [relevantSectionIds, samplesBySection, loadSectionSamples]);

  // Distinct students across the actor's sections, for the "by student" search.
  const allStudents = useMemo(() => {
    if (!sections) return [];
    const byId = new Map<string, SectionStudent>();
    for (const s of sections) {
      for (const st of s.students) if (!byId.has(st.studentId)) byId.set(st.studentId, st);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sections]);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return allStudents;
    return allStudents.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.localSisId ?? "").toLowerCase().includes(q),
    );
  }, [allStudents, studentQuery]);

  const isCoreAssisting =
    teachers.length > 1 && teacherId != null && teacherId !== teachers[0]?.id;

  function refreshAfterMutation(sectionId: number) {
    void loadSectionSamples(sectionId);
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 0.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", color: C.ink }}>
            {t("Partnering with Parents", "Colaborando con las familias")}
          </h1>
          <p style={{ margin: "0.25rem 0 0", color: C.sub, fontSize: "0.9rem" }}>
            {t(
              "Capture a student's classwork and share it with their family.",
              "Capture el trabajo de un estudiante y compártalo con su familia.",
            )}
          </p>
        </div>
        <LangToggle lang={lang} setLang={setLang} />
      </div>

      {teachers.length > 1 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <label
            style={{ fontSize: "0.8rem", color: C.sub, marginRight: "0.5rem" }}
          >
            {t("Assisting teacher", "Ayudando al docente")}
          </label>
          <select
            value={teacherId ?? ""}
            onChange={(e) => setTeacherId(Number(e.target.value))}
            style={{
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              padding: "0.4rem 0.6rem",
              fontSize: "0.9rem",
              color: C.ink,
            }}
          >
            {teachers.map((tch) => (
              <option key={tch.id} value={tch.id}>
                {tch.displayName}
                {tch.department ? ` · ${tch.department}` : ""}
              </option>
            ))}
          </select>
          {isCoreAssisting && (
            <span
              style={{
                marginLeft: "0.5rem",
                fontSize: "0.75rem",
                color: C.warn,
              }}
            >
              {t(
                "You are editing on this teacher's behalf.",
                "Está editando en nombre de este docente.",
              )}
            </span>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <ModeButton
          active={mode === "period"}
          onClick={() => setMode("period")}
          label={t("By class period", "Por período")}
        />
        <ModeButton
          active={mode === "student"}
          onClick={() => setMode("student")}
          label={t("By student", "Por estudiante")}
        />
      </div>

      {loadError && (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: C.danger,
            borderRadius: 8,
            padding: "0.75rem",
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          {loadError}
        </div>
      )}

      {sections === null && !loadError && (
        <div style={{ color: C.sub, fontSize: "0.9rem" }}>
          {t("Loading your classes…", "Cargando sus clases…")}
        </div>
      )}

      {sections !== null && sections.length === 0 && (
        <div
          style={{
            border: `1px dashed ${C.line}`,
            borderRadius: 12,
            padding: "2rem",
            textAlign: "center",
            color: C.sub,
          }}
        >
          {t(
            "No class sections found for this teacher.",
            "No se encontraron secciones para este docente.",
          )}
        </div>
      )}

      {sections !== null && sections.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(220px, 300px) 1fr",
            gap: "1rem",
            alignItems: "start",
          }}
        >
          {/* Left rail: section list or student search */}
          <div
            style={{
              border: `1px solid ${C.line}`,
              borderRadius: 12,
              background: C.card,
              padding: "0.75rem",
            }}
          >
            {mode === "period" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {sections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedSectionId(s.id)}
                    style={railItemStyle(selectedSectionId === s.id)}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {s.period
                        ? t(`Period ${s.period}`, `Período ${s.period}`)
                        : s.courseName || t("Class", "Clase")}
                    </div>
                    <div style={{ fontSize: "0.78rem", color: C.sub }}>
                      {s.courseName} · {s.students.length}{" "}
                      {t("students", "estudiantes")}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div>
                <input
                  value={studentQuery}
                  onChange={(e) => setStudentQuery(e.target.value)}
                  placeholder={t(
                    "Search student or SIS ID…",
                    "Buscar estudiante o ID…",
                  )}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    border: `1px solid ${C.line}`,
                    borderRadius: 8,
                    padding: "0.45rem 0.6rem",
                    fontSize: "0.85rem",
                    marginBottom: "0.5rem",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    maxHeight: 420,
                    overflowY: "auto",
                  }}
                >
                  {filteredStudents.map((st) => (
                    <button
                      key={st.studentId}
                      type="button"
                      onClick={() => setSelectedStudentId(st.studentId)}
                      style={railItemStyle(selectedStudentId === st.studentId)}
                    >
                      <div style={{ fontWeight: 600 }}>{st.name}</div>
                      <div style={{ fontSize: "0.78rem", color: C.sub }}>
                        {st.localSisId ?? "—"}
                      </div>
                    </button>
                  ))}
                  {filteredStudents.length === 0 && (
                    <div style={{ color: C.sub, fontSize: "0.82rem", padding: 8 }}>
                      {t("No students match.", "Ningún estudiante coincide.")}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right pane: contextual samples + add */}
          <div style={{ minWidth: 0 }}>
            {mode === "period" && selectedSectionId != null && (
              <PeriodPane
                section={sections.find((s) => s.id === selectedSectionId)!}
                samples={samplesBySection[selectedSectionId]}
                lang={lang}
                t={t}
                onAdd={(student) =>
                  setAddContext({
                    section: sections.find((s) => s.id === selectedSectionId)!,
                    student,
                  })
                }
                onPreview={setPreviewSampleId}
                onChanged={() => refreshAfterMutation(selectedSectionId)}
              />
            )}
            {mode === "period" && selectedSectionId == null && (
              <EmptyHint
                text={t(
                  "Pick a class period to see and share its work samples.",
                  "Elija un período para ver y compartir las muestras.",
                )}
              />
            )}
            {mode === "student" && selectedStudentId != null && (
              <StudentPane
                studentId={selectedStudentId}
                sections={sections.filter((s) =>
                  s.students.some((st) => st.studentId === selectedStudentId),
                )}
                samplesBySection={samplesBySection}
                lang={lang}
                t={t}
                onAdd={(section, student) => setAddContext({ section, student })}
                onPreview={setPreviewSampleId}
                onChanged={refreshAfterMutation}
              />
            )}
            {mode === "student" && selectedStudentId == null && (
              <EmptyHint
                text={t(
                  "Search and pick a student to see their shared work.",
                  "Busque y elija un estudiante para ver su trabajo.",
                )}
              />
            )}
          </div>
        </div>
      )}

      {addContext && (
        <AddSampleModal
          section={addContext.section}
          student={addContext.student}
          lang={lang}
          t={t}
          onClose={() => setAddContext(null)}
          onCreated={() => {
            refreshAfterMutation(addContext.section.id);
            setAddContext(null);
          }}
        />
      )}

      {previewSampleId != null && (
        <PreviewModal
          sampleId={previewSampleId}
          lang={lang}
          t={t}
          onClose={() => setPreviewSampleId(null)}
        />
      )}
    </div>
  );
}

function railItemStyle(active: boolean): React.CSSProperties {
  return {
    textAlign: "left",
    border: `1px solid ${active ? C.brand : C.line}`,
    background: active ? C.brandSoft : "#fff",
    borderRadius: 8,
    padding: "0.5rem 0.6rem",
    cursor: "pointer",
    color: C.ink,
  };
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? C.brand : C.line}`,
        background: active ? C.brandSoft : "#fff",
        color: active ? C.brand : C.sub,
        borderRadius: 999,
        padding: "0.4rem 0.9rem",
        fontSize: "0.85rem",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function LangToggle({
  lang,
  setLang,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          style={{
            border: `1px solid ${lang === l ? C.brand : C.line}`,
            background: lang === l ? C.brandSoft : "#fff",
            color: lang === l ? C.brand : C.sub,
            borderRadius: 6,
            padding: "0.25rem 0.6rem",
            fontSize: "0.78rem",
            cursor: "pointer",
          }}
        >
          {l === "en" ? "English" : "Español"}
        </button>
      ))}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div
      style={{
        border: `1px dashed ${C.line}`,
        borderRadius: 12,
        padding: "2.5rem 1.5rem",
        textAlign: "center",
        color: C.sub,
        fontSize: "0.9rem",
      }}
    >
      {text}
    </div>
  );
}

function PeriodPane({
  section,
  samples,
  lang,
  t,
  onAdd,
  onPreview,
  onChanged,
}: {
  section: TeacherSection;
  samples: WorkSample[] | undefined;
  lang: Lang;
  t: (en: string, es: string) => string;
  onAdd: (student: SectionStudent) => void;
  onPreview: (id: number) => void;
  onChanged: () => void;
}) {
  const [pickStudent, setPickStudent] = useState(false);
  return (
    <div>
      <PaneHeader
        title={
          section.period
            ? t(`Period ${section.period}`, `Período ${section.period}`)
            : section.courseName || t("Class", "Clase")
        }
        subtitle={`${section.courseName ?? ""}`}
        action={
          <button
            type="button"
            onClick={() => setPickStudent((v) => !v)}
            style={primaryBtn}
          >
            {t("+ Add work sample", "+ Agregar muestra")}
          </button>
        }
      />
      {pickStudent && (
        <div
          style={{
            border: `1px solid ${C.line}`,
            borderRadius: 10,
            padding: "0.75rem",
            marginBottom: "0.75rem",
            background: "#fafafa",
          }}
        >
          <div style={{ fontSize: "0.82rem", color: C.sub, marginBottom: 6 }}>
            {t("Choose a student in this class:", "Elija un estudiante:")}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {section.students.map((st) => (
              <button
                key={st.studentId}
                type="button"
                onClick={() => {
                  setPickStudent(false);
                  onAdd(st);
                }}
                style={chipBtn}
              >
                {st.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <SampleList
        samples={samples}
        lang={lang}
        t={t}
        showStudent
        onPreview={onPreview}
        onChanged={onChanged}
      />
    </div>
  );
}

function StudentPane({
  studentId,
  sections,
  samplesBySection,
  lang,
  t,
  onAdd,
  onPreview,
  onChanged,
}: {
  studentId: string;
  sections: TeacherSection[];
  samplesBySection: Record<number, WorkSample[]>;
  lang: Lang;
  t: (en: string, es: string) => string;
  onAdd: (section: TeacherSection, student: SectionStudent) => void;
  onPreview: (id: number) => void;
  onChanged: (sectionId: number) => void;
}) {
  const student =
    sections[0]?.students.find((st) => st.studentId === studentId) ?? null;
  return (
    <div>
      <PaneHeader
        title={student?.name ?? t("Student", "Estudiante")}
        subtitle={student?.localSisId ?? "—"}
        action={null}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {sections.map((s) => {
          const st = s.students.find((x) => x.studentId === studentId)!;
          const forStudent = (samplesBySection[s.id] ?? []).filter(
            (sm) => sm.studentId === studentId,
          );
          return (
            <div
              key={s.id}
              style={{
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                padding: "0.75rem",
                background: C.card,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.5rem",
                  gap: "0.5rem",
                }}
              >
                <div style={{ fontWeight: 600, color: C.ink }}>
                  {s.period
                    ? t(`Period ${s.period}`, `Período ${s.period}`)
                    : s.courseName}
                  <span
                    style={{
                      fontWeight: 400,
                      color: C.sub,
                      fontSize: "0.82rem",
                      marginLeft: 6,
                    }}
                  >
                    {s.courseName}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onAdd(s, st)}
                  style={primaryBtn}
                >
                  {t("+ Add", "+ Agregar")}
                </button>
              </div>
              <SampleList
                samples={samplesBySection[s.id] ? forStudent : undefined}
                lang={lang}
                t={t}
                showStudent={false}
                onPreview={onPreview}
                onChanged={() => onChanged(s.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PaneHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "0.75rem",
        gap: "0.5rem",
      }}
    >
      <div>
        <div style={{ fontSize: "1.1rem", fontWeight: 700, color: C.ink }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: "0.82rem", color: C.sub }}>{subtitle}</div>
        )}
      </div>
      {action}
    </div>
  );
}

function SampleList({
  samples,
  lang,
  t,
  showStudent,
  onPreview,
  onChanged,
}: {
  samples: WorkSample[] | undefined;
  lang: Lang;
  t: (en: string, es: string) => string;
  showStudent: boolean;
  onPreview: (id: number) => void;
  onChanged: () => void;
}) {
  if (samples === undefined) {
    return (
      <div style={{ color: C.sub, fontSize: "0.85rem", padding: "0.5rem 0" }}>
        {t("Loading…", "Cargando…")}
      </div>
    );
  }
  if (samples.length === 0) {
    return (
      <div style={{ color: C.sub, fontSize: "0.85rem", padding: "0.5rem 0" }}>
        {t("No work samples yet.", "Aún no hay muestras.")}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
      {samples.map((s) => (
        <SampleRow
          key={s.id}
          sample={s}
          lang={lang}
          t={t}
          showStudent={showStudent}
          onPreview={onPreview}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function SampleRow({
  sample,
  lang,
  t,
  showStudent,
  onPreview,
  onChanged,
}: {
  sample: WorkSample;
  lang: Lang;
  t: (en: string, es: string) => string;
  showStudent: boolean;
  onPreview: (id: number) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const published = sample.publishedAt != null;

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: `1px solid ${published ? "#bbf7d0" : C.line}`,
        background: published ? C.okSoft : "#fff",
        borderRadius: 10,
        padding: "0.6rem 0.75rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "0.5rem",
          alignItems: "flex-start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: C.ink }}>
            {sample.assignmentTitle}
          </div>
          <div style={{ fontSize: "0.78rem", color: C.sub }}>
            {subjectLabel(sample.subject, lang)}
            {showStudent ? ` · ${sample.studentName}` : ""}
            {` · ${new Date(sample.createdAt).toLocaleDateString()}`}
          </div>
          {sample.note && (
            <div style={{ fontSize: "0.82rem", color: "#475569", marginTop: 4 }}>
              {sample.note}
            </div>
          )}
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: "0.68rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            color: published ? C.ok : C.warn,
            background: published ? "#d1fae5" : "#fef3c7",
            borderRadius: 999,
            padding: "0.15rem 0.5rem",
            height: "fit-content",
          }}
        >
          {published ? t("Shared", "Compartido") : t("Draft", "Borrador")}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" onClick={() => onPreview(sample.id)} style={ghostBtn}>
          {t("Preview", "Vista previa")}
        </button>
        {published ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => unpublishSample(sample.id))}
            style={ghostBtn}
          >
            {t("Unshare", "Dejar de compartir")}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => publishSample(sample.id))}
            style={primaryBtnSm}
          >
            {t("Share with family", "Compartir con la familia")}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                t(
                  "Delete this work sample? This cannot be undone.",
                  "¿Eliminar esta muestra? No se puede deshacer.",
                ),
              )
            ) {
              void run(() => deleteSample(sample.id));
            }
          }}
          style={{ ...ghostBtn, color: C.danger, borderColor: "#fecaca" }}
        >
          {t("Delete", "Eliminar")}
        </button>
      </div>
      {err && (
        <div style={{ color: C.danger, fontSize: "0.78rem", marginTop: 6 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function AddSampleModal({
  section,
  student,
  lang,
  t,
  onClose,
  onCreated,
}: {
  section: TeacherSection;
  student: SectionStudent;
  lang: Lang;
  t: (en: string, es: string) => string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [subject, setSubject] = useState<AcademicSubject>("ela");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<AcademicSource>("phone");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  async function submit() {
    if (busy) return;
    if (!title.trim()) {
      setErr(t("Add a short assignment title.", "Agregue un título."));
      return;
    }
    if (!file) {
      setErr(t("Take a photo or attach a file.", "Tome una foto o adjunte un archivo."));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const objectPath = await uploadObject(file);
      await createSample({
        sectionId: section.id,
        studentId: student.studentId,
        subject,
        assignmentTitle: title.trim(),
        note: note.trim() || undefined,
        objectPath,
        source,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={t("Add work sample", "Agregar muestra")}
      onClose={onClose}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div style={{ fontSize: "0.85rem", color: C.sub }}>
          {student.name}
          {student.localSisId ? ` · ${student.localSisId}` : ""}
          {" · "}
          {section.period
            ? t(`Period ${section.period}`, `Período ${section.period}`)
            : section.courseName}
        </div>

        <div>
          <FieldLabel text={t("Subject", "Materia")} />
          <div style={{ display: "flex", gap: 6 }}>
            {(["ela", "math", "behavior"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSubject(s)}
                style={{
                  ...chipBtn,
                  borderColor: subject === s ? C.brand : C.line,
                  background: subject === s ? C.brandSoft : "#fff",
                  color: subject === s ? C.brand : C.sub,
                }}
              >
                {subjectLabel(s, lang)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <FieldLabel text={t("Assignment title", "Título de la tarea")} />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("e.g. Chapter 4 exit ticket", "p. ej. Boleto de salida")}
            style={inputStyle}
          />
        </div>

        <div>
          <FieldLabel text={t("Note for family (optional)", "Nota (opcional)")} />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={t(
              "What to notice or practice at home…",
              "Qué observar o practicar en casa…",
            )}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </div>

        <div>
          <FieldLabel text={t("Work sample", "Muestra de trabajo")} />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f) {
                setFile(f);
                setSource("phone");
              }
            }}
          />
          <input
            ref={uploadRef}
            type="file"
            accept="image/*,application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f) {
                setFile(f);
                setSource("upload");
              }
            }}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              style={ghostBtn}
            >
              {t("Take photo", "Tomar foto")}
            </button>
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              style={ghostBtn}
            >
              {t("Attach file", "Adjuntar archivo")}
            </button>
          </div>
          {file && (
            <div style={{ fontSize: "0.8rem", color: C.ok, marginTop: 6 }}>
              {t("Attached:", "Adjuntado:")} {file.name}
            </div>
          )}
        </div>

        {err && (
          <div style={{ color: C.danger, fontSize: "0.82rem" }}>{err}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={ghostBtn}>
            {t("Cancel", "Cancelar")}
          </button>
          <button type="button" onClick={submit} disabled={busy} style={primaryBtn}>
            {busy ? t("Saving…", "Guardando…") : t("Save draft", "Guardar borrador")}
          </button>
        </div>
        <div style={{ fontSize: "0.75rem", color: C.sub }}>
          {t(
            "Saved as a draft — it stays private until you Share it with the family.",
            "Se guarda como borrador — permanece privado hasta que lo comparta.",
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function PreviewModal({
  sampleId,
  lang,
  t,
  onClose,
}: {
  sampleId: number;
  lang: Lang;
  t: (en: string, es: string) => string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    fetchSampleImage(sampleId)
      .then(({ objectUrl, contentType }) => {
        if (alive) {
          created = objectUrl;
          setUrl(objectUrl);
          setContentType(contentType);
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [sampleId]);

  return (
    <ModalShell title={t("Family preview", "Vista previa")} onClose={onClose}>
      {err && <div style={{ color: C.danger, fontSize: "0.85rem" }}>{err}</div>}
      {!err && !url && (
        <div style={{ color: C.sub, fontSize: "0.85rem" }}>
          {t("Loading…", "Cargando…")}
        </div>
      )}
      {url &&
        (contentType.includes("pdf") ? (
          <iframe
            title={t("Work sample", "Muestra")}
            src={url}
            style={{ width: "100%", height: "70vh", border: "none" }}
          />
        ) : (
          <img
            src={url}
            alt={t("Work sample", "Muestra")}
            style={{ width: "100%", borderRadius: 8, border: `1px solid ${C.line}` }}
          />
        ))}
    </ModalShell>
  );
}

function FieldLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: "0.78rem",
        fontWeight: 600,
        color: C.sub,
        marginBottom: 4,
      }}
    >
      {text}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: `1px solid ${C.line}`,
  borderRadius: 8,
  padding: "0.5rem 0.6rem",
  fontSize: "0.9rem",
  color: C.ink,
};

const primaryBtn: React.CSSProperties = {
  border: "none",
  background: C.brand,
  color: "#fff",
  borderRadius: 8,
  padding: "0.45rem 0.85rem",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
};

const primaryBtnSm: React.CSSProperties = {
  ...primaryBtn,
  padding: "0.3rem 0.6rem",
  fontSize: "0.78rem",
};

const ghostBtn: React.CSSProperties = {
  border: `1px solid ${C.line}`,
  background: "#fff",
  color: C.ink,
  borderRadius: 8,
  padding: "0.3rem 0.6rem",
  fontSize: "0.78rem",
  cursor: "pointer",
};

const chipBtn: React.CSSProperties = {
  border: `1px solid ${C.line}`,
  background: "#fff",
  color: C.ink,
  borderRadius: 999,
  padding: "0.3rem 0.7rem",
  fontSize: "0.8rem",
  cursor: "pointer",
};
