import {
  pgTable,
  serial,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// student_house_sort_jobs — one row per "Commit sort" press. Holds the
// before-snapshot for every student whose house_id was changed, so a
// 24-hour "Undo last sort" can flip them back atomically. We do NOT
// snapshot students whose house_id was already on the target — those
// rows weren't touched.
//
// snapshot shape: Array<{ studentDbId: number; fromHouseId: number | null }>.
// undoneAt becomes non-null once the matching undo runs, so the UI can
// hide the button (and we can't undo twice).
export const studentHouseSortJobsTable = pgTable(
  "student_house_sort_jobs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    committedByStaffId: integer("committed_by_staff_id").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Flags used at commit time, captured so the audit tab can show
    // "Sort (re-sort + keep siblings)" instead of a bare timestamp.
    includeAssigned: integer("include_assigned").notNull().default(0),
    keepSiblings: integer("keep_siblings").notNull().default(0),
    affectedCount: integer("affected_count").notNull().default(0),
    snapshot: jsonb("snapshot")
      .$type<Array<{ studentDbId: number; fromHouseId: number | null }>>()
      .notNull()
      .default([]),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneByStaffId: integer("undone_by_staff_id"),
  },
  (t) => ({
    bySchool: index("student_house_sort_jobs_by_school").on(
      t.schoolId,
      t.committedAt,
    ),
  }),
);

export type StudentHouseSortJobRow =
  typeof studentHouseSortJobsTable.$inferSelect;
