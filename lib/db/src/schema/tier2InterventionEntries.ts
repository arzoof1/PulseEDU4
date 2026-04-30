import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Tier 2 daily intervention log. One row per (student, teacher, day) —
// every teacher on the student's schedule who is responsible for the
// intervention must complete their own row each school day. Submissions
// from one teacher do NOT clear the obligation for the others.
//
// `subType` mirrors the assigned subType on the student's MTSS plan
// (CICO or Behavior Group). It's stored on the entry as well so a plan
// edit doesn't retroactively rewrite history.
//
// `trustedAdultInterventionId` is optional: if the school has tier-tagged
// Trusted Adult Interventions, the teacher can pin the specific TAI
// they used. The trusted-adult catalog filtering is enforced client-side.
export const tier2InterventionEntriesTable = pgTable(
  "tier2_intervention_entries",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // students.student_id is text — matches the rest of the codebase.
    studentId: text("student_id").notNull(),
    teacherStaffId: integer("teacher_staff_id").notNull(),
    // School-local date; we store as text "YYYY-MM-DD" to dodge timezone
    // surprises (matches how we handle bell-schedule dates elsewhere).
    entryDate: text("entry_date").notNull(),
    // 'cico' | 'group'
    subType: text("sub_type").notNull(),
    trustedAdultInterventionId: integer("trusted_adult_intervention_id"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    schoolIdx: index("tier2_entries_school_idx").on(t.schoolId),
    studentDateIdx: index("tier2_entries_student_date_idx").on(
      t.schoolId,
      t.studentId,
      t.entryDate,
    ),
    teacherDateIdx: index("tier2_entries_teacher_date_idx").on(
      t.schoolId,
      t.teacherStaffId,
      t.entryDate,
    ),
  }),
);

export type Tier2InterventionEntryRow =
  typeof tier2InterventionEntriesTable.$inferSelect;
