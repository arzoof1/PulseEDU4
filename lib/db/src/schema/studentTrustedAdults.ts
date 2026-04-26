import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// student_trusted_adults — explicit per-student → per-staff "trusted
// adult" relationships, assignable by the core team (MTSS Coordinator,
// Behavior Specialist, Admin, SuperUser).
//
// Used by the Insights module to widen a teacher's visibility scope:
// a teacher sees a student's profile if the student is on their roster
// OR if there is a row here linking that student to that staff member.
//
// Conventions match the rest of this codebase: studentId is text (not a
// FK to students.id), schoolId is duplicated for multi-tenancy, and the
// JOIN is done JS-side with an AND-school filter.
export const studentTrustedAdultsTable = pgTable(
  "student_trusted_adults",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    staffId: integer("staff_id").notNull(),
    assignedByStaffId: integer("assigned_by_staff_id"),
    assignedByName: text("assigned_by_name"),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text("notes"),
  },
  (t) => ({
    // Idempotent assignment: a given student/staff pair at a school can
    // only exist once. POST handler upgrades to a 200-with-existing-row
    // on collision instead of a hard 409.
    studentStaffUnique: uniqueIndex("student_trusted_adults_unique").on(
      t.schoolId,
      t.studentId,
      t.staffId,
    ),
    // Fast lookup for the visibility-scope filter: "all students linked
    // to this teacher at this school".
    staffIdx: index("student_trusted_adults_staff_idx").on(
      t.schoolId,
      t.staffId,
    ),
    // Fast lookup for the per-student profile view: "all trusted adults
    // for this student".
    studentIdx: index("student_trusted_adults_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);

export type StudentTrustedAdultRow =
  typeof studentTrustedAdultsTable.$inferSelect;
