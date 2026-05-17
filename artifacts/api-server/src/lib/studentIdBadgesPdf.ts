// Per-student printable ID badges (Phase 3). Sized as a portrait
// lanyard ID badge — 3.375" × 4.25" (243 × 306 pt). Schools can run
// these on perforated badge stock or print on letter paper and trim.
// One badge per page. Contents:
//   - Colored house ribbon across the top (if assigned)
//   - School name + "Student ID" tag
//   - Initials bubble (placeholder for the deferred Student Photos work)
//   - Name + grade
//   - QR encoding `${baseUrl}?signin=<studentId>` — kiosk reads this and
//     pre-fills the sign-in flow
//   - Code 128 of the raw studentId for hardware laser/CCD scanners
//   - Student ID number

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import { normalizeHex } from "./pdfColors";

// Portrait lanyard ID badge — 3.375" × 4.25" at 72dpi
const BADGE_WIDTH = 243;
const BADGE_HEIGHT = 306;
const PAGE_MARGIN = 10;

export interface StudentBadgeInput {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | null;
  schoolName: string;
  // Same QR contract as the kiosk card: the kiosk page reads
  // `?signin=<studentId>` and pre-fills the sign-in field.
  baseUrl: string;
  house?: {
    name: string;
    color: string;
    iconKey: string | null;
  } | null;
}

export async function renderStudentBadgesPdf(
  badges: StudentBadgeInput[],
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [BADGE_WIDTH, BADGE_HEIGHT],
    margins: {
      top: PAGE_MARGIN,
      bottom: PAGE_MARGIN,
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
    if (i > 0) doc.addPage({ size: [BADGE_WIDTH, BADGE_HEIGHT] });
    await renderOneBadge(doc, badges[i]);
  }

  doc.end();
  return done;
}

async function renderOneBadge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const W = BADGE_WIDTH;
  const H = BADGE_HEIGHT;

  // Outer card border so a trimmer has a guideline when printing on
  // plain paper.
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .roundedRect(2, 2, W - 4, H - 4, 8)
    .stroke()
    .restore();

  // House ribbon across the top — colored band with the house name.
  // Falls back to a neutral header when the student has no house.
  const ribbonH = 36;
  const ribbonColor = badge.house ? normalizeHex(badge.house.color) : "#0f172a";
  doc
    .save()
    .fillColor(ribbonColor)
    .roundedRect(2, 2, W - 4, ribbonH, 8)
    .fill()
    .restore();
  // Square off the bottom of the rounded ribbon so it sits flush
  // against the rest of the card.
  doc
    .save()
    .fillColor(ribbonColor)
    .rect(2, ribbonH - 6, W - 4, 8)
    .fill()
    .restore();

  if (badge.house) {
    const letter = (badge.house.name.charAt(0) || "H").toUpperCase();
    doc
      .save()
      .fillColor("#ffffff")
      .circle(20, ribbonH / 2 + 2, 11)
      .fill()
      .restore();
    doc
      .fillColor(ribbonColor)
      .fontSize(13)
      .text(letter, 16, ribbonH / 2 - 5, { lineBreak: false });
    doc
      .fillColor("#ffffff")
      .fontSize(11)
      .text(`${badge.house.name} House`, 36, ribbonH / 2 - 4, {
        width: W - 44,
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

  // School name under the ribbon
  doc
    .fillColor("#475569")
    .fontSize(8)
    .text(badge.schoolName, PAGE_MARGIN, ribbonH + 8, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      lineBreak: false,
    });

  // Initials bubble — centered, colored to the house when present.
  const bubbleSize = 72;
  const bubbleX = (W - bubbleSize) / 2;
  const bubbleY = ribbonH + 22;
  const bubbleColor = badge.house
    ? normalizeHex(badge.house.color)
    : "#475569";
  doc
    .save()
    .fillColor(bubbleColor)
    .circle(bubbleX + bubbleSize / 2, bubbleY + bubbleSize / 2, bubbleSize / 2)
    .fill()
    .restore();
  const initials =
    `${(badge.firstName[0] ?? "").toUpperCase()}${(badge.lastName[0] ?? "").toUpperCase()}` ||
    "?";
  doc
    .fillColor("#ffffff")
    .fontSize(30)
    .text(initials, bubbleX, bubbleY + bubbleSize / 2 - 17, {
      width: bubbleSize,
      align: "center",
      lineBreak: false,
    });

  // Name + grade — centered, truncates with width-clipping rather than
  // wrapping to a third line so the card never breaks layout.
  const nameY = bubbleY + bubbleSize + 8;
  doc
    .fillColor("#111827")
    .fontSize(14)
    .text(`${badge.firstName} ${badge.lastName}`, PAGE_MARGIN, nameY, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      ellipsis: true,
      height: 18,
    });
  if (badge.grade !== null) {
    doc
      .fillColor("#475569")
      .fontSize(9)
      .text(`Grade ${badge.grade}`, PAGE_MARGIN, nameY + 18, {
        width: W - PAGE_MARGIN * 2,
        align: "center",
        lineBreak: false,
      });
  }

  // QR code — kiosk reads `?signin=<id>` from this URL and lands the
  // student straight on the welcome screen.
  const qrUrl = `${badge.baseUrl}?signin=${encodeURIComponent(badge.studentId)}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    margin: 1,
    width: 200,
    errorCorrectionLevel: "M",
  });
  const qrBuf = Buffer.from(qrDataUrl.split(",")[1], "base64");
  const qrSize = 78;
  const qrX = (W - qrSize) / 2;
  const qrY = nameY + 36;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  // Code 128 for hardware scanners — narrow strip beneath the QR.
  const barcodePng = await bwipjs.toBuffer({
    bcid: "code128",
    text: badge.studentId,
    scale: 2,
    height: 12,
    includetext: false,
    paddingwidth: 4,
    paddingheight: 4,
    backgroundcolor: "FFFFFF",
  });
  const bcW = W - PAGE_MARGIN * 2 - 30;
  const bcH = 22;
  const bcX = (W - bcW) / 2;
  const bcY = qrY + qrSize + 4;
  doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });

  // Student ID number — bottom strip
  doc
    .fillColor("#111827")
    .fontSize(9)
    .text(`ID ${badge.studentId}`, PAGE_MARGIN, H - 16, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      lineBreak: false,
    });
}
