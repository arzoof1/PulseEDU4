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

const PAGE_MARGIN = 36; // used by the office-reference strip only
const PAGE_WIDTH = 612; // Letter, 8.5in x 72dpi
const PAGE_HEIGHT = 792;

// --- TG-0194 die-cut hang-tag stock geometry --------------------------------
// 6 tags per Letter sheet: 3 columns x 2 rows, each cell 204 x 396 pt
// (2.83in x 5.5in), edge-to-edge (no outer page margin). Each tag has a
// punched hanging hole centered near the top and a diagonal "shoulder" cut on
// the top-right corner. The numbers below were measured directly from the
// supplied TG-0194 template (Y measured DOWN from each cell's top edge).
const COLS = 3;
const ROWS = 2;
const CELL_W = PAGE_WIDTH / COLS; // 204
const CELL_H = PAGE_HEIGHT / ROWS; // 396
const TAGS_PER_PAGE = COLS * ROWS; // 6

const HOLE_CX = CELL_W / 2; // 102 — hole is horizontally centered
const HOLE_CY = 71.6; // hole center, from cell top
const HOLE_R = 34.9;
const SHOULDER_FROM = { x: 133.9, y: 88.16 }; // diagonal start (by the hole)
const SHOULDER_TO = { x: CELL_W, y: 128.6 }; // diagonal end (right cut edge)
// Reserve the whole top band (hole + diagonal shoulder) so nothing important
// is punched through or trimmed away.
const TOP_KEEPOUT = SHOULDER_TO.y + 10; // ~139
const SIDE_PAD = 16;
const BOTTOM_PAD = 16;

const COLORS = {
  border: "#0f172a",
  restricted: "#b91c1c",
  text: "#0f172a",
  muted: "#64748b",
  number: "#1e3a8a",
};

export async function renderPickupTagsPdf(
  tags: PickupTagInput[],
  opts: { drawGuides?: boolean } = {},
): Promise<Buffer> {
  // QR encodes the FULL code (base+letter) so one scan resolves the adult.
  const qrPngByCode = new Map<string, Buffer>();
  for (const t of tags) {
    if (!qrPngByCode.has(t.pickupNumber)) {
      const png = await QRCode.toBuffer(t.pickupNumber, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 0,
        width: 220,
      });
      qrPngByCode.set(t.pickupNumber, png);
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    // margin 0 — the die-cut cells run edge-to-edge, so a new page must not
    // inherit pdfkit's default 72pt margin (it would shift the whole grid).
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 0,
      info: {
        Title: "PulseEDU Pickup Tags",
        Author: "PulseEDU",
        Subject: "Car-rider pickup tags (TG-0194 hang-tag stock)",
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      tags.forEach((tag, idx) => {
        const slot = idx % TAGS_PER_PAGE;
        if (idx > 0 && slot === 0) doc.addPage();
        const col = slot % COLS;
        const row = Math.floor(slot / COLS);
        const cellX = col * CELL_W;
        const cellY = row * CELL_H;
        drawTag(
          doc,
          cellX,
          cellY,
          tag,
          qrPngByCode.get(tag.pickupNumber)!,
          !!opts.drawGuides,
        );
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawTag(
  doc: PDFKit.PDFDocument,
  cellX: number,
  cellY: number,
  tag: PickupTagInput,
  qrPng: Buffer,
  drawGuides: boolean,
) {
  // Optional die-cut guides (cut border, hole, diagonal shoulder). OFF for
  // pre-die-cut TG-0194 blanks; ON for proofing or for offices that print on
  // plain stock and trim by hand.
  if (drawGuides) {
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor("#94a3b8")
      .dash(2, { space: 1 });
    doc.rect(cellX, cellY, CELL_W, CELL_H).stroke();
    doc.circle(cellX + HOLE_CX, cellY + HOLE_CY, HOLE_R).stroke();
    doc
      .moveTo(cellX + SHOULDER_FROM.x, cellY + SHOULDER_FROM.y)
      .lineTo(cellX + SHOULDER_TO.x, cellY + SHOULDER_TO.y)
      .stroke();
    doc.undash().restore();
  }

  const bodyX = cellX + SIDE_PAD;
  const bodyW = CELL_W - SIDE_PAD * 2; // 172
  const bodyTop = cellY + TOP_KEEPOUT;
  const bodyBottom = cellY + CELL_H - BOTTOM_PAD;

  // School name (small)
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(tag.schoolName, bodyX, bodyTop, {
      width: bodyW,
      align: "center",
      ellipsis: true,
    });

  // Student name
  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .fillColor(COLORS.text)
    .text(tag.studentName, bodyX, bodyTop + 12, {
      width: bodyW,
      align: "center",
      ellipsis: true,
    });

  // Guardian label
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(COLORS.muted)
    .text(`Pickup: ${tag.guardianLabel}`, bodyX, bodyTop + 32, {
      width: bodyW,
      align: "center",
      ellipsis: true,
    });

  let labelsBottom = bodyTop + 50;
  if (tag.restricted) {
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(COLORS.restricted)
      .text("RESTRICTED — NO-CONTACT", bodyX, labelsBottom, {
        width: bodyW,
        align: "center",
      });
    labelsBottom += 16;
  }

  // QR — bottom center (encodes the FULL code).
  const qrSize = 92;
  const captionH = 10;
  const qrX = cellX + (CELL_W - qrSize) / 2;
  const qrY = bodyBottom - captionH - qrSize;
  doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor(COLORS.muted)
    .text("Scan or type at the curb", bodyX, qrY + qrSize + 2, {
      width: bodyW,
      align: "center",
    });

  // Big base number + software-ringed letter, auto-fit to the tag width and
  // centered in the space between the labels and the QR.
  const baseStr = tag.baseNumber ?? tag.pickupNumber;
  const letter = tag.letter ?? "";
  const ringRatio = 0.82;
  const gapRatio = 0.18;
  doc.font("Helvetica-Bold");
  let numSize = 58;
  for (; numSize >= 18; numSize -= 1) {
    doc.fontSize(numSize);
    const bw = doc.widthOfString(baseStr);
    const ringD = letter ? numSize * ringRatio : 0;
    const gap = letter ? numSize * gapRatio : 0;
    if (bw + gap + ringD <= bodyW) break;
  }
  doc.fontSize(numSize);
  const baseW = doc.widthOfString(baseStr);
  const ringD = letter ? numSize * ringRatio : 0;
  const gap = letter ? numSize * gapRatio : 0;
  const totalW = baseW + gap + ringD;
  const numRegionTop = labelsBottom;
  const numRegionBottom = qrY - 6;
  const numY =
    numRegionTop + Math.max(0, (numRegionBottom - numRegionTop - numSize) / 2);
  const startX = cellX + (CELL_W - totalW) / 2;
  doc
    .font("Helvetica-Bold")
    .fontSize(numSize)
    .fillColor(COLORS.number)
    .text(baseStr, startX, numY, { lineBreak: false });
  if (letter) {
    // Ring the letter beside the base, centered on the digits' optical middle
    // (~0.36em below the text top for Helvetica caps).
    const ringCY = numY + numSize * 0.36;
    const ringCX = startX + baseW + gap + ringD / 2;
    doc
      .save()
      .lineWidth(2.5)
      .strokeColor(COLORS.number)
      .circle(ringCX, ringCY, ringD / 2)
      .stroke()
      .restore();
    const letterSize = ringD * 0.62;
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

  // Restricted: red inner frame inside the safe area (never on the cut line).
  if (tag.restricted) {
    doc
      .save()
      .lineWidth(2)
      .strokeColor(COLORS.restricted)
      .roundedRect(
        cellX + 8,
        cellY + TOP_KEEPOUT - 6,
        CELL_W - 16,
        CELL_H - TOP_KEEPOUT - 2,
        6,
      )
      .stroke()
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
