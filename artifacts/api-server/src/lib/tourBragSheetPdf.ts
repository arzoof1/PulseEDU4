import PDFDocument from "pdfkit";

// Printable "brag sheet" for a tour guide — the family's interests and
// details on one page so the visit can be personalized. Generated on demand
// from a lead; returns a PDF buffer.

export interface BragSheetInput {
  schoolName: string;
  familyName: string;
  phone: string;
  email: string | null;
  preferredLanguage: string;
  children: { name: string; grade: string }[];
  // The checkpoint stops the family ticked on the request form, resolved to
  // their current labels in page order.
  selectedStops: string[];
  // Free-text "anything else?" note from the family (optional).
  interests: string;
  source: string | null;
  status: string;
  assignedTo: string | null;
  requestedAt: Date;
  tourScheduledAt: Date | null;
  // District branding (set once by SuperUser). Rendered at the top when
  // present and the district's "printed documents" toggle is on; the route
  // only passes these through when that toggle is enabled.
  districtLogo?: Buffer | null;
  districtTagline?: string | null;
}

const ACCENT = "#0ea5a4";
const INK = "#1f2937";
const MUTED = "#6b7280";

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

export function buildTourBragSheetPdf(input: BragSheetInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks))),
  );

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Header band
  doc.rect(0, 0, doc.page.width, 96).fill(ACCENT);
  doc
    .fillColor("#ffffff")
    .fontSize(11)
    .font("Helvetica")
    .text("SCHOOL TOURS · BRAG SHEET", left, 30, { characterSpacing: 1.5 });
  doc
    .fillColor("#ffffff")
    .fontSize(22)
    .font("Helvetica-Bold")
    .text(input.schoolName, left, 50, { width });

  // District logo, top-right within the header band.
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

  doc.y = 130;
  doc.fillColor(INK);

  // District tagline, just under the band.
  if (input.districtTagline) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(10)
      .fillColor(MUTED)
      .text(input.districtTagline, left, 104, { width });
    doc.y = 130;
    doc.fillColor(INK);
  }

  // Family block
  doc.font("Helvetica-Bold").fontSize(18).text(input.familyName, left);
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
    doc.moveDown(0.4);
  };

  row("Phone", input.phone);
  row("Email", input.email || "—");
  row("Language", input.preferredLanguage === "es" ? "Spanish" : "English");
  row(
    "Student(s)",
    input.children.length
      ? input.children
          .map((c) => `${c.name} (Grade ${c.grade})`)
          .join("   •   ")
      : "—",
  );
  row("Source", input.source || "—");
  row("Requested", fmtDate(input.requestedAt));
  row("Tour scheduled", fmtDate(input.tourScheduledAt));
  row("Status", input.status);
  row("Owner", input.assignedTo || "Unassigned");

  doc.moveDown(0.6);

  // Interests highlight box — the checkpoints they ticked (structured) plus any
  // free-text note. Height is measured from the content so longer lists never
  // clip.
  const padX = 16;
  const innerW = width - padX * 2;
  const stopLines = input.selectedStops.map((s) => `•  ${s}`);
  const freeText = input.interests.trim();
  const hasStops = stopLines.length > 0;
  const hasFree = freeText.length > 0;

  doc.font("Helvetica").fontSize(12);
  let contentH = 0;
  for (const line of stopLines) {
    contentH += doc.heightOfString(line, { width: innerW }) + 3;
  }
  if (hasFree) {
    if (hasStops) contentH += 8;
    contentH += 16; // "ANYTHING ELSE" label row
    contentH += doc.heightOfString(freeText, { width: innerW });
  }
  if (!hasStops && !hasFree) {
    contentH += doc.heightOfString("No specific interests noted.", {
      width: innerW,
    });
  }
  const headerH = 32;
  const boxH = headerH + contentH + 18;

  // Keep the box (plus room for the personalize prompt + footer) on one page;
  // a long checkpoint list or note can otherwise overflow the page bottom.
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + boxH + 90 > bottom) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }

  const boxY = doc.y;
  doc.roundedRect(left, boxY, width, boxH, 10).fillAndStroke("#f0fdfa", "#99f6e4");
  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("WHAT THEY WANT TO SEE", left + padX, boxY + 14, {
      characterSpacing: 1,
    });

  let cy = boxY + headerH;
  doc.fillColor(INK).font("Helvetica").fontSize(12);
  for (const line of stopLines) {
    doc.text(line, left + padX, cy, { width: innerW });
    cy = doc.y + 3;
  }
  if (hasFree) {
    if (hasStops) cy += 5;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(MUTED)
      .text("ANYTHING ELSE", left + padX, cy, { characterSpacing: 1 });
    cy = doc.y + 2;
    doc
      .font("Helvetica")
      .fontSize(12)
      .fillColor(INK)
      .text(freeText, left + padX, cy, { width: innerW });
  }
  if (!hasStops && !hasFree) {
    doc.text("No specific interests noted.", left + padX, cy, { width: innerW });
  }

  doc.y = boxY + boxH;
  doc.moveDown(0.5);

  // Personalize prompt
  doc
    .fillColor(MUTED)
    .font("Helvetica-Oblique")
    .fontSize(10)
    .text(
      "Personalize the visit: lead with the programs, electives, and staff that match the interests above. Walk past the spaces they care about first — families decide in the first ten minutes.",
      left,
      doc.y,
      { width },
    );

  doc.moveDown(1.5);
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .text("Generated by PulseEDU · School Tours", left, doc.y, { width });

  doc.end();
  return done;
}
