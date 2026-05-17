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
  size: BadgeSize = "lanyard",
): Promise<Buffer> {
  const [W, H] = size === "cr80" ? [CR80_W, CR80_H] : [LANYARD_W, LANYARD_H];
  const doc = new PDFDocument({
    size: [W, H],
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

  doc
    .fillColor("#475569")
    .fontSize(8)
    .text(badge.schoolName, PAGE_MARGIN, ribbonH + 8, {
      width: W - PAGE_MARGIN * 2,
      align: "center",
      lineBreak: false,
    });

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
  const initials = computeInitials(badge);
  doc
    .fillColor("#ffffff")
    .fontSize(30)
    .text(initials, bubbleX, bubbleY + bubbleSize / 2 - 17, {
      width: bubbleSize,
      align: "center",
      lineBreak: false,
    });

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

  const qrBuf = await renderQrBuffer(badge);
  const qrSize = 78;
  const qrX = (W - qrSize) / 2;
  const qrY = nameY + 36;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

  const barcodePng = await renderBarcodeBuffer(badge.studentId);
  const bcW = W - PAGE_MARGIN * 2 - 30;
  const bcH = 22;
  const bcX = (W - bcW) / 2;
  const bcY = qrY + qrSize + 4;
  doc.image(barcodePng, bcX, bcY, { width: bcW, height: bcH });

  doc
    .fillColor("#111827")
    .fontSize(9)
    .text(`ID ${badge.studentId}`, PAGE_MARGIN, H - 16, {
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
  if (badge.grade !== null) {
    doc
      .fillColor("rgba(255,255,255,0.85)")
      .fontSize(8)
      .text(`Grade ${badge.grade}`, 8, nameY + 16, {
        width: leftColW - 12,
        lineBreak: false,
      });
  }
  doc
    .fillColor("rgba(255,255,255,0.85)")
    .fontSize(7)
    .text(`ID ${badge.studentId}`, 8, H - 14, {
      width: leftColW - 12,
      lineBreak: false,
    });

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

  doc
    .fillColor("#475569")
    .fontSize(6)
    .text("Scan to sign in", rightColX, bcY + bcH + 2, {
      width: rightColW,
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
