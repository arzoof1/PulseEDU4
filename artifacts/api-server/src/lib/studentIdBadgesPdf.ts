// Per-student printable ID badges (Phase 3). Two physical sizes:
//   - "lanyard" (default): portrait 3.375" × 4.25" — the common
//     school-issued lanyard ID card. Big initials bubble, centered
//     QR, barcode strip, ID number.
//   - "cr80": standard credit-card ID 3.375" × 2.125", landscape.
//     Two-column layout (left = ribbon/identity, right = QR + barcode)
//     so the smaller canvas still carries every required element.
// One badge per page; the school picks the size when printing.

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
  // District-level Local SIS ID (6-digit). Displayed on the badge front
  // and back when present; FLEID-style studentId remains the barcode/QR
  // payload so existing sign-in scanners keep working.
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: number | null;
  // End-of-day dismissal mode (car_rider / walker / bus / aftercare /
  // parent_pickup_only). Rendered as a human label next to the grade
  // so front-office staff can answer "is Maya a walker today?" from
  // the badge alone. Null/unknown → omitted.
  dismissalMode?: string | null;
  schoolName: string;
  // Same QR contract as the kiosk card: the kiosk page reads
  // `?signin=<studentId>` and pre-fills the sign-in field.
  baseUrl: string;
  house?: {
    name: string;
    color: string;
    iconKey: string | null;
  } | null;
  // Optional rectangular photo bytes — when present we render a
  // rectangle photo in place of the initials bubble (Phase 4 — the
  // user explicitly approved rectangle photos on the ID badge only;
  // every other surface keeps the circular avatar). Null/undefined =
  // fall back to initials bubble.
  photoBytes?: Buffer | null;
}

// Human label for a stored dismissal_mode value. Mirrors the
// DISMISSAL_OPTIONS list on the client so the badge reads the same
// as the StudentProfile chip.
function dismissalLabel(mode: string | null | undefined): string | null {
  if (!mode) return null;
  switch (mode) {
    case "car_rider": return "Car Rider";
    case "walker": return "Walker";
    case "bus": return "Bus";
    case "aftercare": return "Aftercare";
    case "parent_pickup_only": return "Parent Pickup";
    default: return null;
  }
}

export async function renderStudentBadgesPdf(
  badges: StudentBadgeInput[],
  size: BadgeSize = "lanyard",
): Promise<Buffer> {
  const [W, H] = size === "cr80" ? [CR80_W, CR80_H] : [LANYARD_W, LANYARD_H];
  const doc = new PDFDocument({
    size: [W, H],
    // Bottom margin intentionally small: the badge layout positions
    // every element absolutely and we need to write the crisis
    // hotline lines almost flush against the page edge. A larger
    // bottom margin makes pdfkit auto-page text() calls whose y
    // crosses (pageHeight - bottomMargin), which is exactly the
    // bug that shipped the 741741 line to a phantom second page.
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

async function renderLanyardBadge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const W = LANYARD_W;
  const H = LANYARD_H;

  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(2, 2, W - 4, H - 4, 8)
    .stroke()
    .restore();

  const ribbonH = 36;
  const ribbonColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";
  doc
    .save()
    .fillColor(ribbonColor)
    .roundedRect(2, 2, W - 4, ribbonH, 8)
    .fill()
    .restore();
  doc
    .save()
    .fillColor(ribbonColor)
    .rect(2, ribbonH - 6, W - 4, 8)
    .fill()
    .restore();

  if (badge.house) {
    // Bigger letter-in-circle "logo" — until we add svg-to-pdfkit +
    // lucide-static to render real glyphs, the first letter on a
    // larger white disc is the closest we can get to a recognizable
    // house emblem in plain pdfkit.
    const letter = (badge.house.name.charAt(0) || "H").toUpperCase();
    doc
      .save()
      .fillColor("#ffffff")
      .circle(22, ribbonH / 2 + 2, 13)
      .fill()
      .restore();
    doc
      .fillColor(ribbonColor)
      .fontSize(16)
      .text(letter, 16, ribbonH / 2 - 6, {
        width: 12,
        align: "center",
        lineBreak: false,
      });
    doc
      .fillColor("#ffffff")
      .fontSize(12)
      .text(`${badge.house.name} House`, 40, ribbonH / 2 - 5, {
        width: W - 48,
        lineBreak: false,
      });
  } else {
    doc
      .fillColor("#ffffff")
      .fontSize(11)
      .text("Student ID", 12, ribbonH / 2 - 4, {
        width: W - 16,
        lineBreak: false,
      });
  }

  doc
    .fillColor("#475569")
    .fontSize(8)
    .text(badge.schoolName, PAGE_MARGIN, ribbonH + 8, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      lineBreak: false,
    });

  // Photo slot — rectangle (user explicitly approved rectangle on
  // the ID badge in Phase 4). Falls back to a colored initials bubble
  // when no photo bytes are available. Slightly compressed from the
  // original 90×108 to make room for the new "Grade · Car Rider"
  // line + the crisis hotline footer without overflowing the page.
  const photoW = 88;
  const photoH = 100;
  const photoX = (W - photoW) / 2;
  const photoY = ribbonH + 18;
  if (badge.photoBytes) {
    // Border frame in house color so the badge still reads as
    // "belonging to this house" even without the bubble.
    const frame = badge.house ? normalizeHex(badge.house.color) : "#475569";
    doc
      .save()
      .lineWidth(2)
      .strokeColor(frame)
      .roundedRect(photoX - 1, photoY - 1, photoW + 2, photoH + 2, 4)
      .stroke()
      .restore();
    try {
      doc.image(badge.photoBytes, photoX, photoY, {
        width: photoW,
        height: photoH,
        cover: [photoW, photoH],
        align: "center",
        valign: "center",
      });
    } catch {
      // Corrupt image — fall back silently to the initials bubble.
      drawInitialsBubble(doc, badge, photoX, photoY, photoW, photoH);
    }
  } else {
    drawInitialsBubble(doc, badge, photoX, photoY, photoW, photoH);
  }

  const nameY = photoY + photoH + 6;
  doc
    .fillColor("#111827")
    .fontSize(14)
    .text(`${badge.firstName} ${badge.lastName}`, PAGE_MARGIN, nameY, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      ellipsis: true,
      height: 18,
    });
  // "Grade 6 · Car Rider" — combine grade and dismissal so the
  // front-office desk can answer the dismissal question without
  // looking the student up.
  const dLabel = dismissalLabel(badge.dismissalMode);
  const gradeBits: string[] = [];
  if (badge.grade !== null) gradeBits.push(`Grade ${badge.grade}`);
  if (dLabel) gradeBits.push(dLabel);
  if (gradeBits.length > 0) {
    doc
      .fillColor("#475569")
      .fontSize(9)
      .text(gradeBits.join(" · "), PAGE_MARGIN, nameY + 18, {
        width: W - PAGE_MARGIN * 2,
        align: "center",
        lineBreak: false,
      });
  }

  // Layout note: page is 243×306. Targets:
  //   QR 56pt → barcode 16pt → crisis line 1 → crisis line 2
  // Final y of crisis line 2 must clear (H - bottomMargin) = 304.
  // Bottom margin lowered to 2 in the PDFDocument config above so
  // text() at y=294 doesn't trigger pdfkit's auto-page (the bug
  // that put "Text HOME to 741741" on a phantom page 2).
  const qrBuf = await renderQrBuffer(badge);
  const qrSize = 56;
  const qrX = (W - qrSize) / 2;
  const qrY = nameY + 34;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  const barcodePng = await renderBarcodeBuffer(badge.studentId);
  const bcW = W - PAGE_MARGIN * 2 - 30;
  const bcH = 16;
  const bcX = (W - bcW) / 2;
  const bcY = qrY + qrSize + 4;
  doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });

  // Crisis hotlines — required on FL student IDs grades 6-12 by
  // HB 383 (effective 2021-07-01): 988 Suicide & Crisis Lifeline +
  // a text line. We include the Crisis Text Line (HOME → 741741)
  // as the companion text channel. 988 line is red so it's the
  // first thing the eye finds on the lower half of the badge.
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

async function renderCr80Badge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const W = CR80_W;
  const H = CR80_H;
  const leftColW = 138;
  const rightColX = leftColW + 4;
  const rightColW = W - rightColX - 4;

  // Card outline
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(2, 2, W - 4, H - 4, 6)
    .stroke()
    .restore();

  // Colored left band — house color or neutral.
  const bandColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";
  doc
    .save()
    .fillColor(bandColor)
    .roundedRect(2, 2, leftColW, H - 4, 6)
    .fill()
    .restore();
  // Square the right edge of the band so it butts against the right
  // column cleanly.
  doc
    .save()
    .fillColor(bandColor)
    .rect(leftColW - 4, 2, 6, H - 4)
    .fill()
    .restore();

  // Initials bubble (top-left of band)
  const bubbleSize = 40;
  const bubbleX = 10;
  const bubbleY = 10;
  doc
    .save()
    .fillColor("#ffffff")
    .circle(bubbleX + bubbleSize / 2, bubbleY + bubbleSize / 2, bubbleSize / 2)
    .fill()
    .restore();
  const initials = computeInitials(badge);
  doc
    .fillColor(bandColor)
    .fontSize(18)
    .text(initials, bubbleX, bubbleY + bubbleSize / 2 - 9, {
      width: bubbleSize,
      align: "center",
      lineBreak: false,
    });

  // House label beside bubble
  if (badge.house) {
    doc
      .fillColor("#ffffff")
      .fontSize(8)
      .text(`${badge.house.name} House`, bubbleX + bubbleSize + 6, bubbleY + 4, {
        width: leftColW - (bubbleX + bubbleSize + 10),
        lineBreak: false,
      });
  }
  doc
    .fillColor("rgba(255,255,255,0.85)")
    .fontSize(7)
    .text(
      badge.schoolName,
      bubbleX + bubbleSize + 6,
      bubbleY + (badge.house ? 16 : 8),
      {
        width: leftColW - (bubbleX + bubbleSize + 10),
        lineBreak: false,
      },
    );

  // Name + grade beneath the bubble row
  const nameY = bubbleY + bubbleSize + 8;
  doc
    .fillColor("#ffffff")
    .fontSize(12)
    .text(`${badge.firstName} ${badge.lastName}`, 8, nameY, {
      width: leftColW - 12,
      ellipsis: true,
      height: 16,
    });
  const cr80Dlabel = dismissalLabel(badge.dismissalMode);
  const cr80Bits: string[] = [];
  if (badge.grade !== null) cr80Bits.push(`Grade ${badge.grade}`);
  if (cr80Dlabel) cr80Bits.push(cr80Dlabel);
  if (cr80Bits.length > 0) {
    doc
      .fillColor("rgba(255,255,255,0.85)")
      .fontSize(8)
      .text(cr80Bits.join(" · "), 8, nameY + 16, {
        width: leftColW - 12,
        lineBreak: false,
      });
  }
  // Visible "ID …" line removed by request — a lost CR80 badge would
  // otherwise expose the student number in plain text. QR + Code 128
  // still encode the ID for kiosk sign-in.

  // Right column — QR on top, Code 128 below.
  const qrBuf = await renderQrBuffer(badge);
  const qrSize = 70;
  const qrX = rightColX + (rightColW - qrSize) / 2;
  const qrY = 8;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  const barcodePng = await renderBarcodeBuffer(badge.studentId);
  const bcW = rightColW - 6;
  const bcH = 28;
  const bcX = rightColX + (rightColW - bcW) / 2;
  const bcY = qrY + qrSize + 4;
  doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });

  // Crisis hotlines — see lanyard comment above (FL HB 383 mandate).
  // CR80 has less vertical room; we stack the two lines tightly in
  // the right column under the barcode.
  doc
    .fillColor("#b91c1c")
    .fontSize(6)
    .text("Crisis? Call or text 988", rightColX, bcY + bcH + 2, {
      width: rightColW,
      align: "center",
      lineBreak: false,
    });
  doc
    .fillColor("#475569")
    .fontSize(6)
    .text("Text HOME to 741741", rightColX, bcY + bcH + 10, {
      width: rightColW,
      align: "center",
      lineBreak: false,
    });
}

// Lanyard-only initials-bubble fallback. Draws a circle inside the
// reserved photo slot so the layout below it doesn't shift whether
// or not a photo is present.
function drawInitialsBubble(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
  slotX: number,
  slotY: number,
  slotW: number,
  slotH: number,
): void {
  const bubbleSize = Math.min(slotW, slotH);
  const bubbleX = slotX + (slotW - bubbleSize) / 2;
  const bubbleY = slotY + (slotH - bubbleSize) / 2;
  const bubbleColor = badge.house
    ? normalizeHex(badge.house.color)
    : "#475569";
  doc
    .save()
    .fillColor(bubbleColor)
    .circle(bubbleX + bubbleSize / 2, bubbleY + bubbleSize / 2, bubbleSize / 2)
    .fill()
    .restore();
  const initials = computeInitials(badge);
  doc
    .fillColor("#ffffff")
    .fontSize(Math.min(36, bubbleSize / 2.4))
    .text(
      initials,
      bubbleX,
      bubbleY + bubbleSize / 2 - Math.min(20, bubbleSize / 4),
      {
        width: bubbleSize,
        align: "center",
        lineBreak: false,
      },
    );
}

function computeInitials(badge: StudentBadgeInput): string {
  return (
    `${(badge.firstName[0] ?? "").toUpperCase()}${(badge.lastName[0] ?? "").toUpperCase()}` ||
    "?"
  );
}

async function renderQrBuffer(badge: StudentBadgeInput): Promise<Buffer> {
  const qrUrl = `${badge.baseUrl}?signin=${encodeURIComponent(badge.studentId)}`;
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
