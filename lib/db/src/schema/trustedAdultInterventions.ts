import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const trustedAdultInterventionsTable = pgTable(
  "trusted_adult_interventions",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default("Trusted Adult"),
    // Tier-tagging for the new Tier 2 / Tier 3 intervention system.
    // '2' = available on the Tier 2 daily form's Trusted Adult picker;
    // '3' = available on the Tier 3 weekly form (future); NULL = legacy
    // / available everywhere. Stored as text to leave room for "1" or
    // multi-tag schemes later without an enum migration.
    tier: text("tier"),
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
