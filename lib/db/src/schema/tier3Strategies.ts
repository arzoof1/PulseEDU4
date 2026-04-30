import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-school strategy items inside a Tier 3 strategy category. These
// populate the rows of the "Interventions Used This Week" checklist.
//
// Soft-delete via `active=false` rather than hard delete so historic
// `tier3_strategy_usage` rows still resolve a name.
export const tier3StrategiesTable = pgTable(
  "tier3_strategies",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id").notNull(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    schoolCategoryNameUnique: uniqueIndex(
      "tier3_strategies_school_category_name_unique",
    ).on(t.schoolId, t.categoryId, t.name),
  }),
);

export type Tier3StrategyRow = typeof tier3StrategiesTable.$inferSelect;
