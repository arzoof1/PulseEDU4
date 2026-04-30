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
    // CSV of staff IDs of every teacher on the student's schedule who
    // is responsible for completing the daily/weekly intervention log.
    // Stored CSV (e.g. "12,47,138") to match how other roster columns
    // are stored in this codebase. Empty string = no one assigned yet.
    assignedTeacherIds: text("assigned_teacher_ids").notNull().default(""),
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
