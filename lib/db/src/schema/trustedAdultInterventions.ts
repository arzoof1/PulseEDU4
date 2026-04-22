import { pgTable, serial, text, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const trustedAdultInterventionsTable = pgTable(
  "trusted_adult_interventions",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull().default("Trusted Adult"),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    nameUnique: uniqueIndex("trusted_adult_interventions_name_unique").on(t.name),
  }),
);

export type TrustedAdultInterventionRow =
  typeof trustedAdultInterventionsTable.$inferSelect;
