import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const bellSchedulesTable = pgTable("bell_schedules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("regular"),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  },
  (t) => ({
    schedulePeriodIdx: uniqueIndex("bell_schedule_periods_schedule_period_idx").on(
      t.scheduleId,
      t.periodNumber,
    ),
  }),
);

export type BellSchedulePeriodRow = typeof bellSchedulePeriodsTable.$inferSelect;
