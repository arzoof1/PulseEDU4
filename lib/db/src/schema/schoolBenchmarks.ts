import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// school_benchmarks — per-school catalog of standards (benchmark codes)
// the school instructs against. Decouples the dropdown / instructional
// coverage UI from FAST: works for ELA + Math today (auto-seeded from
// student_fast_item_responses), and Science / Social Studies tomorrow
// (CSV-imported by admins from the state standards lists).
//
// Source flag lets us treat "fast"-derived entries as authoritative on
// re-import while leaving "local" / "csv" entries untouched.
export const schoolBenchmarksTable = pgTable(
  "school_benchmarks",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // "ela" | "math" | "writing" | "science" | "social_studies"
    // Stored as TEXT so adding subjects is code-only.
    subject: text("subject").notNull(),
    // Florida benchmark code (e.g. "ELA.6.R.1.1") or any standards-body
    // code admins enter. Unique per (school, subject, code).
    code: text("code").notNull(),
    // Optional grouping label (e.g. "Reading Prose and Poetry").
    category: text("category"),
    // Optional human-readable label so teachers don't have to memorize
    // codes. Populated from CSV or admin edit; FAST-derived rows leave
    // it null and the UI falls back to the code.
    label: text("label"),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    // "fast" | "csv" | "local" — provenance.
    source: text("source").notNull().default("local"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolSubjectIdx: index("school_benchmarks_school_subject_idx").on(
      t.schoolId,
      t.subject,
    ),
    uniq: uniqueIndex("school_benchmarks_school_subject_code_unique").on(
      t.schoolId,
      t.subject,
      t.code,
    ),
  }),
);

export type SchoolBenchmarkRow = typeof schoolBenchmarksTable.$inferSelect;
