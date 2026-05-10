// Generates PulseEDU_Workflow_Guide.pdf — a screen-by-screen, function-by-
// function, per-role workflow reference for developers. Content is written
// inline as data structures so the entire spec lives in one file and can be
// edited without touching layout code.

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "attached_assets", "PulseEDU_Workflow_Guide.pdf");
mkdirSync(dirname(OUT), { recursive: true });

const COLORS = {
  ink: "#0f172a",
  inkSoft: "#475569",
  inkFaint: "#94a3b8",
  brand: "#1d4ed8",
  accent: "#0e7490",
  rule: "#cbd5e1",
  panel: "#f1f5f9",
  warn: "#b45309",
  ok: "#15803d",
};

type Role =
  | "SuperUser"
  | "District Admin"
  | "Admin"
  | "Dean"
  | "Behavior Specialist"
  | "MTSS Coordinator"
  | "School Psychologist"
  | "Guidance Counselor"
  | "PBIS Coordinator"
  | "Teacher"
  | "Parent";

interface RoleAction {
  role: string | string[];
  can: string;
}

interface FunctionSpec {
  name: string;
  what: string;
  roleBehavior: RoleAction[];
  notes?: string[];
}

interface ScreenSpec {
  id: string;
  title: string;
  navPath: string;
  audience: string;
  purpose: string;
  functions: FunctionSpec[];
  visibility?: string;
  routes?: string[];
  notes?: string[];
}

interface Section {
  title: string;
  blurb?: string;
  screens: ScreenSpec[];
}

// -------------------------------------------------------------------------
// CONTENT
// -------------------------------------------------------------------------

const ROLE_GLOSSARY: { role: Role; scope: string; summary: string }[] = [
  {
    role: "SuperUser",
    scope: "District-wide (all schools, all districts)",
    summary:
      "Engineering / district-IT level. Sees Tenancy panel, can switch between any school, manages district integrations, can grant/revoke any role. Implicitly counts as Admin everywhere.",
  },
  {
    role: "District Admin",
    scope: "District-wide (all schools in their district)",
    summary:
      "Cross-school analytics and policy. District Overview view aggregates every school side-by-side; can read/write everything in their district but does not manage tenancy.",
  },
  {
    role: "Admin",
    scope: "Single school",
    summary:
      "Principal / AP. Full edit on every tile in their school: staff roles, settings, signage, store, safety plan library, case investigations (including admin-only video evidence + AI Consistency Check), reopening cases.",
  },
  {
    role: "Dean",
    scope: "Single school",
    summary:
      "Investigator without full admin authority. Sees the Investigations Hub, can collect statements, manage cases, run investigations and footage requests. Cannot edit catalog/settings tiles unless also granted Admin.",
  },
  {
    role: "Behavior Specialist",
    scope: "Single school",
    summary:
      "Core Team member. Reads/writes every teacher's Tier 2/3 entries, manages strategy catalog, sees Behavior Specialist hub, MTSS plans, investigations (as a Case Investigator). Manages bell schedules and displays.",
  },
  {
    role: "MTSS Coordinator",
    scope: "Single school",
    summary:
      "Core Team. Same intervention/case investigator privileges as Behavior Specialist; owns MTSS Plan creation/editing and the MTSS Coordinator hub.",
  },
  {
    role: "School Psychologist",
    scope: "Single school",
    summary:
      "Core Team for intervention purposes (reads/writes any teacher's tier work). Excluded from the discipline-investigation chain — does not see the Case Investigator privileges of Dean/BS/MTSS for investigations.",
  },
  {
    role: "Guidance Counselor",
    scope: "Single school",
    summary:
      "Owns Safety Plans (alongside Core Team). Sees Safety Plan editor + library; not an automatic Core Team member otherwise.",
  },
  {
    role: "PBIS Coordinator",
    scope: "Single school",
    summary:
      "Owns the PBIS Hub: thresholds, school-wide expectations, school store catalog, PBIS Points dashboards, and house standings on signage.",
  },
  {
    role: "Teacher",
    scope: "Their classes / their roster",
    summary:
      "Default staff role. Logs hall passes, tardies, PBIS points, accommodation events, interventions for their own students. Read-only on School Store and most catalogs. Sees their Teacher Roster.",
  },
  {
    role: "Parent",
    scope: "Their student(s) only",
    summary:
      "Lives in /parent/* portal — separate from the staff app. Magic-link / invite-based login. Reads HeartBEAT data (PBIS, hall passes, tardies, accommodations, staff notes) for any student linked to their account; can switch between siblings.",
  },
];

const SECTIONS: Section[] = [
  // =====================================================================
  {
    title: "1. Authentication & First Run",
    blurb:
      "Every staff role uses the same sign-in screen; routing/visibility branches once the session is established. Parents sign in through a separate /parent/* path with magic-link invites managed by Admins.",
    screens: [
      {
        id: "auth-staff",
        title: "Staff Sign-in",
        navPath: "/ (root, when unauthenticated)",
        audience: "All staff roles",
        purpose:
          "Authenticate a staff member into a single school context. Multi-school users (SuperUser, District Admin) land on a school switcher after auth.",
        functions: [
          {
            name: "Sign in",
            what: "Email + password (or SSO if district has it configured).",
            roleBehavior: [
              { role: "All staff", can: "Authenticate; failed attempts are rate-limited per server policy." },
            ],
          },
          {
            name: "Pick active school",
            what:
              "After login, multi-school accounts pick which school context to operate in. Single-school accounts skip this.",
            roleBehavior: [
              { role: "SuperUser", can: "See every school across every district." },
              { role: "District Admin", can: "See every school in their assigned district." },
              { role: ["Admin", "Dean", "Behavior Specialist", "MTSS Coordinator", "Teacher"], can: "Skip — auto-bound to their assigned school." },
            ],
            notes: [
              "School context lives in middleware as req.schoolId; every server query filters by it.",
            ],
          },
        ],
      },
      {
        id: "onboarding",
        title: "Onboarding Checklist",
        navPath: "Auto-displays on first login for Admins until cleared",
        audience: "Admins only",
        purpose:
          "Phase-by-phase setup wizard so a new school comes online without missing a configuration step (bell schedule, locations, kiosks, signage, PBIS thresholds, etc.).",
        functions: [
          {
            name: "Tick a step complete",
            what: "Marks a row as done; persists on the school_onboarding_state table.",
            roleBehavior: [
              { role: "Admin", can: "Tick any step; only Admins see the checklist." },
              { role: ["Teacher", "Dean", "Behavior Specialist", "MTSS Coordinator", "Guidance Counselor"], can: "Do not see the checklist at all." },
            ],
          },
          {
            name: "Export onboarding PDF",
            what:
              "Generates a printable copy of the checklist with 'how this works' copy alongside each step. Useful for handoff to a co-administrator.",
            roleBehavior: [{ role: "Admin", can: "Download the PDF (server-rendered via pdfkit)." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "2. App Shell — Sidebar, Quick Access, Top Bar",
    blurb:
      "The sidebar is feature-flag aware and role aware. Every nav item is hidden if the user lacks the relevant capability; the visible set is the user's effective toolbox. School-level feature flags can hide entire modules even from Admins.",
    screens: [
      {
        id: "shell-sidebar",
        title: "Left Sidebar",
        navPath: "Always visible (collapsible)",
        audience: "All staff",
        purpose:
          "Primary navigation. Items are grouped: Daily Ops (Hall Passes, Tardies, PBIS, Family Comm), Interventions, Investigations, Insights, Admin. Each group is hidden if the user has no items in it.",
        functions: [
          {
            name: "Quick Access (top of sidebar)",
            what:
              "Promotes 1–3 high-priority items based on pending work. Verify Pullouts gets promoted here when the queue is non-empty (replaces its later in-list slot to avoid duplication).",
            roleBehavior: [
              { role: "Teacher", can: "Sees Hall Passes, Tardies, PBIS Points, My Interventions, Family Comm (per feature flags)." },
              { role: "Dean", can: "Sees Investigations, Hall Passes, Verify Pullouts (when pending)." },
              { role: "Admin", can: "Sees everything that is enabled for the school plus admin-only entries." },
            ],
          },
          {
            name: "Investigations entry",
            what: "Routes to Watchlist Hub. Visibility-gated.",
            roleBehavior: [
              {
                role: ["Admin", "SuperUser", "District Admin", "Dean", "Behavior Specialist", "MTSS Coordinator"],
                can: "See the entry.",
              },
              { role: ["Teacher", "Guidance Counselor", "PBIS Coordinator"], can: "Do not see Investigations in the sidebar." },
            ],
          },
          {
            name: "Settings entry",
            what: "Routes to Settings Hub (tile launcher).",
            roleBehavior: [
              { role: ["Admin", "SuperUser", "District Admin"], can: "Always visible." },
              { role: ["Behavior Specialist", "MTSS Coordinator"], can: "Visible — limited tile set (bell schedules, intervention strategies, etc.)." },
              { role: "Teacher", can: "Hidden." },
            ],
          },
        ],
        notes: [
          "Nav-key feature map: hallPasses → HallPasses, pbis → Pbis, schoolStore → SchoolStore, etc. Admins can disable a feature for their school in Settings → Feature Configuration; the matching nav item disappears for everyone, including Admins, until re-enabled.",
        ],
      },
      {
        id: "shell-school-switcher",
        title: "School Switcher (top bar)",
        navPath: "Top bar, only for multi-school accounts",
        audience: "SuperUser, District Admin",
        purpose:
          "Re-bind the active school context without re-authenticating. Updates req.schoolId for every subsequent request.",
        functions: [
          {
            name: "Switch school",
            what:
              "Persists the chosen school in the staff session. All open tabs/sections re-fetch with the new schoolId.",
            roleBehavior: [
              { role: "SuperUser", can: "Switch to any school in any district." },
              { role: "District Admin", can: "Switch to any school in their district." },
              { role: ["Admin", "Teacher", "Dean", "Behavior Specialist", "MTSS Coordinator"], can: "No switcher — single-school binding." },
            ],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "3. Daily Operations",
    blurb: "The screens teachers and front-office staff use every period.",
    screens: [
      {
        id: "hall-passes",
        title: "Hall Passes",
        navPath: "Sidebar → Hall Passes",
        audience: "All staff (teachers most often)",
        purpose:
          "Issue a hall pass to a student, watch the clock, and check them back in. Powers the in-room flow plus the kiosk signage.",
        functions: [
          {
            name: "Create pass",
            what: "Pick student, destination, optional note. Creates a hall_passes row, may notify the destination teacher's allowlist.",
            roleBehavior: [
              { role: "Teacher", can: "Create a pass for any student in their roster; destination must be on their teacher allowlist if configured." },
              { role: ["Admin", "Dean"], can: "Create passes school-wide (any student, any destination), bypassing teacher allowlist." },
            ],
          },
          {
            name: "Check in / out",
            what: "Stamps left_at and arrived_at, optionally returned_at. Drives stale/red highlighting after threshold.",
            roleBehavior: [
              { role: "Teacher", can: "Check in/out passes they own or that arrive at their room." },
              { role: ["Admin", "Dean"], can: "Override any pass." },
            ],
          },
          {
            name: "Hall Pass Queue",
            what:
              "School-wide queue of active passes. Auto-resets per bell-schedule period (or 45-min idle bucket as fallback). Used at the front desk to spot-check who is out of class.",
            roleBehavior: [
              { role: ["Admin", "Dean", "Behavior Specialist", "MTSS Coordinator"], can: "View and manage." },
              { role: "Teacher", can: "View only." },
            ],
            notes: [
              "Requires a default bell schedule for period-based reset; otherwise falls back to idle-time bucketing.",
            ],
          },
          {
            name: "Per-student pass limit",
            what: "Caps how many passes a student can hold open / per day.",
            roleBehavior: [
              { role: "Admin", can: "Configure global default in Settings → School." },
              { role: "Teacher", can: "Override per student via Roster row." },
            ],
          },
        ],
      },
      {
        id: "tardies",
        title: "Tardy Pass",
        navPath: "Sidebar → Tardy Pass",
        audience: "All staff",
        purpose: "Quick capture of late arrivals tied to a period from the bell schedule.",
        functions: [
          {
            name: "Log tardy",
            what: "Pick student + period; writes a tardies row. Aggregated into Insights → Engagement and the Parent Portal.",
            roleBehavior: [
              { role: "Teacher", can: "Log tardies for their own students." },
              { role: ["Admin", "Dean"], can: "Log for any student." },
            ],
          },
          {
            name: "Edit / delete",
            what: "Correct a wrong-student or wrong-period entry.",
            roleBehavior: [
              { role: "Teacher", can: "Edit their own entries (audit-logged)." },
              { role: "Admin", can: "Edit/delete any entry." },
            ],
          },
        ],
      },
      {
        id: "pbis-points",
        title: "PBIS Points",
        navPath: "Sidebar → PBIS Points",
        audience: "All staff",
        purpose:
          "Award positive-behavior points to students using school-defined reasons. Drives house standings on signage and the school/classroom store ledger.",
        functions: [
          {
            name: "Award points",
            what:
              "Pick student(s) + reason + optional note. Multi-select supported for whole-class awards.",
            roleBehavior: [
              { role: "Teacher", can: "Award to any student in their roster." },
              { role: ["Admin", "Dean", "PBIS Coordinator"], can: "Award school-wide." },
            ],
          },
          {
            name: "Note templates",
            what:
              "Reusable pre-written notes for common awards (e.g. 'On-task during fire drill'). Speeds up entry on slow devices.",
            roleBehavior: [
              { role: "PBIS Coordinator", can: "Manage templates." },
              { role: "Teacher", can: "Pick from templates." },
            ],
          },
          {
            name: "Reasons catalog",
            what: "School-wide list of award reasons (e.g. 'Showed leadership').",
            roleBehavior: [
              { role: "PBIS Coordinator", can: "Add / edit / retire reasons." },
              { role: "Teacher", can: "Use only." },
            ],
          },
        ],
      },
      {
        id: "school-store",
        title: "School Store (read-only catalog)",
        navPath: "Sidebar → School Store",
        audience: "All staff",
        purpose:
          "Browse the school-wide rewards catalog so teachers can answer 'what can I redeem?' from the classroom.",
        functions: [
          {
            name: "Browse items",
            what: "Lists school store items with cost, image, stock.",
            roleBehavior: [{ role: "All staff", can: "Read-only browse." }],
          },
          {
            name: "Redeem",
            what: "Spend a student's PBIS balance for an item; deducts points and writes a store_orders row.",
            roleBehavior: [
              { role: ["PBIS Coordinator", "Admin"], can: "Redeem on a student's behalf." },
              { role: "Teacher", can: "View only — redemption happens at the PBIS Hub or at admin." },
            ],
          },
        ],
      },
      {
        id: "classroom-store",
        title: "Classroom Store",
        navPath: "Inside PBIS Hub / per-teacher",
        audience: "Teachers",
        purpose: "Per-teacher reward catalog (unique to each teacher). Lets teachers run a parallel economy alongside the school store.",
        functions: [
          {
            name: "Manage items",
            what: "CRUD on classroom store items with thumbnail, cost, stock.",
            roleBehavior: [
              { role: "Teacher", can: "Full edit on their own classroom store." },
              { role: "Admin", can: "Read across all teacher catalogs (audit)." },
            ],
          },
          {
            name: "Redeem",
            what: "Spend points for a classroom item.",
            roleBehavior: [{ role: "Teacher", can: "Redeem for their own students." }],
          },
        ],
      },
      {
        id: "spotlight",
        title: "Spotlight",
        navPath: "Header pill / Quick Access",
        audience: "All staff",
        purpose:
          "Recognize a student publicly — short message + optional photo that surfaces on signage.",
        functions: [
          {
            name: "Launch spotlight",
            what: "Pick student, write message, optional emoji. Appears in signage rotation immediately.",
            roleBehavior: [
              { role: "Teacher", can: "Spotlight any student in their roster." },
              { role: ["Admin", "PBIS Coordinator"], can: "Spotlight any student in the school." },
            ],
          },
        ],
      },
      {
        id: "accommodations",
        title: "Accommodations",
        navPath: "Sidebar → Accommodations",
        audience: "All staff who teach the student",
        purpose: "Log when an accommodation was provided (extended time, fidget, separate room, etc.) for IEP/504 evidence.",
        functions: [
          {
            name: "Log accommodation use",
            what: "Pick accommodation + student. Stamps the date and optional context.",
            roleBehavior: [
              { role: "Teacher", can: "Log for their own students." },
              { role: ["MTSS Coordinator", "Admin"], can: "Log school-wide." },
            ],
          },
          {
            name: "View accommodation log",
            what: "Chronological list per student.",
            roleBehavior: [
              { role: "All staff who can see the student", can: "Read." },
              { role: "Parent", can: "Read for their child via Parent Portal (if enabled in Parent Portal Sections)." },
            ],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "4. Interventions (Tier 2 / Tier 3 / MTSS)",
    blurb: "The intervention stack: who logs it, who tracks completion, who reads the strategy catalog.",
    screens: [
      {
        id: "log-intervention",
        title: "Log Intervention",
        navPath: "Sidebar → Log Intervention (tier-aware launcher)",
        audience: "All staff",
        purpose:
          "Single launcher that figures out whether the picked student is on a Tier 2 or Tier 3 plan and routes the form accordingly.",
        functions: [
          {
            name: "Pick student",
            what: "Searches the student finder; surfaces tier badge.",
            roleBehavior: [
              { role: "Teacher", can: "Search across their roster." },
              { role: "Core Team", can: "Search across the entire school." },
            ],
          },
          {
            name: "Submit Tier 2 daily entry",
            what:
              "Daily check-in / check-out signal (CICO) form: morning rating, afternoon rating, behavior notes.",
            roleBehavior: [
              { role: "Teacher", can: "Submit for their own students." },
              { role: "Core Team", can: "Submit on behalf of any teacher." },
            ],
          },
          {
            name: "Submit Tier 3 weekly progress",
            what: "Weekly ratings against goal categories with strategy-used checkboxes.",
            roleBehavior: [
              { role: "Teacher", can: "Submit for their own students." },
              { role: "Core Team", can: "Submit for any student." },
            ],
          },
        ],
      },
      {
        id: "my-interventions",
        title: "My Interventions",
        navPath: "Sidebar → My Interventions",
        audience: "All staff",
        purpose:
          "Personal queue: which of MY students are owed an intervention check-in today? Surfaces the count in the Bell notification.",
        functions: [
          {
            name: "Today list",
            what: "Filterable list of owed entries grouped by student.",
            roleBehavior: [
              { role: "Teacher", can: "See their own owed list." },
              { role: "Core Team", can: "See their own AND a 'Today across school' aggregate." },
            ],
          },
          {
            name: "Bell notification",
            what: "Sidebar bell shows count of owed entries; clicking jumps here.",
            roleBehavior: [{ role: "All staff with owed entries", can: "See the bell." }],
          },
        ],
      },
      {
        id: "intervention-reports",
        title: "Intervention Reports",
        navPath: "Sidebar → Interventions (Core Team only)",
        audience: "Core Team",
        purpose: "Completion-rate report and tier roll-ups across all teachers.",
        functions: [
          {
            name: "Completion report",
            what:
              "% of expected entries actually logged per teacher / per student / per week. Drill-in to see missed days.",
            roleBehavior: [
              { role: "All Core Team", can: "View." },
              { role: "Teacher", can: "Hidden." },
            ],
          },
          {
            name: "Strategy catalog",
            what:
              "School-wide list of Tier 3 strategies grouped by category (e.g. self-regulation, social skills).",
            roleBehavior: [
              { role: "All Core Team", can: "Add / edit / retire categories and strategies." },
              { role: "Teacher", can: "View only via the Tier 3 weekly form." },
            ],
          },
        ],
      },
      {
        id: "mtss-plans",
        title: "MTSS Plans",
        navPath: "Sidebar → MTSS Coordinator hub",
        audience: "MTSS Coordinator + Admins",
        purpose:
          "Tier 2 / Tier 3 intervention plan tracking: goal setting, weekly progress monitoring, completion reports.",
        functions: [
          {
            name: "Create plan",
            what: "Pick student, set tier, choose goal categories, assign owner.",
            roleBehavior: [
              { role: "MTSS Coordinator", can: "Create / edit / archive any plan." },
              { role: "Admin", can: "Same." },
              { role: "Teacher", can: "View their own students' active plans (read-only)." },
            ],
          },
          {
            name: "Goal version history",
            what:
              "Tier 3 goals are append-only versioned — editing a goal creates a new version with effective_from timestamp.",
            roleBehavior: [{ role: "Core Team", can: "Edit (creates new version)." }],
          },
          {
            name: "Weekly progress monitor",
            what: "Rating + note per goal per week.",
            roleBehavior: [
              { role: "Teacher", can: "Submit for their own students on the plan." },
              { role: "Core Team", can: "Submit on behalf of teacher." },
            ],
          },
        ],
      },
      {
        id: "request-pullout",
        title: "Request Pullout",
        navPath: "Sidebar → Request Pullout",
        audience: "Teachers",
        purpose:
          "Teacher requests an intervention pullout for a specific student/period. Admins/Core Team triage and verify in the Verify Pullouts queue.",
        functions: [
          {
            name: "Submit request",
            what: "Pick student + reason from the pullout reasons catalog + period.",
            roleBehavior: [{ role: "Teacher", can: "Submit." }],
          },
          {
            name: "Verify Pullouts (admin queue)",
            what:
              "Queue view of pending requests with approve/reject. Promoted to Quick Access in the sidebar when count > 0.",
            roleBehavior: [
              { role: ["Admin", "Behavior Specialist", "MTSS Coordinator"], can: "Verify, approve, reject, add note." },
              { role: "Teacher", can: "See status of their own requests only." },
            ],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "5. Safety Plans",
    blurb: "Per-student behavioral / physical safety checklists with a school-wide library.",
    screens: [
      {
        id: "safety-plan-editor",
        title: "Safety Plan Editor",
        navPath: "Click red 'SP' pill on the Teacher Roster, or via Investigations",
        audience: "Guidance Counselor + Core Team",
        purpose: "Build/edit a student's active safety plan from the school-wide item library.",
        functions: [
          {
            name: "Add item",
            what: "Pick from the school's library; or write a free-text custom item. Each item carries a category (e.g. de-escalation, restraint protocol).",
            roleBehavior: [
              { role: ["Guidance Counselor", "All Core Team"], can: "Add/edit/remove items, mark plan active/inactive." },
              { role: "Teacher", can: "View the active plan for their own students (read-only)." },
              { role: ["Admin", "Dean"], can: "Read across school." },
            ],
          },
          {
            name: "Audit log",
            what: "Every change is timestamped with author. Append-only.",
            roleBehavior: [{ role: "All who can read the plan", can: "View history." }],
          },
          {
            name: "Library management",
            what: "School-wide reusable items.",
            roleBehavior: [
              { role: ["Guidance Counselor", "All Core Team"], can: "CRUD on the library." },
              { role: "Teacher", can: "Hidden." },
            ],
          },
        ],
        notes: [
          "Active safety plan presence drives the red 'SP' indicator on the Teacher Roster and Student Profile so teachers know to review before a difficult interaction.",
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "6. Investigations (Watchlist Suite)",
    blurb:
      "The discipline investigation stack — Hub, Schoolwide Behavior Network, Case Detail (with Investigation tab), Student Graph. Visibility is gated on Admin / Dean / Behavior Specialist / MTSS Coordinator (the 'Case Investigator' set), with admin-only sub-affordances inside.",
    screens: [
      {
        id: "watchlist-hub",
        title: "Investigations Hub (Watchlist Hub)",
        navPath: "Sidebar → Investigations",
        audience: "Case Investigators (Admin / Dean / Behavior Specialist / MTSS Coordinator) + SuperUser / District Admin",
        purpose:
          "Mission control for behavior cases — alerts, orbit (students in flight), active cases, recent incidents, witness statements queue.",
        functions: [
          {
            name: "Active cases panel",
            what:
              "Top-6 active cases (open/monitoring/escalated) by default. Inline search box + status pill row (Active / Open / Monitoring / Escalated / Closed / All) reveals filtered results live.",
            roleBehavior: [
              { role: "Investigators", can: "Open any case from the panel." },
              { role: "Admin", can: "Plus the '+ New' button to launch the New Case modal." },
            ],
            notes: [
              "Search matches case title, case number (full '25-26-0042' or bare '42'), and lead staff name.",
              "Slice-to-6 only applies when the default Active filter is selected and search is empty; otherwise all matches show.",
            ],
          },
          {
            name: "Orbit list",
            what:
              "Students currently 'in flight' in any active case. Sphere icon next to each links to their Student Graph.",
            roleBehavior: [{ role: "Investigators", can: "Click to drill in." }],
          },
          {
            name: "Statements intake",
            what:
              "Pending witness statements with status (requested / reminded / completed / waived) + Dismissed tab for triaged-out statements that can be restored.",
            roleBehavior: [
              { role: "Investigators", can: "Send reminders, mark complete, dismiss with reason." },
              { role: "Admin", can: "Plus restore-from-dismissed." },
            ],
          },
          {
            name: "Recent incidents feed",
            what:
              "Loose interactions not yet promoted to a case. Includes severity color coding.",
            roleBehavior: [
              { role: "Investigators", can: "Promote to a new case (opens Promote-to-Case modal) or attach to an existing case." },
              { role: "Admin", can: "Same plus delete." },
            ],
          },
          {
            name: "Open Schoolwide Behavior Network button",
            what: "Routes to the network visualization.",
            roleBehavior: [{ role: "Investigators", can: "Click." }],
          },
        ],
      },
      {
        id: "watchlist-network",
        title: "Schoolwide Behavior Network",
        navPath: "Investigations Hub → 'Open Network' button",
        audience: "Case Investigators",
        purpose:
          "School-wide spider-web map of who keeps showing up together in incidents. Each active case is its own ring of student spheres; the loose ring at the top holds students with interactions but no case.",
        functions: [
          {
            name: "Time window filter",
            what: "Restrict to last N days (default 30).",
            roleBehavior: [{ role: "Investigators", can: "Change window." }],
          },
          {
            name: "Click sphere",
            what: "Opens the Student Graph for that student.",
            roleBehavior: [{ role: "Investigators", can: "Drill in." }],
          },
          {
            name: "Click case label",
            what: "Opens the Case Detail.",
            roleBehavior: [{ role: "Investigators", can: "Drill in." }],
          },
          {
            name: "Sphere sizing",
            what:
              "Adapts to spiral spacing (clamp 0.45–1.6 of base) so high-frequency students visibly pop on dense schools without overwhelming a sparse view.",
            roleBehavior: [{ role: "All viewers", can: "Read sizing as visual cue." }],
          },
        ],
      },
      {
        id: "watchlist-case",
        title: "Case Detail",
        navPath: "Hub → click case row, or Network → click case label",
        audience: "Case Investigators (visibility) + Admins (admin-only sub-affordances)",
        purpose: "All artifacts of one investigation: incidents, participants, statements, video evidence, AI consistency check, notes, audit log.",
        functions: [
          {
            name: "Tab nav: Overview / Investigation",
            what:
              "Overview is the default participant + incidents list. Investigation tab launches the per-incident ring (see next screen).",
            roleBehavior: [{ role: "All who can see the case", can: "Switch tabs." }],
          },
          {
            name: "Edit title / summary / lead",
            what: "Inline edit with audit row.",
            roleBehavior: [
              { role: ["Admin", "Dean", "Behavior Specialist", "MTSS Coordinator"], can: "Edit." },
            ],
          },
          {
            name: "Change status",
            what:
              "Move between open / monitoring / escalated. Closing requires the dedicated Close modal (cannot be done via this dropdown).",
            roleBehavior: [
              { role: "Investigators", can: "Move between non-closed statuses." },
              { role: "All", can: "Cannot reopen via PATCH — server rejects status='open' on a currently-closed case and directs to /reopen." },
            ],
          },
          {
            name: "Close case (modal)",
            what:
              "Opens CloseCaseModal: required outcome dropdown (from the school's catalog), required note when outcome is 'other'. Writes outcome_code, outcome_note, closed_by_*, audit row.",
            roleBehavior: [
              { role: "Investigators", can: "Close." },
              { role: "All", can: "Cannot close without picking an outcome — server enforces." },
            ],
          },
          {
            name: "Reopen case",
            what:
              "Admin-only. Prompts for a reason (≥5 chars). Preserves prior outcome metadata; flips status to open and writes audit row.",
            roleBehavior: [
              { role: ["Admin", "SuperUser", "District Admin"], can: "Reopen." },
              { role: ["Dean", "Behavior Specialist", "MTSS Coordinator"], can: "Hidden — server returns 403." },
            ],
          },
          {
            name: "Witness statements panel",
            what: "Per-incident statements with reader, complete/remind/dismiss/restore.",
            roleBehavior: [
              { role: "Investigators", can: "Manage." },
            ],
          },
          {
            name: "@-mention chips in statements / notes",
            what: "Typing @ inserts a structured chip (Display Name | STUDENTID). Persisted in the body and indexed in case_mentions.",
            roleBehavior: [{ role: "Anyone editing statement / note", can: "Insert chips." }],
          },
          {
            name: "MentionSuggestStrip",
            what:
              "After typing/save preview, AI scans the body against the roster and proposes additional mentions ('We think this also references X, Y'). One-click insert.",
            roleBehavior: [
              { role: "Anyone editing", can: "See suggestions; suggestions are NOT auto-confirmed — they only become structured mentions when the user clicks insert." },
            ],
          },
          {
            name: "AI Consistency Check (admin-only)",
            what:
              "Header pill + side panel + per-row dot. Runs Anthropic against statements within the case, flags contradictions/corroborations.",
            roleBehavior: [
              { role: ["Admin", "SuperUser", "District Admin"], can: "Run / view findings; dismiss with justification." },
              { role: ["Dean", "Behavior Specialist", "MTSS Coordinator"], can: "Hidden." },
            ],
            notes: ["Phase-3 of the case suite. Dismissal is persistent suppression scoped to the case."],
          },
          {
            name: "Video Evidence panel (admin-only)",
            what: "Upload / link camera feed clips, tag students appearing in the clip.",
            roleBehavior: [
              { role: ["Admin", "SuperUser", "District Admin"], can: "Manage." },
              { role: "Other Investigators", can: "Hidden." },
            ],
          },
          {
            name: "Case notes (timeline)",
            what: "Append-only running notes (meeting summaries, parent calls, room moves).",
            roleBehavior: [{ role: "All who can see the case", can: "Add notes." }],
          },
          {
            name: "Footage requests panel",
            what: "Request that the camera operator pull a window of footage; tracks status.",
            roleBehavior: [{ role: "Investigators", can: "Submit / view." }],
          },
        ],
      },
      {
        id: "watchlist-investigation",
        title: "Investigation Tab (per-incident ring)",
        navPath: "Case Detail → Investigation tab",
        audience: "Case Investigators",
        purpose:
          "Per-incident witness graph. Center = the incident; rings = principals, witnesses with statements, mentioned-but-silent students.",
        functions: [
          {
            name: "Incident selector",
            what: "Pick which incident on the case to render.",
            roleBehavior: [{ role: "Investigators", can: "Switch incidents." }],
          },
          {
            name: "Ring layout",
            what:
              "Anchor (incident) at center; principal participants closest; witness-statement authors next; mentioned-but-silent on the outer ring.",
            roleBehavior: [{ role: "Investigators", can: "Read." }],
          },
          {
            name: "Edges",
            what:
              "Drawn ONLY from confirmed structured @-mentions in case_mentions, plus corroborate/contradict pairs from case_consistency_findings. AI suggestions never become edges until confirmed.",
            roleBehavior: [{ role: "All viewers", can: "Read edges as evidence trail." }],
          },
          {
            name: "Side panel (statement reader)",
            what: "Reuses the case detail's statement reader; shows the highlighted mention's neighborhood.",
            roleBehavior: [{ role: "All who can see the statement", can: "Read." }],
          },
          {
            name: "Request statement (mentioned-only spheres)",
            what:
              "If a student is mentioned in someone else's statement but has no statement of their own, a 'Request statement' button appears on their sphere.",
            roleBehavior: [{ role: "Investigators", can: "Send request — creates a witness_statements row in 'requested' state." }],
          },
        ],
      },
      {
        id: "watchlist-student-graph",
        title: "Student Graph",
        navPath: "Network sphere click, or Hub orbit click",
        audience: "Investigators",
        purpose: "Single-student spider — every case the student touches and the other students they overlap with.",
        functions: [
          {
            name: "Open case from graph",
            what: "Click any case label.",
            roleBehavior: [{ role: "Investigators", can: "Drill in." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "7. Insights Dashboards",
    blurb:
      "Aggregate analytics across the school. All dashboards share grade and time-window filters and support drill-down to a Student Profile.",
    screens: [
      {
        id: "insights-watchlist",
        title: "Insights → Student Watchlist",
        navPath: "Sidebar → Insights → Watchlist",
        audience: "All staff",
        purpose: "Per-staffer watchlist of students they want to keep an eye on; cross-references HeartBEAT data.",
        functions: [
          {
            name: "Add student to my watchlist",
            what: "Star a student to subscribe to their daily roll-up.",
            roleBehavior: [{ role: "All staff", can: "Manage their own list." }],
          },
          {
            name: "Group entries",
            what: "Bucket your watchlisted students by tag (e.g. 'AM Tier 2 cohort').",
            roleBehavior: [{ role: "All staff", can: "Manage their own groups." }],
          },
        ],
      },
      {
        id: "insights-engagement",
        title: "Engagement Dashboard",
        navPath: "Sidebar → Insights → Engagement",
        audience: "All staff",
        purpose:
          "Tardies, attendance, hall-pass time-out-of-class. Top-N lists per grade with disaggregation by demographic (when configured).",
        functions: [
          {
            name: "Filters",
            what: "Grade band, time window, optional demographic disaggregation.",
            roleBehavior: [{ role: "All staff", can: "Filter." }],
          },
          {
            name: "Drill-in to student",
            what: "Click a row to open Student Profile with the same time window pre-applied.",
            roleBehavior: [{ role: "All staff", can: "Drill." }],
          },
        ],
      },
      {
        id: "insights-behavior",
        title: "Behavior Dashboard",
        navPath: "Sidebar → Insights → Behavior",
        audience: "All staff",
        purpose: "Discipline incidents, escalations, repeat actors, location heat.",
        functions: [
          { name: "Top-N", what: "Repeat actors / locations.", roleBehavior: [{ role: "All staff", can: "View." }] },
          { name: "Drill-in", what: "Open the case file or student profile.", roleBehavior: [{ role: "Investigators", can: "Open case file." }, { role: "Teacher", can: "Open student profile only." }] },
        ],
      },
      {
        id: "insights-academics",
        title: "Academics Dashboard",
        navPath: "Sidebar → Insights → Academics",
        audience: "All staff",
        purpose: "FAST scores and academic trajectory.",
        functions: [
          {
            name: "Trajectory chart",
            what: "Per-window FAST scores plotted with grade-level reference lines.",
            roleBehavior: [{ role: "All staff", can: "View." }],
          },
        ],
      },
      {
        id: "insights-sebsel",
        title: "SEB / SEL Dashboard",
        navPath: "Sidebar → Insights → SEB/SEL",
        audience: "Core Team + Counselors",
        purpose: "Social-emotional and behavioral screener data, intervention overlay.",
        functions: [
          {
            name: "Cohort view",
            what: "Filter to students with screener scores in a band.",
            roleBehavior: [{ role: "Core Team + Guidance Counselor", can: "View." }],
          },
        ],
      },
      {
        id: "insights-equity",
        title: "Equity Dashboard",
        navPath: "Sidebar → Insights → Equity",
        audience: "Admins + District Admin",
        purpose: "Disparities across race / IEP / 504 / ELL bands for discipline and engagement.",
        functions: [
          {
            name: "Disaggregation table",
            what: "Side-by-side rates by demographic.",
            roleBehavior: [
              { role: ["Admin", "District Admin", "SuperUser"], can: "View." },
              { role: ["Teacher", "Dean"], can: "Hidden by school policy gate (configurable)." },
            ],
          },
        ],
      },
      {
        id: "insights-early-warning",
        title: "Early Warning Dashboard",
        navPath: "Sidebar → Insights → Early Warning",
        audience: "Core Team",
        purpose:
          "Composite indicators (attendance, behavior, academic, intervention completion) flagging students sliding off track.",
        functions: [
          {
            name: "Threshold tuning",
            what:
              "Score weighting per indicator. Persisted per-school in Settings → PBIS Thresholds and equivalent.",
            roleBehavior: [{ role: "Admin", can: "Tune." }, { role: "Core Team", can: "View." }],
          },
        ],
      },
      {
        id: "student-profile",
        title: "Student Profile",
        navPath: "Drill-in from any dashboard or roster",
        audience: "All staff who can see the student",
        purpose: "Single-student 360°: HeartBEAT, FAST, accommodations, safety plan badge, current cases, intervention plans, parent contacts.",
        functions: [
          {
            name: "Tabs",
            what: "Engagement / Behavior / Academics / SEB / Interventions / Notes.",
            roleBehavior: [{ role: "All staff who teach or work with the student", can: "Read." }],
          },
          {
            name: "Add staff note",
            what: "Free-text note pinned to the student's profile.",
            roleBehavior: [
              { role: "Teacher", can: "Add notes for their own students." },
              { role: "Core Team", can: "Add for any student." },
            ],
          },
          {
            name: "Open case from profile",
            what: "Direct link to any case the student is on.",
            roleBehavior: [{ role: "Investigators", can: "Open." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "8. Teacher Roster",
    blurb: "The day-to-day teacher view of their students.",
    screens: [
      {
        id: "teacher-roster",
        title: "Teacher Roster",
        navPath: "Sidebar → Quick Access → Roster",
        audience: "Teachers (their own); Core Team (any teacher's)",
        purpose:
          "List view of students the teacher is responsible for, with FAST scores, ESE/504/ELL flags, safety plan indicator, and quick actions.",
        functions: [
          {
            name: "Row actions",
            what:
              "Pass / Tardy / PBIS / Spotlight / Open Profile / Open Safety Plan (when present).",
            roleBehavior: [
              { role: "Teacher", can: "Use any action on a student in their own roster." },
              { role: "Core Team", can: "Same on any teacher's roster." },
            ],
          },
          {
            name: "FAST scores column",
            what: "Most recent score with delta from prior window.",
            roleBehavior: [{ role: "All viewers", can: "Read." }],
          },
          {
            name: "Program flags",
            what: "ESE / 504 / ELL pills next to the name.",
            roleBehavior: [{ role: "All viewers", can: "Read." }],
          },
          {
            name: "Safety Plan pill ('SP' red badge)",
            what: "Indicates the student has an active safety plan; click to open editor.",
            roleBehavior: [
              { role: "Teacher", can: "Click → opens read-only viewer." },
              { role: ["Guidance Counselor", "Core Team"], can: "Click → opens editor." },
            ],
          },
          {
            name: "Switch to another teacher's roster",
            what: "Dropdown at top.",
            roleBehavior: [
              { role: "Teacher", can: "Hidden." },
              { role: "Core Team", can: "Switch to any teacher in the school." },
            ],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "9. Admin Hub & ISS",
    blurb: "Admin-facing operational dashboards: ISS log, recent admin actions, Verify Pullouts, ISS Dashboard.",
    screens: [
      {
        id: "admin-hub",
        title: "Admin Hub",
        navPath: "Sidebar → Admin Hub",
        audience: "Admin (and SuperUser/District Admin)",
        purpose: "Recent admin activity feed: ISS assignments, OSS, dismissals, role changes.",
        functions: [
          {
            name: "Recent feed",
            what:
              "Reverse-chron list of admin actions. Click row → opens the underlying record.",
            roleBehavior: [
              { role: ["Admin", "SuperUser", "District Admin"], can: "View any action." },
            ],
          },
          {
            name: "ISS log row → detail (planned)",
            what:
              "Future: click an ISS assignment to see the full record with edit/delete affordances guarded by 'has any day been served yet'. Required reason-for-edit prompt; audit row written. (See replit.md → Future work.)",
            roleBehavior: [{ role: "Admin", can: "Will edit when shipped." }],
          },
        ],
      },
      {
        id: "iss-dashboard",
        title: "ISS Dashboard",
        navPath: "Sidebar → ISS Dashboard",
        audience: "Admin + ISS room staff (capability-flag granted)",
        purpose:
          "Daily roster of students serving in-school suspension; per-period attendance marking, served/rolled state, redirect to OSS handoff if needed.",
        functions: [
          {
            name: "Mark period present",
            what: "Updates iss_attendance_day row.",
            roleBehavior: [
              { role: "ISS room staff", can: "Mark present per period." },
              { role: "Admin", can: "Mark + override." },
            ],
          },
          {
            name: "Roll forward",
            what: "Carry uncompleted day to next school day.",
            roleBehavior: [{ role: "Admin", can: "Roll." }],
          },
        ],
      },
      {
        id: "verify-pullouts",
        title: "Verify Pullouts",
        navPath: "Sidebar → Quick Access (when pending) or Verify Pullouts entry",
        audience: "Admin / Behavior Specialist / MTSS Coordinator",
        purpose: "Approve teacher-submitted intervention pullout requests.",
        functions: [
          {
            name: "Approve / Reject",
            what: "Final disposition + optional note. Approved pullouts surface in My Interventions and student plan.",
            roleBehavior: [
              { role: ["Admin", "Behavior Specialist", "MTSS Coordinator"], can: "Approve / reject." },
            ],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "10. Displays / Signage",
    blurb: "TV signage in hallways and the kiosk experience.",
    screens: [
      {
        id: "displays",
        title: "Displays (admin)",
        navPath: "Sidebar → Displays",
        audience: "Admin / Core Team / staff with cap_manage_displays",
        purpose: "Per-school playlists for digital signage TVs (image, video, audio, PDF).",
        functions: [
          {
            name: "Manage playlist",
            what: "Add / reorder / schedule items.",
            roleBehavior: [
              { role: "Core Team", can: "Manage." },
              { role: "Teacher with cap_manage_displays", can: "Manage." },
            ],
          },
          {
            name: "Per-display override",
            what: "Pin a single item or freeze the rotation on a specific TV.",
            roleBehavior: [{ role: "Admin", can: "Override." }],
          },
          {
            name: "Heartbeat sections",
            what: "Curated cards (PBIS standings, hall pass live count, etc.) configured per school.",
            roleBehavior: [{ role: "Admin", can: "Configure visibility." }],
          },
        ],
      },
      {
        id: "display-show",
        title: "Display Show (TV-facing)",
        navPath: "/signage/* (no auth — opens via signed kiosk URL)",
        audience: "Public TV viewers",
        purpose: "Read-only fullscreen rotation of the playlist + Heartbeat cards.",
        functions: [
          { name: "Auto-rotate", what: "Cycles items per schedule.", roleBehavior: [{ role: "Public viewers", can: "Watch." }] },
          { name: "Active hall pass strip", what: "Live count of out-of-class students.", roleBehavior: [{ role: "Public viewers", can: "Watch." }] },
        ],
      },
      {
        id: "kiosk-banner",
        title: "Kiosk Banner / Activation",
        navPath: "Settings → Kiosk Setup",
        audience: "Admin",
        purpose: "Provisioning a hallway tablet/computer as a hall pass kiosk with a stable token.",
        functions: [
          {
            name: "Activate kiosk",
            what: "Generates a kiosk activation token; the device exchanges it for a long-lived viewer token.",
            roleBehavior: [{ role: "Admin", can: "Activate." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "11. Data Importer",
    blurb: "CSV upload pipeline for assessments, rosters, and behavior data.",
    screens: [
      {
        id: "data-imports",
        title: "Data Imports",
        navPath: "Settings → Data Imports",
        audience: "Admin",
        purpose:
          "Upload CSV → pick template → preview mapped rows → commit. Each import is rollback-able while still in the audit window.",
        functions: [
          {
            name: "Upload CSV",
            what: "Drop file, choose template (Assessments / Roster / Behavior).",
            roleBehavior: [{ role: "Admin", can: "Upload." }],
          },
          {
            name: "Preview & map",
            what: "Show first N rows mapped to columns; warn on type mismatches.",
            roleBehavior: [{ role: "Admin", can: "Preview." }],
          },
          {
            name: "Commit",
            what: "Persist rows. Returns import_id for rollback.",
            roleBehavior: [{ role: "Admin", can: "Commit." }],
          },
          {
            name: "Rollback",
            what: "Reverse a prior import within the rollback window.",
            roleBehavior: [{ role: "Admin", can: "Rollback." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "12. Settings (per tile)",
    blurb:
      "Settings hub launches every per-school configuration tile. Tiles a user can't open are hidden, so the visible set IS their permission profile.",
    screens: [
      {
        id: "settings-hub",
        title: "Settings Hub (launcher)",
        navPath: "Sidebar → Settings",
        audience: "Admin / Core Team / SuperUser / District Admin",
        purpose:
          "Tile launcher grouped by Hall Pass Operations / School Identity & Schedule / Family & Signage / Feature Configuration / Admin & Tenancy.",
        functions: [
          {
            name: "Open a tile",
            what: "Routes to the tile's editor.",
            roleBehavior: [{ role: "Admin", can: "See all tiles." }, { role: "Core Team", can: "See subset." }],
          },
        ],
      },
      {
        id: "settings-bell-schedule",
        title: "Bell Schedules",
        navPath: "Settings → Bell Schedule",
        audience: "Admin / Behavior Specialist / MTSS Coordinator",
        purpose: "Define periods. Mark one schedule as default — required for the Hall Pass Queue's period-based reset.",
        functions: [
          { name: "Create / edit schedule", what: "Period list with start/end times.", roleBehavior: [{ role: "Admin / BS / MTSS", can: "Edit." }] },
          { name: "Mark default", what: "Drives queue reset.", roleBehavior: [{ role: "Admin / BS / MTSS", can: "Mark." }] },
        ],
      },
      {
        id: "settings-locations",
        title: "Locations & Allowlist",
        navPath: "Settings → Locations / Allowlist / Teacher Allowlist",
        audience: "Admin",
        purpose: "Control valid hall pass destinations and which teachers may receive passes.",
        functions: [
          { name: "Manage location list", what: "CRUD on locations.", roleBehavior: [{ role: "Admin", can: "Edit." }] },
          { name: "Manage destination allowlist", what: "Per-teacher receivable destinations.", roleBehavior: [{ role: "Admin", can: "Edit." }] },
        ],
      },
      {
        id: "settings-school",
        title: "School (identity)",
        navPath: "Settings → School",
        audience: "Admin",
        purpose: "School name, address, default pass limit, time zone references.",
        functions: [{ name: "Edit fields", what: "—", roleBehavior: [{ role: "Admin", can: "Edit." }] }],
      },
      {
        id: "settings-branding",
        title: "School Branding & Logo Generator",
        navPath: "Settings → Branding / Logo Generator",
        audience: "Admin",
        purpose: "Upload school logo, set color palette, generate alternate logo variants.",
        functions: [
          { name: "Upload logo", what: "Object Storage backed; school-scoped ACL.", roleBehavior: [{ role: "Admin", can: "Upload." }] },
          { name: "Generate variants", what: "AI-generated logo variants.", roleBehavior: [{ role: "Admin", can: "Generate." }] },
        ],
      },
      {
        id: "settings-pbis-thresholds",
        title: "PBIS Thresholds",
        navPath: "Settings → PBIS Thresholds",
        audience: "Admin / PBIS Coordinator",
        purpose: "Tune house standings cutoffs, store affordability thresholds, milestone bands.",
        functions: [{ name: "Edit thresholds", what: "Persists to school_settings.", roleBehavior: [{ role: "Admin / PBIS Coordinator", can: "Edit." }] }],
      },
      {
        id: "settings-features",
        title: "School Feature Configuration",
        navPath: "Settings → School Features",
        audience: "Admin",
        purpose:
          "Master switches: Hall Passes / Tardy Pass / Family Comm / PBIS / School Store / Accommodations / Log Intervention / Request Pullout / MTSS Plans / Bell Schedule / Displays.",
        functions: [
          {
            name: "Toggle feature",
            what:
              "Off → corresponding sidebar item hidden for everyone in the school. Used to onboard a school in stages.",
            roleBehavior: [{ role: "Admin", can: "Toggle." }],
          },
        ],
      },
      {
        id: "settings-parent-portal-sections",
        title: "Parent Portal Sections",
        navPath: "Settings → Parent Portal Sections",
        audience: "Admin",
        purpose: "Configure which HeartBEAT sections (PBIS, hall passes, tardies, accommodations, staff notes) parents see.",
        functions: [{ name: "Toggle section", what: "Per-section on/off.", roleBehavior: [{ role: "Admin", can: "Toggle." }] }],
      },
      {
        id: "settings-school-wide-expectations",
        title: "School-wide Expectations",
        navPath: "Settings → Expectations",
        audience: "Admin / PBIS Coordinator",
        purpose: "Define the school's PBIS expectations matrix (e.g. Be Respectful / Be Responsible / Be Safe across locations).",
        functions: [{ name: "Edit matrix", what: "—", roleBehavior: [{ role: "Admin / PBIS Coordinator", can: "Edit." }] }],
      },
      {
        id: "settings-intervention-strategies",
        title: "Intervention Strategies",
        navPath: "Settings → Intervention Strategies",
        audience: "Core Team",
        purpose: "Strategy categories + strategies for the Tier 3 weekly form.",
        functions: [
          { name: "CRUD on categories / strategies", what: "—", roleBehavior: [{ role: "Core Team", can: "Edit." }] },
        ],
      },
      {
        id: "settings-iss",
        title: "ISS Settings",
        navPath: "Settings → ISS Settings",
        audience: "Admin",
        purpose: "Reasons catalog, per-day period count, roll-forward behavior.",
        functions: [{ name: "Edit", what: "—", roleBehavior: [{ role: "Admin", can: "Edit." }] }],
      },
      {
        id: "settings-staff-defaults",
        title: "Staff Defaults",
        navPath: "Settings → Staff Defaults",
        audience: "Admin",
        purpose: "Default permissions / capabilities applied to any newly-added staff member.",
        functions: [{ name: "Set defaults", what: "—", roleBehavior: [{ role: "Admin", can: "Edit." }] }],
      },
      {
        id: "settings-staff-directory",
        title: "Staff Directory",
        navPath: "Settings → Staff Directory",
        audience: "Admin",
        purpose: "List of all staff for the school with role pills and last-login.",
        functions: [
          { name: "Open Roles Matrix", what: "Bulk role granting/revoking.", roleBehavior: [{ role: "Admin", can: "Open." }] },
        ],
      },
      {
        id: "settings-cameras",
        title: "Camera Registry",
        navPath: "Settings → Cameras",
        audience: "Admin (capability-flagged)",
        purpose: "Catalog of building cameras for footage requests in cases.",
        functions: [
          { name: "Add camera", what: "Name, location, identifier.", roleBehavior: [{ role: "Admin", can: "Add." }] },
        ],
      },
      {
        id: "settings-case-outcomes",
        title: "Case Outcomes Catalog",
        navPath: "Settings → Case Outcomes",
        audience: "Admin / SuperUser / District Admin",
        purpose:
          "Per-school configurable catalog of case-closure outcomes. Closing a case requires picking from this catalog (no skip).",
        functions: [
          {
            name: "List active outcomes",
            what:
              "Default seeded set: no_action / conflict_resolution / mediation / parent_contact / office_referral / iss_assigned / oss_assigned / safety_plan_update / other.",
            roleBehavior: [{ role: "Admin / SuperUser / District Admin", can: "View." }],
          },
          {
            name: "Add / edit / disable",
            what:
              "Inline edit label + description + sort order; toggle active. Disabling retires the outcome from new closures but preserves historical citations.",
            roleBehavior: [{ role: "Admin / SuperUser / District Admin", can: "Edit." }],
          },
        ],
      },
      {
        id: "settings-tenancy",
        title: "Tenancy",
        navPath: "Settings → Tenancy",
        audience: "SuperUser only",
        purpose: "Add/rename schools, manage districts.",
        functions: [
          { name: "Add school", what: "—", roleBehavior: [{ role: "SuperUser", can: "Add." }] },
          { name: "Rename / archive", what: "—", roleBehavior: [{ role: "SuperUser", can: "Edit." }] },
        ],
      },
      {
        id: "settings-notifications",
        title: "Notifications",
        navPath: "Settings → Notifications",
        audience: "Admin",
        purpose: "Pending admin notifications (alerts that require attention) + email-reminder configuration.",
        functions: [
          { name: "Read / dismiss", what: "—", roleBehavior: [{ role: "Admin", can: "Manage." }] },
        ],
      },
      {
        id: "settings-staff-preview",
        title: "Staff Preview ('view-as')",
        navPath: "Settings → Staff Preview",
        audience: "Admin",
        purpose:
          "Render the app as if signed in as another staff role to verify what they see (no impersonation in writes).",
        functions: [
          { name: "Pick a role profile", what: "Read-only preview lens.", roleBehavior: [{ role: "Admin", can: "Preview." }] },
        ],
      },
      {
        id: "settings-school-plans",
        title: "School Plans (safety plan library)",
        navPath: "Settings → School Plans",
        audience: "Guidance Counselor + Core Team",
        purpose: "School-wide safety plan item library + categories.",
        functions: [
          {
            name: "CRUD on items",
            what: "—",
            roleBehavior: [{ role: "Guidance Counselor + Core Team", can: "Edit." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "13. Parent Portal",
    blurb:
      "Standalone /parent/* application bundled with the staff app. Parents sign in via magic-link invites managed by Admins.",
    screens: [
      {
        id: "parent-access",
        title: "Parent Access (admin tooling)",
        navPath: "Sidebar → Family Communication → Parent Access",
        audience: "Admin",
        purpose:
          "Manage parent invites, link parents to students, configure which sections each parent sees, send invitation emails.",
        functions: [
          { name: "Invite parent", what: "Email + link to one or more students.", roleBehavior: [{ role: "Admin", can: "Invite." }] },
          { name: "Revoke", what: "Disable a parent's access.", roleBehavior: [{ role: "Admin", can: "Revoke." }] },
        ],
      },
      {
        id: "parent-portal",
        title: "Parent HeartBEAT (the parent's view)",
        navPath: "/parent/* (separate from staff app)",
        audience: "Parent",
        purpose: "Read-only HeartBEAT data for their student(s).",
        functions: [
          {
            name: "View HeartBEAT",
            what:
              "PBIS, hall passes, tardies, accommodations, staff notes — exactly the sections enabled in Settings → Parent Portal Sections.",
            roleBehavior: [{ role: "Parent", can: "Read for any linked student." }],
          },
          {
            name: "Sibling switcher",
            what: "Switch between children when one parent account is linked to multiple students.",
            roleBehavior: [{ role: "Parent", can: "Switch." }],
          },
          {
            name: "Export PDF",
            what: "Download a snapshot of the report.",
            roleBehavior: [{ role: "Parent", can: "Export." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "14. Cross-cutting Concerns",
    blurb:
      "Behaviors that are not a screen on their own but are visible across many screens. Worth a separate read so QA covers them on every relevant page.",
    screens: [
      {
        id: "cc-multitenancy",
        title: "Multi-tenancy & School Scoping",
        navPath: "Every server route, every dashboard query",
        audience: "All staff",
        purpose:
          "Every read/write filters by req.schoolId. SuperUser may operate across schools but the active context is still bound; District Admin works district-wide.",
        functions: [
          {
            name: "Cross-school reads (District Admin)",
            what: "District Overview aggregates every school side-by-side; underlying queries filter by district_id and group by school_id.",
            roleBehavior: [{ role: "District Admin", can: "Read across district." }],
          },
        ],
        notes: [
          "QA: every list view should be re-tested with a multi-school account context-switched mid-session to confirm the previous school's rows do not leak in.",
        ],
      },
      {
        id: "cc-audit",
        title: "Audit Trails",
        navPath: "Investigations Case Detail, ISS log (planned), interaction edits",
        audience: "Admin (read), all editors (write)",
        purpose:
          "Sensitive mutations write an audit row with actor, before/after JSON, and a required reason on certain actions (case reopen, future ISS edits).",
        functions: [
          {
            name: "Reopen case",
            what: "Required reason ≥5 chars; audit payload includes prior outcome code.",
            roleBehavior: [{ role: ["Admin", "SuperUser", "District Admin"], can: "Reopen + reason." }],
          },
          {
            name: "Edit / dismiss with reason",
            what:
              "Several flows already require a justification (statement dismiss, AI consistency dismiss). Planned: ISS edit/trim/delete with required reason.",
            roleBehavior: [{ role: "Admin", can: "Edit + reason." }],
          },
        ],
      },
      {
        id: "cc-feature-flags",
        title: "Feature Flags (per-school)",
        navPath: "Settings → School Features",
        audience: "Admin",
        purpose:
          "Disabling a feature hides every entry point: sidebar item, Quick Access promotion, dashboard tile.",
        functions: [
          {
            name: "Disable a feature",
            what: "Server keeps data but UI is hidden.",
            roleBehavior: [{ role: "Admin", can: "Disable." }],
          },
        ],
      },
      {
        id: "cc-help",
        title: "How-to-use Help (HowToUseHelp)",
        navPath: "Inline on every major screen",
        audience: "All staff",
        purpose:
          "Per-screen collapsible 'How to use' panel with role-aware sections (RoleSection). Source of truth for in-app docs; should be refreshed any time a screen gains a new affordance.",
        functions: [
          {
            name: "Read help",
            what: "Click to expand.",
            roleBehavior: [{ role: "All staff", can: "Read." }],
          },
        ],
      },
    ],
  },
];

// -------------------------------------------------------------------------
// PDF RENDERING
// -------------------------------------------------------------------------

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 64, bottom: 64, left: 64, right: 64 },
  bufferPages: true,
  info: {
    Title: "PulseEDU Workflow Guide",
    Author: "PulseEDU Engineering",
    Subject: "Screen-by-screen, function-by-function, per-role workflow reference",
  },
});
const stream = createWriteStream(OUT);
doc.pipe(stream);

const FONT_BODY = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_OBL = "Helvetica-Oblique";

function pageBreakIfNear(needed: number) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function drawFootersOnAllPages() {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const w =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font(FONT_BODY).fontSize(8).fillColor(COLORS.inkFaint);
    doc.text(
      "PulseEDU Workflow Guide — confidential developer reference",
      doc.page.margins.left,
      doc.page.height - 40,
      { width: w, align: "left", lineBreak: false },
    );
    doc.text(
      `p. ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - 40,
      { width: w, align: "right", lineBreak: false },
    );
  }
}

// ---------- Cover ----------
doc.fillColor(COLORS.brand).font(FONT_BOLD).fontSize(36);
doc.text("PulseEDU", { align: "left" });
doc.moveDown(0.2);
doc.fillColor(COLORS.ink).fontSize(28);
doc.text("Workflow Guide");
doc.moveDown(0.4);
doc.fillColor(COLORS.inkSoft).font(FONT_OBL).fontSize(14);
doc.text(
  "Screen-by-screen, function-by-function, per-role reference for the engineering team.",
);
doc.moveDown(2);
doc.fillColor(COLORS.ink).font(FONT_BODY).fontSize(11);
doc.text(
  "This document maps every screen in the PulseEDU staff and parent applications to the functions exposed on it, and for each function describes what each user role can do. It is intended as a baseline test plan for QA and as a single-source-of-truth for product handoffs to new engineers.",
  { align: "left" },
);
doc.moveDown(1);
doc.fillColor(COLORS.inkSoft).fontSize(10);
doc.text(`Generated: ${new Date().toISOString().slice(0, 10)}`);
doc.text("Source: lib/db/src/schema, artifacts/api-server/src/routes, artifacts/client/src/components");

doc.addPage();

// ---------- How to read ----------
function h1(s: string) {
  pageBreakIfNear(60);
  doc.moveDown(0.5);
  doc.font(FONT_BOLD).fontSize(20).fillColor(COLORS.brand).text(s);
  doc.moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .lineWidth(1).strokeColor(COLORS.rule).stroke();
  doc.moveDown(0.6);
  doc.fillColor(COLORS.ink);
}

function h2(s: string) {
  pageBreakIfNear(50);
  doc.moveDown(0.6);
  doc.font(FONT_BOLD).fontSize(14).fillColor(COLORS.accent).text(s);
  doc.moveDown(0.2);
  doc.fillColor(COLORS.ink);
}

function h3(s: string) {
  pageBreakIfNear(40);
  doc.moveDown(0.4);
  doc.font(FONT_BOLD).fontSize(11.5).fillColor(COLORS.ink).text(s);
  doc.moveDown(0.15);
}

function p(s: string, opts: { italic?: boolean; soft?: boolean; size?: number } = {}) {
  doc
    .font(opts.italic ? FONT_OBL : FONT_BODY)
    .fontSize(opts.size ?? 10.5)
    .fillColor(opts.soft ? COLORS.inkSoft : COLORS.ink)
    .text(s, { align: "left" });
  doc.moveDown(0.25);
}

function bullet(s: string) {
  doc.font(FONT_BODY).fontSize(10).fillColor(COLORS.ink);
  doc.text(`• ${s}`, { indent: 12, align: "left" });
  doc.moveDown(0.1);
}

function kv(key: string, value: string) {
  doc.font(FONT_BOLD).fontSize(10).fillColor(COLORS.inkSoft).text(`${key}: `, { continued: true });
  doc.font(FONT_BODY).fillColor(COLORS.ink).text(value);
  doc.moveDown(0.1);
}

function roleStr(r: RoleAction["role"]): string {
  if (Array.isArray(r)) return r.join(", ");
  return r;
}

// ---------- Overview page ----------
h1("How to read this guide");
p(
  "The guide is organized top-down: Authentication, the App Shell, then each major product area as its own section. Inside each section you will find one or more screens. Inside each screen:",
);
bullet("Purpose — what the screen is for, in one paragraph.");
bullet("Visibility — which roles can navigate to it at all.");
bullet("Functions — every action a user can take on the screen, with a per-role behavior list.");
bullet("Notes — gotchas, dependencies, and known follow-ups.");
p(
  "Every per-role line answers two questions: 'is this role even allowed to see this affordance?' and 'if yes, what is the exact behavior they get?'. When a row says a role is hidden, the affordance must not render — and the matching server route must return 403.",
  { soft: true },
);
p(
  "QA pass: walk every screen with each role profile in Settings → Staff Preview. The visible affordances must match the rows in this document.",
  { italic: true, soft: true },
);

// ---------- Roles glossary ----------
h1("User Roles Glossary");
p(
  "Roles are additive: SuperUser implies Admin everywhere; District Admin implies Admin within the district. Several capability flags (cap_manage_displays, etc.) can grant a teacher narrow extra access without elevating them to a full role.",
);
for (const r of ROLE_GLOSSARY) {
  h3(r.role);
  kv("Scope", r.scope);
  p(r.summary);
}

// ---------- Sections ----------
function renderScreen(s: ScreenSpec) {
  h2(`${s.title}`);
  kv("Nav path", s.navPath);
  kv("Audience", s.audience);
  if (s.visibility) kv("Visibility", s.visibility);
  doc.moveDown(0.15);
  doc.font(FONT_BOLD).fontSize(10).fillColor(COLORS.inkSoft).text("Purpose");
  doc.moveDown(0.05);
  p(s.purpose);

  for (const f of s.functions) {
    pageBreakIfNear(80);
    h3(`Function — ${f.name}`);
    p(f.what, { soft: true });
    doc.font(FONT_BOLD).fontSize(9.5).fillColor(COLORS.inkSoft).text("Per-role behavior:");
    doc.moveDown(0.05);
    for (const ra of f.roleBehavior) {
      doc.font(FONT_BOLD).fontSize(9.5).fillColor(COLORS.brand);
      doc.text(`  ${roleStr(ra.role)}`, { continued: true });
      doc.font(FONT_BODY).fillColor(COLORS.ink).text(` — ${ra.can}`);
      doc.moveDown(0.05);
    }
    if (f.notes && f.notes.length) {
      doc.moveDown(0.1);
      doc.font(FONT_OBL).fontSize(9.5).fillColor(COLORS.warn).text("Notes:");
      for (const n of f.notes) bullet(n);
    }
    doc.moveDown(0.2);
  }

  if (s.notes && s.notes.length) {
    doc.font(FONT_OBL).fontSize(9.5).fillColor(COLORS.warn).text("Screen notes:");
    for (const n of s.notes) bullet(n);
  }
  doc.moveDown(0.4);
}

for (const sec of SECTIONS) {
  doc.addPage();
  h1(sec.title);
  if (sec.blurb) p(sec.blurb, { soft: true });
  for (const screen of sec.screens) renderScreen(screen);
}

// ---------- Closing page ----------
doc.addPage();
h1("Maintenance");
p(
  "When you ship a new screen or function, append a row to this document — do not let it drift. The 'How to use' panels inside the app (HowToUseHelp / RoleSection) should mirror the per-role behavior recorded here.",
);
p(
  "Future expansions tracked in replit.md → Future work include: Witness Statement chronological numbering, Admin Hub ISS log edit/delete with audit, AI Consistency Check onboarding step + telemetry tile, school-local timezone for case-number derivation, Core Team 'How this works' refresh after the 4-phase case enhancement suite. Each of these will add new rows to the relevant screen above.",
  { soft: true },
);

drawFootersOnAllPages();
doc.end();

stream.on("finish", () => {
  console.log(`Wrote ${OUT}`);
});
stream.on("error", (e) => {
  console.error(e);
  process.exit(1);
});
