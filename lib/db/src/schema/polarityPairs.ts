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
    studentIdA: text("student_id_a").notNull(),
    studentIdB: text("student_id_b").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByStaffId: integer("created_by_staff_id"),
  },
  (t) => ({
    pairUnique: uniqueIndex("polarity_pairs_pair_unique").on(
      t.studentIdA,
      t.studentIdB,
    ),
  }),
);

export type PolarityPairRow = typeof polarityPairsTable.$inferSelect;
