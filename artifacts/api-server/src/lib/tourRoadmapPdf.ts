import PDFDocument from "pdfkit";

// Tour Roadmap — the staff-facing, "both-in-one" tour plan for a single lead.
// Top: prep info (family, children/grades, language, scheduled time, owner,
// contact, what they asked to see). Bottom: a check-off list of exactly the
// stops the family selected, each with location, talking points, an estimated
// duration, and blank lines the guide fills in during the walk. Generated on
// demand; returns a PDF buffer.

export interface RoadmapStop {
  label: string;
  location: string;
  talkingPoints: string;
  minutes: number;
}

export interface RoadmapInput {
  schoolName: string;
  familyName: string;
  phone: string;
  email: string | null;
  preferredLanguage: string;
  children: { name: string; grade: string }[];
  status: string;
  assignedTo: string | null;
  requestedAt: Date;
  tourScheduledAt: Date | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // Free-text "anything else?" note from the family (optional).
  notes: string;
  // The selected checkpoints, in the page's checkpoint order.
  stops: RoadmapStop[];
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
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function buildTourRoadmapPdf(input: RoadmapInput): Promise<Buffer> {
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
    .text("SCHOOL TOURS · TOUR ROADMAP", left, 30, { characterSpacing: 1.5 });
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

  // ---- Prep block ---------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text(input.familyName, left);
  doc.moveDown(0.3);

  const row = (label: string, value: string) => {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(label, left, y, {
      width: 120,
    });
    doc
      .font("Helvetica")
      .fontSize(12)
      .fillColor(INK)
      .text(value, left + 130, y, { width: width - 130 });
    doc.moveDown(0.35);
  };

  row("Phone", input.phone);
  row("Email", input.email || "—");
  row("Language", input.preferredLanguage === "es" ? "Spanish" : "English");
  row(
    "Student(s)",
    input.children.length
      ? input.children.map((c) => `${c.name} (Grade ${c.grade})`).join("   •   ")
      : "—",
  );
  row("Tour scheduled", fmtDate(input.tourScheduledAt));
  row("Guide / owner", input.assignedTo || "Unassigned");
  row("Status", input.status);
  row("Requested", fmtDate(input.requestedAt));

  // ---- "Anything else?" note ---------------------------------------------
  if (input.notes.trim()) {
    doc.moveDown(0.5);
    const boxTop = doc.y;
    const noteHeight =
      doc.font("Helvetica").fontSize(12).heightOfString(input.notes, {
        width: width - 32,
      }) + 40;
    doc
      .roundedRect(left, boxTop, width, noteHeight, 10)
      .fillAndStroke("#f0fdfa", "#99f6e4");
    doc
      .fillColor(accent)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("FROM THE FAMILY", left + 16, boxTop + 12, { characterSpacing: 1 });
    doc
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(12)
      .text(input.notes, left + 16, boxTop + 28, { width: width - 32 });
    doc.y = boxTop + noteHeight;
  }

  // ---- Checklist heading --------------------------------------------------
  const totalMinutes = input.stops.reduce((s, c) => s + (c.minutes || 0), 0);
  doc.moveDown(0.9);
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(INK)
    .text("Tour stops", left, doc.y, { continued: true });
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(MUTED)
    .text(
      `    ${input.stops.length} selected${
        totalMinutes > 0 ? ` · ~${totalMinutes} min` : ""
      }`,
    );
  doc.moveDown(0.4);
  doc
    .moveTo(left, doc.y)
    .lineTo(left + width, doc.y)
    .strokeColor("#e5e7eb")
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.6);

  // ---- Stops --------------------------------------------------------------
  const ensureSpace = (needed: number) => {
    if (doc.y + needed > bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
  };

  if (input.stops.length === 0) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(11)
      .fillColor(MUTED)
      .text(
        "This family didn't select specific stops. Use the prep notes above to plan the visit, and walk past the spaces they mention first.",
        left,
        doc.y,
        { width },
      );
  }

  input.stops.forEach((stop, i) => {
    // Rough height estimate for this block so we don't split a stop awkwardly:
    // title row + location + talking points + two note lines.
    const tpHeight = stop.talkingPoints
      ? doc.font("Helvetica").fontSize(10).heightOfString(stop.talkingPoints, {
          width: width - 34,
        })
      : 0;
    const blockHeight = 26 + (stop.location ? 14 : 0) + tpHeight + 46;
    ensureSpace(blockHeight);

    const topY = doc.y;
    // Checkbox
    doc
      .roundedRect(left, topY + 1, 14, 14, 3)
      .lineWidth(1.2)
      .strokeColor(accent)
      .stroke();
    // Label + minutes
    const minutesLabel = stop.minutes > 0 ? `  ·  ~${stop.minutes} min` : "";
    doc
      .font("Helvetica-Bold")
      .fontSize(12.5)
      .fillColor(INK)
      .text(`${i + 1}. ${stop.label}`, left + 24, topY, {
        width: width - 24,
        continued: minutesLabel ? true : false,
      });
    if (minutesLabel) {
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor(MUTED)
        .text(minutesLabel);
    }
    // Location
    if (stop.location) {
      doc
        .font("Helvetica-Oblique")
        .fontSize(10)
        .fillColor(MUTED)
        .text(stop.location, left + 24, doc.y + 1, {
          width: width - 24,
        });
    }
    // Talking points
    if (stop.talkingPoints) {
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#374151")
        .text(stop.talkingPoints, left + 24, doc.y + 3, { width: width - 34 });
    }
    // Blank note lines for the guide
    let lineY = doc.y + 12;
    for (let n = 0; n < 2; n++) {
      doc
        .moveTo(left + 24, lineY)
        .lineTo(left + width, lineY)
        .strokeColor("#d1d5db")
        .lineWidth(0.6)
        .stroke();
      lineY += 16;
    }
    doc.y = lineY + 4;
  });

  // ---- Footer -------------------------------------------------------------
  ensureSpace(60);
  doc.moveDown(0.6);
  const contactBits = [
    input.contactPhone ? `Call: ${input.contactPhone}` : null,
    input.contactEmail ? `Email: ${input.contactEmail}` : null,
  ].filter(Boolean) as string[];
  if (contactBits.length) {
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
