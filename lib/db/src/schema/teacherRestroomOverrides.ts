import { pgTable, serial, text, integer, unique } from "drizzle-orm/pg-core";
import { locationsTable } from "./locations";

// Per-teacher restroom availability override (Restroom Access Control).
// Distinct from `teacher_destination_allowlist`, which only governs the
// contact-acknowledgement FRICTION on a pass. THIS table is a hard
// availability override: when a teacher has one or more rows here, the
// Create Pass modal shows ONLY these restrooms for that teacher,
// regardless of the origin room's default restroom pairings. When a
// teacher has zero rows, they inherit the room default (the restroom-kind
// rows of `location_allowed_destinations` for the selected origin room).
// Only restroom-kind locations belong here; classrooms/offices are
// unaffected by Restroom Access Control.
export const teacherRestroomOverridesTable = pgTable(
  "teacher_restroom_overrides",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffName: text("staff_name").notNull(),
    restroomLocationId: integer("restroom_location_id")
      .notNull()
      .references(() => locationsTable.id, { onDelete: "cascade" }),
  },
  (t) => ({
    uniquePair: unique().on(t.staffName, t.restroomLocationId),
  }),
);

export type TeacherRestroomOverrideRow =
  typeof teacherRestroomOverridesTable.$inferSelect;
