import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const interventionTypesTable = pgTable(
  "intervention_types",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    name: text("name").notNull(),
    category: text("category").notNull().default("Classroom"),
    requiresNote: boolean("requires_note").notNull().default(false),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    // Per-school uniqueness — each school maintains its own intervention list.
    schoolNameUnique: uniqueIndex(
      "intervention_types_school_id_name_unique",
    ).on(t.schoolId, t.name),
  }),
);

export type InterventionTypeRow = typeof interventionTypesTable.$inferSelect;
