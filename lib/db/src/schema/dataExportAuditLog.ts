import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// =============================================================================
// Data Export — audit log
// =============================================================================
// Append-only audit trail for the customizable Data Export feature. Every
// time a staff member DOWNLOADS a dataset (CSV / XLSX) we write one row here
// capturing who exported what, with which columns + filters, and how many
// rows left the building. Exports are a PII amplifier (they remove student
// data from the app's access controls), so this trail is what makes the
// feature defensible six months later when an auditor asks "who pulled the
// full roster on 2026-05-01?".
//
// Preview requests are NOT logged here — only actual file downloads. Actor
// columns are nullable only for forward-compatibility; the download routes
// always populate them. `filters` is loose-jsonb so new filter kinds can
// land without a migration.
// =============================================================================
export const dataExportAuditLogTable = pgTable(
  "data_export_audit_log",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Registry dataset key, e.g. 'students' | 'hall_passes' | 'interventions'.
    datasetKey: text("dataset_key").notNull(),
    // 'csv' | 'xlsx'.
    format: text("format").notNull().default("csv"),
    // Column ids that were included in the export, in output order.
    columns: jsonb("columns").$type<string[]>().notNull().default([]),
    // Applied filters snapshot (grade / teacherStaffId / studentId / dates).
    filters: jsonb("filters")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    rowCount: integer("row_count").notNull().default(0),
    actorStaffId: integer("actor_staff_id"),
    actorName: text("actor_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("data_export_audit_school_idx").on(
      t.schoolId,
      t.createdAt,
    ),
  }),
);

export type DataExportAuditRow = typeof dataExportAuditLogTable.$inferSelect;
