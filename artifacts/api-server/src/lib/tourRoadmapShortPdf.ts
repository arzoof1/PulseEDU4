import PDFDocument from "pdfkit";

// Tour Roadmap — short ("1-page") variant. A stripped-down walking sheet for a
// guide (e.g. a principal) who doesn't need locations, talking points, or note
// space. Header: school + essential family info + the live-walk QR. Body: the
// tour route as plain tick-boxes (stop name only), each marked ✓ family-
// requested or ★ school-added. Generated on demand; returns a PDF buffer.

export interface RoadmapShortStop {
  label: string;
  // The family ticked this stop on the public form.
  familyRequested: boolean;
  // The school marked this checkpoint "always include" on every tour.
  schoolHighlight: boolean;
}

export interface RoadmapShortInput {
  schoolName: string;
  familyName: string;
  tourScheduledAt: Date | null;
  assignedTo: string | null;
  children: { name: string; grade: string }[];
  // The tour route in page order: family selections + always-include highlights.
  stops: RoadmapShortStop[];
  accentColor: string;
  // Phase 4 "Live Tour Capture": a pre-rendered QR PNG that deep-links the guide
  // to the token-gated live-walk screen, plus the human-readable URL beneath it.
  walkQrPng?: Buffer | null;
  walkUrl?: string | null;
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
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function buildTourRoadmapShortPdf(
  input: RoadmapShortInput,
): Promise<Buffer> {
  const accent = safeAccent(input.accentColor);
  const HIGHLIGHT = "#d97706"; // amber — the school-added highlights
  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks))),
  );

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  // pdfkit's built-in Helvetica is WinAnsi-encoded and has no ★/✓ glyphs, so
  // both origin markers are drawn as vectors. (cx, cy) is the marker center.
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

  // ---- Header band --------------------------------------------------------
  doc.rect(0, 0, doc.page.width, 96).fill(accent);
  doc
    .fillColor("#ffffff")
    .fontSize(11)
    .font("Helvetica")
    .text("SCHOOL TOURS · QUICK ROADMAP", left, 30, { characterSpacing: 1.5 });
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

  // ---- Essential family info ----------------------------------------------
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(INK)
    .text(input.familyName, left);
  doc.moveDown(0.3);

  const row = (label: string, value: string) => {
    const y = doc.y;
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text(label, left, y, { width: 110 });
    doc
      .font("Helvetica")
      .fontSize(12)
      .fillColor(INK)
      .text(value, left + 120, y, { width: width - 120 });
    doc.moveDown(0.35);
  };

  row(
    "Student(s)",
    input.children.length
      ? input.children.map((c) => `${c.name} (Grade ${c.grade})`).join("   •   ")
      : "—",
  );
  row("Tour scheduled", fmtDate(input.tourScheduledAt));
  row("Guide", input.assignedTo || "Unassigned");

  // ---- Live Tour Capture QR ----------------------------------------------
  if (input.walkQrPng) {
    doc.moveDown(0.5);
    const qrSize = 84;
    const boxTop = doc.y;
    const boxHeight = qrSize + 24;
    doc
      .roundedRect(left, boxTop, width, boxHeight, 10)
      .fillAndStroke("#f8fafc", "#e2e8f0");
    try {
      doc.image(input.walkQrPng, left + 12, boxTop + 12, {
        fit: [qrSize, qrSize],
      });
    } catch {
      /* bad QR bytes — skip the image, keep the caption */
    }
    const textX = left + 12 + qrSize + 16;
    const textW = width - (12 + qrSize + 16) - 16;
    doc
      .fillColor(accent)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("START THE DIGITAL TOUR", textX, boxTop + 16, {
        width: textW,
        characterSpacing: 1,
      });
    doc
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(10.5)
      .text(
        "Scan with your phone to check off each stop as you go. Works offline — taps sync when you're back on Wi-Fi.",
        textX,
        boxTop + 32,
        { width: textW },
      );
    if (input.walkUrl) {
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(8)
        .text(input.walkUrl, textX, boxTop + boxHeight - 18, {
          width: textW,
          lineBreak: false,
          ellipsis: true,
        });
    }
    doc.y = boxTop + boxHeight;
  }

  // ---- Checklist heading --------------------------------------------------
  const familyCount = input.stops.filter((s) => s.familyRequested).length;
  const highlightCount = input.stops.filter(
    (s) => s.schoolHighlight && !s.familyRequested,
  ).length;
  const countBits = [
    `${familyCount} family-requested`,
    highlightCount > 0 ? `${highlightCount} school highlight` : null,
  ].filter(Boolean) as string[];
  doc.moveDown(0.8);
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(INK)
    .text("Tour stops", left, doc.y, { continued: true });
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(MUTED)
    .text(`    ${countBits.join(" · ")}`);
  doc.moveDown(0.35);
  // Legend so the markers read at a glance.
  const legendY = doc.y;
  drawCheck(left + 4, legendY + 4, 4, accent);
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor(MUTED)
    .text("Family requested", left + 13, legendY, { continued: false });
  drawStar(left + 120, legendY + 4, 4.6, HIGHLIGHT);
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor(MUTED)
    .text("School added", left + 130, legendY);
  doc.moveDown(0.3);
  doc
    .moveTo(left, doc.y)
    .lineTo(left + width, doc.y)
    .strokeColor("#e5e7eb")
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.5);

  // ---- Stops (plain tick-boxes) -------------------------------------------
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
        "This family didn't select specific stops — walk the highlights and the spaces they mention.",
        left,
        doc.y,
        { width },
      );
  }

  const TAG_W = 96;
  input.stops.forEach((stop, i) => {
    const nameW = width - 24 - TAG_W;
    const nameText = `${i + 1}. ${stop.label}`;
    const nameH = doc
      .font("Helvetica-Bold")
      .fontSize(12.5)
      .heightOfString(nameText, { width: nameW });
    const rowH = Math.max(24, nameH + 10);
    ensureSpace(rowH);

    const y = doc.y;
    // Empty checkbox to tick by hand during the walk.
    doc
      .roundedRect(left, y + 1, 14, 14, 3)
      .lineWidth(1.2)
      .strokeColor(accent)
      .stroke();
    // Stop name only — no location/talking points/note lines.
    doc
      .font("Helvetica-Bold")
      .fontSize(12.5)
      .fillColor(INK)
      .text(nameText, left + 24, y + 1, { width: nameW });
    // Origin marker (right zone): ✓ family-requested, ★ school-added.
    const tagText = stop.familyRequested ? "REQUESTED" : "ADDED";
    const tagColor = stop.familyRequested ? accent : HIGHLIGHT;
    const markerX = left + width - TAG_W + 4;
    const markerCy = y + 7;
    if (stop.familyRequested) {
      drawCheck(markerX, markerCy, 4, tagColor);
    } else {
      drawStar(markerX, markerCy, 4.6, tagColor);
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(tagColor)
      .text(tagText, markerX + 10, y + 2.5, {
        width: TAG_W - 14,
        characterSpacing: 0.5,
      });
    doc.y = y + rowH;
    doc
      .moveTo(left + 24, doc.y - 6)
      .lineTo(left + width, doc.y - 6)
      .strokeColor("#eef2f7")
      .lineWidth(0.5)
      .stroke();
  });

  doc.end();
  return done;
}
