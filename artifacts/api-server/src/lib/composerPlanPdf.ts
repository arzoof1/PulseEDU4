// Class Composer "Master Plan" printable PDF.
//
// Layout:
//   Page 1 — cover (portrait): school + plan name, (subject, grade,
//            SY), saved by, created/finalized timestamps, and a
//            one-row-per-group recipe summary so the master scheduler
//            can see at a glance what's in the plan.
//   Pages 2..N — one section per group (landscape). Each page has:
//      - Top header strip:  plan name  |  "Group i of N"  |  "Page x of y"
//      - Group title + recipe summary
//      - Focus-standards bullet list (skill-cluster mode only)
//      - Group summary line: avg overall %, avg focus mastery,
//        ESE / 504 / ELL counts
//      - Roster table:  # | SIS ID | Student | Gr | FAST | % | Flags |
//                       Section / Teacher | Fit
//      - Focus-standards matrix (skill-cluster mode only): rows =
//        student #, cols = focus benchmark codes, cells = mastery %.
//        Cells are heat-tinted red < 50%, amber 50–69%, green ≥ 70%
//        so the teacher can sanity-check the recipe at a glance.
//      - Per-student weakest strands mini-table (one row per student
//        listing up to 3 weakest instructional strands + %).
//      - "Confirmed by ___ / Date ___" signature line + Plan ID + QR
//        footer.
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
  ese: boolean;
  is504: boolean;
  ell: boolean;
  // benchmarkCode → mastery % (0..100). Empty when the student has
  // no item responses for the source window — those rows render "—"
  // in the focus-standards matrix.
  benchmarkPctByCode: Record<string, number>;
  // Student's personal bottom-7 weakest benchmark codes (lowest pct
  // first). Used to compute fit-count against the group's focus
  // standards on the PDF; the percentage tells the teacher how many
  // of the recipe's focus standards land in that student's own list
  // of weakest skills.
  bottomBenchmarkCodes: string[];
  strands: Array<{ category: string; pct: number }>;
  currentSection: {
    courseName: string;
    period: number;
    teacherName: string | null;
  } | null;
}

export interface ComposerPlanPdfFocusStandard {
  benchmarkCode: string;
  friendlyLabel: string;
  groupAvgPct: number;
  sourceWindow?: string | null;
}

export interface ComposerPlanPdfGroup {
  groupIndex: number;
  name: string;
  recipeSummary: string;
  seatsPerSection: number;
  students: ComposerPlanPdfStudent[];
  focusStandards?: ComposerPlanPdfFocusStandard[] | null;
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

const PAGE_MARGIN = 40;
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

function programFlagsLabel(s: ComposerPlanPdfStudent): string {
  const f: string[] = [];
  if (s.ese) f.push("ESE");
  if (s.is504) f.push("504");
  if (s.ell) f.push("ELL");
  return f.join(" · ");
}

function heatFill(pct: number | null): string | null {
  if (pct == null) return null;
  if (pct < 50) return "#fee2e2";
  if (pct < 70) return "#fef3c7";
  return "#dcfce7";
}

// Shorten a benchmark code to its trailing identifier for matrix
// column headers — e.g. "ELA.6.R.1.1" → "R.1.1" — so the matrix
// header strip stays readable when there are 5+ focus standards.
function shortBenchmarkCode(code: string): string {
  const parts = code.split(".");
  if (parts.length <= 3) return code;
  return parts.slice(2).join(".");
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

    // ----- Page 1: cover (portrait) -----
    doc.addPage({ size: "LETTER", layout: "portrait" });
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

    // ----- One landscape page per group -----
    for (let i = 0; i < input.groups.length; i++) {
      const g = input.groups[i];
      doc.addPage({ size: "LETTER", layout: "landscape" });
      drawHeader(
        doc,
        input.planName,
        `Group ${g.groupIndex} of ${input.groups.length}`,
        i + 2,
        totalPages,
      );
      drawFooter(doc, input.publicId, qrBuffer, true);
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
  if (pageNo > 0) {
    doc.text(
      `Page ${pageNo} of ${totalPages}`,
      left + (2 * width) / 3,
      y + 9,
      { width: width / 3 - 8, align: "right" },
    );
  }
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  publicId: string,
  qrBuffer: Buffer,
  showSignature: boolean = false,
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
  // Signature block on the left, Plan ID + QR on the right.
  const qrSize = 56;
  doc.image(qrBuffer, right - qrSize, top + 8, { width: qrSize, height: qrSize });
  doc.font("Helvetica").fontSize(9).fillColor("#64748b");
  doc.text("Plan ID", right - qrSize - 110, top + 14, { width: 90, align: "right" });
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
  doc.text(publicId, right - qrSize - 110, top + 26, {
    width: 90,
    align: "right",
  });
  // "Confirmed by" / "Date" signature lines — Florida districts want
  // a paper trail showing who reviewed the benchmark-based grouping
  // before it went to the master scheduler. Only printed on the first
  // page of each group; cover and continuation pages skip it so the
  // reviewer isn't asked to sign 7+ lines for a 6-group plan.
  if (showSignature) {
    doc.font("Helvetica").fontSize(9).fillColor("#64748b");
    doc.text("Confirmed by:", left, top + 14);
    doc
      .save()
      .moveTo(left + 70, top + 24)
      .lineTo(left + 270, top + 24)
      .lineWidth(0.5)
      .strokeColor("#475569")
      .stroke()
      .restore();
    doc.text("Date:", left, top + 38);
    doc
      .save()
      .moveTo(left + 70, top + 48)
      .lineTo(left + 200, top + 48)
      .lineWidth(0.5)
      .strokeColor("#475569")
      .stroke()
      .restore();
  }
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#94a3b8")
    .text(
      "Scan QR or look up the Plan ID in PulseEDU to find the source plan.",
      left,
      top + 58,
      { width: right - left - qrSize - 130 },
    );
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
  const right = doc.page.width - PAGE_MARGIN;
  const width = right - left;
  const top = PAGE_MARGIN + HEADER_HEIGHT + 8;

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f172a");
  doc.text(g.name, left, top);
  doc.font("Helvetica").fontSize(9).fillColor("#64748b");
  doc.text(g.recipeSummary);

  // Group summary — averages + program-flag counts so the reviewer
  // sees the shape of the group before scanning the roster.
  const eseCt = g.students.filter((s) => s.ese).length;
  const fiveOhFourCt = g.students.filter((s) => s.is504).length;
  const ellCt = g.students.filter((s) => s.ell).length;
  const scored = g.students.filter((s) => s.overallPct != null);
  const avgOverall =
    scored.length === 0
      ? null
      : Math.round(
          scored.reduce((a, s) => a + (s.overallPct ?? 0), 0) / scored.length,
        );
  const focusCodes = (g.focusStandards ?? []).map((f) => f.benchmarkCode);
  let avgFocus: number | null = null;
  if (focusCodes.length > 0) {
    const focusPcts: number[] = [];
    for (const s of g.students) {
      for (const code of focusCodes) {
        const p = s.benchmarkPctByCode[code];
        if (typeof p === "number") focusPcts.push(p);
      }
    }
    avgFocus =
      focusPcts.length === 0
        ? null
        : Math.round(focusPcts.reduce((a, b) => a + b, 0) / focusPcts.length);
  }
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(9).fillColor("#334155");
  const summaryParts: string[] = [
    `${g.students.length} student${g.students.length === 1 ? "" : "s"}`,
    `Seats ${g.seatsPerSection}${g.students.length > g.seatsPerSection ? " (OVER)" : ""}`,
  ];
  if (avgOverall != null) summaryParts.push(`Avg overall ${avgOverall}%`);
  if (avgFocus != null) summaryParts.push(`Avg focus ${avgFocus}%`);
  summaryParts.push(`ESE ${eseCt}`);
  summaryParts.push(`504 ${fiveOhFourCt}`);
  summaryParts.push(`ELL ${ellCt}`);
  doc.text(summaryParts.join("  ·  "));

  if (g.focusStandards && g.focusStandards.length > 0) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
    doc.text("Focus standards:");
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    for (const f of g.focusStandards) {
      doc.text(
        `  • ${f.benchmarkCode} — ${f.friendlyLabel.replace(`${f.benchmarkCode} · `, "")} (grp avg ${f.groupAvgPct}%${f.sourceWindow ? `, ${f.sourceWindow.toUpperCase()}` : ""})`,
        { width: width },
      );
    }
  }

  doc.moveDown(0.6);

  // ----- Roster table -----
  // Widths sum ≤ landscape-letter content width (792 - 80 = 712).
  const rosterCols: Array<{ w: number; label: string }> = [
    { w: 24, label: "#" },
    { w: 70, label: "SIS ID" },
    { w: 150, label: "Student" },
    { w: 28, label: "Gr" },
    { w: 38, label: "FAST" },
    { w: 38, label: "%" },
    { w: 50, label: "Flags" },
    { w: 260, label: "Section / Teacher" },
    { w: 50, label: "Focus fit" },
  ];
  const rowH = 18;
  let y = doc.y;
  drawRow(doc, left, y, rowH, rosterCols, "header");
  let x = left;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
  for (const c of rosterCols) {
    doc.text(c.label, x + 4, y + 5, { width: c.w - 8, ellipsis: true });
    x += c.w;
  }
  y += rowH;

  doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
  const bottomLimit = doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT - 6;
  for (let i = 0; i < g.students.length; i++) {
    if (y + rowH > bottomLimit) {
      doc.addPage({ size: "LETTER", layout: "landscape" });
      drawHeader(
        doc,
        ctx.planName,
        `Group ${g.groupIndex} of ${ctx.totalGroups} (cont.)`,
        0,
        0,
      );
      drawFooter(doc, ctx.publicId, ctx.qrBuffer);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a");
      doc.text(`${g.name} (continued)`, left, top);
      doc.moveDown(0.4);
      y = doc.y;
      drawRow(doc, left, y, rowH, rosterCols, "header");
      x = left;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      for (const c of rosterCols) {
        doc.text(c.label, x + 4, y + 5, { width: c.w - 8, ellipsis: true });
        x += c.w;
      }
      y += rowH;
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
    }
    const s = g.students[i];
    if (i % 2 === 1) drawRow(doc, left, y, rowH, rosterCols, "alt");

    // Fit count: how many of the group's focus standards land in
    // this student's personal bottom-7 weakest benchmarks. Gives
    // the teacher a per-student "this kid belongs here" indicator.
    let fitText = "—";
    if (focusCodes.length > 0) {
      const bottomSet = new Set(s.bottomBenchmarkCodes);
      const hit = focusCodes.filter((c) => bottomSet.has(c)).length;
      fitText = `${hit}/${focusCodes.length}`;
    }

    const section = s.currentSection;
    const sectionText = section
      ? `P${section.period} · ${section.courseName}${section.teacherName ? " — " + section.teacherName : ""}`
      : "—";

    x = left;
    const cells = [
      String(i + 1),
      s.localSisId ?? "—",
      `${s.lastName}, ${s.firstName}`,
      s.grade != null ? String(s.grade) : "—",
      s.fastLevel != null ? `L${s.fastLevel}` : "—",
      s.overallPct != null ? `${Math.round(s.overallPct)}%` : "—",
      programFlagsLabel(s) || "—",
      sectionText,
      fitText,
    ];
    doc.fillColor("#0f172a");
    for (let ci = 0; ci < rosterCols.length; ci++) {
      doc.text(cells[ci], x + 4, y + 5, {
        width: rosterCols[ci].w - 8,
        ellipsis: true, lineBreak: false,
      });
      x += rosterCols[ci].w;
    }
    y += rowH;
  }

  // ----- Focus-standards matrix (skill-cluster mode only) -----
  if (g.focusStandards && g.focusStandards.length > 0) {
    if (y + 80 > bottomLimit) {
      doc.addPage({ size: "LETTER", layout: "landscape" });
      drawHeader(
        doc,
        ctx.planName,
        `Group ${g.groupIndex} of ${ctx.totalGroups} (cont.)`,
        0,
        0,
      );
      drawFooter(doc, ctx.publicId, ctx.qrBuffer);
      y = PAGE_MARGIN + HEADER_HEIGHT + 8;
    } else {
      y += 12;
    }
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
    doc.text("Per-student mastery on focus standards", left, y);
    y += 14;
    const matrixNameW = 170;
    const matrixCodeW = Math.min(
      80,
      Math.floor((width - matrixNameW - 50) / g.focusStandards.length),
    );
    const matrixFitW = 50;
    const matrixCols: Array<{ w: number; label: string }> = [
      { w: 24, label: "#" },
      { w: matrixNameW, label: "Student" },
      ...g.focusStandards.map((f) => ({
        w: matrixCodeW,
        label: shortBenchmarkCode(f.benchmarkCode),
      })),
      { w: matrixFitW, label: "Fit" },
    ];
    drawRow(doc, left, y, rowH, matrixCols, "header");
    x = left;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
    for (const c of matrixCols) {
      doc.text(c.label, x + 4, y + 5, { width: c.w - 8, ellipsis: true });
      x += c.w;
    }
    y += rowH;
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
    for (let i = 0; i < g.students.length; i++) {
      if (y + rowH > bottomLimit) {
        doc.addPage({ size: "LETTER", layout: "landscape" });
        drawHeader(
          doc,
          ctx.planName,
          `Group ${g.groupIndex} of ${ctx.totalGroups} (cont.)`,
          0,
          0,
        );
        drawFooter(doc, ctx.publicId, ctx.qrBuffer);
        y = PAGE_MARGIN + HEADER_HEIGHT + 8;
        drawRow(doc, left, y, rowH, matrixCols, "header");
        x = left;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
        for (const c of matrixCols) {
          doc.text(c.label, x + 4, y + 5, { width: c.w - 8, ellipsis: true });
          x += c.w;
        }
        y += rowH;
        doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
      }
      const s = g.students[i];
      if (i % 2 === 1) drawRow(doc, left, y, rowH, matrixCols, "alt");
      x = left;
      doc.fillColor("#0f172a");
      doc.text(String(i + 1), x + 4, y + 5, { width: 24 - 8 });
      x += 24;
      doc.text(`${s.lastName}, ${s.firstName}`, x + 4, y + 5, {
        width: matrixNameW - 8,
        ellipsis: true, lineBreak: false,
      });
      x += matrixNameW;
      const bottomSet = new Set(s.bottomBenchmarkCodes);
      let fit = 0;
      for (const f of g.focusStandards) {
        const pct = s.benchmarkPctByCode[f.benchmarkCode];
        const cell = typeof pct === "number" ? `${Math.round(pct)}%` : "—";
        const fill = typeof pct === "number" ? heatFill(pct) : null;
        if (fill) {
          doc
            .save()
            .rect(x, y, matrixCodeW, rowH)
            .fillColor(fill)
            .fill()
            .restore();
        }
        if (bottomSet.has(f.benchmarkCode)) fit++;
        doc.fillColor("#0f172a");
        doc.text(cell, x + 4, y + 5, {
          width: matrixCodeW - 8,
          align: "center",
        });
        x += matrixCodeW;
      }
      doc.text(`${fit}/${g.focusStandards.length}`, x + 4, y + 5, {
        width: matrixFitW - 8,
        align: "center",
      });
      y += rowH;
    }
  }

  // ----- Per-student weakest strands mini-table -----
  // Suppress when every student has at most one strand — in that case
  // the column just restates the overall % already shown in the roster
  // (typical for Cusp plans grouped on a single instructional category).
  const maxStrandsAcrossGroup = g.students.reduce(
    (m, s) => Math.max(m, s.strands.length),
    0,
  );
  if (
    maxStrandsAcrossGroup >= 2 &&
    g.students.some((s) => s.strands.length > 0)
  ) {
    if (y + 60 > bottomLimit) {
      doc.addPage({ size: "LETTER", layout: "landscape" });
      drawHeader(
        doc,
        ctx.planName,
        `Group ${g.groupIndex} of ${ctx.totalGroups} (cont.)`,
        0,
        0,
      );
      drawFooter(doc, ctx.publicId, ctx.qrBuffer);
      y = PAGE_MARGIN + HEADER_HEIGHT + 8;
    } else {
      y += 12;
    }
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
    // Title says "up to 3" because Cusp plans grouped on a single
    // strand will only surface that one strand per student — saying
    // "Top 3" there would be misleading.
    const maxStrands = g.students.reduce(
      (m, s) => Math.max(m, s.strands.length),
      0,
    );
    doc.text("Weakest FAST strands per student", left, y);
    y += 14;
    const strandCols: Array<{ w: number; label: string }> = [
      { w: 24, label: "#" },
      { w: 170, label: "Student" },
      {
        w: width - 24 - 170,
        label:
          maxStrands <= 1
            ? "Weakest strand (avg %)"
            : `Up to ${Math.min(3, maxStrands)} weakest strands (avg %)`,
      },
    ];
    drawRow(doc, left, y, rowH, strandCols, "header");
    x = left;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
    for (const c of strandCols) {
      doc.text(c.label, x + 4, y + 5, { width: c.w - 8 });
      x += c.w;
    }
    y += rowH;
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
    for (let i = 0; i < g.students.length; i++) {
      if (y + rowH > bottomLimit) {
        doc.addPage({ size: "LETTER", layout: "landscape" });
        drawHeader(
          doc,
          ctx.planName,
          `Group ${g.groupIndex} of ${ctx.totalGroups} (cont.)`,
          0,
          0,
        );
        drawFooter(doc, ctx.publicId, ctx.qrBuffer);
        y = PAGE_MARGIN + HEADER_HEIGHT + 8;
        drawRow(doc, left, y, rowH, strandCols, "header");
        x = left;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
        for (const c of strandCols) {
          doc.text(c.label, x + 4, y + 5, { width: c.w - 8 });
          x += c.w;
        }
        y += rowH;
        doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
      }
      const s = g.students[i];
      if (i % 2 === 1) drawRow(doc, left, y, rowH, strandCols, "alt");
      x = left;
      doc.fillColor("#0f172a");
      doc.text(String(i + 1), x + 4, y + 5, { width: 24 - 8 });
      x += 24;
      doc.text(`${s.lastName}, ${s.firstName}`, x + 4, y + 5, {
        width: 170 - 8,
        ellipsis: true, lineBreak: false,
      });
      x += 170;
      const strandText =
        s.strands.length === 0
          ? "— (no FAST item data)"
          : s.strands.map((c) => `${c.category} ${c.pct}%`).join("  ·  ");
      doc.text(strandText, x + 4, y + 5, {
        width: strandCols[2].w - 8,
        ellipsis: true, lineBreak: false,
      });
      y += rowH;
    }
  }
}

function drawRow(
  doc: PDFKit.PDFDocument,
  left: number,
  y: number,
  rowH: number,
  cols: Array<{ w: number }>,
  kind: "header" | "alt",
) {
  const w = cols.reduce((a, c) => a + c.w, 0);
  doc
    .save()
    .rect(left, y, w, rowH)
    .fillColor(kind === "header" ? "#e2e8f0" : "#f8fafc")
    .fill()
    .restore();
}
