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
  // Per-school card design. When omitted, the badge falls back to the
  // legacy look (house-colored top band, no footer) so unconfigured
  // schools render exactly as before.
  design?: CardDesign | null;
}

// Per-school Student ID card design. Resolved by the badge route from
// school_branding and applied identically to every badge in a batch.
export interface CardDesign {
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

  // Dismissal indicator (car icon / short label) under the school name,
  // tinted to match the header text color so it reads on any background.
  const isCarRider = badge.dismissalMode === "car_rider";
  const dLabel = dismissalLabel(badge.dismissalMode);
  if (isCarRider) {
    drawCarIcon(doc, headerX, 22, 20, headerText);
  } else if (dLabel) {
    doc.fillColor(headerText).fontSize(7).text(dLabel, headerX, 24, {
      width: headerW,
      lineBreak: false,
    });
  }

  // --- Square photo on the left ----------------------------------------
  const photoSize = 58;
  const photoX = 10;
  const photoY = 32;
  // Frame the photo in white when over a colored/image background so it
  // never blends into the top region.
  drawPhotoSlot(doc, badge, photoX, photoY, photoSize, "#ffffff");

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

  // Full-width Code 128 barcode. Encodes the local SIS id ONLY — the
  // internal FLEID-style student_id must never reach a printed,
  // student-facing surface. Skipped (not faked) when missing.
  const bcW = W - PAGE_MARGIN * 2;
  const bcH = 13;
  const bcX = PAGE_MARGIN;
  const bcY = TOP_H + 5;
  if (badge.localSisId) {
    const barcodePng = await renderBarcodeBuffer(badge.localSisId);
    doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });
  }

  // Optional house footer band.
  let crisisY = bcY + bcH + 4;
  if (showFooter && badge.house) {
    const footerH = 16;
    const footerY = bcY + bcH + 3;
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
    crisisY = footerY + footerH + 3;
  }

  // Crisis hotlines — FL HB 383 (effective 2021-07-01) requires the 988
  // lifeline + a crisis text line on student IDs grades 6-12, on the front.
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
