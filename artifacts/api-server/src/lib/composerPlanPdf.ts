// Class Composer "Master Plan" printable PDF.
//
// Layout:
//   Page 1 — cover: school + plan name, (subject, grade, SY), saved by,
//            created/finalized timestamps, and a one-row-per-group
//            recipe summary so the master scheduler can see at a glance
//            what's in the plan.
//   Pages 2..N — one section per group. Each page has:
//      - Top header strip:  plan name  |  "Group i of N"  |  "Page x of y"
//      - Group title + recipe summary
//      - Roster table: # | Local SIS ID | Student | Grade | FAST | %
//      - Footer:  plan publicId  |  QR (encodes "PULSE-COMPOSER:<publicId>")
//
// Headers/footers on every page so a stray page can be re-assembled.
// PDFKit emits pages sequentially; we tag each group page with its
// "Page x of y" using a post-pass that writes the total count once we
// know it (we know it up front — number of groups + cover = pages).

import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface ComposerPlanPdfStudent {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number | null;
  fastLevel: number | null;
  overallPct: number | null;
}

export interface ComposerPlanPdfGroup {
  groupIndex: number;
  name: string;
  recipeSummary: string;
  seatsPerSection: number;
  students: ComposerPlanPdfStudent[];
}

export interface ComposerPlanPdfInput {
  schoolName: string;
  planName: string;
  publicId: string;
  subject: string;
  grade: number;
  schoolYear: string;
  status: "draft" | "final";
  createdAt: Date;
  finalizedAt: Date | null;
  savedByName: string;
  groups: ComposerPlanPdfGroup[];
}

const PAGE_MARGIN = 50;
const HEADER_HEIGHT = 28;
const FOOTER_HEIGHT = 70;

function subjectLabel(s: string): string {
  switch (s) {
    case "ela":
      return "ELA";
    case "math":
      return "Math";
    case "algebra1":
      return "Algebra 1";
    case "geometry":
      return "Geometry";
    default:
      return s.toUpperCase();
  }
}

function fmtDate(d: Date): string {
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function renderComposerPlanPdf(
  input: ComposerPlanPdfInput,
): Promise<Buffer> {
  // Pre-render the QR (small, ~80px) once — same QR on every page.
  const qrPayload = `PULSE-COMPOSER:${input.publicId}`;
  const qrDataUrl = await QRCode.toDataURL(qrPayload, {
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
        Title: `${input.planName} — Class Composer Plan`,
        Author: "PulseEDU",
        Subject: `${subjectLabel(input.subject)} · Grade ${input.grade} · ${input.schoolYear}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const totalPages = 1 + input.groups.length;

    // ----- Page 1: cover -----
    doc.addPage();
    drawHeader(doc, input.planName, "Cover", 1, totalPages);
    drawFooter(doc, input.publicId, qrBuffer);

    const contentLeft = PAGE_MARGIN;
    const contentTop = PAGE_MARGIN + HEADER_HEIGHT + 10;
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#0f172a");
    doc.text(input.planName, contentLeft, contentTop, { width: 500 });
    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(12)
      .fillColor("#475569")
      .text(input.schoolName, { width: 500 });

    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
    doc.text("Plan details", { underline: false });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(11).fillColor("#334155");
    const detailLines = [
      `Subject: ${subjectLabel(input.subject)}`,
      `Grade: ${input.grade}`,
      `School year: ${input.schoolYear}`,
      `Status: ${input.status === "final" ? "Finalized" : "Draft"}`,
      `Saved by: ${input.savedByName}`,
      `Created: ${fmtDate(input.createdAt)}`,
      ...(input.finalizedAt ? [`Finalized: ${fmtDate(input.finalizedAt)}`] : []),
      `Plan ID: ${input.publicId}`,
      `Groups: ${input.groups.length}`,
      `Total students: ${input.groups.reduce((a, g) => a + g.students.length, 0)}`,
    ];
    for (const line of detailLines) doc.text(line);

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
    doc.text("Groups in this plan");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(11).fillColor("#334155");
    for (const g of input.groups) {
      const overCap = g.students.length > g.seatsPerSection;
      const capStr = `${g.students.length}/${g.seatsPerSection}${overCap ? " (over)" : ""}`;
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#0f172a")
        .text(`${g.groupIndex}. ${g.name}  `, { continued: true })
        .font("Helvetica")
        .fillColor(overCap ? "#b91c1c" : "#475569")
        .text(capStr + "  ", { continued: true })
        .fillColor("#64748b")
        .text(g.recipeSummary);
      doc.moveDown(0.2);
    }

    doc.moveDown(1);
    doc
      .font("Helvetica-Oblique")
      .fontSize(9)
      .fillColor("#94a3b8")
      .text(
        "Paper artifact only — does not modify Skyward/RosterOne. Each page is tagged with the Plan ID + QR below so shuffled pages can be re-assembled.",
        { width: 500 },
      );

    // ----- One page per group -----
    for (let i = 0; i < input.groups.length; i++) {
      const g = input.groups[i];
      doc.addPage();
      drawHeader(
        doc,
        input.planName,
        `Group ${g.groupIndex} of ${input.groups.length}`,
        i + 2,
        totalPages,
      );
      drawFooter(doc, input.publicId, qrBuffer);
      drawGroupBody(doc, g, {
        planName: input.planName,
        totalGroups: input.groups.length,
        publicId: input.publicId,
        qrBuffer,
      });
    }

    doc.end();
  });
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  planName: string,
  middle: string,
  pageNo: number,
  totalPages: number,
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
  doc.text(planName, left + 8, y + 9, { width: width / 3, ellipsis: true });
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
  doc.text(middle, left + width / 3, y + 9, {
    width: width / 3,
    align: "center",
  });
  doc.text(
    `Page ${pageNo} of ${totalPages}`,
    left + (2 * width) / 3,
    y + 9,
    { width: width / 3 - 8, align: "right" },
  );
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  publicId: string,
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
  // QR on the right, label on the left.
  const qrSize = 56;
  doc.image(qrBuffer, right - qrSize, top + 8, { width: qrSize, height: qrSize });
  doc.font("Helvetica").fontSize(9).fillColor("#64748b");
  doc.text("Plan ID", left, top + 14);
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a");
  doc.text(publicId, left, top + 26);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#94a3b8")
    .text("Scan QR or look up this ID in PulseEDU to find the source plan.", left, top + 48, {
      width: right - left - qrSize - 16,
    });
}

interface GroupPageCtx {
  planName: string;
  totalGroups: number;
  publicId: string;
  qrBuffer: Buffer;
}

function drawGroupBody(
  doc: PDFKit.PDFDocument,
  g: ComposerPlanPdfGroup,
  ctx: GroupPageCtx,
) {
  const left = PAGE_MARGIN;
  const top = PAGE_MARGIN + HEADER_HEIGHT + 10;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a");
  doc.text(g.name, left, top);
  doc.font("Helvetica").fontSize(10).fillColor("#64748b");
  doc.text(g.recipeSummary);
  const overCap = g.students.length > g.seatsPerSection;
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(overCap ? "#b91c1c" : "#475569")
    .text(
      `${g.students.length} student${g.students.length === 1 ? "" : "s"} · Seats: ${g.seatsPerSection}${overCap ? " (over capacity)" : ""}`,
    );

  doc.moveDown(0.7);

  const cols = [
    { w: 28, label: "#" },
    { w: 80, label: "Local SIS ID" },
    { w: 230, label: "Student" },
    { w: 40, label: "Grade" },
    { w: 50, label: "FAST" },
    { w: 50, label: "Score %" },
  ];
  const rowH = 18;
  let y = doc.y;
  // Header row
  doc.save().rect(left, y, sumCols(cols), rowH).fillColor("#e2e8f0").fill().restore();
  let x = left;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
  for (const c of cols) {
    doc.text(c.label, x + 6, y + 4, { width: c.w - 12 });
    x += c.w;
  }
  y += rowH;

  doc.font("Helvetica").fontSize(10).fillColor("#0f172a");
  const bottomLimit = doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT - 4;
  for (let i = 0; i < g.students.length; i++) {
    if (y + rowH > bottomLimit) {
      // Overflow students continue on a new page that re-renders the
      // top header strip (with "(cont.)" suffix) AND the QR + plan-ID
      // footer, so a shuffled continuation page still re-assembles via
      // QR scan. We can't update "Page x of y" upfront for continuation
      // pages — those are tagged "cont." in the header strip's middle
      // cell instead.
      doc.addPage();
      drawHeader(
        doc,
        ctx.planName,
        `Group ${g.groupIndex} of ${ctx.totalGroups} (cont.)`,
        // pageNo unknown for continuation; tagged "(cont.)" in middle
        // cell — QR + plan ID still let a shuffled page re-assemble.
        0,
        0,
      );
      drawFooter(doc, ctx.publicId, ctx.qrBuffer);
      drawHeaderContinuation(doc, g);
      y = doc.y;
    }
    const s = g.students[i];
    if (i % 2 === 1) {
      doc.save().rect(left, y, sumCols(cols), rowH).fillColor("#f8fafc").fill().restore();
    }
    x = left;
    const cells = [
      String(i + 1),
      s.localSisId ?? "—",
      `${s.lastName}, ${s.firstName}`,
      s.grade != null ? String(s.grade) : "—",
      s.fastLevel != null ? `L${s.fastLevel}` : "—",
      s.overallPct != null ? `${Math.round(s.overallPct)}%` : "—",
    ];
    doc.fillColor("#0f172a");
    for (let ci = 0; ci < cols.length; ci++) {
      doc.text(cells[ci], x + 6, y + 4, {
        width: cols[ci].w - 12,
        ellipsis: true,
      });
      x += cols[ci].w;
    }
    y += rowH;
  }
}

function sumCols(cols: { w: number }[]): number {
  return cols.reduce((a, c) => a + c.w, 0);
}

function drawHeaderContinuation(
  doc: PDFKit.PDFDocument,
  g: ComposerPlanPdfGroup,
) {
  const left = PAGE_MARGIN;
  const top = PAGE_MARGIN + HEADER_HEIGHT + 10;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a");
  doc.text(`${g.name} (continued)`, left, top);
  doc.moveDown(0.5);
}

