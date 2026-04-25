import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Assessments — the first dataset that the Insights / Academics dashboard
// will read from. One row per (student, assessment, administered_at).
// ---------------------------------------------------------------------------
//
// Why text for studentId rather than an integer FK to students.id?
//   The CSV will arrive with the SIS student number (matches
//   students.student_id, the text business key). Joining on the business
//   key keeps the importer dumb and lets us land rows for students who
//   might not yet exist in the roster (those land with `unmatched=true`
//   and surface in the History → Errors tab so an admin can fix the
//   roster and re-run).
//
// Why importJobId NOT NULL?
//   So rollback is a clean `DELETE WHERE import_job_id = X`. Rows added
//   manually (UI, not CSV) would create a synthetic job row first.
export const assessmentsTable = pgTable("assessments", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  // Business key from the SIS (matches students.student_id). Kept as text
  // so importers don't need a roster lookup before insert.
  studentId: text("student_id").notNull(),
  // Free-form name as it appeared on the CSV ("FAST PM2 Reading", "iReady
  // Math BOY", etc.). Normalization happens in the dashboard layer.
  assessmentName: text("assessment_name").notNull(),
  // Numeric score. Nullable because some assessments report a level only.
  score: doublePrecision("score"),
  // Optional human-readable level / band ("Level 3", "On Track", etc.).
  scoreLevel: text("score_level"),
  // When the assessment was given (per CSV). Falls back to upload time if
  // the CSV omitted it; the importer warns in the error log when it does.
  administeredAt: timestamp("administered_at", { withTimezone: true })
    .notNull(),
  // Vendor/source string ("FAST", "iReady", "MAP", etc.) for filtering.
  source: text("source"),
  importJobId: integer("import_job_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AssessmentRow = typeof assessmentsTable.$inferSelect;
