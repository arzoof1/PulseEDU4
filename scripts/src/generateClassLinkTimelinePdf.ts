// Pulse EDU — ClassLink / OneRoster integration timeline (client PDF).
// Run: pnpm --filter @workspace/scripts launch-classlink-timeline-pdf

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "Pulse_EDU_ClassLink_Timeline.pdf");
mkdirSync(dirname(OUT), { recursive: true });

const MARGIN = 54;
const PAGE_W = 612;
const CONTENT_W = PAGE_W - MARGIN * 2;

const C = {
  ink: "#0f172a",
  sub: "#475569",
  muted: "#64748b",
  brand: "#1d4ed8",
  accent: "#0e7490",
  headerBg: "#1e3a5f",
  headerInk: "#ffffff",
  rowAlt: "#f8fafc",
  rowInk: "#0f172a",
  border: "#cbd5e1",
  totalBg: "#eff6ff",
  totalInk: "#1d4ed8",
};

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  bufferPages: true,
  info: {
    Title: "Pulse EDU — ClassLink Integration Plan",
    Author: "PulseEDU",
    Subject: "ClassLink / OneRoster integration scope and schedule",
  },
});

doc.pipe(createWriteStream(OUT));

function ensureSpace(h: number) {
  if (doc.y + h > 720) doc.addPage();
}

/** PDFKit leaves doc.x at the last absolute column after table cells — reset before flow text. */
function resetX() {
  doc.x = MARGIN;
}

function H1(t: string) {
  resetX();
  doc.fillColor(C.brand).font("Helvetica-Bold").fontSize(20).text(t, { width: CONTENT_W });
  doc.moveDown(0.2);
}

function H2(t: string) {
  ensureSpace(44);
  resetX();
  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(12).text(t, { width: CONTENT_W });
  doc.moveDown(0.12);
  const y = doc.y;
  doc.strokeColor(C.accent).lineWidth(1).moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke();
  doc.moveDown(0.3);
}

function P(t: string) {
  resetX();
  doc.fillColor(C.ink).font("Helvetica").fontSize(10).text(t, { width: CONTENT_W, lineGap: 1.4 });
  doc.moveDown(0.28);
}

function bullet(t: string) {
  resetX();
  doc
    .fillColor(C.ink)
    .font("Helvetica")
    .fontSize(10)
    .text(`•  ${t}`, { width: CONTENT_W, indent: 8, lineGap: 1.35 });
}

type TableRow = {
  work: string;
  timeframe: string;
  emphasis?: "normal" | "subtotal" | "total";
};

function drawTimelineTable(rows: TableRow[]) {
  const colWorkW = CONTENT_W * 0.68;
  const colTimeW = CONTENT_W * 0.32;
  const padX = 8;
  const padY = 7;
  const fontSize = 9.5;

  function rowHeight(work: string, timeframe: string, bold: boolean): number {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
    const workH = doc.heightOfString(work, { width: colWorkW - padX * 2 });
    const timeH = doc.heightOfString(timeframe, {
      width: colTimeW - padX * 2,
      align: "right",
    });
    return Math.max(workH, timeH) + padY * 2;
  }

  // Header
  ensureSpace(36);
  const headerH = 26;
  let y = doc.y;
  doc.rect(MARGIN, y, CONTENT_W, headerH).fill(C.headerBg);
  doc
    .fillColor(C.headerInk)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text("Work", MARGIN + padX, y + 8, { width: colWorkW - padX * 2 });
  doc.text("Timeframe", MARGIN + colWorkW + padX, y + 8, {
    width: colTimeW - padX * 2,
    align: "right",
  });
  doc.y = y + headerH;
  resetX();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const emphasis = row.emphasis ?? "normal";
    const bold = emphasis !== "normal";
    const h = rowHeight(row.work, row.timeframe, bold);

    ensureSpace(h + 4);
    y = doc.y;

    const bg =
      emphasis === "total"
        ? C.totalBg
        : emphasis === "subtotal"
          ? "#e2e8f0"
          : i % 2 === 0
            ? "#ffffff"
            : C.rowAlt;

    doc.rect(MARGIN, y, CONTENT_W, h).fill(bg);
    doc
      .strokeColor(C.border)
      .lineWidth(0.5)
      .moveTo(MARGIN, y + h)
      .lineTo(MARGIN + CONTENT_W, y + h)
      .stroke();

    const ink = emphasis === "total" ? C.totalInk : C.rowInk;
    doc.fillColor(ink).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
    doc.text(row.work, MARGIN + padX, y + padY, { width: colWorkW - padX * 2 });
    doc.text(row.timeframe, MARGIN + colWorkW + padX, y + padY, {
      width: colTimeW - padX * 2,
      align: "right",
    });

    doc.y = y + h;
  }

  resetX();
  doc.moveDown(0.35);
}

// ---------------------------------------------------------------------------
H1("Pulse EDU");
doc
  .fillColor(C.sub)
  .font("Helvetica")
  .fontSize(13)
  .text("ClassLink Integration — Scope & Schedule");
doc.moveDown(0.08);
doc
  .fontSize(10)
  .fillColor(C.muted)
  .text("Prepared for Hernando County · June 2026");
doc.moveDown(0.65);

H2("Project overview");
P(
  "Pulse EDU will connect to ClassLink using the OneRoster standard to import roster data automatically. This integration replaces manual CSV uploads for core roster information and keeps student, staff, and schedule data current through a nightly sync.",
);
P(
  "The first production rollout is planned for Hernando County. After a successful launch, additional districts that use ClassLink may be onboarded using the same integration.",
);

H2("Agreed requirements");
bullet("Data flow: ClassLink to Pulse EDU only (one-way sync).");
bullet("Initial district: Hernando County.");
bullet("Sync frequency: nightly.");
bullet("Sync failures: reported to administrators only; no notifications to classroom staff.");
bullet("ClassLink application approval: Pulse EDU will support the ClassLink App Library registration and district enablement process.");

H2("What will be delivered");
P("Upon completion, Pulse EDU will include:");
bullet("Automated import of students, staff, class sections, and enrollments (class schedules).");
bullet("Student demographic and program fields currently supported in Pulse EDU, populated from ClassLink where available.");
bullet("A nightly sync that runs without manual intervention.");
bullet("An administrator view of the last sync time, status, and any errors.");
bullet("Setup and operations documentation for district IT staff.");

P(
  "Until the integration is live, schools may continue to use the CSV Data Importer and the in-app onboarding checklist.",
);

// ---------------------------------------------------------------------------
doc.addPage();
H2("Estimated timeline");
P(
  "The table below summarizes the work involved and the expected timeframe for each phase. Development and integration on the Pulse EDU platform is planned for 1.5 weeks. The full integration, including ClassLink registration, district setup, and production use at Hernando County, is planned for 3 weeks from project start.",
);

drawTimelineTable([
  {
    work: "ClassLink / OneRoster API connection and secure authentication",
    timeframe: "Week 1",
  },
  {
    work: "Import of students, staff, and supported demographic fields",
    timeframe: "Week 1",
  },
  {
    work: "Import of class sections and student enrollments (schedules)",
    timeframe: "Week 1",
  },
  {
    work: "Nightly automated sync job",
    timeframe: "Week 1",
  },
  {
    work: "Administrator sync status and error reporting",
    timeframe: "Week 1–1.5",
  },
  {
    work: "Pulse EDU development and integration",
    timeframe: "1.5 weeks",
    emphasis: "subtotal",
  },
  {
    work: "ClassLink App Library registration and district approval",
    timeframe: "Weeks 1–2",
  },
  {
    work: "School mapping and production configuration",
    timeframe: "Week 2",
  },
  {
    work: "District review and validation with live roster data",
    timeframe: "Weeks 2–3",
  },
  {
    work: "Production go-live and handoff documentation",
    timeframe: "Week 3",
  },
  {
    work: "Full integration live in production (Hernando County)",
    timeframe: "3 weeks",
    emphasis: "total",
  },
]);

doc.addPage();

H2("Data included in the sync");
P("The nightly import will keep the following current in Pulse EDU:");
bullet("Students — identity, grade, and supported program flags (e.g. ELL, ESE, 504 where provided).");
bullet("Staff — identity and contact fields supplied by ClassLink.");
bullet("Schedules — class sections, teacher assignments, and student enrollments used by Teacher Roster and Student Finder.");

P(
  "Assessment scores, behavior logs, and other non-roster data are outside this integration and may continue to use existing import tools where applicable.",
);

H2("District participation");
bullet("Designate a district IT contact for ClassLink approval and credential handoff.");
bullet("Confirm mapping between ClassLink school organizations and Pulse EDU schools.");
bullet("Participate in review and sign-off before production cutover.");

const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(i);
  doc
    .fillColor(C.muted)
    .font("Helvetica")
    .fontSize(8)
    .text(`Page ${i + 1} of ${range.count}`, MARGIN, 738, {
      align: "center",
      width: CONTENT_W,
    });
}

doc.end();

console.log(`Wrote ${OUT}`);
