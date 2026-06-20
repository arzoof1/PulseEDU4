import PDFDocument from "pdfkit";

// Family-facing "Tour Note Catcher" — a take-along sheet the family uses
// during their visit to jot impressions and follow-up questions. General tour
// info up top, then a labelled note area for each stop they asked to see
// (label only — the staff-only location/talking-points never appear here),
// plus a general follow-up section and contact details. Generated on demand
// from a lead; returns a PDF buffer.

export interface NoteCatcherStop {
  label: string;
  // True when the family selected this stop themselves; false when it's a
  // school "always include" highlight we added to the route. Drives the
  // per-stop tag (✓ "You asked to see this" vs ★ "We added this for you").
  requested: boolean;
}

export interface NoteCatcherInput {
  schoolName: string;
  familyName: string;
  tourScheduledAt: Date | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // The tour route in page order (label only): the family's selected stops
  // plus the school's always-include highlights. `requested` on each stop
  // distinguishes the two for the per-stop tag.
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

  // pdfkit's built-in Helvetica is WinAnsi-encoded and has no ★/✓ glyphs, so
  // we draw both markers as vectors. (cx, cy) is the marker center.
  const drawStar = (cx: number, cy: number, outerR: number, color: string) => {
    const innerR = outerR * 0.42;
    const spikes = 5;
    const step = Math.PI / spikes;
    let rot = (Math.PI / 2) * 3;
    doc.save();
    doc.moveTo(cx, cy - outerR);
    for (let n = 0; n < spikes; n++) {
      doc.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
      rot += step;
      doc.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
      rot += step;
    }
    doc.closePath().fill(color);
    doc.restore();
  };

  const drawCheck = (cx: number, cy: number, r: number, color: string) => {
    doc.save();
    doc
      .lineWidth(1.6)
      .lineCap("round")
      .lineJoin("round")
      .strokeColor(color)
      .moveTo(cx - r, cy + r * 0.1)
      .lineTo(cx - r * 0.25, cy + r * 0.8)
      .lineTo(cx + r, cy - r * 0.7)
      .stroke();
    doc.restore();
  };

  // ---- Per-stop note areas ------------------------------------------------
  if (input.stops.length > 0) {
    sectionHeading("Your tour at a glance");
    doc
      .font("Helvetica-Oblique")
      .fontSize(10)
      .fillColor(MUTED)
      .text(
        "A mix of the places you asked about and a few highlights we think you'll love.",
        left,
        doc.y,
        { width },
      );
    doc.moveDown(0.7);
    const REQUESTED_COLOR = accent;
    const HIGHLIGHT_COLOR = "#d97706"; // amber — the school-added highlights
    input.stops.forEach((stop, i) => {
      const tagText = stop.requested
        ? "YOU ASKED TO SEE THIS"
        : "WE ADDED THIS FOR YOU";
      const tagColor = stop.requested ? REQUESTED_COLOR : HIGHLIGHT_COLOR;
      // Measure the (possibly wrapping) heading so long labels never push the
      // prompt + ruled lines off the page.
      const headingText = `${i + 1}. ${stop.label}`;
      const headingH = doc
        .font("Helvetica-Bold")
        .fontSize(12.5)
        .heightOfString(headingText, { width });
      // tag row + heading + prompt row + 3 ruled lines + spacing
      const blockHeight = 13 + headingH + 14 + 3 * 22 + 16;
      ensureSpace(blockHeight);

      // Tag row: vector marker (✓ requested / ★ highlight) + small caps label.
      const tagY = doc.y;
      const markerCy = tagY + 3.5;
      if (stop.requested) {
        drawCheck(left + 3.5, markerCy, 3.5, tagColor);
      } else {
        drawStar(left + 3.5, markerCy, 4.2, tagColor);
      }
      doc
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .fillColor(tagColor)
        .text(tagText, left + 13, tagY, { characterSpacing: 0.8, width: width - 13 });
      doc.y = tagY + 13;

      doc
        .font("Helvetica-Bold")
        .fontSize(12.5)
        .fillColor(INK)
        .text(headingText, left, doc.y, { width });
      doc
        .font("Helvetica-Oblique")
        .fontSize(9)
        .fillColor(MUTED)
        .text("Notes & questions to follow up on:", left, doc.y + 1);
      ruledLines(3);
      doc.moveDown(0.6);
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
