import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  boolean,
} from "drizzle-orm/pg-core";

// student_mtss_plans — MTSS intervention plans owned by the MTSS
// coordinator and the wider "core team" (admin, Behavior Specialist,
// MTSS Coordinator, PBIS Coordinator, SuperUser).
//
// v1 stores only the plan definition: a title, free-text goals, a tier
// (1/2/3, default 2), and a point-range pair the team intends to track.
// The actual per-staff tracking against pointRange will be added in v2.
//
// Status is implicit: `closedAt IS NULL` → active. Closing a plan stamps
// closedAt + closedBy*; reopening clears them.
//
// The Invisible Student Finder reads this table to identify Tier 2
// students (any active plan with tier >= 2) so it can apply the shorter
// "no positive log in N school days" window to them.
export const studentMtssPlansTable = pgTable(
  "student_mtss_plans",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Matches students.student_id (text). FK not declared — convention in
    // this codebase is JS-side join + AND-school filter (see schoolStore /
    // pbisEntries patterns). Multi-tenancy: a (studentId, schoolId) pair
    // is what's actually unique, not studentId alone.
    studentId: text("student_id").notNull(),
    title: text("title").notNull(),
    goals: text("goals").notNull().default(""),
    tier: integer("tier").notNull().default(2),
    pointRangeMin: integer("point_range_min"),
    pointRangeMax: integer("point_range_max"),
    notes: text("notes").notNull().default(""),
    // Tier 2 sub-type for the daily form: 'cico' | 'group' | NULL.
    // NULL means the plan hasn't picked a sub-type yet (allowed for
    // Tier 1/3 plans). Teachers see this as locked; Core Team can edit.
    interventionSubType: text("intervention_sub_type"),
    // CSV of staff IDs — LEGACY. Used only when
    // `autoAssignScheduleTeachers` is FALSE (manual-pick mode). When
    // auto is TRUE, this field is preserved as a historical record but
    // is NOT authoritative; the effective list is computed from the
    // student's live class schedule. Stored CSV (e.g. "12,47,138") to
    // match how other roster columns are stored in this codebase.
    assignedTeacherIds: text("assigned_teacher_ids").notNull().default(""),
    // When TRUE (default), the plan automatically tracks every teacher
    // currently on the student's class schedule (excluding planning
    // periods). Mid-year roster changes flow through automatically.
    // Past teachers' previously-logged entries are NOT deleted — they
    // remain visible in reports because intervention rows are immutable
    // and joined on (studentId, teacherStaffId), not on this list.
    autoAssignScheduleTeachers: boolean("auto_assign_schedule_teachers")
      .notNull()
      .default(true),
    // CSV of staff IDs explicitly excluded from the auto-assigned
    // schedule list (e.g. "include all 7 teachers EXCEPT the PE
    // teacher"). Only consulted when `autoAssignScheduleTeachers` is
    // TRUE. Empty string = no exclusions.
    excludedTeacherIds: text("excluded_teacher_ids").notNull().default(""),
    // CSV of staff IDs added on TOP of the schedule teachers — used for
    // non-classroom interventionists (counselor, behavior specialist,
    // school psych, social worker, trusted adult). Always included in
    // the effective list regardless of the auto toggle.
    additionalInterventionistIds: text("additional_interventionist_ids")
      .notNull()
      .default(""),
    // When true (default), the Tier 3 weekly form includes the
    // school-wide expectations row (PRIDE / equivalent) on a 0..2 scale
    // per day. Core Team can toggle off per plan.
    trackSchoolWideExpectations: boolean("track_school_wide_expectations")
      .notNull()
      .default(true),
    // Tier 3 plans declare how many goal slots are in use (1..5). The
    // weekly form renders only this many score rows. Defaults to 2 to
    // match the most common form layout in the wild.
    tier3GoalSlots: integer("tier3_goal_slots").notNull().default(2),
    // FAST Phase 3 read-path / Phase 5 write-path. Nullable Florida
    // benchmark code (e.g. "ELA.6.R.1.1") this plan targets. The
    // student-profile Benchmarks panel lights a small "MTSS" pill on
    // any benchmark row whose code matches an active plan for the
    // student. Phase 5 will surface a writer in the plan editor;
    // until then the column stays NULL on every row.
    fastBenchmarkCode: text("fast_benchmark_code"),
    // Subject-level academic MTSS plans (ELA / Math) created from the
    // condensed FAST scale-score suggestions. "ela" | "math" | NULL.
    // NULL on behavior plans and on legacy benchmark-level academic
    // plans (those carry only fastBenchmarkCode). Used to exclude a
    // student from re-suggestion once they're on an active academic
    // plan for that subject.
    fastSubject: text("fast_subject"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    openedByStaffId: integer("opened_by_staff_id"),
    openedByName: text("opened_by_name"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByStaffId: integer("closed_by_staff_id"),
    closedByName: text("closed_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    schoolIdx: index("student_mtss_plans_school_idx").on(t.schoolId),
    studentIdx: index("student_mtss_plans_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);

export type StudentMtssPlanRow = typeof studentMtssPlansTable.$inferSelect;
