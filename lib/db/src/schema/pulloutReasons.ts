import { pgTable, serial, text, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const pulloutReasonsTable = pgTable(
  "pullout_reasons",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull().default("General"),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    nameUnique: uniqueIndex("pullout_reasons_name_unique").on(t.name),
  }),
);

export type PulloutReasonRow = typeof pulloutReasonsTable.$inferSelect;
