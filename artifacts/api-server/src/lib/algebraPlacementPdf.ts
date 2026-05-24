// Algebra I Placement Review — printable PDF.
//
// Built on the same PDFKit + QR pattern as `composerPlanPdf.ts` so the
// master scheduler gets a familiar layout (cover, per-page header,
// plan-ID + QR footer). The report differs from a Class Composer
// plan in that there's no per-group page split — placement is a flat
// list of 7th graders with their multi-year PM3 trajectory + the
// proposed/finalized placement decision.
//
// Layout:
//   Page 1 — cover: school + school year + generated timestamp + a
//            count of students in the cohort and how many have an
//            opt-out override saved.
//   Pages 2..N — the roster table, paginated. Each page repeats the
//            top header strip and the QR footer so a stray page can
//            still be re-assembled by scanning the QR (encodes the
//            report's deep-link URL).

import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface AlgebraPlacementPdfRow {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  // Most recent first. Each item is "{year} L{level}" e.g. "25-26 L3".
  trajectory: string[];
  // "Algebra I" or "Regular 8th Math (opt-out)".
  placement: string;
  // Free-form justification, truncated by the renderer if >120 chars.
  justification: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  // Current-year PM3 strand mastery percent (0..100) or null.
  nsoPct: number | null;
  arPct: number | null;
  // Current-year PM3 level (3, 4, or 5) — drives section grouping.
  currentLevel: 3 | 4 | 5;
}

export interface AlgebraPlacementPdfInput {
  schoolName: string;
  schoolYear: string;
  // Stable identifier for the report so the QR + footer match.
  // E.g. "ALG-PLACE-25-26".
  reportId: string;
  // Deep link to the live report page. QR encodes this verbatim so a
  // teacher scanning the printed page lands on the report.
  reportUrl: string;
  generatedAt: Date;
  overrideCount: number;
  levelCounts: { l5: number; l4: number; l3: number };
  // Pre-sorted: L5 → L4 → L3, AR-ascending within each level.
  rows: AlgebraPlacementPdfRow[];
}

const PAGE_MARGIN = 50;
const HEADER_HEIGHT = 28;
const FOOTER_HEIGHT = 70;

function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function renderAlgebraPlacementPdf(
  input: AlgebraPlacementPdfInput,
): Promise<Buffer> {
  // QR encodes the live report URL so a print-recipient can pull up
  // the latest data (override might have changed after the PDF was
  // printed).
  const qrDataUrl = await QRCode.toDataURL(input.reportUrl, {
    margin: 0,
    width: 160,
    errorCorrectionLevel: "M",
  });
  const qrBuffer = Buffer.from(
    qrDataUrl.replace(/^data:image\/png;base64,/, ""),
    "base64",
  );

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: {
        top: PAGE_MARGIN + HEADER_HEIGHT,
        bottom: PAGE_MARGIN + FOOTER_HEIGHT,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      autoFirstPage: false,
      info: {
        Title: `Algebra I Placement Review — ${input.schoolYear}`,
        Author: "PulseEDU",
        Subject: `${input.schoolName} · ${input.schoolYear}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const title = "Algebra I Placement Review";

    // ----- Page 1: cover -----
    doc.addPage();
    drawHeader(doc, title, "Cover");
    drawFooter(doc, input.reportId, qrBuffer);

    const contentLeft = PAGE_MARGIN;
    const contentTop = PAGE_MARGIN + HEADER_HEIGHT + 10;
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#0f172a");
    doc.text(title, contentLeft, contentTop, { width: 500 });
    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(12)
      .fillColor("#475569")
      .text(input.schoolName, { width: 500 });

    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
    doc.text("Report details");
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(11).fillColor("#334155");
    for (
      const line of [
        `School year: ${input.schoolYear}`,
        `Generated: ${fmtDate(input.generatedAt)}`,
        `Report ID: ${input.reportId}`,
        `Cohort size: ${input.rows.length} current 7th grader${input.rows.length === 1 ? "" : "s"} at FAST Math PM3 Level 3+`,
        `By level: L5 ${input.levelCounts.l5} · L4 ${input.levelCounts.l4} · L3 ${input.levelCounts.l3}`,
        `Overrides on file: ${input.overrideCount}`,
      ]
    ) doc.text(line);

    doc.moveDown(1);
    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor("#94a3b8")
      .text(
        "Paper artifact only — does not modify Skyward/RosterOne. Trajectory and override status reflect the moment this PDF was generated. Scan the QR to view the current live report.",
        { width: 500 },
      );

    // ----- Roster pages, split by current PM3 level -----
    // Same table layout as before, with NSO/AR columns inserted
    // between Trajectory and Placement. Each level (L5 → L4 → L3)
    // gets its own section header band so the master scheduler can
    // see counts at a glance and tear pages by level if needed.
    const cols = [
      { w: 26, label: "#" },
      { w: 62, label: "SIS ID" },
      { w: 130, label: "Student" },
      { w: 110, label: "Trajectory" },
      { w: 40, label: "NSO" },
      { w: 40, label: "AR" },
      { w: 104, label: "Placement" },
    ];
    const rowH = 22;
    const sectionBandH = 22;
    const bottomLimit = doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT - 4;

    doc.addPage();
    drawHeader(doc, title, `Roster`);
    drawFooter(doc, input.reportId, qrBuffer);
    let y = PAGE_MARGIN + HEADER_HEIGHT + 10;

    const levels: Array<3 | 4 | 5> = [5, 4, 3];
    for (const lvl of levels) {
      const sectionRows = input.rows.filter((r) => r.currentLevel === lvl);
      if (sectionRows.length === 0) continue;
      const countForLvl =
        lvl === 5
          ? input.levelCounts.l5
          : lvl === 4
            ? input.levelCounts.l4
            : input.levelCounts.l3;

      // Make sure the section band + table header + at least one row
      // can fit on the current page; otherwise start a new page so a
      // section doesn't get an orphan header.
      if (y + sectionBandH + rowH + rowH > bottomLimit) {
        doc.addPage();
        drawHeader(doc, title, `Roster (cont.)`);
        drawFooter(doc, input.reportId, qrBuffer);
        y = PAGE_MARGIN + HEADER_HEIGHT + 10;
      }
      y = drawSectionBand(doc, cols, y, sectionBandH, lvl, countForLvl);
      y = drawTableHeaderAt(doc, cols, y, rowH);

      for (let i = 0; i < sectionRows.length; i++) {
        if (y + rowH > bottomLimit) {
          doc.addPage();
          drawHeader(doc, title, `Roster (cont.)`);
          drawFooter(doc, input.reportId, qrBuffer);
          y = PAGE_MARGIN + HEADER_HEIGHT + 10;
          y = drawSectionBand(doc, cols, y, sectionBandH, lvl, countForLvl, true);
          y = drawTableHeaderAt(doc, cols, y, rowH);
        }
        const r = sectionRows[i];
        if (i % 2 === 1) {
          doc
            .save()
            .rect(PAGE_MARGIN, y, sumCols(cols), rowH)
            .fillColor("#f8fafc")
            .fill()
            .restore();
        }
        let x = PAGE_MARGIN;
        const cells = [
          String(i + 1),
          r.localSisId ?? "—",
          `${r.lastName}, ${r.firstName}`,
          r.trajectory.join(" ← "),
          r.nsoPct != null ? `${r.nsoPct}%` : "—",
          r.arPct != null ? `${r.arPct}%` : "—",
          r.placement,
        ];
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a");
        for (let ci = 0; ci < cols.length; ci++) {
          doc.text(cells[ci], x + 6, y + 5, {
            width: cols[ci].w - 12,
            ellipsis: true,
          });
          x += cols[ci].w;
        }
        y += rowH;
      }
      // Small gap between sections.
      y += 6;
    }

    doc.end();
  });
}

function drawSectionBand(
  doc: PDFKit.PDFDocument,
  cols: { w: number }[],
  y: number,
  h: number,
  level: 3 | 4 | 5,
  count: number,
  isContinuation = false,
): number {
  const bg = level === 5 ? "#dcfce7" : level === 4 ? "#e0f2fe" : "#fef3c7";
  const fg = level === 5 ? "#166534" : level === 4 ? "#075985" : "#92400e";
  doc.save().rect(PAGE_MARGIN, y, sumCols(cols), h).fillColor(bg).fill().restore();
  doc.font("Helvetica-Bold").fontSize(11).fillColor(fg);
  doc.text(
    `Level ${level} — ${count} student${count === 1 ? "" : "s"}${isContinuation ? " (cont.)" : ""}`,
    PAGE_MARGIN + 8,
    y + 5,
    { width: sumCols(cols) - 16 },
  );
  return y + h;
}

function drawTableHeaderAt(
  doc: PDFKit.PDFDocument,
  cols: { w: number; label: string }[],
  top: number,
  rowH: number,
): number {
  const left = PAGE_MARGIN;
  let x = left;
  doc.save().rect(left, top, sumCols(cols), rowH).fillColor("#e2e8f0").fill().restore();
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
  for (const c of cols) {
    doc.text(c.label, x + 6, top + 6, { width: c.w - 12 });
    x += c.w;
  }
  return top + rowH;
}

function sumCols(cols: { w: number }[]): number {
  return cols.reduce((a, c) => a + c.w, 0);
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  middle: string,
) {
  const y = PAGE_MARGIN;
  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  const width = right - left;
  doc
    .save()
    .rect(left, y, width, HEADER_HEIGHT)
    .fillColor("#f1f5f9")
    .fill()
    .restore();
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
  doc.text(title, left + 8, y + 9, { width: width / 2, ellipsis: true });
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
  doc.text(middle, left + width / 2, y + 9, {
    width: width / 2 - 8,
    align: "right",
  });
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  reportId: string,
  qrBuffer: Buffer,
) {
  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  const bottom = doc.page.height - PAGE_MARGIN;
  const top = bottom - FOOTER_HEIGHT;
  doc
    .save()
    .moveTo(left, top)
    .lineTo(right, top)
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .stroke()
    .restore();
  const qrSize = 56;
  doc.image(qrBuffer, right - qrSize, top + 8, { width: qrSize, height: qrSize });
  doc.font("Helvetica").fontSize(9).fillColor("#64748b");
  doc.text("Report ID", left, top + 14);
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a");
  doc.text(reportId, left, top + 26);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#94a3b8")
    .text(
      "Scan QR for the live report. Overrides reflect the moment this PDF was generated.",
      left,
      top + 48,
      { width: right - left - qrSize - 16 },
    );
}
