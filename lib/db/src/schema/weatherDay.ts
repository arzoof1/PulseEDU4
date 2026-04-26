import {
  pgTable,
  serial,
  integer,
  timestamp,
  uniqueIndex,
  date,
  doublePrecision,
  text,
} from "drizzle-orm/pg-core";

export const weatherDayTable = pgTable(
  "weather_day",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    day: date("day").notNull(),
    tempHighF: doublePrecision("temp_high_f"),
    tempLowF: doublePrecision("temp_low_f"),
    precipInches: doublePrecision("precip_inches"),
    weatherCode: integer("weather_code"),
    summary: text("summary"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolDayIdx: uniqueIndex("weather_day_school_day_idx").on(
      t.schoolId,
      t.day,
    ),
  }),
);

export type WeatherDayRow = typeof weatherDayTable.$inferSelect;
