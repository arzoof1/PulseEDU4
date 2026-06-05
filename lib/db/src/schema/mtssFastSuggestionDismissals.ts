import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// mtss_fast_suggestion_dismissals — per-school-year dismissal ledger
// for FAST Phase 5 Tier 2 auto-suggestions. When Core Team dismisses a
// suggested (student, benchmarkCode) pair on the MTSS hub, we insert a
// row keyed by school year so the suggestion stays hidden for the
// remainder of THAT year but returns next year if the pattern persists.
//
// Multi-tenancy: school_id is part of the unique key. studentId is text
// (matches students.student_id; not globally unique). benchmarkCode is
// the bare Florida code (e.g. "ELA.6.R.1.1") with the state strand
// prefix already stripped at import time.
export const mtssFastSuggestionDismissalsTable = pgTable(
  "mtss_fast_suggestion_dismissals",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    benchmarkCode: text("benchmark_code").notNull(),
    // "YY-YY" label (e.g. "25-26") so a dismissal expires automatically
    // when the next school year rolls over — same logic as
    // schoolYearLabelFor().
    schoolYear: text("school_year").notNull(),
    dismissedByStaffId: integer("dismissed_by_staff_id"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("mtss_fast_suggestion_dismissals_unique").on(
      t.schoolId,
      t.studentId,
      t.benchmarkCode,
      t.schoolYear,
    ),
    schoolIdx: index("mtss_fast_suggestion_dismissals_school_idx").on(
      t.schoolId,
      t.schoolYear,
    ),
  }),
);

export type MtssFastSuggestionDismissalRow =
  typeof mtssFastSuggestionDismissalsTable.$inferSelect;
