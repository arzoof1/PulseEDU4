// Per-student printable ID badges. Two physical sizes, both single-sided
// (one badge = one page), visually consistent:
//   - "lanyard": portrait 3.375" × 4.25" (standard lanyard ID).
//   - "cr80":    landscape 3.375" × 2.125" (credit-card ID).
// Each badge carries: square student photo (or initials fallback), house
// color block + uploaded house logo (or initials disc fallback), house
// name, school name, student name, "Grade N · Car Rider" line, QR (links
// to kiosk sign-in), Code 128 barcode, and the two FL HB 383 crisis
// hotlines (988 + Crisis Text Line 741741).

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import { normalizeHex } from "./pdfColors";

export type BadgeSize = "lanyard" | "cr80";

// Portrait lanyard ID — 3.375" × 4.25" at 72dpi
const LANYARD_W = 243;
const LANYARD_H = 306;
// Landscape CR80 — 3.375" × 2.125" at 72dpi
const CR80_W = 243;
const CR80_H = 153;

const PAGE_MARGIN = 10;

export interface StudentBadgeInput {
  studentId: string;
  // District-level Local SIS id (the human-facing id students scan/type at
  // the kiosk). The visible "ID" line, the QR, and the Code128 barcode all
  // encode this — the internal FLEID-style student_id never reaches a
  // student. Falls back to student_id only if a row is missing its SIS id.
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number | null;
  // End-of-day dismissal mode. Rendered as a human label next to grade.
  dismissalMode?: string | null;
  schoolName: string;
  // QR points to: `${baseUrl}?signin=<localSisId>` — the kiosk reads
  // `?signin=…` and pre-fills the sign-in field with the same Local SIS id
  // students type on the keypad.
  baseUrl: string;
  house?: {
    name: string;
    color: string;
    iconKey: string | null;
    // Optional admin-uploaded house logo bytes (PNG/JPEG/WebP). When
    // present, rendered in the house emblem slot instead of the
    // initials disc. SVG is filtered out upstream because pdfkit
    // can't rasterize it.
    logoBytes?: Buffer | null;
  } | null;
  // Optional square student photo bytes — when present we render a
  // square photo in the photo slot. Null/undefined = colored initials
  // disc fallback.
  photoBytes?: Buffer | null;
}

// Human label for a stored dismissal_mode value. `car_rider` is rendered
// as a small vector car icon instead of text (see drawCarIcon) because
// the words wouldn't fit cleanly on the CR80 layout next to a Grade label.
function dismissalLabel(mode: string | null | undefined): string | null {
  if (!mode) return null;
  switch (mode) {
    case "car_rider": return null; // drawn as an icon, not text
    case "walker": return "Walker";
    case "bus": return "Bus";
    case "aftercare": return "Aftercare";
    case "parent_pickup_only": return "Parent Pickup";
    default: return null;
  }
}

// Tiny side-profile car icon — body + roof + two wheels. Used in place of
// the "Car Rider" text on student ID badges so the dismissal mode reads at
// a glance without crowding the Grade label.
function drawCarIcon(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  color: string,
): void {
  // width drives everything; height is ~55% of width for a car silhouette.
  const w = width;
  const h = w * 0.55;
  const bodyTop = y + h * 0.35;
  const bodyH = h * 0.45;
  const wheelR = h * 0.18;
  const wheelY = y + h - wheelR;
  doc.save();
  doc.fillColor(color);
  // Lower body (rounded rect)
  doc.roundedRect(x, bodyTop, w, bodyH, h * 0.12).fill();
  // Roof (trapezoid via polygon)
  const roofLeftBottom = x + w * 0.22;
  const roofRightBottom = x + w * 0.78;
  const roofLeftTop = x + w * 0.34;
  const roofRightTop = x + w * 0.66;
  doc
    .moveTo(roofLeftBottom, bodyTop + 0.5)
    .lineTo(roofLeftTop, y + h * 0.08)
    .lineTo(roofRightTop, y + h * 0.08)
    .lineTo(roofRightBottom, bodyTop + 0.5)
    .closePath()
    .fill();
  // Wheels — drawn over the body in the same color so they read as one
  // shape; a thin contrast disc inside makes the wheel hub visible.
  doc.circle(x + w * 0.25, wheelY, wheelR).fill();
  doc.circle(x + w * 0.75, wheelY, wheelR).fill();
  doc.fillColor("#ffffff");
  doc.circle(x + w * 0.25, wheelY, wheelR * 0.4).fill();
  doc.circle(x + w * 0.75, wheelY, wheelR * 0.4).fill();
  doc.restore();
}

export async function renderStudentBadgesPdf(
  badges: StudentBadgeInput[],
  size: BadgeSize = "lanyard",
): Promise<Buffer> {
  const [W, H] = size === "cr80" ? [CR80_W, CR80_H] : [LANYARD_W, LANYARD_H];
  const doc = new PDFDocument({
    size: [W, H],
    // Bottom margin intentionally small — the badge layout positions
    // every element absolutely and the crisis hotline lines sit almost
    // flush against the page edge. A larger bottom margin would push
    // pdfkit to auto-page when text crosses (pageHeight - bottomMargin).
    margins: {
      top: PAGE_MARGIN,
      bottom: 2,
      left: PAGE_MARGIN,
      right: PAGE_MARGIN,
    },
    info: { Title: "Student ID Badges" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  for (let i = 0; i < badges.length; i++) {
    if (i > 0) doc.addPage({ size: [W, H] });
    if (size === "cr80") {
      await renderCr80Badge(doc, badges[i]);
    } else {
      await renderLanyardBadge(doc, badges[i]);
    }
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Lanyard (portrait 243 × 306)
//
// Layout, top to bottom:
//   [ house-color band, 56pt tall ]
//     house logo (square, 32×32) at left, white if no upload
//     "House Name"  in white on band
//     "School Name" in faint white under house name
//   [ square photo, 96×96, centered, framed in house color ]
//   "First Last" (14pt)  · "Grade N · Car Rider" (9pt)
//   QR (60×60, centered) → Code 128 barcode → crisis lines (988 / 741741)
// ---------------------------------------------------------------------------
async function renderLanyardBadge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const W = LANYARD_W;
  const H = LANYARD_H;
  const houseColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";

  // Card outline
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(2, 2, W - 4, H - 4, 8)
    .stroke()
    .restore();

  // Top color band
  const bandH = 56;
  doc
    .save()
    .fillColor(houseColor)
    .roundedRect(2, 2, W - 4, bandH, 8)
    .fill()
    .restore();
  // Square the bottom edge of the band so it butts cleanly against the
  // photo area (the roundedRect rounds all corners; we paint a small
  // rect over the bottom-rounded portion to flatten it).
  doc
    .save()
    .fillColor(houseColor)
    .rect(2, bandH - 6, W - 4, 8)
    .fill()
    .restore();

  // House emblem (top-left on band) — uploaded logo if we have it,
  // else white disc with first letter in house color.
  const logoSize = 32;
  const logoX = 10;
  const logoY = (bandH - logoSize) / 2 + 2;
  drawHouseEmblem(doc, badge, logoX, logoY, logoSize, houseColor);

  // House name + school, stacked right of the emblem on the band.
  const labelX = logoX + logoSize + 8;
  const labelW = W - labelX - 8;
  if (badge.house) {
    doc
      .fillColor("#ffffff")
      .fontSize(13)
      .text(`${badge.house.name} House`, labelX, 10, {
        width: labelW,
        ellipsis: true,
        lineBreak: false,
      });
    doc
      .fillColor("rgba(255,255,255,0.88)")
      .fontSize(8.5)
      .text(badge.schoolName, labelX, 28, {
        width: labelW,
        ellipsis: true,
        height: 24,
      });
  } else {
    doc
      .fillColor("#ffffff")
      .fontSize(12)
      .text("Student ID", labelX, 12, {
        width: labelW,
        lineBreak: false,
      });
    doc
      .fillColor("rgba(255,255,255,0.88)")
      .fontSize(8.5)
      .text(badge.schoolName, labelX, 30, {
        width: labelW,
        ellipsis: true,
        height: 22,
      });
  }

  // Square photo slot (centered under the band) — sized to roughly double
  // the area of the original 96pt slot. To make room, the QR/barcode block
  // below tightens up (smaller QR, less padding) so the badge still fits
  // the 306pt lanyard height with the FL HB 383 crisis lines intact.
  const photoSize = 130;
  const photoX = (W - photoSize) / 2;
  const photoY = bandH + 8;
  drawPhotoSlot(doc, badge, photoX, photoY, photoSize, houseColor);

  // Name
  const nameY = photoY + photoSize + 4;
  doc
    .fillColor("#111827")
    .fontSize(14)
    .text(`${badge.firstName} ${badge.lastName}`, PAGE_MARGIN, nameY, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      ellipsis: true,
      height: 18,
    });

  // Grade · Dismissal mode. Car riders get a small car icon to the right
  // of the Grade text (the words "Car Rider" don't fit cleanly on a CR80
  // badge so the lanyard mirrors the same convention for consistency).
  const dLabel = dismissalLabel(badge.dismissalMode);
  const isCarRider = badge.dismissalMode === "car_rider";
  const gradeBits: string[] = [];
  if (badge.grade !== null) gradeBits.push(`Grade ${badge.grade}`);
  if (dLabel) gradeBits.push(dLabel);
  const gradeY = nameY + 17;
  if (gradeBits.length > 0 || isCarRider) {
    const text = gradeBits.join(" · ");
    doc.fillColor("#475569").fontSize(9);
    const iconW = 18;
    const iconH = iconW * 0.55;
    const gap = text ? 4 : 0;
    const textW = text ? doc.widthOfString(text) : 0;
    const totalW = textW + (isCarRider ? gap + iconW : 0);
    const startX = PAGE_MARGIN + (W - PAGE_MARGIN * 2 - totalW) / 2;
    if (text) {
      doc.text(text, startX, gradeY, { lineBreak: false });
    }
    if (isCarRider) {
      drawCarIcon(doc, startX + textW + gap, gradeY + (9 - iconH) / 2, iconW, "#475569");
    }
  }

  // QR + barcode + crisis lines, anchored to the bottom of the card so
  // the layout stays stable as the photo / name area flex. Tightened in
  // step with the larger photo above to keep the bottom crisis line on
  // the card.
  const qrSize = 44;
  const qrX = (W - qrSize) / 2;
  const qrY = nameY + 22;
  const qrBuf = await renderQrBuffer(badge);
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  const barcodePng = await renderBarcodeBuffer(badge.localSisId ?? badge.studentId);
  const bcW = W - PAGE_MARGIN * 2 - 30;
  const bcH = 14;
  const bcX = (W - bcW) / 2;
  const bcY = qrY + qrSize + 3;
  doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });

  // Crisis hotlines — FL HB 383 (effective 2021-07-01) requires
  // 988 + a text crisis line on student IDs grades 6-12.
  const crisisY1 = bcY + bcH + 5;
  doc
    .fillColor("#b91c1c")
    .fontSize(7)
    .text("Crisis? Call or text 988", PAGE_MARGIN, crisisY1, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      lineBreak: false,
    });
  doc
    .fillColor("#475569")
    .fontSize(7)
    .text("Crisis Text Line: text HOME to 741741", PAGE_MARGIN, crisisY1 + 10, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      lineBreak: false,
    });
}

// ---------------------------------------------------------------------------
// CR80 (landscape 243 × 153)
//
// Layout: full-card house-color background, with a white rounded "card"
// inset on the RIGHT for QR + barcode + crisis lines. Left side carries
// the house logo, house name, school name, square photo, student name,
// and grade · dismissal — matching the user's mock visually but with all
// content on a single side.
// ---------------------------------------------------------------------------
async function renderCr80Badge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const W = CR80_W;
  const H = CR80_H;
  const houseColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";

  // Card outline
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(2, 2, W - 4, H - 4, 6)
    .stroke()
    .restore();

  // Left house-color zone (≈ 60% of width)
  const leftW = 148;
  doc
    .save()
    .fillColor(houseColor)
    .roundedRect(2, 2, leftW, H - 4, 6)
    .fill()
    .restore();
  // Square the right edge of the band so it butts against the white
  // right-hand zone cleanly.
  doc
    .save()
    .fillColor(houseColor)
    .rect(leftW - 4, 2, 6, H - 4)
    .fill()
    .restore();

  // House emblem (top-left)
  const logoSize = 28;
  const logoX = 8;
  const logoY = 8;
  drawHouseEmblem(doc, badge, logoX, logoY, logoSize, houseColor);

  // House name + school next to the emblem
  const labelX = logoX + logoSize + 6;
  const labelW = leftW - labelX - 4;
  if (badge.house) {
    doc
      .fillColor("#ffffff")
      .fontSize(9)
      .text(`${badge.house.name} House`, labelX, logoY + 1, {
        width: labelW,
        ellipsis: true,
        lineBreak: false,
      });
    doc
      .fillColor("rgba(255,255,255,0.88)")
      .fontSize(7)
      .text(badge.schoolName, labelX, logoY + 13, {
        width: labelW,
        ellipsis: true,
        height: 18,
      });
  } else {
    doc
      .fillColor("#ffffff")
      .fontSize(9)
      .text("Student ID", labelX, logoY + 1, {
        width: labelW,
        lineBreak: false,
      });
    doc
      .fillColor("rgba(255,255,255,0.88)")
      .fontSize(7)
      .text(badge.schoolName, labelX, logoY + 13, {
        width: labelW,
        ellipsis: true,
        height: 18,
      });
  }

  // Square photo (left-bottom area of the band) — enlarged from 64 to
  // 86pt so the photo area roughly doubles. Name + grade column to the
  // right tightens to fit the remaining horizontal space in the band.
  const photoSize = 86;
  const photoX = 8;
  const photoY = H - photoSize - 8;
  drawPhotoSlot(doc, badge, photoX, photoY, photoSize, "#ffffff");

  // Name + grade right of the photo, within the house-color zone
  const txtX = photoX + photoSize + 6;
  const txtW = leftW - txtX - 4;
  doc
    .fillColor("#ffffff")
    .fontSize(10.5)
    .text(`${badge.firstName} ${badge.lastName}`, txtX, photoY + 4, {
      width: txtW,
      ellipsis: true,
      height: 28,
    });
  const dLabel = dismissalLabel(badge.dismissalMode);
  const isCarRider = badge.dismissalMode === "car_rider";
  const gradeBits: string[] = [];
  if (badge.grade !== null) gradeBits.push(`Grade ${badge.grade}`);
  if (dLabel) gradeBits.push(dLabel);
  const gradeRowY = photoY + photoSize - 22;
  if (gradeBits.length > 0 || isCarRider) {
    const text = gradeBits.join(" · ");
    doc.fillColor("rgba(255,255,255,0.92)").fontSize(8);
    if (text) {
      doc.text(text, txtX, gradeRowY, {
        width: txtW,
        ellipsis: true,
        height: 12,
        lineBreak: false,
      });
    }
    if (isCarRider) {
      const iconW = 16;
      const iconH = iconW * 0.55;
      const textW = text ? doc.widthOfString(text) : 0;
      const iconX = txtX + textW + (text ? 4 : 0);
      drawCarIcon(doc, iconX, gradeRowY + (8 - iconH) / 2, iconW, "#ffffff");
    }
  }

  // Right white zone: QR on top, barcode below, crisis lines underneath.
  const rightX = leftW + 2;
  const rightW = W - rightX - 4;

  const qrBuf = await renderQrBuffer(badge);
  const qrSize = 64;
  const qrX = rightX + (rightW - qrSize) / 2;
  const qrY = 8;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  const barcodePng = await renderBarcodeBuffer(badge.localSisId ?? badge.studentId);
  const bcW = rightW - 4;
  const bcH = 26;
  const bcX = rightX + (rightW - bcW) / 2;
  const bcY = qrY + qrSize + 3;
  doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });

  // Crisis hotlines — FL HB 383 mandate, see lanyard comment.
  doc
    .fillColor("#b91c1c")
    .fontSize(6)
    .text("Crisis? Call or text 988", rightX, bcY + bcH + 2, {
      width: rightW,
      align: "center",
      lineBreak: false,
    });
  doc
    .fillColor("#475569")
    .fontSize(6)
    .text("Text HOME to 741741", rightX, bcY + bcH + 10, {
      width: rightW,
      align: "center",
      lineBreak: false,
    });
}

// ---------------------------------------------------------------------------
// Shared drawing helpers
// ---------------------------------------------------------------------------

// House emblem: uploaded logo (rounded-rect clipped) if we have bytes,
// otherwise a white disc with the house's first letter in the house color.
function drawHouseEmblem(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
  x: number,
  y: number,
  size: number,
  houseColor: string,
): void {
  const logo = badge.house?.logoBytes;
  // White rounded background tile — gives both uploaded logos and the
  // letter fallback a consistent contrast against the colored band.
  doc
    .save()
    .fillColor("#ffffff")
    .roundedRect(x, y, size, size, 4)
    .fill()
    .restore();
  if (logo) {
    try {
      // Inset slightly so the logo doesn't touch the white tile edge.
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

// Square photo slot: rounded-rect-clipped photo when present, otherwise
// a colored disc with student initials. `frameColor` becomes the
// border of the photo (or the disc color when there's no photo).
function drawPhotoSlot(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
  x: number,
  y: number,
  size: number,
  frameColor: string,
): void {
  if (badge.photoBytes) {
    // Border tile in the frame color.
    doc
      .save()
      .lineWidth(2)
      .strokeColor(frameColor)
      .roundedRect(x - 1, y - 1, size + 2, size + 2, 5)
      .stroke()
      .restore();
    try {
      doc.save();
      doc.roundedRect(x, y, size, size, 4).clip();
      doc.image(badge.photoBytes, x, y, {
        width: size,
        height: size,
        cover: [size, size],
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
  // Initials fallback — square rounded tile in the frame color (white
  // outline if frame is white).
  const bgColor = frameColor === "#ffffff" ? "#e2e8f0" : frameColor;
  doc
    .save()
    .fillColor(bgColor)
    .roundedRect(x, y, size, size, 4)
    .fill()
    .restore();
  const initials = computeInitials(badge);
  const textColor = frameColor === "#ffffff" ? "#475569" : "#ffffff";
  doc
    .fillColor(textColor)
    .fontSize(Math.round(size * 0.42))
    .text(initials, x, y + size / 2 - Math.round(size * 0.22), {
      width: size,
      align: "center",
      lineBreak: false,
    });
}

function computeInitials(badge: StudentBadgeInput): string {
  return (
    `${(badge.firstName[0] ?? "").toUpperCase()}${(badge.lastName[0] ?? "").toUpperCase()}` ||
    "?"
  );
}

async function renderQrBuffer(badge: StudentBadgeInput): Promise<Buffer> {
  const qrUrl = `${badge.baseUrl}?signin=${encodeURIComponent(badge.localSisId ?? badge.studentId)}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    margin: 1,
    width: 200,
    errorCorrectionLevel: "M",
  });
  return Buffer.from(qrDataUrl.split(",")[1], "base64");
}

async function renderBarcodeBuffer(studentId: string): Promise<Buffer> {
  return bwipjs.toBuffer({
    bcid: "code128",
    text: studentId,
    scale: 2,
    height: 12,
    includetext: false,
    paddingwidth: 4,
    paddingheight: 4,
    backgroundcolor: "FFFFFF",
  });
}
