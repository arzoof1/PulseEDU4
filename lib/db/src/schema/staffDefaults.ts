import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";
import { staffTable } from "./staff";

// Per-staff default origin location (e.g. their classroom).
//
// Two keys are kept on this row for resilience:
//
//  * `staffId` (FK -> staff.id)  — canonical, SIS-safe key. Survives
//    display-name renames coming from any roster import.
//  * `staffName`                 — kept for legacy lookups + readability in
//    debug tools. New writes should always set `staffId`; we still upsert
//    using `staffName` until everything is migrated.
//
// Down the road a roster sync (see `lib/sis-adapters`) will write to this
// table keyed by `staffId`, sourcing the room from the SIS.
export const staffDefaultsTable = pgTable("staff_defaults", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").references(() => staffTable.id, {
    onDelete: "cascade",
  }),
  staffName: text("staff_name").notNull().unique(),
  defaultLocationName: text("default_location_name"),
});

export type StaffDefaultRow = typeof staffDefaultsTable.$inferSelect;
