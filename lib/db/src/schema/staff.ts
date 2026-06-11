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
  // Admin/DistrictAdmin/SuperUser "Preview as another staff" override.
  // When set, the global request middleware swaps req.staffId from this
  // row to the target row before resolving schoolId or anything else, so
  // every downstream route sees the impersonated identity. Persisted on
  // the staff row (rather than the express session) for the same reason
  // as activeSchoolOverride: session cookies are blocked inside the
  // Replit preview iframe, so any state that must survive bearer-only
  // requests has to live in the DB. Cleared by /api/admin/staff-preview/end.
  previewTargetStaffId: integer("preview_target_staff_id"),
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
  // Non-Exempt role: a descriptive role flag distinct from
  // `exemptStatus`. Assigning the role via the preset bundle also
  // flips exemptStatus to 'non_exempt' so Comp Time accrues, but
  // admins can independently mark anyone non-exempt without applying
  // this role (some non-exempt staff hold other roles). When true,
  // the sidebar collapses to Hall Pass + Tardy Pass + Comp Time —
  // these are the only three surfaces this role uses.
  isNonExemptRole: boolean("is_non_exempt_role").notNull().default(false),
  // Front Office: clerical staff who run the front desk. Same view as
  // a teacher, plus AST (submit only), Watchlists, Accommodations.
  // Explicitly excludes Request Pullout (pullouts are a teacher
  // referral). Confidential Secretary keeps its own approver rights
  // — this role does NOT grant approval.
  isFrontOffice: boolean("is_front_office").notNull().default(false),
  // School Resource Officer — sworn officer assigned to the school.
  // Currently identical to teacher view; broken out so reports and
  // future surfaces (incident logs, etc) can target it cleanly.
  isSro: boolean("is_sro").notNull().default(false),
  // Guardian / hall monitor / security aide. Same as teacher today.
  isGuardian: boolean("is_guardian").notNull().default(false),

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
  // Parent Pick-Up Module — grants access to the curb keypad and the
  // walker gate page. Granted by admins to paraprofessionals or
  // front-office assistants who run the dismissal line. Admins have
  // implicit access (route gates check admin OR this flag) so admins
  // don't need this flag set.
  capCarRiderMonitor: boolean("cap_car_rider_monitor")
    .notNull()
    .default(false),
  // Parent Pick-Up Module — grants the holder permission to set a
  // student's dismissal mode (car_rider / walker / bus / aftercare /
  // parent_pickup_only). Until this cap landed, only `isAdmin` could
  // change it, which forced a real front-office clerk to either get
  // the full admin role or send the change up the chain. Admins
  // retain implicit access via the route gate (admin OR this flag),
  // so admins do not need this flag set.
  capManageDismissal: boolean("cap_manage_dismissal")
    .notNull()
    .default(false),
  // AST (Alternate Schedule Time) per HCTA contract. Grants the holder
  // permission to pre-approve / confirm / deny earn requests and approve /
  // deny use requests. Backfilled true for any admin tier (school admin /
  // district admin / super user) at boot so the rollout doesn't break
  // existing workflows; admins can extend it to a confidential secretary
  // or anyone else who needs to sign off without taking on the rest of
  // the admin role. Route gates check admin OR this flag.
  canApproveAst: boolean("can_approve_ast").notNull().default(false),

  // School Tours — when true, this staff member is on the notify group for
  // new tour-request leads (big admin banner + email + the AWS SMS stub).
  // Admin / Core Team / counselor / confidential secretary already qualify
  // via the `canManageTours` route gate; this flag lets an admin add anyone
  // else (e.g. a front-office tour coordinator) to the alert audience and
  // the lead pipeline without granting the rest of the admin surface.
  capTourNotify: boolean("cap_tour_notify").notNull().default(false),

  // Document e-Signing — grants access to the e-Sign manager (upload a
  // PDF/image, share a signing link, collect the signed copy). Office-side
  // tool assignable to a registrar or confidential secretary without the
  // rest of the admin surface. Admins / SuperUser get it implicitly via the
  // route gate (admin OR this flag). Documents are private to the creator.
  capManageEsign: boolean("cap_manage_esign").notNull().default(false),

  // Comp Time (FLSA compensatory time) per-staff capabilities. Mirrors
  // the AST gate above so the role-management UI can sit them side by
  // side under "Time Tracking."
  //
  // exemptStatus  — required for staff to see / submit comp-time
  //                 requests. 'non_exempt' enables the bank; 'exempt'
  //                 (and NULL) hard-blocks at the route with a copy
  //                 that points teachers at AST.
  // canApproveCompTime — explicit per-staff approver flag. Backfilled
  //                 TRUE for admin tier at boot. Principals + Assistant
  //                 Principals are auto-elected by the seed; admins
  //                 can extend to a confidential secretary / HR clerk
  //                 the same way they do for AST.
  exemptStatus: text("exempt_status"),
  canApproveCompTime: boolean("can_approve_comp_time")
    .notNull()
    .default(false),
  // Stamped when an admin marks the staff member as paid-out (flipped
  // to exempt OR separated). The payout writes a negative ledger row
  // zeroing the balance; this column is the human-readable "yes, the
  // last check went out" marker on Staff & Roles.
  compTimePaidOutAt: timestamp("comp_time_paid_out_at", {
    withTimezone: true,
  }),

  // Optional home/default classroom for this staff member. Stored as
  // free text (the location name) so historical records remain intact if
  // a room is later renamed or deleted. The Send Pass modal uses this
  // value to pre-fill the origin room so teachers don't have to pick it
  // every time.
  defaultRoom: text("default_room"),
  // Optional PBIS house affiliation for the staff member. FK to houses.id
  // (no DB-level constraint — same convention as students.house_id). Used
  // on the kiosk activation card and any future "your house" UX. Nullable
  // so existing staff rows and non-house schools stay valid.
  houseId: integer("house_id"),

  // Staff Directory phone numbers, surfaced in the Finder ("Where is
  // this teacher right now?") and on student-finder schedule rows.
  // - workExtension: low-sensitivity (school extension or classroom
  //   line). Visible to every signed-in staff member.
  // - cellPhone: high-sensitivity personal cell number. Visibility is
  //   controlled by school_settings.staff_directory_show_cell_phone:
  //     OFF (default) — only Core Team / Admin / SuperUser can see it
  //     ON              — every signed-in staff member can see it
  //   Edits are restricted to Core Team / Admin / SuperUser regardless.
  //   Server is the source of truth for the redaction; the client
  //   never receives the cell number when the caller is not allowed
  //   to see it.
  workExtension: text("work_extension"),
  cellPhone: text("cell_phone"),

  // Optional academic department, set by an admin on Staff & Roles via a
  // fixed dropdown (ELA / Math / Science / Social Studies / CTE / Elective /
  // Other) and surfaced in the staff CSV export. Nullable — most staff
  // (non-teaching, or unclassified) leave it blank. Stored as free text but
  // the API constrains writes to the known set.
  department: text("department"),

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
