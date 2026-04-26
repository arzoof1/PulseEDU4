import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { districtsTable } from "./districts";

// A school is a tenant inside a district. All operational rows
// (students, hall passes, PBIS entries, etc.) get tagged with a
// school_id starting in Day 2.
export const schoolsTable = pgTable(
  "schools",
  {
    id: serial("id").primaryKey(),
    districtId: integer("district_id")
      .notNull()
      .references(() => districtsTable.id, { onDelete: "restrict" }),
    // Display name ("D. S. Parrott Middle School").
    name: text("name").notNull(),
    // Short label used in the school switcher and badge ("Parrott").
    shortName: text("short_name"),
    // State-issued school code ("0241" for Parrott, FL). Used for matching
    // OneRoster / Skyward sync later.
    stateSchoolCode: text("state_school_code"),
    // Whether this is the district's "primary" school — used as the default
    // for legacy data backfill and for new staff who don't pick one.
    isPrimary: boolean("is_primary").notNull().default(false),
    // Per-school IANA timezone, used for "today" date math and the daily
    // digest cron. Defaults to America/New_York for the first district
    // (Hernando County, FL).
    timezone: text("timezone").notNull().default("America/New_York"),
    // Geographic coordinates used for the daily weather lookup that
    // backs the Attendance dashboard's Weather card. Nullable because
    // SIS-imported schools won't have these set out of the gate;
    // weather is simply skipped for schools without coordinates.
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    districtCodeUnique: uniqueIndex("schools_district_state_code_unique").on(
      t.districtId,
      t.stateSchoolCode,
    ),
  }),
);

export type SchoolRow = typeof schoolsTable.$inferSelect;
