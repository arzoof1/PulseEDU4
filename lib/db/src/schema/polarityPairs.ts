import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Polarity pairs: two students who must NOT both be out on a hall pass at
// the same time (e.g. dating, recently in a fight). Stored normalized so
// that studentIdA <= studentIdB lexicographically; the unique index then
// prevents duplicate pairs regardless of input order.
export const polarityPairsTable = pgTable(
  "polarity_pairs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentIdA: text("student_id_a").notNull(),
    studentIdB: text("student_id_b").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByStaffId: integer("created_by_staff_id"),
  },
  (t) => ({
    // Per-school uniqueness: school A and school B must each be able to
    // hold the same paired student-id pair without colliding. The old
    // global unique index `polarity_pairs_pair_unique` was dropped in
    // April 2026 as part of the post-D5 tenant audit.
    schoolPairUnique: uniqueIndex("polarity_pairs_school_pair_unique").on(
      t.schoolId,
      t.studentIdA,
      t.studentIdB,
    ),
  }),
);

export type PolarityPairRow = typeof polarityPairsTable.$inferSelect;
