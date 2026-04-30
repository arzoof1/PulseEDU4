import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-school list of strategy *categories* used on the Tier 3 weekly
// "Interventions Used This Week" checklist. Seeded with three categories
// out of the box for new schools (Preventative Procedures, Replacement
// Behavior Procedures, Procedures to Reinforce Replacement Behavior),
// but Core Team can add / rename / reorder / soft-delete entries.
export const tier3StrategyCategoriesTable = pgTable(
  "tier3_strategy_categories",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    schoolNameUnique: uniqueIndex(
      "tier3_strategy_categories_school_id_name_unique",
    ).on(t.schoolId, t.name),
  }),
);

export type Tier3StrategyCategoryRow =
  typeof tier3StrategyCategoriesTable.$inferSelect;
