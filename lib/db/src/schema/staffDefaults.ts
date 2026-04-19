import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const staffDefaultsTable = pgTable("staff_defaults", {
  id: serial("id").primaryKey(),
  staffName: text("staff_name").notNull().unique(),
  defaultLocationName: text("default_location_name"),
});

export type StaffDefaultRow = typeof staffDefaultsTable.$inferSelect;
