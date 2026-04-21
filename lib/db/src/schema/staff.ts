import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

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
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),

  // ---- Role flags (legacy gates + labels/presets) ----
  isSuperUser: boolean("is_super_user").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  isEseCoordinator: boolean("is_ese_coordinator").notNull().default(false),
  isPbisCoordinator: boolean("is_pbis_coordinator").notNull().default(false),
  isBehaviorSpecialist: boolean("is_behavior_specialist").notNull().default(false),
  isIssTeacher: boolean("is_iss_teacher").notNull().default(false),
  isDean: boolean("is_dean").notNull().default(false),
  isMtssCoordinator: boolean("is_mtss_coordinator").notNull().default(false),
  isCounselor: boolean("is_counselor").notNull().default(false),
  isSocialWorker: boolean("is_social_worker").notNull().default(false),

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

  externalId: text("external_id"),
  ssoProvider: text("sso_provider"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StaffRow = typeof staffTable.$inferSelect;
