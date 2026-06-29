import {
  pgTable,
  serial,
  text,
  integer,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { locationsTable } from "./locations";
import { staffTable } from "./staff";

export const teacherDestinationAllowlistTable = pgTable(
  "teacher_destination_allowlist",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Canonical, SIS-safe key. New writes always set this (resolved from the
    // teacher's email or display name). Reads PREFER it so a roster rename
    // never orphans a teacher's allowlist. Nullable only for legacy rows that
    // pre-date the migration and whose name was ambiguous at backfill time.
    staffId: integer("staff_id").references(() => staffTable.id, {
      onDelete: "cascade",
    }),
    // Legacy / readability key. Kept in sync with the matched staff's current
    // displayName on every write; still used as a fallback when staffId is null.
    staffName: text("staff_name").notNull(),
    destinationLocationId: integer("destination_location_id")
      .notNull()
      .references(() => locationsTable.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique().on(t.staffName, t.destinationLocationId),
    // PARTIAL unique index: one row per (school, staff, destination) once the
    // canonical staffId is set. Legacy null-staffId rows are excluded.
    uniqueIndex("tda_school_staffid_dest_unique")
      .on(t.schoolId, t.staffId, t.destinationLocationId)
      .where(sql`${t.staffId} IS NOT NULL`),
  ],
);

export type TeacherDestinationAllowlistRow =
  typeof teacherDestinationAllowlistTable.$inferSelect;
