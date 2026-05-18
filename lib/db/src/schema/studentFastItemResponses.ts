import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// student_fast_item_responses — one row per per-benchmark response on a
// Florida FAST per-student xlsx export. The state file ships ~40
// repeating Category / Benchmark / Points Earned / Points Possible
// quadruplets per student per administration; we store them flat so the
// downstream heatmap, student-profile, and growth views can aggregate
// cheaply at read time.
//
// Composite read key: (school_id, student_id, subject, school_year).
// Composite write key: (school_id, student_id, subject, school_year,
// window, item_seq) — every import overwrites the prior PMx by the
// same job_id-style rule used by student_fast_scores: most recent
// import owns the rows, and rollback deletes by import_job_id.
//
// Multi-tenancy: every read MUST filter by school_id. Per project
// convention there is no FK to schools — the application layer joins
// in JS.
export const studentFastItemResponsesTable = pgTable(
  "student_fast_item_responses",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Matches students.student_id (text, not globally unique).
    studentId: text("student_id").notNull(),
    // Mirrors studentFastScores.subject ("ela" | "math" | "algebra1"
    // | "geometry" | "writing"). Stored as TEXT so adding subjects
    // (Phase 6 — writing/math expansion) is a code-only change.
    subject: text("subject").notNull(),
    // "YY-YY" label, e.g. "25-26". Matches schoolYearLabelFor() —
    // letting an admin tag a Florida xlsx file with any school year
    // is what makes prior-year backfill possible.
    schoolYear: text("school_year").notNull(),
    // "pm1" | "pm2" | "pm3" — derived from the file's Test Reason
    // column ("PM1 2025-26", etc.).
    window: text("window").notNull(),
    // Administration date from the file (one of the top-line columns).
    // Nullable because Florida sometimes leaves it blank for absent
    // students who still have an item layout but no scores.
    administeredAt: timestamp("administered_at", { withTimezone: true }),
    // Category label as printed by the state (e.g.
    // "Reading Prose and Poetry").
    category: text("category"),
    // Florida benchmark code (e.g. "ELA.6.R.1.1"). The "RP|" / "VC|"
    // strand prefix the state sometimes prepends is stripped at parse
    // time so consumers can group by the bare code.
    benchmarkCode: text("benchmark_code").notNull(),
    pointsEarned: integer("points_earned"),
    pointsPossible: integer("points_possible"),
    // 0-based ordinal of the item within the student's row. Used as
    // a tie-breaker in the composite key — Florida sometimes repeats
    // the same benchmark code on multiple items in a single PM.
    itemSeq: integer("item_seq").notNull(),
    // The import job that wrote this row. Rollback deletes by job id
    // (mirrors studentFastScores.importJobId).
    importJobId: integer("import_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("student_fast_item_responses_school_idx").on(t.schoolId),
    studentIdx: index(
      "student_fast_item_responses_student_idx",
    ).on(t.schoolId, t.studentId, t.subject, t.schoolYear),
    benchmarkIdx: index(
      "student_fast_item_responses_benchmark_idx",
    ).on(t.schoolId, t.benchmarkCode, t.schoolYear),
    importJobIdx: index(
      "student_fast_item_responses_job_idx",
    ).on(t.importJobId),
  }),
);

export type StudentFastItemResponseRow =
  typeof studentFastItemResponsesTable.$inferSelect;
