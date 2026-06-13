// PDF rendering of the parent HeartBEAT snapshot. Uses pdfkit, which
// produces a deterministic vector PDF without spinning up a headless
// browser. Layout intentionally mirrors the on-screen Dashboard's
// section ordering so a parent printing this can match it row-for-row
// to what they see in the app. Same gating contract as the JSON
// endpoint — the snapshot's `sectionsAvailable` is the single source of
// truth for which sections appear.

import PDFDocument from "pdfkit";
import type { ParentSnapshot } from "./parentSnapshot.js";

interface RenderOpts {
  /** Optional school display name shown in the header strip. */
  schoolName?: string;
}

const COLORS = {
  text: "#0f172a",
  muted: "#64748b",
  border: "#e2e8f0",
  accent: "#0e7490",
  accentSoft: "#ecfeff",
  positive: "#16a34a",
  negative: "#dc2626",
  warn: "#b45309",
  brandStart: "#7c3aed",
  brandMid: "#0d9488",
  brandEnd: "#16a34a",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

function gradeLabel(g: number): string {
  if (g === 0) return "Kindergarten";
  if (g < 0) return "Pre-K";
  return `Grade ${g}`;
}

export function renderSnapshotPdf(
  snapshot: ParentSnapshot,
  opts: RenderOpts = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `HeartBEAT Snapshot — ${snapshot.student.firstName} ${snapshot.student.lastName}`,
        Author: opts.schoolName ?? "PulseEDU",
        Subject: "Whole-child snapshot",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      drawDocument(doc, snapshot, opts);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawDocument(
  doc: PDFKit.PDFDocument,
  s: ParentSnapshot,
  opts: RenderOpts,
) {
  const sec = s.sectionsAvailable;

  drawHeader(doc, s, opts);
  drawIdentityStrip(doc, s);

  if (sec.recognition) drawRecognitionBlock(doc, s);
  if (sec.attendance || sec.hallPasses) drawAttendanceBlock(doc, s);
  if (sec.accommodations) drawAccommodationsBlock(doc, s);
  if (sec.fastScores) drawFastScoresBlock(doc, s);
  if (sec.mtss) drawMtssBlock(doc, s);
  if (sec.interventions) drawInterventionsBlock(doc, s);
  if (sec.staffNotes) drawStaffNotesBlock(doc, s);
  if (sec.oss) drawOssBlock(doc, s);
  if (sec.reteach) drawReteachBlock(doc, s);

  drawFooter(doc, s);
}

// ---------- Header ----------
function drawHeader(
  doc: PDFKit.PDFDocument,
  s: ParentSnapshot,
  opts: RenderOpts,
) {
  const y = doc.y;
  // Brand gradient strip
  const stripH = 4;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const w = right - left;
  // Three solid color blocks emulate the screen's gradient bar — pdfkit
  // does support gradients but solid stripes scale better when printed
  // in greyscale.
  doc.rect(left, y, w / 3, stripH).fill(COLORS.brandStart);
  doc.rect(left + w / 3, y, w / 3, stripH).fill(COLORS.brandMid);
  doc.rect(left + (2 * w) / 3, y, w / 3, stripH).fill(COLORS.brandEnd);
  doc.fillColor(COLORS.text);
  doc.y = y + stripH + 12;

  doc.fontSize(20).font("Helvetica-Bold").text("HeartBEAT Snapshot", { continued: false });
  doc.moveDown(0.15);
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor(COLORS.muted)
    .text(
      `${opts.schoolName ?? "PulseEDU"} · Generated ${fmtDate(new Date().toISOString())}`,
    );
  doc.fillColor(COLORS.text);
  doc.moveDown(0.6);
}

function drawIdentityStrip(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.y;
  const h = 56;
  doc
    .roundedRect(left, top, right - left, h, 6)
    .fillAndStroke(COLORS.accentSoft, COLORS.border);
  doc.fillColor(COLORS.text);
  doc
    .fontSize(15)
    .font("Helvetica-Bold")
    .text(`${s.student.firstName} ${s.student.lastName}`, left + 14, top + 10);
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor(COLORS.muted)
    .text(
      `${gradeLabel(s.student.grade)} · ID ${s.student.localSisId ?? "—"}`,
      left + 14,
      top + 30,
    );

  // Right-side: Tier chip + parent name
  const tier = s.mtss?.tier ?? 1;
  const chipText = `Tier ${tier}`;
  const chipW = 60;
  const chipH = 18;
  const chipX = right - 14 - chipW;
  const chipY = top + 12;
  const tierColor =
    tier === 1 ? COLORS.muted : tier === 2 ? COLORS.warn : COLORS.negative;
  doc
    .roundedRect(chipX, chipY, chipW, chipH, 9)
    .fillAndStroke("#ffffff", tierColor);
  doc
    .fillColor(tierColor)
    .fontSize(9)
    .font("Helvetica-Bold")
    .text(chipText, chipX, chipY + 4, { width: chipW, align: "center" });

  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(`For ${s.parent.displayName || s.parent.email}`, chipX - 200, top + 34, {
      width: 200,
      align: "right",
    });

  doc.y = top + h + 14;
  doc.fillColor(COLORS.text);
}

// ---------- Section frame ----------
function sectionTitle(doc: PDFKit.PDFDocument, label: string) {
  ensureSpace(doc, 60);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.moveDown(0.3);
  // Accent dot + title
  const y = doc.y;
  doc.circle(left + 4, y + 6, 3).fill(COLORS.accent);
  doc
    .fillColor(COLORS.text)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(label, left + 14, y);
  // Hairline under title
  const lineY = doc.y + 4;
  doc
    .moveTo(left, lineY)
    .lineTo(right, lineY)
    .lineWidth(0.5)
    .strokeColor(COLORS.border)
    .stroke();
  doc.y = lineY + 8;
  doc.strokeColor(COLORS.text);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

// ---------- Recognition ----------
function drawRecognitionBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Recognition (PBIS)");
  const left = doc.page.margins.left;

  // Two-stat row: total, this week
  const stats: Array<{ label: string; value: string; color: string }> = [
    { label: "Total points", value: String(s.pbis.total), color: COLORS.accent },
    {
      label: "This week",
      value: (s.pbis.thisWeek >= 0 ? "+" : "") + s.pbis.thisWeek,
      color:
        s.pbis.thisWeek > 0
          ? COLORS.positive
          : s.pbis.thisWeek < 0
            ? COLORS.negative
            : COLORS.muted,
    },
    {
      label: "Positive (7d)",
      value: String(s.pbis.weeklyCounts.positive),
      color: COLORS.positive,
    },
    {
      label: "Redirects (7d)",
      value: String(s.pbis.weeklyCounts.negative),
      color: COLORS.negative,
    },
  ];
  drawStatRow(doc, stats);

  // Mini sparkline of the last 7 days
  doc.moveDown(0.4);
  drawSparkline(doc, s.pbis.sparkline, left, 240, 28);

  // Recent points list
  if (s.pbis.recent.length === 0) {
    drawEmpty(doc, "No PBIS points recorded.");
  } else {
    doc.moveDown(0.4);
    for (const r of s.pbis.recent.slice(0, 8)) {
      ensureSpace(doc, 30);
      const sign = r.points > 0 ? "+" : "";
      const color = r.polarity === "positive" ? COLORS.positive : COLORS.negative;
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor(color)
        .text(`${sign}${r.points}`, { continued: true, width: 36 });
      doc
        .fillColor(COLORS.text)
        .font("Helvetica")
        .text(`  ${r.reason}`, { continued: true });
      doc
        .fillColor(COLORS.muted)
        .text(`   · ${r.staffName} · ${fmtDateTime(r.createdAt)}`);
      if (r.note) {
        doc.fillColor(COLORS.muted).fontSize(9).text(`     ${r.note}`);
        doc.fontSize(10);
      }
      doc.fillColor(COLORS.text);
    }
  }
}

// ---------- Attendance / Hall passes ----------
function drawAttendanceBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Attendance & Hall Passes");
  const stats: Array<{ label: string; value: string; color: string }> = [];
  if (s.sectionsAvailable.attendance) {
    stats.push({
      label: "Tardies (this wk)",
      value: String(s.attendance.tardiesThisWeek),
      color: s.attendance.tardiesThisWeek === 0 ? COLORS.positive : COLORS.warn,
    });
    stats.push({
      label: "Check-ins (this wk)",
      value: String(s.attendance.checkInsThisWeek),
      color: COLORS.muted,
    });
    // Aggregate attendance metrics mirroring the parent Dashboard.
    // Render dashes when the school hasn't loaded any attendance-day
    // data yet so the PDF doesn't pretend to know a 0% rate.
    stats.push({
      label: "Attendance (YTD)",
      value: s.attendance.pct.ytd ? `${s.attendance.pct.ytd.pct}%` : "—",
      color: COLORS.accent,
    });
    stats.push({
      label: "Attendance (30d)",
      value: s.attendance.pct.last30 ? `${s.attendance.pct.last30.pct}%` : "—",
      color: COLORS.accent,
    });
    // Period-level on-time streak — only when the school has a default
    // bell schedule configured (otherwise `onTimeStreak` is null and we
    // skip the streak tiles entirely, matching the parent dashboard).
    if (s.attendance.onTimeStreak) {
      stats.push({
        label: "On-time streak",
        value: `${s.attendance.onTimeStreak.current} pds`,
        color: COLORS.positive,
      });
      stats.push({
        label: "Longest (YTD)",
        value: `${s.attendance.onTimeStreak.longestYtd} pds`,
        color: COLORS.positive,
      });
      stats.push({
        label: "On-time % (YTD)",
        value:
          s.attendance.onTimeStreak.pctYtd != null
            ? `${s.attendance.onTimeStreak.pctYtd}%`
            : "—",
        color: COLORS.positive,
      });
    }
    // Kiosk On-Time Attendance arrivals — only when the student has
    // door-kiosk check-ins this school year (otherwise the block is null).
    if (s.attendance.onTimeArrivals && s.attendance.onTimeArrivals.checkinCount > 0) {
      stats.push({
        label: "On-time arrivals",
        value:
          s.attendance.onTimeArrivals.ratePct != null
            ? `${s.attendance.onTimeArrivals.ratePct}%`
            : "—",
        color: COLORS.positive,
      });
      if (s.attendance.onTimeArrivals.lotteryWins > 0) {
        stats.push({
          label: "Lottery wins",
          value: String(s.attendance.onTimeArrivals.lotteryWins),
          color: COLORS.accent,
        });
      }
    }
  }
  if (s.sectionsAvailable.hallPasses) {
    stats.push({
      label: "Hall passes (this wk)",
      value: String(s.hallPasses.thisWeekCount),
      color: COLORS.accent,
    });
  }
  drawStatRow(doc, stats);

  if (s.sectionsAvailable.attendance && s.attendance.recent.length > 0) {
    doc.moveDown(0.4);
    doc.fontSize(10).font("Helvetica-Bold").fillColor(COLORS.text).text("Recent attendance");
    doc.moveDown(0.2);
    for (const r of s.attendance.recent.slice(0, 6)) {
      ensureSpace(doc, 18);
      const label = r.entryType === "tardy" ? "Tardy" : r.entryType === "checkin" ? "Check-in" : "Check-out";
      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor(COLORS.text)
        .text(`${label}`, { continued: true })
        .fillColor(COLORS.muted)
        .text(`  ${r.period || "—"} · ${r.teacherName} · ${fmtDateTime(r.createdAt)}`);
      if (r.reason) {
        doc.fillColor(COLORS.muted).fontSize(9).text(`     ${r.reason}`);
        doc.fontSize(10);
      }
    }
    doc.fillColor(COLORS.text);
  }

  if (s.sectionsAvailable.hallPasses && s.hallPasses.recent.length > 0) {
    doc.moveDown(0.4);
    doc.fontSize(10).font("Helvetica-Bold").fillColor(COLORS.text).text("Recent hall passes");
    doc.moveDown(0.2);
    for (const r of s.hallPasses.recent.slice(0, 6)) {
      ensureSpace(doc, 18);
      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor(COLORS.text)
        .text(r.destination, { continued: true })
        .fillColor(COLORS.muted)
        .text(`  from ${r.originRoom} · ${r.teacherName} · ${fmtDateTime(r.createdAt)}`);
    }
    doc.fillColor(COLORS.text);
  }
}

// ---------- Accommodations ----------
function drawAccommodationsBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Accommodations");
  if (s.accommodations.length === 0) {
    drawEmpty(doc, "No active accommodations on file.");
    return;
  }
  for (const a of s.accommodations) {
    ensureSpace(doc, 16);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor(COLORS.text)
      .text(a.name, { continued: true })
      .font("Helvetica")
      .fillColor(COLORS.muted)
      .text(`  · ${a.category}`);
  }
  doc.fillColor(COLORS.text);
}

// ---------- FAST scores ----------
function drawFastScoresBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "FAST Progress Monitoring");
  if (s.fastScores.length === 0) {
    drawEmpty(doc, "No FAST results yet.");
    return;
  }
  // Mini table: Subject | PM1 | PM2 | PM3 | Prior year
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const colW = (right - left) / 5;
  const rowY = doc.y;
  ensureSpace(doc, 16 + 16 * (s.fastScores.length + 1));

  doc.fontSize(10).font("Helvetica-Bold").fillColor(COLORS.muted);
  ["Subject", "PM1", "PM2", "PM3", "Prior yr"].forEach((h, i) => {
    doc.text(h, left + colW * i, rowY, { width: colW - 8 });
  });
  let y = rowY + 16;
  doc
    .moveTo(left, y - 2)
    .lineTo(right, y - 2)
    .lineWidth(0.5)
    .strokeColor(COLORS.border)
    .stroke();

  doc.font("Helvetica").fillColor(COLORS.text);
  for (const r of s.fastScores) {
    const subj = r.subject.toUpperCase();
    const cells = [
      subj,
      r.pm1 == null ? "—" : String(r.pm1),
      r.pm2 == null ? "—" : String(r.pm2),
      r.pm3 == null ? "—" : String(r.pm3),
      r.priorYearScore == null
        ? "—"
        : `${r.priorYearScore}${r.priorYearBq ? " · BQ" : ""}`,
    ];
    cells.forEach((c, i) => {
      doc.text(c, left + colW * i, y, { width: colW - 8 });
    });
    y += 16;
  }
  doc.y = y + 4;
}

// ---------- MTSS ----------
function drawMtssBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Active MTSS Plans");
  if (!s.mtss || s.mtss.plans.length === 0) {
    drawEmpty(doc, "No active multi-tiered support plans.");
    return;
  }
  for (const p of s.mtss.plans) {
    ensureSpace(doc, 40);
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .fillColor(COLORS.text)
      .text(p.title, { continued: true })
      .fillColor(COLORS.muted)
      .font("Helvetica")
      .fontSize(10)
      .text(`   · Tier ${p.tier} · opened ${fmtDate(p.openedAt)}`);
    if (p.goals) {
      doc.fontSize(10).fillColor(COLORS.text).text(p.goals, {
        indent: 10,
        align: "left",
      });
    }
    doc.moveDown(0.3);
  }
  doc.fillColor(COLORS.text);
}

// ---------- Interventions ----------
function drawInterventionsBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Recent Interventions");
  if (s.interventions.length === 0) {
    drawEmpty(doc, "No interventions logged.");
    return;
  }
  for (const i of s.interventions) {
    ensureSpace(doc, 24);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor(COLORS.text)
      .text(i.interventionType, { continued: true })
      .fillColor(COLORS.muted)
      .font("Helvetica")
      .text(`   · ${i.staffName} · ${fmtDateTime(i.createdAt)}`);
    if (i.note) {
      doc.fillColor(COLORS.muted).fontSize(9).text(`   ${i.note}`);
      doc.fontSize(10);
    }
    doc.fillColor(COLORS.text);
  }
}

// ---------- Staff notes ----------
function drawStaffNotesBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Staff Notes");
  if (s.staffNotes.length === 0) {
    drawEmpty(doc, "No staff notes.");
    return;
  }
  for (const n of s.staffNotes.slice(0, 10)) {
    ensureSpace(doc, 30);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor(COLORS.accent)
      .text(n.noteType, { continued: true })
      .fillColor(COLORS.muted)
      .font("Helvetica")
      .text(`   · ${n.staffName} · ${fmtDateTime(n.createdAt)}`);
    doc.fillColor(COLORS.text).fontSize(10).text(n.noteText, { indent: 0 });
    doc.moveDown(0.3);
  }
}

// ---------- OSS (out-of-school suspension) ----------
// Renders the year-to-date day count plus the most recent assigned days.
// Reason / notes are only present in the snapshot when the school enabled
// `showOssReason`; we surface them whenever they exist on the row so
// upstream gating stays the single source of truth.
function drawOssBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Out-of-School Suspension (OSS)");
  drawStatRow(doc, [
    {
      label: "Days this school year",
      value: String(s.oss.daysThisYear),
      color: s.oss.daysThisYear === 0 ? COLORS.positive : COLORS.warn,
    },
  ]);
  if (s.oss.recent.length === 0) {
    drawEmpty(doc, "No OSS days on file this school year.");
    return;
  }
  doc.moveDown(0.4);
  doc.fontSize(10).font("Helvetica-Bold").fillColor(COLORS.text).text("Recent OSS days");
  doc.moveDown(0.2);
  for (const r of s.oss.recent) {
    ensureSpace(doc, 18);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor(COLORS.text)
      .text(r.day, { continued: !!r.reason })
      .font("Helvetica")
      .fillColor(COLORS.muted);
    if (r.reason) {
      doc.text(`   · ${r.reason}`);
    }
    if (r.notes) {
      doc.fillColor(COLORS.muted).fontSize(9).text(`     ${r.notes}`);
      doc.fontSize(10);
    }
  }
  doc.fillColor(COLORS.text);
}

// ---------- Reteach (extra support) ----------
// Counts-only rollup. Teacher notes / strategy are not in the payload
// and never rendered here. Each row is one benchmark code with 1:1 +
// small-group counts.
function drawReteachBlock(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  sectionTitle(doc, "Extra Support — Focused Reteach");
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor(COLORS.muted)
    .text(
      "In addition to regular classroom lessons, your child's teachers have provided extra focused practice on the standards below. Counts are for this school year.",
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
    );
  doc.fillColor(COLORS.text);
  doc.moveDown(0.4);

  const items = s.reteach?.items ?? [];
  if (items.length === 0) {
    drawEmpty(doc, "No focused reteach logged this school year.");
    return;
  }
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const colW = (right - left) / 4;
  const headerY = doc.y;
  doc.fontSize(10).font("Helvetica-Bold").fillColor(COLORS.muted);
  ["Benchmark", "1:1", "Small group", "Most recent"].forEach((h, i) => {
    doc.text(h, left + colW * i, headerY, { width: colW - 8 });
  });
  let y = headerY + 16;
  doc
    .moveTo(left, y - 2)
    .lineTo(right, y - 2)
    .lineWidth(0.5)
    .strokeColor(COLORS.border)
    .stroke();

  doc.font("Helvetica").fillColor(COLORS.text);
  for (const r of items) {
    ensureSpace(doc, 18);
    const cells = [
      r.benchmarkCode,
      String(r.oneOnOne),
      String(r.smallGroup),
      fmtDate(r.lastAt),
    ];
    cells.forEach((c, i) => {
      doc.text(c, left + colW * i, y, { width: colW - 8 });
    });
    y += 16;
  }
  doc.y = y + 4;
}

// ---------- Footer ----------
function drawFooter(doc: PDFKit.PDFDocument, s: ParentSnapshot) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom + 24;
    doc
      .fontSize(8)
      .fillColor(COLORS.muted)
      .font("Helvetica")
      .text(
        `Confidential — for ${s.parent.displayName || s.parent.email}. Sections you've hidden in your preferences are excluded from this report.`,
        left,
        y,
        { width: right - left - 60 },
      );
    doc.text(`Page ${i + 1} of ${range.count}`, right - 60, y, {
      width: 60,
      align: "right",
    });
    doc.fillColor(COLORS.text);
  }
}

// ---------- Helpers ----------
function drawStatRow(
  doc: PDFKit.PDFDocument,
  stats: Array<{ label: string; value: string; color: string }>,
) {
  if (stats.length === 0) return;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.y;
  const w = right - left;
  const colW = w / stats.length;
  const h = 44;
  for (let i = 0; i < stats.length; i++) {
    const x = left + i * colW;
    doc
      .roundedRect(x + 2, top, colW - 4, h, 6)
      .lineWidth(0.5)
      .strokeColor(COLORS.border)
      .stroke();
    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .fillColor(stats[i].color)
      .text(stats[i].value, x + 10, top + 6, { width: colW - 20 });
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor(COLORS.muted)
      .text(stats[i].label, x + 10, top + 27, { width: colW - 20 });
  }
  doc.y = top + h + 6;
  doc.fillColor(COLORS.text);
  doc.strokeColor(COLORS.text);
}

function drawSparkline(
  doc: PDFKit.PDFDocument,
  values: number[],
  x: number,
  width: number,
  height: number,
) {
  if (values.length === 0) return;
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const barW = (width - (values.length - 1) * 2) / values.length;
  const baseY = doc.y + height;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const h = (Math.abs(v) / max) * (height - 2);
    const bx = x + i * (barW + 2);
    const by = baseY - h;
    doc
      .rect(bx, by, barW, h)
      .fillColor(v >= 0 ? COLORS.positive : COLORS.negative)
      .fill();
  }
  doc.y = baseY + 4;
  doc.fillColor(COLORS.text);
  doc
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text("Last 7 days · PBIS net points", x, doc.y);
  doc.fillColor(COLORS.text);
  doc.moveDown(0.2);
}

function drawEmpty(doc: PDFKit.PDFDocument, text: string) {
  doc
    .fontSize(10)
    .font("Helvetica-Oblique")
    .fillColor(COLORS.muted)
    .text(text);
  doc.fillColor(COLORS.text).font("Helvetica");
}
