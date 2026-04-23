import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const pulloutReasonsTable = pgTable(
  "pullout_reasons",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default("General"),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    // Per-school uniqueness: each school owns its own reasons list, so the
    // same reason name can exist in two different schools without colliding.
    schoolNameUnique: uniqueIndex("pullout_reasons_school_id_name_unique").on(
      t.schoolId,
      t.name,
    ),
  }),
);

export type PulloutReasonRow = typeof pulloutReasonsTable.$inferSelect;
