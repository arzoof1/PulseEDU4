import {
  pgTable,
  serial,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// PBIS point-balance migrations — carried-over reward balances imported when a
// school converts to PulseEDU from another PBIS platform (LiveSchool, etc.).
// One row per (student, import job).
//
// These points feed the School Store points wallet (see computeEarned in
// lib/storeRedemptions.ts) so students keep their existing balance to spend —
// but, UNLIKE pbis_entries, they are deliberately EXCLUDED from house
// standings, leaderboards, and recognition counts. A school that instead wants
// migrated points to count as earned recognitions uses the importer's
// "count as earned" toggle, which writes straight into pbis_entries (stamped
// with import_job_id) rather than into this ledger.
//
// `studentId` is the canonical FLEID — an INTERNAL join key only, resolved from
// the uploaded local_sis_id at import time. It must never be rendered to a user.
// `importJobId` ties every row to its import_jobs row so a rollback is an exact
// `DELETE WHERE import_job_id = X` (idempotent re-import safety + undo).
export const pbisPointMigrationsTable = pgTable(
  "pbis_point_migrations",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // FLEID — internal foreign key, never displayed.
    studentId: text("student_id").notNull(),
    points: integer("points").notNull(),
    // Free-text label of the originating system (e.g. "LiveSchool").
    source: text("source").notNull().default("Imported balance"),
    // FK to import_jobs.id — drives idempotent rollback.
    importJobId: integer("import_job_id"),
    createdById: integer("created_by_id"),
    createdByName: text("created_by_name"),
    createdAt: text("created_at").notNull(),
    voidedAt: text("voided_at"),
  },
  (t) => ({
    // UNIQUE so the "store balance only" path can UPSERT one migration row per
    // (school, student): re-importing the same (or a corrected) balance file
    // sets the balance to the new value rather than stacking — i.e. the
    // migration is idempotent. The "count as earned" path writes pbis_entries
    // instead, so it never collides here.
    schoolStudentUnique: uniqueIndex(
      "pbis_point_migrations_school_student_unique",
    ).on(t.schoolId, t.studentId),
    importJobIdx: index("pbis_point_migrations_import_job_idx").on(
      t.importJobId,
    ),
  }),
);

export type PbisPointMigrationRow =
  typeof pbisPointMigrationsTable.$inferSelect;
