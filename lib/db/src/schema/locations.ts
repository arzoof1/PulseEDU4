import { pgTable, serial, text, boolean, integer } from "drizzle-orm/pg-core";

export const locationsTable = pgTable("locations", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().default(1),
  externalId: text("external_id"),
  // NOTE: name has a global unique index; with multi-tenancy two schools could
  // legitimately share a location name (both have a "Library"). The DB unique
  // index is left in place for now; Day 4+ will swap it for a (school_id,name)
  // composite. Until then, location creation must avoid name collisions
  // across schools.
  name: text("name").notNull().unique(),
  kind: text("kind").notNull().default("classroom"),
  isOrigin: boolean("is_origin").notNull().default(false),
  isDestination: boolean("is_destination").notNull().default(false),
  studentVisible: boolean("student_visible").notNull().default(false),
  active: boolean("active").notNull().default(true),
});

export type LocationRow = typeof locationsTable.$inferSelect;
