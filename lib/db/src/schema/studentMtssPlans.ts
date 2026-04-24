import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
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
