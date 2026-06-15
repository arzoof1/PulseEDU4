// PulseBrainLab EVIDENCE PACKET PDF — a family-facing one-pager that combines
// the "Reinforce at Home" recall card for a delivered lesson with the child's
// own work sample image and any Home Follow-Up the family recorded. The BS
// shares this with the home; the parent can also download it from the portal.
//
// HARD CONSTRAINTS:
//  - Bilingual: the caller picks the language; CASEL / "SEL" framing never
//    appears — strictly learning / brain-science wording.
//  - The only student ID that may appear is local_sis_id — NEVER the FLEID.
//  - Image samples (phone capture) are embedded directly. Scanned-PDF samples
//    can't be rasterized here (no PNG encoder available), so they render as a
//    "worksheet on file" note instead of a broken image.
import PDFDocument from "pdfkit";
import type { PulseBrainLabParentReinforcement } from "../data/pulseBrainLab/index.js";

const MARGIN = 54;
const INK = "#0f172a";
const MUTED = "#475569";
const ACCENT = "#4338ca";
const RULE = "#cbd5e1";
const SOFT = "#eef2ff";

export type PacketLanguage = "en" | "es";

export interface PacketWorkSampleImage {
  /** Decoded image bytes (PNG/JPEG). Null when the sample is a scanned PDF. */
  imageBytes: Buffer | null;
  source: string;
  createdAtLabel: string;
}

export interface PacketHomeResponse {
  promptIndex: number;
  transcript: string;
}

// Grade/benchmark to render — one entry per SHARED, graded sample (grading is
// per assignment/session, so a multi-session lesson packet can carry several).
export interface PacketGrade {
  sessionDate: string | null;
  gradeMode: "score" | "participation";
  maxScore: number | null;
  score: number | null;
  participationMark: "check" | "x" | null;
  benchmarkCode: string | null;
  benchmarkLabel: string | null;
}

export interface PacketPdfInput {
  language: PacketLanguage;
  lessonTitle: string;
  skillArea: string;
  /** Display name of the child (first + last). */
  studentName: string;
  /** local_sis_id ONLY — never the FLEID. */
  localSisId: string | null;
  sessionDateLabel: string | null;
  parentReinforcement: PulseBrainLabParentReinforcement;
  grades: PacketGrade[];
  workSamples: PacketWorkSampleImage[];
  homeResponses: PacketHomeResponse[];
}

const STR: Record<
  PacketLanguage,
  {
    title: string;
    forStudent: string;
    session: string;
    whatWePracticed: string;
    askYourChild: string;
    whyThisWorks: string;
    tryTogether: string;
    workSample: string;
    sampleOnFile: string;
    homeFollowUp: string;
    answerTo: string;
    noWorkSample: string;
    grade: string;
    benchmark: string;
    markMet: string;
    markNotYet: string;
    reportTitle: string;
    generated: string;
    lessonsCount: string;
  }
> = {
  en: {
    title: "Reinforce at Home",
    forStudent: "For",
    session: "Lesson date",
    whatWePracticed: "What we practiced",
    askYourChild: "Ask your child",
    whyThisWorks: "Why this works",
    tryTogether: "Try this together",
    workSample: "Your child's work",
    sampleOnFile: "A scanned worksheet is on file at school.",
    homeFollowUp: "Home Follow-Up",
    answerTo: "Answer to",
    noWorkSample: "No work sample shared yet.",
    grade: "Grade",
    benchmark: "Florida benchmark",
    markMet: "Met",
    markNotYet: "Not yet",
    reportTitle: "Intervention Report",
    generated: "Generated",
    lessonsCount: "lessons",
  },
  es: {
    title: "Refuerza en casa",
    forStudent: "Para",
    session: "Fecha de la lección",
    whatWePracticed: "Lo que practicamos",
    askYourChild: "Pregúntele a su hijo/a",
    whyThisWorks: "Por qué funciona",
    tryTogether: "Hagan esto juntos",
    workSample: "El trabajo de su hijo/a",
    sampleOnFile: "Hay una hoja escaneada archivada en la escuela.",
    homeFollowUp: "Seguimiento en casa",
    answerTo: "Respuesta a",
    noWorkSample: "Aún no se ha compartido una muestra de trabajo.",
    grade: "Calificación",
    benchmark: "Estándar de Florida",
    markMet: "Logrado",
    markNotYet: "Aún no",
    reportTitle: "Informe de intervención",
    generated: "Generado",
    lessonsCount: "lecciones",
  },
};

function sectionHeading(
  doc: PDFKit.PDFDocument,
  text: string,
  contentWidth: number,
): void {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.6);
  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(text.toUpperCase(), MARGIN, doc.y, { width: contentWidth });
  doc
    .moveTo(MARGIN, doc.y + 2)
    .lineTo(MARGIN + contentWidth, doc.y + 2)
    .strokeColor(RULE)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.4);
}

// Render one lesson's content (grades → home follow-up) into an existing doc,
// starting at the current doc.y. Shared by the single-lesson family packet and
// the multi-lesson staff intervention report so both stay pixel-identical.
function renderLessonBody(
  doc: PDFKit.PDFDocument,
  input: PacketPdfInput,
  contentWidth: number,
): void {
  const t = STR[input.language];
  const pr = input.parentReinforcement;
  const lang = input.language;

  // Grade / benchmark — one block per shared, graded sample. Grading is per
  // assignment (session), so a multi-session lesson packet can carry several.
  const renderableGrades = input.grades.filter((g) => {
    const hasValue =
      (g.gradeMode === "score" && g.score != null) ||
      (g.gradeMode === "participation" && g.participationMark != null);
    return hasValue || g.benchmarkCode != null;
  });
  if (renderableGrades.length > 0) {
    sectionHeading(doc, t.grade, contentWidth);
    renderableGrades.forEach((g) => {
      const valueText =
        g.gradeMode === "score" && g.score != null
          ? `${g.score}${g.maxScore != null ? ` / ${g.maxScore}` : ""}`
          : g.gradeMode === "participation" && g.participationMark != null
            ? g.participationMark === "check"
              ? t.markMet
              : t.markNotYet
            : null;
      const dateSuffix = g.sessionDate ? `  (${g.sessionDate})` : "";
      if (valueText != null) {
        doc
          .fillColor(INK)
          .font("Helvetica-Bold")
          .fontSize(13)
          .text(`${valueText}${dateSuffix}`, MARGIN, doc.y, {
            width: contentWidth,
          });
      }
      if (g.benchmarkCode) {
        const label = g.benchmarkLabel ? ` — ${g.benchmarkLabel}` : "";
        doc
          .fillColor(MUTED)
          .font("Helvetica")
          .fontSize(10)
          .text(`${t.benchmark}: ${g.benchmarkCode}${label}`, MARGIN, doc.y, {
            width: contentWidth,
          });
      }
    });
  }

  // What we practiced.
  sectionHeading(doc, t.whatWePracticed, contentWidth);
  doc
    .fillColor(INK)
    .font("Helvetica")
    .fontSize(11)
    .text(pr.summary[lang], MARGIN, doc.y, { width: contentWidth });

  // Ask your child (the retrieval prompts).
  sectionHeading(doc, t.askYourChild, contentWidth);
  pr.askYourChild.forEach((q, i) => {
    doc
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(11)
      .text(`${i + 1}. ${q[lang]}`, MARGIN, doc.y, { width: contentWidth });
    doc.moveDown(0.2);
  });

  // Why this works.
  sectionHeading(doc, t.whyThisWorks, contentWidth);
  doc
    .fillColor(MUTED)
    .font("Helvetica-Oblique")
    .fontSize(11)
    .text(pr.whyThisWorks[lang], MARGIN, doc.y, { width: contentWidth });

  // Try together.
  sectionHeading(doc, t.tryTogether, contentWidth);
  doc
    .fillColor(INK)
    .font("Helvetica")
    .fontSize(11)
    .text(pr.tryTogether[lang], MARGIN, doc.y, { width: contentWidth });

  // Work sample image(s).
  sectionHeading(doc, t.workSample, contentWidth);
  if (input.workSamples.length === 0) {
    doc
      .fillColor(MUTED)
      .font("Helvetica-Oblique")
      .fontSize(10)
      .text(t.noWorkSample, MARGIN, doc.y, { width: contentWidth });
  } else {
    for (const sample of input.workSamples) {
      if (sample.imageBytes) {
        if (doc.y > doc.page.height - 260) doc.addPage();
        try {
          doc.image(sample.imageBytes, MARGIN, doc.y, {
            fit: [contentWidth, 320],
            align: "center",
          });
          doc.moveDown(0.5);
          doc.y += 8;
        } catch {
          // Unsupported/corrupt image bytes — degrade to the on-file note.
          doc
            .fillColor(MUTED)
            .font("Helvetica-Oblique")
            .fontSize(10)
            .text(t.sampleOnFile, MARGIN, doc.y, { width: contentWidth });
        }
      } else {
        doc
          .fillColor(MUTED)
          .font("Helvetica-Oblique")
          .fontSize(10)
          .text(t.sampleOnFile, MARGIN, doc.y, { width: contentWidth });
        doc.moveDown(0.3);
      }
    }
  }

  // Home Follow-Up transcripts.
  if (input.homeResponses.length > 0) {
    sectionHeading(doc, t.homeFollowUp, contentWidth);
    const sorted = [...input.homeResponses].sort(
      (a, b) => a.promptIndex - b.promptIndex,
    );
    for (const r of sorted) {
      const promptText = pr.askYourChild[r.promptIndex]?.[lang];
      if (promptText) {
        doc
          .fillColor(MUTED)
          .font("Helvetica-Bold")
          .fontSize(9)
          .text(`${t.answerTo}: ${promptText}`, MARGIN, doc.y, {
            width: contentWidth,
          });
      }
      doc
        .fillColor(INK)
        .font("Helvetica")
        .fontSize(11)
        .text(r.transcript, MARGIN, doc.y, { width: contentWidth });
      doc.moveDown(0.5);
    }
  }
}

export async function renderPulseBrainLabPacketPdf(
  input: PacketPdfInput,
): Promise<Buffer> {
  const t = STR[input.language];

  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const contentWidth = doc.page.width - MARGIN * 2;
  const chunks: Buffer[] = [];

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Header band.
  doc.rect(0, 0, doc.page.width, 96).fill(SOFT);
  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(22)
    .text(t.title, MARGIN, 28, { width: contentWidth });
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(input.lessonTitle, MARGIN, 58, { width: contentWidth });
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10)
    .text(input.skillArea, MARGIN, 76, { width: contentWidth });

  doc.y = 112;

  // Who / when line.
  const idSuffix = input.localSisId ? ` (${input.localSisId})` : "";
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(`${t.forStudent}: ${input.studentName}${idSuffix}`, MARGIN, doc.y, {
      width: contentWidth,
    });
  if (input.sessionDateLabel) {
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(10)
      .text(`${t.session}: ${input.sessionDateLabel}`, MARGIN, doc.y, {
        width: contentWidth,
      });
  }

  renderLessonBody(doc, input, contentWidth);

  doc.end();
  return done;
}

// Multi-lesson per-student intervention report (staff-facing). Reuses the exact
// per-lesson body renderer so a printed report matches the family packet, but
// fronts it with a cover header and paginates one lesson per page. Includes
// DRAFT and published lessons (the caller — a staff route — decides scope). The
// only student ID shown is local_sis_id, never the FLEID.
export interface StudentReportPdfInput {
  language: PacketLanguage;
  /** Display name of the child (first + last). */
  studentName: string;
  /** local_sis_id ONLY — never the FLEID. */
  localSisId: string | null;
  /** Human date the report was generated (YYYY-MM-DD). */
  generatedLabel: string;
  /** One entry per lesson card, newest first. */
  lessons: PacketPdfInput[];
}

export async function renderPulseBrainLabStudentReportPdf(
  input: StudentReportPdfInput,
): Promise<Buffer> {
  const t = STR[input.language];

  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const contentWidth = doc.page.width - MARGIN * 2;
  const chunks: Buffer[] = [];

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Cover header band.
  doc.rect(0, 0, doc.page.width, 110).fill(SOFT);
  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(22)
    .text(t.reportTitle, MARGIN, 26, { width: contentWidth });
  const idSuffix = input.localSisId ? ` (${input.localSisId})` : "";
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(`${input.studentName}${idSuffix}`, MARGIN, 58, {
      width: contentWidth,
    });
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10)
    .text(
      `${t.generated}: ${input.generatedLabel}  ·  ${input.lessons.length} ${t.lessonsCount}`,
      MARGIN,
      82,
      { width: contentWidth },
    );
  doc.y = 128;

  if (input.lessons.length === 0) {
    doc
      .fillColor(MUTED)
      .font("Helvetica-Oblique")
      .fontSize(11)
      .text(t.noWorkSample, MARGIN, doc.y, { width: contentWidth });
  }

  input.lessons.forEach((lesson, i) => {
    if (i > 0) doc.addPage();
    else doc.moveDown(0.4);
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(15)
      .text(lesson.lessonTitle, MARGIN, doc.y, { width: contentWidth });
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(10)
      .text(lesson.skillArea, MARGIN, doc.y, { width: contentWidth });
    if (lesson.sessionDateLabel) {
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(10)
        .text(`${t.session}: ${lesson.sessionDateLabel}`, MARGIN, doc.y, {
          width: contentWidth,
        });
    }
    renderLessonBody(doc, lesson, contentWidth);
  });

  doc.end();
  return done;
}
