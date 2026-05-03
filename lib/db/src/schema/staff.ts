import { pgTable, serial, text, boolean, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

// Staff schema. Two parallel concepts live here:
//
//  1. Role flags  (is_admin, is_dean, is_mtss_coordinator, ...) — these are
//     the *labels* and the legacy access-control mechanism. They still gate
//     a few admin-only screens (notably Settings) and they're used as
//     "presets" when adding a new staff member.
//
//  2. Capability flags (cap_*) — these are the per-page access toggles that
//     drive what each staff member can see and do. They were introduced to
//     replace the role-based gates so school admins can grant access to one
//     page at a time rather than picking a role that bundles many things.
//
// Migration plan: each capability column is seeded from the equivalent role
// check at rollout time, then route gates and client visibility flags are
// flipped one page at a time to read the capability instead of the role.
// Role flags stay as labels + presets even after the cutover.
export const staffTable = pgTable("staff", {
  id: serial("id").primaryKey(),
  // The staff member's HOME school. Multi-tenancy: every staff row belongs
  // to one school. SuperUsers can act as any school via session override
  // (req.schoolId), but staff.school_id is still their default landing.
  schoolId: integer("school_id").notNull(),
  // SuperUser-only "act as another school" override. Persisted on the staff
  // row (rather than the express session) so the switch survives across
  // bearer-token requests inside the Replit preview iframe, where session
  // cookies are blocked. Null = use the home school.
  activeSchoolOverride: integer("active_school_override"),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),

  // ---- Role flags (legacy gates + labels/presets) ----
  isSuperUser: boolean("is_super_user").notNull().default(false),
  // District Admin tier: sits between SuperUser (cross-school within
  // district) and school Admin (single school). District Admins can manage
  // every school in their own district (rosters, staff, district-scoped
  // CSV imports, district reports) but cannot reach across to other
  // districts and cannot create or alter SuperUsers. The capability is
  // grant-only by SuperUser; school Admins cannot grant it.
  isDistrictAdmin: boolean("is_district_admin").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  isEseCoordinator: boolean("is_ese_coordinator").notNull().default(false),
  isPbisCoordinator: boolean("is_pbis_coordinator").notNull().default(false),
  isBehaviorSpecialist: boolean("is_behavior_specialist").notNull().default(false),
  isIssTeacher: boolean("is_iss_teacher").notNull().default(false),
  isDean: boolean("is_dean").notNull().default(false),
  isMtssCoordinator: boolean("is_mtss_coordinator").notNull().default(false),
  isCounselor: boolean("is_counselor").notNull().default(false),
  isSocialWorker: boolean("is_social_worker").notNull().default(false),
  // School Psychologist sits in the Core Team alongside Admin / BS / MTSS.
  // Has full Tier 2 / Tier 3 plan editing rights, can edit goals
  // (versioned), and can view the Intervention Completion report.
  isSchoolPsychologist: boolean("is_school_psychologist")
    .notNull()
    .default(false),
  // Guidance Counselor: owns student Safety Plans (clear backpack /
  // no sharp objects / escort plan / etc). Edits the school-wide
  // safety-plan item library and any per-student plan. Sees the red
  // SP pill on every roster like everyone else but with click-through
  // edit access. Not automatically a Core Team member — it's a
  // narrower role focused on the safety-plan surface.
  isGuidanceCounselor: boolean("is_guidance_counselor")
    .notNull()
    .default(false),

  // ---- Per-page capability flags ----
  // Pages everyone uses by default — defaulted true so new staff land with
  // the same baseline access teachers have today.
  capHallPasses: boolean("cap_hall_passes").notNull().default(true),
  capTardies: boolean("cap_tardies").notNull().default(true),
  capStudentActivity: boolean("cap_student_activity").notNull().default(true),
  capPbisAward: boolean("cap_pbis_award").notNull().default(true),
  capParentEmail: boolean("cap_parent_email").notNull().default(true),
  capSupportNotes: boolean("cap_support_notes").notNull().default(true),
  capAccommodationLog: boolean("cap_accommodation_log").notNull().default(true),
  capPulloutsRequest: boolean("cap_pullouts_request").notNull().default(true),
  capInterventionLog: boolean("cap_intervention_log").notNull().default(true),
  capReports: boolean("cap_reports").notNull().default(true),
  capKioskActivate: boolean("cap_kiosk_activate").notNull().default(true),

  // Restricted-by-default pages — seeded from current role gates at rollout.
  capHallPassesViewAll: boolean("cap_hall_passes_view_all")
    .notNull()
    .default(false),
  capPbisManage: boolean("cap_pbis_manage").notNull().default(false),
  capAccommodationManage: boolean("cap_accommodation_manage")
    .notNull()
    .default(false),
  capPulloutsVerify: boolean("cap_pullouts_verify").notNull().default(false),
  capPulloutsReview: boolean("cap_pullouts_review").notNull().default(false),
  capInterventionManage: boolean("cap_intervention_manage")
    .notNull()
    .default(false),
  capIssDashboard: boolean("cap_iss_dashboard").notNull().default(false),
  capManageLocations: boolean("cap_manage_locations").notNull().default(false),
  capStaffRoles: boolean("cap_staff_roles").notNull().default(false),
  capManageRoles: boolean("cap_manage_roles").notNull().default(false),
  // Per-teacher grant for the digital-signage / Displays feature.
  // Core team (admin / MTSS / behavior specialist / dean / SuperUser)
  // gets it implicitly; this flag lets an admin extend the
  // capability to individual teachers who run a classroom TV.
  capManageDisplays: boolean("cap_manage_displays")
    .notNull()
    .default(false),

  // Optional home/default classroom for this staff member. Stored as
  // free text (the location name) so historical records remain intact if
  // a room is later renamed or deleted. The Send Pass modal uses this
  // value to pre-fill the origin room so teachers don't have to pick it
  // every time.
  defaultRoom: text("default_room"),

  externalId: text("external_id"),
  ssoProvider: text("sso_provider"),
  active: boolean("active").notNull().default(true),
  // Per-user UI preferences (jsonb). Free-form key/value bag for
  // individual UI customizations that should sync across devices —
  // e.g. dashboard tile orderings, collapsed sections, etc. Each
  // feature owns its own top-level key (see UiPrefs type).
  uiPrefs: jsonb("ui_prefs")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StaffRow = typeof staffTable.$inferSelect;
