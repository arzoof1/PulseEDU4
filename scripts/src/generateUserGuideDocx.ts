import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlignmentType,
  Document,
  type FileChild,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TableOfContents,
  TextRun,
} from "docx";

// =============================================================================
// PulseEDU — complete User's Guide (Microsoft Word .docx).
//
// A staff-facing, plain-language walkthrough of every shipped module in the
// app. Each feature entry follows the same shape: who can use it, what it
// does, and how to use it. Run with: pnpm --filter @workspace/scripts run
// user-guide-docx
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
const OUT_PATH = path.join(repoRoot, "attached_assets/PulseEDU_User_Guide.docx");
if (!existsSync(path.dirname(OUT_PATH))) {
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
}

const BRAND = "0C4A6E";
const ACCENT = "0369A1";
const INK = "0F172A";
const SOFT = "475569";

interface Feature {
  title: string;
  who: string;
  what: string;
  how: string[];
}

interface Section {
  title: string;
  intro?: string;
  features: Feature[];
}

const SECTIONS: Section[] = [
  {
    title: "Getting Started — Roles, Access & Navigation",
    intro:
      "PulseEDU is a multi-tenant platform: every school's data is kept fully separate, and what each person sees depends on their role. Start here to understand who can do what and how to move around the app.",
    features: [
      {
        title: "Roles & access levels",
        who: "Everyone (assigned by an administrator)",
        what:
          "Access is role-based. SuperUsers operate district-wide. Administrators, Core Team members, counselors, front-office staff, and teachers are scoped to their school. Higher roles see more (for example, Core Team members can open any teacher's roster), while teachers see their own classes and the school-wide read-only tools.",
        how: [
          "Your role is set by an administrator and controls which sidebar items appear.",
          "If you can't see a feature described in this guide, your role likely doesn't include it — ask an administrator.",
          "Some tools (School Store, Insights) are visible to teachers as read-only and editable by admins.",
        ],
      },
      {
        title: "Signing in & navigating",
        who: "Everyone",
        what:
          "Staff sign in to the main app and use the left sidebar to move between modules. Specialized surfaces (digital signage, the parent portal, the pickup keypad, and public tour pages) each have their own web address.",
        how: [
          "Sign in with your staff account; the sidebar lists every module you have access to.",
          "The Admin Hub is the landing area for administrators, with at-a-glance tiles and nudges.",
          "Family- and device-facing pages live at their own paths: /parent, /signage, /pickup, and /tour.",
        ],
      },
      {
        title: "School setup & onboarding",
        who: "Administrators",
        what:
          "A guided onboarding checklist walks a new school through the setup steps it needs before key features work well — for example configuring a bell schedule before turning on the Hall Pass Queue.",
        how: [
          "Administrators follow the onboarding steps from the Admin Hub.",
          "Each step has a short explanation and a completion marker.",
          "Watch for nudge banners (e.g., 'configure a default bell schedule') that point to a setup gap.",
        ],
      },
      {
        title: "Bell schedules",
        who: "Administrators",
        what:
          "Bell schedules define your school's periods. Marking one as the default lets the Hall Pass Queue reset cleanly at each period change, giving every period a fresh line.",
        how: [
          "Go to School Settings → Bell Schedules.",
          "Create your schedule(s) and mark one as the default.",
          "Without a default, the hall-pass queue falls back to 45-minute idle buckets instead of period-aware resets.",
        ],
      },
    ],
  },
  {
    title: "Hall Pass & Tardy",
    intro:
      "Track who is out of the room, where they went, and how long they have been gone — and log late arrivals separately so tardy patterns are easy to spot.",
    features: [
      {
        title: "Live hall-pass queue",
        who: "Teachers (visible school-wide where enabled)",
        what:
          "A real-time view of every student currently out of the room, with timers. The queue auto-resets at each bell period so each period starts with a clean line.",
        how: [
          "Open Sidebar → Hall Passes to see the active queue.",
          "Timers turn yellow at 5 minutes and red at 10 minutes to flag long passes.",
          "Tap a row to close the pass when the student returns.",
        ],
      },
      {
        title: "Create a pass",
        who: "Teachers",
        what:
          "Issue a hall pass from a per-teacher list of allowed destinations, tailored to your room's location so the nearest restroom is one click away.",
        how: [
          "Click '+ New pass' and pick the student.",
          "Choose a destination from your allowed list.",
          "The pass appears in the live queue immediately.",
        ],
      },
      {
        title: "Tardy pass",
        who: "Teachers",
        what:
          "Log a late-to-class arrival without it counting against hall-pass minutes. Tardies feed the Behavior dashboard so you can see patterns over time.",
        how: [
          "From Hall Passes, switch to the Tardy tab.",
          "Pick the student and optionally a reason.",
          "Tardy logs flow into Insights → Behavior.",
        ],
      },
    ],
  },
  {
    title: "Behavior & PBIS",
    intro:
      "Recognize positive behavior, track points, run a fair school-wide house competition, and let students redeem points in two reward stores.",
    features: [
      {
        title: "PBIS Hub",
        who: "Teachers",
        what:
          "Your class-level positive-behavior center. Award points, see each student's house, and redeem rewards — all from one roster view.",
        how: [
          "Open Sidebar → PBIS Hub to see your roster with house badges.",
          "Tap a student card, pick a reason, and points post immediately.",
          "Cards show running totals and recent recognitions.",
        ],
      },
      {
        title: "PBIS Spotlight",
        who: "Teachers",
        what:
          "A random-student recognition draw with a built-in fairness governor (the 'Spotlight governor') that adjusts point pools when one house runs away with the lead, keeping the race competitive.",
        how: [
          "From the PBIS Hub, click 'Spotlight'.",
          "A student is drawn at random and the reveal shows the exact point value (1–10) awarded.",
          "The award is saved immediately — the value you see is the value recorded.",
        ],
      },
      {
        title: "House standings",
        who: "Everyone",
        what:
          "A live, school-wide house leaderboard. It powers the Spotlight fairness governor and the standings tile on signage TVs.",
        how: [
          "View it on the PBIS Hub or on any signage screen that includes the standings tile.",
          "Totals update in real time as points are awarded.",
        ],
      },
      {
        title: "School Store",
        who: "Administrators / PBIS coordinators edit; teachers redeem (read-only)",
        what:
          "A school-wide reward catalog. Admins manage items; teachers see it read-only and redeem from a student's points.",
        how: [
          "Open Sidebar → School Store.",
          "Admins click '+ Add item' to set an image, name, and point cost.",
          "Items go live to the whole school immediately.",
        ],
      },
      {
        title: "Classroom Store",
        who: "Teachers",
        what:
          "Each teacher's own reward catalog, separate from the School Store and fully under your control.",
        how: [
          "Open Sidebar → Classroom Store.",
          "Add items, set point costs, and track in-stock counts.",
          "Redeem directly from a student's PBIS Hub card.",
        ],
      },
    ],
  },
  {
    title: "Safety Plans",
    intro:
      "Per-student behavioral and physical safety checklists, backed by an approved library and a full audit trail.",
    features: [
      {
        title: "Safety plan list & viewing",
        who: "All staff can view; counselors and Core Team edit",
        what:
          "A directory of active safety plans. Plans are also indexed on the student profile and within teacher rosters so the right staff see them in context.",
        how: [
          "Sidebar → Safety Plans to see all active plans.",
          "Indicators appear on student profiles and teacher rosters.",
          "Every change is captured in an audit log.",
        ],
      },
      {
        title: "Safety plan editor",
        who: "Guidance counselors and Core Team",
        what:
          "A checklist editor backed by a shared library of approved items. Add or remove rows, attach notes, and set effective dates.",
        how: [
          "From the plan list, open a student to edit.",
          "Pick items from the library or add custom rows.",
          "Saving publishes the plan to the student's profile.",
        ],
      },
    ],
  },
  {
    title: "MTSS Intervention Plans",
    intro:
      "Track Tier 2 and Tier 3 intervention plans with goals, weekly progress monitoring, and close-out reports.",
    features: [
      {
        title: "Intervention plans",
        who: "MTSS coordinators / Core Team",
        what:
          "Create and manage Tier 2/3 plans with goal setting, strategy categories, and a tier-aware launcher. A bell notification system reminds you when check-ins are due.",
        how: [
          "Sidebar → MTSS Plans to see active plans.",
          "Open a plan to set the goal, frequency, and strategy.",
          "Notifications fire when a weekly check-in is due.",
        ],
      },
      {
        title: "Progress monitoring & completion reports",
        who: "MTSS coordinators / Core Team",
        what:
          "A weekly progress chart with trend and goal lines. When a plan closes, it generates a completion report.",
        how: [
          "From a plan, open the Progress tab.",
          "Add weekly data points; the chart updates automatically.",
          "Close the plan to produce a completion report.",
        ],
      },
    ],
  },
  {
    title: "Teacher Roster",
    intro:
      "A single view of each teacher's students with assessment scores, program flags, safety indicators, and multi-year FAST history.",
    features: [
      {
        title: "Roster overview",
        who: "Teachers; Core Team can view any teacher's roster",
        what:
          "Your class roster combining FAST scores, ESE/504/ELL program flags, and safety-plan indicators in one place.",
        how: [
          "Sidebar → Roster.",
          "Click any student to open their full profile.",
          "Core Team members can switch to any teacher's roster.",
        ],
      },
      {
        title: "Multi-year FAST history",
        who: "Teachers and Core Team",
        what:
          "A history chip showing each student's FAST results across recent years, surfaced on the roster, student profile, and MTSS plan editor for trajectory context.",
        how: [
          "Look for the FAST history chip on a student's roster row or profile.",
          "The number of visible years is set per school (default 3).",
          "Use it to see growth or decline over time when making decisions.",
        ],
      },
      {
        title: "Group Insights tab",
        who: "Teachers of intensive-flagged sections; Core Team",
        what:
          "For intensive-group sections, a tab showing the section's profile, recommended focus standards, suggested sub-groupings, and progress-monitoring drift between windows.",
        how: [
          "Open the Group Insights tab on a qualifying section's roster.",
          "Review the recommended focus standards and sub-groupings.",
          "This is read-only insight — your roster source of record is unchanged.",
        ],
      },
    ],
  },
  {
    title: "Insights Dashboards",
    intro:
      "A suite of analytics dashboards turning your data into trends, top-N lists, and drill-downs — with grade/window filters and demographic disaggregation for equity.",
    features: [
      {
        title: "Dashboard suite (Engagement, Behavior, Academics, SEB/SEL, Equity, Early Warning)",
        who: "Administrators and Core Team (teachers see permitted views)",
        what:
          "Six dashboards covering attendance/engagement, behavior, academics, social-emotional indicators, equity gaps, and a composite early-warning risk list. Each supports filtering and click-through to student profiles.",
        how: [
          "Sidebar → Insights, then pick a dashboard.",
          "Filter by grade and time window; charts re-aggregate in place.",
          "Disaggregate by demographic to surface gaps, and click any student to drill in.",
        ],
      },
      {
        title: "Class Composer",
        who: "Administrators and Core Team (read-only)",
        what:
          "Proposes intensive-group sections from FAST item-level weakness using several modes (including skill-cluster). Produces deterministic groups with a dominant skill focus and a cohesion percentage, with print and CSV export. It never writes back to your roster system.",
        how: [
          "Insights → Class Composer.",
          "Pick a grouping mode and review the proposed groups, focus skills, and cohesion.",
          "Export to print or CSV; your student-information system stays the source of truth.",
        ],
      },
    ],
  },
  {
    title: "Display Management (Digital Signage)",
    intro:
      "Run your hallway and classroom TVs with per-school playlists mixing media and live tiles like house standings and active hall passes.",
    features: [
      {
        title: "Playlist editor",
        who: "Administrators",
        what:
          "Build playlists for signage TVs from images, video, audio, PDFs, and live tiles (PBIS standings, active hall passes, Heartbeat). Includes scheduling.",
        how: [
          "Sidebar → Displays.",
          "Create a playlist, add items, and set each item's duration.",
          "Schedule a playlist to a specific TV by location.",
        ],
      },
      {
        title: "Live signage view",
        who: "Everyone (TV display)",
        what:
          "The page a TV opens to. It rotates through scheduled items and refreshes live tiles on their own cadence.",
        how: [
          "Point the TV's browser at the signage page for that playlist.",
          "The playlist starts automatically; live tiles update on their own.",
        ],
      },
    ],
  },
  {
    title: "Parent Portal",
    intro:
      "A secure place for parents to follow their student's HeartBEAT data, with admin-managed access and PDF export.",
    features: [
      {
        title: "Parent portal",
        who: "Parents",
        what:
          "Lets parents view their student's PBIS, hall passes, tardies, accommodations, and staff notes. Supports sibling switching, per-school section visibility, and PDF export of reports.",
        how: [
          "Parents log in at the parent portal using an admin-issued invite.",
          "A sibling switcher lets one parent view multiple children.",
          "Schools control which sections are visible; parents can export a PDF report.",
        ],
      },
      {
        title: "Invites & access management",
        who: "Administrators",
        what:
          "Issue parent portal invitations and reset access when a parent loses their login.",
        how: [
          "Settings → Parent invites.",
          "Send an invite to the guardian's email of record.",
          "Reset access from the same screen if needed.",
        ],
      },
    ],
  },
  {
    title: "Data Importer",
    intro:
      "Bring assessment, roster, and behavior data into PulseEDU from CSV files, with a safe preview-and-rollback workflow.",
    features: [
      {
        title: "CSV import with preview & rollback",
        who: "Administrators",
        what:
          "A generic importer supporting assessments, rosters, and behavior data. Map your file to a template, preview the parsed rows, commit, and roll back a run if needed.",
        how: [
          "Settings → Data Importer.",
          "Choose the template that matches your file, then upload.",
          "Preview the parsed rows, commit, and keep the rollback link for that run.",
        ],
      },
    ],
  },
  {
    title: "School Tours & Enrollment Leads",
    intro:
      "A complete enrollment-marketing toolkit: a public, bilingual 'brag page', a tour-request form, a sales-style lead pipeline, and a set of print forms for the visit.",
    features: [
      {
        title: "Public brag page (bilingual EN/ES)",
        who: "Families (public); administrators edit",
        what:
          "Each school's public, mobile-friendly page showcasing programs, electives, what you're proud of, flyers, and photos. Admin-written text is auto-translated to Spanish when a family flips the language toggle.",
        how: [
          "Administrators edit the page content from the Tours settings.",
          "Upload labeled flyers (shown at the top) and photos (carousel at the bottom).",
          "Families open it from a flyer QR code or a shared link and can switch to Spanish.",
        ],
      },
      {
        title: "Request-a-tour form & checkpoints",
        who: "Families (public); administrators configure",
        what:
          "Families request a tour and tick which 'checkpoints' (stops) they'd like to see — for example a specific program — plus an optional free-text note. Administrators configure the checkpoint list per school.",
        how: [
          "Admins add Tour Checkpoints (label + staff-only location, talking points, and minutes) in Tours settings.",
          "Families pick the stops they care about and submit the form.",
          "Their selections attach to the lead and drive the print forms below.",
        ],
      },
      {
        title: "Lead pipeline",
        who: "Administrators, Core Team, counselors, front office",
        what:
          "A sales-style pipeline (New → Contacted → Scheduled → Toured → Closed) with outcomes (Enrolled / Deciding / Chose elsewhere), assignable owners, an event timeline, a response-time/overdue clock, family auto-acknowledgement, and email/in-app notifications.",
        how: [
          "Open the School Tours tile in Settings to see the pipeline.",
          "Assign an owner, log contact and notes, and move the lead through the stages.",
          "Record the outcome at close-out; the conversion report ties outcomes to enrollment.",
        ],
      },
      {
        title: "Print form — Brag Sheet (staff)",
        who: "Tour-managing staff",
        what:
          "A one-page staff cheat sheet with the family's details and the checkpoints they want to see, so the guide can personalize the visit.",
        how: [
          "Open the lead and click the Brag Sheet (PDF) download.",
          "Review the family's selected stops and any 'anything else' note.",
          "Open the downloaded file to print.",
        ],
      },
      {
        title: "Print form — Tour Roadmap (staff)",
        who: "Tour-managing staff",
        what:
          "The guide's detailed game plan: prep info up top, then a check-off walklist of exactly the stops the family chose, each with its location, talking points, estimated minutes, and blank lines to fill in during the walk.",
        how: [
          "Open the lead and click the Tour Roadmap (PDF) download.",
          "Use the prep info to get ready, then follow the check-off list on the walk.",
          "This is the internal version and includes staff-only stop details.",
        ],
      },
      {
        title: "Print form — Family Note Catcher (family)",
        who: "Tour-managing staff (handed to the family)",
        what:
          "A take-along sheet for the family with general tour info and a labelled note area for each stop they chose, plus a general follow-up section and your contact details. It shows only the stop name — never the staff-only details.",
        how: [
          "Open the lead and click the Family Note Catcher (PDF) download.",
          "Hand it to the family at the start of the visit so they can jot questions.",
          "Their selected stops appear as labelled note areas.",
        ],
      },
      {
        title: "Print form — Share Your Feedback page (family)",
        who: "Tour-managing staff (handed to the family)",
        what:
          "A warm, single-page handout the family takes home at the end, anchored by a large QR code that opens their personalized post-tour survey, plus your contact info and optional district branding.",
        how: [
          "Open the lead and click the Share Your Feedback page (PDF) download.",
          "Give it to the family at the end of the tour.",
          "Publish the app first so the QR points to your live site, not the preview.",
        ],
      },
      {
        title: "District branding & conversion reporting",
        who: "SuperUser (branding); administrators (reports)",
        what:
          "A SuperUser sets district logo and tagline once for every school to inherit, with placement toggles. An outcome-to-enrollment conversion report shows how tours turn into students.",
        how: [
          "A SuperUser sets the district logo/tagline and placement toggles.",
          "Administrators review the conversion report from the Tours area.",
        ],
      },
    ],
  },
  {
    title: "Parent Pick-Up Module",
    intro:
      "Run a safe, fast dismissal with a curb keypad, a walker gate, tag management, and end-of-day reconciliation.",
    features: [
      {
        title: "Curb keypad",
        who: "Front office and pickup-authorized staff",
        what:
          "A phone-first numeric keypad at the curb. A parent's tag number rolls up exactly the students they're authorized to collect; restricted tags require a justification override.",
        how: [
          "Open a kiosk to the pickup curb page.",
          "Type the parent's tag number; authorized students appear.",
          "Tap each student to release to the car (override restricted tags with a reason).",
        ],
      },
      {
        title: "Walker gate",
        who: "Front office and pickup-authorized staff",
        what:
          "A dismissal gate for walkers that enforces the bell window, so walkers can't be released before dismissal opens.",
        how: [
          "Open the pickup walkers page.",
          "Before the window, the gate shows a 'not yet open' banner.",
          "Inside the window, release walkers individually.",
        ],
      },
      {
        title: "Tag management",
        who: "Administrators",
        what:
          "Issue and reissue parent pickup tags: bulk start-of-year assignment, lost-tag reissue, guardian splits, and single or batch QR tag PDFs, with a capacity warning as the number range fills.",
        how: [
          "Settings → Pickup Tags.",
          "Use 'Bulk start-of-year' to assign every active student's primary guardian.",
          "Print single or batch tag sheets; a warning fires at 80% of the range.",
        ],
      },
      {
        title: "Still-on-campus reconciliation",
        who: "Administrators",
        what:
          "An Admin Hub tile after the dismissal cutoff that groups students still on campus by dismissal mode so the office can clear the building.",
        how: [
          "After the cutoff, the tile appears on the Admin Hub.",
          "Students are grouped by mode (bus, car, walker, after-school).",
          "Resolve each row as picked up or moved to after-school care.",
        ],
      },
    ],
  },
  {
    title: "Behavior Support — Consistency Check & AST",
    intro:
      "Tools that support fair, consistent behavior practice and staff scheduling.",
    features: [
      {
        title: "AI Consistency Check",
        who: "Core Team",
        what:
          "A guardrailed check that helps Core Team review behavior handling for consistency, surfaced through a header indicator and a side panel.",
        how: [
          "Core Team members access the Consistency Check from its header indicator.",
          "Review findings in the side panel.",
          "It is a support tool — Core Team remains the decision-maker.",
        ],
      },
      {
        title: "AST (Alternate Schedule Time)",
        who: "Administrators and affected staff",
        what:
          "Tracks alternate schedule time for staff with a running ledger and a year-end lapse process.",
        how: [
          "View your AST balance in your own AST view.",
          "Administrators manage the ledger and year-end lapse.",
        ],
      },
    ],
  },
  {
    title: "Administration & District Tools",
    intro:
      "Behind-the-scenes controls for administrators and district SuperUsers: staff and roles, school/district management, feature plans, and health monitoring.",
    features: [
      {
        title: "Staff & Roles",
        who: "Administrators",
        what:
          "Manage staff accounts and their roles, which determine what each person can see and do across the app.",
        how: [
          "Settings → Staff & Roles.",
          "Add staff, assign roles, and reset temporary passwords as needed.",
        ],
      },
      {
        title: "Feature plans & licensing",
        who: "SuperUser / administrators",
        what:
          "Schools run on plans that enable feature sets, with per-school overrides and a bulk feature picker. This controls which modules are turned on.",
        how: [
          "A SuperUser sets each school's plan; admins can apply per-school overrides where allowed.",
          "Use the bulk feature picker to turn sets of features on or off.",
        ],
      },
      {
        title: "District & school management",
        who: "SuperUser",
        what:
          "Create, edit, and retire districts and schools, and onboard a new school into an existing district, with district-level overview rollups.",
        how: [
          "From the SuperUser area, add or edit districts and schools.",
          "Use 'Onboard a School' to add a school to an existing district.",
          "Review district overview rollups for a cross-school picture.",
        ],
      },
      {
        title: "Audit & Health panel",
        who: "SuperUser",
        what:
          "A district-level panel summarizing audit activity and system health across schools.",
        how: [
          "Open the SuperUser Audit & Health panel.",
          "Review activity and health indicators for each school.",
        ],
      },
      {
        title: "Kiosk device enrollment (Hall Pass)",
        who: "Administrators and teachers",
        what:
          "Enroll a shared classroom device as a kiosk for hall-pass workflows, using a QR/PIN confirmation flow.",
        how: [
          "From the kiosk page, scan the QR or enter the PIN to enroll the device.",
          "Confirm on first scan; the device is then tied to the room.",
        ],
      },
    ],
  },
];

function featureChildren(f: Feature, instance: number): Paragraph[] {
  const out: Paragraph[] = [];
  out.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 80 },
      children: [new TextRun({ text: f.title, bold: true, color: ACCENT })],
    }),
  );
  out.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({ text: "Who can use it: ", bold: true, color: BRAND }),
        new TextRun({ text: f.who, color: INK }),
      ],
    }),
  );
  out.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({ text: "What it does: ", bold: true, color: BRAND }),
        new TextRun({ text: f.what, color: INK }),
      ],
    }),
  );
  out.push(
    new Paragraph({
      spacing: { before: 20, after: 20 },
      children: [new TextRun({ text: "How to use it:", bold: true, color: BRAND })],
    }),
  );
  for (const step of f.how) {
    out.push(
      new Paragraph({
        numbering: { reference: "how-steps", level: 0, instance },
        spacing: { after: 20 },
        children: [new TextRun({ text: step, color: INK })],
      }),
    );
  }
  return out;
}

const generatedOn = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const totalFeatures = SECTIONS.reduce((n, s) => n + s.features.length, 0);

const coverChildren: Paragraph[] = [
  new Paragraph({ spacing: { before: 2400 }, children: [] }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "PulseEDU", bold: true, size: 84, color: BRAND })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120 },
    children: [new TextRun({ text: "User's Guide", size: 44, color: ACCENT })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 80 },
    children: [
      new TextRun({
        text: "Complete Feature Reference for School Staff",
        size: 24,
        color: SOFT,
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 1200 },
    children: [
      new TextRun({
        text: `${SECTIONS.length} modules · ${totalFeatures} features · Generated ${generatedOn}`,
        size: 20,
        color: SOFT,
      }),
    ],
  }),
];

const introChildren: FileChild[] = [
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: "How this guide is organized", bold: true, color: BRAND })],
  }),
  new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({
        text:
          "This guide covers every module in PulseEDU, grouped by area. Each feature entry tells you who can use it, what it does, and the steps to use it. Because access is role-based, you may not see every feature listed here — what appears in your sidebar depends on the role your administrator assigned you.",
        color: INK,
      }),
    ],
  }),
  new Paragraph({
    spacing: { after: 200 },
    children: [
      new TextRun({
        text:
          "Tip: The table of contents below is clickable in Word. If page numbers look out of date, right-click the table and choose 'Update Field'.",
        italics: true,
        color: SOFT,
      }),
    ],
  }),
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 120, after: 120 },
    children: [new TextRun({ text: "Contents", bold: true, color: BRAND })],
  }),
  new TableOfContents("Contents", {
    hyperlink: true,
    headingStyleRange: "1-2",
  }),
];

const bodyChildren: Paragraph[] = [];
let featureInstance = 0;
for (const section of SECTIONS) {
  bodyChildren.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
      children: [new TextRun({ text: section.title, bold: true, color: BRAND })],
    }),
  );
  if (section.intro) {
    bodyChildren.push(
      new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({ text: section.intro, italics: true, color: SOFT })],
      }),
    );
  }
  for (const f of section.features) {
    bodyChildren.push(...featureChildren(f, featureInstance));
    featureInstance += 1;
  }
}

const doc = new Document({
  creator: "PulseEDU",
  title: "PulseEDU — User's Guide",
  description: "Complete feature reference for school staff",
  features: { updateFields: true },
  numbering: {
    config: [
      {
        reference: "how-steps",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 460, hanging: 260 } } },
          },
        ],
      },
    ],
  },
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22, color: INK } },
    },
  },
  sections: [
    {
      children: [
        ...coverChildren,
        new Paragraph({ pageBreakBefore: true, children: [] }),
        ...introChildren,
        ...bodyChildren,
      ],
    },
  ],
});

const buf = await Packer.toBuffer(doc);
writeFileSync(OUT_PATH, buf);
console.log(`Wrote ${OUT_PATH} (${SECTIONS.length} sections, ${totalFeatures} features)`);
