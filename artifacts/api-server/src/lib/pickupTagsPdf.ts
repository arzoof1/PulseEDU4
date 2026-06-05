// Pickup car-tag PDF renderer. Mirrors the onboardingPdf pattern
// (pdfkit-based, returns Buffer) so we don't pull in a new renderer.
//
// Each tag is roughly the size of a credit-card hang tag — 4 per
// Letter-size page in a 2x2 grid, designed to be cut and laminated.
// Each tag carries:
//   - school name (small, top)
//   - student name (medium)
//   - guardian label ("Mom", "Aunt Sarah" — medium)
//   - the big 4-digit pickup number (centered, large)
//   - a small QR code encoding just the pickup number (Phase G of the
//     pickup module spec'd HMAC-signed payloads — this is the simpler
//     starting point; the curb keypad already accepts a typed number,
//     so the QR is just "type-it-for-me")
//
// Restricted authorizations get a RED border + "RESTRICTED" badge so
// no one accidentally prints + hands out a no-contact tag.

import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface PickupTagInput {
  pickupNumber: string;
  studentName: string;
  guardianLabel: string;
  restricted: boolean;
  schoolName: string;
}

const PAGE_MARGIN = 36;
const TAGS_PER_ROW = 2;
const TAGS_PER_COL = 2;
const PAGE_WIDTH = 612; // Letter, 8.5in x 72dpi
const PAGE_HEIGHT = 792;
const TAG_W = (PAGE_WIDTH - PAGE_MARGIN * 2) / TAGS_PER_ROW;
const TAG_H = (PAGE_HEIGHT - PAGE_MARGIN * 2) / TAGS_PER_COL;

const COLORS = {
  border: "#0f172a",
  restricted: "#b91c1c",
  text: "#0f172a",
  muted: "#64748b",
  number: "#1e3a8a",
};

export async function renderPickupTagsPdf(
  tags: PickupTagInput[],
): Promise<Buffer> {
  const qrPngByNumber = new Map<string, Buffer>();
  for (const t of tags) {
    if (!qrPngByNumber.has(t.pickupNumber)) {
      const png = await QRCode.toBuffer(t.pickupNumber, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 0,
        width: 200,
      });
      qrPngByNumber.set(t.pickupNumber, png);
    }
  }

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
        Title: "PulseEDU Pickup Tags",
        Author: "PulseEDU",
        Subject: "Car-rider pickup tags",
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      tags.forEach((tag, idx) => {
        const slotOnPage = idx % (TAGS_PER_ROW * TAGS_PER_COL);
        if (idx > 0 && slotOnPage === 0) doc.addPage();
        const col = slotOnPage % TAGS_PER_ROW;
        const row = Math.floor(slotOnPage / TAGS_PER_ROW);
        const x = PAGE_MARGIN + col * TAG_W;
        const y = PAGE_MARGIN + row * TAG_H;
        drawTag(doc, x, y, tag, qrPngByNumber.get(tag.pickupNumber)!);
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawTag(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  tag: PickupTagInput,
  qrPng: Buffer,
) {
  const pad = 12;
  const borderColor = tag.restricted ? COLORS.restricted : COLORS.border;
  doc
    .save()
    .lineWidth(tag.restricted ? 3 : 1.5)
    .strokeColor(borderColor)
    .roundedRect(x + 6, y + 6, TAG_W - 12, TAG_H - 12, 10)
    .stroke()
    .restore();

  // School name (small, top)
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(tag.schoolName, x + pad, y + pad + 4, {
      width: TAG_W - pad * 2,
      align: "center",
    });

  // Student name
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(COLORS.text)
    .text(tag.studentName, x + pad, y + pad + 22, {
      width: TAG_W - pad * 2,
      align: "center",
      ellipsis: true,
    });

  // Guardian label
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(COLORS.muted)
    .text(`Pickup: ${tag.guardianLabel}`, x + pad, y + pad + 42, {
      width: TAG_W - pad * 2,
      align: "center",
      ellipsis: true,
    });

  // Big pickup number (centered, big)
  doc
    .font("Helvetica-Bold")
    .fontSize(64)
    .fillColor(COLORS.number)
    .text(`#${tag.pickupNumber}`, x + pad, y + TAG_H * 0.45 - 32, {
      width: TAG_W - pad * 2,
      align: "center",
    });

  // QR — bottom center
  const qrSize = 84;
  const qrX = x + (TAG_W - qrSize) / 2;
  const qrY = y + TAG_H - qrSize - pad - 16;
  doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

  // QR caption
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor(COLORS.muted)
    .text("Scan or type number at the curb", x + pad, qrY + qrSize + 2, {
      width: TAG_W - pad * 2,
      align: "center",
    });

  if (tag.restricted) {
    doc
      .save()
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(COLORS.restricted)
      .text("RESTRICTED — NO-CONTACT", x + pad, y + pad + 60, {
        width: TAG_W - pad * 2,
        align: "center",
      })
      .restore();
  }
}
