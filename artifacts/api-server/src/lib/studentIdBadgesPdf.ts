// Per-student printable ID badge. ONE physical size, single-sided
// (one badge = one page): a landscape credit-card / CR80 ID,
// 3.375" × 2.125". Each badge carries: a full-width house-color header
// (uploaded house logo or initials disc on the left, house name + school,
// and a dismissal-mode indicator on the RIGHT — a small car icon for car
// riders, otherwise a short text label), a square student photo (or
// initials fallback), the student name + grade, an enlarged QR (links to
// kiosk sign-in), a full-width Code 128 barcode, and the two FL HB 383
// crisis hotlines (988 + Crisis Text Line 741741) printed on the front as
// Florida law requires.

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import { normalizeHex } from "./pdfColors";

// Landscape credit-card / CR80 — 3.375" × 2.125" at 72dpi.
const CARD_W = 243;
const CARD_H = 153;

const PAGE_MARGIN = 8;

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
  // End-of-day dismissal mode. Rendered in the header (car icon for car
  // riders, short text label otherwise).
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
// as a small vector car icon instead of text (see drawCarIcon).
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
// the "Car Rider" text in the badge header so the dismissal mode reads at
// a glance without crowding the layout.
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
): Promise<Buffer> {
  // Bottom margin intentionally small — the badge layout positions every
  // element absolutely and the crisis hotline line sits close to the page
  // edge. A larger bottom margin would push pdfkit to auto-page when text
  // crosses (pageHeight - bottomMargin). These margins MUST be passed to
  // every addPage() too: pdfkit applies its default 72pt margins to any
  // page whose options object omits them, which silently shrinks the
  // usable area and auto-paginates a single badge across several pages.
  const margins = {
    top: PAGE_MARGIN,
    bottom: 2,
    left: PAGE_MARGIN,
    right: PAGE_MARGIN,
  };
  const doc = new PDFDocument({
    size: [CARD_W, CARD_H],
    margins,
    info: { Title: "Student ID Badges" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  for (let i = 0; i < badges.length; i++) {
    if (i > 0) doc.addPage({ size: [CARD_W, CARD_H], margins });
    await renderCardBadge(doc, badges[i]);
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Credit-card / CR80 (landscape 243 × 153)
//
// Layout:
//   [ full-width house-color header band, 34pt tall ]
//     house logo (square) at LEFT, white if no upload
//     "House Name" + "School Name" stacked next to the logo
//     dismissal indicator at RIGHT — car icon for car riders, else label
//   [ body, white ]
//     square photo (66) at left · student name + grade in the middle
//     enlarged QR (86, links to kiosk sign-in) at the right
//   [ full-width Code 128 barcode near the bottom ]
//   [ FL HB 383 crisis line on the front: 988 + 741741 ]
// ---------------------------------------------------------------------------
async function renderCardBadge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const W = CARD_W;
  const H = CARD_H;
  const houseColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";

  // Card outline
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(2, 2, W - 4, H - 4, 6)
    .stroke()
    .restore();

  // Full-width header band
  const bandH = 32;
  doc
    .save()
    .fillColor(houseColor)
    .roundedRect(2, 2, W - 4, bandH, 6)
    .fill()
    .restore();
  // Square the bottom edge of the band so it butts cleanly against the body.
  doc
    .save()
    .fillColor(houseColor)
    .rect(2, bandH - 4, W - 4, 8)
    .fill()
    .restore();

  // House emblem (top-left on band)
  const logoSize = 24;
  const logoX = 8;
  const logoY = 2 + (bandH - logoSize) / 2;
  drawHouseEmblem(doc, badge, logoX, logoY, logoSize, houseColor);

  // Dismissal indicator (RIGHT side of the header, opposite the house logo):
  // a small car icon for car riders, otherwise the short text label.
  const isCarRider = badge.dismissalMode === "car_rider";
  const dLabel = dismissalLabel(badge.dismissalMode);
  let headerRightLimit = W - 8;
  if (isCarRider) {
    const iconW = 26;
    const iconH = iconW * 0.55;
    const iconX = W - iconW - 8;
    const iconY = 2 + (bandH - iconH) / 2;
    drawCarIcon(doc, iconX, iconY, iconW, "#ffffff");
    headerRightLimit = iconX - 6;
  } else if (dLabel) {
    doc.fillColor("#ffffff").fontSize(8.5);
    const tw = doc.widthOfString(dLabel);
    const tx = W - 8 - tw;
    doc.text(dLabel, tx, 2 + (bandH - 9) / 2, { lineBreak: false });
    headerRightLimit = tx - 6;
  }

  // House name + school, stacked right of the emblem (clamped so it never
  // collides with the dismissal indicator).
  const labelX = logoX + logoSize + 8;
  const labelW = Math.max(40, headerRightLimit - labelX);
  if (badge.house) {
    doc
      .fillColor("#ffffff")
      .fontSize(9)
      .text(`${badge.house.name} House`, labelX, 8, {
        width: labelW,
        ellipsis: true,
        lineBreak: false,
      });
    doc
      .fillColor("rgba(255,255,255,0.88)")
      .fontSize(7)
      .text(badge.schoolName, labelX, 20, {
        width: labelW,
        ellipsis: true,
        height: 12,
        lineBreak: false,
      });
  } else {
    doc
      .fillColor("#ffffff")
      .fontSize(9)
      .text("Student ID", labelX, 8, { width: labelW, lineBreak: false });
    doc
      .fillColor("rgba(255,255,255,0.88)")
      .fontSize(7)
      .text(badge.schoolName, labelX, 20, {
        width: labelW,
        ellipsis: true,
        height: 12,
        lineBreak: false,
      });
  }

  // Body — enlarged QR on the right.
  const qrSize = 84;
  const qrX = W - qrSize - 8;
  const qrY = bandH + 4;
  const qrBuf = await renderQrBuffer(badge);
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  // Square photo on the left.
  const photoSize = 64;
  const photoX = 8;
  const photoY = bandH + 4;
  drawPhotoSlot(doc, badge, photoX, photoY, photoSize, houseColor);

  // Name + grade between the photo and the QR.
  const txtX = photoX + photoSize + 8;
  const txtW = Math.max(36, qrX - txtX - 6);
  doc
    .fillColor("#111827")
    .fontSize(10.5)
    .text(`${badge.firstName} ${badge.lastName}`, txtX, photoY + 6, {
      width: txtW,
      ellipsis: true,
      height: 26,
    });
  if (badge.grade !== null) {
    doc
      .fillColor("#475569")
      .fontSize(9)
      .text(`Grade ${badge.grade}`, txtX, photoY + 30, {
        width: txtW,
        ellipsis: true,
        lineBreak: false,
      });
  }

  // Full-width Code 128 barcode below the photo / QR — far wider (and so
  // far more scannable) than the old right-zone barcode. Encodes the local
  // SIS id ONLY — the internal FLEID-style student_id must never reach a
  // printed, student-facing surface. local_sis_id is 100%-populated in
  // practice; if it is somehow missing we skip the barcode rather than leak
  // the FLEID or render an unscannable code.
  const bcW = W - PAGE_MARGIN * 2;
  const bcH = 14;
  const bcX = PAGE_MARGIN;
  const bcY = Math.max(photoY + photoSize, qrY + qrSize) + 3;
  if (badge.localSisId) {
    const barcodePng = await renderBarcodeBuffer(badge.localSisId);
    doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });
  }

  // Crisis hotlines — FL HB 383 (effective 2021-07-01) requires the 988
  // lifeline + a crisis text line on student IDs grades 6-12, on the front.
  const crisisY = bcY + bcH + 2;
  doc
    .fillColor("#b91c1c")
    .fontSize(6)
    .text(
      "Crisis? Call or text 988  ·  Crisis Text Line: text HOME to 741741",
      PAGE_MARGIN,
      crisisY,
      {
        width: W - PAGE_MARGIN * 2,
        align: "center",
        lineBreak: false,
      },
    );
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
  // Encode local_sis_id ONLY — the kiosk resolves `?signin=` by local_sis_id,
  // and the internal FLEID-style student_id must never reach a printed QR.
  const qrUrl = `${badge.baseUrl}?signin=${encodeURIComponent(badge.localSisId ?? "")}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    margin: 1,
    width: 280,
    errorCorrectionLevel: "M",
  });
  return Buffer.from(qrDataUrl.split(",")[1], "base64");
}

async function renderBarcodeBuffer(localSisId: string): Promise<Buffer> {
  return bwipjs.toBuffer({
    bcid: "code128",
    text: localSisId,
    scale: 3,
    height: 16,
    includetext: false,
    paddingwidth: 4,
    paddingheight: 4,
    backgroundcolor: "FFFFFF",
  });
}
