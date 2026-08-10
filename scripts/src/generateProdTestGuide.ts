// Generates docs/PulseEDU_Production_Test_Guide.pdf — precise end-to-end
// production QA checklist: where to go, what to click, expected results.

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(
  HERE,
  "..",
  "..",
  "docs",
  "PulseEDU_Production_Test_Guide.pdf",
);
mkdirSync(dirname(OUT), { recursive: true });

const C = {
  ink: "#0f172a",
  inkSoft: "#475569",
  inkFaint: "#94a3b8",
  brand: "#1d4ed8",
  accent: "#0e7490",
  ok: "#15803d",
  rule: "#cbd5e1",
  bgPanel: "#f1f5f9",
  bgOk: "#ecfdf5",
  bgWarn: "#fffbeb",
};

interface TestStep {
  action: string;
  expected: string;
}

interface TestCase {
  id: string;
  title: string;
  role: string;
  navigate: string;
  prereq?: string;
  steps: TestStep[];
  alsoVerify?: string[];
}

interface Chapter {
  title: string;
  intro?: string;
  tests: TestCase[];
}

const PROD_URL = "https://pulseedu.pulsekinetics.us";

const CHAPTERS: Chapter[] = [
  {
    title: "0. Before You Start",
    intro:
      "Complete this section once before module testing. Keep Chrome DevTools open (Network + Console) for every test.",
    tests: [
      {
        id: "PRE-01",
        title: "Environment & accounts",
        role: "You (tester)",
        navigate: `Production URL: ${PROD_URL}`,
        steps: [
          {
            action: "Hard-refresh the browser (Cmd+Shift+R / Ctrl+Shift+R).",
            expected: "Latest deployed client assets load; no stale JS errors in Console.",
          },
          {
            action:
              "Confirm three test personas exist: Teacher, Admin/Core Team, and one specialist (Behavior, MTSS, or ESE) if licensed.",
            expected: "Each can sign in without 500 errors on first dashboard load.",
          },
          {
            action: "Open DevTools → Network → filter Failed.",
            expected: "No burst of red requests immediately after login.",
          },
          {
            action:
              "Open a bug log (spreadsheet or doc). Columns: ID | Module | Role | Steps | Expected | Actual | Severity.",
            expected: "Ready to record failures as you go.",
          },
        ],
      },
      {
        id: "PRE-02",
        title: "Login smoke test",
        role: "Any staff",
        navigate: "/ (root) → sign-in screen",
        steps: [
          {
            action: "Enter staff email + password → Sign in.",
            expected:
              "Dashboard loads; school name visible; left sidebar renders with at least Hall Passes.",
          },
          {
            action: "Check Console for uncaught errors.",
            expected: 'No "t.map is not a function" or blank white screen.',
          },
          {
            action: "Sign out (profile/menu) → sign in again.",
            expected: "Session clears and re-authenticates cleanly.",
          },
        ],
      },
    ],
  },
  {
    title: "1. App Shell & Navigation",
    tests: [
      {
        id: "SHELL-01",
        title: "Sidebar — every visible item opens",
        role: "Teacher (repeat as Admin)",
        navigate: "Left sidebar after login",
        steps: [
          {
            action: "Click each sidebar item visible to this role, one at a time.",
            expected:
              "Each opens a real page (not blank). No dead-click into empty FeatureGate.",
          },
          {
            action: "Return to Hall Passes.",
            expected: "Default daily-ops landing works.",
          },
        ],
      },
      {
        id: "SHELL-02",
        title: "School switcher (if applicable)",
        role: "SuperUser or District Admin only",
        navigate: "Top bar → school name / switcher",
        steps: [
          {
            action: "Switch to a different school in the district.",
            expected: "All data refreshes for the new school context.",
          },
          {
            action: "Switch back to the test school.",
            expected: "Original school data restored.",
          },
        ],
      },
    ],
  },
  {
    title: "2. Hall Passes (Staff App)",
    tests: [
      {
        id: "HP-01",
        title: "Create a one-way hall pass",
        role: "Teacher or Admin",
        navigate: "Sidebar → Hall Passes",
        prereq: "Know a valid student Local SIS ID and a non-restroom destination.",
        steps: [
          {
            action: 'Click "+ Create Pass".',
            expected: "Create Pass modal opens.",
          },
          {
            action: "Enter student ID, pick origin room, pick destination, submit.",
            expected:
              'If off-allowlist destination: contact-ack prompt appears; acknowledge if required.',
          },
          {
            action: "Confirm pass created.",
            expected:
              'Student appears in "Out Right Now" with time-status color (not error).',
          },
        ],
        alsoVerify: [
          "Pass shows correct destination and student name.",
          'Filter "Mine & heading to me" includes pass you created (green stripe).',
        ],
      },
      {
        id: "HP-02",
        title: "End pass from staff app",
        role: "Teacher or Admin",
        navigate: "Hall Passes → Out Right Now",
        prereq: "HP-01 active pass exists.",
        steps: [
          {
            action: "End or check in the active pass from the staff UI.",
            expected: "Pass leaves Active list; moves to ended/history as designed.",
          },
        ],
      },
      {
        id: "HP-03",
        title: "Teacher kiosk settings (gear)",
        role: "Teacher",
        navigate: "Hall Passes → gear icon (left of Create Pass)",
        steps: [
          {
            action: 'Open gear → tab "Get kiosk URL".',
            expected: "Kiosk URL shown with Copy URL and Open buttons.",
          },
          {
            action: 'Click "Generate a new code".',
            expected:
              "QR code + 6-digit PIN appear (no server error). Old code invalidated.",
          },
          {
            action: "Scan QR with phone.",
            expected: "Phone opens /kiosk-code mirror page with activation QR.",
          },
        ],
      },
      {
        id: "HP-04",
        title: "Hall Pass reports (admin)",
        role: "Admin, SuperUser, or ESE Coordinator",
        navigate: "Hall Passes → Reports tab",
        steps: [
          {
            action: "Open Reports hub → Overview.",
            expected: "Metrics/charts load without 500.",
          },
          {
            action: "Open Daily / YTD / Research report.",
            expected: "Each report renders data or empty-state (not blank page).",
          },
        ],
      },
    ],
  },
  {
    title: "3. Hall Pass Kiosk (/kiosk)",
    intro:
      "Open /kiosk in a separate browser tab or Chromebook. Requires two rooms for full arrival test.",
    tests: [
      {
        id: "KIOSK-01",
        title: "Activate kiosk",
        role: "Teacher",
        navigate: `${PROD_URL}/kiosk`,
        prereq: "Fresh code from HP-03 or printed activation card.",
        steps: [
          {
            action: 'Tab "Use this camera" → scan phone /kiosk-code QR (or enter 6-digit PIN).',
            expected: "Room confirmation screen → kiosk activates.",
          },
          {
            action: "Confirm room matches teacher default room.",
            expected:
              'Live kiosk: room title, date/time, student ID field, "Get Pass" flow.',
          },
        ],
      },
      {
        id: "KIOSK-02",
        title: "Student creates pass on kiosk",
        role: "Kiosk (origin room)",
        navigate: "Activated /kiosk",
        steps: [
          {
            action: "Enter student Local SIS ID (or tap camera → scan badge).",
            expected: "Student resolves; destination dropdown enabled.",
          },
          {
            action: 'Select non-restroom destination → "Get Pass".',
            expected: "Green success screen + countdown timer starts.",
          },
        ],
        alsoVerify: [
          'Origin kiosk may show center "In route" card for that student.',
        ],
      },
      {
        id: "KIOSK-03",
        title: "Restroom queue — Get in line",
        role: "Kiosk (origin room)",
        navigate: "Activated /kiosk → right edge queue strip",
        prereq: "Restroom destination configured for this room.",
        steps: [
          {
            action: 'Click "Get in line" on right rail → enter student ID → add.',
            expected: "Student appears in queue list with position number.",
          },
          {
            action: "Previous student taps I'm back (if applicable).",
            expected: '"Next up" prompt or auto-advance for queued student.',
          },
        ],
      },
      {
        id: "KIOSK-04",
        title: "Restroom — Go now (line bypass)",
        role: "Kiosk",
        navigate: "Right rail → Go now",
        steps: [
          {
            action: "Go now → pick non-restroom destination → scan/enter student.",
            expected: "Immediate pass created; bypasses queue.",
          },
        ],
      },
      {
        id: "KIOSK-05",
        title: "Heading here — destination check-in",
        role: "Kiosk (destination room)",
        navigate: "Second /kiosk activated in DESTINATION room",
        prereq:
          "Active one-way pass from KIOSK-02 headed to this room (not restroom).",
        steps: [
          {
            action: "Wait up to 10s (queue poll) on destination kiosk.",
            expected:
              'Left rail "HEADING HERE" appears with student name chip.',
          },
          {
            action: "Student taps their name chip.",
            expected: "Badge-scan confirm overlay opens (does NOT end pass on tap alone).",
          },
          {
            action: "Scan matching student badge → confirm.",
            expected:
              'Green "Checked in [name]" banner; chip disappears from left rail; pass ended.',
          },
        ],
      },
      {
        id: "KIOSK-06",
        title: "I'm back (round-trip / restroom return)",
        role: "Kiosk (origin room)",
        navigate: "Origin /kiosk with active pass on this device",
        steps: [
          {
            action: 'Switch mode to return / tap "I\'m back" on timer screen.',
            expected: "Scan or enter ID → pass ends; timer clears.",
          },
        ],
      },
    ],
  },
  {
    title: "4. Tardy Pass & PBIS Points",
    tests: [
      {
        id: "TARDY-01",
        title: "Log a tardy",
        role: "Teacher",
        navigate: "Sidebar → Tardy Pass",
        steps: [
          {
            action: "Select student + period → submit.",
            expected: "Tardy saved; confirmation or list update.",
          },
        ],
      },
      {
        id: "PBIS-01",
        title: "Award PBIS points",
        role: "Teacher",
        navigate: "Sidebar → PBIS Points",
        steps: [
          {
            action: "Pick student → select reason → award points.",
            expected: "Points recorded; student/house totals update if visible.",
          },
        ],
      },
      {
        id: "PBIS-02",
        title: "House Rankings page",
        role: "Any staff with PBIS nav",
        navigate: "Sidebar → House Rankings (under PBIS group)",
        steps: [
          {
            action: "Open House Rankings.",
            expected: "Standings page renders (not blank); houses listed.",
          },
        ],
      },
    ],
  },
  {
    title: "5. Family Communication & PulseDNA",
    tests: [
      {
        id: "FC-01",
        title: "Family Communication hub",
        role: "Staff with Family Comm access",
        navigate: "Sidebar → Family Communication",
        steps: [
          {
            action: "Open section; browse student list or messages.",
            expected: "Page loads; student data visible (Local SIS ID, not internal IDs).",
          },
        ],
      },
      {
        id: "DNA-01",
        title: "PulseDNA profile",
        role: "Core Team + Family Comm license",
        navigate: "Family Communication → PulseDNA / studio area",
        steps: [
          {
            action: "Load or paste school communication profile → Save.",
            expected: "Profile persists on reload.",
          },
        ],
      },
      {
        id: "DNA-02",
        title: "Generate AI draft",
        role: "Core Team",
        navigate: "PulseDNA Studio → Generate draft",
        prereq: "Anthropic API key funded on server.",
        steps: [
          {
            action: "Enter rough idea + output type → Generate.",
            expected: "Draft text returns in UI (not 502). Error message clear if billing issue.",
          },
        ],
      },
      {
        id: "DNA-03",
        title: "Record PulseDNA video",
        role: "Core Team",
        navigate: "Open /studio in new tab from recording button",
        steps: [
          {
            action: "Allow camera/mic → record short clip → save.",
            expected: "Video attaches to PulseDNA workflow without opening file picker for camera.",
          },
        ],
      },
    ],
  },
  {
    title: "6. Teacher Roster & Benchmarks",
    tests: [
      {
        id: "ROSTER-01",
        title: "Roster search & student row",
        role: "Teacher",
        navigate: "Sidebar → Teacher Roster",
        steps: [
          {
            action: "Search for a student by name or ID.",
            expected: "Matching row appears; opens detail on click.",
          },
        ],
      },
      {
        id: "BENCH-01",
        title: "Benchmarks heatmap headers",
        role: "Teacher",
        navigate: "Teacher Roster → Benchmarks tab",
        steps: [
          {
            action: "Scroll heatmap horizontally and vertically.",
            expected: "Category column headers stay visible (not hidden behind cells).",
          },
          {
            action: "Click category header to expand/collapse.",
            expected: "Benchmark columns show/hide; layout intact.",
          },
        ],
      },
      {
        id: "BENCH-02",
        title: "Log instruction → counter increment",
        role: "Teacher",
        navigate: "Teacher Roster → Instruction Log tab",
        steps: [
          {
            action: "Log instruction for a benchmark (student + benchmark + save).",
            expected: "Entry saved without error.",
          },
          {
            action: "Return to Benchmarks tab → find same benchmark column.",
            expected: "Purple star / delivery count increased by 1.",
          },
        ],
        alsoVerify: [
          "Export Fast Benchmarks PDF — diagonal headers readable.",
        ],
      },
      {
        id: "PWP-01",
        title: "Partnering with Parents — upload & camera",
        role: "Core Team / licensed",
        navigate: "Sidebar → Partnering with Parents (if visible)",
        steps: [
          {
            action: "Add evidence → Attach file → pick document.",
            expected: "File uploads and appears in list.",
          },
          {
            action: "Add evidence → Take photo.",
            expected: "Browser camera opens (not Finder/file picker). Capture attaches photo.",
          },
        ],
      },
    ],
  },
  {
    title: "7. Interventions, MTSS & Behavior",
    tests: [
      {
        id: "INT-01",
        title: "Request Pullout",
        role: "Teacher",
        navigate: "Sidebar → Request Pullout",
        steps: [
          {
            action: "Submit pullout request for a student.",
            expected: "Request queued; confirmation shown.",
          },
        ],
      },
      {
        id: "INT-02",
        title: "Verify Pullouts",
        role: "Admin / specialist with verify cap",
        navigate: "Sidebar → Verify Pullouts (or Quick Access)",
        steps: [
          {
            action: "Open pending request → verify / acknowledge.",
            expected: "Status updates; MTSS acknowledgment gate works if configured.",
          },
        ],
      },
      {
        id: "INT-03",
        title: "Log Intervention",
        role: "Teacher",
        navigate: "Sidebar → Log Intervention",
        steps: [
          {
            action: "Log intervention for a student → save.",
            expected: "Appears under My Interventions.",
          },
        ],
      },
      {
        id: "MTSS-01",
        title: "MTSS Plans & reports",
        role: "MTSS Coordinator / Core Team",
        navigate: "Sidebar → MTSS Plans or MTSS Coordinator hub",
        steps: [
          {
            action: "Open active plan → view weekly log.",
            expected: "Plan data loads; T3 academic minutes display if applicable.",
          },
          {
            action: "Open MTSS reports.",
            expected: "Charts/tables render (not blank AVG SCORE / 0% with no data).",
          },
        ],
      },
      {
        id: "ISS-01",
        title: "ISS Dashboard",
        role: "Staff with ISS access",
        navigate: "Sidebar → ISS Dashboard",
        steps: [
          {
            action: "Open dashboard → view today's roster.",
            expected: "Seat capacity and student list load.",
          },
        ],
      },
    ],
  },
  {
    title: "8. Insights, PBIS Hub & School Store",
    tests: [
      {
        id: "INS-01",
        title: "Insights / Watchlist",
        role: "Admin / dean / specialist",
        navigate: "Sidebar → Insights or Watchlist Hub",
        steps: [
          {
            action: "Open watchlist → click a student.",
            expected: "Student profile drilldown loads.",
          },
        ],
      },
      {
        id: "HUB-01",
        title: "PBIS Hub — Needs Attention",
        role: "PBIS Coordinator / admin",
        navigate: "Sidebar → PBIS Hub",
        steps: [
          {
            action: "Open Needs Attention panel.",
            expected: "Alerts load per configured thresholds (invisible student tiers, etc.).",
          },
        ],
      },
      {
        id: "STORE-01",
        title: "School Store",
        role: "Teacher + admin",
        navigate: "Sidebar → School Store",
        steps: [
          {
            action: "Teacher: browse catalog → redeem item for student (if points).",
            expected: "Transaction completes or shows clear insufficient-points message.",
          },
          {
            action: "Admin: manage store items (if cap allows).",
            expected: "CRUD on items works.",
          },
        ],
      },
    ],
  },
  {
    title: "9. Settings (Admin)",
    intro: "Sidebar → Settings → click each tile below that applies to this school.",
    tests: [
      {
        id: "SET-01",
        title: "Kiosk Setup",
        role: "Admin",
        navigate: "Settings → Kiosk Setup",
        steps: [
          {
            action: "Verify kiosk URL copies; review rooms + teacher room assignments.",
            expected: "Rooms list populated; teacher rows have room dropdowns.",
          },
          {
            action: "Generate / print activation card for one teacher (optional).",
            expected: "PDF generates without error.",
          },
        ],
      },
      {
        id: "SET-02",
        title: "Locations & allowlists",
        role: "Admin",
        navigate: "Settings → Locations + Allowed Locations per Teacher",
        steps: [
          {
            action: "Open Locations → confirm origin/destination pairings.",
            expected: "Student-visible destinations exist for test rooms.",
          },
          {
            action: "Open teacher allowlist → save one teacher's destinations.",
            expected: "Kiosk destination list reflects change after refresh.",
          },
        ],
      },
      {
        id: "SET-03",
        title: "Bell schedule",
        role: "Admin",
        navigate: "Settings → School Bell Schedule",
        steps: [
          {
            action: "Open default schedule → view periods.",
            expected: "Periods listed; kiosk queue period reset tied to schedule.",
          },
        ],
      },
      {
        id: "SET-04",
        title: "Displays",
        role: "Admin",
        navigate: "Sidebar → Displays OR Settings → Signage",
        steps: [
          {
            action: "Create new display → upload image/slide → save playlist.",
            expected: "Upload succeeds; preview/slideshow shows new content.",
          },
          {
            action: "Open /signage player URL.",
            expected: "Slideshow plays on signage route.",
          },
        ],
      },
      {
        id: "SET-05",
        title: "Student ID Badges",
        role: "Admin",
        navigate: "Settings → Student ID Badges",
        steps: [
          {
            action: "Generate badge PDF for a grade or sample students.",
            expected: "PDF downloads with QR + Local SIS ID (no FLEID on face).",
          },
        ],
      },
      {
        id: "SET-06",
        title: "e-Sign",
        role: "Admin with e-sign cap",
        navigate: "Settings → Document e-Sign",
        steps: [
          {
            action: "Upload document → create signing link.",
            expected: "Link copies; opens public /sign/<token> page.",
          },
          {
            action: "Complete signature on public page.",
            expected: "Signed copy stored; no CSRF block on public route.",
          },
        ],
      },
      {
        id: "SET-07",
        title: "Parent Pick-Up",
        role: "Admin",
        navigate: "Settings → Parent Pick-Up",
        steps: [
          {
            action: "Copy curb / walker kiosk URLs.",
            expected: "URLs open /pickup routes.",
          },
          {
            action: "Test lookup with a valid pickup code on /pickup.",
            expected: "Student authorized/not authorized message displays correctly.",
          },
        ],
      },
      {
        id: "SET-08",
        title: "School Features & branding",
        role: "Admin",
        navigate: "Settings → School Features + Branding",
        steps: [
          {
            action: "Toggle one feature off → check sidebar.",
            expected: "Matching nav item hidden for all users including admin.",
          },
          {
            action: "Toggle back on; update branding color/logo → save.",
            expected: "Masthead/kiosk branding updates after refresh.",
          },
        ],
      },
      {
        id: "SET-09",
        title: "Staff & Roles",
        role: "Admin",
        navigate: "Sidebar → Staff & Roles",
        steps: [
          {
            action: "Open matrix → toggle one capability for a test user → save.",
            expected: "Test user sees/loses matching nav item on re-login.",
          },
        ],
      },
    ],
  },
  {
    title: "10. Standalone Routes",
    intro: "Test each URL directly in a browser tab (separate from main App.tsx shell).",
    tests: [
      {
        id: "URL-01",
        title: "/parent — Parent portal",
        role: "Parent (magic link)",
        navigate: "/parent",
        steps: [
          {
            action: "Open parent invite link → sign in.",
            expected: "Heartbeat snapshot loads for linked student(s).",
          },
        ],
      },
      {
        id: "URL-02",
        title: "/tour — School tours",
        role: "Public",
        navigate: "/tour",
        steps: [
          {
            action: "Submit tour request form.",
            expected: "Confirmation; request appears in admin tour pipeline.",
          },
        ],
      },
      {
        id: "URL-03",
        title: "/scan — Event tickets",
        role: "Staff or volunteer link",
        navigate: "/scan or /scan/<linkToken>",
        steps: [
          {
            action: "Scan or enter ticket QR.",
            expected: "Valid/invalid/admitted status shown.",
          },
        ],
      },
      {
        id: "URL-04",
        title: "/sms-policy",
        role: "Public",
        navigate: "/sms-policy",
        steps: [
          {
            action: "Page loads for AWS SNS toll-free registration.",
            expected: "Opt-in policy text renders.",
          },
        ],
      },
      {
        id: "URL-05",
        title: "Forgot password",
        role: "Staff",
        navigate: "/forgot-password",
        steps: [
          {
            action: "Submit registered email.",
            expected: "Success message (or email sent); no 500.",
          },
        ],
      },
    ],
  },
  {
    title: "11. Cross-Cutting & Sign-Off",
    tests: [
      {
        id: "X-01",
        title: "Upload paths",
        role: "Admin",
        navigate: "Displays, evidence, photos, e-sign",
        steps: [
          {
            action: "Upload image/PDF in each module used by the school.",
            expected: "All uploads succeed on production storage (no 403/502).",
          },
        ],
      },
      {
        id: "X-02",
        title: "Print / PDF exports",
        role: "Various",
        navigate: "Badges, benchmarks, onboarding, reports",
        steps: [
          {
            action: "Trigger each PDF/print action once.",
            expected: "PDF opens or downloads; layout not clipped.",
          },
        ],
      },
      {
        id: "X-03",
        title: "Mobile width",
        role: "Teacher",
        navigate: "Hall Passes + Create Pass modal",
        steps: [
          {
            action: "Resize browser to phone width (~390px).",
            expected: "Create Pass CTA and modals usable without horizontal scroll break.",
          },
        ],
      },
      {
        id: "DONE",
        title: "Definition of done",
        role: "You (tester)",
        navigate: "—",
        steps: [
          {
            action: "All P0/P1 bugs logged with steps + Network response.",
            expected: "Fixes deployed or documented as known issues before client handoff.",
          },
          {
            action: "Retest every failed case after deploy.",
            expected: "Pass recorded in bug log.",
          },
          {
            action: "Phase 2 (Hall Pass + Kiosk) and Phase 6 (Benchmarks) must pass.",
            expected: "Conference-critical paths green.",
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
  bufferPages: true,
  info: {
    Title: "PulseEDU Production Test Guide",
    Author: "PulseEDU",
    Subject: "End-to-end production QA checklist",
  },
});
const stream = createWriteStream(OUT);
doc.pipe(stream);

const F_BODY = "Helvetica";
const F_BOLD = "Helvetica-Bold";
const F_OBL = "Helvetica-Oblique";

function pageBreakIfNear(needed: number) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function startNewPageIfNotAtTop() {
  if (doc.y > doc.page.margins.top + 2) doc.addPage();
}

function chapterTitle(s: string) {
  doc.font(F_BOLD).fontSize(20).fillColor(C.brand).text(s);
  doc
    .moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .lineWidth(1)
    .strokeColor(C.rule)
    .stroke();
  doc.moveDown(0.4);
  doc.fillColor(C.ink);
}

function testHeader(tc: TestCase) {
  pageBreakIfNear(80);
  doc.moveDown(0.5);
  doc
    .font(F_BOLD)
    .fontSize(12)
    .fillColor(C.accent)
    .text(`${tc.id}  ${tc.title}`);
  doc.moveDown(0.15);
  doc.font(F_BOLD).fontSize(9).fillColor(C.inkSoft).text("Role: ", { continued: true });
  doc.font(F_BODY).fillColor(C.ink).text(tc.role);
  doc.font(F_BOLD).fontSize(9).fillColor(C.inkSoft).text("Go to: ", { continued: true });
  doc.font(F_BODY).fillColor(C.ink).text(tc.navigate);
  if (tc.prereq) {
    doc.font(F_BOLD).fontSize(9).fillColor(C.inkSoft).text("Prereq: ", { continued: true });
    doc.font(F_OBL).fontSize(9).fillColor(C.inkSoft).text(tc.prereq);
  }
  doc.moveDown(0.2);
}

function testStep(num: number, action: string, expected: string) {
  pageBreakIfNear(52);
  const left = doc.page.margins.left;
  const numW = 18;
  const colW = doc.page.width - doc.page.margins.right - left - numW;
  const y0 = doc.y;
  doc.font(F_BOLD).fontSize(10).fillColor(C.brand).text(`${num}.`, left, y0, {
    width: numW,
    lineBreak: false,
  });
  doc.font(F_BOLD).fontSize(10).fillColor(C.ink).text(action, left + numW, y0, {
    width: colW,
  });
  doc
    .font(F_BOLD)
    .fontSize(9)
    .fillColor(C.ok)
    .text("Expected: ", left + numW, doc.y, { continued: true, width: colW });
  doc.font(F_BODY).fontSize(9).fillColor(C.inkSoft).text(expected, { width: colW });
  doc.moveDown(0.15);
  doc.x = left;
}

function passFailLine() {
  pageBreakIfNear(14);
  doc
    .font(F_BODY)
    .fontSize(9)
    .fillColor(C.inkFaint)
    .text("Result:  [ ] Pass   [ ] Fail   Notes: _________________________________");
  doc.moveDown(0.35);
}

function bulletList(label: string, items: string[]) {
  if (items.length === 0) return;
  pageBreakIfNear(20 + items.length * 12);
  doc.font(F_BOLD).fontSize(9).fillColor(C.inkSoft).text(`${label}:`);
  for (const it of items) {
    doc.font(F_BODY).fontSize(9).fillColor(C.ink).text(`  • ${it}`);
  }
  doc.moveDown(0.15);
}

function drawFooters() {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const orig = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font(F_BODY).fontSize(8).fillColor(C.inkFaint);
    doc.text("PulseEDU Production Test Guide · Internal QA", doc.page.margins.left, doc.page.height - 36, {
      width: w,
      align: "left",
      lineBreak: false,
    });
    doc.text(`p. ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 36, {
      width: w,
      align: "right",
      lineBreak: false,
    });
    doc.page.margins.bottom = orig;
  }
}

// Cover
doc.fillColor(C.brand).font(F_BOLD).fontSize(34).text("PulseEDU");
doc.moveDown(0.15);
doc.fillColor(C.ink).fontSize(22).text("Production Test Guide");
doc.moveDown(0.35);
doc
  .font(F_OBL)
  .fontSize(11)
  .fillColor(C.inkSoft)
  .text(
    "End-to-end QA on production. Each test lists where to navigate, what to click, and the expected result. Mark Pass/Fail as you go.",
  );
doc.moveDown(0.5);
doc.font(F_BODY).fontSize(10).fillColor(C.ink).text(`Production URL: ${PROD_URL}`);
doc.text(`Generated: ${new Date().toISOString().slice(0, 10)}`);
doc.moveDown(1.2);
doc.font(F_BOLD).fontSize(12).fillColor(C.accent).text("Recommended order");
doc.moveDown(0.3);
doc.font(F_BODY).fontSize(10).fillColor(C.ink);
const order = [
  "0 → Prep & login smoke",
  "1 → Shell navigation",
  "2–3 → Hall Passes + Kiosk (highest priority)",
  "4–6 → Daily ops, roster, benchmarks",
  "7–8 → Interventions, insights, PBIS",
  "9 → Settings tiles (admin)",
  "10 → Standalone URLs",
  "11 → Cross-cutting sign-off",
];
for (const o of order) doc.text(`• ${o}`);
doc.moveDown(1);
doc.font(F_BOLD).fontSize(12).fillColor(C.accent).text("Contents");
doc.moveDown(0.25);
for (const ch of CHAPTERS) {
  doc.font(F_BOLD).fontSize(10).fillColor(C.ink).text(ch.title);
  for (const t of ch.tests) {
    doc.font(F_BODY).fontSize(9).fillColor(C.inkSoft).text(`   ${t.id}  ${t.title}`);
  }
  doc.moveDown(0.15);
}

// Body
for (const ch of CHAPTERS) {
  startNewPageIfNotAtTop();
  chapterTitle(ch.title);
  if (ch.intro) {
    doc.font(F_OBL).fontSize(10).fillColor(C.inkSoft).text(ch.intro);
    doc.moveDown(0.3);
  }
  for (const tc of ch.tests) {
    testHeader(tc);
    tc.steps.forEach((s, i) => testStep(i + 1, s.action, s.expected));
    bulletList("Also verify", tc.alsoVerify ?? []);
    passFailLine();
  }
}

drawFooters();
doc.end();

stream.on("finish", () => {
  console.log(`Wrote ${OUT}`);
});
