import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// student_fast_scores — one row per (student, subject). Holds the three
// progress-monitoring scores for the current year (PM1 fall, PM2 winter,
// PM3 spring), the prior-year final scale score, and a Bottom Quartile
// flag derived from the prior-year final.
//
// `subject` is "ela" | "math" | "algebra1" | "geometry". Stored as TEXT
// (no enum constraint) so adding new EOC subjects is a code-only change.
// Algebra 1 / Geometry rows use the EOC scale; chart lookup in
// fastCutScores.ts is by subject only for those (grade is ignored).
//
// v1 stores the raw scores only; the level/sub-level placement and the
// bucket-target gap are computed at read time using fastCutScores.ts.
//
// CSV import (Settings → FAST scores) will write to this table; for now
// it is populated by `seedFastScoresIfEmpty()` with plausible random
// values so the Teacher Roster page has something to render.
export const studentFastScoresTable = pgTable(
  "student_fast_scores",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Matches students.student_id (text, not globally unique). Same
    // convention as student_mtss_plans — JS-side join + AND-school.
    studentId: text("student_id").notNull(),
    subject: text("subject").notNull(), // "ela" | "math" | "algebra1" | "geometry"
    // "YY-YY" label, e.g. "25-26". Added in Phase 1 of the Florida
    // xlsx parser work so admins can backfill prior-year PM data
    // without colliding with current-year rows. The unique index
    // below extends to include school_year; existing rows are
    // backfilled to the current school year on first boot.
    schoolYear: text("school_year").notNull().default(""),
    pm1: integer("pm1"),
    pm2: integer("pm2"),
    pm3: integer("pm3"),
    // Last year's final FAST scale score for this subject. Used to
    // derive priorYearBq (Bottom Quartile) — the BQ pill on the roster.
    priorYearScore: integer("prior_year_score"),
    priorYearBq: boolean("prior_year_bq").notNull().default(false),
    // Last importer job that wrote this row (insert OR upsert). Tagged on
    // every commit so the History tab can offer a real "Undo" — rollback
    // deletes rows whose importJobId matches the job. NULL on legacy /
    // seeded / hand-edited rows so they survive any rollback.
    importJobId: integer("import_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    schoolIdx: index("student_fast_scores_school_idx").on(t.schoolId),
    // One row per (student, subject, school_year). CSV import upserts
    // on this key. The school_year column was added in Phase 1 of the
    // Florida xlsx parser work; the prior unique index (without
    // school_year) is dropped at boot in seed.ts and recreated with
    // the wider composite so prior-year backfill doesn't overwrite
    // current-year rows.
    studentSubjectYearUnique: uniqueIndex(
      "student_fast_scores_student_subject_year_unique",
    ).on(t.schoolId, t.studentId, t.subject, t.schoolYear),
  }),
);

export type StudentFastScoreRow =
  typeof studentFastScoresTable.$inferSelect;
