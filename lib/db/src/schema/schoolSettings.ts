import { pgTable, serial, text, integer, real, boolean, uniqueIndex, jsonb, timestamp } from "drizzle-orm/pg-core";

// Per-school operational settings. As of D4 there is exactly one row per
// school (enforced by `school_settings_school_id_unique`). Routes
// read-or-create the row for `req.schoolId` so a brand-new school gets
// sensible defaults the first time anyone opens its Settings page.
export const schoolSettingsTable = pgTable(
  "school_settings",
  {
    id: serial("id").primaryKey(),
    // Tenant column. NOT NULL DEFAULT 1 stays as a safety net until every
    // INSERT path is explicit — same pattern as the rest of the D2 work.
    schoolId: integer("school_id").notNull(),
    schoolName: text("school_name").notNull().default("PulseED"),
  fromName: text("from_name").notNull().default("PulseED"),
  emailSignature: text("email_signature").notNull().default("Thank you,\nPulseED"),
  periodCount: integer("period_count").notNull().default(7),
  hallPassMaxMinutes: integer("hall_pass_max_minutes").notNull().default(30),
  hallPassDefaultMinutes: integer("hall_pass_default_minutes")
    .notNull()
    .default(5),
  // Optional school-wide cap on the number of hall passes a student can take
  // in one school day. Null means no global cap.
  globalDailyHallPassLimit: integer("global_daily_hall_pass_limit"),
  // -----------------------------------------------------------------
  // ISS room daily seat capacity (Admin Hub).
  //   issDailyCapacity = max number of unique student-days the ISS room
  //     can hold per day (counts walk-in + pullout + admin-logged
  //     together). NULL = no cap.
  //   issCapacityBehavior = 'soft' shows a confirm prompt on save when
  //     the chosen day is at/over capacity (admin can override). 'hard'
  //     refuses the save. Rollover always bypasses the check (with a
  //     dashboard badge so ISS Teacher sees the over-cap state).
  // -----------------------------------------------------------------
  issDailyCapacity: integer("iss_daily_capacity"),
  issCapacityBehavior: text("iss_capacity_behavior").notNull().default("soft"),
  // PBIS Hub "Needs Attention" thresholds
  pbisQuietTeacherDays: integer("pbis_quiet_teacher_days").notNull().default(5),
  // DEPRECATED (kept for back-compat, no longer read): the single flat
  // "Invisible Student" window. Superseded by the three tier-aware windows
  // below. Left in place to avoid a destructive migration.
  pbisInvisibleStudentDays: integer("pbis_invisible_student_days")
    .notNull()
    .default(10),
  // Tier-aware "Invisible Student" alert windows (school days). A student
  // is "invisible" when they have 0 non-voided PBIS recognitions within
  // the window for their highest active MTSS tier. Higher-need students
  // surface faster. Tier 1 = no active MTSS plan (general population);
  // Tier 2 / Tier 3 = most intensive open plan.
  pbisInvisibleDaysTier1: integer("pbis_invisible_days_tier1")
    .notNull()
    .default(8),
  pbisInvisibleDaysTier2: integer("pbis_invisible_days_tier2")
    .notNull()
    .default(5),
  pbisInvisibleDaysTier3: integer("pbis_invisible_days_tier3")
    .notNull()
    .default(3),
  pbisReasonImbalancePct: integer("pbis_reason_imbalance_pct")
    .notNull()
    .default(60),
  pbisColdPeriodMultiple: integer("pbis_cold_period_multiple")
    .notNull()
    .default(5),
  // -----------------------------------------------------------------
  // Watch List (Insights) "Needs Attention" thresholds.
  //
  // The system-driven Watch List defaults to showing ONLY students who
  // trip at least one risk trigger (a "needs attention" gate), with a
  // "Show full roster" escape hatch. A student surfaces when ANY of:
  //   - an active MTSS plan at Tier >= 2                 (always-on)
  //   - FAST bottom-quartile in ELA or Math             (always-on)
  //   - absences >= watchlistAbsenceThreshold  (semester total, Eligibility Hub)
  //   - behavior entries >= watchlistBehaviorThreshold  (pbis negatives + support notes, in window)
  //   - tardies >= watchlistTardyThreshold              (in window)
  //   - ISS days >= watchlistIssThreshold               (in window)
  // Tier + bottom-quartile are inherently boolean triggers, so only the
  // count-based ones are school-configurable here.
  // -----------------------------------------------------------------
  watchlistAbsenceThreshold: integer("watchlist_absence_threshold")
    .notNull()
    .default(10),
  watchlistBehaviorThreshold: integer("watchlist_behavior_threshold")
    .notNull()
    .default(3),
  watchlistTardyThreshold: integer("watchlist_tardy_threshold")
    .notNull()
    .default(5),
  watchlistIssThreshold: integer("watchlist_iss_threshold")
    .notNull()
    .default(1),
  // Classroom-intervention effectiveness window (days). A logged intervention
  // counts as having WORKED if the behavior it targeted does not recur for that
  // student within this many days; if it recurs inside the window it RECURRED;
  // before the window elapses it is PENDING. School-configurable on the
  // Negative Behaviors tab. Default 14.
  interventionEffectivenessDays: integer("intervention_effectiveness_days")
    .notNull()
    .default(14),
  // School Tours — SMS notification scope. 'all' sends a text for every tour
  // alert (new lead, lead assigned, …); 'urgent' limits texts to time-
  // sensitive alerts only (the alert helper passes a tier and standard alerts
  // are suppressed). Email is always sent regardless. Defaults to 'all' so
  // existing behavior is unchanged.
  tourSmsScope: text("tour_sms_scope")
    .$type<"all" | "urgent">()
    .notNull()
    .default("all"),
  // School Tours — Phase 2 "never lose a lead" SLA settings. The background
  // escalation job + the pipeline overdue flags read these.
  //   tourFirstContactHours — a 'new' lead uncontacted longer than this is
  //     overdue (legacy hard-coded 24h is now the default).
  //   tourFollowUpBusinessDays — when a lead is moved to "Still deciding", its
  //     follow-up becomes due this many business days later.
  //   tourArchiveDays — closed leads older than this drop off the default
  //     pipeline board (still queryable via ?view=archived).
  //   tourEscalationEnabled — master switch for the automated overdue emails.
  //     Sending is ALSO gated globally on EMAIL_REMINDERS_ENABLED.
  tourFirstContactHours: integer("tour_first_contact_hours")
    .notNull()
    .default(24),
  tourFollowUpBusinessDays: integer("tour_follow_up_business_days")
    .notNull()
    .default(3),
  tourArchiveDays: integer("tour_archive_days").notNull().default(3),
  tourEscalationEnabled: boolean("tour_escalation_enabled")
    .notNull()
    .default(true),
  // School Tours — Phase 3 "close the loop with families" master switch for the
  // automated FAMILY nurture cadence (pre-tour reminder, post-tour thank-you +
  // survey, gentle "still deciding" nudge, enrollment welcome). Defaults OFF so
  // no school starts emailing families automatically without opting in.
  tourFamilyNurtureEnabled: boolean("tour_family_nurture_enabled")
    .notNull()
    .default(false),
  // How many hours before the scheduled tour the pre-tour reminder goes out.
  tourReminderLeadHours: integer("tour_reminder_lead_hours")
    .notNull()
    .default(24),
  // When true, awarding a negative behavior subtracts its point value from
  // the student's running total. When false (default), the entry is logged
  // on the student's record as a red entry but does not affect the total.
  pbisNegativeAffectsTotal: boolean("pbis_negative_affects_total")
    .notNull()
    .default(false),
  // School Store inventory mode — how item availability is tracked.
  //   "simple"   → each item has a manual in/out-of-stock toggle.
  //   "quantity" → each item tracks a quantity-on-hand that decrements on
  //                redemption and restores on cancellation.
  // Default "simple" so existing catalogs keep working without setup.
  schoolStoreInventoryMode: text("school_store_inventory_mode")
    .notNull()
    .default("simple"),
  // Finder ("Where is this student right now?") — show the "Absent today"
  // banner when the student's attendance day is marked absent. Off by
  // default because attendance currently arrives from the SIS on a delay
  // (not same-day), so a stale banner would mis-locate a student who
  // actually IS on campus. Schools that take attendance directly in
  // PulseEDU (or whose SIS feed is reliably same-day) can flip this on
  // from School Settings.
  finderShowAbsentBanner: boolean("finder_show_absent_banner")
    .notNull()
    .default(false),
  // Staff Directory cell-phone visibility. When false (default), only
  // Core Team / Admin / SuperUser can see staff personal cell numbers
  // in the Finder. When true, every signed-in staff member can see
  // them — appropriate for schools that treat the cell list as a
  // faculty-meeting handout. Work extensions are always visible to
  // everyone regardless of this toggle. Editing is always restricted
  // to Core Team / Admin / SuperUser.
  staffDirectoryShowCellPhone: boolean("staff_directory_show_cell_phone")
    .notNull()
    .default(false),
  // Data Importer — manual roster upload toggle. Default OFF because the
  // expected source of truth for most schools is a Classlink / Clever
  // OneRoster sync. When false, the Roster card in the Data Importer
  // wizard is disabled and the server's roster commit endpoint refuses
  // the upload (defense-in-depth so a stale tab can't bypass the UI).
  // When true, the wizard exposes the Roster importer, which inserts
  // new students AND updates existing ones (with COALESCE so blank CSV
  // cells preserve current values). Updates are snapshotted into
  // student_import_snapshots so rollback is fully reversible.
  manualRosterUploadEnabled: boolean("manual_roster_upload_enabled")
    .notNull()
    .default(false),
  // Data Importer — strict house-name matching for the Roster importer.
  // Default OFF preserves the legacy behavior where a CSV row whose
  // `house_name` doesn't match any configured house silently falls back
  // to the smallest-house rotation. When ON, those rows are rejected at
  // commit time with a per-row error instead of being rebalanced into a
  // house the admin never picked — appropriate for schools whose SIS
  // export occasionally typos a house name and would rather block the
  // row than quietly shuffle a student.
  strictHouseNameMatch: boolean("strict_house_name_match")
    .notNull()
    .default(false),
  // -----------------------------------------------------------------
  // Parent Notifications control panel (Family Communication).
  //
  // Per-school admin master switches for each automated/recurring parent
  // notification. ALL default TRUE so existing behavior is preserved — a
  // school sees no change until an admin flips one off. Each flag is an
  // additive AND-gate layered on top of any existing gate at the send site
  // (the send still respects feature flags, parent opt-ins, etc.).
  //
  // Notifications that already have a dedicated school switch are NOT
  // duplicated here and are surfaced in the panel via their existing flag:
  //   - Friday HeartBEAT   → school_heartbeat_settings.allow_weekly_email
  //   - Family Messages    → feature_family_comm
  //   - Store item ready   → feature_school_store_notify
  //   - Tour family nurture→ tour_family_nurture_enabled
  //
  // Portal invite + password reset are intentionally absent — they are
  // access-critical and always-on (never toggleable).
  // -----------------------------------------------------------------
  notifyParentEligibility: boolean("notify_parent_eligibility")
    .notNull()
    .default(true),
  notifyParentPbisMilestone: boolean("notify_parent_pbis_milestone")
    .notNull()
    .default(true),
  notifyParentTardy: boolean("notify_parent_tardy").notNull().default(true),
  notifyParentEventTickets: boolean("notify_parent_event_tickets")
    .notNull()
    .default(true),
  notifyParentEsign: boolean("notify_parent_esign").notNull().default(true),
  // -----------------------------------------------------------------
  // Request Pullout dispatch notifications.
  //   pulloutSmsEnabled             → also TEXT dispatch recipients (off by
  //     default; email always sends regardless).
  //   pulloutExtraRecipientStaffIds → additional staff (by id) who receive the
  //     dispatch email/text REGARDLESS of role (e.g. a reading coach who helps
  //     with pullouts but is not Admin/Dean/MTSS/ISS). Role-based recipients
  //     always get it; this list is purely additive.
  // -----------------------------------------------------------------
  pulloutSmsEnabled: boolean("pullout_sms_enabled").notNull().default(false),
  pulloutExtraRecipientStaffIds: jsonb("pullout_extra_recipient_staff_ids")
    .$type<number[]>()
    .notNull()
    .default([]),
  // -----------------------------------------------------------------
  // Per-school feature flags (two-tier model).
  //
  //   super_feature_*  → SuperUser-controlled "is this feature available
  //                       to this school at all?" (the billing tier).
  //   feature_*        → Admin-controlled "do we want it on right now?"
  //
  // A feature is live when BOTH switches are on. Admins cannot enable a
  // feature whose super_* flag is off. Defaults are TRUE so existing
  // schools see no change in behavior.
  // -----------------------------------------------------------------
  featureFamilyComm: boolean("feature_family_comm").notNull().default(true),
  featurePbis: boolean("feature_pbis").notNull().default(true),
  featureSchoolStore: boolean("feature_school_store").notNull().default(true),
  featureAccommodations: boolean("feature_accommodations").notNull().default(true),
  featureLogIntervention: boolean("feature_log_intervention").notNull().default(true),
  featureRequestPullout: boolean("feature_request_pullout").notNull().default(true),
  // Expanded sellable feature catalog (T1 of school-plans work).
  featureHallPasses: boolean("feature_hall_passes").notNull().default(true),
  featureTardyPass: boolean("feature_tardy_pass").notNull().default(true),
  featureMtssPlans: boolean("feature_mtss_plans").notNull().default(true),
  featureBehaviorSpecialist: boolean("feature_behavior_specialist").notNull().default(true),
  featureIssDashboard: boolean("feature_iss_dashboard").notNull().default(true),
  featureDisplays: boolean("feature_displays").notNull().default(true),
  featureBellSchedule: boolean("feature_bell_schedule").notNull().default(true),
  featureEarlyWarning: boolean("feature_early_warning").notNull().default(true),
  featureAcademics: boolean("feature_academics").notNull().default(true),
  featureDataImports: boolean("feature_data_imports").notNull().default(true),
  featureHouses: boolean("feature_houses").notNull().default(true),
  featureParentPortal: boolean("feature_parent_portal").notNull().default(true),
  // Partnering with Parents (staff) / Learning at Home (parents) — the
  // academic work-sample sharing feature. Some schools won't use it.
  featureAcademicEvidence: boolean("feature_academic_evidence")
    .notNull()
    .default(true),
  // School Store fulfillment notification (email families when a redeemed
  // store item is fulfilled). NEW opt-in feature: BOTH halves default FALSE
  // so no family email goes out until the district enables it AND the school
  // admin turns it on — a deliberate deviation from the default(true)
  // convention because this sends external email.
  featureSchoolStoreNotify: boolean("feature_school_store_notify")
    .notNull()
    .default(false),
  // Allow classroom teachers (non-Core-Team) to send Family Messages to the
  // families of ONE of their own class periods, or to hand-picked students from
  // their own roster. OFF by default — an admin must opt in. Core Team can
  // always broadcast regardless of this flag; this only unlocks the narrower,
  // roster-scoped teacher composer. Server always re-enforces the own-periods
  // and own-students scopes; this flag only decides whether a teacher may send.
  teacherFamilyMessagingEnabled: boolean("teacher_family_messaging_enabled")
    .notNull()
    .default(false),
  superFeatureFamilyComm: boolean("super_feature_family_comm").notNull().default(true),
  superFeaturePbis: boolean("super_feature_pbis").notNull().default(true),
  superFeatureSchoolStore: boolean("super_feature_school_store").notNull().default(true),
  superFeatureAccommodations: boolean("super_feature_accommodations").notNull().default(true),
  superFeatureLogIntervention: boolean("super_feature_log_intervention").notNull().default(true),
  superFeatureRequestPullout: boolean("super_feature_request_pullout").notNull().default(true),
  superFeatureHallPasses: boolean("super_feature_hall_passes").notNull().default(true),
  superFeatureTardyPass: boolean("super_feature_tardy_pass").notNull().default(true),
  superFeatureMtssPlans: boolean("super_feature_mtss_plans").notNull().default(true),
  superFeatureBehaviorSpecialist: boolean("super_feature_behavior_specialist").notNull().default(true),
  superFeatureIssDashboard: boolean("super_feature_iss_dashboard").notNull().default(true),
  superFeatureDisplays: boolean("super_feature_displays").notNull().default(true),
  superFeatureBellSchedule: boolean("super_feature_bell_schedule").notNull().default(true),
  superFeatureEarlyWarning: boolean("super_feature_early_warning").notNull().default(true),
  superFeatureAcademics: boolean("super_feature_academics").notNull().default(true),
  superFeatureDataImports: boolean("super_feature_data_imports").notNull().default(true),
  superFeatureHouses: boolean("super_feature_houses").notNull().default(true),
  superFeatureParentPortal: boolean("super_feature_parent_portal").notNull().default(true),
  superFeatureAcademicEvidence: boolean("super_feature_academic_evidence")
    .notNull()
    .default(true),
  // AST shipped after the original superFeature catalog; added here so
  // the licensing layer can gate it like every other feature.
  superFeatureAst: boolean("super_feature_ast").notNull().default(true),
  // Comp Time (FLSA compensatory time, non-exempt only). Default ON
  // for the enterprise rollout — the route still hard-blocks staff
  // whose exempt_status != 'non_exempt' so the flag does NOT broadly
  // enable comp-time accrual for teachers (they remain on AST).
  superFeatureCompTime: boolean("super_feature_comp_time")
    .notNull()
    .default(true),
  // SuperUser/district half of the School Store fulfillment notification.
  // Defaults FALSE — the district must explicitly license it (plan/override).
  superFeatureSchoolStoreNotify: boolean("super_feature_school_store_notify")
    .notNull()
    .default(false),
  // -----------------------------------------------------------------
  // Time Tracking nuances (governs both AST + Comp Time so a school
  // configures workweek once for the whole "Time Tracking" surface).
  //
  // workweekStart  — 'sunday' (default, FLSA canonical) | 'monday'.
  //                  Comp-time submissions anchor `week_start_date`
  //                  to this and the route validates the supplied
  //                  date is a workweek start.
  // compTimeRequireAuthForm — when true, every earn submission MUST
  //                           include a signed Authorization to
  //                           Accrue Comp Time. Default true; admins
  //                           can disable if their district uses a
  //                           separate paper process.
  // compTimeAuthFormObjectKey — object key (in /api/storage/*) for
  //                           the blank template staff download
  //                           before signing. NULL = use the built-in
  //                           generic PDF template.
  // -----------------------------------------------------------------
  workweekStart: text("workweek_start").notNull().default("sunday"),
  compTimeRequireAuthForm: boolean("comp_time_require_auth_form")
    .notNull()
    .default(true),
  compTimeAuthFormObjectKey: text("comp_time_auth_form_object_key"),
  // FAST Phase 2 — per-benchmark mastery threshold (percentage 0–100).
  // A student is considered to have mastered a benchmark when their
  // (points_earned / points_possible) on that benchmark in the selected
  // window is >= this threshold. Drives the heatmap color buckets and
  // the bottom-3 tile on Teacher Roster → Benchmarks tab. Configurable
  // per school so a building can tune the bar with its own data.
  fastBenchmarkMasteryThreshold: integer("fast_benchmark_mastery_threshold")
    .notNull()
    .default(80),
  // FAST Phase 4 — z-score threshold for flagging outlier teachers on
  // the admin FAST Benchmarks dashboard. A teacher whose class-avg
  // mastery on the selected benchmark is more than this many standard
  // deviations below the school-wide grade mean is flagged. Stored as
  // a REAL so admins can tighten (1.5) or loosen (0.75) the bar.
  // Default 1.0 = roughly the bottom 16% of teachers per benchmark.
  fastOutlierZThreshold: real("fast_outlier_z_threshold")
    .notNull()
    .default(1.0),
  // FAST Phase 5 — minimum number of below-threshold windows (out of
  // the most recent 3 administered windows for that subject) required
  // before a (student, benchmark_code) pair surfaces as a Tier 2
  // auto-suggestion on the MTSS hub. Default 2 mirrors the common
  // "missed twice in a row" rule of thumb. Mastery threshold itself
  // reuses `fastBenchmarkMasteryThreshold` above so admins only tune
  // one number.
  fastTier2MinWindows: integer("fast_tier2_min_windows")
    .notNull()
    .default(2),
  // FAST Phase 1 (Historical FAST + Algebra I placement review) —
  // how many PM3 school years (current + prior) the multi-year FAST
  // trajectory chip renders on Student Profile, Teacher Roster, and
  // the MTSS plan editor. Imports older than this window remain in
  // the database — they just don't render. 5-year cap is hard:
  // FAST launched in FL 22-23; older data uses the FSA scale, which
  // is not comparable.
  fastHistoryYearsVisible: integer("fast_history_years_visible")
    .notNull()
    .default(3),
  // ---------------------------------------------------------------------------
  // School-controlled school-year rollover ("flip"). Replaces the wall-clock
  // July-1 rollover for the FAST/Insights *reporting year* only — schedules and
  // grade promotion stay owned by the SIS (RosterOne). Both nullable/off by
  // default so behavior is unchanged until a school schedules a flip.
  //   - schoolYearFlipDate: admin-chosen date (YYYY-MM-DD, school-local) on or
  //     after which the reporting year advances. Null = no scheduled flip.
  //   - schoolYearFlipActive: the year label the flip has ACTIVATED (e.g.
  //     "26-27"), set by reconcileSchoolYearFlip once the date passes and the
  //     outgoing year's rows are re-tagged historical. Null = not yet flipped.
  // ---------------------------------------------------------------------------
  schoolYearFlipDate: text("school_year_flip_date"),
  schoolYearFlipActive: text("school_year_flip_active"),
  // Advisory pointer to the tier_presets row last applied to this
  // school. The actual flags above are still authoritative — this is
  // purely so the School Plans grid can show "Currently: Pro" badges.
  tierPresetId: integer("tier_preset_id"),
  // -----------------------------------------------------------------
  // School-wide expectations (PRIDE / equivalent). Used as the optional
  // row on the Tier 3 weekly form when a plan opts in. The acronym is
  // displayed as the row label; `letters` is the per-letter breakdown
  // shown in tooltips and on the school's printable expectations page.
  // -----------------------------------------------------------------
  schoolWideExpectationAcronym: text("school_wide_expectation_acronym")
    .notNull()
    .default("PRIDE"),
  // -----------------------------------------------------------------
  // Parent Pick-Up Module per-school settings.
  //   pickupCutoffTime — "HH:MM" school-local. After this time the
  //     Admin Hub "Still on campus" tile becomes visible. Default 15:30.
  //   pickupTeacherViewScope — controls what /pickup/teacher returns:
  //     'all_students' (default) shows the full school queue; teachers
  //     can release anyone (any-staff-can-release matches the school
  //     reality where a kid in art class needs to be released by the
  //     art teacher, not their homeroom). 'own_roster' restricts to
  //     students on the calling teacher's class_sections roster.
  //     The server enforces this on EVERY release event, so a stale
  //     client tab can't bypass it.
  // -----------------------------------------------------------------
  // -----------------------------------------------------------------
  // Restroom Access Control. When ON, the Create Pass modal HARD-BLOCKS
  // restroom-kind destinations to the resolved allowed set: a teacher's
  // per-teacher override (teacher_restroom_overrides) if they have one,
  // otherwise the origin room's restroom pairings
  // (location_allowed_destinations restroom rows). Unselected restrooms
  // are hidden entirely. When a room has no restroom config and the
  // teacher has no override, NO restrooms are offered (explicit empty
  // state — no fall-through to "all restrooms"). Non-restroom
  // destinations are never affected. Default OFF preserves existing
  // behavior for every current school.
  // -----------------------------------------------------------------
  restroomAccessControlEnabled: boolean("restroom_access_control_enabled")
    .notNull()
    .default(false),
  pickupCutoffTime: text("pickup_cutoff_time").notNull().default("15:30"),
  pickupTeacherViewScope: text("pickup_teacher_view_scope")
    .notNull()
    .default("all_students"),
  // -----------------------------------------------------------------
  // "In car" terminal step toggle. When TRUE (default — preserves
  // existing behavior), curb staff tap "in_car" to remove a student
  // from the live queue. When FALSE, the workflow ends at
  // released_to_walk ("walking out") — no curb tap required. The
  // student's row stays visible on the live queue for
  // pickupWalkedOutDisplaySeconds after release so road staff can
  // see who's on the way, then drops from the *display* (the
  // released_to_walk audit row is preserved forever).
  // Reconciliation treats released_to_walk as a terminal pickup
  // signal when this toggle is OFF.
  // -----------------------------------------------------------------
  pickupInCarStepEnabled: boolean("pickup_in_car_step_enabled")
    .notNull()
    .default(true),
  pickupWalkedOutDisplaySeconds: integer("pickup_walked_out_display_seconds")
    .notNull()
    .default(300),
  // -----------------------------------------------------------------
  // Kiosk welcome messages (Phase 3 — "Sign in to class" flow).
  //   kioskWelcomeTemplate  — default template shown to every student
  //     after they sign in. Supports {firstName}, {lastName}, {house},
  //     {grade} placeholders. Length capped at 240 chars by the route.
  //   kioskWelcomeMessages  — optional per-house override map keyed by
  //     house id (stringified): { "12": "Welcome home, Phoenix!" }.
  //     Empty / missing key falls back to kioskWelcomeTemplate.
  // -----------------------------------------------------------------
  // One-way hall pass: minutes a student may be "in route" (left origin,
  // not yet checked in at the destination) before the overdue-in-route
  // alert fires to admin/dean/behavior-specialist/core-team. Default 10.
  inRouteOverdueMinutes: integer("in_route_overdue_minutes")
    .notNull()
    .default(10),
  // -----------------------------------------------------------------
  // Eligibility Hub (attendance-based participation eligibility for
  // athletics / clubs / activities). Thresholds are uniform school-wide
  // across every activity (district default; set by district admin +
  // Athletic Director + SuperUser).
  //   eligibilityIneligibilityThreshold — counted absences at/above this
  //     make a student INELIGIBLE.
  //   eligibilityWarningWindowDays — when counted absences are within this
  //     many of the threshold (and below it), the student is in the
  //     WARNING zone.
  //   eligibilityTardyToAbsenceRatio — every N tardies count as one
  //     absence. 0 = tardies never roll into the absence count.
  //   eligibilityParentNoteCap — max approved parent notes per student per
  //     semester (each note excuses one absence).
  //   eligibilityDistrictAdNotify — when true, the district AD is BCC'd on
  //     warning / ineligible notifications.
  //   eligibilitySemester* — the CURRENT semester label + date window. The
  //     absence/note ledger is keyed by this label, so changing it starts
  //     a clean count (old rows remain under the old label).
  // -----------------------------------------------------------------
  eligibilityIneligibilityThreshold: integer(
    "eligibility_ineligibility_threshold",
  )
    .notNull()
    .default(10),
  eligibilityWarningWindowDays: integer("eligibility_warning_window_days")
    .notNull()
    .default(4),
  eligibilityTardyToAbsenceRatio: integer("eligibility_tardy_to_absence_ratio")
    .notNull()
    .default(0),
  eligibilityParentNoteCap: integer("eligibility_parent_note_cap")
    .notNull()
    .default(5),
  eligibilityDistrictAdNotify: boolean("eligibility_district_ad_notify")
    .notNull()
    .default(false),
  eligibilitySemesterLabel: text("eligibility_semester_label")
    .notNull()
    .default(""),
  eligibilitySemesterStart: text("eligibility_semester_start"),
  eligibilitySemesterEnd: text("eligibility_semester_end"),
  // Eligibility Hub feature flag (two-tier, like the others above).
  featureEligibility: boolean("feature_eligibility").notNull().default(true),
  superFeatureEligibility: boolean("super_feature_eligibility")
    .notNull()
    .default(true),
  kioskWelcomeTemplate: text("kiosk_welcome_template")
    .notNull()
    .default("Welcome, {firstName}!"),
  kioskWelcomeMessages: jsonb("kiosk_welcome_messages")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  // Class Composer post-PM banner — per-school dismissal token. Stores
  // a "<schoolYear>|<window>" string (e.g. "25-26|pm3") that the admin
  // last dismissed. The Admin Hub banner re-appears automatically when
  // a NEW window arrives (dismissed token no longer matches current
  // readiness). NULL = never dismissed. The banner is informational
  // ("here are suggested groupings — no roster changes") so schools
  // that don't reshuffle mid-year can hide it without losing the
  // ability to run Class Composer manually from Insights.
  classComposerBannerDismissedSy: text("class_composer_banner_dismissed_sy"),
  // Skill-cluster refresh banner dismissal tokens. Append-only array
  // of "<schoolYear>|<pmWindow>|skillcluster_refresh" strings. Once
  // an admin dismisses (e.g.) the 25-26|pm2 banner, that exact token
  // joins the array and stops showing. A new PM window (pm3) creates
  // a fresh token and a fresh banner.
  skillclusterBannerDismissals: jsonb("skillcluster_banner_dismissals")
    .$type<string[]>()
    .notNull()
    .default([]),
  // iReady AP1 cut scores used by the Tier 3 Academic auto-suggest
  // engine. Per-grade, per-subject scale-score thresholds the MTSS
  // coordinator fills in: a student is suggested for a Tier 3 Academic
  // plan when their FAST PM1 places at Level 1 AND their iReady AP1
  // score is strictly below the cut for their grade + subject. Keyed by
  // stringified grade (e.g. "6", "7"). Empty maps = not configured (no
  // Tier 3 suggestions surface until a cut is entered for that grade).
  ireadyAp1Cuts: jsonb("iready_ap1_cuts")
    .$type<{ ela: Record<string, number>; math: Record<string, number> }>()
    .notNull()
    .default({ ela: {}, math: {} }),
  schoolWideExpectationLetters: jsonb("school_wide_expectation_letters")
    .$type<Array<{ letter: string; word: string }>>()
    .notNull()
    .default([
      { letter: "P", word: "Prepared" },
      { letter: "R", word: "Respectful" },
      { letter: "I", word: "Integrity" },
      { letter: "D", word: "Determined" },
      { letter: "E", word: "Engaged" },
    ]),
  // -----------------------------------------------------------------
  // On-Time Attendance / Tardy Incentive (classroom-door kiosk).
  //   onTimeAttendanceEnabled — master switch. When OFF the kiosk never
  //     auto-flips to Attendance mode (default OFF; opt-in per school).
  //   onTimeMaxPoints — point value for arriving in the first minute of
  //     passing; points = min(maxPoints, ceil(minutes until the bell)).
  //     Caps long (post-lunch) passing periods from over-rewarding.
  //   onTimeLotteryEnabled — daily "lucky class" bonus draw on/off.
  //   onTimeLotteryLabel — school-editable name shown in the reveal email
  //     so it mirrors the school's PBIS theme (e.g. "Paw Pride").
  //   onTimeLotteryBonusPoints — points awarded to every present student in
  //     the winning class.
  //   onTimeLotteryRevealLeadMinutes — minutes before end of day that the
  //     draw runs + admins are emailed. Picking this late keeps EVERY
  //     period (even last) eligible without leaking the winner early.
  // -----------------------------------------------------------------
  onTimeAttendanceEnabled: boolean("on_time_attendance_enabled")
    .notNull()
    .default(false),
  onTimeMaxPoints: integer("on_time_max_points").notNull().default(4),
  onTimeLotteryEnabled: boolean("on_time_lottery_enabled")
    .notNull()
    .default(false),
  onTimeLotteryLabel: text("on_time_lottery_label")
    .notNull()
    .default("On-Time Champions"),
  onTimeLotteryBonusPoints: integer("on_time_lottery_bonus_points")
    .notNull()
    .default(20),
  onTimeLotteryRevealLeadMinutes: integer("on_time_lottery_reveal_lead_minutes")
    .notNull()
    .default(30),
  // -----------------------------------------------------------------
  // On-Time Attendance TEST MODE (admin / Core Team only). Lets a
  // school demo the time-gated feature without waiting for a real
  // passing period or the afternoon lottery reveal. Two independent
  // tools, both off by default and never used in normal operation:
  //
  //   onTimeTestLoopEnabled — when true, an activated kiosk ignores the
  //     bell schedule and instead runs a synthetic passing -> bell ->
  //     post-bell cycle on a short repeating timer, so you can watch the
  //     kiosk flip and scan students on demand.
  //
  //   onTimeSimClockMinutes / onTimeSimClockSetAt — "demo clock". A
  //     simulated wall-clock (minutes since local midnight) anchored at
  //     the moment it was set; it advances in real time from there
  //     (sim now = minutes + elapsed-since-setAt). When non-null the
  //     attendance window AND the lottery resolve against this fake
  //     time, so the REAL bell-schedule math can be exercised against
  //     any moment of the day. NULL = off (use the real clock).
  //
  // The test loop takes precedence over the demo clock when both are on.
  // -----------------------------------------------------------------
  onTimeTestLoopEnabled: boolean("on_time_test_loop_enabled")
    .notNull()
    .default(false),
  onTimeSimClockMinutes: integer("on_time_sim_clock_minutes"),
  onTimeSimClockSetAt: timestamp("on_time_sim_clock_set_at", {
    withTimezone: true,
  }),
  // -----------------------------------------------------------------
  // Gradebook GPA. When true, the Student Profile / Snapshot surface a
  // computed unweighted GPA (4.0 scale) from the imported gradebook
  // current grades. OFF by default — not every school grades on a GPA
  // scale, and exposing one where it's not used would be misleading.
  // Core Team / admin controlled (gated in the PUT handler).
  // -----------------------------------------------------------------
  gpaEnabled: boolean("gpa_enabled").notNull().default(false),
  // -----------------------------------------------------------------
  // Feature-checklist completion (two-tier, like the others above).
  // These modules shipped without licensing switches and were always-on;
  // both halves default TRUE so adding the switches changes nothing
  // until someone flips them.
  // -----------------------------------------------------------------
  featureDataChats: boolean("feature_data_chats").notNull().default(true),
  superFeatureDataChats: boolean("super_feature_data_chats")
    .notNull()
    .default(true),
  featurePickup: boolean("feature_pickup").notNull().default(true),
  superFeaturePickup: boolean("super_feature_pickup")
    .notNull()
    .default(true),
  featureTicketing: boolean("feature_ticketing").notNull().default(true),
  superFeatureTicketing: boolean("super_feature_ticketing")
    .notNull()
    .default(true),
  featureTours: boolean("feature_tours").notNull().default(true),
  superFeatureTours: boolean("super_feature_tours").notNull().default(true),
  featureEsign: boolean("feature_esign").notNull().default(true),
  superFeatureEsign: boolean("super_feature_esign").notNull().default(true),
  featureBrainLab: boolean("feature_brain_lab").notNull().default(true),
  superFeatureBrainLab: boolean("super_feature_brain_lab")
    .notNull()
    .default(true),
  featureGradebook: boolean("feature_gradebook").notNull().default(true),
  superFeatureGradebook: boolean("super_feature_gradebook")
    .notNull()
    .default(true),
  featureSchoolGrade: boolean("feature_school_grade").notNull().default(true),
  superFeatureSchoolGrade: boolean("super_feature_school_grade")
    .notNull()
    .default(true),
  featureSafetyPlans: boolean("feature_safety_plans").notNull().default(true),
  superFeatureSafetyPlans: boolean("super_feature_safety_plans")
    .notNull()
    .default(true),
  },
  (t) => ({
    schoolIdUnique: uniqueIndex("school_settings_school_id_unique").on(
      t.schoolId,
    ),
  }),
);

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
