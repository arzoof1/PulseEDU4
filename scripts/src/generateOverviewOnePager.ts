// Generates PulseEDU_Overview.pdf — a single-page, share-with-anyone
// overview of PulseEDU. Designed to be handed (or emailed) to a
// principal / district leader / school board ahead of a demo.

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "attached_assets", "PulseEDU_Overview.pdf");
mkdirSync(dirname(OUT), { recursive: true });

const C = {
  ink: "#0f172a",
  inkSoft: "#475569",
  inkFaint: "#94a3b8",
  brand: "#1d4ed8",
  brandDark: "#1e3a8a",
  accent: "#0e7490",
  rule: "#cbd5e1",
  bgPanel: "#f1f5f9",
  bgBrand: "#eff6ff",
};

interface Module {
  title: string;
  blurb: string;
}

const MODULES: Module[] = [
  { title: "Hall Pass + Tardy",    blurb: "Live queue, per-teacher allowlists, period-aware auto-reset, tardy-pass creation, signage tile." },
  { title: "Digital Signage",      blurb: "Per-TV playlists: media + live tiles (house standings, hall passes, Heartbeat)." },
  { title: "PBIS Hub + Stores",    blurb: "Point tracking, Spotlight reveal, Classroom Store + school-wide School Store." },
  { title: "Safety Plans",         blurb: "Per-student behavioral / physical checklists with library, audit log, role gating." },
  { title: "MTSS Plans (T2/T3)",   blurb: "Goal setting, weekly progress monitoring, strategy categories, completion reports." },
  { title: "Parent Portal",        blurb: "Secure parent view of HeartBEAT — admin-managed invites, sibling switching, PDF export." },
  { title: "Parent Pickup",        blurb: "Curb keypad, walker gate, tag admin (bulk print + QR), 'still on campus' tile." },
  { title: "Insights Dashboards",  blurb: "Engagement, Behavior, Academics, SEB/SEL, Equity, Early Warning — with drill-down." },
  { title: "Teacher Roster",       blurb: "FAST scores, ESE/504/ELL flags, active plans, safety-plan indicators per student." },
  { title: "Data Importer",        blurb: "CSV upload → preview → commit → rollback for rosters, assessments, behavior." },
  { title: "Investigations + ISS", blurb: "Case management with statements, AI consistency check, ISS dashboard + reporting." },
  { title: "Admin + Tenancy",      blurb: "Multi-school SuperUser, district rollups, onboard-a-school wizard, feature licensing." },
];

const HIGHLIGHTS = [
  "One login replaces 6–10 single-purpose tools.",
  "Multi-tenant: every record is scoped to a school; districts roll up.",
  "Role-aware sidebar: staff only see what they're entitled to.",
  "Onboarding checklist auto-detects most setup steps.",
  "Built-in importer + rollback keeps roster data clean.",
  "Generated user guides (Teacher, Core Team, Demo) ship with the product.",
];

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 28, bottom: 28, left: 36, right: 36 },
  bufferPages: true,
  info: {
    Title: "PulseEDU — Overview",
    Author: "PulseEDU",
    Subject: "One-page feature overview for school / district leadership.",
  },
});
const stream = createWriteStream(OUT);
doc.pipe(stream);

const F_BODY = "Helvetica";
const F_BOLD = "Helvetica-Bold";
const F_OBL = "Helvetica-Oblique";

const pageW = doc.page.width;
const pageH = doc.page.height;
const ML = doc.page.margins.left;
const MR = doc.page.margins.right;
const contentW = pageW - ML - MR;

// ---------- Header band ----------
const HEADER_H = 60;
doc.save().rect(0, 0, pageW, HEADER_H).fillColor(C.brandDark).fill().restore();
doc.fillColor("#ffffff").font(F_BOLD).fontSize(28).text("PulseEDU", ML, 16);

// EKG / heartbeat line under the wordmark — a flat baseline with a
// single QRS spike, drawn to the right of the wordmark and across the
// header band. Evokes the "Pulse" in the name.
{
  const wordmarkWidth = doc.widthOfString("PulseEDU");
  const baselineY = 34;
  const startX = ML + wordmarkWidth + 14;
  const endX = pageW - MR;
  // Pre-spike flat: short dip-bump (P wave), then QRS spike, then T wave, then flat.
  const spikeStart = startX + (endX - startX) * 0.25;
  const pts: Array<[number, number]> = [
    [startX, baselineY],
    [spikeStart - 40, baselineY],
    [spikeStart - 32, baselineY - 3],   // P
    [spikeStart - 24, baselineY],
    [spikeStart - 6, baselineY + 3],    // Q
    [spikeStart, baselineY - 18],       // R (spike up)
    [spikeStart + 6, baselineY + 6],    // S
    [spikeStart + 18, baselineY],
    [spikeStart + 38, baselineY - 5],   // T
    [spikeStart + 58, baselineY],
    [endX, baselineY],
  ];
  doc.save()
    .moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) doc.lineTo(pts[i][0], pts[i][1]);
  doc.lineWidth(2).strokeColor("#7dd3fc").stroke().restore();
}

doc.fillColor("#cbd5e1").font(F_BODY).fontSize(10)
  .text("One school operations app — running every part of the building", ML, 44);

// ---------- Tagline / what is it ----------
let y = HEADER_H + 10;
doc.fillColor(C.ink).font(F_BOLD).fontSize(12).text("What it is", ML, y);
y = doc.y + 1;
doc.fillColor(C.ink).font(F_BODY).fontSize(9.8).text(
  "PulseEDU brings the day-to-day systems a K-12 school already runs — hall pass, PBIS, " +
  "safety plans, MTSS, parent communications, dismissal, digital signage, dashboards — " +
  "into one role-aware, multi-tenant platform. Schools stop juggling 6–10 single-purpose " +
  "vendors. Districts get rolled-up visibility without spreadsheet stitching.",
  ML, y, { width: contentW, align: "left" },
);
y = doc.y + 6;

// ---------- Modules grid (3 columns x 4 rows) ----------
doc.fillColor(C.ink).font(F_BOLD).fontSize(12).text("What's included", ML, y);
y = doc.y + 4;

const cols = 4;
const gutter = 6;
const cellW = (contentW - gutter * (cols - 1)) / cols;
const cellH = 58;
for (let i = 0; i < MODULES.length; i++) {
  const m = MODULES[i];
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = ML + col * (cellW + gutter);
  const cy = y + row * (cellH + gutter);

  doc.save()
    .roundedRect(x, cy, cellW, cellH, 6)
    .fillColor(C.bgBrand).fill().restore();
  doc.save()
    .roundedRect(x, cy, cellW, cellH, 6)
    .lineWidth(0.6).strokeColor(C.rule).stroke().restore();

  doc.fillColor(C.brand).font(F_BOLD).fontSize(10)
    .text(m.title, x + 8, cy + 6, { width: cellW - 16 });
  doc.fillColor(C.ink).font(F_BODY).fontSize(8.5)
    .text(m.blurb, x + 8, doc.y + 1, { width: cellW - 16 });
}
const rows = Math.ceil(MODULES.length / cols);
y = y + rows * (cellH + gutter) + 2;

// ---------- Why it matters ----------
doc.fillColor(C.ink).font(F_BOLD).fontSize(12).text("Why schools pick it", ML, y);
y = doc.y + 3;

// Two-column bullet list
const bulletCols = 2;
const bColW = (contentW - 16) / bulletCols;
const half = Math.ceil(HIGHLIGHTS.length / bulletCols);
let leftY = y;
let rightY = y;
for (let i = 0; i < HIGHLIGHTS.length; i++) {
  const inLeft = i < half;
  const cx = inLeft ? ML : ML + bColW + 16;
  const cyStart = inLeft ? leftY : rightY;
  doc.fillColor(C.brand).font(F_BOLD).fontSize(9.5).text("•", cx, cyStart, { lineBreak: false, width: 8 });
  doc.fillColor(C.ink).font(F_BODY).fontSize(9.5).text(HIGHLIGHTS[i], cx + 10, cyStart, { width: bColW - 12 });
  if (inLeft) leftY = doc.y + 1;
  else rightY = doc.y + 1;
}
y = Math.max(leftY, rightY) + 2;

// ---------- Footer band ----------
// Drop the bottom margin to 0 while drawing the footer so the wrapped
// second line never trips an implicit page break.
const FOOTER_H = 44;
const footerY = pageH - FOOTER_H;
const origBottom = doc.page.margins.bottom;
doc.page.margins.bottom = 0;
doc.save().rect(0, footerY, pageW, FOOTER_H).fillColor(C.bgPanel).fill().restore();
doc.fillColor(C.ink).font(F_BOLD).fontSize(10)
  .text("Next step", ML, footerY + 6, { lineBreak: false });
doc.fillColor(C.inkSoft).font(F_BODY).fontSize(8.5)
  .text(
    "Book a 30-minute demo. We walk Hall Pass → PBIS → Pickup → MTSS → Insights in the order that fits your building. " +
    "Onboarding finishes in two short sessions; roster import is reversible.",
    ML, footerY + 20, { width: contentW },
  );
doc.page.margins.bottom = origBottom;

// Page number is unnecessary on a one-pager — skip the footer text.

doc.end();
stream.on("finish", () => console.log(`Wrote ${OUT}`));
stream.on("error", (e) => { console.error(e); process.exit(1); });
