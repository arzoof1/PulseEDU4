// Per-student printable ID badges (Phase 3). One badge per page so the
// same admin can run them through a perforated badge-stock printer or a
// plain laser printer + cutter. Mirrors the kioskCardsPdf shape:
//   - Colored house ribbon across the top (if assigned)
//   - Big name + grade + student ID
//   - QR code encoding `${baseUrl}?signin=<studentId>` so a phone or
//     hardware scanner pointed at the badge takes the kiosk straight to
//     the sign-in flow already pre-filled
//   - Code 128 of the raw studentId for hardware laser/CCD scanners
//   - Initials bubble (no photo until Student Photos work lands)

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import { normalizeHex } from "./pdfColors";

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
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: { Title: "Student ID Badges" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  for (let i = 0; i < badges.length; i++) {
    if (i > 0) doc.addPage();
    await renderOneBadge(doc, badges[i]);
  }

  doc.end();
  return done;
}

async function renderOneBadge(
  doc: PDFKit.PDFDocument,
  badge: StudentBadgeInput,
) {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const width =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // House ribbon — identical to kioskCardsPdf so a school's printed
  // materials read as a consistent set.
  let topOffset = 0;
  if (badge.house) {
    const ribbonH = 48;
    const ribbonY = top - 28;
    const color = normalizeHex(badge.house.color);
    doc
      .save()
      .fillColor(color)
      .rect(left - 20, ribbonY, width + 40, ribbonH)
      .fill()
      .restore();
    const emblemCx = left + 12;
    const emblemCy = ribbonY + ribbonH / 2;
    doc
      .save()
      .fillColor("#ffffff")
      .circle(emblemCx, emblemCy, 16)
      .fill()
      .restore();
    const letter = (badge.house.name.charAt(0) || "H").toUpperCase();
    doc
      .fillColor(color)
      .fontSize(18)
      .text(letter, emblemCx - 6, emblemCy - 9, { lineBreak: false });
    doc
      .fillColor("#ffffff")
      .fontSize(16)
      .text(`${badge.house.name} House`, emblemCx + 24, emblemCy - 8, {
        width: width - 60,
        lineBreak: false,
      });
    topOffset = ribbonH - 14;
  }

  // School name
  doc
    .fillColor("#6b7280")
    .fontSize(12)
    .text(badge.schoolName, left, top + topOffset, {
      width,
      align: "center",
    });

  // Title
  doc
    .fillColor("#111827")
    .fontSize(22)
    .text("Student ID", left, top + 22 + topOffset, {
      width,
      align: "center",
    });

  // Initials bubble (left), name + grade + id (right). Bubble is a
  // colored circle with the student's initials — placeholder until the
  // deferred Student Photos work lands; the layout reserves the same
  // square box so a future photo drop-in is non-breaking.
  const bubbleSize = 110;
  const bubbleX = left + 30;
  const bubbleY = top + 80 + topOffset;
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
    .fontSize(48)
    .text(initials, bubbleX, bubbleY + bubbleSize / 2 - 26, {
      width: bubbleSize,
      align: "center",
      lineBreak: false,
    });

  // Right column text block
  const textX = bubbleX + bubbleSize + 30;
  const textW = width - (textX - left);
  doc
    .fillColor("#111827")
    .fontSize(26)
    .text(`${badge.firstName} ${badge.lastName}`, textX, bubbleY + 6, {
      width: textW,
    });
  if (badge.grade !== null) {
    doc
      .fillColor("#374151")
      .fontSize(14)
      .text(`Grade ${badge.grade}`, textX, bubbleY + 44, {
        width: textW,
      });
  }
  doc
    .fillColor("#6b7280")
    .fontSize(13)
    .text(`ID ${badge.studentId}`, textX, bubbleY + 64, { width: textW });

  // -- QR code (left) + Code 128 (right), same layout as kiosk cards --
  const qrUrl = `${badge.baseUrl}?signin=${encodeURIComponent(badge.studentId)}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    margin: 1,
    width: 240,
    errorCorrectionLevel: "M",
  });
  const qrBuf = Buffer.from(qrDataUrl.split(",")[1], "base64");
  const qrSize = 200;
  const qrX = left + 20;
  const qrY = bubbleY + bubbleSize + 40;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
  doc
    .fillColor("#374151")
    .fontSize(11)
    .text("Scan to sign in", qrX, qrY + qrSize + 6, {
      width: qrSize,
      align: "center",
    });

  const barcodePng = await bwipjs.toBuffer({
    bcid: "code128",
    text: badge.studentId,
    scale: 2,
    height: 22,
    includetext: false,
    paddingwidth: 8,
    paddingheight: 8,
    backgroundcolor: "FFFFFF",
  });
  const bcW = 240;
  const bcH = 90;
  const bcX = left + width - 20 - bcW;
  const bcY = qrY + 30;
  doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });
  doc
    .fillColor("#374151")
    .fontSize(11)
    .text("Hardware scanner", bcX, bcY + bcH + 6, {
      width: bcW,
      align: "center",
    });

  // Footer
  const footY = qrY + qrSize + 50;
  doc
    .fillColor("#374151")
    .fontSize(11)
    .text(
      "Show this badge to the classroom kiosk to sign in. " +
        "If you lose this badge, ask an administrator to print a new one.",
      left + 30,
      footY,
      { width: width - 60, align: "center" },
    );
}
