import { pgTable, serial, text, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const interventionTypesTable = pgTable(
  "intervention_types",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull().default("Classroom"),
    requiresNote: boolean("requires_note").notNull().default(false),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    nameUnique: uniqueIndex("intervention_types_name_unique").on(t.name),
  }),
);

export type InterventionTypeRow = typeof interventionTypesTable.$inferSelect;
