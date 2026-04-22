import { pgTable, serial, integer, unique } from "drizzle-orm/pg-core";
import { locationsTable } from "./locations";

export const locationAllowedDestinationsTable = pgTable(
  "location_allowed_destinations",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    originLocationId: integer("origin_location_id")
      .notNull()
      .references(() => locationsTable.id, { onDelete: "cascade" }),
    destinationLocationId: integer("destination_location_id")
      .notNull()
      .references(() => locationsTable.id, { onDelete: "cascade" }),
  },
  (t) => ({
    uniquePair: unique().on(t.originLocationId, t.destinationLocationId),
  }),
);

export type LocationAllowedDestinationRow =
  typeof locationAllowedDestinationsTable.$inferSelect;
