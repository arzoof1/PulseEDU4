// PulseBrainLab STUDENT WORKSHEET PDF — the completable handout. A completed
// sheet is both the participation record and the work sample the BS scans back
// in. This generator is PER-STUDENT (one personalized QR each), and renders one
// page per student, so the SAME function powers a single reprint and the whole-
// group batch print at the copier.
//
// QR ROUTING / PII RULES (hard constraints):
//  - The QR encodes ONLY an opaque base62 token. No PII, never the FLEID.
//  - The human-readable manual-routing fallback beside the QR is the student's
//    `local_sis_id` + a short session code — NEVER the FLEID.
//  - Student-facing worksheet text is bilingual (EN/ES); the caller picks the
//    language. CASEL / "SEL" framing never appears.
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type {
  PulseBrainLabLesson,
  WorksheetResponseType,
} from "../data/pulseBrainLab/index.js";

const MARGIN = 54;
const INK = "#0f172a";
const MUTED = "#475569";
const ACCENT = "#4338ca";
const RULE = "#cbd5e1";

export type WorksheetLanguage = "en" | "es";

export interface WorksheetStudent {
  /** Opaque base62 token encoded in the QR. NEVER carries PII / the FLEID. */
  token: string;
  /** Display ID printed beside the QR. NEVER the FLEID. */
  localSisId: string | null;
  firstName: string;
  lastName: string;
}

export interface WorksheetPdfInput {
  lesson: PulseBrainLabLesson;
  language: WorksheetLanguage;
  /** Short, human-typeable session code for the manual-routing fallback. */
  sessionCode: string;
  sessionDateLabel: string;
  groupName: string;
  students: WorksheetStudent[];
}

const STR: Record<
  WorksheetLanguage,
  {
    worksheet: string;
    name: string;
    scanBack: string;
    ifNoScan: string;
    student: string;
    session: string;
    write: string;
    draw: string;
    checklist: string;
  }
> = {
  en: {
    worksheet: "BRAIN LAB WORKSHEET",
    name: "Name",
    scanBack: "Staff: scan this code to file this sheet.",
    ifNoScan: "If the code won't scan, file by:",
    student: "Student",
    session: "Session",
    write: "Write your answer:",
    draw: "Draw it:",
    checklist: "Check when you can do it:",
  },
  es: {
    worksheet: "HOJA DEL LABORATORIO DEL CEREBRO",
    name: "Nombre",
    scanBack: "Personal: escanee este código para archivar la hoja.",
    ifNoScan: "Si el código no escanea, archive por:",
    student: "Estudiante",
    session: "Sesión",
    write: "Escribe tu respuesta:",
    draw: "Dibújalo:",
    checklist: "Marca cuando puedas hacerlo:",
  },
};

function responseLabel(t: WorksheetResponseType, lang: WorksheetLanguage) {
  const s = STR[lang];
  if (t === "draw") return s.draw;
  if (t === "checklist") return s.checklist;
  return s.write;
}

function newPage(doc: PDFKit.PDFDocument) {
  doc.addPage({
    size: "LETTER",
    layout: "portrait",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  });
}

async function renderStudentPage(
  doc: PDFKit.PDFDocument,
  input: WorksheetPdfInput,
  student: WorksheetStudent,
) {
  const s = STR[input.language];
  const lesson = input.lesson;
  const contentRight = doc.page.width - MARGIN;
  const qrSize = 120;
  const qrX = contentRight - qrSize;
  const qrTop = MARGIN;

  // ----- QR (opaque token only) + manual-routing fallback -----
  // The QR is auto-read both by the office-copier batch decoder (server-side
  // rasterize + decode) and a phone camera, so it MUST keep a real quiet zone:
  // `margin: 2` bakes a white border into the image and NO caption is allowed to
  // touch the QR (both notes sit BELOW it with a gap). Worksheets printed with a
  // caption overlapping the QR edge or margin:0 could not be located by any
  // decoder — the finder patterns need the surrounding whitespace.
  const qrDataUrl = await QRCode.toDataURL(student.token, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
  const qrBuf = Buffer.from(qrDataUrl.split(",")[1], "base64");
  doc.image(qrBuf, qrX, qrTop, { width: qrSize, height: qrSize });
  const fallback = `${s.student}: ${student.localSisId ?? "—"}   ${s.session}: ${input.sessionCode}`;
  doc
    .font("Helvetica")
    .fontSize(6.5)
    .fillColor(MUTED)
    .text(s.scanBack, qrX - 150, qrTop + qrSize + 4, {
      width: 150 + qrSize,
      align: "right",
    })
    .text(`${s.ifNoScan} ${fallback}`, qrX - 200, qrTop + qrSize + 13, {
      width: 200 + qrSize,
      align: "right",
    });

  // ----- Header (left of the QR) -----
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(ACCENT)
    .text(s.worksheet, MARGIN, MARGIN, { characterSpacing: 1 });
  doc.moveDown(0.2);
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(INK)
    .text(lesson.title, { width: qrX - MARGIN - 16 });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(MUTED)
    .text(
      `${input.groupName}  ·  ${input.sessionDateLabel}  ·  ${lesson.skillArea}`,
      { width: qrX - MARGIN - 16 },
    );

  // Name line — y is below the taller of header/QR block (QR + its two captions).
  doc.y = Math.max(doc.y, qrTop + qrSize + 24) + 6;
  const nameY = doc.y;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(`${s.name}: `, MARGIN, nameY, {
    continued: true,
  });
  doc.font("Helvetica").fillColor(MUTED).text(`${student.firstName} ${student.lastName}`);
  doc.moveDown(0.6);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(contentRight, doc.y)
    .strokeColor(RULE)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.5);

  // ----- Intro -----
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(INK)
    .text(input.language === "es" ? lesson.studentWorksheet.intro.es : lesson.studentWorksheet.intro.en, {
      lineGap: 2,
    });
  doc.moveDown(0.6);

  // ----- Prompts -----
  const bottom = doc.page.height - MARGIN;
  lesson.studentWorksheet.prompts.forEach((p, i) => {
    const promptText = input.language === "es" ? p.text.es : p.text.en;
    const block = p.responseType === "draw" ? 130 : p.responseType === "checklist" ? 40 : 78;
    if (doc.y + block > bottom) return; // keep one student to one page; overflow trims gracefully
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(INK)
      .text(`${i + 1}.  ${promptText}`, { lineGap: 1.5 });
    doc.moveDown(0.2);
    doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(MUTED).text(responseLabel(p.responseType, input.language));
    doc.moveDown(0.2);

    if (p.responseType === "draw") {
      const top = doc.y;
      doc
        .rect(MARGIN, top, contentRight - MARGIN, 96)
        .strokeColor(RULE)
        .lineWidth(1)
        .stroke();
      doc.y = top + 96;
    } else if (p.responseType === "checklist") {
      const top = doc.y;
      doc.rect(MARGIN, top + 1, 12, 12).strokeColor(INK).lineWidth(1).stroke();
      doc.y = top + 16;
    } else {
      // write: three ruled lines
      let ly = doc.y + 4;
      for (let l = 0; l < 3; l++) {
        doc.moveTo(MARGIN, ly).lineTo(contentRight, ly).strokeColor(RULE).lineWidth(0.8).stroke();
        ly += 20;
      }
      doc.y = ly;
    }
    doc.moveDown(0.6);
  });
}

export async function renderPulseBrainLabWorksheetPdf(
  input: WorksheetPdfInput,
): Promise<Buffer> {
  if (input.students.length === 0) {
    throw new Error("renderPulseBrainLabWorksheetPdf: no students");
  }
  const doc = new PDFDocument({
    size: "LETTER",
    layout: "portrait",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    autoFirstPage: false,
    info: {
      Title: `${input.lesson.title} — PulseBrainLab Worksheet`,
      Author: "PulseEDU",
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  for (const student of input.students) {
    newPage(doc);
    await renderStudentPage(doc, input, student);
  }
  doc.end();
  return done;
}
