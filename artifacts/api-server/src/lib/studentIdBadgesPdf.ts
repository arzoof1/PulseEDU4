// Per-student printable ID badge, single-sided (one badge = one page). The
// per-school design chooses one of two CR80 orientations:
//   • LANDSCAPE (legacy) — 3.375" × 2.125", a full-width house-color header
//     (uploaded house logo or initials disc on the left, name/grade + school,
//     dismissal-mode indicator on the right), photo, enlarged QR, then below
//     a house band, a full-width Code 128 barcode, and the crisis strip.
//   • PORTRAIT (lanyard) — 2.125" × 3.375", a lanyard slot + diagonal
//     school-color corner ribbons, centered school name, photo + QR row,
//     icon rows (dismissal / name+grade / teacher), a house emblem band,
//     the barcode below it, and a navy crisis bar at the very bottom.
// Both carry the two FL HB 383 crisis hotlines (988 + Crisis Text Line
// 741741) printed on the front as Florida law requires. The QR and Code 128
// always encode the Local SIS id (never the FLEID-style student_id).

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
  // Optional homeroom / primary teacher display name (e.g. "Ms. Johnson").
  // Rendered as the teacher icon row on portrait badges only; the row is
  // omitted when absent so the layout stays clean.
  teacherName?: string | null;
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
  // Per-school card design. When omitted, the badge falls back to the
  // legacy look (house-colored top band, no footer) so unconfigured
  // schools render exactly as before.
  design?: CardDesign | null;
}

// Per-school Student ID card design. Resolved by the badge route from
// school_branding and applied identically to every badge in a batch.
export interface CardDesign {
  // Physical orientation. 'landscape' = CR80 horizontal (legacy). 'portrait'
  // = tall lanyard ID (corner ribbons, lanyard slot, icon rows, house emblem,
  // navy crisis bar). All other design fields apply to both orientations.
  orientation: "landscape" | "portrait";
  // Top region (header + photo) background.
  bgMode: "colors" | "image";
  // 0-2 resolved hex colors. 0 = fall back to the student's house color
  // (legacy look); 1 = solid; 2 = diagonal gradient.
  bgColors: string[];
  bgAngle: number;
  // Uploaded top-background image bytes (mode='image'). PNG/JPEG/WebP.
  bgImageBytes?: Buffer | null;
  // Header + student-name text color.
  headerTextMode: "auto" | "manual";
  headerTextColor?: string | null;
  // Optional house footer band.
  showHouse: boolean;
  houseBgMode: "house" | "white" | "custom";
  houseBgColor?: string | null;
  houseTextMode: "auto" | "manual";
  houseTextColor?: string | null;
}

// Legacy default used when a badge carries no design (preserves the
// original house-colored full-width header band, no footer).
const LEGACY_DESIGN: CardDesign = {
  orientation: "landscape",
  bgMode: "colors",
  bgColors: [],
  bgAngle: 135,
  bgImageBytes: null,
  headerTextMode: "auto",
  headerTextColor: null,
  showHouse: false,
  houseBgMode: "house",
  houseBgColor: null,
  houseTextMode: "auto",
  houseTextColor: null,
};

// Tiny side-profile car icon — body + roof + two wheels. Used inside the
// white corner badge that flags car riders on the student photo (both
// orientations).
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

// Small circular "Car Rider" badge overlaid on the bottom-left corner of a
// student photo: a white disc (thin slate border) with the car silhouette
// inside, tinted to the school's primary top color so it pops off the photo.
// Used in BOTH orientations and ONLY for car riders — other dismissal modes
// show nothing (per product decision).
function drawCarRiderCornerBadge(
  doc: PDFKit.PDFDocument,
  photoX: number,
  photoBottomY: number,
  carColor: string,
): void {
  const r = 11;
  // Hug the inside of the photo's bottom-left corner.
  const cx = photoX + r + 1.5;
  const cy = photoBottomY - r - 1.5;
  doc.save();
  doc.fillColor("#ffffff").circle(cx, cy, r).fill();
  doc.lineWidth(0.8).strokeColor("#cbd5e1").circle(cx, cy, r).stroke();
  doc.restore();
  const carW = r * 1.4;
  drawCarIcon(doc, cx - carW / 2, cy - (carW * 0.55) / 2, carW, carColor);
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
  // Page size follows each badge's orientation (portrait swaps W/H). A batch
  // shares one school design, so this is usually constant — but we size per
  // badge defensively so a mixed list never clips.
  const sizeFor = (b: StudentBadgeInput): [number, number] =>
    (b.design ?? LEGACY_DESIGN).orientation === "portrait"
      ? [CARD_H, CARD_W]
      : [CARD_W, CARD_H];
  const doc = new PDFDocument({
    size: badges[0] ? sizeFor(badges[0]) : [CARD_W, CARD_H],
    margins,
    info: { Title: "Student ID Badges" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  for (let i = 0; i < badges.length; i++) {
    if (i > 0) doc.addPage({ size: sizeFor(badges[i]), margins });
    await renderCardBadge(doc, badges[i]);
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Credit-card / CR80 (landscape 243 × 153)
//
// Layout (design-driven):
//   [ TOP region — school colors (solid / diagonal) OR uploaded image ]
//     school name (auto-contrast or manual) at top-left
//     square photo at left · student name + grade beside it
//     enlarged QR on a WHITE plate at the right (always clean white)
//     dismissal indicator (car icon / label) at top-right of the region
//   [ WHITE region ]
//     full-width Code 128 barcode
//     optional house footer band (emblem + "HOUSE NAME")
//     FL HB 383 crisis line (988 + 741741)
// ---------------------------------------------------------------------------
const TOP_H = 96;

async function renderCardBadge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const design = badge.design ?? LEGACY_DESIGN;
  if (design.orientation === "portrait") {
    await renderCardBadgePortrait(doc, badge);
  } else {
    await renderCardBadgeLandscape(doc, badge);
  }
}

async function renderCardBadgeLandscape(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const W = CARD_W;
  const H = CARD_H;
  const design = badge.design ?? LEGACY_DESIGN;
  const houseColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";

  // Card outline
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(2, 2, W - 4, H - 4, 6)
    .stroke()
    .restore();

  // --- TOP region background -------------------------------------------
  // Resolve the top colors: explicit design colors, else the student's
  // house color (legacy/default look). Image mode draws the uploaded photo
  // (cover) with a scrim so the header text stays legible.
  const topColors =
    design.bgColors.length > 0
      ? design.bgColors.map((c) => normalizeHex(c))
      : [houseColor];
  const usingImage = design.bgMode === "image" && !!design.bgImageBytes;

  // Clip to a rounded-top / square-bottom region, then paint.
  doc.save();
  roundedTopPath(doc, 2, 2, W - 4, TOP_H);
  doc.clip();
  if (usingImage) {
    try {
      doc.image(design.bgImageBytes as Buffer, 2, 2, {
        width: W - 4,
        height: TOP_H,
        cover: [W - 4, TOP_H],
        align: "center",
        valign: "center",
      });
    } catch {
      doc.rect(2, 2, W - 4, TOP_H).fill(topColors[0] ?? houseColor);
    }
  } else if (topColors.length >= 2) {
    const grad = doc.linearGradient(2, 2, W - 2, TOP_H);
    grad.stop(0, topColors[0]!).stop(1, topColors[1]!);
    doc.rect(2, 2, W - 4, TOP_H).fill(grad);
  } else {
    doc.rect(2, 2, W - 4, TOP_H).fill(topColors[0] ?? houseColor);
  }
  doc.restore();

  // Header / name text color: auto-contrast against the top-left of the
  // region (where the text sits), or a manual override.
  const autoTextColor = usingImage
    ? "#ffffff"
    : readableTextOn(topColors[0] ?? houseColor);
  const headerText =
    design.headerTextMode === "manual" && design.headerTextColor
      ? normalizeHex(design.headerTextColor)
      : autoTextColor;

  // Scrim for legibility — only over the colored/image region, behind the
  // text. Drawn before the photo & QR plate so those sit on top untouched.
  if (usingImage) {
    const scrimDark = headerText === "#ffffff" || isLight(headerText);
    doc.save();
    doc.fillOpacity(scrimDark ? 0.4 : 0.25);
    doc.fillColor(scrimDark ? "#000000" : "#ffffff");
    doc.rect(2, 2, W - 4, 30).fill();
    doc.restore();
  }

  // --- QR on a white plate (always clean white) ------------------------
  const qrSize = 72;
  const qrPad = 4;
  const qrX = W - 8 - qrSize;
  const qrY = 14;
  doc
    .save()
    .fillColor("#ffffff")
    .roundedRect(qrX - qrPad, qrY - qrPad, qrSize + qrPad * 2, qrSize + qrPad * 2, 5)
    .fill()
    .restore();
  const qrBuf = await renderQrBuffer(badge);
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
  const plateLeft = qrX - qrPad;

  // --- School name (top-left header) -----------------------------------
  const headerX = 10;
  const headerY = 8;
  const headerW = Math.max(40, plateLeft - headerX - 6);
  doc
    .fillColor(headerText)
    .fontSize(11)
    .text(badge.schoolName, headerX, headerY, {
      width: headerW,
      ellipsis: true,
      height: 14,
      lineBreak: false,
    });

  // --- Square photo on the left ----------------------------------------
  const photoSize = 58;
  const photoX = 10;
  const photoY = 32;
  // Frame the photo in white when over a colored/image background so it
  // never blends into the top region.
  drawPhotoSlot(doc, badge, photoX, photoY, photoSize, "#ffffff");

  // Car-rider badge overlaid on the photo's bottom-left corner (car riders
  // only; other dismissal modes show nothing). Car tinted to the school's
  // primary top color.
  if (badge.dismissalMode === "car_rider") {
    drawCarRiderCornerBadge(
      doc,
      photoX,
      photoY + photoSize,
      topColors[0] ?? houseColor,
    );
  }

  // --- Name + grade between the photo and the QR plate -----------------
  const txtX = photoX + photoSize + 8;
  const txtW = Math.max(36, plateLeft - txtX - 6);
  doc
    .fillColor(headerText)
    .fontSize(10.5)
    .text(`${badge.firstName} ${badge.lastName}`, txtX, photoY + 4, {
      width: txtW,
      ellipsis: true,
      height: 26,
    });
  if (badge.grade !== null) {
    doc
      .fillColor(headerText)
      .fontSize(8.5)
      .text(`Grade ${badge.grade}`, txtX, photoY + 32, {
        width: txtW,
        ellipsis: true,
        lineBreak: false,
      });
  }

  // --- WHITE region: barcode, optional house footer, crisis line -------
  const showFooter = design.showHouse && !!badge.house;

  // Stack the white region top-down: optional house footer band first
  // (right below the top region), then the barcode BELOW the band, then the
  // crisis line as the very bottom strip. The barcode sits low on the card
  // so it lines up with cafeteria swipe readers.
  let y = TOP_H + 4;

  // Optional house footer band.
  if (showFooter && badge.house) {
    const footerH = 16;
    const footerY = y;
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
    // Band
    doc
      .save()
      .fillColor(footerBg)
      .roundedRect(PAGE_MARGIN, footerY, W - PAGE_MARGIN * 2, footerH, 4)
      .fill();
    if (footerBg === "#ffffff") {
      doc
        .lineWidth(0.5)
        .strokeColor("#cbd5e1")
        .roundedRect(PAGE_MARGIN, footerY, W - PAGE_MARGIN * 2, footerH, 4)
        .stroke();
    }
    doc.restore();
    // Small emblem at the left of the band.
    const emSize = footerH - 4;
    drawHouseEmblem(
      doc,
      badge,
      PAGE_MARGIN + 3,
      footerY + 2,
      emSize,
      footerBg === "#ffffff" ? houseColor : footerBg,
    );
    // House name, centered in the band.
    doc
      .fillColor(footerText)
      .fontSize(9)
      .text(
        `HOUSE ${badge.house.name.toUpperCase()}`,
        PAGE_MARGIN,
        footerY + (footerH - 9) / 2,
        { width: W - PAGE_MARGIN * 2, align: "center", lineBreak: false },
      );
    y = footerY + footerH + 4;
  }

  // Full-width Code 128 barcode, BELOW the house band. Encodes the local SIS
  // id ONLY — the internal FLEID-style student_id must never reach a printed,
  // student-facing surface. Skipped (not faked) when missing.
  const bcH = 13;
  if (badge.localSisId) {
    const barcodePng = await renderBarcodeBuffer(badge.localSisId);
    doc.image(barcodePng, PAGE_MARGIN, y, {
      width: W - PAGE_MARGIN * 2,
      height: bcH,
    });
    y += bcH + 3;
  }

  // Crisis hotlines — FL HB 383 (effective 2021-07-01) requires the 988
  // lifeline + a crisis text line on student IDs grades 6-12, on the front.
  // Pinned to the very bottom edge so it's always the last strip.
  const crisisY = Math.max(y, H - 11);
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
// Portrait (tall lanyard ID — 153 × 243)
//
// Layout (design-driven, matches the lanyard-style reference):
//   [ lanyard slot hole, centered at the very top ]
//   [ diagonal school-color corner ribbons (colors mode) OR a top banner
//     image (image mode) ]
//   centered school name + divider diamond
//   square-ish portrait photo (left, with a corner car-rider badge for car
//     riders) · enlarged QR on a WHITE plate (right)
//   icon rows: student name + grade · teacher (no dismissal row)
//   optional house emblem + "HOUSE NAME" band
//   tall full-width Code 128 barcode BELOW the band (cafeteria swipe)
//   FL HB 383 crisis bar pinned to the very bottom
// ---------------------------------------------------------------------------
async function renderCardBadgePortrait(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  // Portrait swaps the landscape dimensions.
  const W = CARD_H; // 153
  const H = CARD_W; // 243
  const design = badge.design ?? LEGACY_DESIGN;
  const houseColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";
  const M = PAGE_MARGIN;

  // Resolve top colors (same precedence as landscape: design colors, else the
  // student's house color). c0 = primary band/ink; c1 = accent ribbon.
  const topColors =
    design.bgColors.length > 0
      ? design.bgColors.map((c) => normalizeHex(c))
      : [houseColor];
  const c0 = topColors[0] ?? houseColor;
  const c1 = topColors[1] ?? c0;
  const usingImage = design.bgMode === "image" && !!design.bgImageBytes;

  // A dark ink derived from the school colors, used for icon discs, the grade
  // ring, and the crisis bar so they read on white. Falls back to slate.
  const ink = !isLight(c0) ? c0 : !isLight(c1) ? c1 : "#0f172a";

  // White card body + outline.
  doc
    .save()
    .fillColor("#ffffff")
    .roundedRect(2, 2, W - 4, H - 4, 6)
    .fill()
    .restore();

  // Clip everything to the rounded card so ribbons / banner never spill past
  // the rounded corners.
  doc.save();
  doc.roundedRect(2, 2, W - 4, H - 4, 6).clip();

  if (usingImage) {
    // Image mode: uploaded photo as a top banner with a dark scrim; the
    // school name sits white on top.
    const bandH = 46;
    try {
      doc.image(design.bgImageBytes as Buffer, 2, 2, {
        width: W - 4,
        height: bandH,
        cover: [W - 4, bandH],
        align: "center",
        valign: "center",
      });
    } catch {
      doc.rect(2, 2, W - 4, bandH).fill(c0);
    }
    doc.save();
    doc.fillOpacity(0.4).fillColor("#000000").rect(2, 2, W - 4, bandH).fill();
    doc.restore();
  } else {
    // Colors mode: diagonal corner ribbons. c1 (accent) is the outer/larger
    // triangle, c0 (primary) the inner one nearer the corner — so a 2-color
    // school reads as a primary corner with an accent stripe outside it.
    drawCornerRibbon(doc, "left", W, 56, c1);
    drawCornerRibbon(doc, "left", W, 40, c0);
    drawCornerRibbon(doc, "right", W, 56, c1);
    drawCornerRibbon(doc, "right", W, 40, c0);
  }
  doc.restore();

  // Lanyard slot — a rounded "punch" hole centered at the very top, drawn on
  // top of the ribbons/banner.
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

  // School name — centered. Auto-contrast: white over an image banner, else
  // a dark ink on the white body. Manual override honored.
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

  // Divider with a center diamond (colors mode only — the banner already
  // separates the header in image mode).
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
  const photoX = 12;
  const photoY = 52;
  const photoW = 60;
  const photoH = 60;
  drawPhotoRect(doc, badge, photoX, photoY, photoW, photoH, "#e2e8f0");

  // Car-rider badge overlaid on the photo's bottom-left corner (car riders
  // only; other dismissal modes show nothing). Car tinted to the school's
  // primary top color.
  if (badge.dismissalMode === "car_rider") {
    drawCarRiderCornerBadge(doc, photoX, photoY + photoH, c0);
  }

  const qrSize = 60;
  const qrPad = 3;
  const qrX = W - 12 - qrSize;
  const qrY = 52;
  doc
    .save()
    .fillColor("#ffffff")
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(qrX - qrPad, qrY - qrPad, qrSize + qrPad * 2, qrSize + qrPad * 2, 5)
    .fillAndStroke()
    .restore();
  const qrBuf = await renderQrBuffer(badge);
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  // --- Bottom-anchored elements (crisis bar, barcode, house band) ------
  // Barcode is intentionally TALL here — the dismissal row was dropped (car
  // riders now get a corner badge on the photo), so the reclaimed space goes
  // to a taller barcode for more reliable cafeteria-reader scans.
  const crisisBarH = 16;
  const crisisBarY = H - 2 - crisisBarH;
  const bcH = 22;
  const bcY = crisisBarY - 4 - bcH;
  const showFooter = design.showHouse && !!badge.house;
  const bandH = 24;
  const bandY = showFooter ? bcY - 4 - bandH : bcY;

  // --- Icon rows fill the middle, between the photo/QR row and the band -
  const rowsTop = Math.max(photoY + photoH, qrY + qrSize) + 8;
  const rowsBottom = (showFooter ? bandY : bcY) - 6;

  // Name + optional teacher only. The dismissal row was removed — car riders
  // are flagged by the corner badge on the photo; other modes show nothing.
  type IconRow = { kind: "person" | "teacher"; text: string; grade?: number | null };
  const rows: IconRow[] = [];
  rows.push({
    kind: "person",
    text: `${badge.firstName} ${badge.lastName}`.trim() || "Student",
    grade: badge.grade,
  });
  if (badge.teacherName && badge.teacherName.trim()) {
    rows.push({ kind: "teacher", text: `Teacher: ${badge.teacherName.trim()}` });
  }

  const slotCount = Math.max(rows.length, 1);
  const slot = (rowsBottom - rowsTop) / slotCount;
  const discR = Math.min(10, slot / 2 - 2);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const cy = rowsTop + slot * (i + 0.5);
    const discCx = M + 6 + discR;
    // Icon disc.
    doc.save().fillColor(ink).circle(discCx, cy, discR).fill().restore();
    if (row.kind === "teacher") {
      drawTeacherIcon(doc, discCx, cy, discR, "#ffffff");
    } else {
      drawPersonIcon(doc, discCx, cy, discR, "#ffffff");
    }
    // Grade ring on the right (name row only).
    let textRight = W - M - 4;
    if (row.grade !== null && row.grade !== undefined) {
      const gr = 10;
      const gcx = W - M - gr;
      doc
        .save()
        .lineWidth(1.2)
        .strokeColor(ink)
        .circle(gcx, cy, gr)
        .stroke()
        .restore();
      doc
        .fillColor(ink)
        .fontSize(10)
        .text(String(row.grade), gcx - gr, cy - 5, {
          width: gr * 2,
          align: "center",
          lineBreak: false,
        });
      textRight = gcx - gr - 4;
    }
    // Row label — strictly single-line (fitText truncates to width).
    const textX = discCx + discR + 7;
    const labelFs = row.grade !== null && row.grade !== undefined ? 11 : 9.5;
    const labelW = Math.max(20, textRight - textX);
    doc.fillColor("#1f2937").fontSize(labelFs);
    doc.text(fitText(doc, row.text.toUpperCase(), labelW), textX, cy - 6, {
      width: labelW,
      lineBreak: false,
    });
    // Separator under the row (except the last).
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

  // --- Full-width Code 128 barcode, BELOW the house band ---------------
  // Encodes the local SIS id ONLY (never the FLEID-style student_id).
  if (badge.localSisId) {
    const barcodePng = await renderBarcodeBuffer(badge.localSisId);
    doc.image(barcodePng, M, bcY, { width: W - M * 2, height: bcH });
  }

  // --- Crisis bar pinned to the very bottom (FL HB 383) ----------------
  doc
    .save()
    .fillColor(ink)
    .roundedRect(M, crisisBarY, W - M * 2, crisisBarH, 4)
    .fill()
    .restore();
  drawChatIcon(doc, M + 8, crisisBarY + crisisBarH / 2, 5, "#ffffff");
  // FL HB 383 hotline text. Must NEVER be truncated (it's legally required),
  // so we shrink the font until it fits the narrow portrait bar on ONE line —
  // a wrapped second line would spill below the page and add a blank page.
  const crisisText = "Crisis? Call or text 988  ·  Text HOME to 741741";
  const crisisAvailW = W - M * 2 - 16;
  let crisisFs = 6;
  doc.fillColor("#ffffff").fontSize(crisisFs);
  while (crisisFs > 4 && doc.widthOfString(crisisText) > crisisAvailW) {
    crisisFs -= 0.2;
    doc.fontSize(crisisFs);
  }
  doc.text(
    crisisText,
    M + 14,
    crisisBarY + crisisBarH / 2 - crisisFs * 0.6,
    { width: crisisAvailW, align: "center", lineBreak: false },
  );
}

// Truncate `text` with an ellipsis so it always fits on ONE line within
// `maxW`. Measured with the doc's CURRENT font + size, so callers must set the
// font size before calling. Keeping icon-row labels strictly single-line is
// what prevents pdfkit from auto-flowing a wrapped label onto a second page.
function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  maxW: number,
): string {
  if (doc.widthOfString(text) <= maxW) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// One diagonal corner ribbon = a right triangle anchored in a top corner,
// clipped to the card by the caller. Larger `size` first, smaller on top.
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

// Small person glyph (head + shoulders) centered at (cx, cy) within a disc of
// radius r. Used for the student-name and dismissal icon rows.
function drawPersonIcon(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  doc.save().fillColor(color);
  const headR = r * 0.34;
  const headCy = cy - r * 0.34;
  doc.circle(cx, headCy, headR).fill();
  // Shoulders — a rounded "hill" below the head.
  const bw = r * 1.0;
  const bh = r * 0.52;
  const bx = cx - bw / 2;
  const by = cy + r * 0.06;
  doc.moveTo(bx, by + bh).lineTo(bx, by + bh * 0.5);
  doc.quadraticCurveTo(bx, by, bx + bw / 2, by);
  doc.quadraticCurveTo(bx + bw, by, bx + bw, by + bh * 0.5);
  doc.lineTo(bx + bw, by + bh).closePath().fill();
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
  // Mortarboard cap — a flat diamond above the head.
  const cw = r * 0.95;
  const capY = cy - r * 0.62;
  doc
    .moveTo(cx, capY - r * 0.16)
    .lineTo(cx + cw, capY)
    .lineTo(cx, capY + r * 0.16)
    .lineTo(cx - cw, capY)
    .closePath()
    .fill();
  // Shoulders.
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

// Tiny speech-bubble glyph for the crisis bar.
function drawChatIcon(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  doc
    .save()
    .fillColor(color)
    .roundedRect(cx - r, cy - r * 0.8, r * 2, r * 1.4, r * 0.4)
    .fill();
  // Little tail.
  doc
    .moveTo(cx - r * 0.5, cy + r * 0.5)
    .lineTo(cx - r * 0.9, cy + r * 1.1)
    .lineTo(cx - r * 0.05, cy + r * 0.55)
    .closePath()
    .fill()
    .restore();
}

// Trace a rounded-top, square-bottom rectangle path (no fill/stroke) so the
// caller can clip or fill the top region cleanly against the white body.
function roundedTopPath(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  r = 6,
): void {
  doc
    .moveTo(x + r, y)
    .lineTo(x + w - r, y)
    .quadraticCurveTo(x + w, y, x + w, y + r)
    .lineTo(x + w, y + h)
    .lineTo(x, y + h)
    .lineTo(x, y + r)
    .quadraticCurveTo(x, y, x + r, y)
    .closePath();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return { r: 15, g: 23, b: 42 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// Relative-luminance check — true when the color is light enough that dark
// text reads better on top of it.
function isLight(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

// Pick black or white text for maximum contrast against a background color.
function readableTextOn(hexBg: string): string {
  return isLight(hexBg) ? "#111827" : "#ffffff";
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
  drawPhotoRect(doc, badge, x, y, size, size, frameColor);
}

// Rectangular photo slot (square when w===h): rounded-rect-clipped photo when
// present, otherwise a colored tile with student initials. `frameColor` is the
// border of the photo (or the tile color when there's no photo). Portrait
// badges pass a taller-than-wide rect for a classic ID portrait crop.
function drawPhotoRect(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
  x: number,
  y: number,
  w: number,
  h: number,
  frameColor: string,
): void {
  if (badge.photoBytes) {
    // Border tile in the frame color.
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
  // Initials fallback — rounded tile in the frame color (white outline if
  // frame is white).
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
