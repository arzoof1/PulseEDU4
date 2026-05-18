// Generates PulseEDU_Core_Team_User_Guide.pdf — a step-by-step,
// feature-by-feature user guide for the Core Team: SuperUser, District
// Admin, Admin, Behavior Specialist, MTSS Coordinator, Dean of
// Students, ESE Coordinator. Includes Watchlist (Investigations) and
// Behavior Network. Content is grounded in the actual sidebar
// gating in artifacts/client/src/App.tsx and the real headings/
// buttons in each component (WatchlistHub, WatchlistNetwork,
// MtssPlansAdmin, SafetyPlansAdminPage, etc.).

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "attached_assets", "PulseEDU_Core_Team_User_Guide.pdf");
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
  rolesSeeing: string;
  whereToFind: string;
  whatItIs: string;
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

const ROLES_ALL = "Admin, SuperUser, District Admin, Behavior Specialist, MTSS Coordinator, Dean, ESE Coordinator (where noted)";

const CHAPTERS: Chapter[] = [
  // -------------------------------------------------------------------
  {
    title: "1. Who Sees What",
    intro:
      "PulseEDU surfaces different sidebar items depending on which role flag you carry. This chapter is the cheat sheet — read it once so you know which features in this guide actually appear for you.",
    features: [
      {
        title: "Role-by-Role Cheat Sheet",
        rolesSeeing: "—",
        whereToFind: "Reference only — no screen.",
        whatItIs:
          "A quick map from role to the most important screens that role unlocks. Most Core Team members carry more than one flag (e.g., a Dean who is also Behavior Specialist), in which case they see the union of both.",
        steps: [
          { action: "SuperUser.", detail: "Sees everything. Adds: Tenancy settings, multi-school SuperUser Home, ability to act as District Admin." },
          { action: "District Admin.", detail: "Sees the District Admin section, all Admin features for any school they switch into." },
          { action: "Admin (school).", detail: "Admin Hub, Investigations, Settings, Staff & Roles, Bell Schedules, Parent Access, PBIS Hub, MTSS Plans, Safety Plans, ISS Dashboard/Reporting/Settings, Cameras, Onboarding, Verify Pullouts, Behavior Review, Trusted Adults, Trusted Adult Interventions admin, Hall Pass / Interventions / PBIS catalog admin." },
          { action: "Behavior Specialist.", detail: "Behavior Specialist dashboard, Investigations, Verify Pullouts, Behavior Review (close out completed pullouts), ISS Dashboard, MTSS Coordinator hub, MTSS Plans, Intervention Reports, Safety Plans (edit), Trusted Adults, Bell Schedule. Behavior-list admin (interventions / hall pass / PBIS catalog) is reachable from inside the Behavior Specialist dashboard." },
          { action: "MTSS Coordinator.", detail: "MTSS Coordinator hub, MTSS Plans, Intervention Reports, Investigations, Verify Pullouts, ISS Dashboard, Safety Plans (edit), Trusted Adults, Bell Schedule, behavior list admin." },
          { action: "Dean of Students.", detail: "Investigations, Verify Pullouts, ISS Dashboard, behavior list admin, Admin Hub. Does NOT get MTSS Plans, Intervention Reports, MTSS hub, Insights, Safety Plan editing, or the strict admin-only case-enhancement tools (mention insights, video evidence panel, AI Consistency Check)." },
          { action: "ESE Coordinator.", detail: "ESE Coordinator portal — manage accommodations and ESE/504/ELL flags. Does NOT get Safety Plan editing, MTSS Plans, Investigations, or Settings unless they also carry the Admin or SuperUser flag." },
          { action: "Guidance Counselor.", detail: "Safety Plans (edit). No Investigations, no MTSS hub, no Settings unless also Admin." },
          { action: "School Psychologist.", detail: "Safety Plans (edit). Note: the server treats School Psychologist as Core Team for some intervention-write paths, but the client sidebar gates (canAccessMtssHub, canManageMtssPlans) currently do NOT include School Psychologist — so the MTSS Coordinator hub and MTSS Plans tabs do not appear on the sidebar for this role today. If a School Psychologist needs day-to-day MTSS access, ask an admin to flag them as MTSS Coordinator." },
          { action: "PBIS Coordinator.", detail: "PBIS Hub, PBIS Reasons, PBIS Milestone Emails, MTSS Plans, Intervention Reports, Verify Pullouts, School Store editing. No Investigations, no Safety Plans." },
          { action: "Non-Exempt.", detail: "FLSA non-exempt staff. Sidebar collapses to Hall Pass + Tardy Pass + Comp Time ONLY — everything else is hidden (no Teacher Roster, no PBIS, no Request Pullout). Applying this preset auto-flips the staff member's exempt status to 'non_exempt' so Comp Time accrues. Admins escape the collapse if accidentally flagged Non-Exempt. The exempt-status field is also an independent admin toggle for non-exempt staff who carry a different role (e.g., a non-exempt aide who is also a Behavior Specialist)." },
          { action: "Front Office.", detail: "Clerical / receptionist staff. Sees the full teacher bundle EXCEPT Request Pullout (pullouts are a teacher referral, not a front-desk action). Does NOT grant AST or Comp Time approval — Confidential Secretary keeps that grant unchanged." },
          { action: "SRO.", detail: "School Resource Officer. Same capability bundle as Teacher today, broken out as its own role so future SRO-specific surfaces (incident logs, weapon screenings) can target it cleanly." },
          { action: "Guardian.", detail: "Hall monitor / security aide / campus guardian. Same capability bundle as Teacher today, broken out as a distinct role for reporting and future role-targeted features." },
        ],
        tips: [
          "If a screen mentioned in this guide isn't visible to you, your role doesn't have it — ask your administrator to add the flag, or escalate.",
          "Your role flags are managed under Admin Hub → Staff & Roles. Only Admin/SuperUser (or someone with the staff-roles capability) can change them.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "2. The Admin Hub",
    intro:
      "The Admin Hub is the home base for every Core Team member. It surfaces today's school-wide signals (active hall passes, tardies, new ISS assignments, recent behavior events) and links into the deeper screens.",
    features: [
      {
        title: "Open the Admin Hub",
        rolesSeeing: "Admin, SuperUser, District Admin, Dean, Behavior Specialist, MTSS Coordinator.",
        whereToFind: "Sidebar → Admin Hub.",
        whatItIs:
          "An ISS/OSS-focused workspace (heading 'Admin Hub') with two big buttons (📘 Add ISS log, Add OSS log), a Today's ISS prep panel, and a Recent assignments list.",
        steps: [
          { action: "Click Admin Hub in the sidebar." },
          { action: "Use the two big buttons at the top to start a new assignment.", detail: "📘 Add ISS log — opens the ISS modal. Add OSS log — opens the OSS modal. Both ask for student, date range (one or many days), reason, and optional notes." },
          { action: "Scan the 'Today's ISS prep' table.", detail: "Columns: Student, Teacher, Period, Acknowledged. 'Not yet' means the ISS room teacher has not yet checked the student in for that period." },
          { action: "Scan the 'Recent assignments' list below.", detail: "Lists recent ISS/OSS assignments. Use the Cancel button on a row to undo a future-dated assignment — past served days are immutable, so cancellation only trims the tail." },
        ],
        tips: [
          "Bookmark this as your morning landing page — most Core Team users set it as their default sidebar tab.",
        ],
        watchOutFor: [
          "Cancel only removes future days. If a day has already been served (any present period or marked-served), that day cannot be removed from here — it stays in the audit record.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "3. Investigations — The Watchlist Hub",
    intro:
      "Investigations is the case workspace for the Core Team. It is gated to Admin / SuperUser / District Admin / Dean / Behavior Specialist / MTSS Coordinator. The hub is where every open case lives, where new cases are opened, and where you log a witness statement before you have decided which case it belongs to.",
    features: [
      {
        title: "Open Investigations (Incident Investigations Hub)",
        rolesSeeing: "Admin, SuperUser, District Admin, Dean, Behavior Specialist, MTSS Coordinator.",
        whereToFind: "Sidebar → Investigations.",
        whatItIs:
          "The Incident Investigations Hub. The header shows a 'Core Team Only' shield pill, the page title 'Incident Investigations', a window filter (7 / 14 / 30 / 90 days), and four header buttons: Student spider, Network view, + New case, + Log new statement. Below the header are three sections: Alerts requiring eyes, Top of orbit, and Active cases.",
        steps: [
          { action: "Click Investigations in the sidebar." },
          { action: "Set the window filter chip in the header.", detail: "Choose 7 / 14 / 30 / 90 days — every count and chart on the page recomputes against that window." },
          { action: "Read the 'Alerts requiring eyes' panel.", detail: "Automatic flags for students whose interaction-log signals crossed a threshold. Each alert card carries explicit action buttons (e.g., 'Schedule check-in' to act on it, or a button to open the Network view in context). The card itself is not a generic click-through — use the buttons." },
          { action: "Read 'Top of orbit'.", detail: "A table of students appearing most in this window's interactions. Top of orbit rows are read-only — to drill into a specific student, use the Student spider button at the top of the page and search for them." },
          { action: "Use the 'Active cases' list to find an open case.", detail: "Search box: 'Search by title, case #, or lead…'. Click a case row to open Case Detail." },
          { action: "Use the four header buttons for the most common actions:" },
          { action: "Student spider — search one student and see every event tied to them." },
          { action: "Network view — zoom out to the school-wide co-occurrence graph." },
          { action: "+ New case — open a brand-new case file (chapter 6)." },
          { action: "+ Log new statement — record a witness statement before promoting it to a case." },
        ],
        watchOutFor: [
          "Anything you do here is visible to every Core Team member who has Investigations access. Treat the case notes the way you would treat a guidance file.",
        ],
      },
      {
        title: "Open a Case from the List",
        rolesSeeing: "Same as above.",
        whereToFind: "Investigations → Active cases section.",
        whatItIs: "The Active cases list under the Top of orbit panel. Each row shows case number, title, lead investigator, opened date, and days open.",
        steps: [
          { action: "In the Active cases section, type a few characters into 'Search by title, case #, or lead…' to narrow the list." },
          { action: "Click the case row to open the Case Detail screen." },
          { action: "On Case Detail, read the case header (case number, title, days open, status)." },
          { action: "Use the Overview tab's 'Statements on this case' panel to add or attach statements (chapter 6 covers this in detail)." },
          { action: "Use the Investigation Ring tab to read individual statements via the per-incident witness graph." },
        ],
      },
      {
        title: "Open a New Case",
        rolesSeeing: "Same as above.",
        whereToFind: "Investigations header → + New case.",
        whatItIs: "Modal that creates a new case file with a case number assigned automatically based on the school year.",
        steps: [
          { action: "Click + New case." },
          { action: "Type a Title (short, descriptive — e.g., 'Hallway altercation 4/29')." },
          { action: "Pick the primary student from the search field." },
          { action: "(Optional) Add secondary students.", detail: "Anyone you tag here will appear on the case's people-graph and will be searchable when you go looking for related history." },
          { action: "Type an opening note — what happened, who reported it, what you already know." },
          { action: "Click Create case.", detail: "You're routed straight into the new Case Detail screen." },
        ],
        tips: [
          "Case numbers follow the format CASE-{schoolYear}-{seq} (e.g., CASE-2026-0042). The school-year roll-over happens July 1 in school-local time.",
        ],
      },
      {
        title: "Log a Loose Statement",
        rolesSeeing: "Same as above.",
        whereToFind: "Investigations header → + Log new statement.",
        whatItIs:
          "A modal titled 'Log new statement'. The witness is always a student in this flow (search the school's student finder). The statement isn't tied to a case yet — you can attach it from a Case Detail later.",
        steps: [
          { action: "Click + Log new statement in the Investigations Hub header." },
          { action: "Search for the student witness.", detail: "Type 2+ characters into the search field; pick the right student in the suggestions list. Each suggestion shows grade and student ID." },
          { action: "Type (or paste) the statement text." },
          { action: "Click Save.", detail: "The statement is now in the system, unattached. From any Case Detail's Statements panel, use the 'Attach existing statement…' option to tie it to a case." },
        ],
        watchOutFor: [
          "Loose statements are visible to every Core Team member with Investigations access. Word the body accordingly.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "4. Investigations — Behavior Network View",
    intro:
      "The Network view is the school-wide map of students who have appeared in cases or statements over a window. It's the right tool when you suspect a friend group is involved, or when you want to spot recurring pairings before they become a pattern.",
    features: [
      {
        title: "Open the Network View",
        rolesSeeing: "Same Investigations roles.",
        whereToFind: "Investigations Hub → Network view button.",
        whatItIs:
          "A graph view of every student appearing in cases or interactions over a window. The header shows a 'Last N days' pill and a Back arrow. The graph is organized into orbits: a 'Loose ring' at the top for students with un-attached statements, then one 'Case ring' per case (a halo around its students). Sphere size = number of involvements; sphere color = primary role; edges connect students co-appearing in the same case.",
        steps: [
          { action: "Click Network view from the Investigations Hub." },
          { action: "Switch the window using the chips at the top (7 / 14 / 30 / 90 days).", detail: "All counts and the graph itself recompute." },
          { action: "Click any student sphere to open their detail in the side panel.", detail: "From the side panel, you can open the student's Spider or jump into a related case." },
          { action: "Click a case title pill at the top of a case ring to jump directly into Case Detail." },
          { action: "Use + Log new statement in the header to capture something while you're in the view." },
          { action: "Click the back arrow at the top to return to the Hub." },
        ],
        tips: [
          "If the graph is too dense, narrow the window — that's the readability lever.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "5. Investigations — Student Spider",
    intro:
      "Student Spider is the per-student investigation graph. It is the right tool when you have a name in mind and want every interaction (case, statement, intervention, recognition) tied to that student in one canvas.",
    features: [
      {
        title: "Find a Student and Open Their Spider",
        rolesSeeing: "Same Investigations roles.",
        whereToFind: "Investigations Hub → Student spider button (or click any student in the Network view).",
        whatItIs:
          "A focused graph for one student. Has a search bar ('Type a name or student ID…') and a 'Back to Hub' link in the header.",
        steps: [
          { action: "Click Student spider from the Investigations Hub." },
          { action: "Type a student name or ID into the search box.", detail: "Suggestions appear as you type; click the right one." },
          { action: "Read the student header (name, grade)." },
          { action: "Scan the spider — concentric rings group the student's cases, statements, and other interactions." },
          { action: "Click any node to open the underlying record in the side drawer." },
          { action: "Use the X to clear the search and look up another student." },
          { action: "Click 'Back to Hub' to return to the Investigations Hub." },
        ],
        tips: [
          "Student Spider is read-only. To act on what you see (open a case, log a new intervention), use the corresponding sidebar feature.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "6. Investigations — Case Detail",
    intro:
      "Case Detail is where the actual investigative work happens — adding statements, promoting loose statements, attaching evidence, and ultimately closing the case with an outcome.",
    features: [
      {
        title: "Read a Case",
        rolesSeeing: "Same Investigations roles.",
        whereToFind: "Investigations Hub → click a case row in 'Active cases'.",
        whatItIs:
          "A case file with two tabs: Overview (📋) and Investigation Ring (🕸️). The Overview tab carries the 'Statements on this case' panel, a 'Case notes' panel, and a 'Players' panel. The Investigation Ring tab is a per-incident witness graph with the selected incident at the center and the witness statements arranged around it.",
        steps: [
          { action: "Open the case from the Investigations Hub." },
          { action: "Read the case header at the top of the page (case number, title, days-open, status)." },
          { action: "Make sure you're on the Overview tab (selected by default)." },
          { action: "Scan the 'Statements on this case' panel — each card is one witness statement, most recent on top." },
          { action: "Read the 'Case notes' panel for the running narrative the team has been keeping on this case." },
          { action: "Read the 'Players' panel for every student tied to the case." },
          { action: "Switch to the Investigation Ring tab to see the per-incident witness graph (the selected incident at the center, witness statements arranged around it).", detail: "Click any witness in the ring to read their statement in the right rail." },
        ],
      },
      {
        title: "Add a Statement to a Case",
        rolesSeeing: "Same Investigations roles.",
        whereToFind: "Case Detail → Overview tab → 'Statements on this case' panel.",
        whatItIs:
          "A split button in the Statements panel: the primary button is '+ Log new' (the 95% case); the small caret to its right reveals 'Attach existing statement…' (used when the statement already exists as a loose statement and just needs to be tied to this case).",
        steps: [
          { action: "On the Overview tab, find the 'Statements on this case' panel." },
          { action: "Click + Log new (the primary button).", detail: "Opens the Log new statement modal." },
          { action: "Search for the student witness in the modal.", detail: "The witness is always a student in this flow. Type 2+ characters in the search field; click the right student in the suggestions list." },
          { action: "Type (or paste) the statement text." },
          { action: "Click Save.", detail: "The statement appears at the top of the panel and is attached to this case automatically." },
        ],
      },
      {
        title: "Attach an Existing (Loose) Statement",
        rolesSeeing: "Same Investigations roles.",
        whereToFind: "Case Detail → Overview tab → Statements panel → caret next to '+ Log new' → Attach existing statement…",
        whatItIs:
          "A modal titled 'Attach existing statement' that lists statements not yet tied to a case. Use it when a witness reported something before you knew which case it tied to.",
        steps: [
          { action: "Click the small caret next to + Log new in the Statements panel." },
          { action: "Click 'Attach existing statement…'." },
          { action: "Pick the statement from the modal list." },
          { action: "Click Attach.", detail: "The statement is now part of this case's panel. The audit log records the move." },
        ],
        watchOutFor: [
          "Attaching a statement to the wrong case is recoverable but messy — every move is in the audit log. Double-check before clicking Attach.",
        ],
      },
      {
        title: "Add a Player to the Case",
        rolesSeeing: "Same Investigations roles.",
        whereToFind: "Case Detail → Overview tab → Players panel → 'Add player to case'.",
        whatItIs: "A modal titled 'Add player to case' that ties an additional student to the case (e.g., a newly identified subject or witness).",
        steps: [
          { action: "Open the Players panel on the Overview tab." },
          { action: "Click the Add player button." },
          { action: "Search for the student in the modal." },
          { action: "Confirm.", detail: "The student appears in the Players list and on the Investigation Ring." },
        ],
      },
      {
        title: "Close a Case",
        rolesSeeing: "Same Investigations roles.",
        whereToFind: "Case Detail → status control → Close case modal.",
        whatItIs:
          "A modal titled 'Close case' that asks for a closing reason and any final notes. Closing flips the case status and stops the days-open counter.",
        steps: [
          { action: "Click the close-case control on the case (in the case header)." },
          { action: "Type the closing reason / outcome summary in the modal." },
          { action: "Click 'Close case' (the modal's confirm button).", detail: "Days-open stops counting and the case moves out of the Active cases list. Reopening is restricted to Admin, SuperUser, and District Admin." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "7. Watchlists",
    intro:
      "Two watchlists exist. The school Watch List (Insights → Watch List) is shared and rule-driven — students surface automatically based on triggers. My Watch List is your personal, hand-curated list with private notes and groups.",
    features: [
      {
        title: "Use the School Watch List",
        rolesSeeing: "Core Team roles with Insights access (SuperUser, Admin, MTSS Coordinator, Behavior Specialist).",
        whereToFind: "Sidebar → Insights → Watch List.",
        whatItIs:
          "A page titled 'Watch List' showing students surfaced by data triggers. Each row is a student card with a 'New this period' indicator (when applicable) and a small 'Spider' button to jump into Investigations.",
        steps: [
          { action: "Click Insights in the sidebar, then Watch List." },
          { action: "Use the filter presets across the top to narrow the list (or save your own preset).", detail: "Each preset is a saved combination of filters (e.g., grade, signal type)." },
          { action: "Use the search field at the top ('Find a student by name or ID…') to jump to a known student." },
          { action: "Read the row — the 'New this period' badge marks students who surfaced for the first time in the current window." },
          { action: "Click the row to open that student's Profile (whole-child view)." },
          { action: "Click the Spider button on the row to jump into the per-student Investigation Spider." },
        ],
      },
      {
        title: "Build Your Personal Watch List",
        rolesSeeing: "All signed-in staff (private to you).",
        whereToFind: "Sidebar → My Watch List.",
        whatItIs:
          "A page titled 'My Watch List'. Lets you keep a private list of students with private notes and optional groups. Nothing here is visible to other staff.",
        steps: [
          { action: "Click My Watch List in the sidebar." },
          { action: "Click + Add a student in the top-right.", detail: "Search ('Search by name or ID…'), pick the student, click Add." },
          { action: "Add a private note for the student.", detail: "Examples: 'Mom's working nights — Tomás has been sleepy in 1st period.' / 'Call home Friday'. Notes are visible only to you." },
          { action: "Click 'Manage groups' to organize students into groups.", detail: "The Manage groups panel opens inline. Click + Add to create a new group (name + optional emoji), or Delete to remove a group. Click 'Hide groups' to close the panel." },
          { action: "Assign a student to a group from the student's edit modal (open the row, pick the group)." },
        ],
        tips: [
          "Use groups to mirror your real-world cohorts — first-period class, current MTSS roster, kids you're personally mentoring.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "8. Behavior Specialist Dashboard",
    intro:
      "If you carry the Behavior Specialist flag (or are an Admin acting as one), the Behavior Specialist dashboard is your daily landing page.",
    features: [
      {
        title: "Open the Behavior Specialist Dashboard",
        rolesSeeing: "Admin, Behavior Specialist.",
        whereToFind: "Sidebar → Behavior Specialist.",
        whatItIs:
          "A 'Behavior' dashboard with rolled-up counts (incidents, pullouts, ISS days, intervention coverage), a top-N students table, and quick-jump buttons into the rest of the behavior workflow.",
        steps: [
          { action: "Click Behavior Specialist in the sidebar." },
          { action: "Read the rolled-up counts at the top.", detail: "Today / This week / This month — incidents, pullouts, ISS days, intervention check-ins." },
          { action: "Scan the top-N students table.", detail: "Students sorted by signal strength (e.g., most behavior events). Click a name to open their Profile." },
          { action: "Use the quick-jump buttons to open Verify Pullouts, ISS Dashboard, or Investigations directly." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "9. Verify and Review Pullouts",
    intro:
      "Pullouts are the Core Team's queue for student support requests from teachers. Verify is where you say yes/no in real time. Review is where you close the loop with documentation after the support session.",
    features: [
      {
        title: "Verify a Pullout Request",
        rolesSeeing: "Admin, Dean, MTSS Coordinator, Behavior Specialist, PBIS Coordinator.",
        whereToFind: "Sidebar → Verify Pullouts.",
        whatItIs:
          "A live queue of pending pullout requests submitted by teachers via Sidebar → Request Pullout.",
        steps: [
          { action: "Click Verify Pullouts in the sidebar." },
          { action: "Read each request — student, requesting teacher, period, reason, optional teacher note." },
          { action: "Click Approve to schedule the pullout.", detail: "(Optional) attach an internal note for the support staff." },
          { action: "Click Reject if the pullout shouldn't happen.", detail: "Type a reason — the teacher sees this on their Request Pullout screen." },
          { action: "Refresh periodically.", detail: "New requests stream in throughout the day; the queue does not auto-poll aggressively." },
        ],
      },
      {
        title: "Close Out a Completed Pullout (Behavior Review)",
        rolesSeeing: "Admin, Behavior Specialist.",
        whereToFind: "Sidebar → Behavior Review.",
        whatItIs:
          "A queue of pullouts that have been completed but not yet documented. Each row needs a brief outcome note before it leaves the queue.",
        steps: [
          { action: "Click Behavior Review in the sidebar." },
          { action: "Open a completed pullout row." },
          { action: "Type a brief outcome note ('what happened during the pullout, what comes next')." },
          { action: "Pick a follow-up action from the dropdown (e.g., 'no action needed', 'parent contact made', 'add to MTSS plan')." },
          { action: "Click Save & close.", detail: "The row moves out of the queue and lands on the student's intervention history." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "10. ISS — Dashboard, Reporting, and Settings",
    intro:
      "In-School Suspension is split across three Core Team screens: the live Dashboard (who is on ISS today), the Reporting view (history + trends), and Settings (configure how ISS works at your school).",
    features: [
      {
        title: "ISS Dashboard (Today's Roster)",
        rolesSeeing: "SuperUser, Admin, ISS Teacher, Behavior Specialist, Dean, MTSS Coordinator.",
        whereToFind: "Sidebar → ISS Dashboard.",
        whatItIs: "Live view of every student on ISS today — assignments, periods served, marked-served status.",
        steps: [
          { action: "Click ISS Dashboard in the sidebar." },
          { action: "Read the today's roster — name, periods served so far, source (admin log / overflow), notes." },
          { action: "Click a student row to open the per-student ISS detail and mark a period as served." },
          { action: "Use the day picker to look at yesterday or any prior date." },
        ],
      },
      {
        title: "ISS Reporting",
        rolesSeeing: "Same as ISS Dashboard.",
        whereToFind: "Sidebar → ISS Reporting.",
        whatItIs: "Trends over a window — total assignments, days served, no-shows, repeat assignees.",
        steps: [
          { action: "Click ISS Reporting." },
          { action: "Pick a window (7 / 30 / 90 days, or custom)." },
          { action: "Read the metric tiles and drill into the top-N table." },
          { action: "Use Export to download a CSV for further analysis or for a board report." },
        ],
      },
      {
        title: "ISS Settings",
        rolesSeeing: "Admin, SuperUser, District Admin.",
        whereToFind: "Sidebar → Settings → ISS Settings tile.",
        whatItIs: "School-level configuration: which staff are ISS Teachers, default ISS room, period count, whether ISS counts toward attendance.",
        steps: [
          { action: "Open Settings, then click the ISS Settings tile." },
          { action: "Configure the ISS Room (matches a Location)." },
          { action: "Pick the staff member(s) flagged as ISS Teachers (drives who can mark periods served)." },
          { action: "Toggle 'ISS counts as present for attendance' on or off, per district policy." },
          { action: "Click Save.", detail: "Changes take effect immediately on the ISS Dashboard." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "11. PBIS Hub (Coordinator)",
    intro:
      "The PBIS Hub is the configuration + monitoring center for the PBIS coordinator. Day-to-day point awarding still happens on the regular PBIS Points screen; the Hub is where you tune the system.",
    features: [
      {
        title: "Open the PBIS Hub",
        rolesSeeing: "SuperUser, Admin, Behavior Specialist, MTSS Coordinator, PBIS Coordinator.",
        whereToFind: "Sidebar → PBIS Hub.",
        whatItIs: "Hub page with school-wide PBIS metrics, milestone tracking, top-N awarders, top-N recipients, and 'Needs Attention' (students with zero recent recognitions).",
        steps: [
          { action: "Click PBIS Hub in the sidebar." },
          { action: "Read the school-wide metric tiles." },
          { action: "Open the 'Needs Attention' panel.", detail: "Students with zero recent PBIS in the school's invisible-window. The same students are flagged on Teacher Rosters with the eye-with-slash icon." },
          { action: "Use the 'Top awarders' and 'Top recipients' panels for staff-coaching conversations." },
        ],
      },
      {
        title: "Manage PBIS Reasons",
        rolesSeeing: "PBIS Coordinator.",
        whereToFind: "Sidebar → PBIS Reasons.",
        whatItIs: "The catalog of reasons teachers can pick when awarding (or deducting) points. Each reason has a default point value and a polarity (positive / negative).",
        steps: [
          { action: "Click PBIS Reasons in the sidebar." },
          { action: "Click + Add reason to create one." },
          { action: "Type the reason text (e.g., 'Showed leadership during transition')." },
          { action: "Pick the polarity (positive / negative)." },
          { action: "Set the default point value." },
          { action: "Click Save.", detail: "The reason becomes available on every PBIS Points form school-wide." },
          { action: "Use the row's Hide toggle to retire a reason without deleting its history." },
        ],
      },
      {
        title: "Manage PBIS Milestone Emails",
        rolesSeeing: "PBIS Coordinator.",
        whereToFind: "Sidebar → PBIS Milestone Emails.",
        whatItIs: "Configures the milestone-celebration emails that go to families when a student crosses a PBIS threshold.",
        steps: [
          { action: "Click PBIS Milestone Emails in the sidebar." },
          { action: "Open the milestone you want to edit (e.g., 100 points, 250 points)." },
          { action: "Edit the email subject and body.", detail: "Use the {studentName} / {points} placeholders to personalize." },
          { action: "Toggle Active on/off to turn that milestone's email on or off." },
          { action: "Click Save." },
        ],
        watchOutFor: [
          "Milestone emails only send if your school has email reminders enabled and a from-address configured. Confirm with your administrator if you're not seeing sends.",
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "12. MTSS Coordinator Hub & Plans",
    intro:
      "The MTSS surface has three coordinated screens: the Coordinator Hub (school-wide rollups), MTSS Plans (per-student Tier 2/3 plan creation and editing), and Intervention Reports (completion + outcome data).",
    features: [
      {
        title: "Open the MTSS Coordinator Hub",
        rolesSeeing: "SuperUser, Admin, MTSS Coordinator, Behavior Specialist (and School Psychologist).",
        whereToFind: "Sidebar → MTSS Coordinator.",
        whatItIs: "Reports page with school-wide MTSS metrics — count of active T2/T3 plans, weekly completion rate, plans about to lapse, and a top-N students by intervention activity.",
        steps: [
          { action: "Click MTSS Coordinator in the sidebar." },
          { action: "Read the metric tiles." },
          { action: "Open 'Plans about to lapse'.", detail: "Plans whose end date is within the next 14 days. Click a row to open the plan in MTSS Plans." },
          { action: "Use the period picker to switch between This week / This month / This quarter." },
        ],
      },
      {
        title: "Create or Edit a Tier 2 / Tier 3 Plan",
        rolesSeeing: "SuperUser, Admin, Behavior Specialist, MTSS Coordinator, PBIS Coordinator.",
        whereToFind: "Sidebar → MTSS Plans.",
        whatItIs:
          "A management page (heading 'MTSS Plans') with a search box ('Filter by name, student id, or title…') and a table of every plan in the school. The plan modal is titled 'New MTSS Plan' (or 'Edit MTSS Plan').",
        steps: [
          { action: "Click MTSS Plans in the sidebar." },
          { action: "Use the filter box to find an existing plan." },
          { action: "Click + New plan to open the New MTSS Plan modal." },
          { action: "Pick the Student.", detail: "Type into the input ('Type a name or ID…'); the suggestions list appears below. Pick the right student." },
          { action: "Type the plan Title.", detail: "Placeholder: 'e.g. Tier 2 Behavior Support'. Use a name your team will recognize." },
          { action: "Pick the Tier (2 or 3) from the dropdown." },
          { action: "Add the Goals.", detail: "For Tier 3, add multiple goals (one per row) — they show up on the weekly form. Use the Remove button next to a goal to clear it before saving." },
          { action: "Type any optional notes the rest of the team should know." },
          { action: "Click Save (the modal's submit button).", detail: "The plan becomes active immediately and the student appears on the relevant teacher's Log Intervention launcher." },
        ],
        tips: [
          "Edit an existing plan from the same table — click a row, change the title / tier / goals / notes, then Save.",
        ],
      },
      {
        title: "Read Intervention Reports",
        rolesSeeing: "SuperUser, Admin, Behavior Specialist, MTSS Coordinator, PBIS Coordinator.",
        whereToFind: "Sidebar → Intervention Reports.",
        whatItIs:
          "A reporting page (heading 'Intervention Reports') with weekly completion rates per teacher and per student, plus drill-in to the actual entries.",
        steps: [
          { action: "Click Intervention Reports in the sidebar." },
          { action: "Pick the report type (per-teacher completion / per-student adherence / outcome trends)." },
          { action: "Filter the window using the date pickers." },
          { action: "Use the search field ('Search student…') to drill to one student." },
          { action: "Click any row to open the underlying entries." },
          { action: "Use the Back button at the top to return to the report list." },
        ],
      },
      {
        title: "Manage Tier 3 Strategies (Catalog)",
        rolesSeeing: "Same MTSS roles.",
        whereToFind: "Settings → Tier 3 Strategies (or sidebar Behavior Lists → Tier 3 Strategies).",
        whatItIs: "The catalog of strategies that show up as checkboxes on the Tier 3 weekly form.",
        steps: [
          { action: "Open the Tier 3 Strategies admin." },
          { action: "Click + Add category to group related strategies (e.g., 'Self-regulation')." },
          { action: "Inside a category, click + Add strategy and type the strategy name." },
          { action: "Use Hide to retire a strategy without breaking historical entries that reference it." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "13. Safety Plans (Edit + Library)",
    intro:
      "Safety plans are the Core Team's source of truth for how staff should respond to a specific student. Teachers can only view; this chapter is for the staff who write and edit.",
    features: [
      {
        title: "Open Safety Plans Admin",
        rolesSeeing: "SuperUser, Admin, Behavior Specialist, MTSS Coordinator, Guidance Counselor, School Psychologist.",
        whereToFind: "Sidebar → Safety Plans.",
        whatItIs:
          "A page (heading 'Safety Plans') with a search box ('Filter by name or student id…') and a table of every student with an active plan.",
        steps: [
          { action: "Click Safety Plans in the sidebar." },
          { action: "Use the filter to find a student or scan the table for the name." },
          { action: "Click a row to open the plan editor." },
        ],
      },
      {
        title: "Create or Edit a Plan",
        rolesSeeing: "Same Safety Plan roles.",
        whereToFind: "Safety Plans Admin → click a student row, or + New plan.",
        whatItIs: "The Safety Plan editor. Each plan combines (a) a status (Active / Inactive), (b) checkboxes pulled from the school's item library, (c) custom items you can add inline, and (d) a free-form notes section.",
        steps: [
          { action: "From the Safety Plans page, click the student's row to open their plan." },
          { action: "If the student has no plan yet, click + New plan and pick the student via the search ('Search by name or ID…')." },
          { action: "Set the plan status (Active or Inactive) using the dropdown at the top." },
          { action: "Tick each item in the library checklist that applies.", detail: "Type a per-item note in the 'Note' field next to any checked item (placeholder: 'Note (optional)')." },
          { action: "Add a custom item inline.", detail: "Use the 'Add a custom item…' input at the bottom of the items list to capture a one-off the library doesn't cover." },
          { action: "Type the plan-level notes.", detail: "Placeholder: 'Context, triggers, who to call, etc.' Use this for trauma context (summary), trigger phrases, and things to avoid." },
          { action: "Click Save to commit the plan.", detail: "Active immediately. The red SP pill appears next to the student's name on every Teacher Roster." },
        ],
        watchOutFor: [
          "Edits are visible to every viewer in real time. Use the school's protocol for letting staff know a plan changed (typically a Behavior Specialist email).",
        ],
      },
      {
        title: "Manage the School-wide Item Library",
        rolesSeeing: "Same Safety Plan roles.",
        whereToFind: "Safety Plans Admin → 'Manage library' (button on the Safety Plans page header).",
        whatItIs: "The catalog of checklist items every plan can pull from. Updating an item label is reflected on every existing plan that ticks it.",
        steps: [
          { action: "Open the library editor." },
          { action: "Type a new label in the 'New checkbox label (e.g. \\'No phone access\\')' input." },
          { action: "Click Add to save the new item — it now appears on every plan editor." },
          { action: "Edit an existing label by clicking its row, changing the text, and saving." },
        ],
        tips: [
          "Keep labels short and action-oriented. The plan reader needs to scan, not parse.",
        ],
      },
      {
        title: "Deactivate a Plan",
        rolesSeeing: "Same Safety Plan roles.",
        whereToFind: "Safety Plan editor → status dropdown.",
        whatItIs: "Switches the plan from Active to Inactive. The red SP pill disappears from rosters; the historical plan stays in the record.",
        steps: [
          { action: "Open the student's plan." },
          { action: "Change the status dropdown from Active to Inactive." },
          { action: "Click Save.", detail: "The plan moves to inactive; the SP pill clears from rosters on the next roster refresh." },
          { action: "Use the status filter on the Safety Plans page (Active / Archived / All) to see inactive plans later." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "14. ESE Coordinator Portal",
    intro:
      "The ESE Coordinator portal is gated to the ESE Coordinator flag (and Admin). It's the screen for managing accommodation assignments and program flags school-wide.",
    features: [
      {
        title: "Open the ESE Portal",
        rolesSeeing: "Admin, ESE Coordinator.",
        whereToFind: "Sidebar → ESE Coordinator.",
        whatItIs: "A workspace with the school's accommodation catalog, the per-student assignment table, and a usage log.",
        steps: [
          { action: "Click ESE Coordinator in the sidebar." },
          { action: "Use the catalog tab to manage the school's accommodation catalog (add / rename / retire items, grouped by category)." },
          { action: "Use the assignments tab to assign / remove accommodations for individual students." },
          { action: "Open a student row to see their accommodation usage log (every time a teacher logged the accommodation in their classroom)." },
        ],
      },
      {
        title: "Edit a Student's Program Flags (ESE / 504 / ELL)",
        rolesSeeing: "Admin, SuperUser, MTSS Coordinator, Behavior Specialist, PBIS Coordinator.",
        whereToFind: "Student Profile → header → Edit demographics (Core Team only).",
        whatItIs: "An inline editor on the Student Profile that updates the ESE / 504 / ELL / CT-ELA / CT-Math flags.",
        steps: [
          { action: "Open the Student Profile." },
          { action: "Click Edit demographics in the header (visible only to Core Team)." },
          { action: "Tick or untick the relevant flags." },
          { action: "Click Save.", detail: "The flags update immediately on every Teacher Roster row for that student." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "15. Insights Hub",
    intro:
      "The Insights Hub is the analytical front door for Core Team. It links to every dashboard (Engagement / Behavior / Academics / SEB-SEL / Equity / Early Warning) and to the school Watch List.",
    features: [
      {
        title: "Open Insights Hub",
        rolesSeeing: "SuperUser, Admin, MTSS Coordinator, Behavior Specialist.",
        whereToFind: "Sidebar → Insights.",
        whatItIs: "Hub page with a tile for each dashboard. Click a tile to enter that dashboard.",
        steps: [
          { action: "Click Insights in the sidebar." },
          { action: "Click a tile to open that dashboard.", detail: "Engagement (attendance / hall passes / tardies), Behavior (incidents / interventions), Academics (FAST trajectory), SEB-SEL (screener data), Equity (disaggregated outcomes), Early Warning (composite risk)." },
          { action: "Inside any dashboard, use the Grade and Time Window pickers to filter." },
          { action: "Click any student row to drill into their Student Profile with the same window pre-applied." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "16. Settings (Admin / SuperUser / District Admin)",
    intro:
      "Settings is the configuration backbone. It is gated to Admin / SuperUser / District Admin. The hub page lays out the configurable surfaces as tiles.",
    features: [
      {
        title: "Open Settings",
        rolesSeeing: "Admin, SuperUser, District Admin.",
        whereToFind: "Sidebar → Settings.",
        whatItIs: "Settings hub (heading 'Settings') with a grid of tiles. Click a tile to enter that section.",
        steps: [
          { action: "Click Settings in the sidebar." },
          { action: "Click a tile.", detail: "Common tiles: Onboarding, ISS Settings, Cameras, Tenancy (SuperUser only), Locations, School Info, Data Importer, Display Management, PBIS Reasons, Hall Pass Settings, Bell Schedules, Parent Portal Sections." },
          { action: "Make changes inside the tile." },
          { action: "Click Save (each tile saves independently)." },
          { action: "Use Back to return to the Settings hub." },
        ],
      },
      {
        title: "Use the Onboarding Checklist",
        rolesSeeing: "Admin, SuperUser, District Admin (acting in a school).",
        whereToFind: "Settings → Onboarding tile.",
        whatItIs: "A guided checklist (heading 'Onboarding Checklist') grouped into five phases: Identity & Access, Schedule & Operations, Behavior & PBIS, Interventions & MTSS, and Family & Outreach. Each step shows a status pill (✓ Detected, Partial, Needs setup, ✓ Marked done) and an Open → button.",
        steps: [
          { action: "Open Settings → Onboarding." },
          { action: "Read the phase headers and the short blurb under each.", detail: "Example: Identity & Access — 'Who can sign in, what your school looks like, and where everything is.'" },
          { action: "Skim each step's status pill.", detail: "✓ Detected = the system has confirmed this is set up. Partial = some signals present, more needed. Needs setup = nothing detected yet. ✓ Marked done = a human declared it done (used for steps without a detectable signal)." },
          { action: "Click Open → on any step that needs work — it routes you to the right Settings tile or feature." },
          { action: "Toggle the manual checkbox on informational steps without a system signal to mark them done." },
          { action: "Track progress using the completion counter at the top of the page." },
        ],
        tips: [
          "Treat onboarding as the day-one playbook for a new school. Every step you skip becomes a question your teachers will ask later.",
        ],
      },
      {
        title: "Manage Cameras (Settings → Cameras)",
        rolesSeeing: "Admin, SuperUser, District Admin.",
        whereToFind: "Settings → Cameras tile.",
        whatItIs: "Registry of camera URLs the case-evidence panel can pull footage from.",
        steps: [
          { action: "Open Settings → Cameras." },
          { action: "Click + Add camera." },
          { action: "Fill in the camera label, the area it covers, and the playback URL pattern." },
          { action: "Click Save." },
          { action: "Use Test on a row to confirm the camera responds to a sample timestamp." },
        ],
      },
      {
        title: "Tenancy (SuperUser only)",
        rolesSeeing: "SuperUser only.",
        whereToFind: "Settings → Tenancy tile.",
        whatItIs: "District-level tenancy controls — add a new school, switch the active school you're acting in, configure cross-school behaviors.",
        steps: [
          { action: "Open Settings → Tenancy." },
          { action: "To add a school, click + New school and fill in the school name + identifiers." },
          { action: "To act as a different school, use the school picker at the top.", detail: "Every Settings change you make from here on is scoped to the school you have selected." },
        ],
      },
      {
        title: "Parent Access",
        rolesSeeing: "Admin, SuperUser, District Admin.",
        whereToFind: "Sidebar → Parent Access.",
        whatItIs: "Manage parent invites, link parent accounts to students, and configure which Parent Portal sections are enabled school-wide.",
        steps: [
          { action: "Click Parent Access in the sidebar." },
          { action: "To invite a parent, click + New invite, fill in their email, pick the student(s), click Send." },
          { action: "To link an existing parent account to a new sibling, find the parent row and click + Add student." },
          { action: "To toggle Portal sections on/off school-wide, use the Sections panel and click each toggle." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "17. Staff & Roles, Bell Schedule, Trusted Adults",
    intro: "Three surfaces under the Admin Hub umbrella that Core Team uses regularly.",
    features: [
      {
        title: "Staff & Roles",
        rolesSeeing: "SuperUser, Admin, or anyone with the Staff Roles capability.",
        whereToFind: "Sidebar → Staff & Roles.",
        whatItIs:
          "A matrix of every staff member with checkboxes for each role flag (Admin, SuperUser, District Admin, Behavior Specialist, MTSS Coordinator, PBIS Coordinator, ESE Coordinator, Dean, Guidance Counselor, School Psychologist, ISS Teacher, Non-Exempt, Front Office, SRO, Guardian, etc.).",
        steps: [
          { action: "Click Staff & Roles in the sidebar." },
          { action: "Find the staff member (use the search at the top if the list is long)." },
          { action: "Tick or untick a role flag.", detail: "Saves automatically — the change takes effect the next time the user reloads or signs back in." },
          { action: "Use the Capability columns to grant fine-grained capabilities (e.g., manage displays, manage staff roles) without granting full Admin." },
          { action: "For Non-Exempt staff, set the Exempt Status column to 'Non-exempt'.", detail: "Applying the Non-Exempt role preset does this automatically. You can also flip it manually for a staff member who is non-exempt but wears another role bundle (e.g., a non-exempt aide who is also a Behavior Specialist) — Comp Time accrual is driven by this column, not by the role checkbox." },
        ],
        watchOutFor: [
          "Removing your own SuperUser flag is permanent until another SuperUser restores it. Always have at least one other SuperUser configured.",
          "Non-Exempt + Admin on the same staff member: Admin tier wins on the sidebar collapse (you still see the full Admin nav). Exempt Status still controls whether Comp Time accrues, so set both deliberately.",
        ],
      },
      {
        title: "Bell Schedule",
        rolesSeeing: "SuperUser, Admin, MTSS Coordinator, Behavior Specialist.",
        whereToFind: "Sidebar → Bell Schedule.",
        whatItIs: "Configure the school's class periods, passing times, and per-day overrides. Powers the period dropdowns and Hall Pass Queue period reset.",
        steps: [
          { action: "Click Bell Schedule in the sidebar." },
          { action: "Click + New schedule (or pick an existing one to edit)." },
          { action: "Add periods one at a time — start time, end time, label." },
          { action: "Mark one schedule as Default.", detail: "The default drives the Hall Pass Queue reset behavior. Without a default, the Queue falls back to 45-minute idle buckets." },
          { action: "Use Add override to define a one-day variation (e.g., assembly day, early dismissal)." },
          { action: "Save." },
        ],
      },
      {
        title: "Trusted Adults",
        rolesSeeing: "SuperUser, Admin, MTSS Coordinator, Behavior Specialist.",
        whereToFind: "Sidebar → Trusted Adults.",
        whatItIs: "Per-student mapping of which staff members are designated 'Trusted Adults' for a given student. Drives visibility paths in the Student Profile and surfaces them on Safety Plans.",
        steps: [
          { action: "Click Trusted Adults in the sidebar." },
          { action: "Find the student (use search)." },
          { action: "Click + Add trusted adult and pick the staff member." },
          { action: "Save." },
          { action: "Remove a trusted adult by clicking the X next to their chip on the student row." },
        ],
      },
    ],
  },
  // -------------------------------------------------------------------
  {
    title: "18. Daily Habits & What to Watch For",
    intro: "A short checklist for Core Team members at the start and end of each day.",
    features: [
      {
        title: "Morning (10 minutes)",
        rolesSeeing: "All Core Team.",
        whereToFind: "—",
        whatItIs: "What to scan first thing.",
        steps: [
          { action: "Open Admin Hub — read the overnight activity feed." },
          { action: "Open Investigations — check Open cases count and any new loose statements." },
          { action: "Open Verify Pullouts — clear any pending requests teachers submitted before bell." },
          { action: "Glance at ISS Dashboard to confirm today's roster matches yesterday's assignments." },
          { action: "Check the school Watch List for any new trigger pills." },
        ],
      },
      {
        title: "End of Day (10 minutes)",
        rolesSeeing: "All Core Team.",
        whereToFind: "—",
        whatItIs: "What to close out so the next day starts clean.",
        steps: [
          { action: "Open Behavior Review — close out completed pullouts with their outcome notes." },
          { action: "Open Investigations — make sure any new statements are attached or intentionally left loose." },
          { action: "Open MTSS Coordinator → 'Plans about to lapse' and renew or close any plans inside their last 14 days." },
          { action: "If you're an Admin: open Settings → Onboarding for any newly-completed steps to mark done." },
        ],
      },
      {
        title: "Things to Be Careful About",
        rolesSeeing: "All Core Team.",
        whereToFind: "—",
        whatItIs: "The handful of mistakes that are hardest to undo.",
        steps: [
          { action: "Removing your own SuperUser flag.", detail: "Permanent until another SuperUser restores it. Keep at least two SuperUsers configured." },
          { action: "Closing a case prematurely.", detail: "Reopening requires Admin or SuperUser; the audit trail records who closed it and when." },
          { action: "Editing a Safety Plan without telling staff.", detail: "Plan changes are visible immediately. Use your school's notification protocol." },
          { action: "Deactivating a Safety Plan without a reason.", detail: "Deactivation requires a reason — type something useful for the next person who reads the audit log." },
          { action: "Promoting a loose statement to the wrong case.", detail: "Promotion is one-way per statement; you cannot un-attach without leaving an audit trace." },
        ],
      },
    ],
  },
];

// =========================================================================
// PDF RENDERING (same proven pattern as Teacher User Guide)
// =========================================================================

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 64, bottom: 64, left: 64, right: 64 },
  bufferPages: true,
  info: {
    Title: "PulseEDU Core Team User Guide",
    Author: "PulseEDU",
    Subject: "Step-by-step user guide for Core Team (Admin / SuperUser / District Admin / Behavior Specialist / MTSS Coordinator / Dean / ESE Coordinator)",
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

// Measured-height callout — uses heightOfString to compute the true block
// height before drawing the background. Avoids the estimate-overlap risk
// the architect flagged on the Teacher Guide.
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

function drawFootersOnAllPages() {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font(F_BODY).fontSize(8).fillColor(C.inkFaint);
    doc.text("PulseEDU Core Team User Guide", doc.page.margins.left, doc.page.height - 40, {
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
doc.fillColor(C.ink).fontSize(26).text("Core Team User Guide");
doc.moveDown(0.4);
doc.fillColor(C.inkSoft).font(F_OBL).fontSize(13);
doc.text(
  "Step-by-step, screen-by-screen instructions for Admin, SuperUser, District Admin, Behavior Specialist, MTSS Coordinator, Dean of Students, and ESE Coordinator. Includes Investigations (Watchlist), Behavior Network, and personal Watchlist.",
);
doc.moveDown(2);
doc.fillColor(C.ink).font(F_BODY).fontSize(11);
doc.text(
  "This guide is organized by feature, not by role. Each chapter starts with the screen and the roles that can see it, then walks the workflow click-by-click. If a chapter mentions a screen you don't see, your role flag doesn't include it — see chapter 1 for the role cheat sheet.",
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
    metaLine("Roles that see this", f.rolesSeeing);
    metaLine("Where to find it", f.whereToFind);
    metaLine("What it is", f.whatItIs);

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
chapterTitle("Need help?");
paragraph(
  "If a screen described here looks different from what you see, your school may be on a slightly different feature configuration — confirm with your administrator or another Core Team member first. For a wider feature outage or a bug, capture a screenshot with the date/time and the student or case in question and send it to your administrator.",
);
paragraph(
  "This guide is regenerated when features change. The version you are reading was generated from the live source on the date printed on the cover.",
  { italic: true, soft: true },
);

drawFootersOnAllPages();
doc.end();

stream.on("finish", () => console.log(`Wrote ${OUT}`));
stream.on("error", (e) => { console.error(e); process.exit(1); });
