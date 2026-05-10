import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OUT = "exports/PulseEDU_Phase1_Roles_and_Access.pdf";
mkdirSync(dirname(OUT), { recursive: true });

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 54, bottom: 54, left: 54, right: 54 },
  bufferPages: true,
  info: {
    Title: "PulseEDU Phase 1 — User Roles & Access Matrix",
    Author: "PulseEDU",
    Subject: "Developer reference: every user type and what they can access",
  },
});
doc.pipe(createWriteStream(OUT));

const C = {
  ink: "#0f172a",
  sub: "#475569",
  muted: "#94a3b8",
  rule: "#e2e8f0",
  band: "#f1f5f9",
  brand: "#0e7490",
  accent: "#0891b2",
  good: "#16a34a",
  warn: "#d97706",
  bad: "#dc2626",
  noAccess: "#cbd5e1",
};

function H1(t) {
  doc.fillColor(C.brand).font("Helvetica-Bold").fontSize(22).text(t);
  doc.moveDown(0.3);
}
function H2(t) {
  ensureSpace(60);
  doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(14).text(t);
  doc.moveDown(0.2);
  const y = doc.y;
  doc.strokeColor(C.brand).lineWidth(1).moveTo(54, y).lineTo(558, y).stroke();
  doc.moveDown(0.4);
}
function H3(t) {
  ensureSpace(40);
  doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(11).text(t);
  doc.moveDown(0.15);
}
function P(t, opts = {}) {
  doc.fillColor(opts.color || C.ink).font(opts.font || "Helvetica").fontSize(opts.size || 9.5).text(t, { align: opts.align || "left", lineGap: 1.5 });
  doc.moveDown(opts.gap ?? 0.3);
}
function bullet(t) {
  doc.fillColor(C.ink).font("Helvetica").fontSize(9.5).text(`•  ${t}`, { indent: 6, lineGap: 1.5 });
}
function ensureSpace(h) {
  if (doc.y + h > 720) doc.addPage();
}
function newSection() {
  // only break if we're not already near the top of a fresh page
  if (doc.y > 110) doc.addPage();
}
function rule() {
  const y = doc.y + 4;
  doc.strokeColor(C.rule).lineWidth(0.5).moveTo(54, y).lineTo(558, y).stroke();
  doc.moveDown(0.5);
}

// Simple table renderer: fixed columns
function table({ columns, rows, headerFill = C.band, zebra = true }) {
  const x0 = 54;
  const totalWidth = 504;
  const widths = columns.map((c) => Math.round((c.w / 100) * totalWidth));
  const rowPadding = 5;
  const lineGap = 1.5;
  const fontSize = 8.5;
  doc.font("Helvetica");
  // measure row heights
  function measure(rowCells, font) {
    doc.font(font).fontSize(fontSize);
    let max = 0;
    rowCells.forEach((c, i) => {
      const w = widths[i] - rowPadding * 2;
      const h = doc.heightOfString(String(c ?? ""), { width: w, lineGap });
      if (h > max) max = h;
    });
    return max + rowPadding * 2;
  }
  function drawRow(cells, y, h, fill, font, color) {
    if (fill) {
      doc.rect(x0, y, totalWidth, h).fill(fill);
    }
    let x = x0;
    cells.forEach((cell, i) => {
      doc.fillColor(color || C.ink).font(font).fontSize(fontSize)
        .text(String(cell ?? ""), x + rowPadding, y + rowPadding, {
          width: widths[i] - rowPadding * 2,
          lineGap,
        });
      x += widths[i];
    });
    // borders
    doc.strokeColor(C.rule).lineWidth(0.4);
    doc.rect(x0, y, totalWidth, h).stroke();
    let cx = x0;
    for (let i = 0; i < widths.length - 1; i++) {
      cx += widths[i];
      doc.moveTo(cx, y).lineTo(cx, y + h).stroke();
    }
  }
  // header
  const headerH = measure(columns.map((c) => c.label), "Helvetica-Bold");
  ensureSpace(headerH + 30);
  drawRow(columns.map((c) => c.label), doc.y, headerH, headerFill, "Helvetica-Bold");
  doc.y = doc.y + headerH;
  rows.forEach((r, idx) => {
    const cells = columns.map((c) => r[c.key]);
    const h = measure(cells, "Helvetica");
    if (doc.y + h > 740) {
      doc.addPage();
      drawRow(columns.map((c) => c.label), doc.y, headerH, headerFill, "Helvetica-Bold");
      doc.y = doc.y + headerH;
    }
    const fill = zebra && idx % 2 ? "#fafafa" : null;
    drawRow(cells, doc.y, h, fill, "Helvetica");
    doc.y = doc.y + h;
  });
  doc.moveDown(0.6);
}

// =========== CONTENT ==============

// Cover
doc.rect(0, 0, 612, 200).fill(C.brand);
doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28).text("PulseEDU", 54, 70);
doc.font("Helvetica-Bold").fontSize(18).text("Phase 1 — User Roles & Access Matrix", 54, 110);
doc.font("Helvetica").fontSize(11).text("End-to-end developer reference", 54, 142);
doc.fillColor(C.ink);
doc.y = 230;
P(`Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, { color: C.sub, size: 10 });
P("Scope: every user type that exists in the Phase 1 launch, every page they can reach, every action they can take, and every cross-feature dependency.", { size: 11 });
doc.moveDown(0.3);
P("Source of truth: this document is generated from the live codebase — staff schema, capability flags, route guards (requireSchool / isCoreTeam / requireAdmin / parent token / signage token), nav predicates in App.tsx, and parent / signage entry points.", { color: C.sub });

H2("How to read this document");
bullet("Section 1 — Master role list: every identifier with its scope and how it is checked.");
bullet("Section 2 — Capability flags: granular per-user toggles layered on top of roles.");
bullet("Section 3 — Helper predicates: derived gates (Core Team, Safety Plan editor, etc.).");
bullet("Section 4 — Page × Role matrix (cross-reference grid for every page).");
bullet("Section 5 — Per-feature access detail: each feature, who can do what, and dependencies on other features.");
bullet("Section 6 — API surface by feature (route → guard).");
bullet("Section 7 — Cross-feature dependency map (writes that touch other modules).");

newSection();

// === SECTION 1: ROLES ===
H1("1. Master User Type List");
P("PulseEDU has four authentication tiers: staff (with role flags), parents, kiosk/signage devices, and unauthenticated public displays. Roles are stored as boolean flags on the staff record (lib/db/src/schema/staff.ts) and resolved in the global auth middleware (artifacts/api-server/src/app.ts).", { color: C.sub });
doc.moveDown(0.4);

H2("1a. Staff roles (privileged)");
table({
  columns: [
    { key: "id", label: "Identifier", w: 22 },
    { key: "name", label: "Display name", w: 18 },
    { key: "scope", label: "Scope", w: 12 },
    { key: "check", label: "Check / notes", w: 48 },
  ],
  rows: [
    { id: "isSuperUser", name: "SuperUser", scope: "District", check: "Top-level. Can act as any school in district via active_school_override. Grants/revokes any role. Manages tenancy and school plans." },
    { id: "isDistrictAdmin", name: "District Admin", scope: "District", check: "Manages all schools in their district (rosters, staff, imports). Cannot reach other districts. canActAsDistrict() in lib/scope.ts." },
    { id: "isAdmin", name: "School Admin", scope: "School", check: "Manages school settings, staff roles, all admin surfaces for one school." },
    { id: "isBehaviorSpecialist", name: "Behavior Specialist", scope: "School", check: "Core Team member. Receives Watchlist check-in notifications and pullout verifications." },
    { id: "isMtssCoordinator", name: "MTSS Coordinator", scope: "School", check: "Core Team. Owns Tier 2/3 plans and intervention reports." },
    { id: "isSchoolPsychologist", name: "School Psychologist", scope: "School", check: "Core Team. Full Safety Plan editing rights." },
    { id: "isGuidanceCounselor", name: "Guidance Counselor", scope: "School", check: "canEditSafetyPlan gate. Manages student safety plans and library." },
    { id: "isDean", name: "Dean", scope: "School", check: "Bundled with Admin/Core Team for displays and discipline visibility." },
    { id: "isEseCoordinator", name: "ESE Coordinator", scope: "School", check: "Manages school accommodations library; presets for ESE staff." },
    { id: "isPbisCoordinator", name: "PBIS Coordinator", scope: "School", check: "Owns PBIS settings, milestones, and store edit rights." },
    { id: "isIssTeacher", name: "ISS Teacher", scope: "School", check: "Granted capIssDashboard by default. Runs the ISS room daily." },
    { id: "isCounselor", name: "Counselor", scope: "School", check: "Label/preset for non-guidance counseling staff." },
    { id: "isSocialWorker", name: "Social Worker", scope: "School", check: "Label/preset; access via capability flags." },
  ],
});

H2("1b. Non-staff user types");
table({
  columns: [
    { key: "id", label: "Identifier", w: 22 },
    { key: "cat", label: "Category", w: 18 },
    { key: "scope", label: "Scope", w: 14 },
    { key: "auth", label: "Auth mechanism", w: 46 },
  ],
  rows: [
    { id: "parentId", cat: "Parent Portal user", scope: "Linked students", auth: "parents table; email + password (or invite token). verifyParentAuthToken in lib/parentAuth.ts. Only sees students in parent_students join." },
    { id: "kioskActivation", cat: "Kiosk (active)", scope: "Room / school", auth: "kiosk_activations.tokenHash (32-byte). Can issue passes / add to queue for one room." },
    { id: "kioskViewer", cat: "Kiosk viewer (QR)", scope: "Room", auth: "kiosk_viewer_tokens. Read-only token for the waiting-queue display." },
    { id: "publicDisplay", cat: "Signage / TV", scope: "Playlist / school", auth: "None — /api/displays/public/* is open. Scoped by playlist or school id in URL." },
    { id: "anonymous", cat: "Public", scope: "n/a", auth: "Login pages, branding fetches, /api/healthz." },
  ],
});

newSection();

// === SECTION 2: CAPS ===
H1("2. Capability Flags (cap_*)");
P("Granular per-staff toggles defined in adminStaff.ts. Default values fall into two buckets: defaults-on (any signed-in staff member) and defaults-off (must be granted by an Admin or SuperUser).", { color: C.sub });
doc.moveDown(0.3);

H3("Defaults ON — every staff account starts with these");
table({
  columns: [
    { key: "cap", label: "Capability", w: 28 },
    { key: "what", label: "What it unlocks", w: 72 },
  ],
  rows: [
    { cap: "capHallPasses", what: "Issue and end hall passes for own students." },
    { cap: "capTardies", what: "Log tardies, check-ins, check-outs." },
    { cap: "capStudentActivity", what: "View the live activity feed and student timelines." },
    { cap: "capPbisAward", what: "Award PBIS points." },
    { cap: "capParentEmail", what: "Send parent emails / log a parent contact." },
    { cap: "capSupportNotes", what: "Add staff support notes on a student profile." },
    { cap: "capAccommodationLog", what: "Log that an accommodation was provided." },
    { cap: "capPulloutsRequest", what: "Submit a pullout request for behavioral support." },
    { cap: "capInterventionLog", what: "Log a Tier 2/3 intervention contact." },
    { cap: "capReports", what: "Access teacher-level reports (own students)." },
    { cap: "capKioskActivate", what: "Activate a kiosk device with their staff credentials." },
  ],
});

H3("Defaults OFF — must be granted");
table({
  columns: [
    { key: "cap", label: "Capability", w: 28 },
    { key: "what", label: "What it unlocks", w: 72 },
  ],
  rows: [
    { cap: "capHallPassesViewAll", what: "View hall pass log school-wide (not just own classes)." },
    { cap: "capPbisManage", what: "Edit PBIS reasons, milestones, and run bulk awards." },
    { cap: "capAccommodationManage", what: "Edit the school accommodations library." },
    { cap: "capPulloutsVerify", what: "Verify and triage pullout requests." },
    { cap: "capPulloutsReview", what: "Review pullout outcomes / behavior review board." },
    { cap: "capInterventionManage", what: "Manage intervention types and pullout reasons (school-wide)." },
    { cap: "capIssDashboard", what: "Run the ISS dashboard and reporting." },
    { cap: "capManageLocations", what: "Edit rooms, locations, and bell schedules." },
    { cap: "capStaffRoles", what: "View the staff roles matrix." },
    { cap: "capManageRoles", what: "Edit other staff members' roles and capabilities." },
    { cap: "capManageDisplays", what: "Manage signage playlists and display content." },
  ],
});

newSection();

// === SECTION 3: HELPERS ===
H1("3. Helper Predicates");
P("Derived gates used throughout the route layer and the client nav. These compose role flags + capability flags.", { color: C.sub });
doc.moveDown(0.3);
table({
  columns: [
    { key: "name", label: "Predicate", w: 28 },
    { key: "where", label: "Defined in", w: 28 },
    { key: "logic", label: "Logic", w: 44 },
  ],
  rows: [
    { name: "isCoreTeam", where: "lib/coreTeam.ts", logic: "isSuperUser || isDistrictAdmin || isAdmin || isBehaviorSpecialist || isMtssCoordinator || isSchoolPsychologist." },
    { name: "canEditSafetyPlan", where: "routes/safetyPlans.ts", logic: "isCoreTeam || isGuidanceCounselor." },
    { name: "canActAsDistrict", where: "lib/scope.ts", logic: "isSuperUser || isDistrictAdmin." },
    { name: "canManageDisplays", where: "components/Displays guard", logic: "Core Team || isDean || capManageDisplays." },
    { name: "canManageStaffRoles", where: "App.tsx nav", logic: "isAdmin || isSuperUser || capManageRoles." },
    { name: "canAccessMtssHub", where: "App.tsx nav", logic: "isCoreTeam (drives all six insights dashboards)." },
    { name: "canAccessPbisHub", where: "App.tsx nav", logic: "isCoreTeam || isPbisCoordinator." },
    { name: "canEditSchoolStore", where: "App.tsx nav", logic: "isCoreTeam || isPbisCoordinator." },
    { name: "canManageMtssPlans", where: "App.tsx nav", logic: "isCoreTeam." },
    { name: "canManageBehaviorLists", where: "App.tsx nav", logic: "isCoreTeam." },
    { name: "canViewIssDashboard", where: "App.tsx nav", logic: "isAdmin || isIssTeacher || capIssDashboard." },
    { name: "canVerifyPullouts", where: "App.tsx nav", logic: "isCoreTeam || capPulloutsVerify." },
    { name: "canManageBellSchedules", where: "App.tsx nav", logic: "isAdmin || isSuperUser || capManageLocations." },
    { name: "canManageSettings", where: "App.tsx nav", logic: "isAdmin || isSuperUser." },
    { name: "requireSchool", where: "lib/scope.ts (server)", logic: "Resolves req.schoolId from session or active_school_override; rejects if absent." },
    { name: "requireAdmin", where: "routes/kiosk.ts (server)", logic: "isAdmin || isSuperUser." },
    { name: "requireSuperUser", where: "server middleware", logic: "isSuperUser only." },
  ],
});

newSection();

// === SECTION 4: MATRIX ===
H1("4. Page × Role Matrix");
P("R = read, W = write, A = admin (manage settings / others), — = no access. Capability-gated cells are marked 'cap'. The matrix is split into six tables to stay legible at letter-size.", { color: C.sub });
doc.moveDown(0.3);

const roleCols = [
  { key: "su", label: "SU", w: 6.5 },
  { key: "da", label: "DA", w: 6.5 },
  { key: "ad", label: "Admin", w: 8 },
  { key: "core", label: "BS/MTSS/Psych", w: 11 },
  { key: "gc", label: "GC", w: 6.5 },
  { key: "dean", label: "Dean", w: 7 },
  { key: "pbis", label: "PBIS coord", w: 9 },
  { key: "ese", label: "ESE coord", w: 8.5 },
  { key: "iss", label: "ISS Tch", w: 7 },
  { key: "tch", label: "Teacher", w: 7.5 },
  { key: "par", label: "Parent", w: 6.5 },
  { key: "sig", label: "Signage", w: 7 },
];
const featCol = { key: "feat", label: "Page / Feature", w: 22 };

function matrix(title, rows) {
  H3(title);
  table({
    columns: [featCol, ...roleCols],
    rows,
  });
}

matrix("4a. Hall Pass & Tardies", [
  { feat: "Hall Passes (issue/end)", su: "W", da: "W", ad: "W", core: "W", gc: "W", dean: "W", pbis: "W", ese: "W", iss: "W", tch: "W", par: "—", sig: "R*" },
  { feat: "Hall Pass log (school-wide)", su: "R", da: "R", ad: "R", core: "R", gc: "cap", dean: "R", pbis: "cap", ese: "cap", iss: "cap", tch: "cap", par: "—", sig: "—" },
  { feat: "Hall Pass mgmt (lists, limits, polarity)", su: "A", da: "A", ad: "A", core: "A", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Tardy Pass / check-in", su: "W", da: "W", ad: "W", core: "W", gc: "W", dean: "W", pbis: "W", ese: "W", iss: "W", tch: "W", par: "R", sig: "—" },
  { feat: "Hall Pass reports (YTD / research)", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "R", pbis: "—", ese: "R", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Hall Pass Queue (kiosk)", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "W", par: "—", sig: "R" },
]);
P("* Signage shows active passes only when admin enables showActiveHallPasses on the playlist.", { color: C.sub, size: 8 });

matrix("4b. PBIS & Stores", [
  { feat: "Award PBIS points", su: "W", da: "W", ad: "W", core: "W", gc: "W", dean: "W", pbis: "W", ese: "W", iss: "W", tch: "W", par: "—", sig: "—" },
  { feat: "PBIS Hub (analytics, Needs Attention)", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "R", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "PBIS Lists / eligibility", su: "W", da: "W", ad: "W", core: "W", gc: "—", dean: "—", pbis: "W", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "PBIS reasons & milestone emails", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "A", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "School Store (browse)", su: "R", da: "R", ad: "R", core: "R", gc: "R", dean: "R", pbis: "R", ese: "R", iss: "R", tch: "R", par: "—", sig: "—" },
  { feat: "School Store mgmt", su: "A", da: "A", ad: "A", core: "A", gc: "—", dean: "—", pbis: "A", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Classroom Store", su: "R", da: "R", ad: "R", core: "R", gc: "R", dean: "R", pbis: "R", ese: "R", iss: "R", tch: "W", par: "—", sig: "—" },
  { feat: "PBIS House standings (signage)", su: "R", da: "R", ad: "R", core: "R", gc: "R", dean: "R", pbis: "R", ese: "R", iss: "R", tch: "R", par: "—", sig: "R" },
]);

matrix("4c. Behavior, ISS & Interventions", [
  { feat: "Request Pullout", su: "W", da: "W", ad: "W", core: "W", gc: "W", dean: "W", pbis: "W", ese: "W", iss: "W", tch: "W", par: "—", sig: "—" },
  { feat: "Verify Pullouts", su: "W", da: "W", ad: "W", core: "W", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "cap", par: "—", sig: "—" },
  { feat: "Behavior Review (outcomes)", su: "W", da: "W", ad: "W", core: "W", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "ISS Dashboard (live room)", su: "W", da: "W", ad: "W", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "W", tch: "cap", par: "—", sig: "—" },
  { feat: "ISS Reporting (daily logs)", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "R", pbis: "—", ese: "—", iss: "R", tch: "—", par: "—", sig: "—" },
  { feat: "Log Intervention", su: "W", da: "W", ad: "W", core: "W", gc: "W", dean: "W", pbis: "W", ese: "W", iss: "W", tch: "W", par: "—", sig: "—" },
  { feat: "My Interventions (history)", su: "R", da: "R", ad: "R", core: "R", gc: "R", dean: "R", pbis: "R", ese: "R", iss: "R", tch: "R", par: "—", sig: "—" },
  { feat: "Interventions mgmt (types/reasons)", su: "A", da: "A", ad: "A", core: "A", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
]);

matrix("4d. MTSS, Safety & Watchlist", [
  { feat: "MTSS Plans (T2/T3)", su: "A", da: "A", ad: "A", core: "A", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "R†", sig: "—" },
  { feat: "MTSS Reports (fidelity, progress)", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Safety Plans", su: "A", da: "A", ad: "A", core: "A", gc: "A", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "R", par: "—", sig: "—" },
  { feat: "Trusted Adults admin", su: "W", da: "W", ad: "W", core: "W", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Watchlist Hub (alerts, summary)", su: "W", da: "W", ad: "W", core: "W", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Watchlist Network (graph)", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Watchlist Case detail (notes/players)", su: "W", da: "W", ad: "W", core: "W", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Witness Statements", su: "W", da: "W", ad: "W", core: "W", gc: "W*", dean: "W*", pbis: "W*", ese: "W*", iss: "W*", tch: "W*", par: "—", sig: "—" },
]);
P("† Parent sees MTSS plan summary only when admin enables `interventions` / `mtss` in Parent Portal sections.   * Any staff requested as a witness can submit their own statement.", { color: C.sub, size: 8 });

matrix("4e. Insights Dashboards (all gated by canAccessMtssHub = isCoreTeam)", [
  { feat: "Insights Hub (launcher)", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Engagement Dashboard", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Behavior Dashboard", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Academics Dashboard", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Academics Trajectory", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "SEB-SEL Dashboard", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Equity Dashboard", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Early Warning Dashboard", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Student Profile (deep dive)", su: "R", da: "R", ad: "R", core: "R", gc: "R", dean: "R", pbis: "R", ese: "R", iss: "R", tch: "R", par: "—", sig: "—" },
  { feat: "My Watch List (personal)", su: "W", da: "W", ad: "W", core: "W", gc: "W", dean: "W", pbis: "W", ese: "W", iss: "W", tch: "W", par: "—", sig: "—" },
]);

matrix("4f. School Admin & Settings", [
  { feat: "Staff Roles matrix", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Staff Directory", su: "W", da: "W", ad: "W", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Teacher Roster (own)", su: "R", da: "R", ad: "R", core: "R", gc: "R", dean: "R", pbis: "R", ese: "R", iss: "R", tch: "R", par: "—", sig: "—" },
  { feat: "Teacher Roster (any teacher)", su: "R", da: "R", ad: "R", core: "R", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Data Importer", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Bell Schedules", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "cap", par: "—", sig: "—" },
  { feat: "Kiosk Setup", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Displays / Signage mgmt", su: "A", da: "A", ad: "A", core: "A", gc: "—", dean: "A", pbis: "—", ese: "—", iss: "—", tch: "cap", par: "—", sig: "—" },
  { feat: "Branding (logo, colors, EKG)", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Parent Portal (invites + sections)", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Accommodations library", su: "A", da: "A", ad: "A", core: "—", gc: "—", dean: "—", pbis: "—", ese: "A", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Accommodation logs (record)", su: "W", da: "W", ad: "W", core: "W", gc: "W", dean: "W", pbis: "W", ese: "W", iss: "W", tch: "W", par: "R", sig: "—" },
  { feat: "School Plans (assign tiers)", su: "A", da: "—", ad: "—", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Tenancy / multi-school", su: "A", da: "—", ad: "—", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Logo Generator (brand tool)", su: "W", da: "—", ad: "—", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Staff Preview (impersonate)", su: "W", da: "W", ad: "W", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
  { feat: "Notifications (admin alerts)", su: "W", da: "W", ad: "W", core: "—", gc: "—", dean: "—", pbis: "—", ese: "—", iss: "—", tch: "—", par: "—", sig: "—" },
]);

newSection();

// === SECTION 5: PER-FEATURE DETAIL ===
H1("5. Per-Feature Access Detail");
P("Each feature includes: who can see it, what they can do, the entry point in the UI, and any cross-feature dependencies that the developers must keep wired up.", { color: C.sub });
doc.moveDown(0.3);

function feature({ name, where, who, can, deps }) {
  H3(name);
  P(`Where:  ${where}`, { color: C.sub, size: 9 });
  P(`Who:  ${who}`, { size: 9.5 });
  P(`Can do:  ${can}`, { size: 9.5 });
  if (deps) P(`Dependencies:  ${deps}`, { color: C.warn, size: 9 });
  rule();
}

feature({
  name: "Hall Pass system",
  where: "App.tsx → activeSection 'hallPasses'; routes/hallPasses.ts; routes/hallPassQueue.ts",
  who: "Any staff with capHallPasses (default on). School-wide log requires capHallPassesViewAll. Mgmt requires Core Team.",
  can: "Issue / end passes; tardy returns; student polarity pairs; daily limits; queue; YTD + research reports for Admin / Dean / ESE.",
  deps: "Bell Schedules — queue auto-resets on period change; falls back to 45-minute idle buckets if no default schedule. Signage pulls active passes when showActiveHallPasses is on. Parent Portal shows recent passes when section enabled.",
});
feature({
  name: "PBIS Hub & Stores",
  where: "activeSection 'pbis' / 'pbisHub' / 'pbisLists' / 'schoolStore' / 'schoolStoreManage'",
  who: "Award: any staff (capPbisAward). Hub: Core Team or PBIS Coordinator. Store mgmt: Core Team / PBIS coord. Classroom store: each teacher edits own.",
  can: "Award single + bulk; reasons & milestones; eligibility lists; school-wide store catalog; classroom store; house standings.",
  deps: "Watchlist alerts read PBIS counts. Parent Portal `recognition` section pulls from PBIS. Heartbeat & Houses signage stream PBIS events live (names masked to first + last initial).",
});
feature({
  name: "MTSS Intervention Plans",
  where: "activeSection 'mtssPlans' / 'interventionReports'; routes/mtssPlans.ts",
  who: "Core Team only.",
  can: "Create T2/T3 plans, weekly progress monitoring, strategy categories, completion reports; tier-aware launcher with bell-notification system.",
  deps: "Watchlist 'Schedule Check-in' creates a Tier 2 cico plan if absent and inserts today's tier2_intervention_entries row. Parent Portal `mtss` section reads active plans (when admin opts in).",
});
feature({
  name: "Safety Plans",
  where: "activeSection 'safetyPlans'; routes/safetyPlans.ts",
  who: "Edit: Core Team or Guidance Counselor. View: any staff member.",
  can: "Per-student behavioral / physical safety checklists; library items; audit log; integrated into student rosters and profiles.",
  deps: "Surfaced as a flag on Teacher Roster and Student Profile. Audit log retained per change.",
});
feature({
  name: "Watchlist Hub / Network / Case Detail",
  where: "activeSection 'watchlistHub' / 'watchlistNetwork' / 'watchlistCase'; routes/watchlist.ts",
  who: "Core Team only (server enforces requireSchool plus client nav predicate).",
  can: "Hub: alerts (5 rules), summary, orbit. Network: school-wide relationship graph with clickable case halos. Case Detail: notes timeline, players list, link/log incidents, request witness statements.",
  deps: "POST /alerts/check-in writes to MTSS (T2 cico plan) AND tier2_intervention_entries AND admin_notifications for BS + MTSS coord. Witness statements email staff via Resend (RESEND_FROM_ADDRESS, EMAIL_REMINDERS_ENABLED).",
});
feature({
  name: "Insights Dashboards (Engagement, Behavior, Academics, SEB-SEL, Equity, Early Warning)",
  where: "activeSection ends with 'Dashboard'; insights/* components",
  who: "Core Team (canAccessMtssHub).",
  can: "Aggregate data, trends, top-N lists; grade & window filters; demographic disaggregation; drill-down to Student Profile.",
  deps: "Reads PBIS, hall passes, tardies, FAST, accommodations, intervention logs. Drill-through respects student-level scoping.",
});
feature({
  name: "ISS Dashboard & Reporting",
  where: "activeSection 'issDashboard' / 'issReporting'; routes/issRoster.ts; routes/issAttendance.ts",
  who: "ISS Teacher (default) or anyone with capIssDashboard or Admin.",
  can: "Run live ISS room (per-period presence), daily attendance sheet, rollover absent students to next school day.",
  deps: "Admin Hub feed surfaces recent ISS assignments. Future work: edit / trim / delete with audit trail (see replit.md).",
});
feature({
  name: "Teacher Roster",
  where: "activeSection 'teacherRoster'; routes/teacherRoster.ts",
  who: "Each teacher sees own; Core Team can view any teacher.",
  can: "FAST scores, ESE/504/ELL flags, safety plan indicators.",
  deps: "Aggregates Safety Plans, accommodations, FAST academics — must stay live with importer.",
});
feature({
  name: "Data Importer",
  where: "activeSection 'data-imports'; routes/dataImports.ts",
  who: "Admin / SuperUser / District Admin (canManageSettings).",
  can: "CSV uploads with template mapping; preview, commit, rollback; assessments / rosters / behavior.",
  deps: "Feeds students, rosters, FAST, behavior — every dashboard depends on it.",
});
feature({
  name: "Display Management & Signage",
  where: "activeSection 'displays'; routes/displays.ts; signage pages",
  who: "Mgmt: Core Team or Dean or capManageDisplays. Viewing: public via signed URLs.",
  can: "Per-school playlists (image, video, audio, PDF, url); scheduling overrides; toggles for showActiveHallPasses, showHeartbeat, showPbisHousePage.",
  deps: "Heartbeat signage streams pulse events live. Houses signage reads PBIS standings. Active hall pass display reads hall pass system. Names masked (first + last initial) on public displays.",
});
feature({
  name: "Parent Portal",
  where: "artifacts/client/src/parent/*; routes/parentSnapshot.ts; routes/parentInvites.ts",
  who: "Parents linked to a student via parent_students. Admin manages invites.",
  can: "Snapshot dashboard (PBIS, hall passes, tardies, accommodations, staff notes), child switcher, PDF export, per-section visibility prefs.",
  deps: "Sections toggleable globally by admin and per-parent: recognition, hallPasses, attendance, accommodations, staffNotes, fastScores, interventions, mtss. Email invites use Resend.",
});
feature({
  name: "Accommodations",
  where: "routes/accommodationsAdmin.ts; routes/accommodationLogs.ts",
  who: "Library mgmt: ESE Coordinator or Admin. Logging: any staff.",
  can: "Define IEP/504 accommodations; teachers log when provided; appears in Parent Portal.",
  deps: "Surfaced on Student Profile, Teacher Roster, Parent Portal `accommodations` section.",
});

newSection();

// === SECTION 6: API by feature ===
H1("6. API Surface (route → guard)");
P("Inventory of every endpoint and the guard that protects it, grouped by feature. Use this when wiring new clients or auditing.", { color: C.sub });
doc.moveDown(0.3);

function apiBlock(title, items) {
  H3(title);
  table({
    columns: [
      { key: "method", label: "Method", w: 9 },
      { key: "path", label: "Path", w: 51 },
      { key: "guard", label: "Guard", w: 18 },
      { key: "what", label: "Purpose", w: 22 },
    ],
    rows: items,
  });
}

apiBlock("Watchlist & Cases", [
  { method: "GET", path: "/watchlist/summary", guard: "requireSchool + Core", what: "Hub stats" },
  { method: "GET", path: "/watchlist/alerts", guard: "requireSchool + Core", what: "5-rule alerts" },
  { method: "POST", path: "/watchlist/alerts/dismiss", guard: "requireSchool + Core", what: "Snooze/dismiss" },
  { method: "POST", path: "/watchlist/alerts/check-in", guard: "requireSchool + Core", what: "Cross-write to MTSS + BS" },
  { method: "GET", path: "/watchlist/orbit", guard: "requireSchool + Core", what: "Bubble-chart" },
  { method: "GET", path: "/watchlist/network", guard: "requireSchool + Core", what: "Graph nodes/edges" },
  { method: "GET / POST", path: "/watchlist/cases", guard: "requireSchool + Core", what: "List / create" },
  { method: "GET / PATCH", path: "/watchlist/cases/:id", guard: "requireSchool + Core", what: "Detail / update" },
  { method: "POST", path: "/watchlist/cases/:id/notes", guard: "requireSchool + Core", what: "Add note" },
  { method: "POST", path: "/watchlist/cases/:id/players", guard: "requireSchool + Core", what: "Add players" },
  { method: "GET / POST", path: "/watchlist/interactions", guard: "requireSchool + Core", what: "List / log" },
  { method: "POST", path: "/watchlist/interactions/:id/witness-statements/request", guard: "requireSchool + Core", what: "Request statement" },
  { method: "POST", path: "/watchlist/statements/:id/remind", guard: "requireSchool", what: "Email reminder" },
  { method: "POST", path: "/watchlist/statements/:id/submit", guard: "requireSchool", what: "Submit content" },
]);

apiBlock("Hall Pass / Tardies / Kiosk", [
  { method: "GET / POST", path: "/hall-passes", guard: "requireSchool", what: "List / issue" },
  { method: "PATCH", path: "/hall-passes/:id/end", guard: "requireSchool", what: "End pass" },
  { method: "GET", path: "/hall-pass-queue", guard: "requireStaff", what: "Wait queue" },
  { method: "POST", path: "/kiosk/queue/:token/add", guard: "kiosk token", what: "Kiosk add" },
  { method: "POST", path: "/kiosk/viewer-token", guard: "requireStaff", what: "QR display token" },
  { method: "GET / POST", path: "/tardies", guard: "requireSchool", what: "Tardy log" },
]);

apiBlock("PBIS / Stores", [
  { method: "GET / POST", path: "/pbis", guard: "requireSchool", what: "Award / list" },
  { method: "POST", path: "/pbis/bulk", guard: "requireSchool + capPbisManage", what: "Bulk awards" },
  { method: "GET", path: "/pbis-goals", guard: "requireStaff", what: "Goals" },
  { method: "GET / POST", path: "/school-store", guard: "requireSchool (POST: Core/PBIS)", what: "Catalog" },
  { method: "GET", path: "/classroom-store", guard: "requireSchool", what: "Per-teacher rewards" },
]);

apiBlock("MTSS / Safety / Interventions", [
  { method: "POST", path: "/mtss-plans", guard: "requireSchool + Core", what: "Create plan" },
  { method: "GET", path: "/mtss-plans/probe/:studentId", guard: "requireSchool + Core", what: "Progress probe" },
  { method: "GET", path: "/mtss-reports/summary", guard: "requireSchool + Core", what: "Effectiveness" },
  { method: "GET / POST", path: "/safety-plans/library", guard: "requireSchool (POST: Core/GC)", what: "Library" },
  { method: "GET", path: "/safety-plans/student/:id", guard: "requireSchool", what: "Per-student" },
]);

apiBlock("ISS", [
  { method: "GET / POST", path: "/iss-roster", guard: "requireRosterMW", what: "Today's roster" },
  { method: "GET", path: "/iss-attendance", guard: "requireAttendanceMW", what: "Attendance sheet" },
  { method: "POST", path: "/iss-attendance/rollover", guard: "requireAttendanceMW", what: "Rollover absent" },
  { method: "PUT", path: "/iss-attendance/:id", guard: "requireAttendanceMW", what: "Update presence" },
]);

apiBlock("Displays / Signage", [
  { method: "GET", path: "/displays/playlists", guard: "requireSchool", what: "Manage playlists" },
  { method: "GET", path: "/displays/public/playlists/:id", guard: "public", what: "Render on TV" },
  { method: "GET", path: "/displays/public/passes/:schoolId", guard: "public", what: "Active passes" },
  { method: "POST", path: "/displays/playlists/:id/overrides", guard: "requireSchool + canManageDisplays", what: "Schedule override" },
]);

apiBlock("Parent Portal", [
  { method: "GET", path: "/parent/snapshot", guard: "parent token", what: "Live snapshot" },
  { method: "GET", path: "/parent/snapshot.pdf", guard: "parent token", what: "PDF export" },
  { method: "POST", path: "/parent-auth/login", guard: "public", what: "Email + password" },
  { method: "GET", path: "/admin/parent-invites", guard: "requireAdmin", what: "Invite list" },
  { method: "POST", path: "/admin/parent-invites/send", guard: "requireAdmin", what: "Bulk send" },
]);

apiBlock("Admin / Importer / Storage", [
  { method: "GET", path: "/admin/staff", guard: "requireAdminOrSuper", what: "Staff list" },
  { method: "PATCH", path: "/admin/staff/:id", guard: "requireAdminOrSuper", what: "Update roles" },
  { method: "POST", path: "/custom-roles", guard: "requireSuperUser", what: "Custom role" },
  { method: "GET", path: "/data-imports/jobs", guard: "requireImporter", what: "Import history" },
  { method: "POST", path: "/data-imports/students", guard: "requireImporter", what: "Trigger import" },
  { method: "POST", path: "/storage/uploads/request-url", guard: "signed-in staff", what: "Presigned upload" },
  { method: "GET", path: "/storage/objects/*", guard: "requireSchool + ACL", what: "Tenant-scoped fetch" },
  { method: "GET", path: "/storage/public-objects/*", guard: "public", what: "Branding etc." },
]);

apiBlock("Accommodations", [
  { method: "GET / POST", path: "/accommodation-logs", guard: "requireStaff", what: "Log + history" },
  { method: "GET / POST", path: "/school-accommodations", guard: "requireSchool (POST: ESE/Admin)", what: "Library" },
]);

newSection();

// === SECTION 7: CROSS-FEATURE DEPENDENCY MAP ===
H1("7. Cross-Feature Dependency Map");
P("Where one feature writes into or reads from another. Developers must keep these wired when refactoring.", { color: C.sub });
doc.moveDown(0.3);

table({
  columns: [
    { key: "src", label: "Source feature", w: 22 },
    { key: "act", label: "Action", w: 26 },
    { key: "tgt", label: "Target feature(s)", w: 28 },
    { key: "why", label: "Why", w: 24 },
  ],
  rows: [
    { src: "Watchlist Hub", act: "POST /alerts/check-in", tgt: "MTSS Plans + Tier 2 entries + Admin Notifications", why: "Turns alert into a tracked CICO plan and notifies BS + MTSS coord." },
    { src: "Watchlist Cases", act: "Witness statement request", tgt: "Email (Resend) + statement inbox for staff", why: "Collect statements from any staff who witnessed an event." },
    { src: "Hall Pass Queue", act: "Bell schedule period change", tgt: "Hall Pass Queue (auto-reset)", why: "Each period gets a clean line; falls back to 45-min buckets without a default schedule." },
    { src: "Data Importer", act: "Roster / FAST / behavior commit", tgt: "Teacher Roster, Insights dashboards, Watchlist, Parent Portal", why: "All downstream views read these tables; rollback supported." },
    { src: "PBIS awards", act: "Insert pbis_entry", tgt: "PBIS Hub, Houses signage, Heartbeat signage, Parent Portal recognition", why: "Live propagation of recognition events." },
    { src: "Hall passes", act: "Active pass / end pass", tgt: "Active Hall Pass display, Parent Portal hallPasses, Insights Behavior", why: "Operational visibility + parent transparency + analytics." },
    { src: "Tardies", act: "Tardy logged", tgt: "Parent Portal attendance, Insights Engagement, Watchlist alert rules", why: "Tardy spikes trigger Watchlist alerts." },
    { src: "Safety Plans", act: "Plan added/edited", tgt: "Teacher Roster (flag), Student Profile, Audit log", why: "Teachers see indicator; auditors see history." },
    { src: "Accommodations log", act: "Provided event", tgt: "Parent Portal accommodations, Student Profile", why: "Compliance and parent visibility." },
    { src: "Pullout request", act: "Submit request", tgt: "Verify Pullouts queue → Behavior Review", why: "Triage chain for behavioral intervention." },
    { src: "ISS roster", act: "Daily entry", tgt: "Admin Hub feed, Insights Behavior, Parent Portal attendance", why: "Discipline visibility across surfaces." },
    { src: "Displays mgmt", act: "Toggle showHeartbeat / showActiveHallPasses / showPbisHousePage", tgt: "Public signage URLs", why: "Per-playlist enablement of cross-feature widgets." },
    { src: "Parent invite", act: "Admin sends invite", tgt: "Parent Portal account creation via Resend email", why: "Onboarding handshake." },
    { src: "Staff Preview", act: "Admin starts session", tgt: "All scoped routes (impersonation context)", why: "QA and support — every read/write reflects the previewed role." },
    { src: "School plan (SU)", act: "Assign tier", tgt: "Feature flags across all artifacts", why: "Drives which features the school sees." },
  ],
});

H2("Notes for the dev team");
bullet("Every server route MUST go through requireSchool unless explicitly public. Multi-tenant isolation depends on req.schoolId.");
bullet("studentId and displayName are NOT globally unique — always scope queries by schoolId. Composite indexes are (school_id, column).");
bullet("More-specific routes must be registered before broader dynamic routes (avoid path shadowing).");
bullet("Cron jobs are gated on NODE_ENV plus EMAIL_REMINDERS_ENABLED and RESEND_FROM_ADDRESS. Verify both before relying on emails.");
bullet("Drizzle-kit db push can block on rename prompts — additive schema changes use direct ALTER TABLE in seed.ts.");
bullet("Names on public signage are masked to `First L.` to keep privacy on hallway TVs.");

// === SECTION 8: PER-ROLE QUICK REFERENCE ===
newSection();
H1("8. Per-Role Quick Reference");
P("Row-first companion to the matrix. For each role, the complete list of pages they can reach and the actions they can take in one place — useful for onboarding docs, support, and QA scripts.", { color: C.sub });
doc.moveDown(0.3);

function role({ name, who, sees, does, cannot }) {
  H3(name);
  P(`Who:  ${who}`, { color: C.sub, size: 9 });
  P(`Can see:  ${sees}`, { size: 9.5 });
  P(`Can do:  ${does}`, { size: 9.5 });
  if (cannot) P(`Cannot:  ${cannot}`, { color: C.warn, size: 9 });
  rule();
}

role({
  name: "SuperUser (SU)",
  who: "District-wide top-level operator. Replit/PulseEDU staff or district IT lead.",
  sees: "Everything in every school in the district. Tenancy, School Plans, Logo Generator, all Admin surfaces, all Insights, all Watchlist, all Stores, all Signage.",
  does: "Switch active school via override; grant/revoke any role or capability; create custom roles; assign feature tiers; impersonate any staff via Staff Preview; trigger imports.",
  cannot: "Reach a different district's data.",
});
role({
  name: "District Admin (DA)",
  who: "District-level administrator (no PulseEDU access).",
  sees: "All schools in their district: rosters, staff, imports, Admin Hub, Insights, Watchlist (per school).",
  does: "Manage staff and rosters across district schools; run district-wide imports; impersonate via Staff Preview.",
  cannot: "Edit School Plans, Tenancy, or other districts. Cannot manage SuperUsers.",
});
role({
  name: "School Admin",
  who: "Principal, AP, or designated school administrator.",
  sees: "Every page for their school: Insights Hub (all 6 dashboards), PBIS Hub, Watchlist, MTSS, Safety Plans, ISS, Displays, Settings, Staff Roles, Parent Portal admin, Branding.",
  does: "Manage staff roles & capabilities; configure bell schedules, kiosks, displays, branding; send parent invites; trigger imports; verify pullouts; edit safety plans; manage school store.",
  cannot: "Touch other schools. Cannot create custom roles (SU only).",
});
role({
  name: "Behavior Specialist / MTSS Coordinator / School Psychologist (Core Team)",
  who: "Tier 2/3 intervention staff and school psychologist.",
  sees: "All Insights dashboards, Watchlist Hub/Network/Cases, MTSS Plans, Safety Plans, Trusted Adults, PBIS Hub, Verify Pullouts, Behavior Review.",
  does: "Create/edit MTSS plans; manage interventions; run intervention reports; receive Watchlist check-in notifications; manage cases, players, witness statements; edit safety plans (Psych and standard staff).",
  cannot: "Manage staff roles, branding, displays (unless granted), kiosk setup, importer.",
});
role({
  name: "Guidance Counselor",
  who: "School counselor focused on safety and student support.",
  sees: "Safety Plans, Student Profile, Teacher Roster, basic PBIS / Hall Pass / Tardy logging.",
  does: "Manage safety plan library and per-student plans; log accommodations; award PBIS; issue hall passes.",
  cannot: "Access Insights dashboards, Watchlist, MTSS plans, ISS dashboard, admin settings.",
});
role({
  name: "Dean",
  who: "School dean / discipline lead.",
  sees: "ISS Reporting, Hall Pass log school-wide, Displays mgmt, Student Profile, basic logging.",
  does: "Manage signage; oversee ISS rolls; log hall passes/tardies/PBIS.",
  cannot: "Manage staff roles, MTSS plans, Insights dashboards (unless also Core Team).",
});
role({
  name: "PBIS Coordinator",
  who: "Staff member who owns the school's PBIS program.",
  sees: "PBIS Hub, PBIS Lists, PBIS reasons & milestone emails, School Store (browse + manage), Houses signage data.",
  does: "Configure PBIS reasons; set milestone emails; bulk awards; manage student/staff eligibility lists; edit school store catalog.",
  cannot: "Manage staff roles, branding, importer, MTSS plans.",
});
role({
  name: "ESE Coordinator",
  who: "ESE / 504 coordinator.",
  sees: "Accommodations library + logs, Teacher Roster, Hall Pass reports, Student Profile.",
  does: "Add/edit school accommodations; review accommodation logs; log basic teacher actions.",
  cannot: "Manage staff roles, MTSS plans, Watchlist, dashboards (unless Core Team).",
});
role({
  name: "ISS Teacher",
  who: "Teacher running the in-school suspension room.",
  sees: "ISS Dashboard (live), ISS Reporting, daily attendance sheet.",
  does: "Mark per-period presence, rollover absent students; adds notes; basic logging actions for own classroom.",
  cannot: "Edit ISS rosters across the school (Admin only); manage other teachers.",
});
role({
  name: "Teacher (default staff)",
  who: "Any signed-in staff with no elevated roles.",
  sees: "Hall Pass / Tardy tools, PBIS award, Log Intervention, Request Pullout, Classroom Store, Teacher Roster (own), Student Profile, My Watch List.",
  does: "Issue hall passes; tardy log; award PBIS; submit pullout requests; log interventions; record accommodations; edit own classroom store; PBIS milestones (read).",
  cannot: "School-wide hall pass log (cap), Insights dashboards, Watchlist, MTSS plans, Safety Plan editing, ISS dashboard, any settings.",
});
role({
  name: "Parent",
  who: "Verified parent linked to one or more students.",
  sees: "Snapshot dashboard for each linked student: PBIS recognition, hall passes, tardies, accommodations, staff notes, FAST scores, intervention/MTSS summary — only the sections admin enabled.",
  does: "Switch between linked children; download snapshot PDF; toggle own visible sections.",
  cannot: "See any other family's data; see any internal staff field; see Watchlist/Insights/Cases.",
});
role({
  name: "Kiosk (active device)",
  who: "Hallway kiosk activated with staff credentials.",
  sees: "Hall pass queue for its assigned room.",
  does: "Add students to the queue; issue passes for that room.",
  cannot: "Read student PII outside the queue; act outside its room.",
});
role({
  name: "Kiosk Viewer (QR display)",
  who: "Read-only hallway TV / QR-loaded screen.",
  sees: "Waiting queue list for the assigned room.",
  does: "Nothing — display only.",
  cannot: "Issue passes, mutate any state.",
});
role({
  name: "Public Signage / TV",
  who: "Unauthenticated hallway TVs running playlist or Heartbeat / Houses screens.",
  sees: "Playlist content; PBIS house standings; live pulse events with names masked to first + last initial; active hall pass list when admin enables it.",
  does: "Display only; pulls from /api/displays/public/*.",
  cannot: "Show full names; perform writes; reach private routes.",
});
role({
  name: "Anonymous / public",
  who: "Unauthenticated browser.",
  sees: "Login pages, parent invite acceptance, public branding assets, /api/healthz.",
  does: "Submit credentials.",
  cannot: "Reach any tenant data or staff routes.",
});

// Page numbers footer
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  doc.fontSize(8).fillColor(C.muted).font("Helvetica");
  doc.text(`PulseEDU Phase 1 — Roles & Access · Page ${i + 1} of ${range.count}`, 54, 760, { width: 504, align: "center" });
}

doc.end();
console.log("wrote", OUT);
