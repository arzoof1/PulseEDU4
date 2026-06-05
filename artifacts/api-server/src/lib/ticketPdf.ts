// Event-ticket PDF renderer. Mirrors the pickupTagsPdf pattern (pdfkit, QR via
// the `qrcode` package, returns a Buffer) so we don't pull in a new renderer.
//
// One "sheet" per student: a header (school + event details), the student's
// ticket cards (QR + "Ticket X of N" + short code, 2 per row), and the shared
// responsibility verbiage. A sheet can span multiple pages when a family was
// granted many tickets. Multiple sheets (e.g. the no-email office handout)
// concatenate, each starting on a fresh page.

import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import {
  TICKET_RESPONSIBILITY_HEADLINE,
  TICKET_RESPONSIBILITY_LINES,
  ticketShortCode,
} from "./ticketCopy.js";

export interface TicketPdfTicket {
  token: string;
  seq: number;
}

export interface TicketPdfSheet {
  studentName: string;
  grade: number | null;
  guardianName: string | null;
  tickets: TicketPdfTicket[];
}

export interface TicketPdfInput {
  schoolName: string;
  eventName: string;
  eventDate: string | null;
  startTime: string | null;
  location: string | null;
  sheets: TicketPdfSheet[];
}

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 612; // Letter @72dpi
const CONTENT_W = PAGE_WIDTH - PAGE_MARGIN * 2;
const CARDS_PER_ROW = 2;
const CARD_GAP = 16;
const CARD_W = (CONTENT_W - CARD_GAP * (CARDS_PER_ROW - 1)) / CARDS_PER_ROW;
const CARD_H = 170;

const COLORS = {
  ink: "#0f172a",
  muted: "#64748b",
  accent: "#1e3a8a",
  hair: "#cbd5e1",
  warnBg: "#fef3c7",
  warnInk: "#92400e",
};

export async function renderTicketsPdf(input: TicketPdfInput): Promise<Buffer> {
  // Pre-render QR PNGs for every token once.
  const qrByToken = new Map<string, Buffer>();
  for (const sheet of input.sheets) {
    for (const t of sheet.tickets) {
      if (!qrByToken.has(t.token)) {
        const png = await QRCode.toBuffer(t.token, {
          type: "png",
          errorCorrectionLevel: "M",
          margin: 0,
          width: 240,
        });
        qrByToken.set(t.token, png);
      }
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
        Title: `${input.eventName} — Tickets`,
        Author: "PulseEDU",
        Subject: "Event tickets",
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      input.sheets.forEach((sheet, sheetIdx) => {
        if (sheetIdx > 0) doc.addPage();
        drawSheet(doc, input, sheet, qrByToken);
      });
      if (input.sheets.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(12)
          .fillColor(COLORS.muted)
          .text("No tickets to display.", PAGE_MARGIN, PAGE_MARGIN);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function eventLine(input: TicketPdfInput): string {
  const parts: string[] = [];
  if (input.eventDate) parts.push(input.eventDate);
  if (input.startTime) parts.push(input.startTime);
  if (input.location) parts.push(input.location);
  return parts.join("  \u2022  ");
}

function drawHeader(doc: PDFKit.PDFDocument, input: TicketPdfInput): number {
  let y = PAGE_MARGIN;
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(COLORS.muted)
    .text(input.schoolName, PAGE_MARGIN, y, { width: CONTENT_W });
  y += 16;
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(COLORS.ink)
    .text(input.eventName, PAGE_MARGIN, y, { width: CONTENT_W });
  y += 26;
  const line = eventLine(input);
  if (line) {
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor(COLORS.accent)
      .text(line, PAGE_MARGIN, y, { width: CONTENT_W });
    y += 18;
  }
  return y + 6;
}

function drawSheet(
  doc: PDFKit.PDFDocument,
  input: TicketPdfInput,
  sheet: TicketPdfSheet,
  qrByToken: Map<string, Buffer>,
) {
  let y = drawHeader(doc, input);

  // Student banner
  const who =
    sheet.grade !== null && sheet.grade !== undefined
      ? `Tickets for ${sheet.studentName} \u2014 Grade ${sheet.grade}`
      : `Tickets for ${sheet.studentName}`;
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(COLORS.ink)
    .text(who, PAGE_MARGIN, y, { width: CONTENT_W });
  y += 18;
  const sub =
    sheet.tickets.length === 1
      ? "1 ticket \u2014 admit one person per code."
      : `${sheet.tickets.length} tickets \u2014 admit one person per code.`;
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(COLORS.muted)
    .text(sub, PAGE_MARGIN, y, { width: CONTENT_W });
  y += 20;

  const total = sheet.tickets.length;
  let col = 0;
  for (let i = 0; i < sheet.tickets.length; i++) {
    if (y + CARD_H > 792 - PAGE_MARGIN - 90) {
      doc.addPage();
      y = drawHeader(doc, input);
      col = 0;
    }
    const x = PAGE_MARGIN + col * (CARD_W + CARD_GAP);
    drawCard(
      doc,
      x,
      y,
      sheet.tickets[i],
      total,
      qrByToken.get(sheet.tickets[i].token)!,
    );
    col += 1;
    if (col >= CARDS_PER_ROW) {
      col = 0;
      y += CARD_H + CARD_GAP;
    }
  }
  if (col !== 0) y += CARD_H + CARD_GAP;

  drawResponsibility(doc, y + 6);
}

function drawCard(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  ticket: TicketPdfTicket,
  total: number,
  qrPng: Buffer,
) {
  doc
    .save()
    .lineWidth(1)
    .strokeColor(COLORS.hair)
    .roundedRect(x, y, CARD_W, CARD_H, 8)
    .stroke()
    .restore();

  const qrSize = 110;
  const qrX = x + (CARD_W - qrSize) / 2;
  doc.image(qrPng, qrX, y + 14, { width: qrSize, height: qrSize });

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(COLORS.ink)
    .text(`Ticket ${ticket.seq} of ${total}`, x + 8, y + qrSize + 22, {
      width: CARD_W - 16,
      align: "center",
    });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(
      `Admit one  \u2022  Code ${ticketShortCode(ticket.token)}`,
      x + 8,
      y + qrSize + 38,
      { width: CARD_W - 16, align: "center" },
    );
}

function drawResponsibility(doc: PDFKit.PDFDocument, y: number) {
  if (y > 792 - PAGE_MARGIN - 90) {
    doc.addPage();
    y = PAGE_MARGIN;
  }
  const boxH = 84;
  doc
    .save()
    .fillColor(COLORS.warnBg)
    .roundedRect(PAGE_MARGIN, y, CONTENT_W, boxH, 6)
    .fill()
    .restore();
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(COLORS.warnInk)
    .text(TICKET_RESPONSIBILITY_HEADLINE, PAGE_MARGIN + 10, y + 8, {
      width: CONTENT_W - 20,
    });
  let ty = y + 22;
  for (const line of TICKET_RESPONSIBILITY_LINES) {
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(COLORS.warnInk)
      .text(`\u2022  ${line}`, PAGE_MARGIN + 10, ty, {
        width: CONTENT_W - 20,
      });
    ty = doc.y + 2;
  }
}
