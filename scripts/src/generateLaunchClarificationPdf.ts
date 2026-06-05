// Pulse EDU — Final Development Clarification Answers (client PDF).
// Run: pnpm --filter @workspace/scripts exec tsx ./src/generateLaunchClarificationPdf.ts

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(
  HERE,
  "..",
  "..",
  "Pulse_EDU_Launch_Clarification_Answers.pdf",
);
mkdirSync(dirname(OUT), { recursive: true });

const C = {
  ink: "#0f172a",
  sub: "#475569",
  muted: "#94a3b8",
  rule: "#e2e8f0",
  brand: "#1d4ed8",
  accent: "#0e7490",
  warn: "#b45309",
  warnBg: "#fffbeb",
  ok: "#15803d",
  panel: "#f8fafc",
};

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 54, bottom: 54, left: 54, right: 54 },
  bufferPages: true,
  info: {
    Title: "Pulse EDU — Launch Clarification Answers",
    Author: "PulseEDU Development",
    Subject: "Pre-launch developer responses",
  },
});

doc.pipe(createWriteStream(OUT));

function ensureSpace(h: number) {
  if (doc.y + h > 720) doc.addPage();
}

function H1(t: string) {
  doc.fillColor(C.brand).font("Helvetica-Bold").fontSize(20).text(t);
  doc.moveDown(0.25);
}

function H2(t: string) {
  ensureSpace(52);
  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(13).text(t);
  doc.moveDown(0.15);
  const y = doc.y;
  doc.strokeColor(C.accent).lineWidth(1).moveTo(54, y).lineTo(558, y).stroke();
  doc.moveDown(0.35);
}

function H3(t: string) {
  ensureSpace(36);
  doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(10.5).text(t);
  doc.moveDown(0.12);
}

function P(t: string, opts: { gap?: number; color?: string; size?: number } = {}) {
  doc
    .fillColor(opts.color ?? C.ink)
    .font("Helvetica")
    .fontSize(opts.size ?? 9.5)
    .text(t, { lineGap: 1.4 });
  doc.moveDown(opts.gap ?? 0.28);
}

function bullet(t: string) {
  doc
    .fillColor(C.ink)
    .font("Helvetica")
    .fontSize(9.5)
    .text(`•  ${t}`, { indent: 8, lineGap: 1.35 });
}

function callout(title: string, body: string) {
  ensureSpace(70);
  const x = 54;
  const w = 504;
  const pad = 10;
  doc.font("Helvetica-Bold").fontSize(9.5);
  const titleH = doc.heightOfString(title, { width: w - pad * 2 });
  doc.font("Helvetica").fontSize(9.5);
  const bodyH = doc.heightOfString(body, { width: w - pad * 2, lineGap: 1.3 });
  const boxH = pad * 2 + titleH + 4 + bodyH;
  const y0 = doc.y;
  doc
    .roundedRect(x, y0, w, boxH, 4)
    .fillColor(C.warnBg)
    .fill();
  doc
    .fillColor(C.warn)
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .text(title, x + pad, y0 + pad, { width: w - pad * 2 });
  doc
    .fillColor(C.ink)
    .font("Helvetica")
    .fontSize(9.5)
    .text(body, x + pad, y0 + pad + titleH + 4, {
      width: w - pad * 2,
      lineGap: 1.3,
    });
  doc.y = y0 + boxH + 10;
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------
H1("Pulse EDU");
doc
  .fillColor(C.sub)
  .font("Helvetica")
  .fontSize(12)
  .text("Final Development Clarification — Answers", { lineGap: 1.2 });
doc.moveDown(0.15);
doc
  .fontSize(10)
  .fillColor(C.muted)
  .text(
    "Responses prepared for launch planning. Production site: https://pulseedu.pulsekinetics.us/",
  );
doc.moveDown(0.8);
P(
  "This document answers the pre-launch questionnaire. I focus on what the platform provides today, what you must configure on your infrastructure, and items that need a conscious decision before go-live.",
);

callout(
  "Must know before launch",
  "1) Text alerts for Request Pullout are sent by email (Resend), not SMS — SMS would require a separate provider such as Twilio or Amazon SNS and is not built yet. 2) ClassLink / OneRoster automatic roster sync is scaffolded but not live; schools onboard with the in-app checklist and CSV Data Importer until sync is completed. 3) You should own production credentials (database, domain, email API keys).",
);

// ---------------------------------------------------------------------------
// 1. Documentation
// ---------------------------------------------------------------------------
doc.addPage();
H2("1. Documentation");
P(
  "At launch I will deliver a PDF package covering security overview, database and tenancy model, hosting configuration, email notifications, backup expectations, school onboarding, troubleshooting, system administration, and an FAQ for schools and districts.",
);
P("Formats: PDF as the primary deliverable; Word copies on request.");
P("Already in the product today:");
bullet("Settings → Onboarding Checklist with downloadable PDF.");
bullet("Technical runbook in the repository (replit.md): stack, env vars, multi-tenancy rules.");
bullet("Optional generated staff guides (Core Team / Teacher) from the scripts package.");
P(
  "Formal legal FERPA/COPPA opinions are the district’s responsibility with counsel; this documentation describes technical and operational controls only.",
);

// ---------------------------------------------------------------------------
// 2. Security
// ---------------------------------------------------------------------------
H2("2. Security, Privacy, and Compliance");
H3("Data location and protection");
bullet(
  "Student and staff records live in PostgreSQL (your DATABASE_URL). Media uploads use object storage paths you configure (PRIVATE_OBJECT_DIR / PUBLIC_OBJECT_SEARCH_PATHS).",
);
bullet(
  "Every school-scoped query is filtered by school_id. SuperUsers operate within their district, not across unrelated districts.",
);
bullet(
  "Staff sign in with server-side sessions stored in PostgreSQL; parents use a separate parent-portal login (invite-based, bcrypt passwords, rate limiting).",
);
bullet(
  "The API uses Helmet (CSP in production), CORS allowlists, CSRF on mutating requests, and structured HTTP logging (Pino).",
);
bullet(
  "For case AI consistency checks, student names are replaced with aliases before any model sees the bundle.",
);

H3("Encryption");
bullet("In transit: HTTPS on the public site (TLS at your reverse proxy / host).");
bullet(
  "At rest: Provided by your database and storage host (enable encryption on PostgreSQL and object storage). The app does not add separate field-level encryption for roster columns.",
);

H3("Access control");
bullet(
  "Role flags on staff (Admin, Dean, MTSS Coordinator, ISS, PBIS, etc.) gate routes and UI.",
);
bullet(
  "Parents only see students linked to their account; staff only see data for the active school context.",
);

H3("Backups and audit");
bullet(
  "Database backup and point-in-time recovery follow your PostgreSQL provider’s policy. I recommend a documented restore drill before launch.",
);
bullet(
  "The application maintains audit trails for key domains (e.g., investigations/cases, safety plans). HTTP logs support troubleshooting; a full SOC/SIEM is not included.",
);

H3("FERPA (operational alignment)");
bullet(
  "Pulse EDU stores education records used by school officials: roster identifiers, behavior, MTSS/ISS, accommodations, and parent-visible HeartBEAT summaries where enabled.",
);
bullet(
  "Access is limited to authenticated staff in the correct school and to parents for linked students only.",
);

H3("COPPA (operational alignment)");
bullet(
  "The parent portal is for adults (invite-based accounts), not student self-registration.",
);
bullet(
  "Day-to-day student interaction is staff-operated (classroom tools, kiosk/signage under school control).",
);
bullet(
  "District policy and counsel determine any parental consent requirements; I document what the parent portal displays and how invites work.",
);

H3("Questions stakeholders often ask");
bullet("Where is data hosted and who can access it?");
bullet("Can one school see another school’s data? (No, when tenancy is configured correctly.)");
bullet("How do staff get access when someone leaves? (Deactivate staff; manage the sign-in allowlist.)");
bullet("How are parents invited and what can they see?");
bullet("Is SMS used for alerts? (No — see Messaging section.)");
bullet("Is AI used on student information? (Case consistency check uses aliased bundles only.)");

// ---------------------------------------------------------------------------
// 3. ClassLink — honest, brief
// ---------------------------------------------------------------------------
H2("3. ClassLink / OneRoster Integration");
callout(
  "Current status",
  "Adapter structure exists in the codebase (OneRoster rostering and optional ClassLink SSO), with per-school settings in district_integrations. Automatic sync of students, staff, and room assignments is not production-ready yet. Until sync is finished, use CSV Data Importer and the in-app onboarding checklist.",
);
P("When live sync is delivered, it will:");
bullet("Connect via OneRoster API credentials stored as environment variables (not in the database row).");
bullet("Sync students, staff, and room assignments on a scheduled basis.");
bullet("Require district approval of the ClassLink application and redirect URIs for SSO if used.");
P(
  "District setup: approved ClassLink app, credentials in your server environment, and integration row per school. I will document sync status fields (last sync time/status) in the admin guide.",
);

// ---------------------------------------------------------------------------
// 4. Messaging — keep Twilio/SMS prominent
// ---------------------------------------------------------------------------
H2("4. Notifications and Messaging");
callout(
  "SMS is not live",
  "Request Pullout alerts go to designated staff by email today, not text message. The codebase reserves hooks for a future SMS provider (comments reference Twilio). If you require text messaging at launch, that is additional work: choose Twilio or Amazon SNS, provision numbers, comply with carrier rules, and budget per-message cost separately from email.",
);
H3("What works today (email via Resend)");
bullet(
  "When a teacher submits a Request Pullout, active staff in that school with Admin, Dean, MTSS Coordinator, or ISS Teacher role and a valid email receive a dispatch email.",
);
bullet(
  "Other email flows include parent invites, PBIS milestone emails to parents, pullout arrival/return messages, and optional intervention reminder digests when EMAIL_REMINDERS_ENABLED=true.",
);
bullet("Configure RESEND_API_KEY and RESEND_FROM_EMAIL on the production server.");

H3("Costs");
bullet("Email: per your Resend plan and send volume.");
bullet("SMS: not applicable until a provider is integrated; estimate after provider and volume are known.");

H3("Recipient control");
bullet(
  "Dispatch recipients are determined by staff role flags and active status in that school. There is no separate SMS recipient admin screen yet.",
);

// ---------------------------------------------------------------------------
// 5. Onboarding
// ---------------------------------------------------------------------------
H2("5. New School Onboarding");
P(
  "Onboarding is built into the app: Settings → Onboarding Checklist, organized in five phases (Identity & Access, Schedule & Operations, Behavior & PBIS, Interventions & MTSS, Family & Outreach). Each step links to the correct settings screen and can auto-detect completion or be marked done manually. A printable PDF is available from the same screen.",
);
H3("Typical steps");
bullet("Create the school (SuperUser → Tenancy) under your district.");
bullet("Configure branding, staff allowlist, staff directory/default rooms, and locations.");
bullet("Set a default bell schedule before turning on Hall Pass Queue.");
bullet("Configure PBIS, MTSS, parent portal sections, and send parent invites as needed.");
bullet("Import or enter roster data (CSV Data Importer until ClassLink sync is live).");

H3("Timeline and separation");
bullet("Typical setup: about one to two weeks for a motivated admin team; longer if waiting on external roster feeds.");
bullet("Data is isolated per school_id; permissions are managed per school via staff roles.");
P(
  "The onboarding checklist in the application is the authoritative checklist; no separate paper-only process is required.",
);

// ---------------------------------------------------------------------------
// 6. Support — keep light
// ---------------------------------------------------------------------------
H2("6. Launch Support");
P(
  "Support terms (hours, response times, 30/60/90-day windows, and fees) are defined in our project agreement, not in the application itself.",
);
bullet("I recommend email for day-to-day issues and scheduled screen shares during the first weeks after launch.");
bullet("Critical production outages should have a named contact and escalation path in the support agreement.");
bullet(
  "Included vs excluded scope (bug fixes on delivered features vs new modules) should match the signed statement of work.",
);

// ---------------------------------------------------------------------------
// 7. Future changes — shortened, no Replit essay
// ---------------------------------------------------------------------------
H2("7. Safe Changes vs Developer-Managed Areas");
P(
  "School admins can safely adjust settings content: branding, locations, PBIS reasons, bell schedules, allowlists, and onboarding steps that only touch school data.",
);
P("Changes that require a developer:");
bullet("Database schema (lib/db/src/schema), API routes, authentication, CSRF, and session configuration.");
bullet("New features, integrations (ClassLink live sync, SMS), and object-storage ACL logic.");
P(
  "Any new screen or table must include school_id on tenant data and use existing auth helpers so data cannot leak across schools.",
);

// ---------------------------------------------------------------------------
// 8. Ownership
// ---------------------------------------------------------------------------
H2("8. Ownership, Access, and Sustainability");
P(
  "Pulse EDU is deployed on infrastructure you own and control. I build, secure, and configure the application; you retain the production accounts.",
);
bullet(
  "You should own: domain/DNS, application server, PostgreSQL database, Resend account (email), and repository access.",
);
bullet(
  "At handoff I provide: source code, environment variable list (.env.example), deployment notes, and this clarification package.",
);
bullet(
  "Credentials to transfer: DATABASE_URL, SESSION_SECRET, RESEND_API_KEY, storage paths, and any future integration keys (ClassLink, Twilio/SNS).",
);
bullet(
  "Avoid leaving production-only secrets on a developer personal account.",
);
P(
  "Another developer can maintain the system with Node.js 24, pnpm, Express API, React client, and Drizzle ORM; start with multi-tenancy (scope.ts) and authentication.",
);
bullet(
  "Third-party services in use or planned: PostgreSQL hosting, Resend (email), optional Twilio or AWS SNS if SMS is added, ClassLink when sync is completed.",
);

// ---------------------------------------------------------------------------
// 9. Launch checklist
// ---------------------------------------------------------------------------
doc.addPage();
H2("9. Launch Readiness Checklist");
P("Use this table to confirm status before go-live:");
doc.moveDown(0.2);

type Row = [string, string];
const rows: Row[] = [
  ["Security controls (app layer)", "Ready — review your host encryption and HTTPS"],
  ["FERPA / COPPA legal sign-off", "District counsel"],
  ["ClassLink / OneRoster auto-sync", "Not production-ready — use CSV + onboarding"],
  ["Hosting (PostgreSQL + Node app)", "Confirm your server and DATABASE_URL"],
  ["Email notifications (Resend)", "Configure keys; test pullout dispatch email"],
  ["SMS notifications", "Not available — email only unless SMS is scoped"],
  ["User role testing", "Required — test each role against your matrix"],
  ["Request Pullout → staff alert", "Test email to Admin/Dean/MTSS/ISS"],
  ["School onboarding", "Use in-app checklist + PDF"],
  ["Documentation package", "This PDF + onboarding export"],
  ["Support plan", "Per project agreement"],
  ["Database backups", "Enable on provider; run restore drill"],
  ["Known limitations", "No SMS; no live ClassLink sync; email reminders off unless enabled"],
  ["Final walkthrough", "Schedule after items above pass"],
];

const x0 = 54;
const col1 = 220;
const col2 = 284;
const rowH = 22;
let y = doc.y;
doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C.ink);
doc.text("Item", x0, y, { width: col1 });
doc.text("Status / action", x0 + col1, y, { width: col2 });
y += rowH;
doc.strokeColor(C.rule).moveTo(x0, y - 4).lineTo(x0 + col1 + col2, y - 4).stroke();

for (const [a, b] of rows) {
  if (y + rowH > 720) {
    doc.addPage();
    y = 54;
  }
  doc.font("Helvetica").fontSize(8.5).fillColor(C.ink);
  const h1 = doc.heightOfString(a, { width: col1 - 6 });
  const h2 = doc.heightOfString(b, { width: col2 - 6 });
  const rh = Math.max(rowH, h1 + 6, h2 + 6);
  doc.text(a, x0 + 3, y + 3, { width: col1 - 6 });
  doc.text(b, x0 + col1 + 3, y + 3, { width: col2 - 6 });
  y += rh;
  doc.strokeColor(C.rule).moveTo(x0, y).lineTo(x0 + col1 + col2, y).stroke();
}
doc.y = y + 12;

H3("Request Pullout workflow (confirmed behavior)");
P(
  "Teacher submits Request Pullout → system sends email to active dispatch-role staff in that school (Admin, Dean, MTSS Coordinator, ISS Teacher) who have valid email addresses → send is tracked on the pullout record (idempotent). Text messaging is not part of this workflow until an SMS provider is integrated.",
);

// Footer on all pages
const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  doc
    .fillColor(C.muted)
    .font("Helvetica")
    .fontSize(8)
    .text(
      `Pulse EDU Launch Clarification — Page ${i + 1} of ${range.count}`,
      54,
      742,
      { align: "center", width: 504 },
    );
}

doc.end();

console.log(`Wrote ${OUT}`);
