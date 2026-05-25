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
  // PM1/PM2/PM3 FAST achievement levels (1..5 | null) — surfaced as
  // a trajectory chip in the roster table so the teacher can see
  // movement at a glance without paging into the student profile.
  pmLevels?: {
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
  };
  // Cross-module context flags. All optional so older callers that
  // don't supply them still render the same roster.
  hasActiveMtss?: boolean;
  hasActiveSafetyPlan?: boolean;
  everRetained?: boolean;
  disciplineDays30?: number;
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
  // Group-level "what does this whole class most need to work on?"
  // — the 5 lowest-average benchmarks across the roster (each
  // surfaced only when at least half the group has responses).
  weakestBenchmarks?: Array<{
    benchmarkCode: string;
    avgPct: number;
    coveragePct: number;
  }>;
  // Within-class small-group suggestions. Only populated by the
  // route layer when the group has ≥8 students with FAST profiles.
  subPods?: Array<{
    podIndex: number;
    dominantCategory: string | null;
    memberNames: string[];
  }>;
  // Quick cross-module context counts — printed under the group
  // summary so the teacher knows what they're walking into.
  context?: {
    activeMtss: number;
    activeSafetyPlan: number;
    everRetained: number;
    disciplineEvents30: number;
  };
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
      bufferPages: true,
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

    // ----- Page 1: cover (portrait) -----
    doc.addPage({ size: "LETTER", layout: "portrait" });
    drawHeader(doc, input.planName, "Cover", 0, 0);
    drawFooter(doc, input.publicId, qrBuffer);

    drawCoverBody(doc, input);

    // ----- One landscape page per group -----
    for (let i = 0; i < input.groups.length; i++) {
      const g = input.groups[i];
      doc.addPage({ size: "LETTER", layout: "landscape" });
      drawHeader(
        doc,
        input.planName,
        `Group ${g.groupIndex} of ${input.groups.length}`,
        0,
        0,
      );
      drawFooter(doc, input.publicId, qrBuffer, true);
      drawGroupBody(doc, g, {
        planName: input.planName,
        totalGroups: input.groups.length,
        publicId: input.publicId,
        qrBuffer,
        isLastGroup: i === input.groups.length - 1,
      });
    }

    // Stamp page numbers (X / Y) once we know the final count. We do
    // this in a post-pass because continuation pages from oversized
    // groups inflate the count past `1 + groups.length`. The header
    // band already painted on each page leaves room for the stamp.
    const range = doc.bufferedPageRange();
    const total = range.count;
    for (let p = 0; p < total; p++) {
      doc.switchToPage(range.start + p);
      const right = doc.page.width - PAGE_MARGIN;
      const widthBand = right - PAGE_MARGIN;
      doc.font("Helvetica").fontSize(10).fillColor("#334155");
      doc.text(
        `Page ${p + 1} of ${total}`,
        PAGE_MARGIN + (2 * widthBand) / 3,
        PAGE_MARGIN + 9,
        { width: widthBand / 3 - 8, align: "right", lineBreak: false },
      );
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

function drawCoverBody(
  doc: PDFKit.PDFDocument,
  input: ComposerPlanPdfInput,
) {
  const contentLeft = PAGE_MARGIN;
  const contentRight = doc.page.width - PAGE_MARGIN;
  const contentTop = PAGE_MARGIN + HEADER_HEIGHT + 10;
  const colW = (contentRight - contentLeft - 16) / 2;

  // Title block
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#0f172a");
  doc.text(input.planName, contentLeft, contentTop, { width: contentRight - contentLeft });
  doc.moveDown(0.2);
  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor("#475569")
    .text(input.schoolName, { width: contentRight - contentLeft });

  // Roll up plan-wide aggregates.
  const allStudents = input.groups.flatMap((g) => g.students);
  const totalStudents = allStudents.length;
  const eseTotal = allStudents.filter((s) => s.ese).length;
  const fiveOhFourTotal = allStudents.filter((s) => s.is504).length;
  const ellTotal = allStudents.filter((s) => s.ell).length;
  const mtssTotal = allStudents.filter((s) => s.hasActiveMtss).length;
  const safetyTotal = allStudents.filter((s) => s.hasActiveSafetyPlan).length;
  const retainedTotal = allStudents.filter((s) => s.everRetained).length;
  const disciplineTotal = allStudents.reduce(
    (a, s) => a + (s.disciplineDays30 ?? 0),
    0,
  );
  const scored = allStudents.filter((s) => s.overallPct != null);
  const planAvg =
    scored.length === 0
      ? null
      : Math.round(
          scored.reduce((a, s) => a + (s.overallPct ?? 0), 0) / scored.length,
        );

  // ----- Two-column band: details (left) | snapshot (right) -----
  const bandTop = doc.y + 14;
  // Left: Plan details
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
  doc.text("Plan details", contentLeft, bandTop);
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
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
    `Total students: ${totalStudents}`,
  ];
  let dy = bandTop + 16;
  for (const line of detailLines) {
    doc.text(line, contentLeft, dy, { width: colW });
    dy += 13;
  }

  // Right: Roster snapshot
  const rightX = contentLeft + colW + 16;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
  doc.text("Roster snapshot", rightX, bandTop);
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
  let ry = bandTop + 16;
  const snapshotLines: Array<[string, string, string?]> = [
    ["Avg overall %", planAvg != null ? `${planAvg}%` : "—"],
    ["ESE", String(eseTotal)],
    ["504", String(fiveOhFourTotal)],
    ["ELL", String(ellTotal)],
    ["Active MTSS plans", String(mtssTotal)],
    ["Active safety plans", String(safetyTotal)],
    ["Ever retained", String(retainedTotal)],
    ["ISS+OSS days (last 30)", String(disciplineTotal)],
  ];
  for (const [label, value] of snapshotLines) {
    doc.fillColor("#475569").text(label, rightX, ry, { width: colW * 0.6, lineBreak: false });
    doc
      .fillColor("#0f172a")
      .font("Helvetica-Bold")
      .text(value, rightX + colW * 0.6, ry, {
        width: colW * 0.4,
        align: "right",
        lineBreak: false,
      });
    doc.font("Helvetica");
    ry += 13;
  }

  // ----- Plan-wide top weakest benchmarks (aggregated across groups) -----
  // Aggregate from per-group weakestBenchmarks (already coverage-floor-
  // gated). Weight each benchmark's avg by its group's student count so
  // a 30-kid group's deficit isn't equal-weighted with a 6-kid pod.
  const weightedByCode = new Map<
    string,
    { weightedSum: number; weight: number }
  >();
  for (const g of input.groups) {
    const w = g.students.length;
    for (const wb of g.weakestBenchmarks ?? []) {
      const cur = weightedByCode.get(wb.benchmarkCode) ?? {
        weightedSum: 0,
        weight: 0,
      };
      cur.weightedSum += wb.avgPct * w;
      cur.weight += w;
      weightedByCode.set(wb.benchmarkCode, cur);
    }
  }
  const topWeakest = Array.from(weightedByCode.entries())
    .map(([code, v]) => ({ code, avg: Math.round(v.weightedSum / v.weight) }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 7);

  // Place after whichever column ended lower.
  const bandBottom = Math.max(dy, ry) + 14;
  let curY = bandBottom;
  if (topWeakest.length > 0) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
    doc.text("Most-deficit benchmarks plan-wide (weighted)", contentLeft, curY);
    curY += 16;
    doc.font("Helvetica").fontSize(10).fillColor("#334155");
    const wbColW = (contentRight - contentLeft) / Math.min(topWeakest.length, 7);
    for (let i = 0; i < topWeakest.length; i++) {
      const w = topWeakest[i];
      const x = contentLeft + i * wbColW;
      const fill = heatFill(w.avg);
      if (fill) {
        doc
          .save()
          .rect(x, curY, wbColW - 4, 32)
          .fillColor(fill)
          .fill()
          .restore();
      }
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#0f172a")
        .text(w.code, x + 4, curY + 5, { width: wbColW - 12, lineBreak: false });
      doc
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#0f172a")
        .text(`${w.avg}%`, x + 4, curY + 17, {
          width: wbColW - 12,
          lineBreak: false,
        });
    }
    curY += 42;
  }

  // ----- Group list (compact: 2 columns) -----
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
  doc.text("Groups in this plan", contentLeft, curY);
  curY += 16;
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
  const groupRowH = 26;
  const groupColW = (contentRight - contentLeft - 12) / 2;
  for (let i = 0; i < input.groups.length; i++) {
    const g = input.groups[i];
    const col = i % 2;
    const row = Math.floor(i / 2);
    const gx = contentLeft + col * (groupColW + 12);
    const gy = curY + row * groupRowH;
    const overCap = g.students.length > g.seatsPerSection;
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#0f172a")
      .text(`${g.groupIndex}. ${g.name}`, gx, gy, {
        width: groupColW,
        lineBreak: false,
        ellipsis: true,
      });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(overCap ? "#b91c1c" : "#64748b")
      .text(
        `${g.students.length}/${g.seatsPerSection}${overCap ? " OVER" : ""}  ·  ${g.recipeSummary}`,
        gx,
        gy + 12,
        { width: groupColW, lineBreak: false, ellipsis: true },
      );
  }
  curY += Math.ceil(input.groups.length / 2) * groupRowH + 12;

  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor("#94a3b8")
    .text(
      "Paper artifact only — does not modify Skyward/RosterOne. Each page is tagged with the Plan ID + QR below so shuffled pages can be re-assembled.",
      contentLeft,
      curY,
      { width: contentRight - contentLeft },
    );
}

interface GroupPageCtx {
  planName: string;
  totalGroups: number;
  publicId: string;
  qrBuffer: Buffer;
  isLastGroup: boolean;
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

  // Compact title — group name + recipe on the same line so the
  // title block stays under ~32pt, leaving more vertical room for
  // the roster and aggregate blocks.
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a");
  doc.text(g.name, left, top, { continued: true });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#64748b")
    .text(`   ${g.recipeSummary}`);

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
  // Single-line summary: counts + context merged, ·-separated, so we
  // don't burn two lines on what's effectively a header strip.
  doc.font("Helvetica").fontSize(9).fillColor("#334155");
  const summaryParts: string[] = [
    `${g.students.length} student${g.students.length === 1 ? "" : "s"}`,
    `Seats ${g.seatsPerSection}${g.students.length > g.seatsPerSection ? " (OVER)" : ""}`,
  ];
  if (avgOverall != null) summaryParts.push(`Avg ${avgOverall}%`);
  if (avgFocus != null) summaryParts.push(`Focus ${avgFocus}%`);
  if (eseCt > 0) summaryParts.push(`ESE ${eseCt}`);
  if (fiveOhFourCt > 0) summaryParts.push(`504 ${fiveOhFourCt}`);
  if (ellCt > 0) summaryParts.push(`ELL ${ellCt}`);
  if (g.context) {
    if (g.context.activeMtss > 0)
      summaryParts.push(`MTSS ${g.context.activeMtss}`);
    if (g.context.activeSafetyPlan > 0)
      summaryParts.push(`Safety ${g.context.activeSafetyPlan}`);
    if (g.context.everRetained > 0)
      summaryParts.push(`Retained ${g.context.everRetained}`);
    if (g.context.disciplineEvents30 > 0)
      summaryParts.push(`Disc-30d ${g.context.disciplineEvents30}`);
  }
  doc.text(summaryParts.join("  ·  "), { width });

  if (g.focusStandards && g.focusStandards.length > 0) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
    doc.text("Focus standards:", { continued: false });
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    // Render focus standards compactly: one per line is fine, but
    // strip the redundant code prefix from the friendly label.
    for (const f of g.focusStandards) {
      doc.text(
        `  • ${f.benchmarkCode} — ${f.friendlyLabel.replace(`${f.benchmarkCode} · `, "")} (avg ${f.groupAvgPct}%${f.sourceWindow ? `, ${f.sourceWindow.toUpperCase()}` : ""})`,
        { width },
      );
    }
  }

  doc.moveDown(0.3);

  // ----- Roster table -----
  // Widths sum ≤ landscape-letter content width (792 - 80 = 712).
  // PM trajectory col is always present (renders "—" when there's
  // no score). Focus-fit col is dropped when the plan isn't a
  // skill-cluster plan — that column is meaningless without focus
  // standards, and shedding it gives Section / Teacher room to
  // breathe on Cusp plans (where most rows wrap otherwise).
  const hasFocus = !!(g.focusStandards && g.focusStandards.length > 0);
  // Common cols: 24+70+150+28+38+38+50+72 = 470. Remaining 242pt for
  // Section (and optional Focus-fit).
  const rosterCols: Array<{ w: number; label: string }> = [
    { w: 24, label: "#" },
    { w: 70, label: "SIS ID" },
    { w: 150, label: "Student" },
    { w: 28, label: "Gr" },
    { w: 38, label: "FAST" },
    { w: 38, label: "%" },
    { w: 50, label: "Flags" },
    { w: 72, label: "PM1/2/3" },
    { w: hasFocus ? 192 : 242, label: "Section / Teacher" },
    ...(hasFocus ? [{ w: 50, label: "Focus fit" }] : []),
  ];
  const rowH = 16;
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

    // PM trajectory chip: "L#/L#/L# ▲" (or ▼ / – / no glyph if only
    // one window has data). Glyph compares the latest two windows
    // that both have a score — purely directional, no magnitude.
    const pm = s.pmLevels;
    const pmCell = (() => {
      if (!pm) return "—";
      const fmt = (v: number | null) => (v == null ? "—" : `L${v}`);
      const parts = [fmt(pm.pm1), fmt(pm.pm2), fmt(pm.pm3)].join("/");
      // Pick the most-recent two non-null levels for the glyph.
      const seq: number[] = [];
      if (pm.pm1 != null) seq.push(pm.pm1);
      if (pm.pm2 != null) seq.push(pm.pm2);
      if (pm.pm3 != null) seq.push(pm.pm3);
      if (seq.length < 2) return parts;
      const last = seq[seq.length - 1];
      const prev = seq[seq.length - 2];
      const glyph = last > prev ? "▲" : last < prev ? "▼" : "–";
      return `${parts} ${glyph}`;
    })();

    x = left;
    const cells = [
      String(i + 1),
      s.localSisId ?? "—",
      `${s.lastName}, ${s.firstName}`,
      s.grade != null ? String(s.grade) : "—",
      s.fastLevel != null ? `L${s.fastLevel}` : "—",
      s.overallPct != null ? `${Math.round(s.overallPct)}%` : "—",
      programFlagsLabel(s) || "—",
      pmCell,
      sectionText,
      ...(hasFocus ? [fitText] : []),
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

  // ----- Aggregate band: weakest benchmarks (left) + sub-pods (right) -----
  // Two-column layout so both blocks consume one vertical band instead
  // of two — major density win. Each column is independent so the band
  // height = max(left height, right height). Renders only when there's
  // at least one block to show.
  const wbList = g.weakestBenchmarks ?? [];
  const podList = g.subPods ?? [];
  if (wbList.length > 0 || podList.length > 0) {
    const wbBlockH = wbList.length > 0 ? 18 + (wbList.length + 1) * rowH : 0;
    const podBlockH =
      podList.length > 0
        ? 28 +
          podList.reduce(
            (m, p) => Math.max(m, 14 + Math.ceil(p.memberNames.length / 3) * 11),
            0,
          )
        : 0;
    const bandH = Math.max(wbBlockH, podBlockH);
    if (y + bandH + 10 > bottomLimit) {
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
      y += 8;
    }
    const bandY = y;
    const colGap = 12;
    // When both blocks present split 50/50; when only one, give it
    // full width to stay readable.
    const haveBoth = wbList.length > 0 && podList.length > 0;
    const leftColW = haveBoth ? (width - colGap) / 2 : width;
    const rightColW = haveBoth ? (width - colGap) / 2 : 0;
    const rightX = left + leftColW + colGap;

    // ----- Left: Weakest benchmarks (A) -----
    if (wbList.length > 0) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
      doc.text(
        `Group's ${wbList.length} weakest benchmarks (whole-class focus)`,
        left,
        bandY,
        { width: leftColW },
      );
      let wy = bandY + 14;
      // Compact columns: #, benchmark, avg %, coverage.
      const codeW = leftColW - 24 - 60 - 90;
      const wbCols: Array<{ w: number; label: string }> = [
        { w: 24, label: "#" },
        { w: codeW, label: "Benchmark" },
        { w: 60, label: "Avg" },
        { w: 90, label: "Coverage" },
      ];
      drawRow(doc, left, wy, rowH, wbCols, "header");
      let wx = left;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      for (const c of wbCols) {
        doc.text(c.label, wx + 4, wy + 4, { width: c.w - 8, lineBreak: false });
        wx += c.w;
      }
      wy += rowH;
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
      for (let i = 0; i < wbList.length; i++) {
        const wb = wbList[i];
        if (i % 2 === 1) drawRow(doc, left, wy, rowH, wbCols, "alt");
        const fill = heatFill(wb.avgPct);
        if (fill) {
          doc
            .save()
            .rect(left + 24 + codeW, wy, 60, rowH)
            .fillColor(fill)
            .fill()
            .restore();
        }
        wx = left;
        doc.fillColor("#0f172a");
        doc.text(String(i + 1), wx + 4, wy + 4, { width: 16, lineBreak: false });
        wx += 24;
        doc.text(wb.benchmarkCode, wx + 4, wy + 4, {
          width: codeW - 8,
          ellipsis: true,
          lineBreak: false,
        });
        wx += codeW;
        doc.text(`${wb.avgPct}%`, wx + 4, wy + 4, {
          width: 60 - 8,
          align: "center",
          lineBreak: false,
        });
        wx += 60;
        doc.text(`${wb.coveragePct}% of grp`, wx + 4, wy + 4, {
          width: 90 - 8,
          lineBreak: false,
        });
        wy += rowH;
      }
    }

    // ----- Right: Sub-pods (E) -----
    if (podList.length > 0 && haveBoth) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
      doc.text(
        `Suggested within-class sub-pods (${podList.length})`,
        rightX,
        bandY,
        { width: rightColW, lineBreak: false },
      );
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#64748b");
      doc.text(
        "Auto-clustered by benchmark deficit. Adjust as needed.",
        rightX,
        bandY + 12,
        { width: rightColW, lineBreak: false, ellipsis: true },
      );
      // Stack pods vertically inside the right column — names wrap
      // naturally and the column is narrow enough that 3 horizontal
      // pods would clip too many names.
      let py = bandY + 26;
      for (const pod of podList) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
        const podHeader = pod.dominantCategory
          ? `Pod ${pod.podIndex} · ${pod.dominantCategory} (${pod.memberNames.length})`
          : `Pod ${pod.podIndex} (${pod.memberNames.length})`;
        doc.text(podHeader, rightX, py, {
          width: rightColW,
          lineBreak: false,
          ellipsis: true,
        });
        doc.font("Helvetica").fontSize(8).fillColor("#334155");
        doc.text(pod.memberNames.join(", "), rightX, py + 11, {
          width: rightColW,
        });
        py = doc.y + 4;
      }
    } else if (podList.length > 0) {
      // Full-width sub-pods (when there are no weakest benchmarks to
      // pair with — rare, but happens for tiny groups).
      let py = bandY;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
      doc.text(`Suggested within-class sub-pods (${podList.length})`, left, py);
      py += 14;
      const podW = Math.floor(width / podList.length);
      const maxRowH = podList.reduce(
        (m, p) => Math.max(m, 14 + Math.ceil(p.memberNames.length / 3) * 11),
        0,
      );
      for (let pi = 0; pi < podList.length; pi++) {
        const pod = podList[pi];
        const px = left + pi * podW;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
        const header = pod.dominantCategory
          ? `Pod ${pod.podIndex} · ${pod.dominantCategory}`
          : `Pod ${pod.podIndex}`;
        doc.text(header, px + 4, py, { width: podW - 8, ellipsis: true });
        doc.font("Helvetica").fontSize(8).fillColor("#334155");
        doc.text(pod.memberNames.join(", ") || "—", px + 4, py + 12, {
          width: podW - 8,
        });
      }
      y = py + maxRowH + 8;
    }
    y = bandY + bandH;
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

  // ----- Pre-printed M-F × 3-rotation grid (D) -----
  // Only render on the last group page so the deck ends with one
  // ready-to-write grid the teacher can fill in by hand. Three
  // rotations per day is the small-group standard for K-8 reading
  // and math blocks (teacher-led / independent / partner).
  if (ctx.isLastGroup) {
    const gridTitleH = 18;
    const gridRows = 3;
    const gridHeaderH = 18;
    const gridCellH = 42;
    const gridBlockH = gridTitleH + gridHeaderH + gridRows * gridCellH + 8;
    if (y + gridBlockH > bottomLimit) {
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
      y += 16;
    }
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
    doc.text("Weekly rotation grid (fill in by hand)", left, y);
    y += gridTitleH;
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const labelW = 80;
    const dayW = Math.floor((width - labelW) / days.length);
    // Header row.
    doc
      .save()
      .rect(left, y, labelW + dayW * days.length, gridHeaderH)
      .fillColor("#e2e8f0")
      .fill()
      .restore();
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
    doc.text("", left + 4, y + 5, { width: labelW - 8 });
    for (let di = 0; di < days.length; di++) {
      doc.text(days[di], left + labelW + di * dayW + 4, y + 5, {
        width: dayW - 8,
        align: "center",
      });
    }
    // Outline header bottom border.
    doc
      .save()
      .moveTo(left, y + gridHeaderH)
      .lineTo(left + labelW + dayW * days.length, y + gridHeaderH)
      .lineWidth(0.5)
      .strokeColor("#94a3b8")
      .stroke()
      .restore();
    y += gridHeaderH;
    // Three rotation rows.
    const rotationLabels = ["Rotation A", "Rotation B", "Rotation C"];
    for (let ri = 0; ri < gridRows; ri++) {
      // Label cell.
      doc
        .save()
        .rect(left, y, labelW, gridCellH)
        .fillColor("#f8fafc")
        .fill()
        .restore();
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      doc.text(rotationLabels[ri], left + 4, y + 6, { width: labelW - 8 });
      // Day cells — empty bordered boxes.
      for (let di = 0; di < days.length; di++) {
        const cx = left + labelW + di * dayW;
        doc
          .save()
          .rect(cx, y, dayW, gridCellH)
          .lineWidth(0.5)
          .strokeColor("#cbd5e1")
          .stroke()
          .restore();
      }
      // Vertical separator after label.
      doc
        .save()
        .moveTo(left + labelW, y)
        .lineTo(left + labelW, y + gridCellH)
        .lineWidth(0.5)
        .strokeColor("#94a3b8")
        .stroke()
        .restore();
      y += gridCellH;
    }
    // Outer border.
    doc
      .save()
      .rect(left, y - gridRows * gridCellH - gridHeaderH, labelW + dayW * days.length, gridRows * gridCellH + gridHeaderH)
      .lineWidth(0.7)
      .strokeColor("#475569")
      .stroke()
      .restore();
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
