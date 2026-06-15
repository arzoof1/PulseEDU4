// PulseBrainLab interventionist FACILITATION PDF — the staff-facing handout the
// Behavior Specialist downloads to run a session. Portrait, single lesson.
//
// Staff-facing content is English-only by design (flow, discussion prompts).
// The internal CASEL competency is NEVER included here — it must not leave the
// server. Strictly learning / brain-science framing; no "SEL" language.
//
// Robustness mirrors composerPlanPdf: explicit page margins on every addPage,
// buffered chunks resolved on "end".
import PDFDocument from "pdfkit";
import type { PulseBrainLabLesson } from "../data/pulseBrainLab/index.js";

const MARGIN = 54;
const INK = "#0f172a";
const MUTED = "#475569";
const ACCENT = "#4338ca";
const RULE = "#e2e8f0";

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  const bottom = doc.page.height - MARGIN;
  if (doc.y + needed > bottom) {
    doc.addPage({
      size: "LETTER",
      layout: "portrait",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    });
  }
}

function sectionHeading(doc: PDFKit.PDFDocument, label: string) {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(ACCENT)
    .text(label.toUpperCase(), { characterSpacing: 0.5 });
  const y = doc.y + 2;
  doc
    .moveTo(MARGIN, y)
    .lineTo(doc.page.width - MARGIN, y)
    .strokeColor(RULE)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.4);
}

function labeledBlock(doc: PDFKit.PDFDocument, label: string, body: string) {
  ensureSpace(doc, 48);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(label);
  doc
    .font("Helvetica")
    .fontSize(10.5)
    .fillColor(MUTED)
    .text(body, { lineGap: 1.5 });
  doc.moveDown(0.4);
}

export async function renderPulseBrainLabFacilitationPdf(
  lesson: PulseBrainLabLesson,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      layout: "portrait",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: {
        Title: `${lesson.title} — PulseBrainLab Facilitation Guide`,
        Author: "PulseEDU",
        Subject: `PulseBrainLab · ${lesson.gradeBand} · Week ${lesson.week} Session ${lesson.session}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ----- Masthead -----
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(ACCENT)
      .text("PULSEBRAINLAB · FACILITATION GUIDE", { characterSpacing: 1 });
    doc.moveDown(0.2);
    doc.font("Helvetica-Bold").fontSize(22).fillColor(INK).text(lesson.title);
    doc
      .font("Helvetica")
      .fontSize(10.5)
      .fillColor(MUTED)
      .text(
        `Grades ${lesson.gradeBand}  ·  Week ${lesson.week}, Session ${lesson.session}  ·  ${lesson.skillArea}  ·  Brain idea: ${lesson.brainModelTag}  ·  ${lesson.durationMinutes} min`,
      );
    doc.moveDown(0.2);

    sectionHeading(doc, "Lesson at a glance");
    labeledBlock(doc, "Brain concept", lesson.brainConcept);
    labeledBlock(doc, "Objective", lesson.objective);
    labeledBlock(doc, "Materials", lesson.materials);

    sectionHeading(doc, "Session flow");
    labeledBlock(doc, "1 · Connect", lesson.flow.connect);
    labeledBlock(doc, "2 · Teach", lesson.flow.teach);
    labeledBlock(doc, "3 · Practice", lesson.flow.practice);
    labeledBlock(doc, "4 · Close", lesson.flow.close);

    if (lesson.contentQuestions.length > 0) {
      sectionHeading(doc, "Discussion questions");
      for (const q of lesson.contentQuestions) {
        ensureSpace(doc, 26);
        doc
          .font("Helvetica")
          .fontSize(10.5)
          .fillColor(INK)
          .text(`•  ${q.text}`, { lineGap: 1.5, indent: 4 });
      }
      doc.moveDown(0.2);
    }

    if (lesson.followupQuestions.length > 0) {
      sectionHeading(doc, "Retrieval / understanding checks");
      for (const q of lesson.followupQuestions) {
        ensureSpace(doc, 26);
        doc
          .font("Helvetica")
          .fontSize(10.5)
          .fillColor(INK)
          .text(`•  ${q.text}`, { lineGap: 1.5, indent: 4 });
      }
      doc.moveDown(0.2);
    }

    if (lesson.skillTags.length > 0) {
      sectionHeading(doc, "Skill focus");
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .fillColor(MUTED)
        .text(lesson.skillTags.join("  ·  "));
    }

    // ----- Footer on every page -----
    const range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(range.start + p);
      const y = doc.page.height - MARGIN + 18;
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `PulseBrainLab — interventionist guide  ·  Page ${p + 1} of ${range.count}`,
          MARGIN,
          y,
          { width: doc.page.width - MARGIN * 2, align: "center" },
        );
    }

    doc.end();
  });
}
