// Class Composer "Master Plan" printable PDF — teacher-facing redesign.
//
// Design goals (per user request):
//   - Answer 5 questions in under 2 minutes: who's in my class, where
//     are they, what skills are they missing, how do I differentiate
//     inside the class, why was this group built this way.
//   - One page per group (landscape). Roster overflow ONLY produces a
//     continuation page — focus/pods/rationale never repeat.
//   - Strict y-tracking: pdfkit margins are top:0/bottom:0 so the
//     library never auto-paginates on us. Every text call has explicit
//     x,y AND either lineBreak:false or a measured `height` clip.
//
// Layout:
//   Cover (portrait):
//     - Title + subtitle (school · subject/grade/SY · status · saved by)
//     - "How these groups were built" — 5 plain-language criteria
//     - Plan snapshot: two columns (counts | FAST level distribution bar)
//     - "Most-deficit benchmarks plan-wide" heat strip (top 7, weighted)
//     - "Groups in this plan" — 2-column index (name + seats + top focus)
//
//   One landscape page per group:
//     - Top band: name (left) + counts (right) + recipe + context chips
//     - Left col (~42% width):
//         * Focus standards (5) with heat bars + friendly labels
//         * Why this group — auto-generated rationale
//         * Suggested small-group pods (skill-themed)
//     - Right col (~58% width):
//         * Roster sorted Fit desc, then Overall asc
//         * Cols: # · Student · Gr · FAST · Overall % (heat) · PM 1/2/3 · Flags · Fit

import PDFDocument from "pdfkit";

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
  benchmarkPctByCode: Record<string, number>;
  bottomBenchmarkCodes: string[];
  strands: Array<{ category: string; pct: number }>;
  currentSection: {
    courseName: string;
    period: number;
    teacherName: string | null;
  } | null;
  pmLevels?: {
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
  };
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
  weakestBenchmarks?: Array<{
    benchmarkCode: string;
    avgPct: number;
    coveragePct: number;
  }>;
  subPods?: Array<{
    podIndex: number;
    dominantCategory: string | null;
    memberNames: string[];
  }>;
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
  return f.join("·");
}

function heatFill(pct: number | null): string | null {
  if (pct == null) return null;
  if (pct < 50) return "#fee2e2";
  if (pct < 70) return "#fef3c7";
  return "#dcfce7";
}

function detectSourceWindow(input: ComposerPlanPdfInput): string | null {
  for (const g of input.groups) {
    for (const f of g.focusStandards ?? []) {
      if (f.sourceWindow) return f.sourceWindow.toUpperCase();
    }
  }
  return null;
}

function detectSourceWindowForGroup(
  g: ComposerPlanPdfGroup,
): string | null {
  for (const f of g.focusStandards ?? []) {
    if (f.sourceWindow) return f.sourceWindow.toUpperCase();
  }
  return null;
}

export async function renderComposerPlanPdf(
  input: ComposerPlanPdfInput,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      // These doc-level margins are inherited by addPage ONLY when addPage
      // is called without margin options. We pass margins explicitly on
      // every addPage below (pdfkit otherwise resets to 72pt defaults,
      // shrinking page.maxY() and causing auto-pagination on bottom text).
      margins: { top: 0, bottom: 0, left: PAGE_MARGIN, right: PAGE_MARGIN },
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

    // ----- Cover (portrait) -----
    // CRITICAL: must pass margins on every addPage. pdfkit does NOT inherit
    // doc-level margins; without this, page.maxY() falls back to height-72,
    // which auto-paginates any text call near the bottom (e.g. footer).
    doc.addPage({ size: "LETTER", layout: "portrait", margins: { top: 0, bottom: 0, left: PAGE_MARGIN, right: PAGE_MARGIN } });
    drawHeader(doc, input.planName, "Cover");
    drawFooter(doc, input.publicId, false);
    drawCoverBody(doc, input);

    // ----- One landscape page per group -----
    for (let i = 0; i < input.groups.length; i++) {
      const g = input.groups[i];
      doc.addPage({ size: "LETTER", layout: "landscape", margins: { top: 0, bottom: 0, left: PAGE_MARGIN, right: PAGE_MARGIN } });
      drawHeader(
        doc,
        input.planName,
        `Group ${g.groupIndex} of ${input.groups.length}`,
      );
      drawFooter(doc, input.publicId, true);
      drawGroupBody(doc, g, {
        planName: input.planName,
        totalGroups: input.groups.length,
        publicId: input.publicId,
      });
    }

    // Post-pass: stamp "Page X of Y" once we know the final count
    // (roster overflows can push past the up-front estimate).
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
        {
          width: widthBand / 3 - 8,
          align: "right",
          lineBreak: false,
        },
      );
    }

    doc.end();
  });
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  planName: string,
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
  doc.text(planName, left + 8, y + 9, {
    width: width / 3,
    ellipsis: true,
    lineBreak: false,
  });
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
  doc.text(middle, left + width / 3, y + 9, {
    width: width / 3,
    align: "center",
    lineBreak: false,
  });
  // Page X of Y is stamped post-pass in renderComposerPlanPdf.
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  publicId: string,
  showSignature: boolean,
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
  doc.font("Helvetica").fontSize(9).fillColor("#64748b");
  doc.text("Plan ID", right - 200, top + 14, {
    width: 90,
    align: "right",
    lineBreak: false,
  });
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
  doc.text(publicId, right - 110, top + 14, {
    width: 110,
    align: "right",
    lineBreak: false,
  });
  if (showSignature) {
    doc.font("Helvetica").fontSize(9).fillColor("#64748b");
    doc.text("Confirmed by:", left, top + 14, { lineBreak: false });
    doc
      .save()
      .moveTo(left + 70, top + 24)
      .lineTo(left + 270, top + 24)
      .lineWidth(0.5)
      .strokeColor("#475569")
      .stroke()
      .restore();
    doc.text("Date:", left, top + 38, { lineBreak: false });
    doc
      .save()
      .moveTo(left + 70, top + 48)
      .lineTo(left + 200, top + 48)
      .lineWidth(0.5)
      .strokeColor("#475569")
      .stroke()
      .restore();
  }
  doc.font("Helvetica").fontSize(8).fillColor("#94a3b8");
  doc.text(
    "Look up the Plan ID in PulseEDU (Class Composer → Plans) to find the source plan.",
    left,
    top + 58,
    { width: right - left - 220, height: 10, lineBreak: false, ellipsis: true },
  );
}

// ============================================================
// COVER
// ============================================================

function drawCoverBody(
  doc: PDFKit.PDFDocument,
  input: ComposerPlanPdfInput,
) {
  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  const width = right - left;
  const bottomLimit =
    doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT - 8;
  let y = PAGE_MARGIN + HEADER_HEIGHT + 14;

  // === Title ===
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#0f172a");
  doc.text(input.planName, left, y, {
    width,
    lineBreak: false,
    ellipsis: true,
  });
  y += 28;

  doc.font("Helvetica").fontSize(11).fillColor("#475569");
  const subtitleParts = [
    input.schoolName,
    `${subjectLabel(input.subject)} · Grade ${input.grade} · ${input.schoolYear}`,
    input.status === "final" && input.finalizedAt
      ? `Finalized ${fmtDate(input.finalizedAt)}`
      : `Draft (created ${fmtDate(input.createdAt)})`,
    `Saved by ${input.savedByName}`,
  ];
  doc.text(subtitleParts.join("  ·  "), left, y, {
    width,
    lineBreak: false,
    ellipsis: true,
  });
  y += 20;

  // Divider
  doc
    .save()
    .moveTo(left, y)
    .lineTo(right, y)
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .stroke()
    .restore();
  y += 12;

  // === How these groups were built ===
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
  doc.text("How these groups were built", left, y, {
    width,
    lineBreak: false,
  });
  y += 16;

  const hasFocus = input.groups.some(
    (g) => g.focusStandards && g.focusStandards.length > 0,
  );
  const sw = detectSourceWindow(input);
  const criteria = [
    hasFocus
      ? "Eligibility — students at FAST levels 1-2 in the source PM window (and below grade-level decile for tier-3 pools)."
      : "Eligibility — pool defined by the recipe (typically L1/L2 for intensive, broader for cusp).",
    "Cohesion metric — students placed with peers whose personal bottom-7 weakest benchmarks overlap.",
    hasFocus
      ? "Focus standards — top 5 benchmarks per group where avg mastery ≤ 50% AND ≥ 60% of the group has item-response coverage."
      : "Focus skills — ranked by lowest group-average mastery with coverage floor applied.",
    "Caps & guardrails — section seat limit, ESE concentration ceiling, no co-listing of students cross-listed on each other's safety plans.",
    `Source window — ${sw ?? "latest PM"} — anchors the recipe; the plan does not auto-refresh when newer data arrives.`,
  ];
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
  for (const c of criteria) {
    const bulletText = `•  ${c}`;
    const h = doc.heightOfString(bulletText, { width: width - 12 });
    doc.text(bulletText, left + 6, y, {
      width: width - 12,
      height: h,
    });
    y += h + 3;
  }
  y += 8;

  // === Plan snapshot: two columns ===
  const allStudents = input.groups.flatMap((g) => g.students);
  const totalStudents = allStudents.length;
  const counts = {
    ese: allStudents.filter((s) => s.ese).length,
    is504: allStudents.filter((s) => s.is504).length,
    ell: allStudents.filter((s) => s.ell).length,
    mtss: allStudents.filter((s) => s.hasActiveMtss).length,
    safety: allStudents.filter((s) => s.hasActiveSafetyPlan).length,
    retained: allStudents.filter((s) => s.everRetained).length,
    disc30: allStudents.reduce(
      (a, s) => a + (s.disciplineDays30 ?? 0),
      0,
    ),
  };
  const scored = allStudents.filter((s) => s.overallPct != null);
  const planAvg =
    scored.length === 0
      ? null
      : Math.round(
          scored.reduce((a, s) => a + (s.overallPct ?? 0), 0) /
            scored.length,
        );
  const levelCounts = [0, 0, 0, 0, 0];
  for (const s of allStudents) {
    if (s.fastLevel && s.fastLevel >= 1 && s.fastLevel <= 5)
      levelCounts[s.fastLevel - 1]++;
  }

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
  doc.text("Plan snapshot", left, y, { width, lineBreak: false });
  y += 16;

  const colW = (width - 16) / 2;
  const rightColX = left + colW + 16;

  // LEFT — counts
  const leftRows: [string, string][] = [
    ["Total students", String(totalStudents)],
    ["Groups", String(input.groups.length)],
    ["Avg overall %", planAvg != null ? `${planAvg}%` : "—"],
    ["ESE", String(counts.ese)],
    ["504", String(counts.is504)],
    ["ELL", String(counts.ell)],
    ["Active MTSS", String(counts.mtss)],
    ["Active safety plans", String(counts.safety)],
    ["Ever retained", String(counts.retained)],
    ["ISS+OSS days (last 30)", String(counts.disc30)],
  ];
  let ly = y;
  for (const [k, v] of leftRows) {
    doc.font("Helvetica").fontSize(10).fillColor("#475569");
    doc.text(k, left, ly, {
      width: colW * 0.65,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").fillColor("#0f172a");
    doc.text(v, left + colW * 0.65, ly, {
      width: colW * 0.35,
      align: "right",
      lineBreak: false,
    });
    ly += 13;
  }

  // RIGHT — FAST level distribution
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
  doc.text("FAST level distribution", rightColX, y, {
    width: colW,
    lineBreak: false,
  });
  let ry = y + 16;
  const barH = 22;
  const barW = colW;
  const colors = [
    "#ef4444",
    "#f97316",
    "#eab308",
    "#22c55e",
    "#15803d",
  ];
  let cumX = 0;
  for (let i = 0; i < 5; i++) {
    const c = levelCounts[i];
    const segW =
      totalStudents > 0 ? (c / totalStudents) * barW : 0;
    if (segW > 0) {
      doc
        .save()
        .rect(rightColX + cumX, ry, segW, barH)
        .fillColor(colors[i])
        .fill()
        .restore();
    }
    cumX += segW;
  }
  doc
    .save()
    .rect(rightColX, ry, barW, barH)
    .lineWidth(0.5)
    .strokeColor("#475569")
    .stroke()
    .restore();
  ry += barH + 8;
  // Legend — 5 chips side-by-side
  const legW = colW / 5;
  for (let i = 0; i < 5; i++) {
    const lx = rightColX + i * legW;
    doc
      .save()
      .rect(lx, ry, 10, 10)
      .fillColor(colors[i])
      .fill()
      .restore();
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    doc.text(`L${i + 1}: ${levelCounts[i]}`, lx + 14, ry + 1, {
      width: legW - 16,
      lineBreak: false,
    });
  }
  ry += 18;

  y = Math.max(ly, ry) + 12;

  // === Plan-wide weakest benchmarks (heat strip) ===
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
    .map(([code, v]) => ({
      code,
      avg: Math.round(v.weightedSum / v.weight),
    }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 7);

  if (topWeakest.length > 0 && y + 50 < bottomLimit) {
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
    doc.text(
      "Most-deficit benchmarks plan-wide (weighted)",
      left,
      y,
      { width, lineBreak: false },
    );
    y += 16;
    const cellW = width / topWeakest.length;
    for (let i = 0; i < topWeakest.length; i++) {
      const wb = topWeakest[i];
      const x = left + i * cellW;
      const fill = heatFill(wb.avg);
      if (fill) {
        doc
          .save()
          .rect(x, y, cellW - 4, 36)
          .fillColor(fill)
          .fill()
          .restore();
      }
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      doc.text(wb.code, x + 4, y + 6, {
        width: cellW - 12,
        lineBreak: false,
        ellipsis: true,
      });
      doc.font("Helvetica").fontSize(12).fillColor("#0f172a");
      doc.text(`${wb.avg}%`, x + 4, y + 20, {
        width: cellW - 12,
        lineBreak: false,
      });
    }
    y += 46;
  }

  // === Groups in this plan (index) ===
  if (y + 40 < bottomLimit) {
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a");
    doc.text("Groups in this plan", left, y, {
      width,
      lineBreak: false,
    });
    y += 16;
    const groupRowH = 26;
    const groupColW = (width - 12) / 2;
    for (let i = 0; i < input.groups.length; i++) {
      const g = input.groups[i];
      const col = i % 2;
      const row = Math.floor(i / 2);
      const gx = left + col * (groupColW + 12);
      const gy = y + row * groupRowH;
      if (gy + groupRowH > bottomLimit) break;
      const overCap = g.students.length > g.seatsPerSection;
      const topFocus =
        g.focusStandards && g.focusStandards.length > 0
          ? g.focusStandards[0].benchmarkCode
          : g.weakestBenchmarks && g.weakestBenchmarks.length > 0
            ? g.weakestBenchmarks[0].benchmarkCode
            : null;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
      doc.text(`${g.groupIndex}. ${g.name}`, gx, gy, {
        width: groupColW,
        lineBreak: false,
        ellipsis: true,
      });
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(overCap ? "#b91c1c" : "#64748b");
      const meta = `${g.students.length}/${g.seatsPerSection} seats${overCap ? " (OVER)" : ""}${topFocus ? `  ·  Top focus: ${topFocus}` : ""}`;
      doc.text(meta, gx, gy + 12, {
        width: groupColW,
        lineBreak: false,
        ellipsis: true,
      });
    }
    y += Math.ceil(input.groups.length / 2) * groupRowH + 8;
  }

  // Disclaimer
  if (y + 20 < bottomLimit) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#94a3b8");
    const note =
      "Paper artifact only — does not modify Skyward/RosterOne. Each page is tagged with the Plan ID below so shuffled pages can be re-assembled.";
    const noteH = doc.heightOfString(note, { width });
    doc.text(note, left, y, { width, height: Math.min(noteH, 24) });
  }
}

// ============================================================
// GROUP PAGE
// ============================================================

interface GroupPageCtx {
  planName: string;
  totalGroups: number;
  publicId: string;
}

interface RosterCol {
  w: number;
  label: string;
  key:
    | "idx"
    | "name"
    | "grade"
    | "fast"
    | "overall"
    | "pm"
    | "flags"
    | "fit";
}

function buildRosterCols(
  totalW: number,
  hasFocus: boolean,
): RosterCol[] {
  const base: RosterCol[] = [
    { w: 20, label: "#", key: "idx" },
    { w: 0, label: "Student", key: "name" }, // flex
    { w: 24, label: "Gr", key: "grade" },
    { w: 32, label: "FAST", key: "fast" },
    { w: 42, label: "Overall", key: "overall" },
    { w: 70, label: "PM 1/2/3", key: "pm" },
    { w: 56, label: "Flags", key: "flags" },
  ];
  if (hasFocus) base.push({ w: 40, label: "Fit", key: "fit" });
  const used = base.reduce((a, c) => a + c.w, 0);
  base[1].w = Math.max(80, totalW - used);
  return base;
}

function buildReasonText(
  g: ComposerPlanPdfGroup,
  cohesionPct: number | null,
  focusCount: number,
): string {
  const parts: string[] = [];
  if (g.focusStandards && g.focusStandards.length >= 2) {
    const top2 = g.focusStandards.slice(0, 2);
    parts.push(
      `Built around shared deficit in ${top2
        .map((f) => f.benchmarkCode)
        .join(" and ")} (lowest-mastery benchmarks across the roster).`,
    );
  } else if (g.focusStandards && g.focusStandards.length === 1) {
    parts.push(
      `Built around shared deficit in ${g.focusStandards[0].benchmarkCode} (lowest-mastery benchmark across the roster).`,
    );
  } else if (g.weakestBenchmarks && g.weakestBenchmarks.length > 0) {
    parts.push(
      `Roster's most common deficit is ${g.weakestBenchmarks[0].benchmarkCode} at ${g.weakestBenchmarks[0].avgPct}% group average.`,
    );
  } else {
    parts.push(
      `Built per recipe — see roster for FAST level mix and PM trajectory.`,
    );
  }
  if (cohesionPct != null && focusCount > 0) {
    const threshold = Math.max(1, Math.ceil(focusCount / 2));
    parts.push(
      `${cohesionPct}% of the roster has at least ${threshold} of the ${focusCount} focus standards in their personal bottom-7 weakest skills — the higher this number, the more the group can be taught as one.`,
    );
  }
  const sw = detectSourceWindowForGroup(g);
  if (sw) parts.push(`Recipe anchored to ${sw}.`);
  return parts.join(" ");
}

function drawGroupBody(
  doc: PDFKit.PDFDocument,
  g: ComposerPlanPdfGroup,
  ctx: GroupPageCtx,
) {
  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  const width = right - left;
  const top = PAGE_MARGIN + HEADER_HEIGHT + 10;
  const bottomLimit =
    doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT - 8;

  // === Top band ===
  let y = top;

  // Computed aggregates
  const ese = g.students.filter((s) => s.ese).length;
  const fpf = g.students.filter((s) => s.is504).length;
  const ell = g.students.filter((s) => s.ell).length;
  const scored = g.students.filter((s) => s.overallPct != null);
  const avgOverall =
    scored.length === 0
      ? null
      : Math.round(
          scored.reduce((a, s) => a + (s.overallPct ?? 0), 0) /
            scored.length,
        );
  const focusCodes = (g.focusStandards ?? []).map(
    (f) => f.benchmarkCode,
  );
  let cohesionPct: number | null = null;
  if (focusCodes.length > 0 && g.students.length > 0) {
    const threshold = Math.max(1, Math.ceil(focusCodes.length / 2));
    const cohered = g.students.filter((s) => {
      const bs = new Set(s.bottomBenchmarkCodes);
      return focusCodes.filter((c) => bs.has(c)).length >= threshold;
    }).length;
    cohesionPct = Math.round((cohered / g.students.length) * 100);
  }

  // Group name (left) + counts (right)
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f172a");
  doc.text(g.name, left, y, {
    width: width * 0.6,
    lineBreak: false,
    ellipsis: true,
  });

  const overCap = g.students.length > g.seatsPerSection;
  const countsParts = [
    `${g.students.length} student${g.students.length === 1 ? "" : "s"}`,
    `Seats ${g.seatsPerSection}${overCap ? " (OVER)" : ""}`,
    ...(avgOverall != null ? [`Avg ${avgOverall}%`] : []),
    ...(cohesionPct != null ? [`Cohesion ${cohesionPct}%`] : []),
  ];
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(overCap ? "#b91c1c" : "#334155");
  doc.text(countsParts.join("  ·  "), left + width * 0.6, y + 5, {
    width: width * 0.4,
    align: "right",
    lineBreak: false,
  });
  y += 22;

  // Recipe (1 line clipped)
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#64748b");
  doc.text(g.recipeSummary, left, y, {
    width,
    lineBreak: false,
    ellipsis: true,
  });
  y += 14;

  // Context chips (1 line)
  const chips: string[] = [];
  if (ese > 0) chips.push(`ESE ${ese}`);
  if (fpf > 0) chips.push(`504 ${fpf}`);
  if (ell > 0) chips.push(`ELL ${ell}`);
  if (g.context) {
    if (g.context.activeMtss > 0)
      chips.push(`MTSS ${g.context.activeMtss}`);
    if (g.context.activeSafetyPlan > 0)
      chips.push(`Safety ${g.context.activeSafetyPlan}`);
    if (g.context.everRetained > 0)
      chips.push(`Retained ${g.context.everRetained}`);
    if (g.context.disciplineEvents30 > 0)
      chips.push(`Disc-30d ${g.context.disciplineEvents30}`);
  }
  if (chips.length > 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#475569");
    doc.text(chips.join("   ·   "), left, y, {
      width,
      lineBreak: false,
      ellipsis: true,
    });
    y += 13;
  }

  // Divider
  doc
    .save()
    .moveTo(left, y)
    .lineTo(right, y)
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .stroke()
    .restore();
  y += 8;

  // === Two-column body ===
  const colGap = 16;
  const leftColW = Math.floor((width - colGap) * 0.42);
  const rightColW = width - leftColW - colGap;
  const rightColX = left + leftColW + colGap;
  const colTop = y;

  // ----- LEFT COL -----
  let ly = colTop;

  // Focus standards
  if (g.focusStandards && g.focusStandards.length > 0) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
    doc.text(
      `Focus standards (${g.focusStandards.length})`,
      left,
      ly,
      { width: leftColW, lineBreak: false },
    );
    ly += 16;
    for (const f of g.focusStandards) {
      if (ly + 28 > bottomLimit) break;
      // Code on left, heat bar with % on right
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      doc.text(f.benchmarkCode, left, ly + 1, {
        width: leftColW * 0.55,
        lineBreak: false,
        ellipsis: true,
      });
      const barX = left + leftColW * 0.55;
      const barW = leftColW * 0.45;
      const fill = heatFill(f.groupAvgPct) ?? "#f1f5f9";
      doc
        .save()
        .rect(barX, ly - 1, barW, 13)
        .fillColor(fill)
        .fill()
        .restore();
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      doc.text(`${f.groupAvgPct}% group avg`, barX + 4, ly + 1, {
        width: barW - 8,
        align: "center",
        lineBreak: false,
      });
      ly += 14;
      // Friendly label, clipped to 2 lines (~22pt)
      doc.font("Helvetica").fontSize(8.5).fillColor("#475569");
      const label = f.friendlyLabel.replace(
        `${f.benchmarkCode} · `,
        "",
      );
      doc.text(label, left, ly, {
        width: leftColW,
        height: 22,
        ellipsis: true,
      });
      ly += 24;
    }
    ly += 6;
  }

  // Why this group
  if (ly + 50 < bottomLimit) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
    doc.text("Why this group", left, ly, {
      width: leftColW,
      lineBreak: false,
    });
    ly += 15;
    const reason = buildReasonText(
      g,
      cohesionPct,
      focusCodes.length,
    );
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    const reasonH = Math.min(
      doc.heightOfString(reason, { width: leftColW }),
      bottomLimit - ly - 4,
    );
    doc.text(reason, left, ly, {
      width: leftColW,
      height: Math.max(reasonH, 12),
    });
    ly += reasonH + 10;
  }

  // Suggested sub-pods
  if (
    g.subPods &&
    g.subPods.length > 0 &&
    ly + 40 < bottomLimit
  ) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
    doc.text(
      `Suggested small-group pods (${g.subPods.length})`,
      left,
      ly,
      { width: leftColW, lineBreak: false },
    );
    ly += 14;
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#64748b");
    const helperText =
      "Auto-clustered by shared skill deficit — pull together during teacher-led rotations.";
    const helperH = Math.min(
      doc.heightOfString(helperText, { width: leftColW }),
      20,
    );
    doc.text(helperText, left, ly, {
      width: leftColW,
      height: helperH,
    });
    ly += helperH + 4;
    for (const pod of g.subPods) {
      if (ly + 22 > bottomLimit) break;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      const podHeader = pod.dominantCategory
        ? `Pod ${pod.podIndex} · ${pod.dominantCategory} (${pod.memberNames.length})`
        : `Pod ${pod.podIndex} (${pod.memberNames.length})`;
      doc.text(podHeader, left, ly, {
        width: leftColW,
        lineBreak: false,
        ellipsis: true,
      });
      ly += 11;
      doc.font("Helvetica").fontSize(8).fillColor("#475569");
      const members = pod.memberNames.join(", ") || "—";
      const remaining = bottomLimit - ly;
      const mH = Math.min(
        doc.heightOfString(members, { width: leftColW }),
        Math.max(11, Math.min(22, remaining)),
      );
      doc.text(members, left, ly, {
        width: leftColW,
        height: mH,
        ellipsis: true,
      });
      ly += mH + 4;
    }
  }

  // ----- RIGHT COL: roster -----
  // Sort: Fit desc (most-targeted at top), then Overall asc
  const sortedStudents = [...g.students].sort((a, b) => {
    let fitA = 0;
    let fitB = 0;
    if (focusCodes.length > 0) {
      const sA = new Set(a.bottomBenchmarkCodes);
      const sB = new Set(b.bottomBenchmarkCodes);
      fitA = focusCodes.filter((c) => sA.has(c)).length;
      fitB = focusCodes.filter((c) => sB.has(c)).length;
    }
    if (fitB !== fitA) return fitB - fitA;
    const pA = a.overallPct ?? 999;
    const pB = b.overallPct ?? 999;
    return pA - pB;
  });

  const hasFocus = focusCodes.length > 0;
  const rosterCols = buildRosterCols(rightColW, hasFocus);
  const headerH = 18;
  const rowH = 16;

  let ry = colTop;
  drawRosterHeader(doc, rightColX, ry, headerH, rightColW, rosterCols);
  ry += headerH;

  const availRows = Math.floor((bottomLimit - ry) / rowH);
  const rowsThisPage = Math.min(sortedStudents.length, availRows);
  drawRosterRows(
    doc,
    sortedStudents.slice(0, rowsThisPage),
    rightColX,
    ry,
    rowH,
    rosterCols,
    focusCodes,
    0,
  );

  // Continuation pages — roster only, no left col, full-width table.
  let drawn = rowsThisPage;
  while (drawn < sortedStudents.length) {
    doc.addPage({ size: "LETTER", layout: "landscape", margins: { top: 0, bottom: 0, left: PAGE_MARGIN, right: PAGE_MARGIN } });
    drawHeader(
      doc,
      ctx.planName,
      `Group ${g.groupIndex} of ${ctx.totalGroups} (roster cont.)`,
    );
    drawFooter(doc, ctx.publicId, false);
    let cy = PAGE_MARGIN + HEADER_HEIGHT + 12;
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a");
    doc.text(`${g.name} — roster continued`, left, cy, {
      width,
      lineBreak: false,
      ellipsis: true,
    });
    cy += 22;
    const fullCols = buildRosterCols(width, hasFocus);
    drawRosterHeader(doc, left, cy, headerH, width, fullCols);
    cy += headerH;
    const contBottom =
      doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT - 8;
    const remainingRows = Math.floor((contBottom - cy) / rowH);
    const sliceCount = Math.min(
      sortedStudents.length - drawn,
      remainingRows,
    );
    drawRosterRows(
      doc,
      sortedStudents.slice(drawn, drawn + sliceCount),
      left,
      cy,
      rowH,
      fullCols,
      focusCodes,
      drawn,
    );
    drawn += sliceCount;
    // Guard against infinite loop if the page can't fit any rows
    // (shouldn't happen at rowH=16, but defensive).
    if (sliceCount === 0) break;
  }
}

function drawRosterHeader(
  doc: PDFKit.PDFDocument,
  x0: number,
  y: number,
  headerH: number,
  totalW: number,
  cols: RosterCol[],
) {
  doc
    .save()
    .rect(x0, y, totalW, headerH)
    .fillColor("#e2e8f0")
    .fill()
    .restore();
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
  let x = x0;
  for (const c of cols) {
    doc.text(c.label, x + 4, y + 5, {
      width: c.w - 8,
      lineBreak: false,
      ellipsis: true,
    });
    x += c.w;
  }
}

function drawRosterRows(
  doc: PDFKit.PDFDocument,
  students: ComposerPlanPdfStudent[],
  x0: number,
  y0: number,
  rowH: number,
  cols: RosterCol[],
  focusCodes: string[],
  indexOffset: number,
): void {
  let y = y0;
  const totalW = cols.reduce((a, c) => a + c.w, 0);
  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    // Zebra stripe
    if (i % 2 === 1) {
      doc
        .save()
        .rect(x0, y, totalW, rowH)
        .fillColor("#f8fafc")
        .fill()
        .restore();
    }
    // Heat-tint the Overall column cell
    const overallCol = cols.find((c) => c.key === "overall");
    if (overallCol && s.overallPct != null) {
      let ox = x0;
      for (const c of cols) {
        if (c.key === "overall") break;
        ox += c.w;
      }
      const fill = heatFill(s.overallPct);
      if (fill) {
        doc
          .save()
          .rect(ox, y, overallCol.w, rowH)
          .fillColor(fill)
          .fill()
          .restore();
      }
    }

    let fitText = "—";
    if (focusCodes.length > 0) {
      const bs = new Set(s.bottomBenchmarkCodes);
      const hit = focusCodes.filter((c) => bs.has(c)).length;
      fitText = `${hit}/${focusCodes.length}`;
    }
    const pm = s.pmLevels;
    const pmText = (() => {
      if (!pm) return "—";
      const fmt = (v: number | null) => (v == null ? "—" : `L${v}`);
      const parts = [
        fmt(pm.pm1),
        fmt(pm.pm2),
        fmt(pm.pm3),
      ].join("/");
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
    const overallText =
      s.overallPct != null ? `${Math.round(s.overallPct)}%` : "—";

    let x = x0;
    for (const c of cols) {
      let v = "";
      switch (c.key) {
        case "idx":
          v = String(indexOffset + i + 1);
          break;
        case "name":
          v = `${s.lastName}, ${s.firstName}`;
          break;
        case "grade":
          v = s.grade != null ? String(s.grade) : "—";
          break;
        case "fast":
          v = s.fastLevel != null ? `L${s.fastLevel}` : "—";
          break;
        case "overall":
          v = overallText;
          break;
        case "pm":
          v = pmText;
          break;
        case "flags":
          v = programFlagsLabel(s) || "—";
          break;
        case "fit":
          v = fitText;
          break;
      }
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
      doc.text(v, x + 4, y + 4, {
        width: c.w - 8,
        lineBreak: false,
        ellipsis: true,
      });
      x += c.w;
    }
    y += rowH;
  }
}
