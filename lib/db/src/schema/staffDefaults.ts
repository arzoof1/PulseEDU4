import { pgTable, serial, text, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
export const staffDefaultsTable = pgTable(
  "staff_defaults",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").references(() => staffTable.id, {
      onDelete: "cascade",
    }),
    staffName: text("staff_name").notNull().unique(),
    defaultLocationName: text("default_location_name"),
  },
  (t) => [
    // PARTIAL unique index: one row per non-null staff_id. Legacy rows may
    // still have a null staff_id (name-keyed), so the predicate excludes
    // them. The room-upsert (PUT /staff-defaults) relies on this index for
    // its ON CONFLICT (staff_id) WHERE staff_id IS NOT NULL target.
    uniqueIndex("staff_defaults_staff_id_unique")
      .on(t.staffId)
      .where(sql`${t.staffId} IS NOT NULL`),
  ],
);

export type StaffDefaultRow = typeof staffDefaultsTable.$inferSelect;
