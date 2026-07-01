// Generates PulseEDU_Migration_2026-07-01.pdf — a developer hand-off / migration
// document describing every change made on 2026-07-01 and exactly what is needed
// to promote them to LIVE (production). Content is inline so the whole spec lives
// in one file. Layout uses flowing text with measured code/callout blocks.

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(
  HERE,
  "..",
  "..",
  "exports",
  "PulseEDU_Migration_2026-07-01.pdf",
);
mkdirSync(dirname(OUT), { recursive: true });

const C = {
  ink: "#0f172a",
  soft: "#475569",
  faint: "#94a3b8",
  brand: "#1d4ed8",
  accent: "#0e7490",
  rule: "#cbd5e1",
  panel: "#f1f5f9",
  code: "#0b1220",
  codeText: "#e2e8f0",
  warnBg: "#fef3c7",
  warnInk: "#92400e",
  okBg: "#dcfce7",
  okInk: "#166534",
  dangerBg: "#fee2e2",
  dangerInk: "#991b1b",
};

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 64, bottom: 64, left: 64, right: 64 },
  bufferPages: true,
  info: {
    Title: "PulseEDU — Production Migration (2026-07-01)",
    Author: "PulseEDU Engineering",
    Subject: "Deploy-to-LIVE hand-off for changes made on 2026-07-01",
  },
});
doc.pipe(createWriteStream(OUT));

const L = doc.page.margins.left;
const R = doc.page.width - doc.page.margins.right;
const W = R - L;
const BOTTOM = doc.page.height - doc.page.margins.bottom;

function ensure(space: number) {
  if (doc.y + space > BOTTOM) doc.addPage();
}

function h1(text: string) {
  ensure(60);
  doc.moveDown(0.4);
  doc
    .fillColor(C.brand)
    .font("Helvetica-Bold")
    .fontSize(19)
    .text(text, L, doc.y, { width: W });
  doc.moveTo(L, doc.y + 4).lineTo(R, doc.y + 4).lineWidth(1.5).strokeColor(C.brand).stroke();
  doc.moveDown(0.8);
}

function h2(text: string) {
  ensure(40);
  doc.moveDown(0.4);
  doc
    .fillColor(C.accent)
    .font("Helvetica-Bold")
    .fontSize(13.5)
    .text(text, L, doc.y, { width: W });
  doc.moveDown(0.35);
}

function h3(text: string) {
  ensure(30);
  doc
    .fillColor(C.ink)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(text, L, doc.y, { width: W });
  doc.moveDown(0.2);
}

function para(text: string, opts: { color?: string; size?: number } = {}) {
  doc
    .fillColor(opts.color ?? C.soft)
    .font("Helvetica")
    .fontSize(opts.size ?? 10)
    .text(text, L, doc.y, { width: W, align: "left", lineGap: 1.5 });
  doc.moveDown(0.5);
}

function bullets(items: string[], indent = 0) {
  const x = L + 14 + indent;
  const bw = W - 14 - indent;
  doc.font("Helvetica").fontSize(10).fillColor(C.soft);
  for (const it of items) {
    const hgt = doc.heightOfString(it, { width: bw, lineGap: 1.5 });
    ensure(hgt + 4);
    const y = doc.y;
    doc.fillColor(C.brand).font("Helvetica-Bold").text("\u2022", L + indent, y, { width: 12 });
    doc.fillColor(C.soft).font("Helvetica").text(it, x, y, { width: bw, lineGap: 1.5 });
    doc.moveDown(0.25);
  }
  doc.moveDown(0.3);
}

function codeBlock(lines: string[]) {
  const pad = 10;
  const fs = 8.6;
  doc.font("Courier").fontSize(fs);
  const lineH = doc.currentLineHeight() + 1.5;
  const boxH = pad * 2 + lines.length * lineH;
  ensure(boxH + 8);
  const top = doc.y;
  doc.roundedRect(L, top, W, boxH, 5).fill(C.code);
  let y = top + pad;
  for (const ln of lines) {
    doc.fillColor(C.codeText).font("Courier").fontSize(fs).text(ln, L + pad, y, {
      width: W - pad * 2,
      lineBreak: false,
    });
    y += lineH;
  }
  doc.y = top + boxH;
  doc.moveDown(0.6);
}

function callout(kind: "warn" | "ok" | "danger", title: string, body: string) {
  const bg = kind === "warn" ? C.warnBg : kind === "ok" ? C.okBg : C.dangerBg;
  const ink = kind === "warn" ? C.warnInk : kind === "ok" ? C.okInk : C.dangerInk;
  const pad = 10;
  doc.font("Helvetica-Bold").fontSize(10);
  const th = doc.heightOfString(title, { width: W - pad * 2 });
  doc.font("Helvetica").fontSize(9.5);
  const bh = doc.heightOfString(body, { width: W - pad * 2, lineGap: 1.5 });
  const boxH = pad * 2 + th + 4 + bh;
  ensure(boxH + 8);
  const top = doc.y;
  doc.roundedRect(L, top, W, boxH, 5).fill(bg);
  doc.roundedRect(L, top, 4, boxH, 2).fill(ink);
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(10).text(title, L + pad, top + pad, {
    width: W - pad * 2,
  });
  doc.fillColor(ink).font("Helvetica").fontSize(9.5).text(body, L + pad, doc.y + 3, {
    width: W - pad * 2,
    lineGap: 1.5,
  });
  doc.y = top + boxH;
  doc.moveDown(0.7);
}

function table(headers: string[], rows: string[][], widths: number[]) {
  const totalW = widths.reduce((a, b) => a + b, 0);
  const scale = W / totalW;
  const cols = widths.map((w) => w * scale);
  const pad = 6;

  function drawRow(cells: string[], isHead: boolean) {
    doc.font(isHead ? "Helvetica-Bold" : "Helvetica").fontSize(isHead ? 9 : 8.8);
    let maxH = 0;
    const heights = cells.map((c, i) =>
      doc.heightOfString(c, { width: cols[i] - pad * 2, lineGap: 1 }),
    );
    maxH = Math.max(...heights) + pad * 2;
    ensure(maxH + 2);
    const top = doc.y;
    if (isHead) doc.rect(L, top, W, maxH).fill(C.brand);
    else doc.rect(L, top, W, maxH).fill("#ffffff").rect(L, top, W, maxH).lineWidth(0.5).strokeColor(C.rule).stroke();
    let x = L;
    for (let i = 0; i < cells.length; i++) {
      doc
        .fillColor(isHead ? "#ffffff" : C.ink)
        .font(isHead ? "Helvetica-Bold" : "Helvetica")
        .fontSize(isHead ? 9 : 8.8)
        .text(cells[i], x + pad, top + pad, { width: cols[i] - pad * 2, lineGap: 1 });
      x += cols[i];
    }
    doc.y = top + maxH;
  }

  drawRow(headers, true);
  for (const r of rows) drawRow(r, false);
  doc.moveDown(0.7);
}

// ---------------------------------------------------------------- COVER
doc.rect(0, 0, doc.page.width, 150).fill(C.brand);
doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26).text("PulseEDU", L, 44);
doc
  .fillColor("#dbeafe")
  .font("Helvetica")
  .fontSize(13)
  .text("Production Migration & Developer Hand-off", L, 82);
doc.fillColor("#bfdbfe").fontSize(10).text("Changes dated 2026-07-01  \u2022  promote to LIVE", L, 104);
doc.y = 172;

para(
  "This document describes every change committed on July 1, 2026 and the exact steps required to promote them to the LIVE (production) environment. It is written for the developer performing the deployment.",
  { color: C.ink, size: 10.5 },
);

callout(
  "ok",
  "Bottom line",
  "Today's work is CODE + ONE additive schema change. There is exactly one database migration: four new boolean columns on the staff table (all NOT NULL DEFAULT false). No new environment variables, no new dependencies, no data backfill required. The demo attendance data seeded in development must NOT be copied to production.",
);

table(
  ["Item", "Value"],
  [
    ["Commit range", "f3c6fb44 (baseline, 2026-06-30)  \u2192  f33768b8 (HEAD)"],
    ["Commits today", "23"],
    ["Schema migrations", "1 (additive \u2014 4 columns on staff)"],
    ["New API endpoints", "1 (read-only)"],
    ["New env vars", "None"],
    ["New dependencies", "None"],
    ["Codegen / OpenAPI changes", "None"],
    ["Downtime required", "None (additive, backward compatible)"],
  ],
  [26, 74],
);

// ---------------------------------------------------------------- SUMMARY
h1("1. What shipped today");

h2("A. Delegable Data Importers  (the only feature with a schema change)");
para(
  "Four independently-assignable staff capabilities let an Admin (or Core Team) hand a single data importer to a non-admin clerk without granting the rest of the admin surface. Enforcement is server-side at every import route; the client filtering is UX only and is intentionally bypassable-proof on the server.",
);
bullets([
  "New staff caps: cap_import_grades, cap_import_attendance, cap_import_fast, cap_import_iready (all default false = today's admin-only behavior).",
  "Server gates added in scope.ts (canImportKind / requireAttendanceImporter / allowedSchoolImportKinds) and enforced in dataImports.ts and eligibility.ts.",
  "adminStaff.ts lets Core Team into GET/PATCH staff but strips PATCH to ONLY the 4 import caps for non-full-authority actors (anti-privilege-escalation guard).",
  "auth.ts /me payload now returns the 4 caps so the client can render the delegated Data Imports page and the import-only roles matrix.",
  "Client: DataImports.tsx, EligibilityHub.tsx, StaffRolesMatrix.tsx, App.tsx (new Data Imports nav section for non-admin holders).",
  "Scope: SCHOOL-scoped only. District-wide (-district) imports remain District Admin / SuperUser.",
]);

h2("B. Header / Account Menu redesign");
para(
  "The top header was reworked to consolidate secondary user controls into a single account dropdown, add a page title, and fix responsive clipping/wrapping. Pure client + CSS; no server or DB impact.",
);
bullets([
  "New component: artifacts/client/src/components/AccountMenu.tsx.",
  "Edited: App.tsx (header layout), index.css (styles, kebab/menu icon color aligned to the school primary color).",
]);

h2("C. Student attendance on whole-child surfaces");
para(
  "Attendance (days absent) is now surfaced on the Student Profile and in the Family Communication Student Daily Summary. Read-only; sourced from the existing eligibility_absences upload via the shared attendance-metrics helper. No schema change.",
);
bullets([
  "New read-only endpoint: GET /api/insights/students/:studentId/attendance (school-scoped, visibility-gated).",
  "Edited: insights.ts (endpoint + radar/flow attendance source), StudentProfile.tsx, App.tsx (Family Communication summary line).",
]);

h2("D. Sidebar navigation reset on re-click");
para(
  "Clicking a left-sidebar section while already on it now returns that section to its home view (resets sub-navigation/drill-down). Pure client.",
);
bullets([
  "Edited: App.tsx (navHomeTick + handleNavClick + keyed <main> remount + Spotlight button), index.css.",
]);

h2("E. Development-only demo data  (DO NOT migrate)");
callout(
  "danger",
  "Do NOT copy demo attendance data to production",
  "Commits cc5a4a7a and dba474ef seeded synthetic attendance for the 2025-2026 year into the DEVELOPMENT database (and added sample .xlsx files under attached_assets/ and exports/). These are for demo only. Production attendance must come from a real Eligibility Hub attendance upload. Do not run the seeding SQL/scripts against prod, and do not import the sample spreadsheets into prod.",
);

// ---------------------------------------------------------------- DB
h1("2. Database migration (required)");
para(
  "Exactly one additive migration. Four boolean columns are added to the staff table. All are NOT NULL with DEFAULT false, so existing rows are populated automatically and the change is fully backward compatible \u2014 older code simply ignores the columns.",
);

table(
  ["Column", "Type", "Constraint", "Meaning"],
  [
    ["cap_import_grades", "boolean", "NOT NULL DEFAULT false", "Delegate the Gradebook / Current Grades importer"],
    ["cap_import_attendance", "boolean", "NOT NULL DEFAULT false", "Delegate the Eligibility attendance upload"],
    ["cap_import_fast", "boolean", "NOT NULL DEFAULT false", "Delegate FAST importers (florida / scores / prior-year)"],
    ["cap_import_iready", "boolean", "NOT NULL DEFAULT false", "Delegate generic assessments importer (iReady / SCI / MAP)"],
  ],
  [30, 14, 26, 44],
);

h2("Recommended: idempotent ALTER TABLE (run against the PROD database)");
para(
  "This repo's convention for additive schema changes is direct ALTER TABLE ... IF NOT EXISTS, because drizzle-kit push can block on interactive rename prompts. The statements below are idempotent and safe to run more than once. Run them against the PRODUCTION database before (or as part of) the deploy.",
);
codeBlock([
  "ALTER TABLE staff",
  "  ADD COLUMN IF NOT EXISTS cap_import_grades      boolean NOT NULL DEFAULT false;",
  "ALTER TABLE staff",
  "  ADD COLUMN IF NOT EXISTS cap_import_attendance  boolean NOT NULL DEFAULT false;",
  "ALTER TABLE staff",
  "  ADD COLUMN IF NOT EXISTS cap_import_fast        boolean NOT NULL DEFAULT false;",
  "ALTER TABLE staff",
  "  ADD COLUMN IF NOT EXISTS cap_import_iready      boolean NOT NULL DEFAULT false;",
]);

h2("Alternative: drizzle-kit push");
para(
  "The schema source of truth (lib/db/src/schema/staff.ts) already defines these columns. If your prod workflow uses drizzle-kit push, it will detect and add them. Only use this if your process is non-interactive; watch for rename prompts.",
);
codeBlock(["pnpm --filter @workspace/db run push"]);

callout(
  "warn",
  "Production DB is separate",
  "The published production app runs against its own database, distinct from the development workspace. The four columns exist in DEV already; you must apply the migration to the PROD database explicitly. Verify with the query in section 4 after applying.",
);

// ---------------------------------------------------------------- API
h1("3. API, environment & dependencies");

h3("New API endpoint (read-only, additive)");
bullets([
  "GET /api/insights/students/:studentId/attendance \u2014 returns days-absent metrics for one student. School-scoped and visibility-gated; safe to deploy with no config.",
]);

h3("Environment variables");
para("None added or changed today. No action required.");

h3("Dependencies");
para(
  "No new packages. package.json / lockfile for the app artifacts are unchanged by today's work. A standard install during the build is sufficient.",
);

h3("Codegen / OpenAPI");
para(
  "No OpenAPI spec changes today (the new attendance endpoint is consumed via the existing authenticated fetch helper, not generated hooks). No codegen step is required, though a full build regenerates nothing new.",
);

// ---------------------------------------------------------------- DEPLOY
h1("4. Deployment procedure");

h3("Step 1 \u2014 Get the code");
para("Ensure production is building from HEAD (commit f33768b8), which includes the full range f3c6fb44..f33768b8.");

h3("Step 2 \u2014 Apply the database migration");
para("Run the ALTER TABLE statements from section 2 against the PRODUCTION database (or run drizzle-kit push if your process is non-interactive).");

h3("Step 3 \u2014 Typecheck & build");
codeBlock([
  "pnpm install",
  "pnpm run typecheck   # full monorepo typecheck",
  "pnpm run build       # typecheck + build all packages",
]);

h3("Step 4 \u2014 Publish");
para(
  "Deploy via the normal Replit publish flow. Because the schema change is additive and default-valued, the order of Step 2 vs Step 4 is not fragile, but applying the migration first is recommended.",
);

h3("Step 5 \u2014 Verify the migration landed (read-only check)");
codeBlock([
  "SELECT column_name, data_type, is_nullable, column_default",
  "FROM information_schema.columns",
  "WHERE table_name = 'staff'",
  "  AND column_name IN (",
  "    'cap_import_grades','cap_import_attendance',",
  "    'cap_import_fast','cap_import_iready'",
  "  )",
  "ORDER BY column_name;",
]);
para("Expect four rows, all boolean, is_nullable = NO, column_default = false.");

// ---------------------------------------------------------------- SMOKE
h1("5. Post-deploy smoke tests");
bullets([
  "Data Imports delegation: as an Admin, grant one import cap to a non-admin staff member via Staff & Roles; confirm that user sees ONLY the matching importer and cannot access others. Confirm a user with no caps still cannot import.",
  "Anti-escalation: confirm a Core Team (non-full-authority) actor editing staff can toggle ONLY the 4 import caps and nothing else.",
  "Header / Account Menu: confirm the account dropdown opens, all previous controls are reachable, and the header does not clip/wrap on desktop and mobile widths.",
  "Student attendance: open a Student Profile for a student who has an Eligibility attendance upload; confirm days-absent shows. Confirm the Family Communication Daily Summary shows the same figure. (No upload = no number, which is expected.)",
  "Sidebar reset: drill into a section (e.g. Settings \u2192 a tile), click the same sidebar item again, confirm it returns to the section home. Spot-check Spotlight too.",
]);

// ---------------------------------------------------------------- ROLLBACK
h1("6. Rollback plan");
bullets([
  "Code: redeploy the previous production build (baseline commit f3c6fb44). The four new columns are additive and default false, so the older code ignores them \u2014 no DB rollback is required to revert code.",
  "Database (optional, usually unnecessary): the columns are harmless to leave in place. Only if you must fully revert the schema, drop them \u2014 this is destructive to any caps already assigned:",
]);
codeBlock([
  "ALTER TABLE staff DROP COLUMN IF EXISTS cap_import_grades;",
  "ALTER TABLE staff DROP COLUMN IF EXISTS cap_import_attendance;",
  "ALTER TABLE staff DROP COLUMN IF EXISTS cap_import_fast;",
  "ALTER TABLE staff DROP COLUMN IF EXISTS cap_import_iready;",
]);

// ---------------------------------------------------------------- APPENDIX
h1("Appendix A \u2014 Files changed today");
para("Application source (excludes screenshots, sample spreadsheets, memory notes, and this document):", { size: 9.5 });
table(
  ["File", "Area"],
  [
    ["lib/db/src/schema/staff.ts", "SCHEMA \u2014 4 new import-cap columns"],
    ["artifacts/api-server/src/lib/scope.ts", "Server \u2014 import authorization helpers"],
    ["artifacts/api-server/src/routes/adminStaff.ts", "Server \u2014 Core Team staff PATCH field-strip"],
    ["artifacts/api-server/src/routes/dataImports.ts", "Server \u2014 per-kind import gating"],
    ["artifacts/api-server/src/routes/eligibility.ts", "Server \u2014 attendance-importer gate + sample download"],
    ["artifacts/api-server/src/routes/insights.ts", "Server \u2014 student attendance endpoint + radar source"],
    ["artifacts/api-server/src/routes/auth.ts", "Server \u2014 /me returns the 4 caps"],
    ["artifacts/client/src/App.tsx", "Client \u2014 header, Data Imports nav, sidebar reset, family comm"],
    ["artifacts/client/src/components/AccountMenu.tsx", "Client \u2014 new account dropdown"],
    ["artifacts/client/src/components/DataImports.tsx", "Client \u2014 delegated importer wizard"],
    ["artifacts/client/src/components/EligibilityHub.tsx", "Client \u2014 activity mgmt + attendance upload UX"],
    ["artifacts/client/src/components/StaffRolesMatrix.tsx", "Client \u2014 import-only roles mode"],
    ["artifacts/client/src/components/StudentProfile.tsx", "Client \u2014 days-absent display"],
    ["artifacts/client/src/index.css", "Client \u2014 header/menu/nav styles"],
  ],
  [52, 48],
);

para(
  "Not for production: attached_assets/*.png (screenshots), attached_assets/*.xlsx and exports/Attendance_25-26_Parrott_Seeded.xlsx (demo spreadsheets), and .agents/memory/*.md (engineering notes).",
  { size: 9, color: C.faint },
);

// ---------------------------------------------------------------- FOOTERS
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  const y = doc.page.height - 42;
  doc
    .fillColor(C.faint)
    .font("Helvetica")
    .fontSize(8)
    .text(
      "PulseEDU \u2014 Production Migration \u2014 2026-07-01",
      L,
      y,
      { width: W / 2, align: "left" },
    );
  doc.text(`Page ${i + 1} of ${range.count}`, L + W / 2, y, {
    width: W / 2,
    align: "right",
  });
}

doc.end();
console.log("Wrote", OUT);
