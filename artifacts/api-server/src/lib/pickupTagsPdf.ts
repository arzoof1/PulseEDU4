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
// Tag stock (plain paper, cheap): one big tag per LANDSCAPE Letter sheet.
// The sheet is meant to be draped over a child's clothes hanger, folded on the
// top edge (the crease sits over the hanger's top bar like a shirt collar) and
// taped in place. To make the number readable from BOTH sides of the car line,
// the SAME content is printed on both halves of the sheet: the bottom half
// upright, the top half rotated 180° so that — once the top edge is folded down
// behind the hanger — it also reads right-side-up from the back. A dashed fold
// line + keep-out band keeps content off the crease that wraps the bar.
//
// Restricted authorizations get a RED border + "RESTRICTED" badge so
// no one accidentally prints + hands out a no-contact tag.

import PDFDocument from "pdfkit";
import QRCode from "qrcode";

// One sibling listed on a family tag.
export interface PickupFamilyTagStudent {
  name: string;
  grade: number | null; // students.grade (integer); <=0 renders as "K"
  restricted: boolean; // this adult is no-contact for THIS child
}

// ONE FAMILY TAG PER ADULT. The adult's representative code (base + ringed
// letter) is the hero of the sheet; every child that adult may pick up is
// listed with their grade. The QR encodes the full representative code so one
// scan/keystroke resolves ALL of that adult's kids at the curb (the curb
// resolver groups siblings by adultKey, so any one of the adult's codes works).
export interface PickupFamilyTagInput {
  pickupNumber: string; // representative full code (base+letter), encoded in QR
  baseNumber: string | null; // big number; falls back to pickupNumber
  letter: string | null; // ringed suffix; omitted for legacy bare numbers
  guardianLabel: string; // the adult this tag belongs to
  students: PickupFamilyTagStudent[]; // every child this adult picks up
  restrictedAll: boolean; // true only if the adult is no-contact for ALL kids
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

// --- Landscape fold-over-the-hanger tag geometry ----------------------------
// One tag per LANDSCAPE Letter sheet (792 x 612 pt). The page is split in half
// at the horizontal center (the FOLD). The bottom half holds the tag content
// upright; the top half holds the SAME content rotated 180° so that, once the
// top edge is folded down behind the hanger's top bar, both faces read upright
// (one on the front of the car line, one on the back). A keep-out band on each
// side of the fold keeps content off the crease that wraps the bar.
const LAND_W = 792; // landscape Letter width
const LAND_H = 612; // landscape Letter height
const PANEL_H = LAND_H / 2; // 306 — height of each (front/back) half
const FOLD_Y = PANEL_H; // 306 — the crease, vertically centered
const FOLD_KEEPOUT = 40; // clear band between the crease and content
const EDGE_PAD = 30; // padding at the outer (top/bottom) page edges
const SIDE_PAD = 46; // left/right padding inside a panel

const COLORS = {
  border: "#0f172a",
  restricted: "#b91c1c",
  text: "#0f172a",
  muted: "#64748b",
  number: "#1e3a8a",
};

export async function renderPickupTagsPdf(
  tags: PickupFamilyTagInput[],
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
        width: 240,
      });
      qrPngByCode.set(t.pickupNumber, png);
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const docOpts: PDFKit.PDFDocumentOptions = {
      size: "LETTER",
      layout: "landscape",
      margin: 0,
      info: {
        Title: "PulseEDU Pickup Tags",
        Author: "PulseEDU",
        Subject: "Car-rider pickup tags (fold-over hanger sheet)",
      },
    };
    const doc = new PDFDocument(docOpts);
    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      tags.forEach((tag, idx) => {
        if (idx > 0) doc.addPage(docOpts);
        drawTagSheet(
          doc,
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

// One full landscape sheet = bottom panel (upright) + top panel (rotated 180°)
// + the fold line. Both panels render identical content via drawPanel; the top
// one is rotated about its own center so it reads upright once folded behind
// the hanger.
function drawTagSheet(
  doc: PDFKit.PDFDocument,
  tag: PickupFamilyTagInput,
  qrPng: Buffer,
  drawGuides: boolean,
) {
  if (drawGuides) {
    // Optional outer trim border (plain-paper proof aid only).
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor("#cbd5e1")
      .dash(3, { space: 2 })
      .rect(8, 8, LAND_W - 16, LAND_H - 16)
      .stroke()
      .undash()
      .restore();
  }

  // Bottom panel — upright (front face).
  drawPanel(doc, 0, FOLD_Y, tag, qrPng);

  // Top panel — same content rotated 180° about the top panel's center so it
  // reads upright after the top edge folds down behind the hanger (back face).
  doc.save();
  doc.rotate(180, { origin: [LAND_W / 2, PANEL_H / 2] });
  drawPanel(doc, 0, 0, tag, qrPng);
  doc.restore();

  drawFoldLine(doc);
}

// Dashed crease + instruction, drawn upright across the page center.
function drawFoldLine(doc: PDFKit.PDFDocument) {
  doc
    .save()
    .lineWidth(0.75)
    .strokeColor(COLORS.muted)
    .dash(4, { space: 3 })
    .moveTo(0, FOLD_Y)
    .lineTo(LAND_W, FOLD_Y)
    .stroke()
    .undash()
    .restore();
  const label = "FOLD HERE  —  drape over the hanger's top bar and tape";
  doc.font("Helvetica").fontSize(8);
  const lw = doc.widthOfString(label);
  // Mask a gap in the dashes behind the centered label, then print it.
  doc
    .save()
    .fillColor("#ffffff")
    .rect(LAND_W / 2 - lw / 2 - 6, FOLD_Y - 6, lw + 12, 12)
    .fill()
    .restore();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(label, LAND_W / 2 - lw / 2, FOLD_Y - 4, { lineBreak: false });
}

// Draw the tag content upright inside a half-panel whose top-left corner is
// (ox, oy) and whose size is LAND_W x PANEL_H. The fold-keep-out band is always
// at the panel's TOP edge: for the bottom panel that is the crease; for the
// rotated top panel the 180° turn maps that same band back onto the crease too.
// Format a grade integer for the sibling list: <=0 is kindergarten ("K"),
// otherwise the plain number. Null (legacy/unknown) renders as a dash.
function gradeLabel(grade: number | null): string {
  if (grade === null) return "—";
  if (grade <= 0) return "K";
  return String(grade);
}

function drawPanel(
  doc: PDFKit.PDFDocument,
  ox: number,
  oy: number,
  tag: PickupFamilyTagInput,
  qrPng: Buffer,
) {
  const contentTop = oy + FOLD_KEEPOUT;
  const contentBottom = oy + PANEL_H - EDGE_PAD;
  const contentH = contentBottom - contentTop;

  // The alphanumeric CODE is the hero — it gets the entire left region at the
  // largest size that fits. A narrow right column carries the secondary detail
  // (school, the adult, the sibling list, and the QR). Keeping the right
  // column tight (just wide enough for the QR) maximizes the code's width.
  const rightW = 168;
  const rightX = ox + LAND_W - SIDE_PAD - rightW;
  const numLeft = ox + SIDE_PAD;
  const numRegionRight = rightX - 22;
  const numRegionW = numRegionRight - numLeft;

  // --- Right info column: school → adult → siblings (top), QR (bottom) ---
  let ry = contentTop;
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(COLORS.muted)
    .text(tag.schoolName, rightX, ry, {
      width: rightW,
      align: "center",
      ellipsis: true,
    });
  ry += 16;
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(COLORS.text)
    .text(tag.guardianLabel, rightX, ry, {
      width: rightW,
      align: "center",
      ellipsis: true,
    });
  ry += 20;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text("PICKS UP", rightX, ry, { width: rightW, align: "center" });
  ry += 13;

  // Sibling list — auto-shrink the line height so even a big family fits the
  // space between the "PICKS UP" header and the QR block.
  const qrSize = 120;
  const qrBlockH = qrSize + 14; // QR + caption
  const listTop = ry;
  const listBottom = contentBottom - qrBlockH - 6;
  const listH = Math.max(0, listBottom - listTop);
  const n = Math.max(1, tag.students.length);
  const lineH = Math.max(10, Math.min(15, listH / n));
  const listFont = Math.min(11, lineH - 2);
  tag.students.forEach((s, i) => {
    const ly = listTop + i * lineH;
    if (ly + lineH > listBottom + 0.5) return; // overflow guard (rare)
    const label = `${s.name}  (Gr ${gradeLabel(s.grade)})`;
    doc
      .font("Helvetica")
      .fontSize(listFont)
      .fillColor(s.restricted ? COLORS.restricted : COLORS.text)
      .text(s.restricted ? `${label}  NO-CONTACT` : label, rightX, ly, {
        width: rightW,
        align: "center",
        ellipsis: true,
        lineBreak: false,
      });
  });

  // QR + caption pinned to the bottom of the right column.
  const qrX = rightX + (rightW - qrSize) / 2;
  const qrY = contentBottom - 12 - qrSize;
  doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text("Scan or type this code at the curb", rightX, qrY + qrSize + 2, {
      width: rightW,
      align: "center",
    });

  // --- HERO: big base number + software-ringed letter (auto-fit) ---
  const baseStr = tag.baseNumber ?? tag.pickupNumber;
  const letter = tag.letter ?? "";
  const ringRatio = 0.84;
  const gapRatio = 0.16;
  const maxNumH = contentH * 0.94; // leave a little vertical breathing room
  doc.font("Helvetica-Bold");
  let numSize = 320;
  for (; numSize >= 28; numSize -= 2) {
    doc.fontSize(numSize);
    const bw = doc.widthOfString(baseStr);
    const ringD = letter ? numSize * ringRatio : 0;
    const gap = letter ? numSize * gapRatio : 0;
    if (bw + gap + ringD <= numRegionW && numSize <= maxNumH) break;
  }
  doc.fontSize(numSize);
  const baseW = doc.widthOfString(baseStr);
  const ringD = letter ? numSize * ringRatio : 0;
  const gap = letter ? numSize * gapRatio : 0;
  const totalW = baseW + gap + ringD;
  const numY = contentTop + Math.max(0, (contentH - numSize) / 2);
  const startX = numLeft + Math.max(0, (numRegionW - totalW) / 2);
  doc
    .font("Helvetica-Bold")
    .fontSize(numSize)
    .fillColor(COLORS.number)
    .text(baseStr, startX, numY, { lineBreak: false });
  if (letter) {
    const ringCY = numY + numSize * 0.36;
    const ringCX = startX + baseW + gap + ringD / 2;
    doc
      .save()
      .lineWidth(Math.max(3, numSize * 0.04))
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

  // Restricted: red frame + badge only when the adult is no-contact for EVERY
  // child (mixed families flag the affected child inline in the list instead).
  if (tag.restrictedAll) {
    doc
      .save()
      .lineWidth(2.5)
      .strokeColor(COLORS.restricted)
      .roundedRect(
        ox + 16,
        contentTop - 10,
        LAND_W - 32,
        contentBottom - contentTop + 20,
        8,
      )
      .stroke()
      .restore();
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(COLORS.restricted)
      .text("RESTRICTED — NO-CONTACT", numLeft, contentBottom - 14, {
        width: numRegionW,
        align: "center",
        lineBreak: false,
      });
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
