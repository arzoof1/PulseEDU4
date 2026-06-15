import {
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// benchmark_descriptions — GLOBAL reference catalog of the official
// FLDOE B.E.S.T. standards text, keyed by benchmark code. Unlike almost
// every other table in this app, this is DELIBERATELY NOT school-scoped:
// the standard wording for "ELA.7.R.1.1" is identical for every tenant
// (it is published state reference data, not tenant data), so it lives
// once and is read by all schools. Populated from a committed dataset
// parsed from the FLDOE standards PDF and upserted idempotently at boot.
//
// Lookup key is (subject, code). `code` is the bare Florida benchmark
// code (e.g. "ELA.7.R.1.1") — the "STRAND|" prefix the FAST item file
// sometimes prepends must be stripped by callers before matching.
export const benchmarkDescriptionsTable = pgTable(
  "benchmark_descriptions",
  {
    id: serial("id").primaryKey(),
    // "ela" | "math" | … (lowercase; matches student_fast_item_responses).
    subject: text("subject").notNull(),
    // Grade band as printed by the state: "K" | "1".."12" (and bands like
    // "612" for grades 6-12 foundational standards). Stored as TEXT.
    grade: text("grade").notNull(),
    // Strand letter group from the code (e.g. "R", "V", "C", "F" for ELA;
    // "AR", "NSO", "GR", "DP" for math). Convenience for grouping/filtering.
    strand: text("strand"),
    // Bare Florida benchmark code, e.g. "ELA.7.R.1.1".
    code: text("code").notNull(),
    // Full official benchmark statement (may include lettered sub-skills
    // for Foundational / Conventions standards).
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    subjectIdx: index("benchmark_descriptions_subject_idx").on(t.subject),
    uniq: uniqueIndex("benchmark_descriptions_subject_code_unique").on(
      t.subject,
      t.code,
    ),
  }),
);

export type BenchmarkDescriptionRow =
  typeof benchmarkDescriptionsTable.$inferSelect;
