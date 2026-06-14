// Pickup car-tag PDF renderer. Mirrors the onboardingPdf pattern
// (pdfkit-based, returns Buffer) so we don't pull in a new renderer.
//
// Redesign (student-anchored alphanumeric codes):
//   - Each STUDENT owns ONE base number (e.g. 1001).
//   - Each authorized ADULT gets a letter suffix (1001A = Mom, 1001B = Dad).
//   - One machine-printed tag per (adult, student): student name, the big
//     bold BASE number, the adult's letter RINGED by software, the guardian
//     label, and a QR encoding the FULL code (1001C) so the curb camera /
//     keypad resolve ALL of that adult's kids at once.
//   - A separate per-family OFFICE REFERENCE STRIP lists a student's base +
//     every adult letter ("1001 — A Mom · B Dad · C Grandma") for the front
//     desk. The strip shows the local SIS id only — NEVER the FLEID.
//
// Restricted authorizations get a RED border + "RESTRICTED" badge so
// no one accidentally prints + hands out a no-contact tag.

import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface PickupTagInput {
  pickupNumber: string; // full code (base+letter), encoded in the QR
  baseNumber: string | null; // big number; falls back to pickupNumber
  letter: string | null; // ringed suffix; omitted for legacy bare numbers
  studentName: string;
  guardianLabel: string;
  restricted: boolean;
  schoolName: string;
}

export interface PickupOfficeStripAdult {
  letter: string | null;
  guardianLabel: string;
  restricted: boolean;
}

export interface PickupOfficeStripFamily {
  studentName: string;
  baseNumber: string;
  localSisId: string | null; // display ID — never the FLEID
  adults: PickupOfficeStripAdult[];
  schoolName: string;
}

const PAGE_MARGIN = 36;
const TAGS_PER_ROW = 2;
const TAGS_PER_COL = 2;
const PAGE_WIDTH = 612; // Letter, 8.5in x 72dpi
const PAGE_HEIGHT = 792;
const TAG_W = (PAGE_WIDTH - PAGE_MARGIN * 2) / TAGS_PER_ROW;
const TAG_H = (PAGE_HEIGHT - PAGE_MARGIN * 2) / TAGS_PER_COL;

const COLORS = {
  border: "#0f172a",
  restricted: "#b91c1c",
  text: "#0f172a",
  muted: "#64748b",
  number: "#1e3a8a",
};

export async function renderPickupTagsPdf(
  tags: PickupTagInput[],
): Promise<Buffer> {
  // QR encodes the FULL code (base+letter) so one scan resolves the adult.
  const qrPngByCode = new Map<string, Buffer>();
  for (const t of tags) {
    if (!qrPngByCode.has(t.pickupNumber)) {
      const png = await QRCode.toBuffer(t.pickupNumber, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 0,
        width: 200,
      });
      qrPngByCode.set(t.pickupNumber, png);
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: {
        top: PAGE_MARGIN,
        bottom: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      info: {
        Title: "PulseEDU Pickup Tags",
        Author: "PulseEDU",
        Subject: "Car-rider pickup tags",
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      tags.forEach((tag, idx) => {
        const slotOnPage = idx % (TAGS_PER_ROW * TAGS_PER_COL);
        if (idx > 0 && slotOnPage === 0) doc.addPage();
        const col = slotOnPage % TAGS_PER_ROW;
        const row = Math.floor(slotOnPage / TAGS_PER_ROW);
        const x = PAGE_MARGIN + col * TAG_W;
        const y = PAGE_MARGIN + row * TAG_H;
        drawTag(doc, x, y, tag, qrPngByCode.get(tag.pickupNumber)!);
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawTag(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  tag: PickupTagInput,
  qrPng: Buffer,
) {
  const pad = 12;
  const borderColor = tag.restricted ? COLORS.restricted : COLORS.border;
  doc
    .save()
    .lineWidth(tag.restricted ? 3 : 1.5)
    .strokeColor(borderColor)
    .roundedRect(x + 6, y + 6, TAG_W - 12, TAG_H - 12, 10)
    .stroke()
    .restore();

  // School name (small, top)
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(tag.schoolName, x + pad, y + pad + 4, {
      width: TAG_W - pad * 2,
      align: "center",
    });

  // Student name
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(COLORS.text)
    .text(tag.studentName, x + pad, y + pad + 22, {
      width: TAG_W - pad * 2,
      align: "center",
      ellipsis: true,
    });

  // Guardian label
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(COLORS.muted)
    .text(`Pickup: ${tag.guardianLabel}`, x + pad, y + pad + 42, {
      width: TAG_W - pad * 2,
      align: "center",
      ellipsis: true,
    });

  // Big base number + software-ringed letter, centered as one unit.
  const baseStr = tag.baseNumber ?? tag.pickupNumber;
  const letter = tag.letter ?? "";
  const numSize = 60;
  doc.font("Helvetica-Bold").fontSize(numSize);
  const baseW = doc.widthOfString(baseStr);
  const ringD = letter ? 46 : 0;
  const gap = letter ? 12 : 0;
  const totalW = baseW + gap + ringD;
  const startX = x + (TAG_W - totalW) / 2;
  const numY = y + TAG_H * 0.42 - numSize / 2;
  doc
    .font("Helvetica-Bold")
    .fontSize(numSize)
    .fillColor(COLORS.number)
    .text(baseStr, startX, numY, { lineBreak: false });
  if (letter) {
    // Ring the letter beside the base. Vertically centered on the digits'
    // optical middle (~0.36em below the text top for Helvetica caps).
    const ringCY = numY + numSize * 0.36;
    const ringCX = startX + baseW + gap + ringD / 2;
    doc
      .save()
      .lineWidth(3)
      .strokeColor(COLORS.number)
      .circle(ringCX, ringCY, ringD / 2)
      .stroke()
      .restore();
    const letterSize = 26;
    doc
      .font("Helvetica-Bold")
      .fontSize(letterSize)
      .fillColor(COLORS.number)
      .text(letter, ringCX - ringD / 2, ringCY - letterSize * 0.5, {
        width: ringD,
        align: "center",
        lineBreak: false,
      });
  }

  // QR — bottom center (encodes the FULL code).
  const qrSize = 84;
  const qrX = x + (TAG_W - qrSize) / 2;
  const qrY = y + TAG_H - qrSize - pad - 16;
  doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

  // QR caption
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor(COLORS.muted)
    .text("Scan or type code at the curb", x + pad, qrY + qrSize + 2, {
      width: TAG_W - pad * 2,
      align: "center",
    });

  if (tag.restricted) {
    doc
      .save()
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(COLORS.restricted)
      .text("RESTRICTED — NO-CONTACT", x + pad, y + pad + 60, {
        width: TAG_W - pad * 2,
        align: "center",
      })
      .restore();
  }
}

// ---------------------------------------------------------------------------
// Per-family OFFICE REFERENCE STRIP — a dense, cut-apart list for the front
// desk. One row per student: base number, name, local SIS id, and every
// authorized adult's letter + label. NEVER renders the FLEID.
// ---------------------------------------------------------------------------
const STRIP_LEFT = PAGE_MARGIN;
const STRIP_RIGHT = PAGE_WIDTH - PAGE_MARGIN;
const STRIP_WIDTH = STRIP_RIGHT - STRIP_LEFT;
const STRIP_ROW_H = 54;
const STRIP_TOP = PAGE_MARGIN + 28;

export async function renderPickupOfficeStripPdf(
  families: PickupOfficeStripFamily[],
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: {
        top: PAGE_MARGIN,
        bottom: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      info: {
        Title: "PulseEDU Pickup Office Reference",
        Author: "PulseEDU",
        Subject: "Car-rider pickup office reference strip",
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const schoolName = families[0]?.schoolName ?? "School";
      drawStripHeader(doc, schoolName);
      let y = STRIP_TOP;
      families.forEach((fam) => {
        if (y + STRIP_ROW_H > PAGE_HEIGHT - PAGE_MARGIN) {
          doc.addPage();
          drawStripHeader(doc, schoolName);
          y = STRIP_TOP;
        }
        drawStripRow(doc, y, fam);
        y += STRIP_ROW_H;
      });
      if (families.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(11)
          .fillColor(COLORS.muted)
          .text("No active pickup codes to list.", STRIP_LEFT, STRIP_TOP, {
            width: STRIP_WIDTH,
          });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawStripHeader(doc: PDFKit.PDFDocument, schoolName: string) {
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(COLORS.text)
    .text(`Pickup Office Reference — ${schoolName}`, STRIP_LEFT, PAGE_MARGIN, {
      width: STRIP_WIDTH,
    });
  doc
    .save()
    .lineWidth(1)
    .strokeColor(COLORS.muted)
    .moveTo(STRIP_LEFT, PAGE_MARGIN + 22)
    .lineTo(STRIP_RIGHT, PAGE_MARGIN + 22)
    .stroke()
    .restore();
}

function drawStripRow(
  doc: PDFKit.PDFDocument,
  y: number,
  fam: PickupOfficeStripFamily,
) {
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#e2e8f0")
    .moveTo(STRIP_LEFT, y + STRIP_ROW_H - 6)
    .lineTo(STRIP_RIGHT, y + STRIP_ROW_H - 6)
    .stroke()
    .restore();

  // Base number (left, bold)
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(COLORS.number)
    .text(fam.baseNumber, STRIP_LEFT, y + 6, { width: 70, lineBreak: false });

  const textX = STRIP_LEFT + 80;
  const textW = STRIP_WIDTH - 80;

  // Student name + SIS id
  const sis = fam.localSisId ? `  ·  SIS ${fam.localSisId}` : "";
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(COLORS.text)
    .text(fam.studentName, textX, y + 6, { width: textW, lineBreak: false });
  if (sis) {
    const nameW = doc.widthOfString(fam.studentName);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(sis, textX + nameW, y + 8, { lineBreak: false });
  }

  // Adults: "A Mom · B Dad · C Grandma"
  const adultsStr =
    fam.adults.length > 0
      ? fam.adults
          .map(
            (a) =>
              `${a.letter ?? "?"} ${a.guardianLabel}${
                a.restricted ? " (restricted)" : ""
              }`,
          )
          .join("   ·   ")
      : "No adults on file";
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(COLORS.text)
    .text(adultsStr, textX, y + 24, { width: textW, ellipsis: true });
}
