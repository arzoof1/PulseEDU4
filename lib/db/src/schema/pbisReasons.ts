import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const pbisReasonsTable = pgTable(
  "pbis_reasons",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    name: text("name").notNull(),
    category: text("category").notNull().default("General"),
    defaultPoints: integer("default_points").notNull().default(1),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    nameUnique: uniqueIndex("pbis_reasons_name_unique").on(t.name),
  }),
);

export type PbisReasonRow = typeof pbisReasonsTable.$inferSelect;
