// Generates PulseEDU_Workflow_Guide.pdf — a screen-by-screen, function-by-
// function, per-role workflow reference for developers. Content is written
// inline as data structures so the entire spec lives in one file and can be
// edited without touching layout code.

import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "attached_assets", "PulseEDU_Workflow_Guide_v4.pdf");
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
  | "Non-Exempt"
  | "Front Office"
  | "SRO"
  | "Guardian"
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
    role: "Non-Exempt",
    scope: "Single school",
    summary:
      "FLSA non-exempt staff whose entire app surface is timekeeping. Sidebar collapses to Hall Pass + Tardy Pass + Comp Time ONLY (including Quick Access — Teacher Roster, PBIS, Request Pullout, etc. all hidden). Applying the preset auto-flips exempt_status='non_exempt' so Comp Time accrues. Admin tier escapes the sidebar collapse if accidentally marked Non-Exempt. exempt_status is also an independent admin toggle for staff who are non-exempt but don't take this role bundle (e.g., a non-exempt aide who is also a Behavior Specialist).",
  },
  {
    role: "Front Office",
    scope: "Single school",
    summary:
      "Clerical / receptionist staff. Sees everything a Teacher sees (Hall Pass, Tardy Pass, Family Communication, PBIS Points, School Store, Accommodations, Log/My Interventions, AST, Comp Time) EXCEPT Request Pullout — pullouts are a teacher referral, not a front-desk action. Watchlists and Accommodations come through the teacher baseline. Does NOT grant AST or Comp Time approval rights; Confidential Secretary keeps its existing canApproveAst grant unchanged.",
  },
  {
    role: "SRO",
    scope: "Single school",
    summary:
      "School Resource Officer (sworn officer assigned to the school). Same capability bundle as Teacher — action-capable on Hall Pass, Tardy Pass, PBIS award, Family Communication, etc. Broken out as its own role so future SRO-specific surfaces (incident logs, weapon screenings) can target it cleanly.",
  },
  {
    role: "Guardian",
    scope: "Single school",
    summary:
      "Hall monitor / security aide / campus guardian. Same capability bundle as Teacher today. Broken out as a distinct role for reporting and future role-targeted features.",
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
    title: "15. Parent Pick-Up Module",
    blurb:
      "End-of-day dismissal coordination. An append-only event log (pickup_queue_events) is the source of truth for queue state; every UI surface is a projection of it. The whole module is gated by canManagePickup (admin + Core Team + counselor + front-office + confidential secretary; teachers excluded).",
    screens: [
      {
        id: "pickup-curb",
        title: "Curb Keypad",
        navPath: "/pickup/curb (standalone kiosk page)",
        audience: "Front-office, dismissal monitors, admins",
        purpose:
          "Phone-first numeric keypad. Office staff type the 4-digit pickup number from the car hanger; the page returns the primary student plus every sibling that shares the same authorized parent. Tapping 'Add to line' writes an `added` event for each student and they appear on the classroom signage tile so the teacher releases them.",
        functions: [
          {
            name: "Type pickup number",
            what: "4-digit input (range 1001–9999; schema is TEXT to allow a future 5-digit expansion). Matches student_pickup_authorizations within the active school.",
            roleBehavior: [
              { role: ["Admin", "Front Office", "Core Team", "Counselor"], can: "Look up and enqueue." },
              { role: "Teacher", can: "Page is hidden — canManagePickup excludes teachers." },
            ],
          },
          {
            name: "Sibling roll-up",
            what: "After a match, every student linked to the same parentId on the typed tag is shown. Bulk 'Add' enqueues all siblings in one event burst.",
            roleBehavior: [{ role: "All authorized pickup staff", can: "See and add the whole sibling group at once." }],
            notes: [
              "If an authorization has a null parentId (guardian-only tag with no portal account) sibling roll-up is skipped — only the primary student is returned.",
            ],
          },
          {
            name: "Restricted-tag override",
            what: "If an authorization is flagged restrictedFrom (court order / no-contact), the lookup returns a red banner and refuses the add. Admins can override with a ≥5-char justification; this writes a restricted_override event tagged with the actor + reason.",
            roleBehavior: [
              { role: "Admin", can: "Override with justification." },
              { role: ["Front Office", "Core Team", "Counselor"], can: "See the banner; the Override button is hidden." },
            ],
            notes: [
              "A non-override touch is still recorded as a restricted_attempt event for the audit trail.",
            ],
          },
          {
            name: "'In car' terminal step (new)",
            what:
              "When schoolSettings.pickupInCarStepEnabled = true, each enqueued student gets an explicit 'In car' button on the curb page; tapping it writes an in_car event and clears the row from every queue display. When the toggle is off, released_to_walk is treated as terminal and the row auto-fades after schoolSettings.pickupWalkedOutDisplaySeconds (60–1800; default 300).",
            roleBehavior: [
              { role: ["Admin", "Front Office", "Core Team", "Counselor"], can: "Tap 'In car' to terminate." },
            ],
            notes: [
              "Toggle + display seconds live on the Pickup Settings page (Section 15 → Pickup Settings).",
              "The /api/pickup/queue response always includes inCarStepEnabled + walkedOutDisplaySeconds so every consumer renders the same UX.",
            ],
          },
          {
            name: "Live queue strip",
            what:
              "Bottom of the page shows students currently 'in line' or 'walking out' with elapsed time. Student avatars (StudentPhoto) appear at 72px for face-match.",
            roleBehavior: [{ role: "All authorized pickup staff", can: "View." }],
          },
        ],
        notes: [
          "Auth: standalone /pickup/* pages require a staff session. Without one, the page redirects to the main login.",
          "Every action writes to pickup_queue_events (append-only); the queue endpoint reduces today's events into the visible state. There is no UPDATE/DELETE path.",
        ],
      },
      {
        id: "pickup-walkers",
        title: "Walker Gate",
        navPath: "/pickup/walkers",
        audience: "Walker-gate staff, admins",
        purpose:
          "Releases students flagged dismissalMode = 'walker'. Same keypad and sibling logic as the curb page, but the release button is gated by a bell-window banner — the page refuses the release if the configured 'Walker Release' bell period is not active.",
        functions: [
          {
            name: "Bell-window gate",
            what: "Reads the active bell schedule + period. Banner shows the window; release button is disabled outside it.",
            roleBehavior: [{ role: ["Admin", "Front Office", "Core Team", "Counselor"], can: "Release inside the window." }],
            notes: ["Admins can manually override the window (writes the override into the audit trail)."],
          },
          {
            name: "Release walker",
            what: "Writes walker_released — terminal event; the student does not need an 'in car' tap.",
            roleBehavior: [{ role: ["Admin", "Front Office", "Core Team", "Counselor"], can: "Release any walker on the active sibling group." }],
          },
        ],
      },
      {
        id: "pickup-teacher-tile",
        title: "Classroom Signage Tile",
        navPath: "/pickup/teacher (or Display playlist tile)",
        audience: "Teachers (read), admins",
        purpose:
          "TV signage tile inside the classroom that lights up when a curb operator enqueues a student in the teacher's roster. Filtered by playlist-owner roster, so each classroom only sees its own kids.",
        functions: [
          {
            name: "Send to line",
            what: "Teacher (or signage operator) taps to confirm release; writes released_to_walk and starts the 'walking out' clock.",
            roleBehavior: [{ role: "Teacher", can: "Send any student on their roster." }],
            notes: ["10-second undo window writes release_undone."],
          },
          {
            name: "Teacher view scope",
            what:
              "schoolSettings.pickupTeacherViewScope = 'own_roster' restricts visibility to roster students; 'all_students' shows the school-wide queue (small-school mode).",
            roleBehavior: [{ role: "Admin", can: "Pick the scope in Pickup Settings." }],
          },
        ],
      },
      {
        id: "pickup-tags",
        title: "Pickup Tags Admin",
        navPath: "Sidebar → Settings → Pickup Tags (or /pickup/admin)",
        audience: "Admin + canManagePickup",
        purpose:
          "Issue, reprint, and restrict the 4-digit car-tag numbers; manage extra-guardian splits; print physical PDF tags with QR codes.",
        functions: [
          {
            name: "Bulk start-of-year assign",
            what: "Walks the active roster and assigns the next free number per family (siblings share a number by default). Skips students who already hold an active tag.",
            roleBehavior: [{ role: "Admin", can: "Run." }],
          },
          {
            name: "Lost-tag reissue",
            what: "Voids an existing number and assigns the next free one. The old number is held in a cooldown so it doesn't get re-handed-out immediately.",
            roleBehavior: [{ role: "Admin", can: "Reissue with reason." }],
          },
          {
            name: "Extra-guardian split",
            what: "Issues a second authorization on a different number for a non-cohabiting guardian; both tags carry the same studentId.",
            roleBehavior: [{ role: "Admin", can: "Issue." }],
          },
          {
            name: "Print PDF — single + batch",
            what: "Server renders 2×2 grid (4 tags/page) with student name, family label, QR code, and a prominent red RESTRICTED badge for restricted tags. Renderer lives in artifacts/api-server/src/lib/pickupTagsPdf.ts.",
            roleBehavior: [{ role: "Admin", can: "Print individual tags or a full school batch." }],
          },
          {
            name: "80%-of-range capacity warning",
            what: "NUMBER_RANGE_MAX = 9999. When used numbers cross 80% of the 8,999-slot range, the panel shows an amber warning to schedule the 5-digit expansion (future work in replit.md).",
            roleBehavior: [{ role: "Admin", can: "See warning." }],
          },
          {
            name: "Toggle restrictedFrom",
            what: "Flips an authorization's restricted state. Curb-page lookups refuse non-admin pickup when this is true.",
            roleBehavior: [{ role: "Admin", can: "Toggle." }],
          },
        ],
      },
      {
        id: "pickup-still-on-campus",
        title: "Still-on-Campus Reconciliation Tile",
        navPath: "Admin Hub → Still on Campus",
        audience: "Admin, front-office",
        purpose:
          "Post-cutoff reconciliation. After schoolSettings.pickupCutoffTime (default 15:30), the tile lists every student who has no terminal event today (in_car, walker_released, or auto_cleared), grouped by dismissalMode. Used to drive 'who do we call?' parent contacts.",
        functions: [
          {
            name: "View grouped list",
            what: "Groups by dismissalMode (car_rider, walker, bus, aftercare).",
            roleBehavior: [{ role: ["Admin", "Front Office"], can: "View." }],
          },
          {
            name: "Mark auto-cleared",
            what: "Admin can mark a remaining student as auto_cleared with a note (e.g., 'parent confirmed off-campus pickup'). Writes an auto_cleared event.",
            roleBehavior: [{ role: "Admin", can: "Clear with note." }],
          },
        ],
        notes: [
          "Tile hidden before the cutoff time so it doesn't pollute the morning Admin Hub.",
          "Terminal logic respects pickupInCarStepEnabled — when off, released_to_walk also counts as terminal so the tile doesn't false-positive.",
        ],
      },
      {
        id: "pickup-settings",
        title: "Pickup Settings",
        navPath: "Settings → Pickup",
        audience: "Admin",
        purpose: "Per-school configuration tile for the dismissal module.",
        functions: [
          {
            name: "Cutoff time",
            what: "HH:MM — controls when the Still-on-Campus tile appears.",
            roleBehavior: [{ role: "Admin", can: "Edit." }],
          },
          {
            name: "Teacher view scope",
            what: "'own_roster' vs 'all_students'.",
            roleBehavior: [{ role: "Admin", can: "Edit." }],
          },
          {
            name: "'In car' terminal step toggle (new)",
            what:
              "Boolean. When true, every released student must be tapped 'in car' before the row clears. When false, released_to_walk is terminal and rows auto-fade after the configured display seconds.",
            roleBehavior: [{ role: "Admin", can: "Toggle." }],
          },
          {
            name: "Walked-out display seconds (new)",
            what: "Integer 60–1800, default 300. Only takes effect when the in-car toggle is off. PUT validates the range; out-of-range payloads 422.",
            roleBehavior: [{ role: "Admin", can: "Edit." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "16. Student Photos & ID Badges",
    blurb:
      "students.photo_object_key + students.photo_consent live on the canonical student row. Photos are stored via the school-scoped object-storage ACL (bindObjectToSchool) and rendered through the StudentPhoto component everywhere a student avatar appears. The badge generator embeds them into printable IDs.",
    screens: [
      {
        id: "student-photo-upload",
        title: "Student Photo upload",
        navPath: "Student profile → Photo tile (per-student); bulk via Data Importer 'yearbook zip'",
        audience: "Admin, Core Team (canManageStudentPhoto)",
        purpose:
          "Single-entry ingestion path today: per-student in-browser capture using getUserMedia (cropped to a square) or file picker. Result is uploaded through /api/storage/* and the returned object key is bound to the school's ACL. Bulk yearbook-ZIP ingest is documented as future work in the route header.",
        functions: [
          {
            name: "Upload (per-student)",
            what:
              "POST /api/students/:studentId/photo (replace) and DELETE /api/students/:studentId/photo (clear). Accepts an object key from /api/storage/upload, calls bindObjectToSchool, writes students.photo_object_key. Photo-consent toggle lives at PATCH /api/students/:studentId/photo-consent (admin-only).",
            roleBehavior: [
              { role: "Admin, Core Team", can: "Upload, replace, remove." },
              { role: "Teacher", can: "Hidden." },
            ],
            notes: [
              "Bind step enforces the school-scoped ACL; without it the asset is unreachable to the badge renderer and StudentPhoto.",
            ],
          },
          {
            name: "Camera capture",
            what: "getUserMedia → square crop → blob upload → bind. Falls back to file picker on browsers without camera access.",
            roleBehavior: [{ role: "Admin, Core Team", can: "Capture in browser." }],
          },
          {
            name: "Consent toggle",
            what:
              "students.photo_consent (BOOL DEFAULT true). When false, every StudentPhoto surface renders initials regardless of whether a file exists. The file is not deleted — flipping the toggle back restores the photo.",
            roleBehavior: [{ role: "Admin", can: "Toggle on student profile." }],
          },
        ],
        notes: [
          "Photo-key column is nullable. The fallback is the existing initials bubble (consistent color per name).",
          "Parent portal never sees the photo — the staff-only ACL blocks it even if a parent guessed the URL.",
        ],
      },
      {
        id: "student-photo-surfaces",
        title: "Where the photo renders",
        navPath: "Cross-cutting",
        audience: "All staff",
        purpose:
          "StudentPhoto is the single component; every surface uses it. Replacing the avatar in one place automatically updates everywhere.",
        functions: [
          {
            name: "Surfaces",
            what:
              "Teacher roster avatars, PBIS Hub cards, Spotlight reveal, pickup curb confirmation (72px), walker gate, Watchlist, safety-plan picker, ID badges.",
            roleBehavior: [{ role: "All staff", can: "See where the surface is otherwise visible." }],
          },
        ],
      },
      {
        id: "student-id-badges",
        title: "Student ID Badges (PDF)",
        navPath: "Settings → Student ID Badges",
        audience: "Admin",
        purpose:
          "Renders printable badges (lanyard portrait or CR80 credit-card landscape) with student photo (when consent), name + ID, house ribbon, and a Code128 + QR encoding the student_id for kiosk scans.",
        functions: [
          {
            name: "Render PDF (single or batch)",
            what:
              "GET /api/students/id-badges.pdf and POST /api/students/id-badges.pdf both call the same handler. Accepts a student-id list (or a scope: grade / homeroom / school) and a size (lanyard portrait or CR80 landscape). Bounded concurrency (6) and 4MB per-photo cap keep the renderer from OOMing on 'print all'.",
            roleBehavior: [{ role: "Admin", can: "Print." }],
          },
          {
            name: "Audit ledger",
            what:
              "Every print writes a badge_print_events row: actor, students printed, batch size, reason (lost / damaged / first-issue / reprint). Read via GET /api/students/badge-print-events. Best-effort — a failed audit insert does not block the PDF.",
            roleBehavior: [{ role: "Admin", can: "View audit table." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "17. AST + Comp Time — Staff Time Banks",
    blurb:
      "Two parallel time banks. AST (Alternate Schedule Time) is the HCTA-contract earn-then-use bank for exempt instructional staff. Comp Time (FLSA compensatory time, 1.5x earn rate, 240h cap) is the non-exempt bank — visible only to staff whose exempt_status='non_exempt'. Exempt staff hitting /comp see a 'not eligible — use AST instead' splash. Both banks store quarter-hour INTEGER units (no float drift); both are keyed to staff_id (not (school_id, staff_id)) so balances follow a staff member across schools within the same district. The Non-Exempt role preset collapses the sidebar to Hall Pass + Tardy Pass + Comp Time only, since those are the only three surfaces this role ever uses.",
    screens: [
      {
        id: "ast-staff",
        title: "Staff AST Page",
        navPath: "Sidebar → AST (AstSidebarBadge shows unread admin decisions)",
        audience: "All staff",
        purpose:
          "Personal ledger + request submission. Shows district-wide banked total, YTD earned/used, and full ledger history.",
        functions: [
          {
            name: "Submit Earn request",
            what:
              "Pre-approval workflow: staff submits intent (hours + category + description). Admin pre-approves, work happens, staff hits 'Submit completion' with actual hours, admin confirms — only the confirm step writes the ledger credit (earn_confirm).",
            roleBehavior: [{ role: "All staff", can: "Submit." }],
          },
          {
            name: "Submit Use request",
            what: "Single-step: staff requests time off; admin approval writes the ledger debit (use_approval).",
            roleBehavior: [{ role: "All staff", can: "Submit." }],
          },
          {
            name: "Cancel pending",
            what:
              "Staff can cancel an earn request before completion confirm and a use request before approval. After approval the debit is posted and only admin intervention can reverse it.",
            roleBehavior: [{ role: "All staff", can: "Cancel within window." }],
          },
          {
            name: "Acknowledge bell",
            what: "On mount /api/ast/acknowledge clears the AstSidebarBadge.",
            roleBehavior: [{ role: "All staff", can: "Auto." }],
          },
        ],
        notes: [
          "Categories (Family-Facing / Athletics / Curriculum / etc.) are admin-set and stripped from staff-facing responses to avoid 'why was my work classified as X' disputes.",
        ],
      },
      {
        id: "ast-admin-queue",
        title: "Admin AST Approval Queue",
        navPath: "Admin Hub → AST Approval Queue (AstNotificationBell pulses when non-empty)",
        audience: "Admin / District Admin / SuperUser / staff with canApproveAst (confidential secretary)",
        purpose: "Two-stage approval queue for Earn (pre-approve + confirm) and one-step approval for Use.",
        functions: [
          {
            name: "Earn pre-approval",
            what:
              "Approve / deny before work happens. Must pick a category on approve. Denial requires a note (so the staff member can re-submit).",
            roleBehavior: [{ role: "Approver", can: "Pre-approve + categorize, or deny with note." }],
          },
          {
            name: "Completion confirm",
            what:
              "After staff submits actual hours, admin confirms or amends; confirm writes the earn_confirm ledger credit (the only credit path).",
            roleBehavior: [{ role: "Approver", can: "Confirm; amends require a justification note." }],
          },
          {
            name: "Use approval",
            what: "One-tap approve or deny-with-note. Approve writes the use_approval debit.",
            roleBehavior: [{ role: "Approver", can: "Approve/deny." }],
          },
        ],
      },
      {
        id: "ast-insights",
        title: "AST Insights",
        navPath: "Admin Hub → AST Insights",
        audience: "Approver-tier",
        purpose: "School-wide liability and usage analytics so admins can size the bank.",
        functions: [
          {
            name: "Headline tiles",
            what: "Live banked total, earned YTD, used YTD.",
            roleBehavior: [{ role: "Approver", can: "View." }],
          },
          {
            name: "Top 5 leaderboards",
            what: "Top balances and top earners.",
            roleBehavior: [{ role: "Approver", can: "View." }],
          },
          {
            name: "By category + by role",
            what: "Earned/used breakdown by AST category and by role-group (Admin / Core Team / Teacher / etc.).",
            roleBehavior: [{ role: "Approver", can: "View." }],
          },
          {
            name: "Monthly trend",
            what: "Earned vs used bar chart (12-month rolling).",
            roleBehavior: [{ role: "Approver", can: "View." }],
          },
        ],
      },
      {
        id: "ast-lapse-cron",
        title: "Lapse Cron (July 1)",
        navPath: "artifacts/api-server/src/cron/astLapse.ts",
        audience: "Engineering",
        purpose:
          "Zeros every positive balance on July 1 @ 00:05 local. Writes a 'lapse' ledger row per staff with a negative delta equal to their prior balance. Guarded by a year-specific pg_advisory_xact_lock so duplicate triggers cannot double-lapse.",
        functions: [
          {
            name: "Run",
            what: "Annual; idempotent.",
            roleBehavior: [{ role: "System", can: "Run." }],
          },
        ],
        notes: [
          "Open follow-ups (replit.md): voluntary mid-year transfer hook (transfer_lapse kind reserved; not yet wired), optional weekly Friday digest gated on per-school ast_email_digest_enabled, per-staff ledger drilldown GET /api/ast/staff/:id/ledger.",
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "18. Feature Licensing & Plans",
    blurb:
      "Two-tier flag model: a SuperUser-controlled 'super feature' (from plan + per-school overrides) AND a school-level admin toggle. loadEffectiveFeatures(schoolId) is the single read path and is cached per-request. The 'AND fix' means turning a school's admin toggle ON cannot enable a feature the plan does not license.",
    screens: [
      {
        id: "licensing-plans",
        title: "Plans (global catalog)",
        navPath: "/admin/feature-licensing → Plans",
        audience: "SuperUser (cross-district required for create/edit/delete)",
        purpose:
          "Global catalog of bundles (Bronze/Silver/Gold/Enterprise — labels are tenant-defined). Each plan toggles a set of super_feature_* booleans and carries an optional quotas JSONB.",
        functions: [
          {
            name: "Create / edit / delete plan",
            what: "JSONB blob: { features: {...bools}, quotas: { maxPlaylists: N, maxParentAccounts: N, ... } }",
            roleBehavior: [
              { role: "Cross-district SuperUser (ALLOW_CROSS_DISTRICT_SUPERUSER=1)", can: "Full CRUD." },
              { role: "District SuperUser", can: "Read-only." },
            ],
          },
          {
            name: "Assign plan to school",
            what:
              "Writes the plan id to schools.feature_plan_id and recomputes the school's super_feature_* boolean snapshot inside a locked transaction (lockSchoolForLicensing → SELECT FOR UPDATE on schools).",
            roleBehavior: [{ role: "SuperUser", can: "Assign." }],
          },
        ],
      },
      {
        id: "licensing-overrides",
        title: "Per-School Overrides",
        navPath: "/admin/feature-licensing → Schools → Overrides drawer",
        audience: "SuperUser",
        purpose:
          "Per-school exceptions to the plan, with optional expiration (e.g., 30-day trial of an upsell module). Each upsert/delete writes a feature_licensing_audit_log row.",
        functions: [
          {
            name: "Add / edit / remove override",
            what: "Force a super_feature on or off and optionally set expires_at.",
            roleBehavior: [{ role: "SuperUser", can: "Edit." }],
          },
          {
            name: "Expiration sweep cron",
            what:
              "featureLicensingOverrideSweep.ts revokes expired overrides and writes an override_expired_sweep audit row. Sweep is idempotent via the audit log dedup.",
            roleBehavior: [{ role: "System", can: "Run." }],
          },
          {
            name: "Bulk overrides (Phase 5)",
            what:
              "BulkOverridesPanel applies a single override to every school in a district or platform-wide. Cross-district guard requires ALLOW_CROSS_DISTRICT_SUPERUSER.",
            roleBehavior: [{ role: "Cross-district SuperUser", can: "Bulk apply." }],
          },
        ],
      },
      {
        id: "licensing-quotas",
        title: "Quota Telemetry & Enforcement",
        navPath: "/admin/feature-licensing → Quota Telemetry",
        audience: "SuperUser",
        purpose:
          "KNOWN_SEAT_QUOTAS (currently maxPlaylists, maxParentAccounts) are enforced at the consumer-route level via checkQuota(schoolId, feature, quotaName); a 403 with { error: 'quota_exceeded' } is returned when a school would exceed its plan.",
        functions: [
          {
            name: "Telemetry table",
            what: "Lists schools at ≥ 80% of any quota (adjustable threshold). Sourced from getQuotaUsage.",
            roleBehavior: [{ role: "SuperUser", can: "View." }],
          },
        ],
        notes: [
          "Open follow-up: wire a third quota consumer to keep KNOWN_SEAT_QUOTAS honest (good candidates per replit.md: mtss.maxActivePlans or displays.maxConcurrentSchedules).",
        ],
      },
      {
        id: "licensing-audit",
        title: "Licensing Audit Log",
        navPath: "/admin/feature-licensing → Audit Log",
        audience: "SuperUser",
        purpose:
          "Read-only history of every licensing event: plan_assigned, override_upserted, override_deleted, override_expired_sweep. Used for idempotency of the sweep and to answer 'why does school X have feature Y?' questions.",
        functions: [{ name: "Browse", what: "Most-recent-first list with filters by school + event kind.", roleBehavior: [{ role: "SuperUser", can: "View." }] }],
      },
      {
        id: "licensing-school-side",
        title: "School Feature Configuration (admin-side)",
        navPath: "Settings → School Features",
        audience: "Admin",
        purpose:
          "School-level toggles. The visible toggle for a feature is greyed out when super_feature is OFF (the plan does not license it) and the legend explains 'Contact your district to enable'.",
        functions: [
          {
            name: "Toggle a feature",
            what:
              "Writes school_settings.feature_*. Effective state is the AND of super_feature_* (plan + override) and feature_*. Sidebar items, Quick Access promotions, and dashboard tiles all consult loadEffectiveFeatures.",
            roleBehavior: [
              { role: "Admin", can: "Toggle features the plan licenses." },
              { role: "SuperUser", can: "Toggle anything (admin tier is implicit)." },
            ],
          },
          {
            name: "Bulk feature picker",
            what:
              "One-click enable-all / disable-all (within the plan's licensed set). Useful for end-of-summer reset.",
            roleBehavior: [{ role: "Admin", can: "Apply." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "19. SuperUser & District Admin Tenancy",
    blurb:
      "Cross-school operating surface. District-scoped SuperUsers (default) can see every school in their home district; cross-district SuperUsers (ALLOW_CROSS_DISTRICT_SUPERUSER=1) get the platform tier (global plans, bulk overrides). District Admins can read across the district but do not mutate licensing or tenancy.",
    screens: [
      {
        id: "tenancy-superuser-home",
        title: "SuperUser Home (Rollups)",
        navPath: "/admin/superuser",
        audience: "SuperUser",
        purpose:
          "Aggregate counts (districts, schools, students, staff) + per-district summary. Landing page after multi-school login.",
        functions: [
          {
            name: "Switch into a school",
            what: "Sets req.schoolId for subsequent requests; every read re-binds.",
            roleBehavior: [{ role: "SuperUser", can: "Switch to any school the role can see." }],
          },
          {
            name: "Open Audit & Health panel",
            what:
              "7-day activity timeline across licensing changes, ISS log edits, case events. Surfaces 'is anything on fire?' at-a-glance.",
            roleBehavior: [{ role: "SuperUser", can: "View." }],
          },
        ],
      },
      {
        id: "tenancy-district-overview",
        title: "District Overview",
        navPath: "/admin/district-overview",
        audience: "SuperUser + District Admin",
        purpose:
          "Per-school detail for the selected district with side-by-side 7-day stats (PBIS events, hall passes, ISS days, active cases, parent invites). Used for cross-school comparison without a context switch.",
        functions: [
          {
            name: "Per-school rollup row",
            what: "Click-through opens the school's Admin Hub in a context switch.",
            roleBehavior: [
              { role: "SuperUser", can: "Switch to any row." },
              { role: "District Admin", can: "View only — switch is 403 from the API." },
            ],
          },
        ],
      },
      {
        id: "tenancy-onboard-district",
        title: "Onboard-a-District Wizard",
        navPath: "Tenancy Panel → Onboard a district",
        audience: "Cross-district SuperUser",
        purpose:
          "Atomic creation of a district + primary school + initial admin staff + default settings + plan assignment, all inside a single DB transaction so a partial failure rolls back the entire tenant.",
        functions: [
          {
            name: "Run wizard",
            what:
              "Multi-step modal: district details → primary school → admin email → plan pick → confirm. Generates a CSPRNG temp password via generateAndHashTempPassword and surfaces it once to the SuperUser for hand-off.",
            roleBehavior: [{ role: "Cross-district SuperUser", can: "Run." }],
          },
        ],
      },
      {
        id: "tenancy-onboard-school",
        title: "Onboard-a-School (existing district)",
        navPath: "Tenancy Panel → Onboard a school",
        audience: "SuperUser",
        purpose: "Adds a school under an existing district. Reuses the temp-password flow.",
        functions: [
          {
            name: "Add school",
            what: "Creates schools row, default school_settings row, initial admin staff, plan assignment.",
            roleBehavior: [{ role: "SuperUser", can: "Add." }],
          },
        ],
      },
      {
        id: "tenancy-edit-soft-delete",
        title: "Edit + Soft-Delete Districts / Schools",
        navPath: "Tenancy Panel rows",
        audience: "SuperUser",
        purpose: "Rename, change district binding, or deactivate. Soft-delete = active = false; data stays for audit.",
        functions: [
          {
            name: "Edit name / metadata",
            what: "Inline.",
            roleBehavior: [{ role: "SuperUser", can: "Edit." }],
          },
          {
            name: "Soft-delete",
            what:
              "Sets active = false. Every read path joins on (school.active AND district.active) so a retired tenant cannot serve orphaned sessions.",
            roleBehavior: [{ role: "SuperUser", can: "Soft-delete." }],
          },
        ],
        notes: [
          "Cross-silo guard: assertSchoolInCallerDistrict prevents a district-scoped SuperUser from acting on schools they shouldn't see, even by guessing IDs.",
        ],
      },
      {
        id: "tenancy-data-integrity",
        title: "Data-Integrity Check (Tenancy Panel)",
        navPath: "Settings → Tenancy",
        audience: "SuperUser",
        purpose:
          "Reports orphans (rows where school_id IS NULL) and a per-school row-count grid across 15 major tables (students, staff, hall_passes, pbis_entries, …). Sanity check after a botched import.",
        functions: [
          { name: "Run check", what: "Read-only snapshot.", roleBehavior: [{ role: "SuperUser", can: "Run." }] },
          { name: "Add school (inline)", what: "Quick form alternative to the wizard.", roleBehavior: [{ role: "SuperUser", can: "Add." }] },
        ],
      },
      {
        id: "tenancy-reset-temp-pw",
        title: "Reset to Temp Password",
        navPath: "Staff & Roles → row → 'Reset to temp password'",
        audience: "Admin (own school), SuperUser (any school)",
        purpose:
          "Generates a fresh CSPRNG temp password for a staff member, hashes it, writes the hash + must_change_at_next_login flag, and returns the plaintext ONCE to the actor for hand-off.",
        functions: [
          {
            name: "Reset",
            what:
              "Confirmation modal explains the temp password will be shown only once. After dismiss it cannot be retrieved.",
            roleBehavior: [
              { role: "Admin", can: "Reset any staff in their school." },
              { role: "SuperUser", can: "Reset anywhere." },
            ],
          },
        ],
        notes: [
          "Helper: artifacts/api-server/src/lib/tempPassword.ts → generateAndHashTempPassword. Same helper is used by both onboarding wizards.",
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "20. Additional Admin Catalogs & Tiles",
    blurb:
      "Single-purpose Settings tiles. Most are CRUD on a per-school catalog; many are referenced by daily-ops screens.",
    screens: [
      {
        id: "settings-school-branding",
        title: "School Branding",
        navPath: "Settings → School Branding",
        audience: "Admin",
        purpose:
          "Per-school header gradient, logo, and color overrides applied to printouts, the HeartBEAT parent snapshot, and the Kiosk masthead.",
        functions: [
          { name: "Edit colors", what: "Hex inputs validated against /^#[0-9a-fA-F]{6}$/.", roleBehavior: [{ role: "Admin", can: "Edit." }] },
          {
            name: "Upload logo",
            what:
              "POST /api/school-branding/logo/bind — binds the uploaded object key to the school ACL.",
            roleBehavior: [{ role: "Admin", can: "Upload." }],
          },
        ],
        notes: ["gradient_colors persists as a JSON string for portability across drizzle-kit versions."],
      },
      {
        id: "settings-logo-generator",
        title: "Logo Generator",
        navPath: "Settings → Logo Generator",
        audience: "Admin / SuperUser",
        purpose:
          "Pure client-side tool that produces Pulse-branded SVG / PNG assets for sister apps (PulseTV, Kinetics, Athletics). No server round-trip.",
        functions: [
          { name: "Pick preset", what: "Bundled color packs.", roleBehavior: [{ role: "Admin", can: "Generate." }] },
          { name: "Export SVG / PNG", what: "Canvas rasterization at 4× for retina.", roleBehavior: [{ role: "Admin", can: "Download." }] },
        ],
        notes: ["SVG animation does not survive PNG export — a static fallback path is used in the raster."],
      },
      {
        id: "settings-heartbeat-sections",
        title: "Heartbeat Sections Admin",
        navPath: "Settings → Heartbeat Sections",
        audience: "Admin",
        purpose:
          "Picks which 'Today's Heartbeat' signage tiles render and in what order (PBIS events, hall passes today, kiosk pulse, weather, etc.).",
        functions: [
          { name: "Toggle / reorder", what: "Drag-and-drop with per-section visibility.", roleBehavior: [{ role: "Admin", can: "Edit." }] },
        ],
      },
      {
        id: "settings-closed-days",
        title: "School Closed Days",
        navPath: "Settings → School Closed Days",
        audience: "Admin / Core Team",
        purpose:
          "Non-instructional day calendar. ISS day-rollover and Add-Discipline-Log calendars skip these dates so 'no school' days don't show up as missed attendance.",
        functions: [
          { name: "Add / remove", what: "Date + label.", roleBehavior: [{ role: ["Admin", "Core Team"], can: "Edit." }] },
        ],
        notes: ["Read is open to any signed-in staff."],
      },
      {
        id: "settings-pullout-templates",
        title: "Pullout Note Templates",
        navPath: "Settings → Pullout Note Templates",
        audience: "Core Team",
        purpose:
          "Canned parent-message templates with placeholders the Verify modal substitutes client-side: {firstName} {lastName} {teacherName} {reason} {period} {schoolName}.",
        functions: [
          { name: "CRUD", what: "Mirrors pulloutReasons.ts pattern.", roleBehavior: [{ role: ["Admin", "Behavior Specialist", "MTSS Coordinator", "Dean"], can: "Edit." }] },
        ],
      },
      {
        id: "settings-trusted-adults",
        title: "Trusted Adult Links",
        navPath: "Settings → Trusted Adults",
        audience: "Core Team",
        purpose:
          "Manual link between staff and student that grants the staff Watchlist + Insights visibility regardless of the section roster. Used for advisor / mentor relationships.",
        functions: [
          { name: "Add / remove", what: "Inline.", roleBehavior: [{ role: ["Admin", "Core Team", "PBIS Coordinator"], can: "Edit." }] },
        ],
      },
      {
        id: "settings-trusted-adult-interventions",
        title: "Trusted-Adult Interventions",
        navPath: "Settings → Trusted-Adult Interventions",
        audience: "Core Team",
        purpose: "Catalog of intervention types that trusted-adult mentors can log (separate from teacher tier 2/3).",
        functions: [{ name: "CRUD", what: "—", roleBehavior: [{ role: ["Admin", "Core Team"], can: "Edit." }] }],
      },
      {
        id: "settings-separation-tags",
        title: "Separation Tags Admin",
        navPath: "Settings → Separation Tags",
        audience: "Admin",
        purpose: "Tag catalog used by SuggestSeparationModal and the Separation Suggestions aggregate.",
        functions: [{ name: "CRUD", what: "—", roleBehavior: [{ role: "Admin", can: "Edit." }] }],
      },
      {
        id: "settings-polarity-pairs",
        title: "Polarity Pairs",
        navPath: "Sidebar → Interventions → Polarity Pairs",
        audience: "Core Team",
        purpose:
          "Two students who must NOT both be out on a hall pass at the same time. findPolarityConflict is called by hallPasses + kiosk pass creation — the rule is enforced at issuance, not just by convention.",
        functions: [
          { name: "CRUD pair", what: "Pick both students + reason.", roleBehavior: [{ role: ["Admin", "Behavior Specialist", "Dean", "MTSS Coordinator"], can: "Edit." }] },
        ],
        notes: ["The conflict short-circuits new-pass creation with a 409 + the other student's name."],
      },
      {
        id: "settings-discipline-reasons",
        title: "Discipline Reasons Catalog",
        navPath: "Settings → Discipline Reasons",
        audience: "Admin",
        purpose: "Dropdown source for ISS / OSS logging.",
        functions: [
          { name: "CRUD + active toggle", what: "Inactivating preserves historical labels.", roleBehavior: [{ role: "Admin", can: "Edit." }] },
        ],
      },
      {
        id: "settings-custom-roles",
        title: "Custom Roles",
        navPath: "Settings → Custom Roles",
        audience: "SuperUser",
        purpose: "District-defined named role profiles built from capability flags (cap_*). Lets a district mint, e.g., 'Attendance Clerk' without code changes.",
        functions: [
          { name: "Create role profile", what: "Name + capability set.", roleBehavior: [{ role: "SuperUser", can: "Create." }] },
          { name: "Assign to staff", what: "From Staff & Roles.", roleBehavior: [{ role: "Admin", can: "Assign existing profiles." }] },
        ],
      },
      {
        id: "settings-fast-coverage",
        title: "FAST Coverage",
        navPath: "Settings → FAST Coverage",
        audience: "Admin",
        purpose:
          "Pre-flight check before staff use the Roster: per-grade / per-subject count of students with PM1/PM2/PM3 scores vs total roster.",
        functions: [
          { name: "View coverage", what: "Status badges flag 'Missing PM3' / 'Partial PM3' in red/amber.", roleBehavior: [{ role: "Admin", can: "View." }] },
        ],
        notes: ["A 'No chart' flag means the subject is imported but FL DOE cut-scores aren't wired yet — common for Geometry until the next import cycle."],
      },
      {
        id: "settings-kiosk",
        title: "Kiosk Setup & Activation",
        navPath: "Settings → Kiosk Setup",
        audience: "Admin / Core Team",
        purpose:
          "QR/PIN activation cards for classroom tablets. Each card is a kiosk_enroll_token; exchange writes a kiosk_activation + a kiosk_viewer_token (long-lived but rotatable).",
        functions: [
          {
            name: "Bulk generate teacher cards",
            what: "One-click PDF for every active teacher.",
            roleBehavior: [{ role: "Admin", can: "Generate." }],
          },
          {
            name: "Activate proxy (sub coverage)",
            what: "Core Team can pre-activate a kiosk for a substitute for today or 14 days.",
            roleBehavior: [{ role: "Core Team", can: "Activate." }],
          },
          {
            name: "Token rotation on print",
            what:
              "Printing a card invalidates the previous token immediately — security feature; hand out new cards right after printing.",
            roleBehavior: [{ role: "Admin", can: "Print." }],
          },
        ],
      },
      {
        id: "settings-camera-registry",
        title: "Camera Registry + Scanner",
        navPath: "Settings → Camera Registry",
        audience: "Admin / Dean",
        purpose:
          "Catalog of school security cameras (id, label, location, retention days, viewer URL). Used by the Investigations Case Detail to issue footage requests.",
        functions: [
          { name: "CRUD camera", what: "—", roleBehavior: [{ role: ["Admin", "Dean"], can: "Edit." }] },
          { name: "Scan QR (CameraScanner)", what: "Mobile QR-scan helper to onboard a camera by sticker.", roleBehavior: [{ role: ["Admin", "Dean"], can: "Use." }] },
        ],
      },
      {
        id: "settings-email-digest",
        title: "Email Digest & Preview",
        navPath: "Settings → Notifications → Email Digest",
        audience: "Admin",
        purpose:
          "Preview today's digest email (rendered HTML) and force-fire the dispatcher for the school. Backed by /api/email-preview and /api/digest.",
        functions: [
          { name: "Preview", what: "Renders the current digest with live data.", roleBehavior: [{ role: "Admin", can: "Preview." }] },
          { name: "Send now", what: "Manual trigger — not rate-limited; use sparingly.", roleBehavior: [{ role: "Admin", can: "Send." }] },
        ],
        notes: ["Cron is gated on EMAIL_REMINDERS_ENABLED + RESEND_FROM_ADDRESS (see replit.md Gotchas)."],
      },
      {
        id: "school-store-admin",
        title: "School Store Editor",
        navPath: "Sidebar → School Store",
        audience: "Admin / PBIS Coordinator (edit); all staff (read)",
        purpose:
          "School-wide reward catalog (separate from the per-teacher Classroom Store). Items support image, cost (PBIS points), inventory, and active toggle. Teachers see the same catalog read-only.",
        functions: [
          {
            name: "CRUD item",
            what:
              "Image uploads use /api/storage/* with school-scoped ACL bind (bindObjectToSchool). pendingUploads ledger orphans cleanup.",
            roleBehavior: [
              { role: ["Admin", "PBIS Coordinator"], can: "CRUD." },
              { role: "Teacher", can: "Read-only." },
            ],
          },
          {
            name: "Toggle active",
            what: "Inactive items disappear from the redemption picker but historical redemptions keep their label.",
            roleBehavior: [{ role: ["Admin", "PBIS Coordinator"], can: "Toggle." }],
          },
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "21. Insights — Additional Dashboards & Drilldowns",
    blurb:
      "Surfaces that complete the Insights suite already documented in Section 7. All Insights endpoints are core-team gated and accept grades + window filters; CSV export is described in Section 22.",
    screens: [
      {
        id: "insights-sebsel",
        title: "SEB/SEL Dashboard",
        navPath: "Sidebar → Insights → SEB/SEL",
        audience: "Core Team",
        purpose:
          "Whole-school social-emotional / behavioral lens. Pulls active student_mtss_plans (bucketed into 5 plan-area categories), ESE / 504 / ELL flags, last-30-day negative PBIS, FAST priorYearBq, and active accommodations.",
        functions: [
          { name: "Filter grades", what: "Defensive parser; bad input becomes 'no filter'.", roleBehavior: [{ role: "Core Team", can: "Filter." }] },
          { name: "Export CSV", what: "See Section 22.", roleBehavior: [{ role: "Core Team", can: "Export." }] },
        ],
        notes: ["Time window is fixed at 30 days for the negative-PBIS signal; every other signal is stateful."],
      },
      {
        id: "insights-attendance",
        title: "Attendance Dashboard",
        navPath: "Sidebar → Insights → Attendance",
        audience: "Core Team",
        purpose: "Absences + tardies per student over the chosen window with rate calculation and top-N lists.",
        functions: [
          { name: "Window picker", what: "windowKey (week / month / quarter / custom).", roleBehavior: [{ role: "Core Team", can: "Pick." }] },
          { name: "Export CSV", what: "See Section 22.", roleBehavior: [{ role: "Core Team", can: "Export." }] },
        ],
      },
      {
        id: "insights-academics-trajectory",
        title: "Academics Trajectory (longitudinal drill-in)",
        navPath: "Insights → Academics → Trajectory",
        audience: "Core Team",
        purpose:
          "PM1 → PM2 → PM3 trajectory per student per subject. Classifies students into archetypes (steady-high, declining, recovering, stuck-low) and sub-archetypes. Powers the BandStudentsDrawer drill-in.",
        functions: [
          { name: "Pick subjects", what: "Multi-select with band coloring.", roleBehavior: [{ role: "Core Team", can: "Pick." }] },
          { name: "Open band drawer (BandStudentsDrawer)", what: "Click a chart band to see the constituent students.", roleBehavior: [{ role: "Core Team", can: "Drill in." }] },
          { name: "Export full CSV", what: "Server-streamed; see Section 22.", roleBehavior: [{ role: "Core Team", can: "Export." }] },
          { name: "Export drawer CSV", what: "Client-rendered limited to drilldown.", roleBehavior: [{ role: "Core Team", can: "Export." }] },
        ],
      },
      {
        id: "insights-watchlist",
        title: "Insights Watchlist",
        navPath: "Insights → Watchlist",
        audience: "Core Team",
        purpose:
          "Personal pinned-students view: each Core Team member can pin students they want to track; the dashboard aggregates each pinned student's PBIS, passes, ISS, MTSS, accommodations into one row.",
        functions: [
          { name: "Pin / unpin", what: "Toggles in MyWatchList.", roleBehavior: [{ role: "Core Team", can: "Pin." }] },
        ],
      },
      {
        id: "insights-separation-suggestions",
        title: "Separation Suggestions",
        navPath: "Insights → Behavior → Separation Suggestions",
        audience: "Scheduling team (admins, counselors, Core Team — read); Teachers (write only)",
        purpose:
          "Aggregates SuggestSeparationModal flags filed by teachers. Pairs with high teacher-consensus counts surface to the master-schedule builder for next year.",
        functions: [
          { name: "Filter grade / consensus threshold", what: "Min #teachers + grade.", roleBehavior: [{ role: ["Admin", "Counselor", "Core Team"], can: "View." }] },
          { name: "Drill into student", what: "Full timeline of separation flags + notes.", roleBehavior: [{ role: ["Admin", "Counselor", "Core Team"], can: "Drill." }] },
        ],
        notes: ["Intended for next-year scheduling, not active behavioral intervention."],
      },
      {
        id: "pbis-goals-milestones",
        title: "PBIS Goals + Milestones + Needs-Attention",
        navPath: "Sidebar → PBIS Hub",
        audience: "PBIS Coordinator / Admin",
        purpose:
          "pbis_goals = per-student period goals (week/month/quarter/all). pbis_milestones = thresholds that trigger automated parent emails when crossed. PbisNeedsAttention surfaces 'quiet teachers' (no points awarded in X days), 'invisible students' (zero points in X days), and reason imbalance (>80% one reason).",
        functions: [
          { name: "Create / archive goal", what: "Creator or PBIS Coord/Admin can archive.", roleBehavior: [{ role: ["Teacher", "PBIS Coordinator", "Admin"], can: "Create on their own students; PBIS Coord/Admin archive anyone's." }] },
          { name: "CRUD milestone", what: "Email template + threshold.", roleBehavior: [{ role: ["Admin", "PBIS Coordinator"], can: "Edit." }] },
          { name: "Tune thresholds", what: "Quiet-teacher days, invisible-student days, reason-imbalance ratio — Settings → PBIS Thresholds.", roleBehavior: [{ role: ["Admin", "PBIS Coordinator"], can: "Edit." }] },
        ],
      },
      {
        id: "pbis-houses",
        title: "Houses Panel + Change-House Modal + Sort Jobs",
        navPath: "Sidebar → PBIS Hub → Houses",
        audience: "PBIS Coordinator / Admin",
        purpose:
          "Manages the 4-house system. ChangeHouseModal records the move into student_house_changes (audit). Sort jobs (student_house_sort_jobs) batch-balance new students into houses.",
        functions: [
          { name: "View standings", what: "Live points + ranking (consumed by Spotlight governor v2 — see Section 3 / Spotlight).", roleBehavior: [{ role: "Any staff", can: "View." }] },
          { name: "Change house", what: "Writes audit row with actor + reason.", roleBehavior: [{ role: ["Admin", "PBIS Coordinator"], can: "Change." }] },
          { name: "Run sort job", what: "Bulk-assign new students.", roleBehavior: [{ role: ["Admin", "PBIS Coordinator"], can: "Run." }] },
        ],
      },
      {
        id: "mtss-reports",
        title: "MTSS Reports",
        navPath: "Sidebar → Interventions → Reports",
        audience: "MTSS Coordinator / Admin",
        purpose: "Quantitative health of the MTSS program: completion stats, weekly trend lines, Mon-Fri heatmap.",
        functions: [
          { name: "Per-teacher completion", what: "Logged vs expected entries, by subject.", roleBehavior: [{ role: ["MTSS Coordinator", "Admin"], can: "View." }] },
          { name: "Trend line", what: "Weekly T2 completion %, T3 average score.", roleBehavior: [{ role: ["MTSS Coordinator", "Admin"], can: "View." }] },
          { name: "Heatmap", what: "Day-of-week completion.", roleBehavior: [{ role: ["MTSS Coordinator", "Admin"], can: "View." }] },
        ],
        notes: ["Tier 3 completion is binary per week; Tier 2 is ratio-based."],
      },
    ],
  },
  // =====================================================================
  {
    title: "22. CSV Exports — Cross-cutting Reference",
    blurb:
      "Every CSV download in PulseEDU. Two implementation styles: server-streamed (Content-Disposition: attachment, UTF-8 BOM for Excel) and client-rendered (downloadCsv helper in InsightsPicker.tsx). Server route + filename pattern + columns are listed per surface so QA can verify any export end-to-end.",
    screens: [
      {
        id: "csv-trajectory-full",
        title: "Academics Trajectory — full export",
        navPath: "Insights → Academics → Trajectory → 'CSV' button",
        audience: "Core Team",
        purpose:
          "Server-streamed full-cohort export. GET /api/insights/academics/trajectory/export.csv. Filename trajectory_<subjects>_<grade>_<YYYY-MM-DD>.csv. Columns: student_id, student_name, grade, subject, pm1, pm2, pm3, pm1_band, pm3_band, archetype, sub_archetype.",
        functions: [
          { name: "Apply filters then export", what: "Honors subjects, grades, ell, ese, is504.", roleBehavior: [{ role: "Core Team", can: "Export." }] },
        ],
      },
      {
        id: "csv-trajectory-drawer",
        title: "Trajectory Band Drawer export",
        navPath: "Trajectory → click chart band → '⬇ CSV'",
        audience: "Core Team",
        purpose: "Client-rendered (downloadCsv) limited to the drilled archetype + subKey. Capped at CAP=200 students.",
        functions: [{ name: "Export", what: "trajectory_<subjects>_<arch>_<date>.csv", roleBehavior: [{ role: "Core Team", can: "Export." }] }],
      },
      {
        id: "csv-data-export-panel",
        title: "Data Export Panel",
        navPath: "Settings → Data Management → Export",
        audience: "Importer roles (Admin)",
        purpose:
          "Generic exporter mirror of the importer. GET /api/data-imports/export?kind=<kind>&… Filename pulseedu-<kind>-<date>.csv (BOM prefixed). Kinds: rosters, behavior, fast_scores, fast_prior_year, assessments. Required columns are always re-injected even if the user deselects them.",
        functions: [
          {
            name: "Pick kind + filters + columns",
            what:
              "Filters per kind: grade, date, subject, noteType, assessmentName. Scope: school (default) or district (assessments only).",
            roleBehavior: [{ role: "Admin", can: "Export." }],
          },
        ],
        notes: ["Server uses Papa.unparse with quoting; prepends \\uFEFF so Excel reads UTF-8 names correctly."],
      },
      {
        id: "csv-skipped-houses",
        title: "Skipped roster rows (per import job)",
        navPath: "Data Imports → Job → 'Download skipped rows'",
        audience: "Admin",
        purpose:
          "GET /api/data-imports/jobs/:id/skipped-houses.csv — re-emits the rejected rows with their original columns. Filename skipped-houses_<orig_filename>_job<id>.csv.",
        functions: [{ name: "Download", what: "Job-scoped; no extra filters.", roleBehavior: [{ role: "Admin", can: "Download." }] }],
      },
      {
        id: "csv-dashboards",
        title: "Insights dashboards — CSV button",
        navPath: "Each dashboard's filter bar",
        audience: "Core Team",
        purpose:
          "Client-rendered (downloadCsv) using topListsToCsv concatenated-list format (one file, multiple sub-tables separated by blank line, with a 'list' discriminator column). Filenames <dashboard>_<grades>_<YYYY-MM-DD>.csv.",
        functions: [
          {
            name: "Per-dashboard export",
            what:
              "Attendance, Behavior, Engagement, Equity, SEB/SEL, Academics, Early Warning each have their own button. Honors the current grades + window filters.",
            roleBehavior: [{ role: "Core Team", can: "Export." }],
          },
        ],
        notes: [
          "Client triggers use authFetch (Bearer) rather than a bare <a href> so the iframe sandbox does not strip the auth cookie.",
          "RFC 4180 escape: any cell containing comma, quote, or newline is wrapped in quotes; literal quotes doubled.",
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "23. Witness Statements & AI Consistency Check",
    blurb:
      "Two recently shipped layers on top of the Investigations suite (Section 6). Data layer is live; UI surfacing has open follow-ups noted in replit.md.",
    screens: [
      {
        id: "witness-statement-numbering",
        title: "Witness Statement Numbering",
        navPath: "Investigations → Case Detail → Statements list",
        audience: "Investigators (Admin / Dean / BS)",
        purpose:
          "Deterministic per-case statement IDs in the form CASE-YY-NNNN-WS-XX. Assignment is transaction-locked so concurrent statement creation cannot collide on a number.",
        functions: [
          {
            name: "Assign number on attach",
            what:
              "When a statement is attached to a Case (a row moves from interaction_witness_statements with case_id IS NULL to NOT NULL) the helper assigns the next XX inside a SELECT…FOR UPDATE on the case row. Order is created_at ASC.",
            roleBehavior: [{ role: "System", can: "Assign." }],
          },
        ],
        notes: [
          "Backfill task at deploy: walk existing attached statements per case ordered by created_at ASC. Open follow-ups: surface the formatted ID in PlayerDrawer header, Case Detail statements list, witness statement PDF/print, audit-log payload (copy-on-click).",
        ],
      },
      {
        id: "ai-consistency-check",
        title: "AI Consistency Check",
        navPath: "Investigations → Case Detail → Consistency panel (investigator-gated)",
        audience: "Case investigators (Admin / SuperUser / District Admin / Dean / Behavior Specialist / MTSS Coordinator) via adminGate → isCaseInvestigator",
        purpose:
          "Background AI evaluation that compares statements + video evidence + interaction descriptions on a case and flags contradictions. Runs are scheduled when a statement is completed or video evidence is added; findings + dismissals + audit are stored in case_consistency_runs, case_consistency_findings, case_consistency_state.",
        functions: [
          { name: "Run manually", what: "'Run check' button. Gated by adminGate (admin tier + Dean + BS + MTSS).", roleBehavior: [{ role: ["Admin", "Dean", "Behavior Specialist", "MTSS Coordinator"], can: "Trigger." }] },
          { name: "Dismiss finding with reason", what: "Required justification ≥5 chars; writes to case_consistency_state.", roleBehavior: [{ role: ["Admin", "Dean", "Behavior Specialist", "MTSS Coordinator"], can: "Dismiss." }] },
        ],
        notes: [
          "Open follow-ups (replit.md): (1) onboarding step 'Review Consistency Check guardrails' in Behavior & PBIS phase with an 'I understand' marker, Core Team audience; (2) Settings tile 'Consistency Check — this month' backed by GET /api/watchlist/consistency-telemetry (admin-gated; cheap COUNT/SUM grouped by current month).",
        ],
      },
      {
        id: "iss-admin-log-audit",
        title: "ISS Admin Log Detail Drawer (edit / delete + audit)",
        navPath: "Admin Hub → ISS log → row → Detail Drawer",
        audience: "Admin",
        purpose:
          "Edit / trim / delete a posted ISS admin log row with a required reason; the prior payload is written to iss_admin_log_audit so the change history is reconstructable.",
        functions: [
          { name: "Edit row", what: "Required reason ≥5 chars.", roleBehavior: [{ role: "Admin", can: "Edit." }] },
          { name: "Delete row", what: "Soft-delete; visible in audit.", roleBehavior: [{ role: "Admin", can: "Delete." }] },
          { name: "View audit history", what: "Chronological before/after JSON.", roleBehavior: [{ role: "Admin", can: "View." }] },
        ],
        notes: [
          "Synthesized rows from admin-hub-logged days (iss_attendance_day) have negative IDs and are NOT editable from the ISS dashboard; they must be edited from Admin Hub.",
        ],
      },
    ],
  },
  // =====================================================================
  {
    title: "24. Cross-cutting Concerns",
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

function isAtTopOfPage(): boolean {
  return doc.y <= doc.page.margins.top + 2;
}

function startNewPageIfNotAtTop() {
  if (!isAtTopOfPage()) doc.addPage();
}

function drawFootersOnAllPages() {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Zero the bottom margin so writing into the footer band does not
    // trigger pdfkit's auto-pagination (which would spawn blank pages).
    const origBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
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
    doc.page.margins.bottom = origBottom;
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
  // h1 always starts a new section; callers ensure top-of-page placement.
  doc.font(FONT_BOLD).fontSize(20).fillColor(COLORS.brand).text(s);
  doc.moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .lineWidth(1).strokeColor(COLORS.rule).stroke();
  doc.moveDown(0.6);
  doc.fillColor(COLORS.ink);
}

function h2(s: string) {
  // Reserve only the heading's own line height so a screen heading does
  // not orphan at the very bottom of a page; let the rest flow naturally.
  pageBreakIfNear(24);
  doc.moveDown(0.6);
  doc.font(FONT_BOLD).fontSize(14).fillColor(COLORS.accent).text(s);
  doc.moveDown(0.2);
  doc.fillColor(COLORS.ink);
}

function h3(s: string) {
  pageBreakIfNear(20);
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
    // Just enough room for the function heading + its first line so the
    // heading does not orphan; everything else auto-paginates.
    pageBreakIfNear(40);
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
  startNewPageIfNotAtTop();
  h1(sec.title);
  if (sec.blurb) p(sec.blurb, { soft: true });
  for (const screen of sec.screens) renderScreen(screen);
}

// ---------- Closing page ----------
startNewPageIfNotAtTop();
h1("Maintenance");
p(
  "When you ship a new screen or function, append a row to this document — do not let it drift. The 'How to use' panels inside the app (HowToUseHelp / RoleSection) should mirror the per-role behavior recorded here.",
);
p(
  "Open follow-ups tracked in replit.md → Future work: AI Consistency Check onboarding step + 'Consistency Check — this month' Settings tile; per-school IANA timezone column (replace DEFAULT_SCHOOL_TZ with a per-school column threaded through schoolYearLabelFor, seed case backfill, AST insights, lapse cron); refresh Core Team 'How this works' copy after the Phase 4 case enhancements (tagging, video evidence panel, AI consistency check, Case Insights dashboard) ship as a single pass; Pickup module 5-digit expansion (bump NUMBER_RANGE_MAX once a tenant exceeds ~7200 active tags + narrow the PDF font + accept 4-or-5-digit input on the curb keypad); curb-line audible chime (design open — leaning visual-only since high-volume schools would overlap); Student Photos rollout (the StudentPhoto component, photo_object_key + photo_consent columns, and per-student upload route are shipped, but bulk yearbook-ZIP ingestion and several delivery surfaces remain open per replit.md); Witness statement formatted-ID surfacing in PlayerDrawer header + Case Detail list + PDF + audit log payload, plus one-time backfill at deploy; AST voluntary-transfer zero-out hook (transfer_lapse kind reserved) + optional Friday digest gated on ast_email_digest_enabled + per-staff ledger drilldown GET /api/ast/staff/:id/ledger; Feature Licensing Phase 4 (wire a third quota consumer to keep KNOWN_SEAT_QUOTAS honest — mtss.maxActivePlans or displays.maxConcurrentSchedules — and per-feature usage sparklines in the SuperUser admin page).",
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
