import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Tier 3 strategy usage. One row per (weekly_record, strategy, day) when
// a strategy was checked off as used. Days store the abbreviated weekday
// ('mon'..'fri') matching the score column naming on tier3_weekly_records.
//
// Storing only USED rows keeps the table sparse — absent rows mean "not
// used that day." This makes the strategy-frequency report a simple
// COUNT(*) GROUP BY strategy.
export const tier3StrategyUsageTable = pgTable(
  "tier3_strategy_usage",
  {
    id: serial("id").primaryKey(),
    weeklyRecordId: integer("weekly_record_id").notNull(),
    strategyId: integer("strategy_id").notNull(),
    day: text("day").notNull(), // 'mon' | 'tue' | 'wed' | 'thu' | 'fri'
    used: boolean("used").notNull().default(true),
  },
  (t) => ({
    recordStrategyDayUnique: uniqueIndex(
      "tier3_strategy_usage_record_strategy_day_unique",
    ).on(t.weeklyRecordId, t.strategyId, t.day),
  }),
);

export type Tier3StrategyUsageRow =
  typeof tier3StrategyUsageTable.$inferSelect;
