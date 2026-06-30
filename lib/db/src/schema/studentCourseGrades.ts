import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// student_course_grades — one row per (student, course section) per upload.
// Holds the per-quarter numeric grades (0-100) from a school's gradebook /
// "Live Grade Report" export. Source format is one row per student×course
// carrying ALL four quarters (Q1-Q4) plus a final (FIN) at once.
//
// This is a SEPARATE store from FAST/iReady — it is the school's own
// gradebook, not state assessment data. The current grade for a class is the
// selected upload quarter's value, falling back to the latest populated
// quarter when that cell is blank.
//
// Scope: school-scoped (school_id on every row). studentId matches
// students.student_id (text FLEID, NOT globally unique) — always pair with
// school_id in queries. Matched at import time by Other ID -> local_sis_id.
//
// Rollback: every row carries `import_job_id` so a rollback DELETEs by job.
// Each upload is a FULL REPLACE of the school's rows (delete-then-insert in
// one transaction), so at most one job's rows exist for a school at a time.
export const studentCourseGradesTable = pgTable(
  "student_course_grades",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Matches students.student_id (text, not globally unique). JS-side join
    // + AND-school, same convention as student_fast_scores.
    studentId: text("student_id").notNull(),
    // Grade level from the export's "Grade" column (e.g. "06"). Display only.
    gradeLevel: text("grade_level"),
    // Course identity from the export.
    courseCode: text("course_code").notNull(),
    section: text("section"),
    courseDesc: text("course_desc"),
    teacherName: text("teacher_name"),
    length: text("length"), // e.g. "YRM" (year), term length code
    startTerm: text("start_term"),
    stopTerm: text("stop_term"),
    // Per-quarter numeric grades, 0-100. Null when the cell is blank.
    q1: integer("q1"),
    q2: integer("q2"),
    q3: integer("q3"),
    q4: integer("q4"),
    fin: integer("fin"),
    // The quarter the uploader designated as "current" for this batch
    // ("Q1" | "Q2" | "Q3" | "Q4"). Drives current-grade selection.
    effectiveQuarter: text("effective_quarter").notNull(),
    // Admin-chosen effective date for the batch (YYYY-MM-DD, school-local).
    effectiveDate: text("effective_date").notNull(),
    // Import job that wrote this row; rollback deletes by this id.
    importJobId: integer("import_job_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolStudentIdx: index("student_course_grades_school_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
    schoolIdx: index("student_course_grades_school_idx").on(t.schoolId),
    importJobIdx: index("student_course_grades_import_job_idx").on(
      t.importJobId,
    ),
  }),
);

export type StudentCourseGradeRow =
  typeof studentCourseGradesTable.$inferSelect;
