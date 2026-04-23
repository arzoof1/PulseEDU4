import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const trustedAdultInterventionsTable = pgTable(
  "trusted_adult_interventions",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default("Trusted Adult"),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    // Per-school uniqueness.
    schoolNameUnique: uniqueIndex(
      "trusted_adult_interventions_school_id_name_unique",
    ).on(t.schoolId, t.name),
  }),
);

export type TrustedAdultInterventionRow =
  typeof trustedAdultInterventionsTable.$inferSelect;
