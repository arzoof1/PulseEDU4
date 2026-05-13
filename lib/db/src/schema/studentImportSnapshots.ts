import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// student_import_snapshots — per-row "before" snapshot used to rollback
// roster imports that touch existing students. Today only the roster
// importer writes here; the table is kind-agnostic in shape so future
// upsert importers (e.g. accommodations) can reuse it.
//
// Two modes captured by `wasInsert`:
//   - true  : the row was a brand-new student created by the job.
//             priorJson is empty {}; rollback deletes the student.
//   - false : the row was an UPDATE on an existing student. priorJson
//             holds the columns we touched, in their pre-import values.
//             Rollback restores those columns onto the live row.
//
// Snapshots are scoped by school for defense-in-depth and indexed by
// (import_job_id) since rollback always selects by job id.
export const studentImportSnapshotsTable = pgTable(
  "student_import_snapshots",
  {
    id: serial("id").primaryKey(),
    importJobId: integer("import_job_id").notNull(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    wasInsert: boolean("was_insert").notNull(),
    // Prior values for the columns the importer may have changed. Shape
    // is { firstName?, lastName?, grade?, parentName?, parentEmail?,
    // parentPhone?, gender?, ell?, ese?, is504? }. Only present for
    // wasInsert=false rows.
    priorJson: jsonb("prior_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    jobIdx: index("student_import_snapshots_job_idx").on(t.importJobId),
    schoolIdx: index("student_import_snapshots_school_idx").on(t.schoolId),
  }),
);

export type StudentImportSnapshotRow =
  typeof studentImportSnapshotsTable.$inferSelect;
