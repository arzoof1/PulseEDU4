import PDFDocument from "pdfkit";

// Family-facing "Tour Note Catcher" — a take-along sheet the family uses
// during their visit to jot impressions and follow-up questions. General tour
// info up top, then a labelled note area for each stop they asked to see
// (label only — the staff-only location/talking-points never appear here),
// plus a general follow-up section and contact details. Generated on demand
// from a lead; returns a PDF buffer.

export interface NoteCatcherStop {
  label: string;
}

export interface NoteCatcherInput {
  schoolName: string;
  familyName: string;
  tourScheduledAt: Date | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // The stops the family selected, in page order (label only).
  stops: NoteCatcherStop[];
  accentColor: string;
  // District branding (set once by SuperUser). Only passed through when the
  // district's "printed documents" toggle is on.
  districtLogo?: Buffer | null;
  districtTagline?: string | null;
}

const INK = "#1f2937";
const MUTED = "#6b7280";

function safeAccent(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#0ea5a4";
}

function fmtDate(d: Date | null): string {
  if (!d) return "To be scheduled";
  return d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function buildTourNoteCatcherPdf(
  input: NoteCatcherInput,
): Promise<Buffer> {
  const accent = safeAccent(input.accentColor);
  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks))),
  );

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  // ---- Header band --------------------------------------------------------
  doc.rect(0, 0, doc.page.width, 96).fill(accent);
  doc
    .fillColor("#ffffff")
    .fontSize(11)
    .font("Helvetica")
    .text("SCHOOL TOURS · MY TOUR NOTES", left, 30, { characterSpacing: 1.5 });
  doc
    .fillColor("#ffffff")
    .fontSize(22)
    .font("Helvetica-Bold")
    .text(input.schoolName, left, 50, { width: width - 110 });

  if (input.districtLogo) {
    try {
      doc.image(input.districtLogo, doc.page.width - left - 96, 24, {
        fit: [96, 48],
        align: "right",
      });
    } catch {
      /* bad/unsupported image bytes — skip silently */
    }
  }

  doc.y = 116;
  doc.fillColor(INK);
  if (input.districtTagline) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(10)
      .fillColor(MUTED)
      .text(input.districtTagline, left, 104, { width });
    doc.y = 128;
    doc.fillColor(INK);
  }

  // ---- Intro --------------------------------------------------------------
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(INK)
    .text(input.familyName, left);
  doc.moveDown(0.2);
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(MUTED)
    .text(`Tour: ${fmtDate(input.tourScheduledAt)}`, left);
  doc.moveDown(0.4);
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#374151")
    .text(
      "Use this sheet during your visit to jot down what stands out and any questions you'd like us to follow up on. We'll be glad to answer anything afterward.",
      left,
      doc.y,
      { width },
    );
  doc.moveDown(0.8);

  // ---- Helpers ------------------------------------------------------------
  const ensureSpace = (needed: number) => {
    if (doc.y + needed > bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
  };

  const ruledLines = (count: number) => {
    let lineY = doc.y + 8;
    for (let n = 0; n < count; n++) {
      doc
        .moveTo(left, lineY)
        .lineTo(left + width, lineY)
        .strokeColor("#d1d5db")
        .lineWidth(0.6)
        .stroke();
      lineY += 22;
    }
    doc.y = lineY;
  };

  const sectionHeading = (title: string) => {
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(title, left);
    doc.moveDown(0.2);
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor("#e5e7eb")
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.5);
  };

  // ---- Per-stop note areas ------------------------------------------------
  if (input.stops.length > 0) {
    sectionHeading("What you asked to see");
    input.stops.forEach((stop, i) => {
      // Measure the (possibly wrapping) heading so long labels never push the
      // prompt + ruled lines off the page.
      const headingText = `${i + 1}. ${stop.label}`;
      const headingH = doc
        .font("Helvetica-Bold")
        .fontSize(12.5)
        .heightOfString(headingText, { width });
      // heading + prompt row + 3 ruled lines + spacing
      const blockHeight = headingH + 14 + 3 * 22 + 14;
      ensureSpace(blockHeight);
      doc
        .font("Helvetica-Bold")
        .fontSize(12.5)
        .fillColor(accent)
        .text(headingText, left, doc.y, { width });
      doc
        .font("Helvetica-Oblique")
        .fontSize(9)
        .fillColor(MUTED)
        .text("Notes & questions to follow up on:", left, doc.y + 1);
      ruledLines(3);
      doc.moveDown(0.5);
    });
  } else {
    // No specific stops — give a generous open notes area instead.
    sectionHeading("Your notes");
    ensureSpace(8 * 22);
    ruledLines(8);
    doc.moveDown(0.5);
  }

  // ---- General follow-up questions ---------------------------------------
  ensureSpace(26 + 14 + 3 * 22 + 12);
  doc.moveDown(0.2);
  sectionHeading("Questions for follow-up");
  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(MUTED)
    .text("Anything you'd like us to answer after the tour:", left, doc.y);
  ruledLines(3);

  // ---- Footer — contact ---------------------------------------------------
  ensureSpace(56);
  doc.moveDown(0.9);
  const contactBits = [
    input.contactPhone ? `Call: ${input.contactPhone}` : null,
    input.contactEmail ? `Email: ${input.contactEmail}` : null,
  ].filter(Boolean) as string[];
  if (contactBits.length) {
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Questions after your visit?", left, doc.y, { width });
    doc.moveDown(0.2);
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(10)
      .text(contactBits.join("     •     "), left, doc.y, { width });
    doc.moveDown(0.4);
  }
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(9)
    .text("Generated by PulseEDU · School Tours", left, doc.y, { width });

  doc.end();
  return done;
}
