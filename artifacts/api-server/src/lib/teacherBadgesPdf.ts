// Per-teacher printable ID badge, single-sided (one badge = one page). This
// is the LANYARD-style staff counterpart to the student ID badge
// (studentIdBadgesPdf.ts) and shares its per-school CardDesign so a school's
// staff + student IDs read as one family. Unlike the student badge it ALSO
// carries a SCAN-ONLY hall-pass kiosk activation payload, so a single worn
// card both identifies the teacher AND activates their room kiosk:
//   • QR code  → `${baseUrl}?enroll=<token>` (phone camera / USB scanner)
//   • Code 128 → the raw enroll token (hardware laser/CCD scanner)
// The human-readable 6-digit PIN is intentionally NOT printed here — the
// badge activates a kiosk by scanning only. (A teacher who needs the typeable
// PIN reads it from the Hall Pass gear → "Get kiosk URL" tab; see
// GET /kiosk/my-pin.) The caller is still responsible for never persisting
// the raw token/PIN (only the hash lives in kiosk_enroll_tokens). There is
// NO FL HB 383 crisis line —
// that is a student-ID legal requirement, not a staff one. The teacher name
// splits onto two lines on the last space (first part bold over the rest).

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import { normalizeHex } from "./pdfColors";

// CR80 portrait lanyard — 2.125" × 3.375" at 72dpi (the portrait swap of the
// landscape CR80 used by student badges).
const CARD_W = 243; // long edge
const CARD_H = 153; // short edge
const PAGE_MARGIN = 8;

export interface TeacherBadgeInput {
  // Full staff display name (e.g. "Ms. Jane Johnson"). Split onto two lines
  // on the LAST space so the surname/last token drops below.
  teacherName: string;
  // Optional default room/location, rendered as the room icon row.
  room: string | null;
  schoolName: string;
  // The raw enroll token (encoded into the QR + Code 128). One-shot — never
  // persisted by this renderer.
  enrollToken: string;
  // The raw 6-digit PIN. Accepted for API contract parity with the kiosk
  // card/token modes, but NO LONGER rendered on the badge (scan-only). Same
  // one-shot rule — never persisted.
  pin: string;
  // Origin the kiosk lives at, e.g. "https://school.pulseedu.com/kiosk". The
  // QR encodes `${baseUrl}?enroll=${enrollToken}`.
  baseUrl: string;
  house?: {
    name: string;
    color: string;
    iconKey: string | null;
    // Optional admin-uploaded house logo bytes (PNG/JPEG/WebP). SVG filtered
    // out upstream (pdfkit can't rasterize it).
    logoBytes?: Buffer | null;
  } | null;
  // Optional square staff photo bytes. Null/undefined = initials disc.
  photoBytes?: Buffer | null;
  // Per-school card design (shared with student badges). When omitted the
  // badge falls back to the legacy look (house-colored region, no footer).
  design?: CardDesign | null;
}

// Per-school card design, identical shape to the student badge's CardDesign
// so both surfaces are fed by the same `buildCardDesign` helper.
export interface CardDesign {
  orientation: "landscape" | "portrait";
  bgMode: "colors" | "image";
  bgColors: string[];
  bgAngle: number;
  bgImageBytes?: Buffer | null;
  headerTextMode: "auto" | "manual";
  headerTextColor?: string | null;
  showHouse: boolean;
  houseBgMode: "house" | "white" | "custom";
  houseBgColor?: string | null;
  houseTextMode: "auto" | "manual";
  houseTextColor?: string | null;
}

// Legacy default used when a badge carries no design.
const LEGACY_DESIGN: CardDesign = {
  orientation: "portrait",
  bgMode: "colors",
  bgColors: [],
  bgAngle: 135,
  bgImageBytes: null,
  headerTextMode: "auto",
  headerTextColor: null,
  showHouse: true,
  houseBgMode: "house",
  houseBgColor: null,
  houseTextMode: "auto",
  houseTextColor: null,
};

export async function renderTeacherBadgesPdf(
  badges: TeacherBadgeInput[],
): Promise<Buffer> {
  // Small bottom margin: the layout positions every element absolutely and
  // the lowest element sits close to the page edge. A larger bottom margin
  // would push pdfkit to auto-page when text crosses (pageHeight -
  // bottomMargin). These margins MUST be passed to every addPage() too.
  const margins = {
    top: PAGE_MARGIN,
    bottom: 2,
    left: PAGE_MARGIN,
    right: PAGE_MARGIN,
  };
  // Always portrait (lanyard). Page is the portrait swap of the CR80.
  const size: [number, number] = [CARD_H, CARD_W];
  const doc = new PDFDocument({
    size,
    margins,
    info: { Title: "Teacher ID Badges" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  for (let i = 0; i < badges.length; i++) {
    if (i > 0) doc.addPage({ size, margins });
    await renderTeacherBadge(doc, badges[i]!);
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Portrait lanyard badge (153 × 243):
//   [ lanyard slot hole, centered at the top ]
//   [ diagonal school-color corner ribbons (colors mode) OR top banner image ]
//   centered school name + divider diamond
//   square photo (left) · QR on a WHITE plate (right)
//   icon rows: teacher name (two lines) · room (when present)
//   "Scan to activate kiosk" hint under the QR
//   optional house emblem + "HOUSE NAME" band
//   full-width Code 128 barcode (the enroll token) BELOW the band
// ---------------------------------------------------------------------------
async function renderTeacherBadge(
  doc: PDFKit.PDFDocument,
  badge: TeacherBadgeInput,
) {
  const W = CARD_H; // 153
  const H = CARD_W; // 243
  const design = badge.design ?? LEGACY_DESIGN;
  const houseColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";
  const M = PAGE_MARGIN;

  const topColors =
    design.bgColors.length > 0
      ? design.bgColors.map((c) => normalizeHex(c))
      : [houseColor];
  const c0 = topColors[0] ?? houseColor;
  const c1 = topColors[1] ?? c0;
  const usingImage = design.bgMode === "image" && !!design.bgImageBytes;

  // A dark ink derived from the school colors, used for icon discs and labels
  // so they read on white. Falls back to slate.
  const ink = !isLight(c0) ? c0 : !isLight(c1) ? c1 : "#0f172a";

  // Photo + QR geometry, declared up-front so image-mode bg can extend down to
  // cover this row.
  const photoX = 12;
  const photoY = 52;
  const photoW = 60;
  const photoH = 60;
  const qrSize = 60;
  const qrPad = 3;
  const qrX = W - 12 - qrSize;
  const qrY = 52;

  // White card body + outline.
  doc
    .save()
    .fillColor("#ffffff")
    .roundedRect(2, 2, W - 4, H - 4, 6)
    .fill()
    .restore();

  // Clip everything to the rounded card so ribbons / banner never spill.
  doc.save();
  doc.roundedRect(2, 2, W - 4, H - 4, 6).clip();

  if (usingImage) {
    const imgH = photoY + photoH + 6 - 2;
    try {
      doc.image(design.bgImageBytes as Buffer, 2, 2, {
        width: W - 4,
        height: imgH,
        cover: [W - 4, imgH],
        align: "center",
        valign: "center",
      });
    } catch {
      doc.rect(2, 2, W - 4, imgH).fill(c0);
    }
    doc.save();
    doc.fillOpacity(0.4).fillColor("#000000").rect(2, 2, W - 4, 46).fill();
    doc.restore();
  } else {
    drawCornerRibbon(doc, "left", W, 56, c1);
    drawCornerRibbon(doc, "left", W, 40, c0);
    drawCornerRibbon(doc, "right", W, 56, c1);
    drawCornerRibbon(doc, "right", W, 40, c0);
  }
  doc.restore();

  // Lanyard slot — a rounded "punch" hole centered at the top.
  const slotW = 34;
  const slotH = 7;
  doc
    .save()
    .fillColor("#ffffff")
    .roundedRect(W / 2 - slotW / 2, 8, slotW, slotH, slotH / 2)
    .fill()
    .lineWidth(0.8)
    .strokeColor("#94a3b8")
    .roundedRect(W / 2 - slotW / 2, 8, slotW, slotH, slotH / 2)
    .stroke()
    .restore();

  // School name — centered.
  const autoHeaderText = usingImage ? "#ffffff" : readableTextOn("#ffffff");
  const headerText =
    design.headerTextMode === "manual" && design.headerTextColor
      ? normalizeHex(design.headerTextColor)
      : autoHeaderText;
  doc.fillColor(headerText).fontSize(13);
  doc.text(fitText(doc, badge.schoolName.toUpperCase(), W - M * 2), M, 24, {
    width: W - M * 2,
    align: "center",
    lineBreak: false,
  });

  // Divider with a center diamond (colors mode only).
  if (!usingImage) {
    const dy = 45;
    const dw = 44;
    doc
      .save()
      .lineWidth(0.8)
      .strokeColor(c1)
      .moveTo(W / 2 - dw, dy)
      .lineTo(W / 2 - 6, dy)
      .moveTo(W / 2 + 6, dy)
      .lineTo(W / 2 + dw, dy)
      .stroke();
    doc
      .fillColor(c1)
      .moveTo(W / 2, dy - 3)
      .lineTo(W / 2 + 3, dy)
      .lineTo(W / 2, dy + 3)
      .lineTo(W / 2 - 3, dy)
      .closePath()
      .fill()
      .restore();
  }

  // --- Photo (left) + QR plate (right) ---------------------------------
  drawPhotoRect(
    doc,
    badge,
    photoX,
    photoY,
    photoW,
    photoH,
    usingImage ? "#ffffff" : "#e2e8f0",
  );

  doc
    .save()
    .fillColor("#ffffff")
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(qrX - qrPad, qrY - qrPad, qrSize + qrPad * 2, qrSize + qrPad * 2, 5)
    .fillAndStroke()
    .restore();
  const qrBuf = await renderEnrollQrBuffer(badge);
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
  // "Scan to activate kiosk" hint directly under the QR plate.
  doc
    .fillColor("#475569")
    .font("Helvetica")
    .fontSize(6);
  doc.text(
    fitText(doc, "Scan to activate kiosk", qrSize + qrPad * 2),
    qrX - qrPad,
    qrY + qrSize + qrPad + 1,
    { width: qrSize + qrPad * 2, align: "center", lineBreak: false },
  );

  // --- Bottom-anchored elements (barcode, house band) -----------------
  const bcH = 22;
  const bcY = H - 2 - bcH;
  const showFooter = design.showHouse && !!badge.house;
  const bandH = 24;
  const bandY = showFooter ? bcY - 4 - bandH : bcY;

  // --- Icon rows fill the middle, between the photo/QR row and the house
  // band / barcode. The human-readable PIN strip was removed (badge is
  // scan-only), so the rows extend all the way down to the band/barcode.
  const rowsTop = Math.max(photoY + photoH, qrY + qrSize) + 12;
  const rowsBottom = (showFooter ? bandY : bcY) - 6;

  type IconRow = {
    kind: "person" | "room";
    text: string;
    firstLine?: string;
    secondLine?: string;
  };
  const rows: IconRow[] = [];
  const { firstLine, secondLine } = splitNameOnLastSpace(badge.teacherName);
  rows.push({
    kind: "person",
    text: badge.teacherName.trim() || "Staff",
    firstLine,
    secondLine,
  });
  if (badge.room && badge.room.trim()) {
    rows.push({ kind: "room", text: `Room ${badge.room.trim()}` });
  }

  const slotCount = Math.max(rows.length, 1);
  const slot = (rowsBottom - rowsTop) / slotCount;
  const discR = Math.min(10, slot / 2 - 2);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const cy = rowsTop + slot * (i + 0.5);
    const discCx = M + 6 + discR;
    doc.save().fillColor(ink).circle(discCx, cy, discR).fill().restore();
    if (row.kind === "room") {
      drawRoomIcon(doc, discCx, cy, discR, "#ffffff");
    } else {
      drawTeacherIcon(doc, discCx, cy, discR, "#ffffff");
    }
    const textRight = W - M - 4;
    const textX = discCx + discR + 7;
    const labelW = Math.max(20, textRight - textX);
    if (row.kind === "person" && (row.firstLine || row.secondLine)) {
      const firstFs = 11;
      const lastFs = firstFs - 2;
      const second = (row.secondLine || "").trim();
      const totalH = second ? firstFs + 1 + lastFs : firstFs;
      drawTwoLineName(
        doc,
        (row.firstLine || "").toUpperCase(),
        second.toUpperCase(),
        textX,
        cy - totalH / 2,
        labelW,
        { firstFs, lastFs, color: "#1f2937" },
      );
    } else {
      const labelFs = 9.5;
      doc.fillColor("#1f2937").font("Helvetica").fontSize(labelFs);
      doc.text(fitText(doc, row.text.toUpperCase(), labelW), textX, cy - 6, {
        width: labelW,
        lineBreak: false,
      });
    }
    if (i < rows.length - 1) {
      doc
        .save()
        .lineWidth(0.4)
        .strokeColor("#e2e8f0")
        .moveTo(M + 2, rowsTop + slot * (i + 1))
        .lineTo(W - M - 2, rowsTop + slot * (i + 1))
        .stroke()
        .restore();
    }
  }

  // --- Optional house emblem + "HOUSE NAME" band -----------------------
  if (showFooter && badge.house) {
    const footerBg =
      design.houseBgMode === "white"
        ? "#ffffff"
        : design.houseBgMode === "custom" && design.houseBgColor
          ? normalizeHex(design.houseBgColor)
          : houseColor;
    const footerText =
      design.houseTextMode === "manual" && design.houseTextColor
        ? normalizeHex(design.houseTextColor)
        : readableTextOn(footerBg);
    doc
      .save()
      .fillColor(footerBg)
      .roundedRect(M, bandY, W - M * 2, bandH, 4)
      .fill();
    if (footerBg === "#ffffff") {
      doc
        .lineWidth(0.5)
        .strokeColor("#cbd5e1")
        .roundedRect(M, bandY, W - M * 2, bandH, 4)
        .stroke();
    }
    doc.restore();
    const emSize = bandH - 6;
    drawHouseEmblem(
      doc,
      badge,
      M + 4,
      bandY + 3,
      emSize,
      footerBg === "#ffffff" ? houseColor : footerBg,
    );
    const houseW = W - M * 2 - emSize - 12;
    doc.fillColor(footerText).fontSize(11);
    doc.text(
      fitText(doc, `HOUSE ${badge.house.name.toUpperCase()}`, houseW),
      M + emSize + 8,
      bandY + (bandH - 11) / 2,
      { width: houseW, align: "center", lineBreak: false },
    );
  }

  // --- Full-width Code 128 barcode (the enroll token) ------------------
  const barcodePng = await renderBarcodeBuffer(badge.enrollToken);
  doc.image(barcodePng, M, bcY, { width: W - M * 2, height: bcH });
}

// Split a display name onto two lines on the LAST space — the part before the
// last space goes on line one, the final token below. Single-token names get
// the whole name on line one (no second line). Mirrors the student badge's
// first-over-last two-line treatment but works from a single display string.
function splitNameOnLastSpace(name: string): {
  firstLine: string;
  secondLine: string;
} {
  const trimmed = (name || "").trim();
  const idx = trimmed.lastIndexOf(" ");
  if (idx <= 0) return { firstLine: trimmed, secondLine: "" };
  return {
    firstLine: trimmed.slice(0, idx).trim(),
    secondLine: trimmed.slice(idx + 1).trim(),
  };
}

// Truncate `text` with an ellipsis so it always fits on ONE line within
// `maxW`. Measured with the doc's CURRENT font + size.
function fitText(doc: PDFKit.PDFDocument, text: string, maxW: number): string {
  if (doc.widthOfString(text) <= maxW) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// Draw a name on TWO lines — the first part (bold, larger) over the second
// (regular, smaller). Returns total height drawn. Restores default Helvetica.
function drawTwoLineName(
  doc: PDFKit.PDFDocument,
  firstName: string,
  lastName: string,
  x: number,
  y: number,
  maxW: number,
  opts: {
    firstFs: number;
    lastFs: number;
    color: string;
    align?: "left" | "center";
    lineGap?: number;
  },
): number {
  const { firstFs, lastFs, color, align = "left", lineGap = 1 } = opts;
  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  doc.fillColor(color);
  let cursorY = y;
  if (first) {
    doc.font("Helvetica-Bold").fontSize(firstFs);
    doc.text(fitText(doc, first, maxW), x, cursorY, {
      width: maxW,
      align,
      lineBreak: false,
    });
    cursorY += firstFs + lineGap;
  }
  if (last) {
    doc.font("Helvetica").fontSize(lastFs);
    doc.text(fitText(doc, last, maxW), x, cursorY, {
      width: maxW,
      align,
      lineBreak: false,
    });
    cursorY += lastFs + lineGap;
  }
  doc.font("Helvetica");
  return cursorY - y;
}

// One diagonal corner ribbon = a right triangle anchored in a top corner.
function drawCornerRibbon(
  doc: PDFKit.PDFDocument,
  corner: "left" | "right",
  W: number,
  size: number,
  color: string,
): void {
  doc.save().fillColor(color);
  if (corner === "left") {
    doc.moveTo(2, 2).lineTo(2 + size, 2).lineTo(2, 2 + size).closePath().fill();
  } else {
    doc
      .moveTo(W - 2, 2)
      .lineTo(W - 2 - size, 2)
      .lineTo(W - 2, 2 + size)
      .closePath()
      .fill();
  }
  doc.restore();
}

// Person + mortarboard cap — the teacher icon row.
function drawTeacherIcon(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  doc.save().fillColor(color);
  const headR = r * 0.3;
  const headCy = cy - r * 0.18;
  doc.circle(cx, headCy, headR).fill();
  const cw = r * 0.95;
  const capY = cy - r * 0.62;
  doc
    .moveTo(cx, capY - r * 0.16)
    .lineTo(cx + cw, capY)
    .lineTo(cx, capY + r * 0.16)
    .lineTo(cx - cw, capY)
    .closePath()
    .fill();
  const bw = r * 0.95;
  const bh = r * 0.46;
  const bx = cx - bw / 2;
  const by = cy + r * 0.16;
  doc.moveTo(bx, by + bh).lineTo(bx, by + bh * 0.5);
  doc.quadraticCurveTo(bx, by, bx + bw / 2, by);
  doc.quadraticCurveTo(bx + bw, by, bx + bw, by + bh * 0.5);
  doc.lineTo(bx + bw, by + bh).closePath().fill();
  doc.restore();
}

// Small door glyph — the room icon row.
function drawRoomIcon(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  doc.save();
  const w = r * 1.0;
  const h = r * 1.3;
  const x = cx - w / 2;
  const y = cy - h / 2;
  doc.lineWidth(Math.max(0.8, r * 0.16)).strokeColor(color);
  doc.roundedRect(x, y, w, h, r * 0.12).stroke();
  // Door knob.
  doc.fillColor(color).circle(x + w * 0.74, cy, Math.max(0.7, r * 0.12)).fill();
  doc.restore();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return { r: 15, g: 23, b: 42 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function isLight(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

function readableTextOn(hexBg: string): string {
  return isLight(hexBg) ? "#111827" : "#ffffff";
}

// House emblem: uploaded logo (rounded-rect clipped) if we have bytes,
// otherwise a white disc with the house's first letter in the house color.
function drawHouseEmblem(
  doc: PDFKit.PDFDocument,
  badge: TeacherBadgeInput,
  x: number,
  y: number,
  size: number,
  houseColor: string,
): void {
  const logo = badge.house?.logoBytes;
  doc
    .save()
    .fillColor("#ffffff")
    .roundedRect(x, y, size, size, 4)
    .fill()
    .restore();
  if (logo) {
    try {
      const pad = 2;
      doc.save();
      doc.roundedRect(x + pad, y + pad, size - pad * 2, size - pad * 2, 3).clip();
      doc.image(logo, x + pad, y + pad, {
        width: size - pad * 2,
        height: size - pad * 2,
        cover: [size - pad * 2, size - pad * 2],
        align: "center",
        valign: "center",
      });
      doc.restore();
      return;
    } catch {
      // Corrupt image — fall through to letter fallback.
    }
  }
  const letter = (badge.house?.name.charAt(0) || "H").toUpperCase();
  doc
    .fillColor(houseColor)
    .fontSize(Math.round(size * 0.55))
    .text(letter, x, y + size / 2 - Math.round(size * 0.32), {
      width: size,
      align: "center",
      lineBreak: false,
    });
}

// Rectangular photo slot: rounded-rect-clipped photo when present, otherwise
// a colored tile with the teacher's initials.
function drawPhotoRect(
  doc: PDFKit.PDFDocument,
  badge: TeacherBadgeInput,
  x: number,
  y: number,
  w: number,
  h: number,
  frameColor: string,
): void {
  if (badge.photoBytes) {
    doc
      .save()
      .lineWidth(2)
      .strokeColor(frameColor)
      .roundedRect(x - 1, y - 1, w + 2, h + 2, 5)
      .stroke()
      .restore();
    try {
      doc.save();
      doc.roundedRect(x, y, w, h, 4).clip();
      doc.image(badge.photoBytes, x, y, {
        width: w,
        height: h,
        cover: [w, h],
        align: "center",
        valign: "center",
      });
      doc.restore();
      return;
    } catch {
      doc.restore?.();
      // Corrupt image — fall through to initials.
    }
  }
  const bgColor = frameColor === "#ffffff" ? "#e2e8f0" : frameColor;
  doc
    .save()
    .fillColor(bgColor)
    .roundedRect(x, y, w, h, 4)
    .fill()
    .restore();
  const initials = computeInitials(badge);
  const textColor = frameColor === "#ffffff" ? "#475569" : "#ffffff";
  const fs = Math.round(Math.min(w, h) * 0.42);
  doc
    .fillColor(textColor)
    .fontSize(fs)
    .text(initials, x, y + h / 2 - Math.round(fs * 0.55), {
      width: w,
      align: "center",
      lineBreak: false,
    });
}

// Initials from the teacher display name — first letter of the first one or
// two whitespace-separated tokens.
function computeInitials(badge: TeacherBadgeInput): string {
  const parts = (badge.teacherName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return `${first}${last}`.toUpperCase() || "?";
}

async function renderEnrollQrBuffer(badge: TeacherBadgeInput): Promise<Buffer> {
  const qrUrl = `${badge.baseUrl}?enroll=${encodeURIComponent(badge.enrollToken)}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    margin: 1,
    width: 280,
    errorCorrectionLevel: "M",
  });
  return Buffer.from(qrDataUrl.split(",")[1], "base64");
}

async function renderBarcodeBuffer(enrollToken: string): Promise<Buffer> {
  return bwipjs.toBuffer({
    bcid: "code128",
    text: enrollToken,
    scale: 3,
    height: 16,
    includetext: false,
    paddingwidth: 4,
    paddingheight: 4,
    backgroundcolor: "FFFFFF",
  });
}
