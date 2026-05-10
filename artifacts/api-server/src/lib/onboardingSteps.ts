// =============================================================================
// Onboarding step registry — single source of truth for the per-school
// onboarding checklist. Each step has:
//
//   key         stable identifier persisted in onboarding_checklist_state
//   phase       grouping label rendered as a section header
//   label       short human title shown in the row
//   hint        the "How this works" copy expanded by the info toggle
//   route       where the "Open" link sends the admin
//   autoCheck   server-side probe that returns 'complete' | 'partial' |
//               'empty' — wrapped in try/catch in the route so any
//               schema drift gracefully falls back to "manual only".
//
// To add a step: append to STEPS, give it a unique key. The PDF and UI
// pick it up automatically.
// =============================================================================

import type { db as DB } from "@workspace/db";
import { sql } from "drizzle-orm";

export type AutoStatus = "complete" | "partial" | "empty";

export type OnboardingPhase =
  | "Identity & Access"
  | "Schedule & Operations"
  | "Behavior & PBIS"
  | "Interventions & MTSS"
  | "Family & Outreach";

export interface OnboardingStepRoute {
  // 'settings' = land on the SettingsHub then drill into a tile.
  // 'section'  = jump straight to a top-level activeSection.
  kind: "settings" | "section";
  // SettingsTileId when kind='settings'. activeSection key when kind='section'.
  target: string;
}

export interface OnboardingStepDef {
  key: string;
  phase: OnboardingPhase;
  label: string;
  hint: string;
  route: OnboardingStepRoute;
  autoCheck: (
    db: typeof DB,
    schoolId: number,
  ) => Promise<AutoStatus>;
}

// Tiny helper: count(*) > 0 → complete, else empty. `partial` is reserved
// for steps where we can distinguish "exists but not finished" (e.g. bell
// schedule rows exist but none is marked default).
async function countGt0(
  db: typeof DB,
  q: ReturnType<typeof sql>,
): Promise<AutoStatus> {
  const r = await db.execute(q);
  const row = (r.rows[0] ?? {}) as { c?: number | string };
  const c = Number(row.c ?? 0);
  return c > 0 ? "complete" : "empty";
}

export const ONBOARDING_STEPS: OnboardingStepDef[] = [
  // ---------- Phase 1: Identity & Access ----------
  {
    key: "branding",
    phase: "Identity & Access",
    label: "School Branding",
    hint: "Upload your school's logo, choose header gradient colors, and set the display name that prints on parent reports and shows on hallway signage. Without branding configured, every screen falls back to neutral PulseEDU colors.",
    route: { kind: "settings", target: "branding" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM school_branding WHERE school_id = ${schoolId} AND (logo_object_path IS NOT NULL OR gradient_colors_json <> '[]')`,
      ),
  },
  {
    key: "allowlist",
    phase: "Identity & Access",
    label: "Teacher Sign-in Allowlist",
    hint: "Choose which staff email addresses are allowed to sign in to your school. New employees only get access after they're added here. Use the search box to find names, then toggle each row on. Bulk paste is supported.",
    route: { kind: "settings", target: "allowlist" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM staff WHERE school_id = ${schoolId} AND active = true`,
      ),
  },
  {
    key: "staff-directory",
    phase: "Identity & Access",
    label: "Staff Directory",
    hint: "Confirm every staff member's display name, default classroom, and contact phone. The default room is what auto-fills on hall passes and pullout requests. Use the inline edit table — click any cell to edit, dropdowns let you pick the location.",
    route: { kind: "settings", target: "staff-directory" },
    autoCheck: async (db, schoolId) => {
      const r = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM staff_defaults WHERE school_id = ${schoolId} AND default_location_name IS NOT NULL AND default_location_name <> ''`,
      );
      const c = Number((r.rows[0] as { c?: number } | undefined)?.c ?? 0);
      if (c === 0) return "empty";
      const totalR = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM staff WHERE school_id = ${schoolId} AND active = true`,
      );
      const total = Number((totalR.rows[0] as { c?: number } | undefined)?.c ?? 0);
      // "Partial" = some staff configured but not all.
      if (total === 0) return "complete";
      return c >= Math.max(1, Math.floor(total * 0.5)) ? "complete" : "partial";
    },
  },
  {
    key: "locations",
    phase: "Identity & Access",
    label: "Locations & Pass Destinations",
    hint: "Add every room, office, and bathroom that staff or students will pick from a dropdown. Mark each one as origin (where passes start), destination (where passes end), or both. Required before kiosks or hall passes work.",
    route: { kind: "settings", target: "locations" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM locations WHERE school_id = ${schoolId} AND active = true`,
      ),
  },

  // ---------- Phase 2: Schedule & Operations ----------
  {
    key: "bell-schedule",
    phase: "Schedule & Operations",
    label: "Bell Schedule (default)",
    hint: "Create at least one bell schedule (regular day) with each period's start and end time. Mark ONE schedule as the default — this is what the Hall Pass Queue and PBIS Points use to know which period is currently in session.",
    route: { kind: "settings", target: "bell-schedule" },
    autoCheck: async (db, schoolId) => {
      const anyR = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM bell_schedules WHERE school_id = ${schoolId}`,
      );
      const any = Number((anyR.rows[0] as { c?: number } | undefined)?.c ?? 0);
      if (any === 0) return "empty";
      const defR = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM bell_schedules WHERE school_id = ${schoolId} AND is_default = true`,
      );
      const def = Number((defR.rows[0] as { c?: number } | undefined)?.c ?? 0);
      return def > 0 ? "complete" : "partial";
    },
  },
  {
    key: "signage",
    phase: "Schedule & Operations",
    label: "Hallway Signage / TVs",
    hint: "Open the Displays page to copy the hallway-TV URLs for HeartBEAT, Houses leaderboard, and Active Hall Passes. Paste those URLs into each TV's browser. Optional but recommended — turn this on once your TVs are wired up.",
    route: { kind: "settings", target: "signage" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM display_playlists WHERE school_id = ${schoolId}`,
      ),
  },
  {
    key: "data-imports",
    phase: "Schedule & Operations",
    label: "Initial Data Import",
    hint: "Use the Data Importer to upload your roster (students + sections), assessment scores (FAST, iReady, MAP), and any prior behavior data. Upload one CSV at a time — the importer auto-detects columns and shows a preview before commit.",
    route: { kind: "settings", target: "data-imports" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM imports WHERE school_id = ${schoolId}`,
      ),
  },

  // ---------- Phase 3: Behavior & PBIS ----------
  {
    key: "school-features",
    phase: "Behavior & PBIS",
    label: "School Features Switchboard",
    hint: "Toggle the major modules ON for your school: PBIS, FamilyComm, SchoolStore, Accommodations, LogIntervention, RequestPullout. Anything left OFF is hidden from staff. SuperUser must allow each feature first; you flip the actual switch.",
    route: { kind: "settings", target: "schoolFeatures" },
    autoCheck: async () => "empty", // No clean signal; admins tick manually after reviewing.
  },
  {
    key: "pbis-reasons",
    phase: "Behavior & PBIS",
    label: "PBIS Recognition Reasons",
    hint: "Build the list of reasons staff can pick when awarding PBIS points (e.g. \"Helping a peer\", \"On-task\"). Set the point weight and category for each. Staff cannot award points until at least one school-wide reason exists.",
    route: { kind: "section", target: "pbisReasons" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM pbis_reasons WHERE school_id = ${schoolId} AND owner_scope = 'school' AND active = true`,
      ),
  },
  {
    key: "pbis-thresholds",
    phase: "Behavior & PBIS",
    label: "PBIS Alert Thresholds",
    hint: "Tune the three behavior alerts: Quiet Teacher (staff awarding very few points), Invisible Student (going unnoticed), and Reason Imbalance (one category over-used). Defaults work for most schools — adjust if you see too few or too many alerts.",
    route: { kind: "settings", target: "pbis-thresholds" },
    autoCheck: async () => "empty", // Threshold tuning is judgement-based; manual.
  },
  {
    key: "pbis-milestones",
    phase: "Behavior & PBIS",
    label: "PBIS Milestone Emails",
    hint: "Decide which point thresholds (e.g. 25, 50, 100) trigger an automatic congratulations email to parents. Add as many tiers as you want. Requires FamilyComm to be enabled in the Switchboard.",
    route: { kind: "section", target: "pbisMilestoneEmails" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM pbis_milestones WHERE school_id = ${schoolId} AND active = true`,
      ),
  },
  {
    key: "school-store",
    phase: "Behavior & PBIS",
    label: "School Store Catalog",
    hint: "Add the items and privileges students can redeem with PBIS points (e.g. \"5 min computer time = 10 pts\"). Upload a thumbnail image for each. The catalog is school-wide and read-only for teachers.",
    route: { kind: "section", target: "schoolStore" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM school_store_items WHERE school_id = ${schoolId} AND archived = false`,
      ),
  },
  {
    key: "cameras",
    phase: "Behavior & PBIS",
    label: "Camera Registry",
    hint: "Add the named security cameras at your school so admins can pick from a dropdown when logging video evidence on a case (instead of typing long camera names by hand). Schools with 100+ cameras especially benefit. Five demo cameras are seeded automatically; replace them with your real list. Removed cameras are soft-deleted so historical footage rows keep their original camera name.",
    route: { kind: "settings", target: "cameras" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM case_camera_registry WHERE school_id = ${schoolId} AND active = true`,
      ),
  },
  {
    key: "iss-and-discipline",
    phase: "Behavior & PBIS",
    label: "ISS Settings & Discipline Reasons",
    hint: "On the ISS Settings page, enter your daily ISS seat capacity, set the soft/hard behavior rules, and add any school-closed days. Then in the same page, populate the Discipline Reasons dropdown that appears in the Add ISS / OSS Log modals.",
    route: { kind: "settings", target: "iss-settings" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM discipline_reasons WHERE school_id = ${schoolId} AND active = true`,
      ),
  },

  // ---------- Phase 4: Interventions & MTSS ----------
  {
    key: "school-wide-expectations",
    phase: "Interventions & MTSS",
    label: "School-wide Expectations",
    hint: "Enter your school's expectations acronym (e.g. PRIDE, ROAR, PAWS) and what each letter stands for. These letters appear as checkboxes on Tier 3 weekly logs so coaches can track which expectation a student worked on.",
    route: { kind: "settings", target: "school-wide-expectations" },
    autoCheck: async (db, schoolId) => {
      const r = await db.execute(
        sql`SELECT school_wide_expectation_acronym AS a FROM school_settings WHERE school_id = ${schoolId} LIMIT 1`,
      );
      const a = (r.rows[0] as { a?: string | null } | undefined)?.a;
      return typeof a === "string" && a.trim().length > 0
        ? "complete"
        : "empty";
    },
  },
  {
    key: "tier3-strategies",
    phase: "Interventions & MTSS",
    label: "Tier 3 Strategy Catalog",
    hint: "Group your Tier 3 strategies into categories (e.g. \"De-escalation\", \"Academic supports\") and add the individual strategies under each. These populate the weekly checklist your behavior team fills out for every Tier 3 student.",
    route: { kind: "settings", target: "intervention-strategies" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM tier3_strategies WHERE school_id = ${schoolId} AND active = true`,
      ),
  },
  {
    key: "trusted-adult-interventions",
    phase: "Interventions & MTSS",
    label: "Trusted Adult Interventions",
    hint: "Curate the list of TAI types your school uses (e.g. Check-In/Check-Out, mentor lunch, restorative circle). Behavior Specialists pick from this dropdown when assigning a trusted adult to a student.",
    route: { kind: "section", target: "behaviorSpecialist" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM trusted_adult_interventions WHERE school_id = ${schoolId} AND active = true`,
      ),
  },
  {
    key: "mtss-templates",
    phase: "Interventions & MTSS",
    label: "MTSS Plan Templates",
    hint: "Create reusable Tier 2 / Tier 3 plan templates so coaches don't start from scratch each time. Templates include preset goals, monitoring frequency, and a default strategy bundle. Optional but speeds plan creation 10×.",
    route: { kind: "section", target: "mtssTemplates" },
    autoCheck: async () => "empty", // No standalone table here; admins tick manually.
  },
  {
    key: "separation-tags",
    phase: "Interventions & MTSS",
    label: "Separation Reason Tags",
    hint: "Add the reasons your school uses to flag students who shouldn't be paired (e.g. \"Conflict\", \"Family connection\"). Counselors and deans pick from this list when adding a separation pair.",
    route: { kind: "settings", target: "separation-tags" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM separation_reason_tags WHERE school_id = ${schoolId}`,
      ),
  },

  // ---------- Phase 5: Family & Outreach ----------
  {
    key: "heartbeat-sections",
    phase: "Family & Outreach",
    label: "HeartBEAT Section Visibility",
    hint: "Choose which sections of a student's HeartBEAT snapshot are visible to parents (PBIS, hall passes, tardies, accommodations, staff notes, MTSS). Toggle off anything your school isn't ready to share with families yet.",
    route: { kind: "settings", target: "parent-portal-sections" },
    autoCheck: async () => "empty", // Visibility is judgement; manual.
  },
  {
    key: "parent-access",
    phase: "Family & Outreach",
    label: "Parent Portal Access",
    hint: "Turn on the Parent Portal for your school, then send invite emails to parents. Parents accept the invite, set a password, and can then view their student's HeartBEAT and download a PDF report.",
    route: { kind: "section", target: "parentAccess" },
    autoCheck: (db, schoolId) =>
      countGt0(
        db,
        sql`SELECT COUNT(*)::int AS c FROM parents WHERE school_id = ${schoolId}`,
      ),
  },
];

export const ONBOARDING_PHASES: OnboardingPhase[] = [
  "Identity & Access",
  "Schedule & Operations",
  "Behavior & PBIS",
  "Interventions & MTSS",
  "Family & Outreach",
];
