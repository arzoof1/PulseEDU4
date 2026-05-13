import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// One row per (student, repeated grade). A kid retained twice (e.g. held
// back in 3rd AND in 5th) gets two rows. The unique index on
// (school_id, student_id, grade_level) guarantees a grade isn't
// double-recorded.
//
// `gradeLevel` stores the grade the student repeated (1..8 in seed data;
// the column itself accepts any int so a school could record K=0 or
// HS retention later).
//
// Multi-tenant: every read MUST filter by school_id (mirrors the rest
// of the per-student tables in this schema).
export const studentRetentionsTable = pgTable(
  "student_retentions",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    gradeLevel: integer("grade_level").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name"),
  },
  (t) => ({
    uniqStudentGrade: uniqueIndex("student_retentions_unique").on(
      t.schoolId,
      t.studentId,
      t.gradeLevel,
    ),
  }),
);

export type StudentRetentionRow = typeof studentRetentionsTable.$inferSelect;
