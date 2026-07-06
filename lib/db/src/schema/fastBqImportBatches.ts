import {
  pgTable,
  serial,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Rollback ledger for the BQ / Lower-25 (L25) full-replace importer.
//
// The BQ importer is FULL-REPLACE: committing a file clears prior_year_bq
// for every current-year student_fast_scores row in scope (school, current
// school year, subjects present in the file), then sets it TRUE for the
// students the file lists. Because clearing loses the prior state, a plain
// import_job_id delete can't restore it — so on commit we snapshot the set
// of (student, subject) that WERE bottom-quartile before, keyed by subject.
// Rollback reads this snapshot, re-clears the scope, and restores the flag.
//
// One row per committed bq_l25 job. Mirrors the studentImportSnapshots /
// teacher-allowlist rollback-ledger pattern. Created at boot via a
// CREATE TABLE IF NOT EXISTS in seed.ts (drizzle-kit push can't apply this
// non-interactively — see the HOUSES note in seed.ts).
// ---------------------------------------------------------------------------
export const fastBqImportBatchesTable = pgTable(
  "fast_bq_import_batches",
  {
    id: serial("id").primaryKey(),
    importJobId: integer("import_job_id").notNull(),
    schoolId: integer("school_id").notNull(),
    // { schoolYear: "25-26", prior: { ela: ["1023", ...], math: [...] } }
    // `prior` holds only the students that were bottom-quartile before this
    // job ran, grouped by subject. Subjects present == the file's scope.
    priorJson: jsonb("prior_json")
      .$type<{ schoolYear: string; prior: Record<string, string[]> }>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    jobIdx: index("fast_bq_import_batches_job_idx").on(t.importJobId),
    schoolIdx: index("fast_bq_import_batches_school_idx").on(t.schoolId),
  }),
);
