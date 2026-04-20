import { pgTable, serial, text, integer, unique } from "drizzle-orm/pg-core";
import { locationsTable } from "./locations";

export const teacherDestinationAllowlistTable = pgTable(
  "teacher_destination_allowlist",
  {
    id: serial("id").primaryKey(),
    staffName: text("staff_name").notNull(),
    destinationLocationId: integer("destination_location_id")
      .notNull()
      .references(() => locationsTable.id, { onDelete: "cascade" }),
  },
  (t) => ({
    uniquePair: unique().on(t.staffName, t.destinationLocationId),
  }),
);

export type TeacherDestinationAllowlistRow =
  typeof teacherDestinationAllowlistTable.$inferSelect;
