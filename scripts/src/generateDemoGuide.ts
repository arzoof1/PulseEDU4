// Generates PulseEDU_Demo_Guide.pdf — a complete, step-by-step
// walkthrough of the entire app for a new-school demo / onboarding.
// Organized as a guided tour: who-to-show-when, where-to-click,
// and what-to-say. Modeled after the existing Core Team / Teacher
// user guides in this folder.

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "attached_assets", "PulseEDU_Demo_Guide.pdf");
mkdirSync(dirname(OUT), { recursive: true });

const C = {
  ink: "#0f172a",
  inkSoft: "#475569",
  inkFaint: "#94a3b8",
  brand: "#1d4ed8",
  accent: "#0e7490",
  rule: "#cbd5e1",
  ok: "#15803d",
  warn: "#b45309",
  bgPanel: "#f1f5f9",
  bgTip: "#ecfdf5",
  bgWarn: "#fffbeb",
  bgRole: "#eff6ff",
};

interface Step {
  action: string;
  detail?: string;
}
interface Feature {
  title: string;
  audience: string;
  whereToFind: string;
  whatItIs: string;
  demoScript?: string;
  steps: Step[];
  tips?: string[];
  watchOutFor?: string[];
}
interface Chapter {
  title: string;
  intro?: string;
  features: Feature[];
}

// =========================================================================
// CONTENT
// =========================================================================

const CHAPTERS: Chapter[] = [
  // -------------------------------------------------------------------
  {
    title: "1. Before You Demo",
    intro:
      "A 30-second prep so the demo lands. Skim this once, then never again.",
    features: [
      {
        title: "What PulseEDU Is",
        audience: "You (the demonstrator).",
        whereToFind: "—",
        whatItIs:
          "PulseEDU is one school-operations app that replaces 6–10 single-purpose tools: digital signage, hall pass, PBIS / house points and store, safety plans, MTSS tier-2/3 intervention plans, parent portal, parent pickup line, insights dashboards, data importing, and behavior investigations. It is multi-tenant — every district / school / role sees a different slice.",
        steps: [
          { action: "One product, many roles.", detail: "Teachers, admins, counselors, PBIS coordinators, MTSS coordinators, deans, ESE coordinators, behavior specialists, front-office, parents, and a 'SuperUser' for the district all log into the same app and see only what they're entitled to." },
          { action: "Multi-tenant by school.", detail: "Every record (student, plan, point, pass, tag) is scoped to a school_id. A district admin can switch schools; a teacher cannot see students from another school." },
          { action: "Feature licensing.", detail: "Districts can turn whole modules on or off per school (e.g. one school uses Pickup, another doesn't). What the demo audience sees is governed by the school's plan." },
        ],
        tips: [
          "Demo against a seeded school with realistic-looking names (not 'Test Student 1'). The seed script creates one.",
          "Open with the Admin Hub — the audience is almost always an admin or a Core Team member with admin-ish vision.",
        ],
      },
      {
        title: "Suggested 30-Minute Demo Order",
        audience: "You.",
        whereToFind: "—",
        whatItIs:
          "A proven order that flows from 'what the audience sees today' to 'what they get tomorrow.' Skip any section that doesn't apply to that school's plan.",
        steps: [
          { action: "Minute 0–2 — Login & sidebar.", detail: "Land on Admin Hub. Point out role-based sidebar." },
          { action: "Minute 2–6 — Hall Pass + Digital Signage.", detail: "These are visible / visceral. They sell the rest." },
          { action: "Minute 6–11 — PBIS Hub + Spotlight + School Store.", detail: "The 'culture' loop teachers love." },
          { action: "Minute 11–15 — Parent Pick-Up Module.", detail: "Curb keypad → tag → walker gate. Always gets the room talking." },
          { action: "Minute 15–20 — MTSS Plans + Safety Plans + Teacher Roster.", detail: "The 'student support' core. Teacher Roster is where everything converges." },
          { action: "Minute 20–24 — Parent Portal.", detail: "Open the invite flow. Open the parent view. Show the PDF export." },
          { action: "Minute 24–28 — Insights Dashboards + Data Importer.", detail: "Numbers + how data gets in." },
          { action: "Minute 28–30 — Onboarding + Settings Hub.", detail: "Close with 'this is your first week of setup.' De-risks the buy." },
        ],
        tips: [
          "Resist the urge to show every screen. The point is to make the buyer trust that the screens they didn't see also work.",
          "Always end on Onboarding — it shows the path forward, not a wall of features.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "2. Logging In & The Sidebar",
    intro:
      "The first 30 seconds the audience sees. Get them comfortable with where everything lives.",
    features: [
      {
        title: "Sign In",
        audience: "All users.",
        whereToFind: "/ (root) when signed out → redirected to login.",
        whatItIs:
          "Email + temp password on first login, then a password reset. Admins can reset any staff member to a fresh temp password from Staff & Roles.",
        steps: [
          { action: "Open the app URL in a browser tab.", detail: "If the staff member's email is registered, they're prompted for a password." },
          { action: "First-time login uses the temp password the admin set.", detail: "Force-change is built in." },
          { action: "After login, you land on the role's default home.", detail: "Teachers land on Teacher Hub; Admins on Admin Hub; SuperUsers on SuperUser Home." },
        ],
        tips: [
          "If a staff member is stuck, an admin can issue a fresh temp password from Admin Hub → Staff & Roles → row menu → 'Reset to temp password.'",
        ],
      },
      {
        title: "Read the Sidebar",
        audience: "All users.",
        whereToFind: "Left rail.",
        whatItIs:
          "The sidebar is role-aware — it never shows something the user can't open. Sections collapse so the rail stays short.",
        steps: [
          { action: "Top section: today's work.", detail: "Hub (Admin / Teacher / PBIS / MTSS Coordinator), Hall Pass, Student Search, PBIS." },
          { action: "Middle section: student support.", detail: "Safety Plans, MTSS Plans, Intervention Reports, Trusted Adults." },
          { action: "Operational tools.", detail: "Display Management (signage), Pickup, Bell Schedules, Cameras, Data Importer." },
          { action: "Insights.", detail: "Engagement / Behavior / Academics / SEB-SEL / Equity / Early Warning dashboards." },
          { action: "Admin & Tenancy.", detail: "Settings, Onboarding, Staff & Roles, Parent Access, District Admin, SuperUser Home." },
        ],
        tips: [
          "If an item is missing for a logged-in user, it's a role-flag question — not a bug. See chapter 3.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "3. Roles & Who Sees What",
    intro:
      "Buyers always ask this. Keep this page open in a second tab during the demo.",
    features: [
      {
        title: "Role-by-Role Cheat Sheet",
        audience: "Buyer / admin.",
        whereToFind: "Reference only.",
        whatItIs:
          "Every staff user can carry multiple role flags. The sidebar shows the UNION of everything those flags unlock.",
        steps: [
          { action: "SuperUser.", detail: "District-wide. Sees every school, every feature. Manages tenancy, plans, license toggles." },
          { action: "District Admin.", detail: "Sees every school in the district as an Admin. Cannot edit tenancy." },
          { action: "Admin.", detail: "Full school admin: Settings, Staff & Roles, Hall Pass admin, PBIS admin, Pickup admin, Investigations, ISS dashboard, Onboarding." },
          { action: "Behavior Specialist / Dean / MTSS Coordinator / ESE Coordinator.", detail: "Core Team. See Investigations, MTSS Plans (most), Safety Plans (view + edit for Counselor/MTSS), behavior list admin, Verify Pullouts." },
          { action: "Guidance Counselor / School Psychologist.", detail: "Safety Plans (edit). Counselor also gets Pickup tag management." },
          { action: "PBIS Coordinator.", detail: "PBIS Hub, PBIS Reasons, milestone emails, School Store editing." },
          { action: "Teacher.", detail: "Teacher Hub, Teacher Roster, Hall Pass (subject to allowlist), PBIS award, Classroom Store." },
          { action: "Front Office / Confidential Secretary.", detail: "Pickup tag management; office-only tiles in Admin Hub." },
          { action: "Parent.", detail: "Logs into a separate Parent Portal (different URL path)." },
        ],
        tips: [
          "Flags are set in Admin Hub → Staff & Roles. Bulk-assign is available there too.",
          "If a school doesn't license a module, the sidebar item is hidden for everyone — even SuperUser at that school.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "4. Admin Hub — Today at a Glance",
    intro:
      "The home screen for every admin and Core Team member. Treat it as the demo's 'living room.'",
    features: [
      {
        title: "Open the Admin Hub",
        audience: "Admin, Core Team.",
        whereToFind: "Sidebar → Admin Hub.",
        whatItIs:
          "Real-time tiles showing what's happening in the building right now: hall passes out, ISS arrivals today, recent behavior events, tardies, Pickup 'still on campus' after cutoff.",
        steps: [
          { action: "Land on Admin Hub.", detail: "Tiles auto-refresh every few seconds." },
          { action: "Click any tile to drill in.", detail: "Hall pass tile → live queue. ISS tile → ISS dashboard. Pickup 'still on campus' tile → reconciliation list." },
          { action: "Look for the bell icon (top right).", detail: "Notifications: MTSS plans about to lapse, Spotlight re-spin alerts, AST consistency-check flags." },
        ],
        tips: [
          "Hub tiles are role-gated. A counselor's hub is lighter than an admin's; a SuperUser's adds district rollups.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "5. Hall Pass",
    intro:
      "Visible everywhere, real-time, gamified just enough. Start the demo here when possible.",
    features: [
      {
        title: "Issue a Pass (Teacher View)",
        audience: "Teacher.",
        whereToFind: "Sidebar → Hall Pass → New Pass.",
        whatItIs:
          "Teacher picks the student, picks the destination, and confirms. The pass is on a live queue visible in the hall and at the admin hub.",
        demoScript:
          "Pretend you're a teacher. Show how fast it is — name → destination → done. Then jump to the admin view in another tab and show the same pass live.",
        steps: [
          { action: "Click 'New Pass.'", detail: "Type-ahead by name or student ID." },
          { action: "Pick the destination.", detail: "If the destination is on this teacher's allowlist (their nearest restroom, the room next door), it goes immediately." },
          { action: "Off-allowlist destinations require 'I've contacted them.'", detail: "Friction by design — discourages random wandering, encourages staff coordination." },
          { action: "Pass appears on the live queue at the Admin Hub.", detail: "Color-codes by elapsed time." },
        ],
        tips: [
          "Allowlist is edited at Settings → Allowlist. Use the new 'select all' column header to grant a location to every teacher in one click.",
          "The Locations list (which becomes the columns in the allowlist) is edited at Settings → Locations.",
        ],
      },
      {
        title: "Hall Pass Queue (Admin View)",
        audience: "Admin, Hall Pass admin.",
        whereToFind: "Sidebar → Hall Pass → Queue.",
        whatItIs:
          "Every active pass, sorted by elapsed time, with one-click close, escalate, or assign-camera-review. Auto-resets per bell-schedule period.",
        steps: [
          { action: "Watch the live queue.", detail: "Each row: student, teacher, destination, elapsed." },
          { action: "Pass over the time-elapsed threshold turns warning-colored.", detail: "Stale passes float to the top." },
          { action: "Click a pass to close it or add a note.", detail: "Closed passes feed into the student's HeartBEAT timeline." },
          { action: "Period changes auto-reset the queue.", detail: "Configure a default bell schedule first — Settings → Bell Schedules → set default." },
        ],
        tips: [
          "If no default bell schedule is configured, the queue falls back to 45-minute idle buckets. Workable, but the period reset is the real magic.",
        ],
        watchOutFor: [
          "If a teacher's allowlist is too permissive, the contact-confirm guardrail does nothing. Keep allowlists small.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "6. Digital Signage (Display Management)",
    intro:
      "Big visual wins. If the school has any TV in a hallway, show this.",
    features: [
      {
        title: "Configure a Playlist",
        audience: "Admin / PBIS Coordinator.",
        whereToFind: "Sidebar → Display Management.",
        whatItIs:
          "Per-school, per-TV playlists. Mix images, video, audio, PDF, and live tiles: PBIS house standings, active hall passes, Heartbeat signage, Spotlight reveal.",
        steps: [
          { action: "Open Display Management.", detail: "Lists each registered display." },
          { action: "Create a playlist or pick an existing one.", detail: "Add items: media (image/video/audio/PDF) or live tiles." },
          { action: "Set a schedule.", detail: "When the playlist plays (school hours, after lunch, etc.)." },
          { action: "Assign the playlist to one or more TVs.", detail: "Each TV opens /signage/<TV-id> on a browser kiosk." },
        ],
        tips: [
          "Heartbeat signage is the auto-curated highlight reel: house standings, top recent PBIS awards, today's Spotlight reveal.",
          "Use the classroom signage tile (filtered to that teacher's roster) for in-classroom TVs that show only that classroom's pickup status.",
        ],
      },
      {
        title: "PBIS House Standings on Signage",
        audience: "Whole school.",
        whereToFind: "Auto-included tile in playlists.",
        whatItIs:
          "Live house bar chart. Updates when teachers award points. Built-in 'runaway leader' rebalancer so one house can't snowball the year.",
        steps: [
          { action: "Add the 'House Standings' tile to a playlist.", detail: "Renders as a vertical bar chart with each house's color." },
          { action: "Spotlight reveal lives in the same tile.", detail: "When a teacher 'spotlights' a student, the points and student name appear briefly on signage." },
        ],
        tips: [
          "Spotlight is governor-throttled: when standings diverge by more than 1,500, the lagging houses draw from higher-value pools. The number shown to the teacher is the number the DB stores — no surprises.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "7. PBIS Hub, Spotlight & Stores",
    intro:
      "The culture engine. Teachers love this. Show the full loop: award → spotlight → store.",
    features: [
      {
        title: "Award PBIS Points",
        audience: "Teacher / staff.",
        whereToFind: "Sidebar → PBIS, or PBIS Hub.",
        whatItIs:
          "Pick a student (or a roster, or a house), pick a reason, award. Points roll into the student's HeartBEAT and the house standings.",
        steps: [
          { action: "Open the PBIS Hub.", detail: "Search bar, recent awards, house bars." },
          { action: "Click 'Award.' Pick a student.", detail: "Type-ahead." },
          { action: "Pick a reason.", detail: "Reasons are configured per school — Settings → PBIS Reasons." },
          { action: "Submit.", detail: "Shows on signage instantly; logs to HeartBEAT." },
        ],
        tips: [
          "PBIS reasons are managed at Settings → PBIS Reasons. Encourage schools to keep the list short and meaningful (≤ 8 reasons).",
        ],
      },
      {
        title: "Spotlight Reveal",
        audience: "Teacher.",
        whereToFind: "PBIS Hub → 'Spotlight.'",
        whatItIs:
          "A randomized 1–10 point bonus for a single student, designed to feel like a slot reveal. Pools are house-aware (rebalancer keeps the race tight). The teacher sees the value before they submit; the DB stores exactly that value.",
        steps: [
          { action: "Click Spotlight.", detail: "Pick a student." },
          { action: "Reveal animation runs.", detail: "Shows the awarded point value." },
          { action: "Confirm.", detail: "Re-validates standings — if standings shifted mid-reveal, prompts a 're-spin' (409)." },
        ],
        tips: [
          "Spotlight is intentionally lightweight on signage — a 2-second flash, no audio. Schools running quiet halls have asked for that.",
        ],
      },
      {
        title: "Classroom Store vs School Store",
        audience: "Students; teachers issue.",
        whereToFind: "PBIS Hub → Stores.",
        whatItIs:
          "Two reward catalogs. Classroom Store is per-teacher (each teacher manages their own inventory). School Store is school-wide (admin + PBIS coordinator manage; teachers can only spend on behalf of students).",
        steps: [
          { action: "Browse a store.", detail: "Each item has a thumbnail, cost, and inventory." },
          { action: "Pick an item for a student.", detail: "Student's points are debited; inventory drops by one." },
          { action: "Admins manage School Store inventory at PBIS Hub → School Store admin.", detail: "Teachers see read-only School Store." },
        ],
        tips: [
          "Item thumbnails use the object storage ACL so each school's images are tenant-isolated.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "8. Safety Plans",
    intro:
      "Counselor / Core Team feature with quiet but huge schoolwide reach. Show the staff-facing checklist.",
    features: [
      {
        title: "Create / Edit a Safety Plan",
        audience: "Guidance Counselor, Core Team.",
        whereToFind: "Sidebar → Safety Plans.",
        whatItIs:
          "Per-student behavioral and physical safety checklist. Library of pre-baked items, free-text additions, role-based access (Counselor/Core Team edit; all staff view), full audit log.",
        steps: [
          { action: "Open Safety Plans.", detail: "List of active plans + deactivated archive." },
          { action: "Create a new plan for a student.", detail: "Pick from library or add custom items." },
          { action: "Save. Plan immediately surfaces on the student's profile, teacher roster, and pickup curb confirmation.", detail: "The team is now operating from the same checklist." },
          { action: "Deactivation requires a reason.", detail: "Logged in the audit trail." },
        ],
        tips: [
          "Items typed once into the library become reusable across plans — encourages consistent language.",
        ],
        watchOutFor: [
          "Plan edits go live instantly. Coordinate with classroom teachers if the change is material (e.g., new restraint protocol).",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "9. MTSS Intervention Plans (Tier 2 / Tier 3)",
    intro:
      "Counselors / MTSS Coordinator workflow. Show the goal-setting and the weekly progress log.",
    features: [
      {
        title: "Launch a Tier 2 / Tier 3 Plan",
        audience: "MTSS Coordinator, Core Team.",
        whereToFind: "Sidebar → MTSS Plans.",
        whatItIs:
          "Per-student intervention plan with a tier, goals, strategy category, weekly monitoring rows, and a completion / outcome report.",
        steps: [
          { action: "Open MTSS Plans.", detail: "Active list + completed archive." },
          { action: "Launch a new plan.", detail: "Tier-aware launcher: picks the right template by tier." },
          { action: "Set goal(s) and target.", detail: "Quantitative target the weekly check-ins compare against." },
          { action: "Pick strategy category.", detail: "Drives the suggested weekly observation rows." },
          { action: "Save.", detail: "Plan now appears in the student profile and on the MTSS Coordinator hub." },
        ],
        tips: [
          "Plans about to lapse (within 14 days of their end) appear on the MTSS Coordinator hub and trigger a bell notification.",
        ],
      },
      {
        title: "Weekly Progress Logging",
        audience: "MTSS Coordinator, Core Team.",
        whereToFind: "MTSS Plans → individual plan → 'Weekly Log.'",
        whatItIs:
          "One row per week. Score, observation note, optional school-wide expectations row (the PRIDE / ROAR row).",
        steps: [
          { action: "Open the plan's Weekly Log tab.", detail: "Past weeks listed; new-week row pre-filled." },
          { action: "Score the goal.", detail: "Numeric or qualitative depending on goal type." },
          { action: "If the plan opted in to school-wide expectations, score the expectation row.", detail: "Row label comes from Settings → School-wide Expectations (PRIDE / ROAR / etc.)." },
          { action: "Save.", detail: "Trend chart on the plan updates." },
        ],
        tips: [
          "The expectation acronym AND each letter→word mapping are now editable in Settings → School-wide Expectations.",
        ],
      },
      {
        title: "Intervention Reports",
        audience: "MTSS Coordinator, PBIS Coordinator, Admin.",
        whereToFind: "Sidebar → Intervention Reports.",
        whatItIs:
          "Cross-student rollup: completion rate, score trends, strategy usage, and PRIDE / expectation breakdown.",
        steps: [
          { action: "Open Intervention Reports.", detail: "Filters: grade, window, strategy." },
          { action: "Drill into any cohort row.", detail: "Lists plans + outcome." },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "10. Teacher Roster",
    intro:
      "The teacher's home for student support. Show one teacher's view.",
    features: [
      {
        title: "Open Your Roster",
        audience: "Teacher (any), Core Team (any teacher's).",
        whereToFind: "Sidebar → Teacher Roster.",
        whatItIs:
          "Every student assigned to that teacher with FAST scores, ESE / 504 / ELL flags, Safety Plan indicator, active MTSS plan indicator, and quick-actions.",
        steps: [
          { action: "Open Roster.", detail: "Default: my own classes. Core Team picks any teacher from a dropdown." },
          { action: "Each student row shows badges.", detail: "ESE / 504 / ELL / Safety Plan / Active MTSS / FAST tier." },
          { action: "Click a row to open the student profile.", detail: "Full HeartBEAT timeline." },
        ],
        tips: [
          "Core Team members can switch into any teacher's roster — useful for prepping a Tier 2 cohort meeting.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "11. Parent Portal",
    intro:
      "Closes the loop with families. Always demo with the admin invite flow first, then the parent view.",
    features: [
      {
        title: "Invite a Parent",
        audience: "Admin.",
        whereToFind: "Sidebar → Parent Access.",
        whatItIs:
          "Issue a secure invite to a parent / guardian. Configure which sections of HeartBEAT they can see (PBIS, hall passes, tardies, accommodations, staff notes).",
        steps: [
          { action: "Open Parent Access.", detail: "Search for the student, view current authorizations." },
          { action: "Click 'Invite parent.'", detail: "Enter the email; pick which sections are visible." },
          { action: "Send.", detail: "Parent receives an email with a secure first-login link." },
        ],
        tips: [
          "Sibling switching is automatic — if a parent has invites for multiple kids, they switch with a dropdown.",
        ],
      },
      {
        title: "Parent View",
        audience: "Parent.",
        whereToFind: "/parent/ on the same URL.",
        whatItIs:
          "Read-only HeartBEAT for their student(s). Filters and PDF export. No teacher chat, no PII beyond what the admin enabled.",
        steps: [
          { action: "Parent logs in at /parent/.", detail: "Different bundle, different layout." },
          { action: "Sees their student's HeartBEAT.", detail: "Sections governed by what the admin enabled." },
          { action: "Click 'Export PDF.'", detail: "Generates a tidy report for parent-teacher conferences." },
        ],
        tips: [
          "Sibling dropdown sits top-left. Useful when families have multiple kids at the same school.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "12. Parent Pick-Up Module",
    intro:
      "The 'wow' moment of most demos. Walk through the three surfaces.",
    features: [
      {
        title: "Curb Keypad (Phone-First)",
        audience: "Front office / car-rider staff.",
        whereToFind: "/pickup/curb on the front-office computer.",
        whatItIs:
          "Numeric keypad. Type a parent's phone (or 4-digit tag #). Sibling rollup shows every kid that parent is authorized to take — scoped to the typed parent. Restricted-tag override requires justification.",
        steps: [
          { action: "Type the parent's phone number.", detail: "Sibling rollup appears as you type." },
          { action: "Confirm pickup.", detail: "Each student is added to the dismissal queue." },
          { action: "Restricted-tag overrides require a typed justification.", detail: "Audit logged to pickup_queue_events." },
        ],
        tips: [
          "Curb is intentionally keypad-only — designed for a single shared touch monitor or rugged tablet at the curb.",
        ],
      },
      {
        title: "Walker Gate",
        audience: "Front office / walker-gate staff.",
        whereToFind: "/pickup/walkers.",
        whatItIs:
          "Bell-window-enforced gate. Only walkers tagged for the active dismissal window appear. Confirm walker-by-walker as they leave.",
        steps: [
          { action: "Open the walker gate during dismissal.", detail: "List filtered to walkers active right now." },
          { action: "Tap each walker as they leave.", detail: "Logged with timestamp." },
        ],
      },
      {
        title: "Tag Admin (Issue, Reissue, Print)",
        audience: "Admin + Core Team + Counselor + Front-Office + Confidential Secretary.",
        whereToFind: "Pickup Admin section.",
        whatItIs:
          "Bulk start-of-year assignment, lost-tag reissue, extra-guardian splits, single and batch PDF tag printing with QR codes. 80%-of-range capacity warning.",
        steps: [
          { action: "Bulk assign.", detail: "Allocates a tag # per student from the school's range." },
          { action: "Reissue a lost tag.", detail: "Mark old tag inactive, issue new number." },
          { action: "Print.", detail: "Single or batch PDF with QR code; print on cardstock." },
        ],
        tips: [
          "Default tag range is 4-digit (1001–9999) — ~8,999 slots per school. The 80%-warning fires when a school exceeds ~7,200 active tags.",
        ],
        watchOutFor: [
          "Teachers are explicitly excluded from tag management — by design, the role gate (canManagePickup) admits only admin / Core Team / counselor / front-office / confidential secretary.",
        ],
      },
      {
        title: "'Still on Campus' Tile",
        audience: "Admin.",
        whereToFind: "Admin Hub.",
        whatItIs:
          "After the dismissal cutoff, this tile lists students who haven't been picked up or marked walked. Grouped by dismissal mode.",
        steps: [
          { action: "Tile turns on after the cutoff.", detail: "Empty when everyone's accounted for." },
          { action: "Click any name to mark dismissed manually or escalate.", detail: "Common case: after-school program pickups not yet logged." },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "13. Insights Dashboards",
    intro:
      "Where buyers go from 'cool features' to 'this answers my SIP questions.' Show two or three; mention the rest.",
    features: [
      {
        title: "Tour of the Dashboards",
        audience: "Admin, Core Team, MTSS Coordinator.",
        whereToFind: "Sidebar → Insights.",
        whatItIs:
          "Six dashboards: Engagement, Behavior, Academics, SEB/SEL, Equity, Early Warning. Each has filters (grade, window), demographic disaggregation, drill-down to student profile, and a top-N list.",
        steps: [
          { action: "Open Insights → Engagement.", detail: "Attendance trend, tardy rate, hall-pass density." },
          { action: "Open Insights → Behavior.", detail: "Incident counts, top reasons, by grade, by demographic." },
          { action: "Open Insights → Academics.", detail: "FAST score windows, growth, top-N at risk." },
          { action: "Open Insights → SEB/SEL.", detail: "Self-report surveys and PBIS rollups." },
          { action: "Open Insights → Equity.", detail: "Demographic disaggregation of behavior + academics." },
          { action: "Open Insights → Early Warning.", detail: "Composite signal: attendance + behavior + academics. Click any student to drill in." },
        ],
        tips: [
          "Every dashboard accepts the same window filter. Default is the current grading period.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "14. Data Importer",
    intro:
      "Critical for onboarding. Show a CSV upload, the preview, the commit, and the rollback.",
    features: [
      {
        title: "Import Rosters / Assessments / Behavior",
        audience: "Admin, Data Coordinator.",
        whereToFind: "Sidebar → Data Importer.",
        whatItIs:
          "Generic importer. Three template families: roster, assessment, behavior. Upload CSV → template mapping → preview → commit → rollback if needed.",
        steps: [
          { action: "Pick the template (Roster, Assessment, Behavior).", detail: "Each template lists required columns + sample CSV." },
          { action: "Upload the CSV.", detail: "Server parses, validates row by row." },
          { action: "Preview.", detail: "Shows what will change (new rows, updated rows, skipped rows with reason)." },
          { action: "Download skipped-rows CSV if any.", detail: "Fix and re-upload only the skipped rows." },
          { action: "Commit.", detail: "Applies. Job appears in 'Recent imports.'" },
          { action: "Rollback any committed job from 'Recent imports.'", detail: "Reverts that import, leaves other imports intact." },
        ],
        tips: [
          "Roster importer is strict on house names — must match an existing house exactly. Did-you-mean suggestions help.",
          "Every import job is reversible. Encourage teams to commit early and often; rollback exists.",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "15. Behavior Investigations & ISS",
    intro:
      "Core Team feature. Show how a behavior incident becomes an investigation, then an ISS assignment.",
    features: [
      {
        title: "Open Investigations (Watchlist)",
        audience: "Admin, Core Team.",
        whereToFind: "Sidebar → Investigations.",
        whatItIs:
          "Active and resolved behavior cases. Each case can attach statements (student / staff / witness), evidence, AI consistency check results, and outcome notes.",
        steps: [
          { action: "Open Investigations.", detail: "Cases sorted by activity." },
          { action: "Open a case.", detail: "Header: student, opened-by, status. Tabs: statements, evidence, AI checks, notes, outcome." },
          { action: "Attach a statement.", detail: "Statements can be loose, then promoted to a case (one-way)." },
          { action: "Run AI Consistency Check.", detail: "Cross-checks statements for contradictions. Findings logged for telemetry." },
          { action: "Close out → Behavior Review.", detail: "Behavior Review tab is where Behavior Specialist closes completed pullouts with their outcome notes." },
        ],
        tips: [
          "Statement numbering uses a stable per-case scheme (data layer shipped; UI surfacing in progress).",
        ],
        watchOutFor: [
          "Promoting a loose statement to a case is one-way; cannot un-attach without an audit trace.",
          "Closing a case prematurely requires Admin / SuperUser to reopen.",
        ],
      },
      {
        title: "ISS Dashboard",
        audience: "Dean, Admin, Core Team.",
        whereToFind: "Sidebar → ISS Dashboard.",
        whatItIs:
          "Today's ISS assignments, with arrival/departure timestamps, work-completed checklist, and end-of-day reporting.",
        steps: [
          { action: "Open ISS Dashboard.", detail: "Today's roster, color-coded by status." },
          { action: "Check in arrivals, check out departures.", detail: "Timestamps logged." },
          { action: "End-of-day → ISS Reporting.", detail: "Generates the day's summary; editable / deletable from the log." },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "16. Admin & Tenancy",
    intro:
      "End-of-demo. Show that there's a clear path to set this up. Don't overload.",
    features: [
      {
        title: "Settings Hub",
        audience: "Admin.",
        whereToFind: "Sidebar → Settings.",
        whatItIs:
          "All school-level configuration grouped into 7 gradient-headed sections: Getting Started, School Identity, People & Access, Hall Pass & Locations, Behavior & PBIS, Family & Signage, Admin & Tenancy.",
        steps: [
          { action: "Open Settings.", detail: "Gradient section bars with live progress count for Getting Started." },
          { action: "Click any tile to open that editor.", detail: "Back bar at the top to return to the Hub." },
          { action: "'Next 3 steps' cards in Getting Started deep-link to the matching tile.", detail: "Audience never has to hunt." },
        ],
        tips: [
          "Show the gradient sections — the visual chunking is what makes the Settings page un-scary.",
        ],
      },
      {
        title: "Onboarding Checklist",
        audience: "Admin (during initial setup).",
        whereToFind: "Settings → Onboarding, or Admin Hub bell.",
        whatItIs:
          "A weighted progress checklist. Steps auto-detect when possible (a feature is on, a template exists, a pickup tag is issued, a bell schedule is default). Manual steps are 'I understand' markers for governance items. Phase + role grouping so each role sees their own work.",
        steps: [
          { action: "Open Onboarding.", detail: "X / N complete shown in the header. Partial steps count as 0.5." },
          { action: "Phases collapse / expand.", detail: "Inside each phase, steps are grouped by role: admin / tech-coordinator / PBIS-coordinator." },
          { action: "Clicking a step jumps to the matching settings tile.", detail: "Mapping kept in App.tsx (step-id → tile-id)." },
        ],
        tips: [
          "Export the checklist to PDF for a kickoff meeting agenda.",
        ],
      },
      {
        title: "Staff & Roles",
        audience: "Admin / SuperUser.",
        whereToFind: "Admin Hub → Staff & Roles.",
        whatItIs:
          "Roster of every staff user with their role flags. Bulk-assign roles, bulk-issue temp passwords, edit feature gates, reset to temp password.",
        steps: [
          { action: "Open Staff & Roles.", detail: "Filterable, bulk-selectable." },
          { action: "Edit role flags.", detail: "Multi-select; flags applied immediately." },
          { action: "'Reset to temp password' from the row menu.", detail: "Single-shot helper for stuck users." },
        ],
      },
      {
        title: "Bulk Feature Picker",
        audience: "SuperUser / District Admin.",
        whereToFind: "Settings (Admin & Tenancy section).",
        whatItIs:
          "Pick from a list of feature modules; apply ON/OFF state in bulk to one or many schools.",
        steps: [
          { action: "Open Bulk Feature Picker.", detail: "Module list + school list." },
          { action: "Select schools and modules.", detail: "Apply." },
          { action: "Two-tier flag AND check enforced.", detail: "District flag AND school flag must both be ON." },
        ],
      },
      {
        title: "District / SuperUser Tools",
        audience: "SuperUser only.",
        whereToFind: "Sidebar → SuperUser Home.",
        whatItIs:
          "District-wide rollups, Onboard-a-District wizard, Onboard-a-School (existing district), edit/soft-delete districts and schools, Audit & Health panel.",
        steps: [
          { action: "Open SuperUser Home.", detail: "District + school rollups." },
          { action: "Onboard-a-District wizard.", detail: "Step-by-step setup for a brand-new district." },
          { action: "Onboard-a-School wizard.", detail: "Adds a school to an existing district." },
          { action: "Audit & Health panel.", detail: "Recent admin actions across the district; system health metrics." },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------
  {
    title: "17. Closing the Demo",
    intro:
      "Don't end on a feature. End on confidence.",
    features: [
      {
        title: "What to Leave Them With",
        audience: "You.",
        whereToFind: "—",
        whatItIs:
          "Recap. Anchor on the three things this school will see in week one.",
        steps: [
          { action: "Recap the three highest-leverage screens for THIS school.", detail: "If they're PBIS-heavy, lead with Hub + Spotlight + signage. If they're a discipline-heavy middle school, lead with Investigations + ISS + Pickup." },
          { action: "Show the Onboarding checklist again.", detail: "'This is your first week. Step by step. Most of it is auto-detected.'" },
          { action: "Offer the data importer as the on-ramp.", detail: "'Send your roster CSV and we'll import it together on day one.'" },
          { action: "Mention the user guides.", detail: "Teacher User Guide and Core Team User Guide PDFs are generated from the live app; you can hand them out the day the school goes live." },
        ],
        tips: [
          "Don't promise features that aren't licensed for that school's plan. Mention them as 'available' rather than 'included.'",
        ],
      },
    ],
  },
];

// =========================================================================
// PDF RENDERING (same pattern as Teacher / Core Team guides)
// =========================================================================

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 64, bottom: 64, left: 64, right: 64 },
  bufferPages: true,
  info: {
    Title: "PulseEDU Demo Guide",
    Author: "PulseEDU",
    Subject: "Complete step-by-step demo / onboarding walkthrough of the entire app.",
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
function isAtTopOfPage(): boolean {
  return doc.y <= doc.page.margins.top + 2;
}
function startNewPageIfNotAtTop() {
  if (!isAtTopOfPage()) doc.addPage();
}

function chapterTitle(s: string) {
  doc.font(F_BOLD).fontSize(22).fillColor(C.brand).text(s);
  doc.moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .lineWidth(1.2).strokeColor(C.rule).stroke();
  doc.moveDown(0.5);
  doc.fillColor(C.ink);
}

function featureTitle(s: string) {
  pageBreakIfNear(28);
  doc.moveDown(0.7);
  doc.font(F_BOLD).fontSize(15).fillColor(C.accent).text(s);
  doc.moveDown(0.15);
  doc.fillColor(C.ink);
}

function metaLine(label: string, value: string) {
  doc.font(F_BOLD).fontSize(9.5).fillColor(C.inkSoft).text(`${label}: `, { continued: true });
  doc.font(F_BODY).fillColor(C.ink).text(value);
}

function sectionLabel(s: string) {
  pageBreakIfNear(18);
  doc.moveDown(0.3);
  doc.font(F_BOLD).fontSize(10.5).fillColor(C.inkSoft).text(s.toUpperCase(), { characterSpacing: 0.5 });
  doc.moveDown(0.1);
  doc.fillColor(C.ink);
}

function paragraph(s: string, opts: { italic?: boolean; soft?: boolean } = {}) {
  doc.font(opts.italic ? F_OBL : F_BODY).fontSize(10.5).fillColor(opts.soft ? C.inkSoft : C.ink);
  doc.text(s);
  doc.moveDown(0.2);
}

function step(num: number, action: string, detail?: string) {
  pageBreakIfNear(36);
  const numStr = `${num}.`;
  const numWidth = 22;
  const left = doc.page.margins.left;
  const startY = doc.y;
  doc.font(F_BOLD).fontSize(10.5).fillColor(C.brand).text(numStr, left, startY, {
    width: numWidth,
    lineBreak: false,
  });
  doc.font(F_BODY).fontSize(10.5).fillColor(C.ink).text(action, left + numWidth, startY, {
    width: doc.page.width - doc.page.margins.right - left - numWidth,
  });
  if (detail) {
    doc.font(F_OBL).fontSize(10).fillColor(C.inkSoft).text(detail, left + numWidth, doc.y, {
      width: doc.page.width - doc.page.margins.right - left - numWidth,
    });
  }
  doc.moveDown(0.25);
  doc.x = left;
}

function calloutBox(label: string, items: string[], bg: string, accent: string) {
  if (items.length === 0) return;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const innerWidth = right - left - 20;
  const labelHeight = doc
    .font(F_BOLD)
    .fontSize(9.5)
    .heightOfString(label.toUpperCase(), { width: innerWidth, characterSpacing: 0.4 });
  let bodyHeight = 0;
  for (const it of items) {
    bodyHeight += doc
      .font(F_BODY)
      .fontSize(9.8)
      .heightOfString(`• ${it}`, { width: innerWidth }) + 1;
  }
  const totalHeight = 8 + labelHeight + 4 + bodyHeight + 6;
  pageBreakIfNear(totalHeight + 6);
  doc.moveDown(0.2);
  const startY = doc.y;
  doc
    .save()
    .rect(left, startY, right - left, totalHeight)
    .fillColor(bg)
    .fill()
    .restore();
  doc.font(F_BOLD).fontSize(9.5).fillColor(accent).text(label.toUpperCase(), left + 10, startY + 6, {
    width: innerWidth,
    characterSpacing: 0.4,
  });
  let y = doc.y + 2;
  for (const it of items) {
    doc.font(F_BODY).fontSize(9.8).fillColor(C.ink).text(`• ${it}`, left + 10, y, {
      width: innerWidth,
    });
    y = doc.y + 1;
  }
  doc.y = startY + totalHeight + 4;
  doc.x = left;
}

function demoScriptBox(s: string) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const innerWidth = right - left - 20;
  const labelHeight = doc
    .font(F_BOLD).fontSize(9.5)
    .heightOfString("WHAT TO SAY", { width: innerWidth, characterSpacing: 0.4 });
  const bodyHeight = doc
    .font(F_OBL).fontSize(10).heightOfString(s, { width: innerWidth });
  const totalHeight = 8 + labelHeight + 4 + bodyHeight + 6;
  pageBreakIfNear(totalHeight + 6);
  doc.moveDown(0.2);
  const startY = doc.y;
  doc.save().rect(left, startY, right - left, totalHeight)
    .fillColor(C.bgRole).fill().restore();
  doc.font(F_BOLD).fontSize(9.5).fillColor(C.brand)
    .text("WHAT TO SAY", left + 10, startY + 6, {
      width: innerWidth, characterSpacing: 0.4,
    });
  doc.font(F_OBL).fontSize(10).fillColor(C.ink)
    .text(s, left + 10, doc.y + 2, { width: innerWidth });
  doc.y = startY + totalHeight + 4;
  doc.x = left;
}

function drawFootersOnAllPages() {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font(F_BODY).fontSize(8).fillColor(C.inkFaint);
    doc.text("PulseEDU Demo Guide", doc.page.margins.left, doc.page.height - 40, {
      width: w, align: "left", lineBreak: false,
    });
    doc.text(`p. ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 40, {
      width: w, align: "right", lineBreak: false,
    });
    doc.page.margins.bottom = origBottom;
  }
}

// ---------- Cover ----------
doc.fillColor(C.brand).font(F_BOLD).fontSize(38).text("PulseEDU");
doc.moveDown(0.2);
doc.fillColor(C.ink).fontSize(26).text("Demo Guide");
doc.moveDown(0.4);
doc.fillColor(C.inkSoft).font(F_OBL).fontSize(13);
doc.text(
  "A complete, step-by-step walkthrough of every module — built for demoing PulseEDU to a brand-new school or district. Covers Hall Pass, PBIS Hub + Stores + Spotlight, Digital Signage, Safety Plans, MTSS, Parent Portal, Parent Pickup, Insights, Investigations, ISS, Data Importer, and Settings / Onboarding.",
);
doc.moveDown(2);
doc.fillColor(C.ink).font(F_BODY).fontSize(11);
doc.text(
  "Read chapter 1 ('Before You Demo') once, then keep this PDF open in a second monitor during the demo. Each feature page tells you who in the audience cares, where to click, what to say, and what to watch out for.",
);
doc.moveDown(2);
doc.font(F_BOLD).fontSize(13).fillColor(C.accent).text("Contents");
doc.moveDown(0.4);
doc.font(F_BODY).fontSize(11).fillColor(C.ink);
for (const ch of CHAPTERS) {
  doc.text(`• ${ch.title}`);
  for (const f of ch.features) {
    doc.font(F_OBL).fontSize(10).fillColor(C.inkSoft);
    doc.text(`     – ${f.title}`);
    doc.font(F_BODY).fontSize(11).fillColor(C.ink);
  }
}

// ---------- Chapters ----------
for (const ch of CHAPTERS) {
  startNewPageIfNotAtTop();
  chapterTitle(ch.title);
  if (ch.intro) paragraph(ch.intro, { soft: true });

  for (const f of ch.features) {
    featureTitle(f.title);
    metaLine("Audience", f.audience);
    metaLine("Where to find it", f.whereToFind);
    metaLine("What it is", f.whatItIs);

    if (f.demoScript) demoScriptBox(f.demoScript);

    sectionLabel("Steps");
    f.steps.forEach((s, i) => step(i + 1, s.action, s.detail));

    if (f.tips && f.tips.length) calloutBox("Tips", f.tips, C.bgTip, C.ok);
    if (f.watchOutFor && f.watchOutFor.length) {
      calloutBox("Watch out for", f.watchOutFor, C.bgWarn, C.warn);
    }
  }
}

// ---------- Closing ----------
startNewPageIfNotAtTop();
chapterTitle("After the Demo");
paragraph(
  "Two follow-up artifacts: (1) hand the buyer the matching User Guide PDFs (Teacher User Guide and Core Team User Guide are generated from the same live source). (2) Schedule a 90-minute onboarding call to walk the Onboarding checklist together. Most schools finish setup in two sessions.",
);
paragraph(
  "This guide is regenerated from the live app every time features change. The version you are reading was generated on the date stamped in PDF metadata.",
  { italic: true, soft: true },
);

drawFootersOnAllPages();
doc.end();

stream.on("finish", () => console.log(`Wrote ${OUT}`));
stream.on("error", (e) => { console.error(e); process.exit(1); });
