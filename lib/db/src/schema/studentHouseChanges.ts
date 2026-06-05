import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// student_house_changes — append-only audit row written every time a
// student's house_id moves. Covers single-student admin changes (via
// PATCH /api/students/:id/house) and bulk sort commits (one row per
// student whose house_id actually changed). Reason text is required at
// the API layer so admins must justify the move; NULLABLE here only so
// older rows (none today, but defensive) can survive a future schema
// tweak without a backfill. fromHouseId is nullable for the
// "previously unassigned" case. toHouseId is ALSO nullable so an
// admin clearing a student back to "unassigned" (via the Change
// House modal) still leaves an audit row — the move is auditable
// regardless of direction.
export const studentHouseChangesTable = pgTable(
  "student_house_changes",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentDbId: integer("student_db_id").notNull(),
    fromHouseId: integer("from_house_id"),
    toHouseId: integer("to_house_id"),
    reason: text("reason").notNull(),
    changedByStaffId: integer("changed_by_staff_id").notNull(),
    // Source of the change — "manual" (Change House modal), "bulk_sort"
    // (Sort Students into Houses commit), "undo" (Undo Last Sort).
    source: text("source").notNull().default("manual"),
    // When non-null, ties this row back to the bulk job that produced
    // it. Lets the audit feed group an entire sort under one heading.
    sortJobId: integer("sort_job_id"),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("student_house_changes_by_school").on(
      t.schoolId,
      t.changedAt,
    ),
    byStudent: index("student_house_changes_by_student").on(t.studentDbId),
  }),
);

export type StudentHouseChangeRow =
  typeof studentHouseChangesTable.$inferSelect;
