import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Data Imports — shared infrastructure for every CSV importer (assessments,
// rosters, attendance, behavior history, etc.). One row per upload attempt.
// ---------------------------------------------------------------------------
//
// Lifecycle:
//   pending  → preview  → committed  (happy path)
//                      ↘ rolled_back (admin pressed undo)
//   pending  → failed   (parse error, schema mismatch, etc.)
//
// The CSV file itself is stored in object storage at `objectPath`; this row
// just holds the metadata + outcome counters + per-row error log so the
// History tab can render a list without re-parsing.
//
// Scope:
//   - schoolId set + districtId null → single-school upload (SA flow)
//   - districtId set + schoolId null → district-wide upload, rows are
//     routed to schools by their `school_code` column at parse time (DA/SU)
//   - both set is invalid (validated at insert time)
//
// Rollback strategy: every importer's data table carries an `import_job_id`
// FK; rollback = `DELETE WHERE import_job_id = X` inside a transaction
// that also flips this row's status to `rolled_back`.
export const importJobsTable = pgTable("import_jobs", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id"),
  districtId: integer("district_id"),
  // Importer kind: "assessments" today; "roster", "attendance", etc. later.
  // Stored as text (not enum) so adding a new importer doesn't require a
  // migration — the route layer is the source of truth for what's valid.
  kind: text("kind").notNull(),
  // Source filename as the user uploaded it (display only).
  filename: text("filename").notNull(),
  // Object storage path for the raw CSV. Kept around for support / re-runs.
  objectPath: text("object_path"),
  // Staff id of the uploader. Not a hard FK so deleting a staff row never
  // blocks a historical import record from rendering.
  uploadedBy: integer("uploaded_by").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  status: text("status").notNull().default("pending"),
  totalRows: integer("total_rows").notNull().default(0),
  successRows: integer("success_rows").notNull().default(0),
  errorRows: integer("error_rows").notNull().default(0),
  // Per-row error log. Shape: Array<{ row: number, message: string,
  // raw?: Record<string, string> }>. Capped at ~500 entries by the route
  // layer so a pathological file can't blow up jsonb.
  errorLog: jsonb("error_log")
    .$type<Array<{ row: number; message: string; raw?: Record<string, string> }>>()
    .notNull()
    .default([]),
  // Resolved column mapping used for the commit (snapshot of whichever
  // template/manual mapping was chosen). Lets History show "we mapped
  // 'Reading SS' to assessment_name" without re-deriving it.
  mapping: jsonb("mapping")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
});

export type ImportJobRow = typeof importJobsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Saved column-mapping templates. A school admin uploads a CSV from the
// same vendor every quarter; once they've mapped "STUDENT_NUM → student_id"
// once, they save the mapping as a template and the next upload pre-fills.
// ---------------------------------------------------------------------------
export const importTemplatesTable = pgTable("import_templates", {
  id: serial("id").primaryKey(),
  // Templates are owned at the school OR district level. District-owned
  // templates are visible to every school in the district as read-only
  // suggestions; school-owned templates stay private.
  schoolId: integer("school_id"),
  districtId: integer("district_id"),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  // Mapping: { csvColumnName: targetField }. Targets are importer-specific.
  mapping: jsonb("mapping")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ImportTemplateRow = typeof importTemplatesTable.$inferSelect;
