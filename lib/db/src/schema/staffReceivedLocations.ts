import { pgTable, serial, integer, uniqueIndex } from "drizzle-orm/pg-core";

// Staff -> location coverage for one-way hall passes.
//
// A pass to destination D is visible on a staff member's "Heading to me"
// list when either: (a) the staff member's defaultRoom matches D (teachers
// auto-cover their own room — no row needed here), OR (b) an admin has
// assigned them to cover D's location via a row in this table (used for
// non-classroom destinations like Guidance / Clinic / Office that several
// staff staff).
//
// Multi-tenancy: every read/write must filter by school_id. The composite
// unique index prevents duplicate (school, staff, location) assignments.
export const staffReceivedLocationsTable = pgTable(
  "staff_received_locations",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),
    locationId: integer("location_id").notNull(),
  },
  (t) => ({
    schoolStaffLocationUnique: uniqueIndex(
      "staff_received_locations_unique",
    ).on(t.schoolId, t.staffId, t.locationId),
  }),
);

export type StaffReceivedLocationRow =
  typeof staffReceivedLocationsTable.$inferSelect;
