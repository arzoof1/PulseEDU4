import {
  pgTable,
  serial,
  text,
  integer,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-school no-school calendar. Maintained by Admin/PBIS/BS/MTSS/Dean
// at the start of the school year (and as needed). Used by:
//   - Add ISS / OSS Log modal: greys out closed days in the calendar
//   - ISS absence rollover: skips closed days when finding the next
//     available school day to roll an absent day to
export const schoolClosedDaysTable = pgTable(
  "school_closed_days",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    day: date("day").notNull(),
    label: text("label"),
    createdById: integer("created_by_id"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchoolDay: uniqueIndex("school_closed_days_school_day_uq").on(
      t.schoolId,
      t.day,
    ),
  }),
);

export type SchoolClosedDayRow = typeof schoolClosedDaysTable.$inferSelect;
