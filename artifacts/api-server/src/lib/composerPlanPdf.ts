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
        isLastGroup: i === input.groups.length - 1,
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

  // Second summary line — cross-module context counts. Only render
  // when there's anything to show (otherwise the empty "·" line is
  // visual noise on plans whose students happen to have no MTSS /
  // safety / retention / discipline footprint at all).
  if (g.context) {
    const ctxParts: string[] = [];
    if (g.context.activeMtss > 0)
      ctxParts.push(`Active MTSS ${g.context.activeMtss}`);
    if (g.context.activeSafetyPlan > 0)
      ctxParts.push(`Safety plan ${g.context.activeSafetyPlan}`);
    if (g.context.everRetained > 0)
      ctxParts.push(`Ever retained ${g.context.everRetained}`);
    if (g.context.disciplineEvents30 > 0)
      ctxParts.push(`ISS+OSS last 30d ${g.context.disciplineEvents30}`);
    if (ctxParts.length > 0) {
      doc.font("Helvetica").fontSize(9).fillColor("#475569");
      doc.text(ctxParts.join("  ·  "));
    }
  }

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

  // ----- Group weakest benchmarks (A) -----
  // Always render when we have aggregate data — gives Cusp plans
  // a "where to focus instruction" handle (they have no focus
  // standards) and gives skill-cluster plans a sanity check (the
  // recipe's focus codes should overlap heavily with this list).
  if (g.weakestBenchmarks && g.weakestBenchmarks.length > 0) {
    if (y + 60 + g.weakestBenchmarks.length * rowH > bottomLimit) {
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
    doc.text("Group's 5 weakest benchmarks (whole-class focus)", left, y);
    y += 14;
    const wbCols: Array<{ w: number; label: string }> = [
      { w: 24, label: "#" },
      { w: 180, label: "Benchmark" },
      { w: 80, label: "Group avg" },
      { w: 100, label: "Coverage" },
      { w: width - 24 - 180 - 80 - 100, label: "" },
    ];
    drawRow(doc, left, y, rowH, wbCols, "header");
    x = left;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
    for (const c of wbCols) {
      doc.text(c.label, x + 4, y + 5, { width: c.w - 8 });
      x += c.w;
    }
    y += rowH;
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
    for (let i = 0; i < g.weakestBenchmarks.length; i++) {
      const wb = g.weakestBenchmarks[i];
      if (i % 2 === 1) drawRow(doc, left, y, rowH, wbCols, "alt");
      const fill = heatFill(wb.avgPct);
      if (fill) {
        doc.save().rect(left + 24 + 180, y, 80, rowH).fillColor(fill).fill().restore();
      }
      x = left;
      doc.fillColor("#0f172a");
      doc.text(String(i + 1), x + 4, y + 5, { width: 24 - 8 });
      x += 24;
      doc.text(wb.benchmarkCode, x + 4, y + 5, {
        width: 180 - 8,
        ellipsis: true,
        lineBreak: false,
      });
      x += 180;
      doc.text(`${wb.avgPct}%`, x + 4, y + 5, { width: 80 - 8, align: "center" });
      x += 80;
      doc.text(`${wb.coveragePct}% of group`, x + 4, y + 5, {
        width: 100 - 8,
      });
      y += rowH;
    }
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

  // ----- Suggested within-class sub-pods (E) -----
  // Only when the route layer found enough students with FAST
  // profiles to be worth pod-ing (≥6 profiles, capped at 3 pods).
  if (g.subPods && g.subPods.length > 0) {
    const podBlockH = 30 + g.subPods.length * 32;
    if (y + podBlockH > bottomLimit) {
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
    doc.text(
      `Suggested within-class sub-pods (${g.subPods.length})`,
      left,
      y,
    );
    y += 4;
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#64748b");
    doc.text(
      "Auto-generated from benchmark deficit clustering. Adjust as needed.",
      left,
      y + 8,
    );
    y += 20;
    const podW = Math.floor(width / g.subPods.length);
    const podY = y;
    let maxPodH = 0;
    for (let pi = 0; pi < g.subPods.length; pi++) {
      const pod = g.subPods[pi];
      const px = left + pi * podW;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      const header = pod.dominantCategory
        ? `Pod ${pod.podIndex} · ${pod.dominantCategory}`
        : `Pod ${pod.podIndex}`;
      doc.text(header, px + 4, podY, { width: podW - 8, ellipsis: true });
      doc.font("Helvetica").fontSize(8).fillColor("#334155");
      const memberText = pod.memberNames.join(", ") || "—";
      doc.text(memberText, px + 4, podY + 12, { width: podW - 8 });
      const podH = doc.y - podY;
      if (podH > maxPodH) maxPodH = podH;
    }
    y = podY + maxPodH + 8;
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
