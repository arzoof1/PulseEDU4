import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ACADEMIC EVIDENCE — the "Partnering with Parents" staff collection surface and
// its family-facing "Learning at Home" mirror. This is the ACADEMIC sibling of
// the PulseBrainLab delivery workflow: instead of a Behavior-Specialist building
// an intervention group, a classroom TEACHER captures a student's formative-
// assessment work sample for one of their OWN class sections and shares it with
// that student's family.
//
// All rows are SCHOOL-SCOPED tenant data. The class section is the read-only
// Skyward roster (class_sections + section_roster) — teachers SELECT students
// from their current periods, they never manually add a roster. studentId is the
// canonical students.student_id (the FLEID, a text FK) which is NEVER rendered;
// surfaces JOIN to students.local_sis_id for the human-visible id.

// A captured student work sample (photo/scan/upload of a completed formative
// assessment) attached to exactly one (school, section, student, subject).
// objectKey is the /objects/... storage path (school-bound via
// bindObjectToSchool). `shared` is a staff annotation; family visibility is
// gated solely by `publishedAt` (null = draft, staff-only) — mirroring the
// PulseBrainLab publish lifecycle. assignmentTitle groups several students'
// samples under one named formative assessment; note is an optional caption to
// the family.
export const academicWorkSamplesTable = pgTable(
  "academic_work_samples",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // class_sections.id — the teacher's class period (read-only Skyward roster).
    sectionId: integer("section_id").notNull(),
    studentId: text("student_id").notNull(),
    // 'ela' | 'math' — the FAST subject this artifact relates to.
    subject: text("subject").notNull(),
    assignmentTitle: text("assignment_title").notNull(),
    note: text("note"),
    objectKey: text("object_key").notNull(),
    // 'phone' (live in-browser capture) | 'upload' (file picker).
    source: text("source").notNull(),
    shared: boolean("shared").notNull().default(false),
    // Explicit publish-to-family gate. null = draft (staff-only); a timestamp =
    // visible to the family on the "Learning at Home" surface. Section roster
    // membership stays the OUTER gate (parent only sees their own student).
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdByStaffId: integer("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    schoolIdx: index("academic_work_samples_school_idx").on(t.schoolId),
    sectionIdx: index("academic_work_samples_section_idx").on(
      t.schoolId,
      t.sectionId,
    ),
    studentIdx: index("academic_work_samples_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
    sectionSubjectIdx: index("academic_work_samples_section_subject_idx").on(
      t.schoolId,
      t.sectionId,
      t.subject,
    ),
  }),
);

export type AcademicWorkSampleRow =
  typeof academicWorkSamplesTable.$inferSelect;
