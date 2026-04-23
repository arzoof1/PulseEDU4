import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Per-student daily hall-pass cap. Typically created at parental request /
// approval and managed by behavior specialists. At most one ACTIVE row per
// student is enforced via a partial unique index where active=true; multiple
// soft-deactivated rows (active=false) are allowed for history.
export const studentHallPassLimitsTable = pgTable(
  "student_hall_pass_limits",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    dailyLimit: integer("daily_limit").notNull(),
    note: text("note"),
    parentApproved: boolean("parent_approved").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // D5: per-school active uniqueness — both schools can independently
    // hold one active row for the same student id.
    studentIdx: uniqueIndex("student_hall_pass_limits_student_active")
      .on(t.studentId, t.schoolId)
      .where(sql`${t.active} = true`),
  }),
);

export type StudentHallPassLimitRow =
  typeof studentHallPassLimitsTable.$inferSelect;
