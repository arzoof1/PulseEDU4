import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const bellSchedulesTable = pgTable(
  "bell_schedules",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("regular"),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // At most one default bell schedule per school (silo-scoped). Pre-silo,
    // there was a global `bell_schedules_one_default_idx` that allowed only
    // one default row in the entire DB; the silo migration replaces it with
    // this per-school partial unique index.
    schoolDefaultIdx: uniqueIndex("bell_schedules_school_default_idx")
      .on(t.schoolId)
      .where(sql`${t.isDefault} = true`),
  }),
);

export type BellScheduleRow = typeof bellSchedulesTable.$inferSelect;

export const bellSchedulePeriodsTable = pgTable(
  "bell_schedule_periods",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => bellSchedulesTable.id, { onDelete: "cascade" }),
    periodNumber: integer("period_number").notNull(),
    name: text("name").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    // Whether this period counts toward the parent-portal on-time
    // streak. Schools toggle off lunch / advisory / passing periods so
    // an "on-time streak" only counts academic periods. Defaults TRUE
    // so existing schedules keep working without re-editing.
    includedInOnTimeStreak: boolean("included_in_on_time_streak")
      .notNull()
      .default(true),
  },
  (t) => ({
    schedulePeriodIdx: uniqueIndex("bell_schedule_periods_schedule_period_idx").on(
      t.scheduleId,
      t.periodNumber,
    ),
  }),
);

export type BellSchedulePeriodRow = typeof bellSchedulePeriodsTable.$inferSelect;
