// Per-teacher hall-pass kiosk activation cards. One card per page
// (full Letter), prints three encodings of the same enrollment token
// so a teacher always has a working path even when one channel fails:
//   - QR code: phone camera or USB QR scanner
//   - Code 128 barcode: hardware laser/CCD scanner
//   - 6-digit PIN: typed manually
//
// Mirrors the pickupTagsPdf pattern (pdfkit + Buffer return).

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import bwipjs from "bwip-js";

export interface KioskCardInput {
  teacherName: string;
  room: string | null;
  schoolName: string;
  // The raw enrollment token (the secret encoded into the QR + Code 128).
  // Caller is responsible for never persisting this — only the hash is
  // stored in kiosk_enroll_tokens.token_hash.
  enrollToken: string;
  // The raw 6-digit PIN. Same one-shot rule as enrollToken.
  pin: string;
  // The base URL the kiosk lives at, e.g.
  // "https://my-school.pulseedu.com/kiosk". The QR encodes
  // `${baseUrl}?enroll=${enrollToken}` so scanning with a phone opens
  // the kiosk page already pre-filled. Hardware scanners that just
  // type the QR contents into a focused input field will still see the
  // URL — the kiosk page detects pasted-URL input too.
  baseUrl: string;
}

export async function renderKioskCardsPdf(
  cards: KioskCardInput[],
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: { Title: "Hall Pass Kiosk Activation Cards" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  for (let i = 0; i < cards.length; i++) {
    if (i > 0) doc.addPage();
    await renderOneCard(doc, cards[i]);
  }

  doc.end();
  return done;
}

async function renderOneCard(
  doc: PDFKit.PDFDocument,
  card: KioskCardInput,
) {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const width =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // School name (small, top, gray)
  doc
    .fillColor("#6b7280")
    .fontSize(12)
    .text(card.schoolName, left, top, { width, align: "center" });

  // Big title
  doc
    .fillColor("#111827")
    .fontSize(28)
    .text("Hall Pass Kiosk Activation", left, top + 22, {
      width,
      align: "center",
    });

  // Teacher name + room
  doc
    .fillColor("#111827")
    .fontSize(22)
    .text(card.teacherName, left, top + 70, { width, align: "center" });
  if (card.room) {
    doc
      .fillColor("#374151")
      .fontSize(16)
      .text(`Room ${card.room}`, left, top + 100, {
        width,
        align: "center",
      });
  }

  // -- QR code (left column) -------------------------------------------
  const qrUrl = `${card.baseUrl}?enroll=${encodeURIComponent(card.enrollToken)}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    margin: 1,
    width: 260,
    errorCorrectionLevel: "M",
  });
  const qrBuf = Buffer.from(qrDataUrl.split(",")[1], "base64");
  const qrSize = 220;
  const qrX = left + 20;
  const qrY = top + 160;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
  doc
    .fillColor("#374151")
    .fontSize(11)
    .text("Scan with phone camera", qrX, qrY + qrSize + 6, {
      width: qrSize,
      align: "center",
    });

  // -- Code 128 barcode (right column) --------------------------------
  const barcodePng = await bwipjs.toBuffer({
    bcid: "code128",
    text: card.enrollToken,
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
    .text("Hardware barcode scanner", bcX, bcY + bcH + 6, {
      width: bcW,
      align: "center",
    });

  // 6-digit PIN row (centered, big)
  const pinY = qrY + qrSize + 50;
  doc
    .fillColor("#6b7280")
    .fontSize(11)
    .text("Or type your 6-digit PIN", left, pinY, {
      width,
      align: "center",
    });
  // Space the digits so they read like 123 456 instead of 123456
  const spacedPin = `${card.pin.slice(0, 3)}  ${card.pin.slice(3)}`;
  doc
    .fillColor("#111827")
    .fontSize(42)
    .text(spacedPin, left, pinY + 16, {
      width,
      align: "center",
      characterSpacing: 4,
    });

  // Footer instructions
  const footY = pinY + 90;
  doc
    .fillColor("#374151")
    .fontSize(11)
    .text(
      "Tap any of the three options on this card to sign this kiosk in for 14 days. " +
        "If you lose this card, ask an administrator to print a new one — the old card stops working immediately.",
      left + 30,
      footY,
      { width: width - 60, align: "center" },
    );
}
